/**
 * 评审记录的读写、净化与派生查询。
 *
 * 目录布局（见 state.ts）：`<stateRoot>/crossfire/<reviewId>/`
 *   - `review.json`       — 主记录（本模块负责）
 *   - `transcript.jsonl`  — 专家发言（append-only）
 *
 * ## 设计要点
 *
 * 1. **schemaVersion 缺失视为 1**（与圆桌同款判定）。crossfire 的目录是独立的，
 *    不可能读到圆桌的记录，所以这里刻意不背它的 v1→v2 迁移包袱 —— 但保留"版本
 *    常量 + 迁移函数"的写法，因为下一次改形状时它仍然是对的。
 * 2. **读失败绝不抛给调用方**：坏 JSON / 缺字段 / 类型不符一律降级为默认值，
 *    由 `normalizeRecord` 收敛出一份**永远可用**的记录。界面宁可由空缺陷列表
 *    组成，也不能因为一条脏数据整张卡片消失。
 * 3. **落库的 dimension 必须是本次采用维度之一**（见 dimensions.ts 的理由）。
 * 4. 所有写操作都走**同一把进程内锁**（`reviewLockKey`），与 state.ts 的原子写
 *    叠加，保证同一场评审不会出现两个写者交错。
 *
 * @module dsh-plugin-crossfire/review
 */

import { join } from 'node:path'
import {
  appendJsonLine,
  crossfireRootOf,
  readJsonFile,
  readJsonLines,
  reviewDirOf,
  reviewLockKey,
  withCrossfireLock,
  writeJsonAtomic,
} from './state.ts'
import type {
  CrossfireBudget,
  CrossfireEvidence,
  CrossfireRecord,
  Defect,
  DefectStatus,
  ExpertUtterance,
  Intensity,
  PassSnapshot,
  RecheckVerdict,
  RedTeamExpert,
  Stance,
  Subject,
} from './types.ts'
import { DIMENSION_POOL, INTENSITY_SPECS } from './types.ts'

/** 当前 schema 版本。 */
export const CURRENT_SCHEMA_VERSION = 1 as const

/* ------------------------------------------------------------------ *
 * 0. 路径
 * ------------------------------------------------------------------ */

/** `<reviewDir>/review.json`。 */
export function reviewFile(stateRoot: string, reviewId: string): string {
  return join(reviewDirOf(stateRoot, reviewId), 'review.json')
}

/** `<reviewDir>/transcript.jsonl`。 */
export function transcriptFile(stateRoot: string, reviewId: string): string {
  return join(reviewDirOf(stateRoot, reviewId), 'transcript.jsonl')
}

/** `<reviewDir>/user-actions.jsonl`。 */
export function userActionsFile(stateRoot: string, reviewId: string): string {
  return join(reviewDirOf(stateRoot, reviewId), 'user-actions.jsonl')
}

/** `<reviewDir>/export.md`。 */
export function exportFile(stateRoot: string, reviewId: string): string {
  return join(reviewDirOf(stateRoot, reviewId), 'export.md')
}

/** `<stateRoot>/crossfire`（诊断用）。 */
export function namespaceRoot(stateRoot: string): string {
  return crossfireRootOf(stateRoot)
}

/* ------------------------------------------------------------------ *
 * 1. 净化
 * ------------------------------------------------------------------ */

/** 通用：取一个非空字符串，否则返回 undefined。 */
function asText(value: unknown, max = 4096): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  return text.slice(0, max)
}

/** 通用：取一个非负整数，否则返回 undefined。 */
function asCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const n = Math.floor(value)
  return n < 0 ? undefined : n
}

function sanitizeEvidence(value: unknown): CrossfireEvidence | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as { kind?: unknown; text?: unknown }
  if (raw.kind !== 'repro' && raw.kind !== 'argument') return undefined
  const text = asText(raw.text, 600)
  if (text === undefined) return undefined
  return { kind: raw.kind, text }
}

function sanitizeRecheck(value: unknown): Defect['recheck'] {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as { pass?: unknown; verdict?: unknown; note?: unknown }
  const pass = asCount(raw.pass)
  if (pass === undefined) return undefined
  // 只认三个合法值，其余（含缺失）一律**保持未判断**。
  // 此前这里把任何非 fixed/partial 的值都归一成 'unfixed'，于是"人还没判断"在每次
  // 读盘时都被改写成"人判定为未修复" —— 与开轮时预置默认值是同一个缺陷的另一半。
  const verdict: RecheckVerdict | undefined =
    raw.verdict === 'fixed' || raw.verdict === 'unfixed' || raw.verdict === 'partial'
      ? raw.verdict
      : undefined
  const note = asText(raw.note, 500)
  return {
    pass,
    ...(verdict === undefined ? {} : { verdict }),
    ...(note === undefined ? {} : { note }),
  }
}

