/**
 * 把一场评审渲染成 Markdown 交付物。
 *
 * 与圆桌会议的 `export_review` 同一形态（带预填头的 Markdown，可直接贴进 issue
 * 或存档），但内容围绕 crossfire 的语义重组：**先给已认定缺陷**，因为那才是这
 * 场评审真正的产出；被驳回的观点另立一节，因为"哪些被否掉了"同样是结论，而且
 * 它是下一轮去重的依据。
 *
 * @module dsh-plugin-crossfire/export-md
 */

import { HARNESS_RANGE, PLUGIN_ID } from './version.ts'
import type { CrossfireRecord, Defect } from './types.ts'
import { INTENSITY_SPECS } from './types.ts'

/** 渲染所需的统计（由 review.countDefects 提供）。 */
export interface ExportCounts {
  total: number
  pending: number
  endorsed: number
  rejected: number
  strikes: number
}

/** 把一段多行文本缩进成引用块（用于议题与立场）。 */
function quote(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return '> （空）'
  return trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/** 一条缺陷的正文渲染。 */
function renderDefect(defect: Defect, index: number): string[] {
  const lines: string[] = []
  const marks: string[] = [`\`${defect.dimension}\``]
  if (defect.dimensionFallback === true) marks.push('维度已归一化')
  if (defect.strikesStance === true) marks.push('**打穿立场**')
  if (defect.seq > 0) marks.push(`观点 ${defect.seq}`)
  lines.push(`#### ${index}. ${marks.join(' · ')}`)
  lines.push('')
  lines.push(defect.content)
  lines.push('')
  if (defect.quote !== undefined && defect.quote !== '') {
    lines.push(`> 原文引用：“${defect.quote}”`)
    lines.push('')
  }
  if (defect.evidence !== undefined) {
    const label = defect.evidence.kind === 'repro' ? '可复现步骤' : '论证链'
    lines.push(`**证据（${label}）**：${defect.evidence.text}`)
    lines.push('')
  }
  lines.push(`来源专家：\`${defect.expertKey === '' ? '（未知）' : defect.expertKey}\``)
  lines.push('')
  if (defect.status === 'rejected' && defect.rejectReason !== undefined && defect.rejectReason !== '') {
    lines.push(`驳回理由：${defect.rejectReason}`)
    lines.push('')
  }
  if (defect.recheck !== undefined) {
    // 未判断是**有意义的第三种状态**，不能渲染成"未修复"（那是机器替人下结论）。
    const verdict = defect.recheck.verdict === 'fixed'
      ? '已修复'
      : defect.recheck.verdict === 'partial'
        ? '部分修复'
        : defect.recheck.verdict === 'unfixed'
          ? '未修复'
          : '尚未判断'
    lines.push(`复核（第 ${defect.recheck.pass} 轮认定）：**${verdict}**${defect.recheck.note === undefined ? '' : ` — ${defect.recheck.note}`}`)
    lines.push('')
  }
  return lines
}

/** 渲染整场评审。 */
export function renderReviewMarkdown(record: CrossfireRecord, counts: ExportCounts): string {
  const spec = INTENSITY_SPECS[record.intensity]
  const lines: string[] = []

  lines.push(`# 针锋评审 · ${record.subject.title}`)
  lines.push('')
  lines.push(`> ${PLUGIN_ID}`)
  lines.push(`> 宿主基线：${HARNESS_RANGE}`)
  lines.push(`> 评审 id：\`${record.reviewId}\``)
  lines.push(`> 轮次：第 ${record.reviewPass} 轮 / 上限 ${record.maxReviewPass} 轮`)
  lines.push(`> 强度：${record.intensity}（${spec.label}）`)
  lines.push(`> 状态：${record.status}`)
  lines.push(`> 维度：${record.dimensions.join('、')}`)
  lines.push(`> 表态：认定 ${counts.endorsed} · 驳回 ${counts.rejected} · 待定 ${counts.pending}（共 ${counts.total}）`)
  lines.push('')

  lines.push('## 一、待验证对象')
  lines.push('')
  lines.push(`来源：${record.subject.source}${record.subject.sourceRef === undefined ? '' : `（${record.subject.sourceRef}）`}`)
  lines.push('')
  lines.push(quote(record.subject.content))
  lines.push('')

  lines.push('## 二、用户立场与理由')
  lines.push('')
  lines.push(record.stance.text.trim() === ''
    ? '> （本次评审没有填写立场）'
    : quote(record.stance.text))
  lines.push('')

  const endorsed = record.defects.filter((defect) => defect.status === 'endorsed')
  const pending = record.defects.filter((defect) => defect.status === 'pending')
  const rejected = record.defects.filter((defect) => defect.status === 'rejected')

  lines.push('## 三、已认定缺陷（本次评审的产出）')
  lines.push('')
  if (endorsed.length === 0) {
    lines.push('> （没有认定任何缺陷）')
  } else {
    for (const [index, defect] of endorsed.entries()) lines.push(...renderDefect(defect, index + 1))
  }
  lines.push('')

  if (pending.length > 0) {
    lines.push('## 四、待定缺陷（用户尚未表态）')
    lines.push('')
    for (const [index, defect] of pending.entries()) lines.push(...renderDefect(defect, index + 1))
    lines.push('')
  }

  if (rejected.length > 0) {
    lines.push('## 五、被驳回的观点（用户审阅后否定）')
    lines.push('')
    lines.push('> 这些观点**不会被再次提出**（去重依据）；列出它们是结论的一部分。')
    lines.push('')
    for (const [index, defect] of rejected.entries()) lines.push(...renderDefect(defect, index + 1))
    lines.push('')
  }

  if (record.experts.length > 0) {
    lines.push('## 六、红队阵容')
    lines.push('')
    lines.push('| 专家 | 维度 | 模型 | 状态 | 缺陷数 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const expert of record.experts) {
      const route = expert.provider === undefined || expert.model === undefined ? '（继承主持人）' : `${expert.provider}/${expert.model}`
      const note = expert.note === undefined ? '' : ` ${expert.note}`
      lines.push(`| \`${expert.key}\` | ${expert.dimension} | ${route} | ${expert.status}${note} | ${expert.defectCount} |`)
    }
    lines.push('')
  }

  if (record.history.length > 0) {
    lines.push('## 七、历史轮次')
    lines.push('')
    for (const snapshot of record.history) {
      const endorsedInPass = snapshot.defects.filter((defect) => defect.status === 'endorsed').length
      lines.push(`- 第 ${snapshot.pass} 轮：认定 ${endorsedInPass} 条（共 ${snapshot.defects.length} 条观点）`
        + `${snapshot.revisedSummary === undefined ? '' : ` — 修订：${snapshot.revisedSummary}`}`)
    }
    lines.push('')
  }

  lines.push('## 八、边界声明')
  lines.push('')
  lines.push('- 本记录由「针锋 Crossfire」生成：机器只负责挑错，**结论由人逐条给出**。')
  lines.push('- 认定 / 驳回是用户的操作，插件不提供任何"代表认定"的入口。')
  lines.push('- 红队专家的工具为只读：它们只挑错，从未改动工作区。')
  lines.push('- 用户的历次表态只用于去重与复审递进，不会作为"用户画像"喂给红队。')
  lines.push('')

  return lines.join('\n')
}
