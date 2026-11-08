/**
 * `crossfire_*` 模型面向的工具。
 *
 * ## 编排模型（与圆桌会议的根本差异）
 *
 * 圆桌是"主持人统筹"：模型负责建会、拉人、转述、聚合、推进每一轮。crossfire 不
 * 需要这些 —— 卡片上的按钮经 RPC 直接驱动 host 状态机（O1 决策）。所以这里的工具
 * 面刻意小：**预检一步 + 状态机七步、每步一件事、每步可单独重试**，模型只在
 * "推不动了"的时候介入。
 *
 * 状态机（见 review.ts）：
 *   draft --open--> attacking --attack--> judging --collect--> settled --finish-->
 *   settled --recheck--> attacking（复审：只核对旧账，不许开新战线）
 *
 * ## 一条不可越界的规则
 *
 * **没有任何"代表态"的工具。** 缺陷的认定 / 驳回只能由人在卡片上操作，因此这里
 * 找不到 `crossfire_decide` 这类入口，而且不该有人加上它 —— 表态权是这个插件
 * 存在的理由本身。
 *
 * @module dsh-plugin-crossfire/tools
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveDimension, resolveDimensions } from './dimensions.ts'
import { applyCollected, collectDefects, planExperts, type ExpertRosterEntry } from './engine.ts'
import { renderReviewMarkdown } from './export-md.ts'
import { assertBudget, beginPass, chargeTokens, estimateTokens } from './budget.ts'
import { locateExpertChildWithGrace, registerExpertChild } from './expert-events.ts'
import { spawnExpert, type MemberRuntimeConfig } from './members.ts'
import {
  formatReviewDraft,
  PLAN_APPROVE_LABEL,
  PLAN_REVISE_LABEL,
  resolvePlanConfirmation,
  type DraftExpert,
  type ReviewDraft,
} from './plan.ts'
import {
  appendTranscript,
  buildRecheckItems,
  countDefects,
  exportFile,
  exportTextFile,
  knownFlaws,
  mutateRecord,
  newRecord,
  readRecord,
  readTranscriptReport,
  writeRecord,
} from './review.ts'
// 刻意**不**在这里导入 `setDefectStatus` / `setRecheckVerdict`：它们是表态函数，
// 只允许浏览器半体经 RPC 调用。工具面没有任何"代表态"的入口 —— 这是这个插件
// 存在的理由本身，而 `test/redteam.test.mjs` 里有专门的断言守着它。
import { newReviewId, reviewLockKey, stateRootOf, withCrossfireLock } from './state.ts'
import type { ReviewSplitConfig, SplitLlmLike } from './split.ts'
import type { CrossfireRecord, Defect, ExpertUtterance, Intensity } from './types.ts'

/** 设置页那一层（每次调用实时读取，因此改设置对新建评审立即生效）。 */
export interface ReviewDefaults {
  intensity: Intensity
  maxRounds: number
  maxTokens: number
  expertMaxTokens: number
  expertMaxOpinions: number
  customDimensions: string[]
}

/** 工具运行时配置。 */
export interface ToolsConfig {
  stateDir: string
  memberProvider: string
  maxExperts: number
  memberMaxDepth?: number
  /**
   * 专家**继承主持人**时实际生效的模型路由。
   *
   * 只为可观测性：开打时把这个生效值写回专家记录，卡片才能把"继承"画成真实品牌
   * （DeepSeek 的蓝色 DS 块），而不是中性灰 `?`。它不参与任何路由决策。
   */
  defaultProvider?: string
  defaultModel?: string
  /** 观点拆分的 LLM 路由（不可用时自动退到本地兜底）。 */
  reviewSplit: ReviewSplitConfig
  /** 实时读取的默认值。 */
  getDefaults: () => ReviewDefaults
}

/* ------------------------------------------------------------------ *
 * 调用方辅助
 * ------------------------------------------------------------------ */