/** 净化一条缺陷；内容为空的条目直接丢弃。 */
function sanitizeDefect(value: unknown, index: number, allowed: readonly string[]): Defect | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const content = asText(raw.content, 2000)
  if (content === undefined) return undefined

  const id = asText(raw.id, 128) ?? `defect-${index}`
  const utteranceId = asText(raw.utteranceId, 128) ?? id
  const expertKey = asText(raw.expertKey, 64) ?? ''
  // 维度必须是本次采用维度之一；越界值退回第一个（可见地标记 fallback）。
  const rawDimension = asText(raw.dimension, 32)
  const matched = rawDimension !== undefined && allowed.includes(rawDimension) ? rawDimension : undefined
  const dimension = matched ?? allowed[0] ?? DIMENSION_POOL[0]
  const status: DefectStatus = raw.status === 'endorsed' || raw.status === 'rejected' ? raw.status : 'pending'

  const defect: Defect = {
    id,
    utteranceId,
    expertKey,
    content,
    dimension,
    status,
    ts: asCount(raw.ts) ?? Date.now(),
    seq: asCount(raw.seq) ?? 0,
  }
  if (matched === undefined) defect.dimensionFallback = true
  else if (raw.dimensionFallback === true) defect.dimensionFallback = true

  const quote = asText(raw.quote, 120)
  if (quote !== undefined) defect.quote = quote
  const evidence = sanitizeEvidence(raw.evidence)
  if (evidence !== undefined) defect.evidence = evidence
  if (raw.strikesStance === true) defect.strikesStance = true
  const rejectReason = asText(raw.rejectReason, 500)
  if (rejectReason !== undefined) defect.rejectReason = rejectReason
  const recheck = sanitizeRecheck(raw.recheck)
  if (recheck !== undefined) defect.recheck = recheck
  return defect
}

/** 净化一位专家的状态。 */
function sanitizeExpert(value: unknown): RedTeamExpert | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const key = asText(raw.key, 64)
  if (key === undefined) return undefined
  const dimension = asText(raw.dimension, 32) ?? DIMENSION_POOL[0]
  const status = raw.status === 'running' || raw.status === 'done' || raw.status === 'failed' || raw.status === 'silent'
    ? raw.status
    : 'pending'
  const expert: RedTeamExpert = {
    key,
    dimension,
    status,
    defectCount: asCount(raw.defectCount) ?? 0,
  }
  const childId = asText(raw.childId, 128)
  if (childId !== undefined) expert.childId = childId
  const reportCount = asCount(raw.reportCount)
  if (reportCount !== undefined) expert.reportCount = reportCount
  const provider = asText(raw.provider, 64)
  if (provider !== undefined) expert.provider = provider
  const model = asText(raw.model, 128)
  if (model !== undefined) expert.model = model
  const role = asText(raw.role, 2000)
  if (role !== undefined) expert.role = role
  const note = asText(raw.note, 500)
  if (note !== undefined) expert.note = note
  return expert
}

function sanitizeStance(value: unknown, now: number): Stance {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const text = asText(raw.text, 2000) ?? ''
  const origin = raw.origin === 'manual' || raw.origin === 'distilled' ? raw.origin : 'edited'
  const distilledAt = asCount(raw.distilledAt)
  // 空立场一律视为"手写空文本"：自动提炼失败时就是这条路，卡片必须照常可用。
  return {
    text,
    origin: text === '' ? 'manual' : origin,
    ...(distilledAt === undefined ? {} : { distilledAt }),
    updatedAt: asCount(raw.updatedAt) ?? now,
  }
}

function sanitizeSubject(value: unknown): Subject {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const source = raw.source === 'chat' || raw.source === 'file' ? raw.source : 'manual'
  const subject: Subject = {
    title: asText(raw.title, 200) ?? '未命名评审',
    content: asText(raw.content, 20_000) ?? '',
    source,
  }
  const sourceRef = asText(raw.sourceRef, 512)
  if (sourceRef !== undefined) subject.sourceRef = sourceRef
  return subject
}

