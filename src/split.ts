/**
 * 观点拆分：把红队专家的一条发言拆成 1~3 条独立缺陷，用户即可对单条缺陷
 * 「认定/驳回」。
 *
 * 三道防线（沿用圆桌里被真实数据验证过的设计，**不要改**）：
 *  ① JSON schema 严格约束输出（tools 参数 + temperature 0）
 *  ② 任何解析失败 → 返回 null，由调用方整条兜底（seq=0）
 *  ③ quote 必须是发言原文的子串（规范化后 indexOf），否则丢弃该 quote
 *
 * crossfire 相对圆桌的三处改动：
 *  - **维度归一化**：拆分结果里的 dimension 不再直接采信，一律过
 *    `resolveDimension`，保证落库的 dimension 一定 ∈ `allowed`；
 *  - **打穿标记**：每条缺陷可带 `strikesStance`（是否打穿了用户立场里的某条理由）；
 *  - 工具名与 system 提示词按 crossfire 改写。
 *
 * @module dsh-plugin-crossfire/split
 */

import { randomUUID } from 'node:crypto'

import { resolveDimension } from './dimensions.ts'

/** 一条拆分结果（= 一条待裁决的缺陷）。 */
export interface SplitLine {
  content: string
  quote?: string
  /** 归一化后的维度，只要 `allowed` 非空就一定 ∈ allowed。 */
  dimension: string
  /** true = 模型给的原始维度越界/缺失，落库时被归一化过。 */
  dimensionFallback?: boolean
  /** 是否打穿了用户在「立场」里给出的某条理由。 */
  strikesStance?: boolean
  /** 证据分级（C1）：代码/bug 类 = repro（可复现步骤）；设计类 = argument（论证链）。 */
  evidence?: { kind: 'repro' | 'argument'; text: string }
}

/** 拆分调用的模型路由配置（默认 deepseek-official/deepseek-v4-flash，实测可用）。 */
export interface ReviewSplitConfig {
  provider: string
  model: string
  /** 每条发言最多拆几条缺陷（默认 3）。 */
  maxOpinions: number
  /**
   * 拆分阶段的 LLM 并发上限（默认 4；`1` = 串行）。
   *
   * 它是"收集"这一步的墙钟时间决定项：一条发言一次往返，此前是串行 `await`，一场
   * 21 条发言的评审就是 21 次串行往返（红队评审抓出的性能缺陷）。上限刻意不高 ——
   * 这些请求打同一个 provider，拉满只会撞速率限制反而更慢。
   *
   * 放在这里而不是插件 Config：两个调用点（工具与 RPC 直推）读的都是同一个
   * `reviewSplit`，因此两边的并发行为天然一致，不会分叉。
   */
  llmConcurrency?: number
}

/** 最小化 LLM 服务形状（与 ctx.llm.stream 结构兼容）。 */
export interface SplitLlmLike {
  stream(options: {
    provider: string
    model: string
    messages: { id: string; role: 'user'; content: { type: 'text'; text: string }[]; source: { kind: 'user' } }[]
    system?: string
    tools?: { name: string; description: string; parameters: Record<string, unknown> }[]
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<unknown>
}

/** 拆分工具的 JSON schema（防线①）。导出以便测试断言 schema 形状。 */
export const SPLIT_TOOL = {
  name: 'split_crossfire_defect',
  description: '把一条红队专家发言拆成 1~3 条独立缺陷（每条缺陷只含一个问题）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      defects: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', description: '单条缺陷的完整表述。' },
            quote: { type: 'string', description: '发言原文中与该缺陷对应的子串（可选，必须逐字来自发言原文）。' },
            dimension: { type: 'string', description: '缺陷所属维度。必须逐字取自给定清单 allowed 中的一项，不得自创。' },
            strikes_stance: { type: 'boolean', description: '该缺陷是否打穿了用户在「立场」里给出的某条理由。' },
            evidence: {
              type: 'object',
              description: '证据分级（C1）：代码/bug 类缺陷填 repro（附可复现步骤 1. 2. 3.）；设计类缺陷填 argument（附论证链，不编造伪复现步骤）。无法给出证据时省略该字段。',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['repro', 'argument'], description: 'repro=可复现步骤（代码/bug 类）；argument=论证链（设计类）。' },
                text: { type: 'string', description: '证据正文：复现步骤（编号 1. 2. 3.）或论证链，≤600 字符。' },
              },
              required: ['kind', 'text'],
            },
          },
          required: ['content', 'dimension'],
        },
      },
    },
    required: ['defects'],
  },
} as const