/** 调用者 agent，或一个响亮的失败（非 agent 调用）。 */
function requireAgent(exec: { agent?: Agent }): Agent {
  if (exec.agent === undefined) {
    throw new Error('crossfire tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/** 调用者的工作区目录（状态根的父目录）。 */
function workspaceOf(agent: Agent): string {
  const header = (agent.session as unknown as { header?: { cwd?: string } }).header
  return header?.cwd ?? process.cwd()
}

/** 取参数里的非空字符串。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 容错地把参数读成字符串数组（支持真数组、逗号分隔串、空白分隔串）。 */
function stringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    return items.length > 0 ? items : undefined
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const items = value.split(/[,，、;；\s]+/).map((item) => item.trim()).filter((item) => item !== '')
    return items.length > 0 ? items : undefined
  }
  return undefined
}

function parseIntensity(value: unknown): Intensity | undefined {
  return value === 'quick' || value === 'standard' || value === 'deep' ? value : undefined
}

/* ------------------------------------------------------------------ *
 * 启动前确认卡的参数解析（crossfire_plan_review / crossfire_open 共用）
 * ------------------------------------------------------------------ */

/**
 * 把 `experts[]` 参数读成确认卡上的"草案行"。
 *
 * 维度经 `resolveDimension` 归一化到本次采用的维度：用户在卡上写「安全风险」也要
 * 能对上「安全」，否则一行配置会因为这个后缀被静默丢掉。
 *
 * `key` 允许为空（缺席），表示"沿用默认的维度名"——用户通常只改模型或提示词。
 */
function parseDraftExpertRows(value: unknown, dimensions: readonly string[]): DraftExpert[] {
  if (!Array.isArray(value)) return []
  const rows: DraftExpert[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const dimensionRaw = text(entry.dimension)
    if (dimensionRaw === '') continue
    const row: DraftExpert = {
      key: text(entry.key),
      dimension: resolveDimension(dimensionRaw, dimensions).dimension,
    }
    const role = text(entry.role)
    if (role !== '') row.role = role
    const provider = text(entry.provider)
    if (provider !== '') row.provider = provider
    const model = text(entry.model)
    if (model !== '') row.model = model
    const prompt = text(entry.prompt)
    if (prompt !== '') row.prompt = prompt
    rows.push(row)
  }
  return rows
}

/**
 * 默认阵容：每维一位（等价于 `crossfire_attack` 不带 roster 时的结果），不落盘。
 *
 * 借 `newRecord` 造一份**不写盘**的临时记录：`planExperts` 只读 `dimensions` 与
 * `intensity`，用真构造器而不是手工拼对象，是为了让卡片上的默认阵容与真正开打时
 * 走**同一段**规划逻辑（复制一份必然分叉）。
 */
function defaultDraftExperts(
  dimensions: string[],
  intensity: Intensity,
  maxRounds: number,
  maxTokens: number,
  maxExperts: number,
): DraftExpert[] {
  const preview = newRecord({
    reviewId: 'plan-preview',
    title: '',
    content: '',
    source: 'manual',
    dimensions,
    intensity,
    maxRounds,
    maxTokens,
  })
  return planExperts(preview, maxExperts).map((expert) => ({ key: expert.key, dimension: expert.dimension }))
}

/**
 * 把用户提供的行合并进默认阵容（**只覆盖给了的列**）。
 *
 * 匹配顺序与 `planExperts` 一致：先按 key，再按维度。用户没提到的行保持默认值 ——
 * 卡片上"未指定的列沿用设置页阵容/继承"这句话就是这条规则。
 *
 * 同一维度上用户显式加了第二位专家时**追加**（粒度由用户决定），最后按专家上限截断。
 */
function mergeDraftExperts(
  defaults: readonly DraftExpert[],
  provided: readonly DraftExpert[],
  maxExperts: number,
): DraftExpert[] {
  const merged = defaults.map((expert) => ({ ...expert }))
  const claimed = new Set<number>()
  for (const row of provided) {
    let target = row.key === ''
      ? -1
      : merged.findIndex((expert, index) => !claimed.has(index) && expert.key === row.key)
    if (target < 0) {
      target = merged.findIndex((expert, index) => !claimed.has(index) && expert.dimension === row.dimension)
    }
    if (target >= 0) {
      claimed.add(target)
      const current = merged[target]
      if (current === undefined) continue
      const next: DraftExpert = { ...current }
      if (row.key !== '') next.key = row.key
      if (row.role !== undefined) next.role = row.role
      if (row.provider !== undefined) next.provider = row.provider
      if (row.model !== undefined) next.model = row.model
      if (row.prompt !== undefined) next.prompt = row.prompt
      merged[target] = next
    } else {
      merged.push({ ...row, key: row.key === '' ? row.dimension : row.key })
      claimed.add(merged.length - 1)
    }
  }
  return merged.length > maxExperts ? merged.slice(0, maxExperts) : merged
}

/**
 * 把 `experts[]` 参数读成**落盘的**阵容条目（只存非空字段）。
 *
 * 与确认卡的 `DraftExpert` 是同一份形状，但这里落的是 `ExpertRosterEntry`：
 * "怎么配一位专家"。`dimension` 是比 `key` 更硬的匹配键（见 engine.ts 的
 * `planExperts`），所以用户给专家换个名字也不会让这一行配置对不上。
 */
function rosterFromArguments(value: unknown): ExpertRosterEntry[] {
  if (!Array.isArray(value)) return []
  const entries: ExpertRosterEntry[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const dimension = text(entry.dimension)
    const key = text(entry.key) || dimension
    if (key === '') continue
    const roster: ExpertRosterEntry = { key }
    if (dimension !== '') roster.dimension = dimension
    const role = text(entry.role)
    if (role !== '') roster.role = role
    const provider = text(entry.provider)
    if (provider !== '') roster.provider = provider
    const model = text(entry.model)
    if (model !== '') roster.model = model
    const prompt = text(entry.prompt)
    if (prompt !== '') roster.prompt = prompt
    entries.push(roster)
  }
  return entries
}

/** `userQuestions` seam 返回的一条已回答问题（与圆桌 plan 卡同一协议）。 */
interface AskUserQuestionAnswerItemLike {
  id: string
  selected: string[]
  custom?: string
}

/** 读一场评审，不存在就抛错。 */
async function requireRecord(stateRoot: string, reviewId: string): Promise<CrossfireRecord> {
  const record = await readRecord(stateRoot, reviewId)
  if (record === undefined) {
    throw new Error(`no review "${reviewId}" — call crossfire_open first (or check the review id)`)
  }
  return record
}

/**
 * 校验调用者是不是这场评审的开启者。
 *
 * 旧记录没有 owner 字段时跳过校验（而不是拒绝）—— 宁可放过，也不能让一条早期
 * 记录变成谁也打不开的死文件。
 */
function requireOwner(record: CrossfireRecord, callerId: string): void {
  if (record.ownerSessionId === undefined || record.ownerSessionId === '') return
  if (record.ownerSessionId !== callerId) {
    throw new Error(`review "${record.reviewId}" belongs to another session — refusing to operate on it`)
  }
}

/** 状态机门禁：不在期望状态就抛错，并把当前状态说清楚。 */
function requireStatus(record: CrossfireRecord, expected: readonly CrossfireRecord['status'][]): void {
  if (!expected.includes(record.status)) {
    throw new Error(`review "${record.reviewId}" is "${record.status}" — expected ${expected.map((item) => `"${item}"`).join(' or ')}`)
  }
}

/** 深拷贝一条缺陷（历史快照必须是快照，不能被后续修改穿透）。 */
function cloneDefect(defect: Defect): Defect {
  return {
    ...defect,
    ...(defect.evidence === undefined ? {} : { evidence: { ...defect.evidence } }),
    ...(defect.recheck === undefined ? {} : { recheck: { ...defect.recheck } }),
  }
}

/* ------------------------------------------------------------------ *
 * 工具注册
 * ------------------------------------------------------------------ */

export function registerCrossfireTools(ctx: Context, config: ToolsConfig): void {
  const memberConfig: MemberRuntimeConfig = {
    provider: config.memberProvider,
    ...(config.memberMaxDepth === undefined ? {} : { maxDepth: config.memberMaxDepth }),
    // 专家继承主持人时的生效路由：写回记录后卡片才能把"继承"画成真实品牌块。
    ...(config.defaultProvider === undefined ? {} : { defaultProvider: config.defaultProvider }),
    ...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }),
  }

  /* ================================================================ *
   * 0. crossfire_plan_review —— 启动前确认卡（不落盘）
   * ================================================================ */
  ctx.tools.register(defineTool({
    name: 'crossfire_plan_review',
    description: 'Show the human a REVIEW SETTINGS CARD before opening anything (step 0 of the flow). This tool does NOT create a review: it composes the draft (title, subject, source, intensity, dimensions, stance, one red-team expert per dimension with optional role/model/prompt, budget) into two markdown tables and BLOCKS until the user confirms. Returns decision="approved" plus the full confirmed config to pass to crossfire_open (including experts), or decision="revise" with the user\'s own words — update the draft, add changes[] and call this tool again (the card is shown again with the change list on top). Call it for EVERY review, even a single-expert one.',
    parameters: {
      title: { type: 'string', required: true, description: 'One-line title of the thing under review (shown on the card and in the export).' },
      content: { type: 'string', required: true, description: 'The settled result / plan / artifact itself: paste the actual text to be attacked.' },
      dimensions: { type: 'array', items: { type: 'string' }, description: 'Dimensions to attack from, e.g. ["安全","性能"]. Omit to use the full pool (安全/数据/交互/性能/兼容/流程/反例 + your custom ones). Unknown values are normalized to the nearest pool value.' },
      intensity: { type: 'string', enum: ['quick', 'standard', 'deep'], description: 'Attack intensity: quick (one round), standard (default), deep (adds a cross-examination round, allows two re-reviews).' },
      stance: { type: 'string', description: 'YOUR position and reasons on this subject, in your own words. When present, the red team must argue against each reason and mark whether it was refuted (strikes_stance). This is what turns a neutral review into 针锋相对.' },
      source: { type: 'string', enum: ['manual', 'chat', 'file'], description: 'Where the subject came from (default manual).' },
      source_ref: { type: 'string', description: 'Optional reference for the source (a file path, or a short anchor).' },
      source_meeting: { type: 'string', description: 'Optional: the roundtable meeting id this review was handed over from.' },
      experts: {
        type: 'array',
        description: 'Red-team roster shown on the card. Omit for the default: one expert per chosen dimension (key = dimension name, inheriting your route). Rows match by key, then by dimension; columns you leave out keep the default (inherit the host route, no extra role/prompt).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', description: 'Expert key inside the review (default: the dimension name).' },
            dimension: { type: 'string', required: true, description: 'The one dimension this expert attacks.' },
            role: { type: 'string', description: 'Short supplementary role, e.g. "密钥与权限". Narrows expertise only — it can never relax the read-only / no-plan / no-flattery rules.' },
            provider: { type: 'string', description: 'Optional model provider route.' },
            model: { type: 'string', description: 'Optional model id.' },
            prompt: { type: 'string', description: 'Free-text supplementary prompt for this expert. Narrows expertise only — it can never relax the hard constraints.' },
          },
        },
      },
      changes: { type: 'array', items: { type: 'string' }, description: 'What changed since the previous draft (only meaningful when revised=true). Be specific, e.g. "reviewer model: zai/glm-5.2 → deepseek/deepseek-chat". An empty list while revised=true shows "（本次未标注具体变更）" — do not fake changes.' },
      revised: { type: 'boolean', description: 'Set true when re-showing the card after the user asked for changes (the card then lists changes[] on top).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          decision: { type: 'string', required: true },
          user_note: { type: 'string', required: true },
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
          dimensions: { type: 'array', items: { type: 'string' }, required: true },
          intensity: { type: 'string', required: true },
          stance: { type: 'string', required: true },
          source: { type: 'string', required: true },
          source_ref: { type: 'string', required: true },
          source_meeting: { type: 'string', required: true },
          // 专家的每一列都声明为 required + 空串约定：主持人要把这份名单原样转给
          // `crossfire_open`，缺席的列写成空串比"字段不存在"更好处理（与其它工具一致）。
          experts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                dimension: { type: 'string', required: true },
                role: { type: 'string', required: true },
                provider: { type: 'string', required: true },
                model: { type: 'string', required: true },
                prompt: { type: 'string', required: true },
              },
            },
          },
          max_rounds: { type: 'integer', required: true },
          max_tokens: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.decision === 'approved'
          ? `用户已确认评审设置：${value.title}（${value.intensity}，维度 ${value.dimensions.join(', ')}，`
            + `${value.experts.length} 位红队专家，${value.max_rounds} 轮 / ${value.max_tokens} tokens）。`
            + '请用 crossfire_open 按这些值开启评审（experts 原样传入），然后 crossfire_attack。'
          : value.decision === 'revise'
            ? `用户要求修改：${value.user_note}\n请据此更新草案（保持未改动的项原样），带上 changes[] 再次调用 crossfire_plan_review 让用户确认；确认前不要 crossfire_open。`
            : `设置卡片未能取得用户答复（userQuestions 服务不可用或被中止）${value.user_note === '' ? '' : `：${value.user_note}`}。请把配置用文字告知用户，取得明确同意后再调用 crossfire_open。`,
      }],
    },
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const defaults = config.getDefaults()

      const content = text(args.content)
      if (content === '') throw new Error('content must not be empty — paste the thing under review')
      const title = text(args.title) || content.slice(0, 40)
      const intensity = parseIntensity(args.intensity) ?? defaults.intensity
      const dimensions = resolveDimensions(stringArray(args.dimensions), defaults.customDimensions)
      const source = args.source === 'chat' || args.source === 'file' ? args.source : 'manual'
      const sourceRef = text(args.source_ref)
      const sourceMeeting = text(args.source_meeting)
      const stance = text(args.stance).slice(0, 2000)
      const revised = args.revised === true
      const changes = (args.changes ?? []).map((item) => item.trim()).filter((item) => item !== '')

      // 默认阵容 = 开打时的那份（每维一位），用户给的行覆盖它。这里**不落盘**：
      // 确认工具一旦顺手建记录，用户每改一次草案就会在磁盘上留一条空记录。
      const experts = mergeDraftExperts(
        defaultDraftExperts(dimensions, intensity, defaults.maxRounds, defaults.maxTokens, config.maxExperts),
        parseDraftExpertRows(args.experts, dimensions),
        config.maxExperts,
      )

      const draft: ReviewDraft = {
        title,
        content,
        source,
        ...(sourceRef === '' ? {} : { sourceRef }),
        dimensions,
        intensity,
        stance,
        experts,
        maxRounds: defaults.maxRounds,
        maxTokens: defaults.maxTokens,
        changes,
        revised,
      }
      const detail = formatReviewDraft(draft)

      // 卡面输出的专家列一律写成字符串（缺席 = 空串），主持人把它原样转给
      // `crossfire_open` 即可 —— 空串在 open 侧被当作"没写"。
      const outExperts = draft.experts.map((expert) => ({
        key: expert.key,
        dimension: expert.dimension,
        role: expert.role ?? '',
        provider: expert.provider ?? '',
        model: expert.model ?? '',
        prompt: expert.prompt ?? '',
      }))
      const configured = {
        title,
        content,
        dimensions,
        intensity,
        stance,
        source,
        source_ref: sourceRef,
        source_meeting: sourceMeeting,
        experts: outExperts,
        max_rounds: defaults.maxRounds,
        max_tokens: defaults.maxTokens,
      }
      const answerWith = (decision: string, note: string) => ({ decision, user_note: note, ...configured })

      // `userQuestions` 是**可选**服务（不列进 inject）：缺席时返回 unavailable，
      // 由主持人改用文字取得同意 —— 确认卡不能成为整个插件的加载门禁。
      const userQuestions = ctx.get('userQuestions') as
        | {
            ask(request: {
              questions: {
                id: string
                question: string
                detail?: string
                header?: string
                options?: { label: string; description?: string }[]
                intent?: { kind: 'plan-review'; approve: string }
              }[]
              agent?: Agent
              signal?: AbortSignal
            }): Promise<{ answers: AskUserQuestionAnswerItemLike[] }>
          }
        | undefined
      if (userQuestions === undefined) {
        return answerWith('unavailable', 'the userQuestions service is not mounted in this composition')
      }

      const questionId = randomUUID()
      let answer: { answers: AskUserQuestionAnswerItemLike[] }
      try {
        answer = await userQuestions.ask({
          questions: [{
            id: questionId,
            question: `确认「${title}」的评审设置？`,
            detail,
            header: '针锋 Crossfire · 评审设置确认',
            options: [
              { label: PLAN_APPROVE_LABEL, description: '按上方两张表开始评审（红队随后由主持人拉起）' },
              { label: PLAN_REVISE_LABEL, description: '在输入框写明要改的地方，主持人会更新草案并再弹一次' },
            ],
            // 原生 plan-review 载体：detail 放卡片 Markdown，approve 指向批准选项。
            intent: { kind: 'plan-review', approve: PLAN_APPROVE_LABEL },
          }],
          agent: caller,
          signal: exec.signal,
        })
      } catch (error: unknown) {
        // 卡片不可用（服务抛错/被中止）不是失败：它只是要求主持人改用文字确认。
        return answerWith('unavailable', `设置卡片不可用：${(error as Error).message}`)
      }
      // 服务返回形状不可信（第三方 UI 可能不给 answers）。拿不到合法数组时按
      // "用户没答"处理，而不是在这里抛错把整张卡变成一次失败。
      const answers = Array.isArray(answer.answers) ? answer.answers : []
      const item = answers.find((candidate) => candidate.id === questionId)
      const confirmation = resolvePlanConfirmation(item)
      return answerWith(confirmation.kind, confirmation.kind === 'approved' ? '' : confirmation.note)
    },
  }))

  /* ================================================================ *
   * 1. crossfire_open —— 开一场评审（draft）
   * ================================================================ */
  ctx.tools.register(defineTool({
    name: 'crossfire_open',
    description: 'Open a 针锋 (adversarial) review: put ONE settled result on the stand so red-team experts can attack it. Records the subject, your stance (optional but recommended — it gives the attack a target), the dimensions to attack from, the intensity, and (when the user confirmed a settings card) the red-team roster. Returns a review_id in status "draft"; the review card appears in the trajectory. Preferred flow (v0.2.0): call crossfire_plan_review first and let the user confirm, then call this tool with exactly the confirmed values — including experts, which are stored on the record and consumed by crossfire_attack. Next step is crossfire_attack. Use this ONLY for something already decided — Crossfire never produces a plan and never fixes anything.',
    parameters: {
      title: { type: 'string', required: true, description: 'One-line title of the thing under review (shown on the card and in the export).' },
      content: { type: 'string', required: true, description: 'The settled result / plan / artifact itself: paste the actual text to be attacked.' },
      dimensions: { type: 'array', items: { type: 'string' }, description: 'Dimensions to attack from, e.g. ["安全","性能"]. Omit to use the full pool (安全/数据/交互/性能/兼容/流程/反例 + your custom ones). Unknown values are normalized to the nearest pool value.' },
      intensity: { type: 'string', enum: ['quick', 'standard', 'deep'], description: 'Attack intensity: quick (one round), standard (default), deep (adds a cross-examination round, allows two re-reviews).' },
      stance: { type: 'string', description: 'YOUR position and reasons on this subject, in your own words. When present, the red team must argue against each reason and mark whether it was refuted (strikes_stance). This is what turns a neutral review into 针锋相对.' },
      source: { type: 'string', enum: ['manual', 'chat', 'file'], description: 'Where the subject came from (default manual).' },
      source_ref: { type: 'string', description: 'Optional reference for the source (a file path, or a short anchor).' },
      source_meeting: { type: 'string', description: 'Optional: the roundtable meeting id this review was handed over from.' },
      experts: {
        type: 'array',
        description: 'The confirmed red-team roster from crossfire_plan_review (pass it verbatim). Stored on the record and consumed by crossfire_attack, so each expert keeps its dimension, model, role and prompt. Omit to keep the defaults (one expert per dimension, inheriting your route) — behavior is then byte-identical to before.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', description: 'Expert key (default: the dimension name).' },
            dimension: { type: 'string', required: true, description: 'The one dimension this expert attacks.' },
            role: { type: 'string', description: 'Short supplementary role (narrows expertise only).' },
            provider: { type: 'string', description: 'Optional model provider route.' },
            model: { type: 'string', description: 'Optional model id.' },
            prompt: { type: 'string', description: 'Free-text supplementary prompt (narrows expertise only — never relaxes the hard constraints).' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          review_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          dimensions: { type: 'array', items: { type: 'string' }, required: true },
          intensity: { type: 'string', required: true },
          max_review_pass: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Review ${value.review_id} opened (status ${value.status}, intensity ${value.intensity}). `
          + `Dimensions: ${(value.dimensions as string[]).join(', ')}. Re-review cap: ${value.max_review_pass}. `
          + 'Next: crossfire_attack to send in the red team.',
      }],
    },
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const defaults = config.getDefaults()

      const content = text(args.content)
      if (content === '') throw new Error('content must not be empty — paste the thing under review')
      const title = text(args.title) || content.slice(0, 40)
      const intensity = parseIntensity(args.intensity) ?? defaults.intensity
      const dimensions = resolveDimensions(stringArray(args.dimensions), defaults.customDimensions)
      const sourceParam = args.source
      const source = sourceParam === 'chat' || sourceParam === 'file' ? sourceParam : 'manual'
      const sourceRef = text(args.source_ref)
      const sourceMeeting = text(args.source_meeting)

      const reviewId = newReviewId()
      const record = newRecord({
        reviewId,
        title,
        content,
        source,
        ...(sourceRef === '' ? {} : { sourceRef }),
        dimensions,
        intensity,
        stanceText: text(args.stance),
        maxRounds: defaults.maxRounds,
        maxTokens: defaults.maxTokens,
        ...(sourceMeeting === '' ? {} : { sourceMeeting }),
        ownerSessionId: caller.id,
      })
      // 确认卡确认过的阵容（主持人按 `crossfire_plan_review` 的输出原样传入）。
      // 只写非空字段；空数组不写 —— 让"没走确认卡"的老记录保持与从前逐字相同的形状，
      // 此时 crossfire_attack 的 roster 为空，行为与从前完全一致。
      const expertRoster = rosterFromArguments(args.experts)
      if (expertRoster.length > 0) record.expertRoster = expertRoster
      await withCrossfireLock(reviewLockKey(stateRoot, reviewId), async () => {
        await writeRecord(stateRoot, record)
      })

      return {
        review_id: reviewId,
        status: record.status,
        dimensions: record.dimensions,
        intensity: record.intensity,
        max_review_pass: record.maxReviewPass,
      }
    },
  }))

  /* ================================================================ *
   * 2. crossfire_attack —— 拉起红队（attacking）
   * ================================================================ */
  ctx.tools.register(defineTool({
    name: 'crossfire_attack',
    description: 'Send in the red team: spawn one read-only expert per chosen dimension (draft -> attacking). Experts are durable continuable subagents whose tool surface is a strict read-only allowlist (read/read_image/glob/grep + crossfire_report) — they can gather evidence but can never write, execute or fetch the network. Each expert submits its findings with crossfire_report. Use again on a recheck round: experts then only verify the previously endorsed defects.',
    parameters: {
      review_id: { type: 'string', required: true, description: 'The review to attack (from crossfire_open).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          spawned: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          dimensions: { type: 'array', items: { type: 'string' }, required: true },
          review_pass: { type: 'integer', required: true },
          failures: { type: 'array', items: { type: 'string' }, required: true, description: 'Readable reason per expert that could not be started.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.failed === 0
          ? `Red team sent in: ${value.spawned} expert(s) over ${(value.dimensions as string[]).length} dimension(s), pass ${value.review_pass}. They are attacking now; call crossfire_collect when they have reported.`
          : `Red team: ${value.spawned} expert(s) started, ${value.failed} failed. Reasons: ${(value.failures as string[]).join(' | ')}`,
      }],
    },
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const reviewId = text(args.review_id)
      if (reviewId === '') throw new Error('review_id must not be empty')
      const defaults = config.getDefaults()

      // 状态门禁 + 规划 + spawn + 写回**全在同一个临界区里**（A4 + A6，与 rpc.ts 的
      // 卡片路径同构）。此前 spawn 在锁外，两个并发调用都能通过门禁、各自拉起一批
      // 专家，而后一批的写回把前一批的 experts 整批覆盖 —— 前一批已经真的跑起来
      // （正花着用户的 token），却再没人跟踪它们的 childId。
      //
      // 代价（刻意的）：拉起 N 位专家期间同一场评审的其它写操作会排队。同一场评审的
      // 写本就该串行，这里只是把这条不变量贯彻到底。
      const planned = await withCrossfireLock(reviewLockKey(stateRoot, reviewId), async () => {
        const record = await requireRecord(stateRoot, reviewId)
        requireOwner(record, caller.id)
        assertBudget(record)
        // 只允许 draft 与 attacking：draft 是卡片攻击按钮**唯一可见**的状态，
        // attacking 是复审轮的起点。**刻意不含 settled** —— 对已定稿的评审直接重新
        // 攻击会绕过复审流程，而卡片在 settled 上根本没有攻击按钮（与 rpc.ts 的同一
        // 道门禁对齐；红队在验收里指出过这条放行是一条谁也点不到的死路径）。
        requireStatus(record, ['draft', 'attacking'])
        // A4 的第二道判据：这一场评审**已经有一批专家在跑**。
        //
        // `attacking` 必须仍是合法起点（复审轮 settled → recheck → attacking 之后要能
        // 再开打），所以判据只能是"记录里有没有 running 的专家"：有 = 这一批还没结束，
        // 拒绝重复启动（放行会覆盖掉正在跑的 childId）；一个都没有（全部 done/silent/
        // failed，或刚开轮 experts 为空）= 允许 —— "上一批全部 failed 后用户重试"走的
        // 正是这条路。
        const running = record.experts.filter((expert) => expert.status === 'running')
        if (running.length > 0) {
          throw new Error(
            `experts are already running for review "${reviewId}" (${running.map((expert) => expert.key).join(', ')}) — `
            + 'wait for them to report, or collect what they have already submitted',
          )
        }

        // 阵容来源优先级：用户在启动前确认卡里逐行确认过的 `expertRoster` 优先 ——
        // 那是用户看过并点过「确定开始」的那一份，模型/角色/提示词都可能被他改过。
        // 没有确认卡时 roster 为空，`planExperts` 的结果与从前的内联循环逐字一致
        // （每维一位、继承主持人路由、无补充定位）。
        //
        // 顺带把这段规划收进 engine：工具端与 RPC 端此前各写一份，而 RPC 那份早就
        // 会消费设置页阵容 —— 同一条规则两处实现，分叉只是时间问题。
        const trimmed = planExperts(record, config.maxExperts, record.expertRoster ?? [])

        // 复审轮：本轮的攻击目标是"核对旧账"，阵容照旧但缺陷集合是核对项。
        const isRecheck = record.reviewPass > 1 && record.history.length > 0
        if (isRecheck && record.defects.length === 0) {
          record.defects = buildRecheckItems(record)
        }
        record.experts = trimmed
        record.status = 'attacking'
        // 先落一次盘再拉起：卡片立刻能看到 attacking + pending，不必等所有子代理都起来。
        await writeRecord(stateRoot, record)

        // 拉起子代理：每位专家一个独立的 signal（它必须在本次调用返回之后继续跑，
        // 所以不能绑定调用方的生命周期）。
        const failures: string[] = []
        for (const expert of trimmed) {
          const controller = new AbortController()
          try {
            const childId = await spawnExpert(
              ctx,
              memberConfig,
              record,
              expert,
              caller,
              controller.signal,
              { maxTokens: defaults.expertMaxTokens, maxOpinions: defaults.expertMaxOpinions },
            )
            expert.childId = childId
            expert.status = 'running'
            registerExpertChild(childId, { stateRoot, reviewId })
          } catch (error: unknown) {
            expert.status = 'failed'
            expert.note = error instanceof Error ? error.message : String(error)
            failures.push(`${expert.key}: ${expert.note}`)
          }
        }
        // 写回 childId / status（以及 spawnExpert 落下的 persona）。
        record.experts = trimmed
        await writeRecord(stateRoot, record)
        return { record, experts: trimmed, failures }
      })

      return {
        spawned: planned.experts.filter((expert) => expert.status === 'running').length,
        failed: planned.failures.length,
        dimensions: planned.record.dimensions,
        review_pass: planned.record.reviewPass,
        failures: planned.failures,
      }
    },
  }))

  /* ================================================================ *
   * 3. crossfire_collect —— 收集并拆分（judging）
   * ================================================================ */
  ctx.tools.register(defineTool({
    name: 'crossfire_collect',
    description: 'Collect the red team\'s findings into adjudicable defects (attacking -> judging). Each utterance is split into 1-3 single-defect items (LLM first, deterministic local fallback), every dimension is normalized into the review\'s chosen set, and progress chatter is filtered out so the adjudication list stays clean. Idempotent per utterance. Defects you REJECTED in an earlier pass are not proposed again.',
    parameters: {
      review_id: { type: 'string', required: true, description: 'The review to collect for.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collected: { type: 'integer', required: true },
          dropped_duplicates: { type: 'integer', required: true },
          skipped_noise: { type: 'integer', required: true },
          split_attempts: { type: 'integer', required: true },
          malformed_lines: { type: 'integer', required: true },
          total_defects: { type: 'integer', required: true },
          status: { type: 'string', required: true },
          recheck_round: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.recheck_round === true
          ? `Recheck round: no new defects collected (the recheck only verifies the previously endorsed ones). ${value.total_defects} item(s) await your verdict.`
          : `Collected ${value.collected} defect(s) into ${value.total_defects} total; dropped ${value.dropped_duplicates} duplicate(s) you had rejected, skipped ${value.skipped_noise} noise line(s). `
            + `Status ${value.status} — the card now waits for your verdicts.`,
      }],
    },
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const reviewId = text(args.review_id)
      if (reviewId === '') throw new Error('review_id must not be empty')

      // 状态门禁 + 读转录 + 拆分 + 合并写回**全在同一个临界区里**（A2 + A6，与 rpc.ts
      // 的卡片路径同构）：此前是"锁外读快照 → 锁外拆分 → 锁内纯拼接"，两次调用会基于
      // 同一份旧快照各拆一遍，裁决面上出现重复缺陷。整段串行化之后，第二次进来时锁内
      // 读到的已是第一批的结果，`collectDefects` 的 utteranceId 幂等键直接命中，
      // `applyCollected` 的 id 幂等键是第二道闸。
      //
      // 代价（刻意的）：拆分走 LLM 是十秒级的，持锁期间同一场评审的其它写操作会排队。
      return await withCrossfireLock(reviewLockKey(stateRoot, reviewId), async () => {
        const record = await requireRecord(stateRoot, reviewId)
        requireOwner(record, caller.id)
        requireStatus(record, ['attacking', 'judging'])

        const transcript = await readTranscriptReport(stateRoot, reviewId)
        const llm = ctx.get('llm') as SplitLlmLike | undefined
        // 拆分 + 噪音过滤 + 维度归一化 + 历史去重全在 engine 里：**单点实现**，因为
        // 浏览器 RPC 的直推按钮（O1）走的是同一段逻辑，复制一份必然分叉。
        const outcome = await collectDefects({
          record,
          transcript: transcript.items,
          malformed: transcript.malformed,
          llm,
          splitConfig: config.reviewSplit,
        })

        // 返回的 `collected` 是**真正追加的条数**：并发的第二次调用一条都不该新增，
        // 报 `outcome.added.length` 会让用户看到"新增 N 条"而列表里一条没变。
        const appended = applyCollected(record, outcome.added)
        record.status = 'judging'
        await writeRecord(stateRoot, record)

        return {
          collected: appended,
          dropped_duplicates: outcome.droppedDuplicates,
          skipped_noise: outcome.skippedNoise,
          split_attempts: outcome.splitAttempts,
          malformed_lines: outcome.malformedLines,
          total_defects: record.defects.length,
          status: record.status,
          recheck_round: record.reviewPass > 1 && record.history.length > 0,
        }
      })
    },
  }))

  /* ================================================================ *
   * 4. crossfire_finish —— 定稿（settled）
   * ================================================================ */
  ctx.tools.register(defineTool({
    name: 'crossfire_finish',
    description: 'Settle the review (judging -> settled): freeze the endorsed defects into the known-flaws checklist and archive this pass into history. Only call it after the user has adjudicated the defects on the card — Crossfire never decides for the human, and an unfinished list stays unfinished on purpose.',
    parameters: {
      review_id: { type: 'string', required: true, description: 'The review to settle.' },
      revised_summary: { type: 'string', description: 'One line describing how the endorsed defects were addressed. Written into history so the NEXT pass can check exactly these items.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          settled: { type: 'boolean', required: true },
          endorsed: { type: 'integer', required: true },
          rejected: { type: 'integer', required: true },
          pending: { type: 'integer', required: true },
          known_flaws: { type: 'array', items: { type: 'string' }, required: true },
          review_pass: { type: 'integer', required: true },
          max_review_pass: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Review settled: ${value.endorsed} endorsed defect(s) frozen as the known-flaws checklist`
          + `${value.pending > 0 ? ` (${value.pending} still unadjudicated)` : ''}. `
          + `Pass ${value.review_pass}/${value.max_review_pass}. `
          + (value.review_pass < value.max_review_pass ? 'Use crossfire_recheck to verify the fixes in a new pass.' : 'Re-review cap reached — ask the user before opening another pass.'),
      }],
    },
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const reviewId = text(args.review_id)
      if (reviewId === '') throw new Error('review_id must not be empty')

      const record = await requireRecord(stateRoot, reviewId)
      requireOwner(record, caller.id)
      requireStatus(record, ['judging', 'attacking', 'settled'])

      const summary = text(args.revised_summary)
      const result = await mutateRecord(stateRoot, reviewId, (current) => {
        const counts = countDefects(current)
        current.history = [...current.history, {
          pass: current.reviewPass,
          subject: current.subject.content,
          stanceText: current.stance.text,
          dimensions: [...current.dimensions],
          intensity: current.intensity,
          defects: current.defects.map(cloneDefect),
          finishedAt: Date.now(),
          ...(summary === '' ? {} : { revisedSummary: summary }),
        }]
        current.status = 'settled'
        current.settledAt = Date.now()
        return {
          counts,
          flaws: knownFlaws(current).map((defect) => `${defect.dimension}｜${defect.content}`),
          pass: current.reviewPass,
          maxPass: current.maxReviewPass,
        }
      })
      if (result === undefined) throw new Error(`no review "${reviewId}"`)
      return {
        settled: true,
        endorsed: result.counts.endorsed,
        rejected: result.counts.rejected,
        pending: result.counts.pending,
        known_flaws: result.flaws,
        review_pass: result.pass,
        max_review_pass: result.maxPass,
      }
    },
  }))

  /* ================================================================ *
   * 5. crossfire_recheck —— 复审开轮（只核对旧账）
   * ================================================================ */
  ctx.tools.register(defineTool({
    name: 'crossfire_recheck',
    description: 'Open the next review pass (settled -> attacking) that ONLY verifies the defects endorsed in the previous pass. No new fronts: the defect list becomes the previous pass\'s endorsed items, each defaulting to "unfixed", and collecting is skipped for this round. Capped by the intensity spec; beyond the cap the user must approve explicitly.',
    parameters: {
      review_id: { type: 'string', required: true, description: 'The settled review to re-check.' },
      user_approved_extra_pass: { type: 'boolean', description: 'Set true ONLY when the user explicitly approved going beyond the re-review cap. Never set it on your own.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          review_pass: { type: 'integer', required: true },
          max_review_pass: { type: 'integer', required: true },
          recheck_items: { type: 'integer', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Recheck pass ${value.review_pass}/${value.max_review_pass} opened with ${value.recheck_items} item(s) to verify (status ${value.status}). `
          + 'Next: crossfire_attack — the red team now verifies whether each endorsed defect was actually fixed.',
      }],
    },
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const reviewId = text(args.review_id)
      if (reviewId === '') throw new Error('review_id must not be empty')

      const record = await requireRecord(stateRoot, reviewId)
      requireOwner(record, caller.id)
      requireStatus(record, ['settled'])

      const nextPass = record.reviewPass + 1
      if (nextPass > record.maxReviewPass && args.user_approved_extra_pass !== true) {
        throw new Error(
          `re-review cap reached (pass ${nextPass} > max ${record.maxReviewPass}) — ask the user to approve continuing, `
          + 'then retry with user_approved_extra_pass=true, or export and stop here',
        )
      }

      const result = await mutateRecord(stateRoot, reviewId, (current) => {
        const items = buildRecheckItems(current)
        current.reviewPass = beginPass(current)
        current.maxReviewPass = args.user_approved_extra_pass === true
          ? Math.max(current.maxReviewPass, current.reviewPass)
          : current.maxReviewPass
        current.defects = items
        current.experts = []
        current.status = 'attacking'
        current.settledAt = undefined
        return { pass: current.reviewPass, maxPass: current.maxReviewPass, items: items.length, status: current.status }
      })
      if (result === undefined) throw new Error(`no review "${reviewId}"`)
      return {
        review_pass: result.pass,
        max_review_pass: result.maxPass,
        recheck_items: result.items,
        status: result.status,
      }
    },
  }))

  /* ================================================================ *
   * 6. crossfire_export —— 导出 Markdown
   * ================================================================ */
  ctx.tools.register(defineTool({
    name: 'crossfire_export',
    description: 'Export the review as a Markdown deliverable (issue-style header, the subject, your stance, endorsed defects first, rejected viewpoints listed separately, red-team roster and pass history). Written to the review directory as export.md and returned in full.',
    parameters: {
      review_id: { type: 'string', required: true, description: 'The review to export.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          markdown: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Exported to ${value.path} (${value.bytes} bytes).` }],
    },
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const reviewId = text(args.review_id)
      if (reviewId === '') throw new Error('review_id must not be empty')

      const record = await requireRecord(stateRoot, reviewId)
      requireOwner(record, caller.id)
      // 导出是收尾路径：预算熔断时也必须可用（否则评审会困在"超预算又不能导出"里）。
      assertBudget(record, { allowMuted: true })

      const markdown = renderReviewMarkdown(record, countDefects(record))
      const path = exportFile(stateRoot, reviewId)
      const { writeTextAtomic, writeTextAtomicWithBom } = await import('./state.ts')
      await writeTextAtomic(path, markdown)
      // 人读副本：`.txt` + UTF-8 BOM（记事本可直开；见 review.ts 的 exportTextFile）。
      let textPath = ''
      try {
        textPath = exportTextFile(stateRoot, reviewId)
        await writeTextAtomicWithBom(textPath, markdown)
      } catch {
        // 副本写不成不影响导出本身。
      }
      return { path, textPath, bytes: Buffer.byteLength(markdown, 'utf8'), markdown }
    },
  }))

  /* ================================================================ *
   * 7. crossfire_stance —— 写入用户立场（主持人从对话提炼）
   * ================================================================ */
  ctx.tools.register(defineTool({
    name: 'crossfire_stance',
    description: 'Record the position and reasons of the person whose work is under review. This is what turns a neutral review into 针锋相对: once a stance exists, every red-team defect must answer one of its reasons and mark whether that reason was refuted (strikes_stance). The user can edit it on the card at any time. If they have not written one, distil it from the conversation and pass distilled=true — but never invent a position they did not express; a fabricated stance gives the red team a fake target.',
    parameters: {
      review_id: { type: 'string', required: true, description: 'The review to record the stance for.' },
      text: { type: 'string', required: true, description: 'The position and its reasons in the user\'s own terms (≤2000 chars). Pass an empty string to clear it.' },
      distilled: { type: 'boolean', description: 'Set true when YOU distilled this from the conversation rather than quoting the user verbatim.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          saved: { type: 'boolean', required: true },
          origin: { type: 'string', required: true },
          length: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.length === 0
          ? 'Stance cleared — the red team will attack by dimension only.'
          : `Stance recorded (${value.length} chars, origin ${value.origin}). Each red-team reason must now be answered and marked refuted or not.`,
      }],
    },
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const reviewId = text(args.review_id)
      if (reviewId === '') throw new Error('review_id must not be empty')
      const record = await requireRecord(stateRoot, reviewId)
      requireOwner(record, caller.id)

      const stanceText = text(args.text).slice(0, 2000)
      const distilled = args.distilled === true
      const result = await mutateRecord(stateRoot, reviewId, (current) => {
        // 空立场一律记 manual：自动提炼失败时就是这条路，卡片必须照常可用。
        current.stance = {
          text: stanceText,
          origin: stanceText === '' ? 'manual' : distilled ? 'distilled' : 'manual',
          ...(distilled && stanceText !== '' ? { distilledAt: Date.now() } : {}),
          updatedAt: Date.now(),
        }
        return { origin: current.stance.origin, length: current.stance.text.length }
      })
      if (result === undefined) throw new Error(`no review "${reviewId}"`)
      return { saved: true, origin: result.origin, length: result.length }
    },
  }))

  /* ================================================================ *
   * 8. crossfire_report —— 专家提交发言（专家侧工具）
   * ================================================================ */
  ctx.tools.register(defineTool({
    name: 'crossfire_report',
    description: 'Submit your red-team findings for the review you belong to. Use the fixed "观点 N（指向 X，维度Y）：…" structure — one defect per item — so each can be adjudicated separately by the human. Include graded evidence (repro steps for code/behaviour defects, an argument chain for design defects). Give no improvement suggestions: you only point out what does not hold.',
    parameters: {
      content: { type: 'string', required: true, description: 'Your findings: one item per defect, each starting with 观点 N（指向 …，维度 …）：.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recorded: { type: 'boolean', required: true },
          pass: { type: 'integer', required: true },
          tokens_charged: { type: 'integer', required: true },
          budget_remaining_tokens: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Findings recorded (pass ${value.pass}). Token budget remaining: ${value.budget_remaining_tokens}.`,
      }],
    },
    async execute(args, exec) {
      const caller = requireAgent(exec)
      // 宽限查询：归属索引是在 spawn 返回之后登记的，而子代理可能在那之前就已经
      // 跑完一轮（见 expert-events.ts 里对这段竞态的说明）。
      const located = await locateExpertChildWithGrace(caller.id)
      if (located === undefined) {
        throw new Error(
          'crossfire_report is only for red-team experts of a running review '
          + '(if you were just spawned, retry once — your review binding may still be settling)',
        )
      }
      const content = text(args.content)
      if (content === '') throw new Error('content must not be empty')

      const record = await readRecord(located.stateRoot, located.reviewId)
      if (record === undefined) throw new Error(`no review "${located.reviewId}"`)
      assertBudget(record)

      const expert = record.experts.find((candidate) => candidate.childId === caller.id)
      const expertKey = expert?.key ?? 'unknown'
      const utterance: ExpertUtterance = {
        id: randomUUID(),
        expertKey,
        kind: 'speech',
        content: content.slice(0, 20_000),
        pass: record.reviewPass,
        ts: Date.now(),
      }
      await appendTranscript(located.stateRoot, located.reviewId, utterance)
      const charged = estimateTokens(utterance.content)
      const remaining = await mutateRecord(located.stateRoot, located.reviewId, (current) => {
        chargeTokens(current, utterance.content)
        if (expert !== undefined) {
          const target = current.experts.find((candidate) => candidate.childId === caller.id)
          if (target !== undefined) {
            target.status = 'done'
            // 实时记下"提交过几次"。`defectCount` 要等 collect 拆分后才有值，
            // 在此之前卡片必须能显示这位专家确实交了东西。
            target.reportCount = (target.reportCount ?? 0) + 1
          }
        }
        return Math.max(0, current.budget.maxTokens - current.budget.usedTokens)
      })
      return {
        recorded: true,
        pass: utterance.pass,
        tokens_charged: charged,
        budget_remaining_tokens: remaining ?? 0,
      }
    },
  }))
}

/**
 * 归属识别说明：`crossfire_report` 只认**专家索引**（expert-events 的进程内
 * childId → 评审位置）。专家是通过 `startContinuable` 拉起的子代理，唯一可靠的
 * 归属线索就是它的 childId。刻意不去"扫所有评审找 ownerSessionId 匹配" ——
 * 那样会让一个普通会话冒充专家提交发言。
 */