function sanitizeBudget(value: unknown, fallback: CrossfireBudget): CrossfireBudget {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    maxRounds: asCount(raw.maxRounds) ?? fallback.maxRounds,
    maxTokens: asCount(raw.maxTokens) ?? fallback.maxTokens,
    usedRounds: asCount(raw.usedRounds) ?? 0,
    usedTokens: asCount(raw.usedTokens) ?? 0,
  }
}

/** 净化一轮历史快照。 */
function sanitizeSnapshot(value: unknown, index: number, allowed: readonly string[]): PassSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const rawDefects = Array.isArray(raw.defects) ? raw.defects : []
  const defects: Defect[] = []
  for (const [position, item] of rawDefects.entries()) {
    const defect = sanitizeDefect(item, position, allowed)
    if (defect !== undefined) defects.push(defect)
  }
  const intensity: Intensity = raw.intensity === 'quick' || raw.intensity === 'deep' ? raw.intensity : 'standard'
  const snapshot: PassSnapshot = {
    pass: asCount(raw.pass) ?? index + 1,
    subject: asText(raw.subject, 20_000) ?? '',
    stanceText: asText(raw.stanceText, 2000) ?? '',
    dimensions: Array.isArray(raw.dimensions)
      ? raw.dimensions.filter((item): item is string => typeof item === 'string')
      : [...allowed],
    intensity,
    defects,
    finishedAt: asCount(raw.finishedAt) ?? Date.now(),
  }
  const revisedSummary = asText(raw.revisedSummary, 2000)
  if (revisedSummary !== undefined) snapshot.revisedSummary = revisedSummary
  return snapshot
}

/* ------------------------------------------------------------------ *
 * 2. 归一化（schemaVersion 迁移的落点）
 * ------------------------------------------------------------------ */

/**
 * 把任意一份读出来的记录收敛成当前 schema 的**完整可用**记录。
 *
 * @param raw - 磁盘上读到的原始值（可能来自旧版本、可能被人手改坏）。
 * @param reviewId - 目录名（权威 id：即使文件里写的 id 不一致也以目录为准）。
 */
export function normalizeRecord(raw: unknown, reviewId: string): CrossfireRecord {
  const source = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const now = Date.now()

  // 目前只有版本 1，所以迁移是直通。**下一次改形状时**：在这里读
  // `source.schemaVersion`（缺失视为 1），按版本号逐级迁移，最后统一写成
  // CURRENT_SCHEMA_VERSION —— 与圆桌 review.json 的写法一致（那边已经真跑过
  // 一次 v1→v2，证明这个位置是对的，且"缺失视为 1"必须成立）。
  const schemaVersion = CURRENT_SCHEMA_VERSION

  const intensity: Intensity = source.intensity === 'quick' || source.intensity === 'deep' ? source.intensity : 'standard'
  const spec = INTENSITY_SPECS[intensity]

  // 维度先净化，因为缺陷的 dimension 要用它做 allowed。
  const dimensions: string[] = Array.isArray(source.dimensions)
    ? source.dimensions
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim().slice(0, 32))
      .filter((item, index, all) => all.indexOf(item) === index)
    : []
  const allowed = dimensions.length > 0 ? dimensions : [...DIMENSION_POOL]

  const defects: Defect[] = []
  if (Array.isArray(source.defects)) {
    for (const [index, item] of source.defects.entries()) {
      const defect = sanitizeDefect(item, index, allowed)
      if (defect !== undefined) defects.push(defect)
    }
  }

  const experts: RedTeamExpert[] = []
  if (Array.isArray(source.experts)) {
    for (const item of source.experts) {
      const expert = sanitizeExpert(item)
      if (expert !== undefined) experts.push(expert)
    }
  }

  const history: PassSnapshot[] = []
  if (Array.isArray(source.history)) {
    for (const [index, item] of source.history.entries()) {
      const snapshot = sanitizeSnapshot(item, index, allowed)
      if (snapshot !== undefined) history.push(snapshot)
    }
  }

  const status = source.status === 'attacking' || source.status === 'judging' || source.status === 'settled'
    ? source.status
    : 'draft'

  const reviewPass = Math.max(1, asCount(source.reviewPass) ?? 1)
  const maxReviewPass = Math.max(1, asCount(source.maxReviewPass) ?? spec.maxReviewPass)

  const record: CrossfireRecord = {
    schemaVersion,
    reviewId,
    status,
    subject: sanitizeSubject(source.subject),
    stance: sanitizeStance(source.stance, now),
    dimensions: allowed,
    intensity,
    experts,
    defects,
    reviewPass,
    maxReviewPass,
    history,
    budget: sanitizeBudget(source.budget, { maxRounds: 6, maxTokens: 150_000, usedRounds: 0, usedTokens: 0 }),
    startedAt: asCount(source.startedAt) ?? now,
    updatedAt: asCount(source.updatedAt) ?? now,
  }
  const sourceMeeting = asText(source.sourceMeeting, 128)
  if (sourceMeeting !== undefined) record.sourceMeeting = sourceMeeting
  const ownerSessionId = asText(source.ownerSessionId, 128)
  if (ownerSessionId !== undefined) record.ownerSessionId = ownerSessionId
  const settledAt = asCount(source.settledAt)
  if (settledAt !== undefined) record.settledAt = settledAt
  return record
}