const SPLIT_TIMEOUT_MS = 60_000

/** 调用 LLM 一次，收集工具调用参数（或文本 JSON）为字符串；失败返回 null。 */
async function callSplitLlm(
  llm: SplitLlmLike,
  config: ReviewSplitConfig,
  system: string,
  userText: string,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SPLIT_TIMEOUT_MS)
  try {
    const deltas: string[] = []
    let assembled: string | null = null
    const stream = llm.stream({
      provider: config.provider,
      model: config.model,
      messages: [{
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      }],
      system,
      tools: [SPLIT_TOOL],
      temperature: 0,
      maxTokens: 1024,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      const raw = chunk as {
        type?: string
        delta?: unknown
        text?: unknown
        argumentsDelta?: unknown
        block?: { type?: string; arguments?: unknown }
      }
      if (raw.type === 'tool-call-delta' && typeof raw.argumentsDelta === 'string') {
        deltas.push(raw.argumentsDelta)
      } else if (raw.type === 'block-end' && raw.block?.type === 'tool-call' && typeof raw.block.arguments === 'string') {
        // 终态整块已经包含全部分片。旧实现把它与分片一起 join，拼出
        // 「片1片2…{完整 JSON}」——JSON.parse 必然失败并被 catch 吞掉，
        // 于是 LLM 拆分每一次都静默退化为本地正则：观点维度与 C1 证据
        // 分级从未真正生效过。这里改成覆盖式记录，绝不与分片相加。
        assembled = raw.block.arguments
      } else if (raw.type === 'text' && typeof raw.delta === 'string') {
        deltas.push(raw.delta)
      } else if (raw.type === 'text' && typeof raw.text === 'string') {
        deltas.push(raw.text)
      } else if (raw.type === 'text-delta' && typeof raw.text === 'string') {
        // dsh-llm 文本流式块：模型未走工具调用、直接输出 JSON 文本时的兜底收集。
        deltas.push(raw.text)
      }
    }
    // 有组装完成的整块就优先用它；只有在完全没有 block-end 时才退回拼接分片。
    const raw = (assembled ?? deltas.join('')).trim()
    return raw === '' ? null : raw
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 本地启发式兜底拆分（零 token、确定性）：红队专家发言通常按
 * "**观点 N（指向 X，维度Y）**" 的固定结构分条，直接按该标记切段，
 * 并从段首括号里提取维度标签。找不到任何观点标记时返回 null，
 * 由调用方整条兜底（seq=0）。
 */
const VIEWPOINT_MARKER = /(?:\*{1,2})?\s*观点\s*(\d+)\s*[（(]([^）)]*)[）)]/g
const TAIL_SECTION = /\[(?:核心产出|下一步建议)[^\]]*\]/

/** 括号里可能出现的维度引导词，去掉它们才剩下维度名。 */
const DIMENSION_LABEL_WORD = /^(维度|方面|角度|类别|类型)/

/**
 * 专家报告里的「针对立场」标记（`redteam.ts` 的 `reportEnvelopeSpec` 规定每条缺陷里
 * 恰好有一行）。`未` 只允许出现在 `打穿` 之前 —— 见 {@link stanceMarkerStrikes}。
 */
const STANCE_MARKER = /针对\s*立场[^\n]{0,20}?[:：]\s*(未\s*)?打穿/

/**
 * 判定这段文字里专家自己写的「针对立场」结论是不是**打穿**。
 *
 * ## 为什么不能只写 `includes('打穿')`（这是真实存在的坑）
 *
 * `未打穿` 的后两个字就是 `打穿`，纯子串匹配会把"没打穿"读成"打穿了"，方向整个反过来。
 * 所以这里匹配有界的标记（`针对立场…：打穿|未打穿`）并**显式取反**：只有 `未` 缺席时
 * 才算打穿；标记压根不存在（含 `undefined`）也一律算没打穿。
 *
 * 之所以要有这个本地判定：专家的信封格式是**固定**的，报告正文里本来就写着结论。
 * 模型拆分失败退到本地启发式（{@link splitByMarkers}）时不该把这个信号丢掉 ——
 * 那正是"打穿立场"标签永远显示不出来的原因之一。
 */
