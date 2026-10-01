/**
 * 专家子代理的生命周期接入。
 *
 * ## 为什么要这一层（来自圆桌的真实事故）
 *
 * 专家的产出**只在它主动提交的那一刻**才落盘。圆桌 v0-2-36 那场评审里，一位红队
 * 专家完成了大量取证，却在提交之前进程中断 —— 观点全丢，记录永久停在
 * `reviewing`、缺陷列表为空；9 条被拉起的路由里 4 条 0 产出，而插件只留下一个
 * `removed` 墓碑，没有任何失败原因，只能靠主持人用自然语言反复催办。
 *
 * 宿主其实把两件事递到手上：
 * - `subagent/end` 带 `lastAssistantMessage`，且可续聊子代理的**每一个 activation
 *   epoch** 都会发这个事件 —— 于是产出能在主动提交之外被自动捕获；
 * - 同一事件带 `stopReason`（`error` / `max-tokens` / `aborted` …），基础设施级
 *   失败时 `lastAssistantMessage` 为空；而 `agent/request-error` 进一步带
 *   `provider` 与 `failure: LlmFailure`（含 HTTP `status`），于是"为什么拉不起来"
 *   （额度、鉴权、模型名写错）可以被写成一条可读的专家备注。
 *
 * ## 与圆桌的关键差异
 *
 * 自动捕获的发言 kind 是 `auto-capture`，而 **`auto-capture` 绝不进入缺陷收集**
 * （见 noise.ts）：圆桌的真实数据里出现过 `[当前状态] 已收到主持人任务…`
 * 这类过程叙述被当成缺陷收进裁决列表，污染了用户的表态面。这里保留落盘（诊断
 * 价值真实存在），但收集阶段会把它过滤掉。
 *
 * 索引是**进程内**的：childId → (stateRoot, reviewId)。冷启动后的旧专家无法归属，
 * 这是刻意的 —— 宁可漏捕获，也不要把别的会话的文本写进评审记录。
 *
 * @module dsh-plugin-crossfire/expert-events
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { estimateTokens } from './budget.ts'
import { appendTranscript, mutateRecord } from './review.ts'
import type { ExpertUtterance } from './types.ts'

/** 一位专家的评审在磁盘上的位置。 */
export interface ExpertLocation {
  stateRoot: string
  reviewId: string
}

/** childId → 评审位置。进程内，理由见模块注释。 */
const expertIndex = new Map<string, ExpertLocation>()

/** 记住一位刚被拉起的专家属于哪场评审。 */
export function registerExpertChild(childId: string, location: ExpertLocation): void {
  if (childId === '') return
  expertIndex.set(childId, location)
}

/** 忘掉一位专家的索引条目（专家失败回滚，或评审已清理）。 */
export function forgetExpertChild(childId: string): void {
  if (childId === '') return
  expertIndex.delete(childId)
}

/** 按子会话 id 查一位专家的评审位置。 */
export function locateExpertChild(childId: string): ExpertLocation | undefined {
  return expertIndex.get(childId)
}

/**
 * 宽限查询：索引里没有就等一个极短窗口再查一次。
 *
 * ## 为什么需要它（红队在真实评审里抓到的竞态）
 *
 * 索引是在 `spawnExpert` **返回之后**才登记的，而宿主的 `startContinuable` 文档
 * 写明它"resolve at initial idle" —— 也就是说子代理可能在 `spawnExpert` 返回的
 * 那一瞬间就已经跑完第一轮并提交了发言。这几毫秒的窗口里：
 *
 * - `crossfire_report` 查不到归属 → 抛"你不在任何评审里"，专家的产出直接丢掉；
 * - `subagent/end` 查不到归属 → 被当作"不属于任何评审"丢弃，专家永远停在 running。
 *
 * 概率极低（需要专家在几毫秒内完成整轮），但代价是**丢掉一整位专家的工作**，而且
 * 它无法复现、无法从外部诊断。所以这里不是掩盖问题，而是把这个窗口等过去。
 *
 * @param childId - 子会话 id。
 * @param graceMs - 等待窗口（默认 400ms，仅在一次查不到时才付出这点时间）。
 */
