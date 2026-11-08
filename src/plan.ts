/**
 * 评审启动前的设置确认卡（R1）：草案数据结构 + 卡片 Markdown 渲染 + 答案解析。
 *
 * ## 为什么要有这张卡
 *
 * 用户点「确定开始」之前就得**看全**将要发生什么：评审标题、来源、强度档
 * （每维几位专家、复审上限、轮数、Token）、维度、立场，以及每一位红队专家的
 * 维度 / key / 模型 / 角色 / 提示词。它把"即将开评"从一句"我开始了"变成一份
 * 可核对的清单 —— 用户在点按钮之前就能发现"专家怎么跑到另一个模型上了"。
 *
 * ## 为什么是两张表而不是一行行文字
 *
 * 同一份信息用表格摊开时，用户能**按列横着比**（例如逐个看模型或提示词），
 * 而条目式文本只能竖着读。针锋最容易配错的恰恰是"某一位专家的某一列"。
 *
 * ## 为什么这里不落盘、不拉专家
 *
 * 这个模块只做渲染与解析。真正的创建仍由主持人调用 `crossfire_open` 完成
 * （与圆桌 `plan.ts` 的分工一致）：确认工具一旦顺手建记录，用户改一次草案就会
 * 在磁盘上留下一条没人用的空记录，"确认前不产生任何状态"这条不变量就没了。
 *
 * @module dsh-plugin-crossfire/plan
 */

import { INTENSITY_SPECS, type Intensity } from './types.ts'

/** 卡片上"批准"选项的固定标签；`intent.approve` 必须与它逐字一致。 */
export const PLAN_APPROVE_LABEL = '确定开始'

/** 卡片上的次选项：用户想改点什么。 */
export const PLAN_REVISE_LABEL = '仍需修改'

/** 表 2 里的一位专家（= 本次评审将拉起的那一行）。 */
export interface DraftExpert {
  /** 专家 key（缺省就是维度名；用户想换一个称呼时才会不同）。 */
  key: string
  /** 负责的维度。 */
  dimension: string
  /** 用户补充的角色定位。 */
  role?: string
  provider?: string
  model?: string
  /** 用户补充的提示词（进 persona 的「评审者补充提示词」段）。 */
  prompt?: string
}

/**
 * 一张确认卡所描述的评审草案（尚未创建）。
 *
 * 字段与 `crossfire_open` 的入参一一对应，外加 `changes` / `revised`，这样用户
 * 确认后主持人可以**原样**按草案调用 `crossfire_open`，不再自行拍参数。
 */
export interface ReviewDraft {
  /** 一句话标题（卡片抬头 + 导出标题）。 */
  title: string
  /** 待验证正文。 */
  content: string
  /** 来源。 */
  source: 'manual' | 'chat' | 'file'
  /** 来源引用（文件路径或对话锚点）。 */
  sourceRef?: string
  /** 本次采用的维度（已归一化）。 */
  dimensions: string[]
  /** 强度档。 */
  intensity: Intensity
  /** 用户的立场与理由（可空）。 */
  stance: string
  /** 红队阵容（已按维度展开；用户改过的行以这里为准）。 */
  experts: DraftExpert[]
  /** 轮数上限（超限闭麦）。 */
  maxRounds: number
  /** Token 预算（超限闭麦）。 */
  maxTokens: number
  /** 主持人总结的本次变更点（`revised` 时显示在卡片顶部）。 */
  changes: string[]
  /** 本次是"用户要求修改后"的再次确认。 */
  revised: boolean
}

/** 卡片选项的三态解析结果。 */
export type PlanConfirmation =
  | { kind: 'approved' }
  | { kind: 'revise'; note: string }
  /** 服务缺失或用户没给任何选择：主持人应把它当作"再确认一次"。 */
  | { kind: 'unavailable'; note: string }

/** 待验证正文在卡片上最多显示的字数（超出截断，完整正文随评审落盘）。 */
export const SUBJECT_PREVIEW_MAX = 1200

/** 提示词摘要的最大字数（表 2 的「提示词」列）。 */
export const PROMPT_SUMMARY_MAX = 40

