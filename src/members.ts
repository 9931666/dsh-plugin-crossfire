/**
 * 红队专家的子代理生命周期：为一位专家拉起一个**可续聊**子代理、把消息投进它的
 * 下一轮、必要时打断它。
 *
 * 与圆桌 meetings 的 members.ts 相比，这里刻意薄得多：
 * 没有拓扑、没有连线、没有转述链路 —— 专家只做一件事：攻击指定维度并 report。
 *
 * ## 安全边界（本文件是它的落点）
 *
 * 专家的 `toolFilter` 是**只读白名单**（见 redteam.ts 的 `EXPERT_TOOL_ALLOW`）：
 * 它们能读文件取证，但**不能写**、不能执行命令、不能联网。这条边界是针锋与
 * 普通"多个 agent 分工干活"最本质的区别 —— 验收器不该有改动被测对象的能力。
 *
 * @module dsh-plugin-crossfire/members
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CrossfireRecord, RedTeamExpert } from './types.ts'
import { expertPersona, expertToolRestriction, expertWelcome, type ExpertPersonaInput } from './redteam.ts'

/**
 * 本插件自己声明的 `MessageSourceMap` 条目。
 *
 * 0.2.0-rc.2 移除了宿主 catch-all 的 `plugin` kind（`MessageSourceMap` 只保留
 * `user` / `model` / `tool` / `system-prompt`），其余一律由**生产者在自己的模块里
 * 声明**。这里照同一模式补上 crossfire 的 kind，而不是退化成匿名的 `user` 消息：
 * 转录消费者据此把"插件注入的提示"与"用户自己说的话"分开。运行时无影响。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 针锋插件注入的评审任务消息。 */
    crossfire: {
      kind: 'crossfire'
      /** 生产者标识，便于在转录里追溯来源。 */
      plugin: string
    }
  }
}

/** 拉起专家所需的运行时开关（来自插件 Config）。 */
export interface MemberRuntimeConfig {
  /** 已注册的 `ctx.subagents` provider 名（必须支持 continuable + persona）。 */
  provider: string
  /** 委派深度上限（默认 1：红队专家不得再招人）。 */
  maxDepth?: number
  /**
   * 专家**继承**主持人时实际生效的模型路由。
   *
   * 主要用途是可观测性：写回记录后卡片才能把"继承"画成真实品牌（DeepSeek 的蓝色
   * DS 块），而不是一个中性灰 `?`。取不到时不写（界面退化为 `?` + "继承主持人"提示）。
   *
   * 另一处用途（A5）：阵容成员**只填了 model** 时，`defaultProvider` 是真正参与路由
   * 的那个 provider（补进 agentOptions 并写回记录）。只在纯继承的情形下它才是纯
   * 可观测值 —— 而且它**不会**被用来顶替某个成员自己指定的 model。
   */
  defaultProvider?: string
  defaultModel?: string
}

/** 一位专家的输出限制。 */
export interface ExpertRuntimeLimits {
  /** 单轮输出 token 上限（0/未设 = provider 默认）。 */
  maxTokens?: number
  /** 这位专家最多提几条缺陷（0 = 不限制）。 */
  maxOpinions?: number
}

/** 专家子代理的 label 前缀（持久化为该子会话的创建标签，便于在宿主侧辨认）。 */
const EXPERT_LABEL_PREFIX = 'crossfire-expert:'

/** 取一个"真的写了东西"的字符串；空串与纯空白一律视为**缺席**。 */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 一位专家最终生效的路由决定。 */
export interface ExpertRoute {
  /** 写回记录的 provider；缺席 = "继承 / 未知"（界面退化为中性块，而不是一个假路由）。 */
  provider?: string
  /** 写回记录的 model；缺席 = 同上。 */
  model?: string
  /** **真正**交给 `startContinuable` 的 agentOptions（空对象 = 完全不干预路由）。 */
  agentOptions: { provider?: string; model?: string }
}