export async function locateExpertChildWithGrace(
  childId: string,
  graceMs = 400,
): Promise<ExpertLocation | undefined> {
  const immediate = expertIndex.get(childId)
  if (immediate !== undefined) return immediate
  await new Promise((resolve) => setTimeout(resolve, graceMs))
  return expertIndex.get(childId)
}

/** 仅供测试：清空进程内索引。 */
export function __resetExpertIndexForTests(): void {
  expertIndex.clear()
}

/** 把一条助手输出里的文本块拼起来（没有则返回空串）。 */
export function blocksToText(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined || blocks.length === 0) return ''
  const parts: string[] = []
  for (const block of blocks) {
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n').trim()
}

/** 一次子代理结束对它的评审意味着什么。 */
export interface ExpertEndOutcome {
  /** 捕获到的输出；空串表示这一轮没有任何可用产出。 */
  text: string
  /** 可读原因，在 `text` 为空时写进专家备注。 */
  note: string
}

/**
 * 判定一次结束的子代理运行给评审带来了什么。
 *
 * 一个 `completed` 但没有任何文本的运行**不是**硬故障（专家可能只回了一句确认），
 * 所以它有自己的一句措辞 —— 要点是绝不让用户去猜"还在跑"和"已经死了"。
 */
export function describeExpertEnd(info: {
  readonly stopReason?: string
  readonly lastAssistantMessage?: readonly ContentBlock[]
}): ExpertEndOutcome {
  const text = blocksToText(info.lastAssistantMessage)
  if (text !== '') return { text, note: '' }
  const reason = info.stopReason ?? 'unknown'
  return {
    text: '',
    note: reason === 'completed'
      ? '本轮结束但没有产出内容（可能只回了确认，未见 crossfire_report）'
      : `本轮未产出内容（stopReason=${reason}）`,
  }
}

/** 一句可读的 provider 请求失败说明。 */
export function describeRequestFailure(
  provider: string,
  failure: { message?: string; code?: string; status?: number } | undefined,
): string {
  const status = typeof failure?.status === 'number' ? ` HTTP ${failure.status}` : ''
  const code = typeof failure?.code === 'string' && failure.code !== '' ? ` ${failure.code}` : ''
  const message = typeof failure?.message === 'string' ? failure.message.trim().slice(0, 200) : ''
  return `请求失败（provider=${provider}${status}${code}）${message === '' ? '' : `：${message}`}`
}

/** 按 childId 更新专家的状态与备注。 */
async function writeExpertNote(
  location: ExpertLocation,
  childId: string,
  note: string | undefined,
  status: 'done' | 'failed' | 'silent',
): Promise<void> {
  await mutateRecord(location.stateRoot, location.reviewId, (record) => {
    const expert = record.experts.find((candidate) => candidate.childId === childId)
    if (expert === undefined) return undefined
    expert.status = status
    expert.note = note
    return undefined
  })
}

/**
 * 捕获一次结束的专家运行。
 *
 * 有产出：作为 `auto-capture` 发言落盘，并清掉备注 —— 这样即便专家从没调用过
 * `crossfire_report`，它的内容也仍然进了转录。
 * 无产出：留下一条可读的专家备注。
 */
async function onExpertEnd(
  ctx: Context,
  info: { readonly id?: unknown; readonly stopReason?: string; readonly lastAssistantMessage?: readonly ContentBlock[] },
): Promise<void> {
  const childId = String(info.id ?? '')
  if (childId === '') return
  // 同一个窗口：结束事件可能在归属登记之前到达。等一小会儿再放弃，否则这位
  // 专家的产出会被静默丢弃、状态永远停在 running。
  const location = await locateExpertChildWithGrace(childId)
  if (location === undefined) return
  const outcome = describeExpertEnd(info)
  try {
    if (outcome.text === '') {
      await writeExpertNote(location, childId, outcome.note, 'silent')
      return
    }
    let expertKey = ''
    let pass = 1
    await mutateRecord(location.stateRoot, location.reviewId, (record) => {
      const expert = record.experts.find((candidate) => candidate.childId === childId)
      if (expert === undefined) return undefined
      expertKey = expert.key
      pass = record.reviewPass
      expert.status = 'done'
      expert.note = undefined
      record.budget.usedTokens += estimateTokens(outcome.text)
      return undefined
    })
    if (expertKey === '') return
    const utterance: ExpertUtterance = {
      id: randomUUID(),
      expertKey,
      kind: 'auto-capture',
      content: outcome.text,
      pass,
      ts: Date.now(),
    }
    await appendTranscript(location.stateRoot, location.reviewId, utterance)
  } catch (error: unknown) {
    ctx.logger.warn(`crossfire: capturing output of expert ${childId} failed: ${String(error)}`)
  }
}