export function stanceMarkerStrikes(text: string | undefined): boolean {
  if (text === undefined) return false
  const found = STANCE_MARKER.exec(text)
  return found !== null && found[1] === undefined
}

/**
 * 从段首括号的文字里提取维度，并交给 `resolveDimension` 归一化。
 *
 * 上一版的兜底把括号里的圆圈数字（①）直接当成了维度名，产出 `维度②`
 * 这种垃圾值 —— 真实数据显示 5 份 review.json 里全是这种编号。现在改成：
 * 按分隔符拆成若干候选，取**第一个能被归一化到具体维度**的那段；全都不行时
 * 传空串给 `resolveDimension`，由它给出默认维度（并标 fallback）。
 */
function dimensionOfSegmentHead(head: string, allowed: readonly string[]): { dimension: string; fallback: boolean } {
  const pieces = head.split(/[，,、；;｜|/\s]+/).filter((piece) => piece.trim() !== '')
  for (const piece of pieces) {
    // "维度 Y" / "维度Y" 这类引导词要去掉再匹配。
    const candidate = piece.trim().replace(DIMENSION_LABEL_WORD, '').replace(/[：:]+$/, '')
    if (candidate === '') continue
    const resolved = resolveDimension(candidate, allowed)
    if (resolved.how !== 'default') return { dimension: resolved.dimension, fallback: resolved.fallback }
  }
  // 括号里没有可识别文字（或只剩编号）→ 明确走默认归一化，不留编号。
  const fallback = resolveDimension('', allowed)
  return { dimension: fallback.dimension, fallback: fallback.fallback }
}

export function splitByMarkers(content: string, allowed: readonly string[]): SplitLine[] | null {
  const trimmed = content.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return null
  const marks: { start: number; end: number; label: string; head: string }[] = []
  VIEWPOINT_MARKER.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = VIEWPOINT_MARKER.exec(trimmed)) !== null) {
    marks.push({ start: m.index, end: m.index + m[0].length, label: m[1] ?? '', head: m[2] ?? '' })
  }
  if (marks.length === 0) return null
  const lines: SplitLine[] = []
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]
    if (mark === undefined) continue
    const next = marks[i + 1]
    const rawEnd = next !== undefined ? next.start : trimmed.length
    let raw = trimmed.slice(mark.end, rawEnd)
    const tail = raw.search(TAIL_SECTION)
    if (tail !== -1) raw = raw.slice(0, tail)
    const text = raw.replace(/^[\s*:：]+/, '').replace(/\s+/g, ' ').trim()
    if (text === '') continue
    // 注意：维度**不再**取括号里的圆圈数字，而是从括号文字归一化得到。
    const { dimension, fallback } = dimensionOfSegmentHead(mark.head, allowed)
    // 打穿标记（本地兜底）：只看这一段，不看整条发言 —— 否则前面某条写了「打穿」
    // 会让后面每一条都跟着被标成打穿。标记可能落在括号里（专家把结论并进了标记行），
    // 也可能落在正文开头（信封规定的标准位置），两处都查。
    const strikes = stanceMarkerStrikes(mark.head) || stanceMarkerStrikes(text.slice(0, 160))
    lines.push({
      content: `观点 ${mark.label}（${mark.head}）：${text}`,
      dimension,
      ...(fallback ? { dimensionFallback: true } : {}),
      ...(strikes ? { strikesStance: true } : {}),
      quote: undefined,
    })
  }
  return lines.length > 0 ? lines : null
}

/**
 * 拆分一条发言为若干独立缺陷；任何失败返回 null（调用方整条兜底）。
 * quote 与发言原文做规范化子串校验（防线③），不匹配即丢弃。
 * dimension 一律过 `resolveDimension`（落库值必须 ∈ allowed）。
 */
