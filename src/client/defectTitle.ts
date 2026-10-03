/**
 * 观点标题：一条缺陷卡片的"抬头"。
 *
 * 红队的报告信封要求每条发言以 `观点 N（指向 X，维度Y）：正文` 开头，而这个前缀
 * 恰恰就是最有信息量的一行（编号 + 定位 + 维度）。用户反馈："观点虽然说我可以理解，
 * 把完整内容给写出来了，但我觉得还是要在最开始那里立一个标题，这样目的明确"。
 *
 * ## 为什么单独一个模块
 *
 * 标题按钮是**折叠态唯一可见的内容**，所以这里的两条边界（空括号信封、内嵌换行）
 * 一旦退化，肉眼看到的是"整张卡片塌成一团"，而不是一条错误文案。它是纯字符串函数，
 * 因此抽出来直接单测 —— 不需要 jsdom / react 测试环境（本仓库只有 `node:test`）。
 *
 * 兜底顺序：① 用信封前缀（`观点 N（指向 X，维度Y）`）→ ② 未按格式提交时取首句
 * （按换行、再按中英文句末标点切，限长）。**绝不**返回空串 —— 标题位空了比不显示更糟。
 */

/** 标题硬上限（字符）。超过即截断并加省略号。 */
const TITLE_MAX = 80

/**
 * 信封前缀：`观点 N（…）` / `观点N(…)`。
 *
 * 括号内必须**至少有一个既非空白、也非右括号的字符**：`观点 1（）`、`观点 1（ ）`、
 * `观点 1（\u3000）` 是"格式没填"，不是"合法信封"。旧写法 `[^）)]*` 会把它们当成命中
 * 直接返回，于是标题退化成无信息串、还绕过了首句兜底。
 *
 * 首个字符的字符类是 `[^）)\s]` 而不是 `\S`：`\S` 能匹配**右括号本身**，于是
 * `观点 1（）真正的首句。` 会靠回溯让 `\S` 吃掉 `）`、再由 `[^）)]*[）)]` 一路吃到
 * 下一个 `）`（跨过右括号），把一条没按格式提交的发言重新判成合法信封。
 * 两侧的 `\s*` 只作用于**括号内首尾的空白**，正文与冒号之间仍允许空格（`观点 1(指向 y)：`）。
 */
const ENVELOPE = /^(观点\s*\d+\s*[（(]\s*[^）)\s]\s*[^）)]*[）)])\s*[:：]?/

/**
 * 从一条缺陷正文里导出标题。
 *
 * @param content 缺陷原文（可以是任意多行文本）。
 * @returns 非空标题：信封前缀，或首句/首行，最长 {@link TITLE_MAX} 字符。
 */
export function defectTitle(content: string): string {
  const text = content.trim()
  const envelope = ENVELOPE.exec(text)
  // 信封前缀同样封顶：正常信封远短于上限，但"上限"必须是**无条件**的。
  if (envelope !== null && envelope[1] !== undefined) return take(envelope[1].trim(), TITLE_MAX)
  // 逐句切：先按换行取首段（标题必须是一行 —— 内嵌换行会把折叠态撑成多行大块），
  // 再按句末标点取首句。
  const firstLine = text.split(/\r?\n/)[0] ?? text
  const firstSentence = firstLine.split(/(?<=[。．.；;！!？?])/)[0] ?? firstLine
  const title = firstSentence.trim()
  if (title === '') return take(text, TITLE_MAX)
  return take(title, TITLE_MAX)
}

/**
 * 截断到 `max` 个字符；被截断时补省略号。
 *
 * 省略号只在**真的截掉了内容**时加：`text` 恰好 80 字时不该显示一个假的"还有更多"。
 */
function take(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