/** 记住每位专家最近一次 provider 失败（可观测性，不做恢复）。 */
function onRequestError(
  ctx: Context,
  payload: { agent?: unknown; provider?: unknown; failure?: { message?: string; code?: string; status?: number } },
): void {
  const agentId = String((payload.agent as { id?: unknown } | undefined)?.id ?? '')
  if (agentId === '') return
  const location = locateExpertChild(agentId)
  if (location === undefined) return
  const note = describeRequestFailure(String(payload.provider ?? ''), payload.failure)
  void writeExpertNote(location, agentId, note, 'failed').catch((error: unknown) => {
    ctx.logger.warn(`crossfire: recording request failure of expert ${agentId} failed: ${String(error)}`)
  })
}

/**
 * 订阅两个让专家产出与专家失败变得可见的宿主事件。
 *
 * 刻意非侵入：`subagent/end` 是普通 emit；`agent/request-error` 是 waterfall
 * 监听器，且**永远通过 `next()` 委托**，因此宿主自己的重试/恢复策略完全不受影响
 * —— 本插件只观察。
 */
export function attachExpertEvents(ctx: Context): void {
  ctx.on('subagent/end', (info) => {
    void onExpertEnd(ctx, info as { id?: unknown; stopReason?: string; lastAssistantMessage?: readonly ContentBlock[] })
  })
  ctx.on('agent/request-error', (payload, next) => {
    try {
      onRequestError(ctx, payload as Parameters<typeof onRequestError>[1])
    } catch {
      // 观测失败绝不能影响宿主的错误处理链路。
    }
    return next()
  })
}

/** 专家活性（批 3 的卡片用它显示"还在跑 / 已就绪 / 已经没了"）。 */
export type ExpertLiveness = 'running' | 'idle' | 'ready' | 'missing'

/** 宿主已知的持久子会话 id；目录不可用时返回 undefined。 */
async function knownChildIds(ctx: Context, parentSessionId: string): Promise<Set<string> | undefined> {
  try {
    const children = await ctx.subagents.listChildren(parentSessionId as SessionId)
    return new Set(children.map((child) => String(child.id)))
  } catch (error: unknown) {
    ctx.logger.warn(`crossfire: listing child subagents failed: ${String(error)}`)
    return undefined
  }
}

/**
 * 把专家状态与宿主真实的子代理树对账。
 *
 * `ctx.agents.get(id)` 只知道**活着的**驱动，所以进程已经没了的专家看起来和只是
 * 在两轮之间的一样 —— 都报 `ready`，用户无法区分"待唤醒"和"已经没了"。问一次
 * 持久目录就能分开：宿主还列着的 id 是"冷但真实"的子会话，不再认识的 id 才是
 * `missing`。
 */
export async function reconcileExpertLiveness(
  ctx: Context,
  parentSessionId: string,
  experts: readonly { childId?: string }[],
): Promise<Map<string, ExpertLiveness>> {
  const result = new Map<string, ExpertLiveness>()
  let catalog: Set<string> | undefined
  for (const expert of experts) {
    const childId = expert.childId ?? ''
    if (childId === '') continue
    const live = ctx.agents.get(childId as SessionId)
    if (live !== undefined) {
      result.set(childId, live.status === 'running' ? 'running' : 'idle')
      continue
    }
    if (catalog === undefined) catalog = await knownChildIds(ctx, parentSessionId)
    result.set(childId, catalog === undefined || catalog.has(childId) ? 'ready' : 'missing')
  }
  return result
}