/**
 * 把"专家显式指定的路由"与"宿主默认路由"收敛成一份确定的路由决定（A5 + B3）。
 *
 * ## 一条铁律
 *
 * **写回记录的值 = 真正下发的值。** 记录与下发必须由**同一次决定**产生，否则界面
 * 会显示一条并非事实的路由（红队抓出的原缺陷：只填了 provider 的成员，记录里却被
 * 写成 `defaultProvider` + `defaultModel` —— 界面说跑 A，实际跑 B）。
 *
 * ## 四种组合的行为（全都是确定的，没有"看情况"）
 *
 * | 专家显式指定 | agentOptions（下发） | 写回记录 |
 * |---|---|---|
 * | provider + model | `{provider, model}` | provider、model |
 * | 只有 provider | `{provider}` | provider（**不补 model**） |
 * | 只有 model | `{defaultProvider?, model}` | provider（补上的那个）、model |
 * | 都没有（继承） | `{}`（不干预） | defaultProvider、defaultModel |
 *
 * 逐条理由：
 * - **只有 provider 时刻意不补 model**：`provider` 自己会选它的默认模型，我们没有
 *   任何依据知道那会是哪一个；拿 `config.defaultModel` 去顶替就是编造（那正是原
 *   缺陷的写法）。记录的 `model` 缺席是诚实的"不知道"。
 * - **只有 model 时补 `defaultProvider`**：一个不给 provider 的 model id 在多数路由上
 *   无法解析，而"只写 model、不写 provider"在用户眼里就是"用默认 provider 跑这个
 *   模型"。补上的值同时写回记录 —— 于是界面显示的正是真正下发的。
 * - **都没有时 agentOptions 为空**：这一种情形下我们**不替宿主做决定**，真正的继承
 *   必须保持是继承。记录里那份 `defaultProvider`/`defaultModel` 是配置里声明的
 *   "继承主持人时**实际生效**的模型路由"（见 index.ts / ToolsConfig 的同一段注释），
 *   写它只为把"继承"画成真实品牌块（否则头像永远是中性灰 `?`，那是用户报过的缺陷）。
 *   这是**唯一**一处记录值不等于 agentOptions 的字段 —— 而它们仍然同源：记录里出现的
 *   每一个字段，要么是我们显式下发的，要么是宿主默认路由本身。
 * - **取不到生效值的字段一律不写**（保持"缺失 = 继承"的诚实语义），也不写空串。
 *
 * 纯函数：没有 I/O、没有时间、不改入参，所以四种组合都能被单测直接钉住
 * （见 `test/members.test.mjs`）。
 */
export function resolveExpertRoute(
  expert: { provider?: string; model?: string },
  config: { defaultProvider?: string; defaultModel?: string },
): ExpertRoute {
  const explicitProvider = nonEmpty(expert.provider)
  const explicitModel = nonEmpty(expert.model)
  const fallbackProvider = nonEmpty(config.defaultProvider)
  const fallbackModel = nonEmpty(config.defaultModel)

  const agentOptions: { provider?: string; model?: string } = {}
  if (explicitProvider !== undefined) agentOptions.provider = explicitProvider
  // 只有 model：补一个默认 provider，否则这个 model 在多数路由上无解。
  else if (explicitModel !== undefined && fallbackProvider !== undefined) agentOptions.provider = fallbackProvider
  if (explicitModel !== undefined) agentOptions.model = explicitModel

  const route: ExpertRoute = { agentOptions }
  if (agentOptions.provider !== undefined) route.provider = agentOptions.provider
  else if (explicitProvider === undefined && explicitModel === undefined && fallbackProvider !== undefined) {
    // 纯继承：写回"宿主默认路由"，只为可观测性（见上面的逐条理由）。
    route.provider = fallbackProvider
  }
  if (agentOptions.model !== undefined) route.model = agentOptions.model
  else if (explicitProvider === undefined && explicitModel === undefined && fallbackModel !== undefined) {
    route.model = fallbackModel
  }
  return route
}

