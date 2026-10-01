/**
 * 针锋的设置页（`settings.section`，id `crossfire`）。
 *
 * ## 覆盖范围
 *
 * 五块：默认强度、维度池（固定池展示 + 自定义增删）、预算、**角色预设**、
 * **阵容预设**，末尾是四条边界说明与 locale 侧的批次批注。
 *
 * 角色预设与阵容预设是**纯本地偏好**（`crossfire/preferences.json`）：它们只
 * 回答"谁来"（key / 角色说明 / 模型路由），不描述"怎么开"——没有维度、没有流程。
 *
 * ## 三条实现约定
 *
 * - **选项类改动立即落库**：点击/枚举类操作直接提交 `crossfire/prefs.set`，
 *   成功后用服务端返回的 prefs 覆盖本地快照。
 * - **数字输入走"本地草稿 + 失焦提交"**：避免每敲一个字符就写一次盘；四个数字
 *   字段都遵循 `0 = 不限制`。
 * - **渲染只读快照**：服务端返回的 prefs 是唯一真相，本地不做长驻乐观状态，
 *   否则一次失败的保存会让界面显示一个并不存在的值。唯一的例外是正在编辑的
 *   草稿（还没提交），以及"整条条目文本/路由原样就是旧值"时的本地重试。
 *
 * 长度与数量上限在 host `preferences.ts` 里重新净化一次，本页只是提前拦截并给出
 * 即时反馈。
 *
 * @module dsh-plugin-crossfire/client/SettingsView
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  Intensity,
  RpcCaller,
  WireProviderOption,
  WirePrefs,
  WirePrefsSnapshot,
  WireRolePreset,
  WireRoleSquad,
  WireRoleSquadMember,
} from './wire.ts'
import { mergePreset, mergeSquad } from './merge.ts'
import { providerBrand, routeAbbr, routeText } from './brand.ts'
import styles from './SettingsView.module.css'

/* ------------------------------------------------------------------ *
 * 与 host `preferences.ts` 对齐的常量（host 侧仍会再净化一次）
 * ------------------------------------------------------------------ */

/** 与 host `DIMENSION_NAME_MAX` 一致。 */
const DIMENSION_NAME_MAX = 12
/** 与 host `CUSTOM_DIMENSION_MAX` 一致。 */
const CUSTOM_DIMENSION_MAX = 12
/** 与 host `ROLE_PRESET_MAX` 一致。 */
const ROLE_PRESET_MAX = 50
/** 与 host `SQUAD_MAX` 一致。 */
const SQUAD_MAX = 20
/** 与 host `SQUAD_MEMBER_MAX` 一致。 */
const SQUAD_MEMBER_MAX = 8

/** slot entry 收到的注入面（见 client/index.ts）。 */
export interface CrossfireSettingsInjected {
  rpc: RpcCaller
  t: (key: string) => string
}

/** 页面级提示。 */
type Notice = 'loading' | 'saved' | 'saveFailed' | 'loadFailed'

/** 数字字段的本地草稿（输入过程中不回写服务端，失焦才提交）。 */
interface NumericDraft {
  maxRounds: string
  maxTokens: string
  expertMaxTokens: string
  expertMaxOpinions: string
}

/** 预设编辑器里的字符串草稿（provider / model 为空表示"不覆盖"，提交时剔除）。 */
interface PresetDraft {
  id: string
  name: string
  role: string
  provider: string
  model: string
}

/** 阵容编辑器里的成员草稿。 */
interface SquadMemberDraft {
  key: string
  role: string
  provider: string
  model: string
}

/** 阵容编辑器草稿（至少保留一行成员，删到空时会自动补一行）。 */
interface SquadDraft {
  id: string
  name: string
  members: SquadMemberDraft[]
}

const INTENSITY_ORDER: readonly Intensity[] = ['quick', 'standard', 'deep']

const INTENSITY_LABEL_KEY: Readonly<Record<Intensity, string>> = {
  quick: 'intensityQuick',
  standard: 'intensityStandard',
  deep: 'intensityDeep',
}

/** 模型路由后缀使用的符号（无需新增 locale 键）。 */
const ROUTE_SEPARATOR = ' · '
const ROUTE_JOINER = ' / '

const NUMERIC_FIELDS: readonly { key: keyof NumericDraft; labelKey: string }[] = [
  { key: 'maxRounds', labelKey: 'budgetRounds' },
  { key: 'maxTokens', labelKey: 'budgetTokens' },
  { key: 'expertMaxTokens', labelKey: 'expertMaxTokens' },
  { key: 'expertMaxOpinions', labelKey: 'expertMaxOpinions' },
]

function draftFrom(prefs: WirePrefs): NumericDraft {
  return {
    maxRounds: String(prefs.maxRounds),
    maxTokens: String(prefs.maxTokens),
    expertMaxTokens: String(prefs.expertMaxTokens),
    expertMaxOpinions: String(prefs.expertMaxOpinions),
  }
}