/* ------------------------------------------------------------------ *
 * 3. 构造新记录
 * ------------------------------------------------------------------ */

/** `crossfire_open` 的输入。 */
export interface OpenReviewInput {
  reviewId: string
  title: string
  content: string
  source: Subject['source']
  sourceRef?: string
  /** 本次采用的维度（已由 dimensions.resolveDimensions 归一化）。 */
  dimensions: string[]
  intensity: Intensity
  /** 用户手写的立场与理由（可空）。 */
  stanceText?: string
  maxRounds: number
  maxTokens: number
  /** 从圆桌会议移交时记录来源会议 id（v0.1.0 只写不读）。 */
  sourceMeeting?: string
  /** 开启这场评审的会话 id（用于校验调用者，见 types.ts）。 */
  ownerSessionId?: string
  now?: number
}

/** 按输入构造一份全新的记录（status 恒为 `draft`）。 */
export function newRecord(input: OpenReviewInput): CrossfireRecord {
  const now = input.now ?? Date.now()
  const spec = INTENSITY_SPECS[input.intensity]
  const stanceText = (input.stanceText ?? '').trim().slice(0, 2000)
  const subject: Subject = {
    title: input.title.trim().slice(0, 200) || '未命名评审',
    content: input.content.trim().slice(0, 20_000),
    source: input.source,
  }
  if (input.sourceRef !== undefined && input.sourceRef !== '') subject.sourceRef = input.sourceRef
  const record: CrossfireRecord = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    reviewId: input.reviewId,
    status: 'draft',
    subject,
    stance: {
      text: stanceText,
      origin: 'manual',
      updatedAt: now,
    },
    dimensions: input.dimensions.length > 0 ? [...input.dimensions] : [...DIMENSION_POOL],
    intensity: input.intensity,
    experts: [],
    defects: [],
    reviewPass: 1,
    maxReviewPass: spec.maxReviewPass,
    history: [],
    budget: {
      maxRounds: input.maxRounds,
      maxTokens: input.maxTokens,
      usedRounds: 0,
      usedTokens: 0,
    },
    startedAt: now,
    updatedAt: now,
  }
  if (input.sourceMeeting !== undefined && input.sourceMeeting !== '') record.sourceMeeting = input.sourceMeeting
  if (input.ownerSessionId !== undefined && input.ownerSessionId !== '') record.ownerSessionId = input.ownerSessionId
  return record
}

/* ------------------------------------------------------------------ *
 * 4. 读写
 * ------------------------------------------------------------------ */

/** 读一场评审；缺失或损坏都返回 undefined。 */
export async function readRecord(stateRoot: string, reviewId: string): Promise<CrossfireRecord | undefined> {
  const raw = await readJsonFile<unknown>(reviewFile(stateRoot, reviewId))
  if (raw === undefined) return undefined
  return normalizeRecord(raw, reviewId)
}

/** 写一场评审（自动刷新 updatedAt）。 */
export async function writeRecord(stateRoot: string, record: CrossfireRecord): Promise<void> {
  record.updatedAt = Date.now()
  await writeJsonAtomic(reviewFile(stateRoot, record.reviewId), record)
}

/** 读发言记录（坏行计数一并返回，不许静默吞掉）。 */
export async function readTranscriptReport(
  stateRoot: string,
  reviewId: string,
): Promise<{ items: ExpertUtterance[]; malformed: number }> {
  const report = await readJsonLines<ExpertUtterance>(transcriptFile(stateRoot, reviewId))
  const items = report.items.filter((item) =>
    item !== null && typeof item === 'object' && typeof item.content === 'string' && item.content.trim() !== '')
  return { items, malformed: report.malformed }
}

