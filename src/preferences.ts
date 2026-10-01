/**
 * 运行时偏好的持久化与净化（自持久化，不依赖宿主 settings 命名空间）。
 *
 * ## 为什么自持久化
 *
 * 宿主 0.2.0-rc.2 把 `settings` 服务重构成 `SettingsForms`：它只把 **profile
 * 配置投影成表单**，插件不再有"注册自己的命名空间"这个动作（`SettingsScope`
 * 类型已消失）。而写 Cordis `Config` 会触发 Loader 重载该 entry —— 对"改一个
 * 默认强度就重启插件"来说太重。
 *
 * 因此偏好落在 DSH home 下的 `crossfire/preferences.json`，读写都在插件内部
 * 完成。**命名空间与圆桌会议的 `roundtable/preferences.json` 完全分开**：两个
 * 插件共享一个偏好文件会让任意一方改字段就踩到另一方。
 *
 * ## 三条铁律（与 state.ts 同源）
 *
 * 1. **读失败绝不抛给调用方**：偏好文件损坏或被人手改成非法 JSON，一律退回
 *    默认值并留一条日志。偏好是观察性配置，它不能让整个设置页消失。
 * 2. **写入必须原子**：复用 {@link writeTextAtomic}。
 * 3. **非法字段一律净化**：schemastery 不校验数组条目的 required 字段（圆桌
 *    实测过 `z.object` 对缺 required 在 resolve 阶段不报错），条目级校验只能
 *    手写 —— 这条在设置页写入侧尤其重要。
 *
 * @module dsh-plugin-crossfire/preferences
 */

import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DIMENSION_POOL, type Intensity, type RolePreset, type RoleSquad, type RoleSquadMember } from './types.ts'
import { writeTextAtomic } from './state.ts'

/* ------------------------------------------------------------------ *
 * 0. 偏好文件位置
 * ------------------------------------------------------------------ */

/**
 * 解析 DeepSeek Harness home。
 *
 * 与宿主 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 优先级对齐：
 * `configured` > `$DSH_HOME` > `~/.dsh`。第一级做不到（它是宿主进程内部传入的
 * 显式覆盖，插件拿不到），但环境变量与默认值这两级完全一致。
 *
 * 刻意**不**静态 import `@deepseek-ai/dsh-home-paths`：那会把它变成加载门禁，
 * 而本模块只是要一个路径。
 */
export function dshHomeDir(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 偏好文件的绝对路径（DSH home 下的 `crossfire/preferences.json`）。 */
export function preferencesFilePath(): string {
  return join(dshHomeDir(), 'crossfire', 'preferences.json')
}

/* ------------------------------------------------------------------ *
 * 1. 偏好形状
 * ------------------------------------------------------------------ */

/** 偏好的 wire 形状。 */
export interface CrossfirePreferences {
  /** 新建评审的默认强度档。 */
  readonly defaultIntensity: Intensity
  /** 默认轮数上限。 */
  readonly maxRounds: number
  /** 默认 token 预算。 */
  readonly maxTokens: number
  /** 专家每轮输出 token 上限（模型请求 max_tokens），0 = 不限制。 */
  readonly expertMaxTokens: number
  /** 专家每轮最多提几条缺陷，0 = 不限制。 */
  readonly expertMaxOpinions: number
  /** 用户自建维度（固定池之外）。 */
  readonly customDimensions: string[]
  /** 用户自建角色预设（全局；**不预置任何内置角色**）。 */
  readonly rolePresets: RolePreset[]
  /** 用户自建阵容预设（一次套用多位专家；同样不预置）。 */
  readonly squads: RoleSquad[]
  /**
   * 被用户关掉的解释性说明（键 → true）。
   *
   * 用户原话："一些解释性质的东西可以做一些删除按钮，就比如说在这个对话之前是一次
   * 当用户删了之后就不会再显示，从而减少视觉上的负担"。所以它是**持久的**：刷新
   * 页面、换会话都不该让它回来。恢复入口在设置页（那里列出已隐藏的说明）。
   */
  readonly dismissedHints: Record<string, boolean>
}

/** 没有任何持久化数据时的偏好。`defaultIntensity` 由调用方按插件 Config 覆盖。 */
export function defaultPreferences(defaultIntensity: Intensity): CrossfirePreferences {
  return {
    defaultIntensity,
    maxRounds: 6,
    maxTokens: 150_000,
    expertMaxTokens: 0,
    expertMaxOpinions: 3,
    customDimensions: [],
    rolePresets: [],
    squads: [],
    dismissedHints: {},
  }
}

/* ------------------------------------------------------------------ *
 * 2. 字段级净化（schemastery 不替我们拦条目级错误）
 * ------------------------------------------------------------------ */

/** 自定义维度的硬上限（客户端与服务端共用；服务端截断，客户端提前拦截）。 */
export const CUSTOM_DIMENSION_MAX = 12

/** 单条维度名的最大长度。 */
export const DIMENSION_NAME_MAX = 12

/**
 * 把任意输入收敛成合法的自定义维度清单。
 *
 * 三条规则：空/超长丢弃；与固定池重名的丢弃（池内的不算"自定义"，否则界面上
 * 会出现两个"安全"）；去重且截断到上限。
 */
export function sanitizeCustomDimensions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const pool: readonly string[] = DIMENSION_POOL
  const out: string[] = []
  for (const item of value) {
    const raw = typeof item === 'string' ? item.trim() : ''
    if (raw === '' || raw.length > DIMENSION_NAME_MAX) continue
    if (pool.includes(raw) || out.includes(raw)) continue
    out.push(raw)
    if (out.length >= CUSTOM_DIMENSION_MAX) break
  }
  return out
}