/** 立场摘要的最大字数（表 1 的「立场」行）。 */
const STANCE_SUMMARY_MAX = 60

/** 非空判定：`undefined` 与纯空白都算"没写"。 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

/**
 * Markdown 表格单元格转义。
 *
 * 为什么必须做：`|` 会把一行劈成多一列（整张表错位），换行会直接终结表格
 * 结构（后面的内容全变成表外散文）。角色与提示词完全由用户书写，两样都可能
 * 出现，所以每一个**进入表格的**值都必须过这一层。
 */
function cell(value: string): string {
  return value.replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|').trim()
}

/** 多行文本压成一行（只用于摘要，避免摘要里出现换行）。 */
function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** 截断到上限并加省略号（摘要类文本用；全文不截断）。 */
function summarize(value: string, max: number): string {
  const text = flatten(value)
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * 模型路由在卡片上的写法。
 *
 * 四种组合刻意写出**不同的**标签，因为"没填"与"只填了一半"在真实评审里的行为
 * 不同（见 `members.ts` 的 `resolveExpertRoute`）：只填 provider 时由 provider
 * 自选模型，只填 model 时补继承的 provider。把这些折叠成一句"继承主持人"会让
 * 用户以为自己的路由没生效。
 */
function routeLabel(expert: DraftExpert): string {
  const provider = hasText(expert.provider) ? expert.provider.trim() : ''
  const model = hasText(expert.model) ? expert.model.trim() : ''
  if (provider !== '' && model !== '') return `${provider}/${model}`
  if (provider !== '') return `${provider}（模型随该 provider 默认）`
  if (model !== '') return `${model}（provider 继承主持人）`
  return '继承主持人'
}

/** 表 2 的「提示词」列：填了就显示前 40 字，没填明说"自动"。 */
function promptSummary(prompt: string | undefined): string {
  return hasText(prompt) ? summarize(prompt, PROMPT_SUMMARY_MAX) : '自动（九条硬约束）'
}

/** 表 1 的「来源」行。 */
function sourceLabel(draft: ReviewDraft): string {
  const ref = hasText(draft.sourceRef) ? draft.sourceRef.trim() : ''
  return ref === '' ? draft.source : `${draft.source}（引用：${ref}）`
}

/** 表 1 的「强度」行：把这一档真正生效的数字写在同行，用户不必再查设置页。 */
function intensityLabel(draft: ReviewDraft): string {
  const spec = INTENSITY_SPECS[draft.intensity]
  return `${draft.intensity}（每维 ${spec.expertsPerDimension} 位专家 / 复审上限 ${spec.maxReviewPass} / `
    + `预算 ${draft.maxRounds} 轮 · ${draft.maxTokens} tokens）`
}

/** 表 1 的「立场」行：有就前 60 字摘要，没有就明说「无」。 */
function stanceLabel(stance: string): string {
  return hasText(stance) ? `有（${summarize(stance, STANCE_SUMMARY_MAX)}）` : '无'
}

/** 渲染「本次变更」列表（空清单明说"未标注"，不假装有变更）。 */
function changeLines(changes: readonly string[]): string[] {
  const items = changes.map((change) => flatten(change)).filter((change) => change !== '')
  if (items.length === 0) return ['> - （本次未标注具体变更）']
  // 引用块不是表格：这里只需要压掉换行，**不能**把 `|` 转义成 `\|`（那会在
  // 引用块里显示出一个多余的反斜杠）。
  return items.map((change) => `> - ${change}`)
}

/**
 * 把一份草案渲染成卡片正文（Markdown，放 `AskUserQuestionItem.detail`）。
 *
 * 结构固定为：抬头 →（revised 时）本次变更 → 表 1 评审设置 → 表 2 红队阵容 →
 * 待验证正文 → 立场全文 → 修改说明。**顺序有意义**：先给"怎么评"，再给"评什么"，
 * 最后才是"怎么改这张卡"。
 */
export function formatReviewDraft(draft: ReviewDraft): string {
  const title = draft.title.trim() === '' ? '（未命名评审）' : draft.title.trim()
  const lines: string[] = [
    draft.revised
      ? `# 评审设置确认 · ${title}（已按你的意见更新）`
      : `# 评审设置确认 · ${title}`,
    '',
  ]

  if (draft.revised) {
    // 用户改过一轮之后必须先回答"这次改了什么"，否则他要重新逐行比对两张表。
    lines.push('> 本次变更：', ...changeLines(draft.changes), '')
  } else {
    lines.push('> 以下是即将开始的评审设置。**确认后才会真正开始评审。**', '')
  }

  lines.push(
    '## 表 1 · 评审设置',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 评审标题 | \`${cell(title)}\` |`,
    `| 来源 | ${cell(sourceLabel(draft))} |`,
    `| 强度 | ${cell(intensityLabel(draft))} |`,
    `| 维度 | ${cell(draft.dimensions.length === 0
      ? '（未指定）'
      : `${draft.dimensions.join('、')}（${draft.dimensions.length} 个）`)} |`,
    `| 立场 | ${cell(stanceLabel(draft.stance))} |`,
    `| 红队人数 | ${draft.experts.length} 位 |`,
    '',
    '## 表 2 · 红队阵容',
    '',
    '| # | 维度 | 专家 key | 模型 | 角色 | 提示词 |',
    '|---|---|---|---|---|---|',
  )

  if (draft.experts.length === 0) {
    lines.push('| — | （无） | — | — | — | — |')
  } else {
    draft.experts.forEach((expert, index) => {
      lines.push(
        `| ${index + 1} | ${cell(expert.dimension)} | \`${cell(expert.key)}\` | ${cell(routeLabel(expert))} `
        + `| ${cell(hasText(expert.role) ? expert.role.trim() : '（未填）')} | ${cell(promptSummary(expert.prompt))} |`,
      )
    })
  }

  lines.push('', '## 待验证正文', '')

  const content = draft.content.trim()
  if (content === '') {
    lines.push('（未提供正文）')
  } else if (content.length > SUBJECT_PREVIEW_MAX) {
    // 截断必须**明说**，并且告诉用户完整正文仍然随评审落盘 —— 否则用户会以为
    // 评审只看丢了一截的摘要。
    lines.push(
      content.slice(0, SUBJECT_PREVIEW_MAX),
      '',
      `…（正文超过 ${SUBJECT_PREVIEW_MAX} 字，此处已截断；**完整正文随评审落盘**，评审用的是全文。）`,
    )
  } else {
    lines.push(content)
  }

  lines.push('', '## 立场全文', '')
  lines.push(
    hasText(draft.stance)
      ? draft.stance.trim()
      : '（本次未填写立场：红队只按维度攻击，不做立场对攻。）',
  )

  lines.push(
    '',
    '## 修改说明',
    '',
    `需要改哪一项就选「${PLAN_REVISE_LABEL}」，并在输入框写清改什么`
      + '（例：把「安全」这一行的模型换成 zai-coding-cn/glm-5.2、强度改成 quick、正文补上第三节）。',
    '主持人据此更新草案后**会再弹一次**这张卡片；确认前不会创建任何评审。',
  )

  return lines.join('\n')
}

/**
 * 解析用户的卡片回答。
 *
 * 协议与 `intent.kind: 'plan-review'` 的语义一致：`selected` 含
 * `PLAN_APPROVE_LABEL` 即视为批准，其余选项（或只有 custom 文本）视为要求修改。
 * 不识别 intent 的 UI 会退回普通选项列表，答复编码完全相同。
 *
 * 纯空白 custom 不算"要求修改"（那只是用户点错了），统一归 unavailable ——
 * 主持人会改用文字再确认一次，而不是拿一句空话去改草案。
 */
export function resolvePlanConfirmation(
  answer: { selected: string[]; custom?: string } | undefined,
  approveLabel: string = PLAN_APPROVE_LABEL,
): PlanConfirmation {
  if (answer === undefined) return { kind: 'unavailable', note: '' }
  const selected = Array.isArray(answer.selected) ? answer.selected : []
  const note = answer.custom === undefined ? '' : answer.custom.trim()
  if (selected.includes(approveLabel)) return { kind: 'approved' }
  if (note !== '') return { kind: 'revise', note }
  return { kind: 'unavailable', note: '' }
}