/** 读发言记录。 */
export async function readTranscript(stateRoot: string, reviewId: string): Promise<ExpertUtterance[]> {
  return (await readTranscriptReport(stateRoot, reviewId)).items
}

/** 追加一条专家发言。 */
export async function appendTranscript(
  stateRoot: string,
  reviewId: string,
  utterance: ExpertUtterance,
): Promise<void> {
  await appendJsonLine(transcriptFile(stateRoot, reviewId), utterance)
}

/**
 * 在锁内读-改-写一场评审。
 *
 * @returns 变更函数的返回值；记录不存在时返回 undefined。
 */
export async function mutateRecord<T>(
  stateRoot: string,
  reviewId: string,
  mutate: (record: CrossfireRecord) => T | undefined,
): Promise<T | undefined> {
  return await withCrossfireLock(reviewLockKey(stateRoot, reviewId), async () => {
    const record = await readRecord(stateRoot, reviewId)
    if (record === undefined) return undefined
    const result = mutate(record)
    await writeRecord(stateRoot, record)
    return result
  })
}

/* ------------------------------------------------------------------ *
 * 5. 缺陷状态与派生查询
 * ------------------------------------------------------------------ */

/**
 * 设置一条缺陷的三态（可互切）。
 *
 * 驳回必须给理由 —— 这条约束同时是"用户在想什么"这一信息的唯一来源，
 * 因此它在数据层就被强制，而不是只靠界面拦。
 *
 * @returns true = 确有变更；false = 记录/缺陷不存在，或状态本来就相同。
 */
export async function setDefectStatus(
  stateRoot: string,
  reviewId: string,
  defectId: string,
  status: DefectStatus,
  rejectReason?: string,
): Promise<boolean> {
  const reason = (rejectReason ?? '').trim()
  if (status === 'rejected' && reason === '') {
    throw new Error('rejecting a defect requires a non-empty reason')
  }
  const changed = await mutateRecord(stateRoot, reviewId, (record) => {
    const defect = record.defects.find((candidate) => candidate.id === defectId)
    if (defect === undefined) return false
    if (defect.status === status && (status !== 'rejected' || defect.rejectReason === reason)) return false
    defect.status = status
    // 驳回理由在改回其它状态时**不清除**：它供追溯，清掉就再也说不出"当时为什么否"。
    if (status === 'rejected') defect.rejectReason = reason.slice(0, 500)
    return true
  })
  return changed === true
}

/** 设置一条核对项的复审核对结论。 */
export async function setRecheckVerdict(
  stateRoot: string,
  reviewId: string,
  defectId: string,
  verdict: RecheckVerdict,
  note?: string,
): Promise<boolean> {
  const changed = await mutateRecord(stateRoot, reviewId, (record) => {
    const defect = record.defects.find((candidate) => candidate.id === defectId)
    if (defect === undefined) return false
    // 核对的是"上一轮"的结论，所以 pass 记上一轮。
    const pass = Math.max(1, record.reviewPass - 1)
    const trimmed = (note ?? '').trim()
    defect.recheck = trimmed === ''
      ? { pass, verdict }
      : { pass, verdict, note: trimmed.slice(0, 500) }
    return true
  })
  return changed === true
}

/** 三态计数（卡片顶部影响条的数据源）。 */
export interface DefectCounts {
  total: number
  pending: number
  endorsed: number
  rejected: number
  /** 打穿用户立场的条数。 */
  strikes: number
}

/** 统计三态。 */
export function countDefects(record: CrossfireRecord): DefectCounts {
  let pending = 0
  let endorsed = 0
  let rejected = 0
  let strikes = 0
  for (const defect of record.defects) {
    if (defect.status === 'endorsed') endorsed += 1
    else if (defect.status === 'rejected') rejected += 1
    else pending += 1
    if (defect.strikesStance === true) strikes += 1
  }
  return { total: record.defects.length, pending, endorsed, rejected, strikes }
}

/** 已认定缺陷清单（定稿时固化的 known-flaws）。 */
export function knownFlaws(record: CrossfireRecord): Defect[] {
  return record.defects.filter((defect) => defect.status === 'endorsed')
}

/* ------------------------------------------------------------------ *
 * 6. 历史去重与复审递进（D8：只做去重与递进，绝不做用户画像）
 * ------------------------------------------------------------------ */