/** 角色预设条目的硬上限。 */
export const ROLE_PRESET_MAX = 50
/** 阵容条目的硬上限。 */
export const SQUAD_MAX = 20
/** 单个阵容的成员上限。 */
export const SQUAD_MEMBER_MAX = 8

/** 名称/角色说明的最大长度。 */
const TEXT_MAX = 120

/** 把任意输入收敛成合法的角色预设清单（缺 name/role 的条目直接丢弃）。 */
export function sanitizeRolePresets(value: unknown): RolePreset[] {
  if (!Array.isArray(value)) return []
  const out: RolePreset[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const entry = (item !== null && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, TEXT_MAX) : ''
    const role = typeof entry.role === 'string' ? entry.role.trim().slice(0, TEXT_MAX) : ''
    if (id === '' || name === '' || role === '' || seen.has(id)) continue
    seen.add(id)
    const preset: RolePreset = { id, name, role }
    if (typeof entry.provider === 'string' && entry.provider.trim() !== '') preset.provider = entry.provider.trim()
    if (typeof entry.model === 'string' && entry.model.trim() !== '') preset.model = entry.model.trim()
    out.push(preset)
    if (out.length >= ROLE_PRESET_MAX) break
  }
  return out
}

/** 阵容成员 key 的合法化（小写、去空白；空则丢弃）。 */
function sanitizeMemberKey(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return /^[a-z0-9][a-z0-9_-]*$/.test(raw) ? raw.slice(0, 32) : ''
}

/** 把任意输入收敛成合法的阵容清单。 */
export function sanitizeSquads(value: unknown): RoleSquad[] {
  if (!Array.isArray(value)) return []
  const out: RoleSquad[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const entry = (item !== null && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, TEXT_MAX) : ''
    if (id === '' || name === '' || seen.has(id)) continue
    const rawMembers = Array.isArray(entry.members) ? entry.members : []
    const members: RoleSquadMember[] = []
    const memberKeys = new Set<string>()
    for (const rawMember of rawMembers) {
      const member = (rawMember !== null && typeof rawMember === 'object' ? rawMember : {}) as Record<string, unknown>
      const key = sanitizeMemberKey(member.key)
      if (key === '' || memberKeys.has(key)) continue
      memberKeys.add(key)
      const role = typeof member.role === 'string' ? member.role.trim().slice(0, TEXT_MAX) : ''
      const sanitized: RoleSquadMember = { key, role }
      if (typeof member.provider === 'string' && member.provider.trim() !== '') sanitized.provider = member.provider.trim()
      if (typeof member.model === 'string' && member.model.trim() !== '') sanitized.model = member.model.trim()
      members.push(sanitized)
      if (members.length >= SQUAD_MEMBER_MAX) break
    }
    if (members.length === 0) continue
    seen.add(id)
    out.push({ id, name, members })
    if (out.length >= SQUAD_MAX) break
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 3. 整份偏好的归一化
 * ------------------------------------------------------------------ */

/**
 * 四个数字字段共用的净化规则：**0 = 不限制**，只接受非负整数，并夹到上限
 * 避免误填一个天文数字。
 *
 * 为什么四个字段必须同规则：设置页对这四个字段都写着「0 = 不限制」。如果
 * `maxTokens` 单独要求 ≥1000，用户填 0 就会被静默拒绝并退回旧值 —— 界面显示
 * 一个数、实际生效另一个数，是最难被用户理解的一类失败。
 */
function clampLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const n = Math.floor(value)
  if (n < 0) return undefined
  return Math.min(n, 500_000)
}

/**
 * 把任意一层输入叠加到基准偏好上。
 *
 * 与 {@link defaultPreferences} 的分工：`base` 是"当前生效值"，`layer` 是"这次
 * 提交的部分更新"。缺字段一律沿用 base，非法字段一律退回 base（而不是默认值）
 * —— 这样一次错误的提交不会把用户的其它设置顺手清掉。
 */
export function normalizePreferences(layer: unknown, base: CrossfirePreferences): CrossfirePreferences {
  const raw = (layer !== null && typeof layer === 'object' ? layer : {}) as Record<string, unknown>
  const pick = <T>(key: keyof CrossfirePreferences, fallback: T, accept: (value: unknown) => T | undefined): T => {
    if (!(key in raw)) return fallback
    const accepted = accept(raw[key])
    return accepted === undefined ? fallback : accepted
  }
  const asIntensity = (value: unknown): Intensity | undefined =>
    value === 'quick' || value === 'standard' || value === 'deep' ? value : undefined

  return {
    defaultIntensity: pick('defaultIntensity', base.defaultIntensity, asIntensity),
    maxRounds: pick('maxRounds', base.maxRounds, clampLimit),
    maxTokens: pick('maxTokens', base.maxTokens, clampLimit),
    expertMaxTokens: pick('expertMaxTokens', base.expertMaxTokens, clampLimit),
    expertMaxOpinions: pick('expertMaxOpinions', base.expertMaxOpinions, clampLimit),
    customDimensions: pick('customDimensions', base.customDimensions, sanitizeCustomDimensions),
    rolePresets: pick('rolePresets', base.rolePresets, sanitizeRolePresets),
    squads: pick('squads', base.squads, sanitizeSquads),
    dismissedHints: pick('dismissedHints', base.dismissedHints, sanitizeDismissedHints),
  }
}

/** 已关闭说明的键长度上限（键是代码里的常量，不是用户输入）。 */
const DISMISSED_HINT_KEY_MAX = 64
/** 已关闭说明的条数上限 —— 防止有人用 prefs.patch 往里塞无上限的垃圾。 */
const DISMISSED_HINT_MAX = 100

/**
 * 把任意输入收敛成"已关闭说明"的键集。
 *
 * 规则：键必须是非空短字符串、值必须是 `true`（只记"关掉了"这一事实，不存别的东西）、
 * 去重并截断。存 `true` 而不是存时间戳，是因为界面只需要回答"要不要显示这一段"。
 */
export function sanitizeDismissedHints(value: unknown): Record<string, boolean> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, boolean> = {}
  let count = 0
  for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
    if (flag !== true) continue
    const trimmed = key.trim()
    if (trimmed === '' || trimmed.length > DISMISSED_HINT_KEY_MAX) continue
    if (out[trimmed] === true) continue
    out[trimmed] = true
    count += 1
    if (count >= DISMISSED_HINT_MAX) break
  }
  return out
}

