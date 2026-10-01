/**
 * Crossfire 预算：一条**熔断线**，不是一台状态机。
 *
 * ## 为什么刻意没有 active / muted / ended
 *
 * 圆桌的预算有三态与"闭麦"：一次会议是持续存在的对象，预算耗尽只是把它**调成
 * 静音**，之后还能靠 `roundtable_set_budget` 补预算复活。针锋没有多轮辩论，
 * 预算的角色因此完全不同 —— 它唯一的作用是**在超限的那一刻把后续工作停下来并
 * 报错**。停下不改变任何评审状态：`status` 由 `review.ts` 独占管理，本模块
 * **一行都不写 `record.status`**（这是设计边界，不是疏忽）。
 *
 * ## 两条判据（与设置页「0 = 不限制」严格一致）
 *
 * - `rounds`：`usedRounds > maxRounds`。设 N 轮就能开满 N 轮，只有想开第 N+1 轮
 *   才触顶 —— `>=` 会让 `maxRounds = 10` 实际只能开 9 轮，对面向用户的设置项
 *   不直觉（圆桌已经踩过这个坑，注释里写明了原因，这里沿用同一口径）。
 * - `tokens`：`usedTokens >= maxTokens`，且仅当 `maxTokens > 0` 时才判。
 * - 两条轴的 `max*` 为 `0` 时该轴**不限制**（设置页对这四个数字字段都写着
 *   「0 = 不限制」，实现必须与文案一致，否则用户关掉限制反而被立刻熔断）。
 *
 * ## 调用方契约
 *
 * `chargeTokens` / `beginPass` 都是**原地修改** `record` 的纯计算，不落盘 ——
 * 落盘由调用方负责（状态写入统一走 `state.ts` 的原子写 + 进程内锁）。
 *
 * @module dsh-plugin-crossfire/budget
 */

import type { CrossfireRecord } from './types.ts'

/**
 * 估算文本的 token 成本（粗估：CJK 0.6/字，其它非空白 0.3/字符，向上取整）。
 *
 * 口径与圆桌 `budget.ts` 的 `estimateTokens` **完全一致**（逐字符 `for...of`
 * 按码点遍历，`code >= 0x2e80` 记 CJK，空白不计入 other，最后 `Math.ceil`）。
 * 这是刻意照搬而不是重新设计：两个插件对同一段中文给出的预算数字必须可比。
 *
 * 再次强调：这是一个**已说出的文本长度估算**，不是模型真实用量。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x2e80) cjk += 1
    else if (char.trim() !== '') other += 1
  }
  return Math.ceil(cjk * 0.6 + other * 0.3)
}

/**
 * 哪条预算轴被突破（无则 `undefined`）。
 *
 * 语义（与圆桌一致，见文件头）：两条轴的 `max*` 为 `0` 表示该轴不限制。
 * 返回的是**轴名**，不是布尔 —— 调用方需要把它透出给用户，让"是哪条线断了"
 * 可诊断，而不是笼统的一句"预算用完了"。
 */
export function budgetExceeded(record: CrossfireRecord): 'rounds' | 'tokens' | undefined {
  const { maxRounds, maxTokens, usedRounds, usedTokens } = record.budget
  // 设 N 轮就能开 N 轮：`usedRounds` 是"已开启的轮次"，只有想开第 N+1 轮时才触顶。
  // maxRounds === 0 时该轴不限制，必须提前返回而不是顺手判 `>=`。
  if (maxRounds > 0 && usedRounds > maxRounds) return 'rounds'
  if (maxTokens > 0 && usedTokens >= maxTokens) return 'tokens'
  return undefined
}

/**
 * 预算熔断错误。
 *
 * 不是"会议已结束"，也不是"会议被静音"：针锋只有这一种停止原因，且**可恢复**
 * —— 用户把设置里的上限调大即可继续（状态从未被改动，所以不存在"复活"一说）。
 */
export class CrossfireMutedError extends Error {
  readonly axis: 'rounds' | 'tokens'
  constructor(reviewId: string, axis: 'rounds' | 'tokens') {
    super(
      `crossfire: review "${reviewId}" hit the ${axis} budget cap — later work stops here; ` +
        'raise the cap in the Crossfire settings to continue (the review status was not changed)',
    )
    this.name = 'CrossfireMutedError'
    this.axis = axis
  }
}

/**
 * 熔断门禁：超限即抛 {@link CrossfireMutedError}，否则什么都不做。
 *
 * **不修改 `record`**（与圆桌 `markMuted` 的本质区别）：针锋不把"超预算"写成
 * 一个持久状态，因为那个状态会反过来挡住用户自救的路径 —— 圆桌的真实事故就是
 * `ensureActive` 先改状态再抛错，导致连补预算/导出都被同一个门禁拒绝，花完预算
 * 的会议永远卡在 `active` 却什么都做不了。这里只抛、不改，问题无从被固化。
 *
 * @param record - 被检查的评审记录。
 * @param options.allowMuted - 收尾路径（导出、表态、定稿）必须保持可达，
 *   否则用户连"把已经打出来的缺陷看完并裁决"都做不了；置 `true` 时直接放行。
 */
export function assertBudget(record: CrossfireRecord, options: { allowMuted?: boolean } = {}): void {
  if (options.allowMuted === true) return
  const axis = budgetExceeded(record)
  if (axis !== undefined) throw new CrossfireMutedError(record.reviewId, axis)
}

/**
 * 把一段专家输出计入 token 用量（**原地修改** `record`，由调用方负责落盘）。
 *
 * 只在文本非空时累加，避免空发言把 `usedTokens` 上一堆无意义的 `+0` 调用；
 * 估算口径交给 {@link estimateTokens}，本函数不做任何额外加权。
 */
export function chargeTokens(record: CrossfireRecord, text: string): void {
  if (text === '') return
  record.budget.usedTokens += estimateTokens(text)
}

/**
 * 推进一轮：`reviewPass += 1` 并同步 `budget.usedRounds`，返回新的轮次。
 *
 * 这里**不**做预算检查：门禁由调用方在动手之前调用 {@link assertBudget}，因为
 * "先检查后推进"的顺序一旦反过来，第 N+1 轮的副作用就已经发生了。
 * `usedRounds` 与 `reviewPass` 必须同进同退，两者脱钩会让预算判据失去意义。
 */
export function beginPass(record: CrossfireRecord): number {
  record.reviewPass += 1
  record.budget.usedRounds = record.reviewPass
  return record.reviewPass
}
