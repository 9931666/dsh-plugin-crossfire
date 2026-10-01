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
  if (!provider.capabilities.persona) {
    throw new Error(`crossfire: provider "${config.provider}" cannot apply an expert persona`)
  }
  if (!provider.capabilities.toolFilter) {
    throw new Error(`crossfire: provider "${config.provider}" cannot restrict expert tools (the read-only guarantee needs this)`)
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
  const agentOptions: { provider?: string; model?: string; maxTokens?: number } = {}
  if (expert.provider !== undefined && expert.model !== undefined) {
    agentOptions.provider = expert.provider
    agentOptions.model = expert.model
  }
  if (limits.maxTokens !== undefined && limits.maxTokens > 0) {
    agentOptions.maxTokens = limits.maxTokens
  }

  const started = await ctx.subagents.startContinuable({
    provider: config.provider,
    label: `${EXPERT_LABEL_PREFIX}${record.reviewId}:${expert.key}`,
    request: {
      prompt: [{ type: 'text', text: expertWelcome(input) }] as ContentBlock[],
      parent,
      persona: expertPersona(input),
      toolFilter: expertToolRestriction(),
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      ...(config.maxDepth === undefined ? {} : { maxDepth: config.maxDepth }),
    },
    signal,
  })
  return String(started.childId)
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