/** 本次可用的完整维度清单：固定池在前，自定义在后。 */
export function effectiveDimensions(prefs: CrossfirePreferences): string[] {
  return [...DIMENSION_POOL, ...prefs.customDimensions]
}

/* ------------------------------------------------------------------ *
 * 4. 偏好存储
 * ------------------------------------------------------------------ */

/** 偏好读取面：`get()` 永远返回一个完整、合法的对象。 */
export interface PreferenceStore {
  /** 当前生效的偏好（同步读，永远完整）。 */
  get(): CrossfirePreferences
  /** 叠加一次部分更新，落盘后返回新值；写失败只记日志，不抛给调用方。 */
  update(patch: unknown): Promise<CrossfirePreferences>
  /** 订阅变更（返回退订函数）；回调抛错不影响其它订阅者。 */
  watch(listener: (value: CrossfirePreferences) => void): () => void
  /** 等待首次读盘完成（测试与诊断用）。 */
  ready(): Promise<void>
}

/** 建一个偏好存储所需的最小依赖。 */
export interface PreferenceStoreOptions {
  /** 基准偏好（通常来自插件 Config 的 `defaultIntensity` 与内置默认值）。 */
  base: CrossfirePreferences
  /** 覆盖偏好文件路径（测试用）。 */
  file?: string
  /** 诊断日志；缺省静默 —— 偏好问题不该刷屏。 */
  log?: (message: string, error?: unknown) => void
}

/**
 * 创建偏好存储。
 *
 * 读盘是**惰性且异步**的（构造后立刻开始），因此 `get()` 在首次读盘完成前返回
 * 基准值而不是阻塞宿主启动 —— 这也是它比 `ctx.inject(['settings'])` 更稳的地方：
 * 没有可选能力可缺。
 */
export function createPreferenceStore(options: PreferenceStoreOptions): PreferenceStore {
  const file = options.file ?? preferencesFilePath()
  let current = options.base
  let writeQueue: Promise<void> = Promise.resolve()
  const listeners = new Set<(value: CrossfirePreferences) => void>()

  const load = (async (): Promise<void> => {
    try {
      const text = await readFile(file, 'utf8')
      current = normalizePreferences(JSON.parse(text), options.base)
    } catch (error: unknown) {
      // 文件不存在是正常首次启动；其余情况（坏 JSON、权限）留痕但继续。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.log?.(`crossfire: preferences at ${file} unreadable; using defaults`, error)
      }
    }
  })()

  const publish = (next: CrossfirePreferences): void => {
    current = next
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (error: unknown) {
        options.log?.('crossfire: a preference listener threw', error)
      }
    }
  }

  return {
    get: () => current,
    ready: () => load.then(() => undefined),
    watch(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async update(patch) {
      await load
      const next = normalizePreferences(patch, current)
      publish(next)
      // 串行化落盘：并发的设置页提交不会互相截断，最后一次写入胜出。
      writeQueue = writeQueue.then(async () => {
        try {
          await mkdir(dirname(file), { recursive: true })
          await writeTextAtomic(file, JSON.stringify(next, null, 2))
        } catch (error: unknown) {
          options.log?.(`crossfire: failed to persist preferences to ${file}`, error)
        }
      })
      await writeQueue
      return next
    },
  }
}