export async function splitUtterance(
  llm: SplitLlmLike,
  config: ReviewSplitConfig,
  expertKey: string,
  content: string,
  allowed: readonly string[],
  stance: string,
): Promise<SplitLine[] | null> {
  const trimmed = content.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return null
  const system = '你是 Crossfire「针锋」评审的缺陷拆分器。把下面一条红队专家发言拆成 1~3 条独立缺陷，每条缺陷只包含一个问题，不得发明原文没有的内容。dimension 必须**逐字取自给定清单 allowed 中的一项**，不得自创标签、不得输出编号；若该缺陷用「立场」中的某条理由打穿了用户的说法，把 strikes_stance 设为 true；**用户没有写立场时（下文明确标注「未填写立场」）一律不得把任何一条标成打穿**。对每条缺陷给出证据分级（C1）：代码/bug 类缺陷的 evidence.kind=repro 并写可复现步骤（1. 2. 3.）；设计类缺陷的 evidence.kind=argument 并写论证链——禁止为设计类缺陷编造"运行某命令即可复现"这类伪复现步骤。无法从原文提取证据时省略 evidence 字段。必须调用 split_crossfire_defect 工具返回结构化结果。'
  const allowedText = allowed.length > 0 ? allowed.join(' / ') : '（未限定，按通用维度判断）'
  // 立场必须**随请求一起交给拆分器**：提示词要求它判断"是否打穿立场"，而此前它连立场
  // 是什么都看不到 —— 于是 strikes_stance 永远是 false，"打穿立场"标签与优先排序从未生效。
  const stanceText = stance.trim() === ''
    ? '（未填写立场）用户这次**没有**写下立场与理由。因此不得把任何一条缺陷标成 strikes_stance=true（没有靶子就没有打穿）。'
    : stance.trim()
  const raw = await callSplitLlm(
    llm,
    config,
    system,
    `本次评审采用的维度清单 allowed（dimension 只能取其中之一）：${allowedText}\n\n用户在本次评审里写下的「立场与理由」：\n${stanceText}\n\n专家 ${expertKey} 的发言：\n${trimmed}`,
  )
  if (raw !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    const list = (parsed as { defects?: unknown } | null | undefined)?.defects
    if (Array.isArray(list) && list.length > 0) {
      const lines: SplitLine[] = []
      for (const item of list) {
        const obj = item as {
          content?: unknown
          quote?: unknown
          dimension?: unknown
          strikes_stance?: unknown
          evidence?: unknown
        } | null | undefined
        const line = typeof obj?.content === 'string' ? obj.content.replace(/\s+/g, ' ').trim() : ''
        if (line === '') continue
        let quote: string | undefined
        if (typeof obj?.quote === 'string') {
          const candidate = obj.quote.replace(/\s+/g, ' ').trim()
          if (candidate !== '' && candidate.length <= 120 && trimmed.includes(candidate)) quote = candidate
        }
        // 打穿标记有两处来源，任一为真即为真（只加不删）：
        //  ① 模型读懂了立场并判定打穿；
        //  ② **专家自己在正文里写下的结论** —— 信封格式固定在每条缺陷里写一行
        //     `针对立场：打穿 / 未打穿`，这是比模型转述更硬的证据。专家报告了打穿、
        //     模型却漏标时，标签不该消失（这正是"打穿立场"从未显示出来的原因之一）。
        const strikes = obj?.strikes_stance === true
          || stanceMarkerStrikes(line)
          || stanceMarkerStrikes(quote)
        // 维度不再直接采信：一律归一化到 allowed 之内（越界值留下 fallback 标记）。
        const resolved = resolveDimension(obj?.dimension, allowed)
        let evidence: SplitLine['evidence']
        const ev = obj?.evidence as { kind?: unknown; text?: unknown } | null | undefined
        if (ev !== null && typeof ev === 'object'
          && (ev.kind === 'repro' || ev.kind === 'argument')
          && typeof ev.text === 'string') {
          const text = ev.text.replace(/\s+/g, ' ').trim()
          if (text !== '') evidence = { kind: ev.kind, text: text.slice(0, 600) }
        }
        lines.push({
          content: line,
          quote,
          dimension: resolved.dimension,
          // 只有严格 true 才算打穿：模型输出 "true"/1 这类不可信值一律忽略。
          ...(strikes ? { strikesStance: true } : {}),
          ...(resolved.fallback ? { dimensionFallback: true } : {}),
          evidence,
        })
        if (lines.length >= Math.max(1, config.maxOpinions)) break
      }
      if (lines.length > 0) return lines
    }
  }
  // LLM 拆分失败（调用异常/解析失败/输出为空）→ 本地启发式兜底（零 token）。
  return splitByMarkers(trimmed, allowed)
}