/**
 * 拉起一位红队专家，返回它的子会话 id。
 *
 * 失败一律抛错且**不落任何状态** —— 调用方负责把 `expert.status` 记成 `failed`
 * 并把消息写进 `expert.note`，而不是留下一个"看起来在跑其实根本没起来"的专家。
 */
export async function spawnExpert(
  ctx: Context,
  config: MemberRuntimeConfig,
  record: CrossfireRecord,
  expert: RedTeamExpert,
  parent: Agent,
  signal: AbortSignal,
  limits: ExpertRuntimeLimits = {},
): Promise<string> {
  const provider = ctx.subagents.getProvider(config.provider)
  if (provider === undefined) {
    throw new Error(
      `crossfire: no subagent provider "${config.provider}" is registered (available: ${ctx.subagents.list().join(', ') || 'none'}) — `
      + 'check that the subagent provider row (e.g. subagent-spawn) is mounted in the composition',
    )
  }
  if (provider.prepareContinuable === undefined) {
    throw new Error(`crossfire: provider "${config.provider}" does not support continuable experts`)
  }

  const input: ExpertPersonaInput = {
    reviewId: record.reviewId,
    dimension: expert.dimension,
    title: record.subject.title,
    subject: record.subject.content,
    stance: record.stance.text,
    dimensions: record.dimensions,
    maxOpinions: limits.maxOpinions ?? 0,
    // 用户的补充角色定位（来自阵容/角色预设）。它进 persona 的「你的角色定位」段，
    // 那一段带着不可覆盖的声明 —— 这条文本不能用来放宽只读边界。
    ...(expert.role === undefined ? {} : { role: expert.role }),
  }

  // Per-request output cap: model max_tokens applied to every request this
  // expert makes (0/unset = the provider's own default).
  //
  // 路由（provider / model）由 `resolveExpertRoute` **一次决定**，记录与下发共用
  // 它的结果 —— 不允许出现"记录写 A、实际跑 B"（见该函数的注释）。
  const route = resolveExpertRoute(expert, config)
  const agentOptions: { provider?: string; model?: string; maxTokens?: number } = { ...route.agentOptions }
  if (limits.maxTokens !== undefined && limits.maxTokens > 0) {
    agentOptions.maxTokens = limits.maxTokens
  }

  // 把这位专家**实际使用的路由**写回记录：逐字段等于 `route` 的决定，取不到生效值
  // 就删掉该字段（"缺失 = 继承"必须看得见，而不是留一个空串或上一轮的残值）。
  if (route.provider === undefined) delete expert.provider
  else expert.provider = route.provider
  if (route.model === undefined) delete expert.model
  else expert.model = route.model

  // persona **只生成一次**：同一个常量既用于下发、也用于落盘。
  //
  // 这不是省一次函数调用，而是这个字段的正确性来源：如果下发与落盘各调一次
  // `expertPersona()`，任何一次参数漂移（或函数内部带了时间戳之类的非纯行为）都会让
  // "查看原提示词"显示的东西与专家真正收到的东西不是同一份 —— 而那正是我们要修的缺陷。
  const persona = expertPersona(input)

  const prompt: ContentBlock[] = [{ type: 'text', text: expertWelcome(input) }]
  const request: Record<string, unknown> = {
    prompt,
    parent,
    ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
    ...(config.maxDepth === undefined ? {} : { maxDepth: config.maxDepth }),
  }

  // 0.2.1 收敛了子代理契约：`startContinuable` 与 per-child `persona`/`toolFilter`
  // 一起被移除（persona 归 system-prompt / agent preset，工具面由 preset 拥有）。
  // 按运行时形状二选一，不把探测变成加载门禁：两个入口都缺才报错。
  //
  // **只读边界的退化**：旧宿主用 `toolFilter`（白名单）硬保证专家不能写、不能执行、
  // 不能联网；新宿主没有这个通道，边界退化为 persona 里的文字约束（见 redteam.ts
  // 的「工具边界」段）。要恢复硬边界，需要宿主提供只读 preset 并通过 `agentPreset`
  // 选择 —— 本文件已支持（见下方 agentPreset 透传），但 preset 必须在 profile 里
  // 静态声明，不能由插件运行时注册。
  const subagents = ctx.subagents as unknown as {
    startActivation?: (spec: {
      provider: string
      label: string
      request: Record<string, unknown>
      signal: AbortSignal
      delivery: 'parent' | 'caller'
    }) => Promise<{ childId: unknown }>
    startContinuable?: (spec: {
      provider: string
      label: string
      request: Record<string, unknown>
      signal: AbortSignal
    }) => Promise<{ childId: unknown }>
  }

  const label = `${EXPERT_LABEL_PREFIX}${record.reviewId}:${expert.key}`
  let childId: unknown
  if (typeof subagents.startActivation === 'function') {
    request.prompt = [...prompt, { type: 'text', text: persona }]
    const started = await subagents.startActivation({
      provider: config.provider,
      label,
      request,
      signal,
      delivery: 'parent',
    })
    childId = started.childId
  } else if (typeof subagents.startContinuable === 'function') {
    const started = await subagents.startContinuable({
      provider: config.provider,
      label,
      request: { ...request, persona, toolFilter: expertToolRestriction() },
      signal,
    })
    childId = started.childId
  } else {
    throw new Error('crossfire: the host exposes neither startActivation (0.2.1+) nor startContinuable (older) — cannot spawn an expert')
  }
  // 落盘时机**在拉起成功之后**：拉起失败时什么都不记（调用方会把 status 记成
  // failed），避免留下一份"看起来下发过、其实没发出去"的原文。
  expert.persona = persona
  return String(childId)
}

