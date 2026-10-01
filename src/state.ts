/**
 * Crossfire durable state：`<workspace>/<stateDir>/crossfire/<reviewId>/` 下的
 * 原子文件持久化 + 进程内串行锁。
 *
 * 目录布局（与圆桌会议的**关键差异**：多一层 `crossfire/` 命名空间，因为本
 * 插件不依附任何一场会议，可以完全不开会直接审）：
 *
 *   <stateRoot>/crossfire/<reviewId>/review.json       — 评审记录（主文档）
 *   <stateRoot>/crossfire/<reviewId>/transcript.jsonl   — 红队发言（append-only）
 *   <stateRoot>/crossfire/<reviewId>/user-actions.jsonl — 用户行为队列
 *   <stateRoot>/crossfire/<reviewId>/export.md          — 导出物
 *
 * 三条铁律（沿用圆桌已验证的契约）：
 * 1. **读失败绝不抛给调用方**：坏 JSON / 缺文件一律返回 undefined 或空集，
 *    由调用方决定降级方式。状态损坏不能让整张卡片从界面上消失。
 * 2. **写必须原子**：优先宿主 `@deepseek-ai/dsh-atomic-write`（带 Windows
 *    瞬时 EACCES/EBUSY 重试），否则本地同目录 tmp + rename 兜底。
 * 3. **坏行必须被计数**：`user-actions.jsonl` 的半行 JSON 若被静默跳过，
 *    那条用户操作就永久丢失且无人知道（圆桌 A2 的真实教训）。
 *
 * @module dsh-plugin-crossfire/state
 */

import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/** 本插件在状态根下的固定命名空间目录名。 */
export const CROSSFIRE_NAMESPACE = 'crossfire'

/** Stable directory id from a display name (keeps CJK, lowercases latin). */
export function sanitizeKey(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'review' : cleaned
}

/** Process-local mutex chain keyed by an arbitrary lock key. */
const locks = new Map<string, Promise<unknown>>()

/**
 * Serialize async operations sharing one key inside this process.
 *
 * 注意（已知限制，写在任务书里）：这是**进程内**锁，跨进程不互斥。多窗口同时
 * 操作同一场评审时，后写者覆盖前者，只靠原子写保证文件不会写坏。v0.1.0 接受。
 */
export async function withCrossfireLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  locks.set(key, current.then(() => undefined, () => undefined))
  return current
}

/** 锁 key：同一场评审的操作互相串行。 */
export function reviewLockKey(stateRoot: string, reviewId: string): string {
  return `crossfire:${stateRoot}:${reviewId}`
}

/** Absolute state root under a workspace. */
export function stateRootOf(workspace: string, stateDir: string): string {
  return join(workspace, stateDir)
}

/** `<stateRoot>/crossfire` —— 本插件的命名空间目录。 */
export function crossfireRootOf(stateRoot: string): string {
  return join(stateRoot, CROSSFIRE_NAMESPACE)
}

/** Absolute directory of one review. */
export function reviewDirOf(stateRoot: string, reviewId: string): string {
  return join(crossfireRootOf(stateRoot), reviewId)
}

/** 生成一个可读、可排序、无碰撞的评审 id：`x-<yyyyMMdd-HHmmss>-<4位>`。 */
export function newReviewId(now: number = Date.now(), random: string = randomUUID()): string {
  const d = new Date(now)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const suffix = random.replace(/[^a-z0-9]/gi, '').slice(0, 4).toLowerCase() || 'r000'
  return `x-${stamp}-${suffix}`
}

/** Cached host atomic writer: `null` = not resolved yet, `undefined` = unavailable. */
let hostAtomicWriter: ((file: string, text: string) => Promise<void>) | undefined | null = null

/**
 * Resolve the host's atomic writer **without making it a load gate**.
 *
 * 静态 import 会让缺少 `@deepseek-ai/dsh-atomic-write` 的组合直接加载失败 ——
 * 那正是"可选能力变成硬门禁"的经典事故（圆桌 v0.2.36 修过一次）。所以这里
 * 懒解析一次，取不到就退到下面的本地实现。
 */
async function resolveHostWriter(): Promise<((file: string, text: string) => Promise<void>) | undefined> {
  if (hostAtomicWriter !== null) return hostAtomicWriter
  try {
    const host = await import('@deepseek-ai/dsh-atomic-write') as {
      writeFileAtomic?: (file: string, content: string, options: { mode: number }) => Promise<void>
    }
    const write = host.writeFileAtomic
    hostAtomicWriter = typeof write === 'function'
      ? (file: string, text: string) => write(file, text, { mode: 0o644 })
      : undefined
  } catch {
    hostAtomicWriter = undefined
  }
  return hostAtomicWriter
}

/** Atomically publish a UTF-8 text file. */
export async function writeTextAtomic(file: string, text: string): Promise<void> {
  const hostWrite = await resolveHostWriter()
  if (hostWrite !== undefined) {
    await hostWrite(file, text)
    return
  }
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${randomUUID()}.tmp`)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/** Atomically publish a JSON file (same-directory tmp + rename). */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, JSON.stringify(value, null, 2))
}

/** 确保目录存在（幂等）。 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/**
 * 读一个 JSON 文件；**不存在或损坏都返回 undefined**（铁律 1）。
 *
 * 调用方拿到 undefined 时应当降级，而不是把异常抛给用户界面。
 */
export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** 追加一条 JSONL 记录（自动建目录）。 */
export async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(value)}\n`, 'utf8')
}

/** 读取 JSONL 的结果：合法条目 + **被丢弃的坏行数**（铁律 3）。 */
export interface JsonLinesReport<T> {
  items: T[]
  /** 无法解析的行数。非 0 时调用方必须如实告知用户，不许静默吞掉。 */
  malformed: number
}

/**
 * 读 JSONL；坏行被跳过但**计数**。
 *
 * 容忍被截断的尾行（进程在写一半时崩溃留下的半行 JSON），但它同样计入
 * `malformed` —— 因为那条记录确实丢了。
 */
export async function readJsonLines<T>(file: string): Promise<JsonLinesReport<T>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { items: [], malformed: 0 }
  }
  const items: T[] = []
  let malformed = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      items.push(JSON.parse(trimmed) as T)
    } catch {
      malformed += 1
    }
  }
  return { items, malformed }
}

/** 列出状态根下的全部评审 id（按名字排序，名字本身按时间可排）。 */
export async function listReviewIds(stateRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(crossfireRootOf(stateRoot), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('x-'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 删除一场评审的全部落盘记录（幂等；目录不存在不算错误）。 */
export async function removeReviewDir(stateRoot: string, reviewId: string): Promise<void> {
  await rm(reviewDirOf(stateRoot, reviewId), { recursive: true, force: true })
}
