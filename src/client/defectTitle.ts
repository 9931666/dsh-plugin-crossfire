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
 * ## 标题从哪里来（三层，逐层兜底）
 *
 * 1. **压缩信封**：`观点 N（指向 dsh-plugin-crossfire/src/client/ReviewCard.module.css:106-176，维度 交互）`
 *    → `观点 N · ReviewCard.module.css:106-176 · 交互`
 *    红队写**完整路径**是对的（审计要能定位到文件），但它不该占满标题 —— 用户实测反馈：
 *    "标题过长，导致后面无法显示；且有很多无用信息，比如路径的位置，这个可以放在内容里"。
 *    所以完整路径仍留在缺陷正文（可追溯），标题只留**文件名 + 行号 + 维度**。
 * 2. **原始信封**（压缩不出来时，例如括号里没有 `指向`/`维度` 的旧格式）→ 原样返回前缀。
 * 3. **首句兜底**：未按格式提交时取首句（按换行、再按中英文句末标点切，限长）。
 *
 * **绝不**返回空串 —— 标题位空了比不显示更糟。
 */

/** 标题硬上限（字符）。超过即截断并加省略号。 */
const TITLE_MAX = 80

/** 压缩后的单个片段上限（文件名或维度名过长时截断，避免任一片段独吞整行）。 */
const PART_MAX = 40

/**
 * 信封：`观点 N（…）` / `观点N(…)`。
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
 * 信封内部：`观点 N（指向 X，维度 Y）` 的三段。
 *
 * `指向` 后取到**逗号或右括号**为止（中英文逗号、顿号都认）；`维度` 后取到右括号为止。
 * 用 `[\s\S]` 而不是 `.`：定位串里可能出现换行（红队偶尔换行排版）。
 */
const ENVELOPE_PARTS = /^观点\s*(\d+)\s*[（(]\s*指向\s*([\s\S]*?)\s*[，,、]\s*维度\s*([\s\S]*?)\s*[）)]/

/**
 * 从一条缺陷正文里导出标题。见模块注释的三层兜底。
 *
 * @param content 缺陷原文（可以是任意多行文本）。
 * @returns 非空标题，最长 {@link TITLE_MAX} 字符。
 */
export function defectTitle(content: string): string {
  const text = content.trim()
  const envelope = ENVELOPE.exec(text)
  if (envelope !== null && envelope[1] !== undefined) {
    const raw = envelope[1].trim()
    const compact = compactEnvelope(raw)
    return take(compact ?? raw, TITLE_MAX)
  }
  // 逐句切：先按换行取首段（标题必须是一行 —— 内嵌换行会把折叠态撑成多行大块），
  // 再按句末标点取首句。
  const firstLine = text.split(/\r?\n/)[0] ?? text
  const firstSentence = firstLine.split(/(?<=[。．.；;！!？?])/)[0] ?? firstLine
  const title = firstSentence.trim()
  if (title === '') return take(text, TITLE_MAX)
  return take(title, TITLE_MAX)
}

/**
 * 把信封压缩成 `观点 N · 文件名:行号 · 维度`。
 *
 * @returns 压缩结果；**形状不认识时返回 `undefined`**（调用方退回原始前缀），
 *          而不是硬拼一个残缺标题。
 */
function compactEnvelope(envelope: string): string | undefined {
  const parts = ENVELOPE_PARTS.exec(envelope)
  if (parts === null) return undefined
  const index = parts[1] ?? ''
  const pointer = shortPointer(parts[2] ?? '')
  const dimension = (parts[3] ?? '').trim().replace(/\s+/g, ' ')
  if (index === '' || pointer === '' || dimension === '') return undefined
  return `观点 ${index} · ${take(pointer, PART_MAX)} · ${take(dimension, PART_MAX)}`
}

/**
 * 把"指向"里的定位串压成**文件名 + 行号**：
 *
 *   `dsh-plugin-crossfire/src/client/ReviewCard.module.css:106-176` → `ReviewCard.module.css:106-176`
 *   `src/a.ts`                                                     → `a.ts`
 *   `README.md`                                                    → `README.md`
 *
 * 只认 `/` 与 `\` 两种分隔符（Windows 路径也要能压）。文件名与行号之间的冒号保留 ——
 * 行号是"跳到哪一行"的关键信息，不能丢。
 */
function shortPointer(pointer: string): string {
  const compact = pointer.trim().replace(/\s+/g, ' ')
  if (compact === '') return ''
  const file = compact.split(/[/\\]/).pop() ?? compact
  return file.trim()
}

/**
 * 截断到 `max` 个字符；被截断时补省略号。
 *
 * 省略号只在**真的截掉了内容**时加：`text` 恰好 `max` 字时不该显示一个假的"还有更多"。
 */
function take(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