/**
 * 把一条消息投进某位专家的下一轮（best effort）。
 *
 * @returns true = 宿主接受了投递；false = 失败（已记日志，由调用方决定怎么办）。
 */
export async function deliverToExpert(
  ctx: Context,
  parent: Agent,
  childId: string,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await ctx.subagents.sendMessage(
      parent,
      childId as SessionId,
      [{ type: 'text', text }],
      { signal },
    )
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`crossfire: followup to expert ${childId} failed: ${String(error)}`)
    return false
  }
}

/** 请求取消某位专家当前这一轮（fire and return）。 */
export function interruptExpert(ctx: Context, parent: Agent, childId: string): void {
  try {
    ctx.subagents.interrupt(childId as SessionId, { kind: 'ancestor', agent: parent })
  } catch (error: unknown) {
    ctx.logger.warn(`crossfire: interrupt of expert ${childId} failed: ${String(error)}`)
  }
}

/**
 * 打断一位专家，**不需要**一个活着的 parent Agent。
 *
 * `ctx.subagents.interrupt` 需要祖先 Agent 作为授权凭据，因此在只持有 session id
 * 的路径上（浏览器 RPC、或 parent 已离线的场景）用不了。宿主的 remote face 正是
 * 为这种情况提供的："what keeps a live child interruptible while its parent Agent
 * is offline"。
 *
 * @returns true = 宿主接受了请求。
 */
export function interruptExpertByParent(ctx: Context, childId: string, parentSessionId: string): boolean {
  if (childId === '' || parentSessionId === '') return false
  const subagents = ctx.subagents as unknown as {
    interruptByParent?: (childId: SessionId, parentId: SessionId, mode: 'continuable') => unknown
  }
  if (typeof subagents.interruptByParent !== 'function') return false
  try {
    subagents.interruptByParent(childId as SessionId, parentSessionId as SessionId, 'continuable')
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`crossfire: interruptByParent of expert ${childId} failed: ${String(error)}`)
    return false
  }
}