/** 成员 key 的合法化规则：与 host `sanitizeMemberKey` 逐字一致（小写 + 基本字符集）。 */
const MEMBER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

/** 新建条目用的 id：优先浏览器原生 `crypto.randomUUID()`，RPC 只认非空 id。 */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // 极老环境（无 randomUUID）才走到这里：退化成 32 位十六进制，仍然够唯一。
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  return `${String(Date.now())}-${String(Math.random()).slice(2)}`
}

/** 表单里的字符串 → 可选字段（修剪后为空即视为"不设置"）。 */
function optionalText(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 草稿 → 合法预设；缺 name/role 时返回 null（调用方给 presetInvalid）。 */
function presetFromDraft(draft: PresetDraft): WireRolePreset | null {
  const name = draft.name.trim()
  const role = draft.role.trim()
  if (name === '' || role === '') return null
  const provider = optionalText(draft.provider)
  const model = optionalText(draft.model)
  return {
    id: draft.id,
    name,
    role,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

/** 草稿 → 合法阵容；name 为空或 key 不合法/重复/成员为空时返回 null。 */
function squadFromDraft(draft: SquadDraft): WireRoleSquad | null {
  const name = draft.name.trim()
  if (name === '') return null
  const members: WireRoleSquadMember[] = []
  const seen = new Set<string>()
  for (const raw of draft.members) {
    const key = raw.key.trim().toLowerCase()
    if (!MEMBER_KEY_PATTERN.test(key) || seen.has(key)) return null
    seen.add(key)
    const provider = optionalText(raw.provider)
    const model = optionalText(raw.model)
    members.push({
      key,
      role: raw.role.trim(),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
    })
  }
  if (members.length === 0) return null
  return { id: draft.id, name, members }
}

function memberDraft(): SquadMemberDraft {
  return { key: '', role: '', provider: '', model: '' }
}

/** 空行阵容（新建入口用；空成员行不会被净化掉，也不会被提交）。 */
function newSquadDraft(): SquadDraft {
  return { id: newId(), name: '', members: [memberDraft()] }
}

/** 排序用：小写副本，避免 "Alpha" 与 "alpha" 各自成群。 */
function sortedByText<T>(items: readonly T[], text: (item: T) => string): T[] {
  return [...items].sort((left, right) => {
    const a = text(left).toLowerCase()
    const b = text(right).toLowerCase()
    if (a < b) return -1
    return a > b ? 1 : 0
  })
}

/** 角色说明在列表里的摘要长度。 */
const ROLE_PREVIEW_MAX = 48

function previewRole(role: string): string {
  const flat = role.replace(/\s+/g, ' ').trim()
  return flat.length <= ROLE_PREVIEW_MAX ? flat : `${flat.slice(0, ROLE_PREVIEW_MAX)}…`
}

/** 预设的模型路由后缀；没有 provider / model 时不显示。 */
function presetRoute(preset: WireRolePreset): string | null {
  if (preset.provider === undefined && preset.model === undefined) return null
  return ROUTE_SEPARATOR + [preset.provider, preset.model].filter((part) => part !== undefined).join(ROUTE_JOINER)
}

export function CrossfireSettings(props: CrossfireSettingsInjected): ReactElement {
  const { rpc, t } = props
  const [snapshot, setSnapshot] = useState<WirePrefsSnapshot | null>(null)
  const [draft, setDraft] = useState<NumericDraft | null>(null)
  const [notice, setNotice] = useState<Notice>('loading')
  const [newDimension, setNewDimension] = useState('')
  const [dimensionError, setDimensionError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  // 宿主的 provider / model 目录。设置页的模型字段是**下拉**而不是文本框 —— 手打
  // provider/model 串既容易写错，又根本不知道有哪些可选（实测反馈："模型选择那里
  // 出了问题，无法正常选择以及对应的框也无法去选择"）。
  //
  // 这个目录**依赖 host 侧的新端点**（`crossfire/models.list`），所以它有三种失败
  // 形态，每一种都必须说出来，否则界面表现完全相同：两个框里只剩「继承主持人」，
  // 用户只会看到"选不了"，而不知道是没装好、还是自己没选对。
  //   loading → 在读数；failed → 端点不存在（典型：host 未重启）；empty → 宿主没报 provider
  const [providers, setProviders] = useState<WireProviderOption[]>([])
  const [catalog, setCatalog] = useState<{ state: 'loading' | 'ready' | 'failed' | 'empty'; reason?: string }>({ state: 'loading' })

  // 角色预设：正在编辑的草稿（未提交）与最近一次操作的独立回执。
  const [presetEdit, setPresetEdit] = useState<PresetDraft | null>(null)
  const [presetError, setPresetError] = useState<'invalid' | 'limit' | null>(null)
  const [presetNotice, setPresetNotice] = useState<'saved' | 'failed' | null>(null)

  // 阵容预设：同上。
  const [squadEdit, setSquadEdit] = useState<SquadDraft | null>(null)
  const [squadError, setSquadError] = useState<'invalid' | 'limit' | null>(null)
  const [squadNotice, setSquadNotice] = useState<'saved' | 'failed' | null>(null)

  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void (async () => {
      const result = await rpc<WirePrefsSnapshot>('crossfire/prefs.get', {})
      if (!alive.current) return
      if (result.ok) {
        setSnapshot(result.value)
        setDraft(draftFrom(result.value.prefs))
        setNotice('saved')
      } else {
        setNotice('loadFailed')
      }
      // 模型目录单独取：它拿不到也不该让整页失败（退化为空下拉 + 提示），
      // 因为它依赖宿主的 llm 服务，而偏好本身不依赖。
      const catalog = await rpc<{ providers: WireProviderOption[] }>('crossfire/models.list', {})
      if (!alive.current) return
      if (catalog.ok && Array.isArray(catalog.value?.providers)) {
        setProviders(catalog.value.providers)
        setCatalog(catalog.value.providers.length === 0 ? { state: 'empty' } : { state: 'ready' })
      } else if (catalog.ok) {
        // 回包成功但形状不对：同样当作拿不到，别静默变成空下拉。
        setCatalog({ state: 'failed', reason: 'unexpected payload' })
      } else {
        setCatalog({ state: 'failed', reason: catalog.error.message })
      }
    })()
    return () => {
      alive.current = false
    }
  }, [rpc])

  /** 提交一次部分更新；成功后用服务端真相刷新本地快照。 */
  const save = async (patch: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    const result = await rpc<{ prefs: WirePrefs; dimensions: string[] }>('crossfire/prefs.set', { patch })
    if (!alive.current) return false
    setBusy(false)
    if (!result.ok) {
      setNotice('saveFailed')
      return false
    }
    setNotice('saved')
    setSnapshot((previous) => (previous === null ? previous : {
      ...previous,
      prefs: result.value.prefs,
      dimensions: result.value.dimensions,
    }))
    setDraft(draftFrom(result.value.prefs))
    return true
  }

  /** 数字字段失焦提交：非法值回滚为当前服务端值。 */
  const commitNumber = (key: keyof NumericDraft): void => {
    if (snapshot === null || draft === null) return
    const raw = draft[key].trim()
    const parsed = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      setNotice('saveFailed')
      setDraft(draftFrom(snapshot.prefs))
      return
    }
    if (parsed === snapshot.prefs[key]) return
    void save({ [key]: parsed })
  }

  const patchDraft = (key: keyof NumericDraft, value: string): void => {
    setDraft((previous) => (previous === null ? previous : { ...previous, [key]: value }))
  }

  const addDimension = (): void => {
    if (snapshot === null) return
    const candidate = newDimension.trim()
    const invalid = candidate === ''
      || candidate.length > DIMENSION_NAME_MAX
      || snapshot.pool.includes(candidate)
      || snapshot.prefs.customDimensions.includes(candidate)
    if (invalid) {
      setDimensionError(true)
      return
    }
    setDimensionError(false)
    setNewDimension('')
    void save({ customDimensions: [...snapshot.prefs.customDimensions, candidate] })
  }

  const removeDimension = (name: string): void => {
    if (snapshot === null) return
    void save({ customDimensions: snapshot.prefs.customDimensions.filter((item) => item !== name) })
  }

  /* ---------------- 角色预设 ---------------- */

  /** 打开编辑器（编辑已有条目时逐字段拷贝，绝不共享对象引用）。 */
  const beginEditPreset = (preset: WireRolePreset | null): void => {
    setPresetError(null)
    setPresetNotice(null)
    setPresetEdit(preset === null
      ? { id: newId(), name: '', role: '', provider: '', model: '' }
      : {
        id: preset.id,
        name: preset.name,
        role: preset.role,
        provider: preset.provider ?? '',
        model: preset.model ?? '',
      })
  }

  /** 从列表里拿"服务端当前值"：本地乐观写盘被 host 净化掉时用它回退。 */
  const storedPreset = (id: string): WireRolePreset | undefined =>
    snapshot?.prefs.rolePresets.find((item) => item.id === id)

  const savePreset = (): void => {
    if (snapshot === null || presetEdit === null) return
    const preset = presetFromDraft(presetEdit)
    if (preset === null) {
      setPresetError('invalid')
      return
    }
    if (storedPreset(preset.id) === undefined && snapshot.prefs.rolePresets.length >= ROLE_PRESET_MAX) {
      setPresetError('limit')
      return
    }
    setPresetError(null)
    setPresetNotice(null)
    setSaving(true)
    void (async () => {
      // 更新既有条目必须**就地替换**（见 `merge.ts` 的模块注释：append 会让同 id
      // 出现两份，host 去重保留旧值，界面报"已保存"但改动被静默回退）。
      const next = mergePreset(snapshot.prefs.rolePresets, preset)
      const ok = await save({ rolePresets: next })
      if (!alive.current) return
      setSaving(false)
      if (!ok) {
        setPresetNotice('failed')
        return
      }
      setPresetEdit(null)
      setPresetNotice('saved')
    })()
  }

  const deletePreset = (id: string): void => {
    if (snapshot === null) return
    setPresetError(null)
    setPresetNotice(null)
    if (presetEdit !== null && presetEdit.id === id) setPresetEdit(null)
    void save({ rolePresets: snapshot.prefs.rolePresets.filter((item) => item.id !== id) })
  }

  /* ---------------- 阵容预设 ---------------- */

  const beginEditSquad = (squad: WireRoleSquad | null): void => {
    setSquadError(null)
    setSquadNotice(null)
    setSquadEdit(squad === null ? newSquadDraft() : {
      id: squad.id,
      name: squad.name,
      members: squad.members.length === 0
        ? [memberDraft()]
        : squad.members.map((member) => ({
          key: member.key,
          role: member.role,
          provider: member.provider ?? '',
          model: member.model ?? '',
        })),
    })
  }

  const storedSquad = (id: string): WireRoleSquad | undefined =>
    snapshot?.prefs.squads.find((item) => item.id === id)

  const patchSquadDraft = (apply: (current: SquadDraft) => SquadDraft): void => {
    setSquadEdit((previous) => (previous === null ? previous : apply(previous)))
  }

  const patchSquadMember = (index: number, patch: Partial<SquadMemberDraft>): void => {
    patchSquadDraft((current) => ({
      ...current,
      members: current.members.map((member, position) => (position === index ? { ...member, ...patch } : member)),
    }))
  }

  const addSquadMember = (): void => {
    patchSquadDraft((current) => (
      current.members.length >= SQUAD_MEMBER_MAX
        ? current
        : { ...current, members: [...current.members, memberDraft()] }
    ))
  }

  const removeSquadMember = (index: number): void => {
    patchSquadDraft((current) => {
      const members = current.members.filter((_member, position) => position !== index)
      // 空成员行会被服务端净化掉，因此界面上至少留一行，否则"加一位成员"就没了入口。
      return { ...current, members: members.length === 0 ? [memberDraft()] : members }
    })
  }

  const saveSquad = (): void => {
    if (snapshot === null || squadEdit === null) return
    const squad = squadFromDraft(squadEdit)
    if (squad === null) {
      setSquadError('invalid')
      return
    }
    if (storedSquad(squad.id) === undefined && snapshot.prefs.squads.length >= SQUAD_MAX) {
      setSquadError('limit')
      return
    }
    setSquadError(null)
    setSquadNotice(null)
    setSaving(true)
    void (async () => {
      // 与 `savePreset` 同一处缺陷：更新既有阵容必须**就地替换**。此前"值相同才替换、
      // 否则追加"会让编辑过的阵容同 id 出现两次，host 去重保留旧值 —— 界面报"已保存"，
      // 改动却被静默回退（红队评审抓出的真实缺陷）。规则见 `merge.ts`。
      const next = mergeSquad(snapshot.prefs.squads, squad)
      const ok = await save({ squads: next })
      if (!alive.current) return
      setSaving(false)
      if (!ok) {
        setSquadNotice('failed')
        return
      }
      setSquadEdit(null)
      setSquadNotice('saved')
    })()
  }

  const deleteSquad = (id: string): void => {
    if (snapshot === null) return
    setSquadError(null)
    setSquadNotice(null)
    if (squadEdit !== null && squadEdit.id === id) setSquadEdit(null)
    void save({ squads: snapshot.prefs.squads.filter((item) => item.id !== id) })
  }

  /* ---------------- 渲染 ---------------- */

  if (snapshot === null) {
    return (
      <div className={styles.root}>
        <div className={notice === 'loadFailed' ? `${styles.notice} ${styles.noticeErr}` : `${styles.notice} ${styles.hint}`}>
          {t(notice === 'loadFailed' ? 'loadFailed' : 'loading')}
        </div>
      </div>
    )
  }

  const activeSpec = snapshot.intensities[snapshot.prefs.defaultIntensity]
  const atDimensionLimit = snapshot.prefs.customDimensions.length >= CUSTOM_DIMENSION_MAX
  const presets = sortedByText(snapshot.prefs.rolePresets, (preset) => preset.name)
  const squads = sortedByText(snapshot.prefs.squads, (squad) => squad.name)
  const atPresetLimit = snapshot.prefs.rolePresets.length >= ROLE_PRESET_MAX
  const atSquadLimit = snapshot.prefs.squads.length >= SQUAD_MAX
  // 当前强度档的生效规则由 host 给出（`intensities`），这里只读展示。
  const crossText = activeSpec !== undefined && activeSpec.crossExamination
    ? t('intensityCrossYes')
    : t('intensityCrossNo')
  const perDimensionText = t('intensityPerDimension')
    .replace('{n}', String(activeSpec === undefined ? 0 : activeSpec.expertsPerDimension))
  const recheckCapText = activeSpec === undefined
    ? ''
    : t('intensityRecheckCap').replace('{n}', String(activeSpec.maxReviewPass))
  const anySaving = busy || saving
  // 被用户关掉的解释性说明条数。卡片上每关掉一段就 +1；这里给一个统一的恢复入口，
  // 否则"删掉"就是单向操作（用户只是嫌乱，不是要永久销毁）。
  const hiddenHintCount = Object.keys(snapshot.prefs.dismissedHints ?? {}).length
  const restoreHints = (): void => {
    void save({ dismissedHints: {} })
  }
  // 模型目录的状态说明。**三种失败形态都必须说出来**：不说的话界面表现完全一样
  // （两个下拉里只剩「继承主持人」），用户只会觉得"选不了"，无法判断是 host 没重启、
  // 还是自己没选 provider。这条提示是本轮实测反馈的直接产物。
  const catalogHint = catalog.state === 'loading'
    ? { text: t('modelCatalogLoading'), warn: false }
    : catalog.state === 'failed'
      ? { text: t('modelCatalogFailed').replace('{reason}', catalog.reason ?? ''), warn: true }
      : catalog.state === 'empty'
        ? { text: t('modelCatalogEmpty'), warn: true }
        : null

  return (
    <div className={styles.root}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t('settingsTitle')}</div>
        <div className={styles.hint}>{t('settingsIntro')}</div>
      </div>

      {notice === 'saved' ? <div className={`${styles.notice} ${styles.noticeOk}`}>{t('saved')}</div> : null}
      {notice === 'saveFailed' ? <div className={`${styles.notice} ${styles.noticeErr}`}>{t('saveFailed')}</div> : null}
      {catalogHint === null ? null : (
        <div className={catalogHint.warn ? `${styles.notice} ${styles.warn}` : styles.hint}>{catalogHint.text}</div>
      )}

      {/* ---------------- 默认强度（改动立即落库） ---------------- */}
      <div className={styles.section}>
        <div className={styles.label}>{t('defaultIntensity')}</div>
        <div className={styles.segmented}>
          {INTENSITY_ORDER.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              className={snapshot.prefs.defaultIntensity === option
                ? `${styles.segment} ${styles.segmentActive}`
                : styles.segment}
              onClick={() => {
                if (snapshot.prefs.defaultIntensity === option) return
                void save({ defaultIntensity: option })
              }}
            >
              {t(INTENSITY_LABEL_KEY[option])}
            </button>
          ))}
        </div>
        <div className={styles.hint}>
          {t('intensityHint')}
          {' '}
          {/* 生效规则用人类可读的文案键表达，不暴露 wire 字段名。 */}
          {`(${perDimensionText} / ${crossText} / ${recheckCapText})`}
        </div>
      </div>

      {/* ---------------- 维度池 ---------------- */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t('dimensionsTitle')}</div>
        <div className={styles.hint}>{t('dimensionsHint')}</div>

        <div className={styles.label}>{t('poolLabel')}</div>
        <div className={styles.chips}>
          {snapshot.pool.map((name) => (
            <span key={name} className={styles.chip}>{name}</span>
          ))}
        </div>

        <div className={styles.label}>{t('customLabel')}</div>
        {snapshot.prefs.customDimensions.length === 0 ? (
          <div className={styles.hint}>{t('customEmpty')}</div>
        ) : (
          <div className={styles.chips}>
            {snapshot.prefs.customDimensions.map((name) => (
              <span key={name} className={styles.chipCustom}>
                {name}
                <button
                  type="button"
                  className={styles.chipRemove}
                  disabled={busy}
                  title={t('customRemove')}
                  aria-label={`${t('customRemove')} ${name}`}
                  onClick={() => removeDimension(name)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className={styles.addRow}>
          <input
            className={styles.input}
            value={newDimension}
            maxLength={DIMENSION_NAME_MAX}
            placeholder={t('customPlaceholder')}
            aria-label={t('customAdd')}
            onChange={(event) => {
              setNewDimension(event.target.value)
              setDimensionError(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addDimension()
            }}
          />
          <button
            type="button"
            className={styles.addButton}
            disabled={busy || atDimensionLimit}
            onClick={addDimension}
          >
            {t('customAdd')}
          </button>
        </div>
        {dimensionError ? (
          <div className={`${styles.notice} ${styles.noticeErr}`}>
            {t('customInvalid').replace('{len}', String(DIMENSION_NAME_MAX))}
          </div>
        ) : null}
        {atDimensionLimit ? (
          <div className={styles.hint}>
            {t('customLimit').replace('{max}', String(CUSTOM_DIMENSION_MAX)).replace('{len}', String(DIMENSION_NAME_MAX))}
          </div>
        ) : null}
      </div>

      {/* ---------------- 预算（数字字段：失焦提交） ---------------- */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t('budgetTitle')}</div>
        <div className={styles.hint}>{t('budgetHint')}</div>
        {NUMERIC_FIELDS.map((field) => (
          <div className={styles.field} key={field.key}>
            <label className={styles.label} htmlFor={`cf-${field.key}`}>{t(field.labelKey)}</label>
            <input
              id={`cf-${field.key}`}
              className={styles.input}
              type="number"
              min={0}
              step={field.key === 'maxTokens' ? 1000 : 1}
              value={draft === null ? '' : draft[field.key]}
              onChange={(event) => patchDraft(field.key, event.target.value)}
              onBlur={() => commitNumber(field.key)}
            />
          </div>
        ))}
        <div className={styles.hint}>{t('unlimited')}</div>
      </div>

      {/* ---------------- 角色预设 ---------------- */}
      <div className={styles.section}>
        {/* 区块抬头行：标题在左，"新建"作为**区块主操作**在右。
            用户实测反馈"＋ 新建预设"不够显眼 —— 它此前和次要的"编辑/删除"同级、
            并淹没在列表下方。现在它是本区唯一的实心按钮，且位置固定不随列表长度漂移。 */}
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitle}>{t('settingsPresetsTitle')}</div>
          <span className={styles.sectionHeadGap} />
          <button
            type="button"
            className={styles.primaryButton}
            disabled={busy || atPresetLimit}
            title={atPresetLimit ? t('presetLimitInline').replace('{max}', String(ROLE_PRESET_MAX)) : undefined}
            onClick={() => beginEditPreset(null)}
          >
            {t('presetAddCount')
              .replace('{count}', String(snapshot.prefs.rolePresets.length))
              .replace('{max}', String(ROLE_PRESET_MAX))}
          </button>
        </div>
        <div className={styles.hint}>{t('settingsPresetsHint')}</div>

        {presetNotice === 'saved' ? <div className={`${styles.notice} ${styles.noticeOk}`}>{t('presetSaved')}</div> : null}
        {presetNotice === 'failed' ? <div className={`${styles.notice} ${styles.noticeErr}`}>{t('saveFailed')}</div> : null}
        {presetError === 'invalid' ? <div className={`${styles.notice} ${styles.noticeErr}`}>{t('presetInvalid')}</div> : null}
        {presetError === 'limit' || atPresetLimit ? (
          <div className={`${styles.notice} ${styles.warn}`}>
            {t('presetLimit').replace('{max}', String(ROLE_PRESET_MAX))}
          </div>
        ) : null}

        {snapshot.prefs.rolePresets.length === 0 ? (
          <div className={styles.hint}>{t('settingsPresetsEmpty')}</div>
        ) : (
          <div className={styles.list}>
            {presets.map((preset) => {
              const route = presetRoute(preset)
              return (
              <div className={styles.listRow} key={preset.id}>
                <div className={styles.rowHead}>
                  <span className={styles.rowName}>{preset.name}</span>
                  <span className={styles.spacer} />
                  <button
                    type="button"
                    className={styles.rowButton}
                    disabled={busy}
                    onClick={() => beginEditPreset(preset)}
                  >
                    {t('presetEdit')}
                  </button>
                  <button
                    type="button"
                    className={styles.rowDanger}
                    disabled={busy}
                    onClick={() => deletePreset(preset.id)}
                  >
                    {t('presetDelete')}
                  </button>
                </div>
                <div className={styles.rowMeta}>{previewRole(preset.role)}</div>
                {route === null ? null : (
                  // 品牌块给身份（一眼分辨哪个预设是哪个模型），后面的完整路由串给
                  // 可读性 —— 块的 `title` 在触屏上读不到，不能只靠它。
                  <div className={styles.routeRow}>
                    <span
                      className={styles.brandBlock}
                      style={{ background: providerBrand(preset.provider).color }}
                      title={routeText(preset.provider, preset.model)}
                    >
                      {routeAbbr(preset.provider, preset.model)}
                    </span>
                    <span className={styles.rowMeta}>{`${t('presetProvider')}${route}`}</span>
                  </div>
                )}
              </div>
              )
            })}
          </div>
        )}

        {presetEdit === null ? null : (
          <div className={styles.editor}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="cf-preset-name">{t('presetName')}</label>
              <input
                id="cf-preset-name"
                className={styles.inputWide}
                value={presetEdit.name}
                onChange={(event) => {
                  const value = event.target.value
                  setPresetEdit((previous) => (previous === null ? previous : { ...previous, name: value }))
                }}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="cf-preset-role">{t('presetRole')}</label>
              <textarea
                id="cf-preset-role"
                className={styles.textarea}
                rows={3}
                value={presetEdit.role}
                onChange={(event) => {
                  const value = event.target.value
                  setPresetEdit((previous) => (previous === null ? previous : { ...previous, role: value }))
                }}
              />
            </div>
            <div className={styles.gridTwo}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="cf-preset-provider">{t('presetProvider')}</label>
                <select
                  id="cf-preset-provider"
                  className={styles.inputWide}
                  value={presetEdit.provider}
                  onChange={(event) => {
                    // 换 provider 必须清空 model：旧 model 属于上一个 provider，
                    // 留着就得到一个 provider/model 不匹配的路由。
                    const value = event.target.value
                    setPresetEdit((previous) => (previous === null ? previous : { ...previous, provider: value, model: '' }))
                  }}
                >
                  <option value="">{t('modelInherit')}</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name === '' ? provider.id : provider.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="cf-preset-model">{t('presetModel')}</label>
                <select
                  id="cf-preset-model"
                  className={styles.inputWide}
                  value={presetEdit.model}
                  disabled={presetEdit.provider === ''}
                  // 模型必须先选 provider 才有意义（否则会得到一个 provider/model 不匹配
                  // 的路由）。禁用的原因写成 title，避免它看起来像坏了。
                  title={presetEdit.provider === '' ? t('presetProviderNeeded') : undefined}
                  onChange={(event) => {
                    const value = event.target.value
                    setPresetEdit((previous) => (previous === null ? previous : { ...previous, model: value }))
                  }}
                >
                  <option value="">{t('modelInherit')}</option>
                  {(providers.find((provider) => provider.id === presetEdit.provider)?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name === '' ? model.id : model.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className={styles.addRow}>
              <button
                type="button"
                className={styles.addButton}
                disabled={anySaving}
                onClick={savePreset}
              >
                {t('presetSave')}
              </button>
              <button
                type="button"
                className={styles.addButton}
                disabled={anySaving}
                onClick={() => {
                  setPresetEdit(null)
                  setPresetError(null)
                }}
              >
                {t('presetCancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- 阵容预设 ---------------- */}
      <div className={styles.section}>
        {/* 与角色预设同一套层级：标题在左、新建在右、且是唯一实心按钮。 */}
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitle}>{t('settingsSquadsTitle')}</div>
          <span className={styles.sectionHeadGap} />
          <button
            type="button"
            className={styles.primaryButton}
            disabled={busy || atSquadLimit}
            title={atSquadLimit
              ? t('squadLimit').replace('{max}', String(SQUAD_MAX)).replace('{members}', String(SQUAD_MEMBER_MAX))
              : undefined}
            onClick={() => beginEditSquad(null)}
          >
            {t('squadAddCount')
              .replace('{count}', String(snapshot.prefs.squads.length))
              .replace('{max}', String(SQUAD_MAX))}
          </button>
        </div>
        <div className={styles.hint}>{t('settingsSquadsHint')}</div>

        {squadNotice === 'saved' ? <div className={`${styles.notice} ${styles.noticeOk}`}>{t('squadSaved')}</div> : null}
        {squadNotice === 'failed' ? <div className={`${styles.notice} ${styles.noticeErr}`}>{t('saveFailed')}</div> : null}
        {squadError === 'invalid' ? <div className={`${styles.notice} ${styles.noticeErr}`}>{t('squadInvalid')}</div> : null}
        {squadError === 'limit' || atSquadLimit ? (
          <div className={`${styles.notice} ${styles.warn}`}>
            {t('squadLimit')
              .replace('{max}', String(SQUAD_MAX))
              .replace('{members}', String(SQUAD_MEMBER_MAX))}
          </div>
        ) : null}

        {snapshot.prefs.squads.length === 0 ? (
          <div className={styles.hint}>{t('settingsSquadsEmpty')}</div>
        ) : (
          <div className={styles.list}>
            {squads.map((squad) => (
              <div className={styles.listRow} key={squad.id}>
                <div className={styles.rowHead}>
                  <span className={styles.rowName}>{squad.name}</span>
                  <span className={styles.rowMeta}>
                    {t('squadMemberCount').replace('{count}', String(squad.members.length))}
                  </span>
                  <span className={styles.spacer} />
                  <button
                    type="button"
                    className={styles.rowButton}
                    disabled={busy}
                    onClick={() => beginEditSquad(squad)}
                  >
                    {t('squadEdit')}
                  </button>
                  <button
                    type="button"
                    className={styles.rowDanger}
                    disabled={busy}
                    onClick={() => deleteSquad(squad.id)}
                  >
                    {t('squadDelete')}
                  </button>
                </div>
                <div className={styles.chips}>
                  {squad.members.map((member) => (
                    // 成员 chip 带一个品牌块：阵容是"谁来"的答案，而"谁"的一半信息
                    // 其实是它跑在哪个模型上。没有路由时块显示中性 `?`（继承主持人）。
                    <span className={styles.chipWithBrand} key={member.key}>
                      <span
                        className={styles.brandBlockSmall}
                        style={{ background: providerBrand(member.provider).color }}
                        title={member.provider === undefined ? t('modelInherit') : routeText(member.provider, member.model)}
                      >
                        {providerBrand(member.provider).abbr}
                      </span>
                      {member.key}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {squadEdit === null ? null : (
          <div className={styles.editor}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="cf-squad-name">{t('squadName')}</label>
              <input
                id="cf-squad-name"
                className={styles.inputWide}
                value={squadEdit.name}
                onChange={(event) => {
                  const value = event.target.value
                  patchSquadDraft((current) => ({ ...current, name: value }))
                }}
              />
            </div>

            <div className={styles.label}>{t('squadMembers')}</div>
            {squadEdit.members.map((member, index) => (
              // 成员行是纯草稿，没有稳定 id；用 index 作为 key 在"只在尾部增删"的
              // 交互下是安全的（删除会让后续行整体上移，输入值本来就跟随位置）。
              <div className={styles.member} key={`member-${String(index)}`}>
                <div className={styles.memberFields}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`cf-squad-key-${String(index)}`}>
                      {t('squadMemberKey')}
                    </label>
                    <input
                      id={`cf-squad-key-${String(index)}`}
                      className={styles.inputWide}
                      value={member.key}
                      maxLength={32}
                      onChange={(event) => patchSquadMember(index, { key: event.target.value })}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`cf-squad-role-${String(index)}`}>
                      {t('squadMemberRole')}
                    </label>
                    <input
                      id={`cf-squad-role-${String(index)}`}
                      className={styles.inputWide}
                      value={member.role}
                      onChange={(event) => patchSquadMember(index, { role: event.target.value })}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`cf-squad-provider-${String(index)}`}>
                      {t('presetProvider')}
                    </label>
                    <select
                      id={`cf-squad-provider-${String(index)}`}
                      className={styles.inputWide}
                      value={member.provider}
                      onChange={(event) => patchSquadMember(index, { provider: event.target.value, model: '' })}
                    >
                      <option value="">{t('modelInherit')}</option>
                      {providers.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name === '' ? provider.id : provider.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`cf-squad-model-${String(index)}`}>
                      {t('presetModel')}
                    </label>
                    <select
                      id={`cf-squad-model-${String(index)}`}
                      className={styles.inputWide}
                      value={member.model}
                      disabled={member.provider === undefined || member.provider === ''}
                      title={member.provider === undefined || member.provider === '' ? t('presetProviderNeeded') : undefined}
                      onChange={(event) => patchSquadMember(index, { model: event.target.value })}
                    >
                      <option value="">{t('modelInherit')}</option>
                      {(providers.find((provider) => provider.id === member.provider)?.models ?? []).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name === '' ? model.id : model.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <button
                  type="button"
                  className={styles.rowDanger}
                  title={t('squadRemoveMember')}
                  aria-label={`${t('squadRemoveMember')} ${String(index + 1)}`}
                  onClick={() => removeSquadMember(index)}
                >
                  {t('squadRemoveMember')}
                </button>
              </div>
            ))}

            <div className={styles.addRow}>
              <button
                type="button"
                className={styles.addButton}
                disabled={squadEdit.members.length >= SQUAD_MEMBER_MAX}
                onClick={addSquadMember}
              >
                {t('squadAddMember')}
              </button>
            </div>

            <div className={styles.addRow}>
              <button
                type="button"
                className={styles.addButton}
                disabled={anySaving}
                onClick={saveSquad}
              >
                {t('squadSave')}
              </button>
              <button
                type="button"
                className={styles.addButton}
                disabled={anySaving}
                onClick={() => {
                  setSquadEdit(null)
                  setSquadError(null)
                }}
              >
                {t('squadCancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- 已隐藏的说明（可恢复） ----------------
          用户在卡片上关掉的解释性说明是**持久**的（刷新页面不会回来）。那个"删掉"是
          为了少点视觉负担，不是要永久销毁，所以必须留一个恢复入口 —— 否则它就成了
          一条单向操作。这里只统计条数并整体恢复：恢复是低频操作，逐条恢复不值得多一
          屏列表。 */}
      <div className={styles.section}>
        <div className={styles.label}>{t('settingsExplainTitle')}</div>
        {hiddenHintCount === 0 ? (
          <div className={styles.hint}>{t('settingsExplainNone')}</div>
        ) : (
          <div className={styles.addRow}>
            <span className={styles.hint}>
              {t('settingsExplainCount').replace('{n}', String(hiddenHintCount))}
            </span>
            <button
              type="button"
              className={styles.addButton}
              disabled={busy}
              onClick={restoreHints}
            >
              {t('settingsExplainRestore')}
            </button>
          </div>
        )}
      </div>

      {/* ---------------- 边界 ---------------- */}
      <div className={styles.boundary}>
        <div className={styles.boundaryTitle}>{t('boundaryTitle')}</div>
        <div>{t('boundaryLine1')}</div>
        <div>{t('boundaryLine2')}</div>
        <div>{t('boundaryLine3')}</div>
        <div>{t('boundaryLine4')}</div>
      </div>

      <div className={styles.batchNote}>{t('batchNote')}</div>
    </div>
  )
}