/** 归一化用于比较的文本：去空白与标点、统一小写。 */
function compareKey(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？"'“”‘’（）()\[\]【】《》<>—\-·…,.!?;:]/g, '')
    .toLowerCase()
}

/**
 * 两条缺陷是否应视为"同一条"。
 *
 * 两档判据（刻意不同，因为代价不对称）：
 * - **完全相同**（规范化后）→ 同一条，**哪怕它很短**。"缺日志"就是"缺日志"，
 *   用户驳回过它，就不该第二次弹出来。
 * - **部分包含** → 只有较短一方 ≥ 8 个字符时才敢判。否则"缺日志"会把
 *   "缺日志且没有轮转机制" 这类同族但不同的缺陷一起吞掉 —— 漏报一条真缺陷，
 *   比多弹一条重复项严重得多。
 */
export function isSameDefect(a: string, b: string): boolean {
  const x = compareKey(a)
  const y = compareKey(b)
  if (x === '' || y === '') return false
  if (x === y) return true
  const shorter = x.length <= y.length ? x : y
  const longer = x.length <= y.length ? y : x
  if (shorter.length < 8) return false
  return longer.includes(shorter)
}

/** 历史上被用户**驳回**过的全部缺陷内容（用于"不再重复弹同一观点"）。 */
export function rejectedContents(record: CrossfireRecord): string[] {
  const out: string[] = []
  for (const snapshot of record.history) {
    for (const defect of snapshot.defects) {
      if (defect.status === 'rejected') out.push(defect.content)
    }
  }
  for (const defect of record.defects) {
    if (defect.status === 'rejected') out.push(defect.content)
  }
  return out
}

/** 上一轮（history 的最后一轮）中已被用户**认定**的缺陷。 */
export function lastEndorsedDefects(record: CrossfireRecord): Defect[] {
  const previous = record.history[record.history.length - 1]
  if (previous === undefined) return []
  return previous.defects.filter((defect) => defect.status === 'endorsed')
}

/**
 * 复审开轮：把上一轮已认定的缺陷变成本轮的"修复核对项"。
 *
 * 语义（R7）：复审**只核对旧账**，不许开新战线。所以本轮的缺陷集合不是清的，
 * 而是被这些核对项替换。
 *
 * **刻意不预置 `verdict`**：开轮时机器不替人下结论。此前这里写死
 * `verdict: 'unfixed'`（"未被证明修复之前都算没修"），结果是复审轮一打开，
 * 三态按钮里"未修复"就已经是高亮选中态，而备注框旁的保存按钮会把这个机器默认值
 * 当作人的表态落库（红队评审抓出的真实缺陷）。现在缺席即"尚未判断"，由人来选。
 */
export function buildRecheckItems(record: CrossfireRecord): Defect[] {
  const previousPass = Math.max(1, record.reviewPass - 1)
  return lastEndorsedDefects(record).map((defect) => ({
    id: defect.id,
    utteranceId: defect.utteranceId,
    expertKey: defect.expertKey,
    content: defect.content,
    dimension: defect.dimension,
    ...(defect.dimensionFallback === true ? { dimensionFallback: true } : {}),
    ...(defect.quote === undefined ? {} : { quote: defect.quote }),
    ...(defect.evidence === undefined ? {} : { evidence: defect.evidence }),
    status: 'endorsed' as DefectStatus,
    ts: Date.now(),
    seq: defect.seq,
    recheck: { pass: previousPass },
  }))
}

/**
 * 过滤掉"上一轮已被驳回"的候选缺陷。
 *
 * 这是 D8 允许的唯一历史用法：提升信噪比。**绝不**把用户偏好告诉红队 ——
 * 模型一旦知道用户历史上总驳回某类观点，就会干脆不提那类问题，系统性削弱
 * 对抗强度，与这个插件存在的理由正好相反。
 */
export function dropRejectedDuplicates(candidates: Defect[], pastRejected: readonly string[]): {
  kept: Defect[]
  dropped: number
} {
  if (pastRejected.length === 0) return { kept: candidates, dropped: 0 }
  const kept: Defect[] = []
  let dropped = 0
  for (const candidate of candidates) {
    if (pastRejected.some((rejected) => isSameDefect(candidate.content, rejected))) {
      dropped += 1
      continue
    }
    kept.push(candidate)
  }
  return { kept, dropped }
}
