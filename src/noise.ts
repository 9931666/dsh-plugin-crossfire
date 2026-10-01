/**
 * 专家发言的噪音过滤（缺陷收集的第一道闸门）。
 *
 * ## 为什么必须有这一层
 *
 * 圆桌的真实数据里，下面这类**过程叙述**被当成缺陷收进了裁决列表：
 *
 *   `[当前状态] 已收到主持人任务，完成对 17 项清单的四维红队审查；按…`
 *   `[当前状态] 主持人再次派发任务；第一轮 3 条观点已提交（第 7 项语义矛盾 / 批次 10–…`
 *
 * 它们有两个来源：
 *  - 宿主的 `subagent/end` 自动补捕（`kind: 'auto-capture'`）：专家没主动上报结果就
 *    结束了，宿主把它的最后一段话整段当成发言收下 —— 通常只是收尾寒暄或进度叙述；
 *  - 专家自己写的进度汇报：以 `[当前状态]`/`[进度]` 之类的方括号标记开头。
 *
 * 它们不是缺陷，却会挤进用户的表态面：用户被迫对"我收到了任务"点认定或驳回。
 * 判定在这里集中成一处，**缺陷收集侧只调 `isNoiseUtterance`**，规则不外泄。
 *
 * @module dsh-plugin-crossfire/noise
 */

/**
 * 行首的进度/状态标记。命中即视为过程叙述，而不是缺陷。
 *
 * 只认**方括号标记在行首**：真正的缺陷正文不会以 `[当前状态]` 开头，而
 * "第 3 步会打印 `[状态]`"这种出现在正文中间的说法不该被误杀 —— 所以
 * 这里刻意不做全文搜索。
 */
const PROGRESS_MARKER = /^\s*[\[【]\s*(当前状态|状态|进度|任务|当前任务|汇报|确认)\s*[\]】]/

/**
 * 极短发言里的客套话。**只在发言足够短时才生效**（见 rule 4）。
 *
 * 「开始」「已完成确认」这类词单独看毫无信息量；但一条真正的缺陷正文
 * 完全可能包含它们（例如「开始运行前没有做密钥校验」），所以这张表
 * 必须与"长度 ≤ 24"联合判定，不能单独使用。
 */
const ACK_PHRASES = ['收到', '明白', '好的', '已收到', '了解', '开始', '已完成确认'] as const

/** 被认为"极短"的长度上限（按去空白后的字符数）。 */
const ACK_MAX_LENGTH = 24

/** 去空白：所有空白（含全角空格）都折叠掉，便于长度与开头判定。 */
function squeeze(value: string): string {
  return value.replace(/[\s\u3000]+/g, '')
}

/**
 * 命中的噪音规则名（诊断/测试用；不是噪音时返回 `undefined`）。
 *
 * 按顺序判定，命中即返回：`auto-capture` → `progress-report` → `empty`
 * → `acknowledgement`。
 */
export function noiseReason(kind: string, content: string): string | undefined {
  // 规则 1：宿主自动补捕的收尾发言永远不是缺陷（哪怕正文看起来像缺陷 ——
  // 专家自己没上报，就说明它不认为那是它要提交的结论）。
  if (kind === 'auto-capture') return 'auto-capture'

  // 规则 2：行首方括号状态标记 = 过程叙述。半角 [] 与全角 【】 都认。
  if (PROGRESS_MARKER.test(content)) return 'progress-report'

  // 规则 3：空白/空串没有任何可裁决内容。
  const squeezed = squeeze(content)
  if (squeezed === '') return 'empty'

  // 规则 4：**必须同时满足"短"和"客套"**才算噪音。
  // 只判客套词会误杀真缺陷（「密钥硬编码在源码里」不含客套词，但
  // 「开始运行前没有做密钥校验」含「开始」）；只判长度则会误杀一切短缺陷
  // （「密钥硬编码在源码里」只有 10 个字）。两个条件缺一不可。
  if (squeezed.length <= ACK_MAX_LENGTH && ACK_PHRASES.some((phrase) => squeezed.includes(phrase))) {
    return 'acknowledgement'
  }

  // 规则 5：其余都不是噪音。
  return undefined
}

/** 这条发言是否应当被排除在缺陷收集之外。 */
export function isNoiseUtterance(kind: string, content: string): boolean {
  return noiseReason(kind, content) !== undefined
}
