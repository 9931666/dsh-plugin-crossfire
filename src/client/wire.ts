/**
 * Wire types shared by the Crossfire browser half: the RPC result envelope and
 * the shapes the settings page consumes.
 *
 * 这些类型**刻意在浏览器侧重新声明**，而不是从 host 的 `src/types.ts` import：
 * `tsconfig.client.json` 只 include `src/client`，跨目录 import 会把 host 模块
 * 拖进客户端类型程序（圆桌会议也采用同一处置）。
 *
 * @module dsh-plugin-crossfire/client/wire
 */

/** One RPC response envelope (structurally compatible with the host's RpcResult). */
export type RpcEnvelope<T> =
  | { ok: true; value: T; error?: never }
  | { ok: false; error: { code: string; message: string; details?: unknown }; value?: never }

/** A tiny typed RPC caller over the plugin's own web route. */
export type RpcCaller = <T>(endpoint: string, payload: unknown) => Promise<RpcEnvelope<T>>

/** 插件自有 RPC 路由。必须与 host `rpc.ts` 的 `RPC_ROUTE` 逐字一致。 */
export const RPC_ROUTE = '/plugins/dsh-plugin-crossfire/rpc'

/**
 * POST one RPC call to the plugin's OWN web route.
 *
 * 这条路由与（批 3 起的）快照路由挂在同一个 `webServer` 注册上，因此即使宿主
 * 的通用 connection 通道没有挂载，浏览器也能到达它。不可达或格式错误一律返回
 * 失败包封，而不是让 promise reject —— 调用方不必写 try/catch。
 */
export async function callRpc<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcEnvelope<T>> {
  try {
    const response = await fetch(RPC_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    })
    const body = await response.json() as unknown
    const envelope = body as RpcEnvelope<T> | null
    if (envelope === null || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
      return { ok: false, error: { code: 'internal', message: `crossfire rpc route returned ${response.status}` } }
    }
    return envelope
  } catch (error: unknown) {
    return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
  }
}

/** 攻击强度档。 */
export type Intensity = 'quick' | 'standard' | 'deep'

/** 用户自建角色预设（与 host `RolePreset` 对应）。 */
export interface WireRolePreset {
  id: string
  name: string
  role: string
  provider?: string
  model?: string
}

/** 阵容预设的一位成员（与 host `RoleSquadMember` 对应）。 */
export interface WireRoleSquadMember {
  key: string
  role: string
  provider?: string
  model?: string
}

/** 用户自建阵容预设（与 host `RoleSquad` 对应）。 */
export interface WireRoleSquad {
  id: string
  name: string
  members: WireRoleSquadMember[]
}

/** `crossfire/models.list` 里的一个 provider 及其可选模型（与圆桌同源做法）。 */
export interface WireProviderOption {
  id: string
  name: string
  models: { id: string; name: string }[]
}

/** 偏好形状（与 host `CrossfirePreferences` 对应）。 */
export interface WirePrefs {
  defaultIntensity: Intensity
  maxRounds: number
  maxTokens: number
  expertMaxTokens: number
  expertMaxOpinions: number
  customDimensions: string[]
  rolePresets: WireRolePreset[]
  squads: WireRoleSquad[]
  /** 被用户关掉的解释性说明（键 → true）；持久化，刷新不会回来。 */
  dismissedHints: Record<string, boolean>
}

/** 强度档的生效规则（单一来源在 host 侧，客户端只读展示）。 */
export interface WireIntensitySpec {
  expertsPerDimension: number
  crossExamination: boolean
  maxReviewPass: number
  label: string
}

/** `crossfire/prefs.get` 的返回载荷。 */
export interface WirePrefsSnapshot {
  prefs: WirePrefs
  /** 固定维度池。 */
  pool: string[]
  /** 本次实际可用维度：固定池 + 自定义。 */
  dimensions: string[]
  intensities: Record<Intensity, WireIntensitySpec>
  stateDir: string
}

/* ------------------------------------------------------------------ *
 * 评审快照（卡片的数据源）
 * ------------------------------------------------------------------ */

/** 评审状态机的四态（与 host `ReviewStatus` 对应）。 */
export type WireReviewStatus = 'draft' | 'attacking' | 'judging' | 'settled'

/** 缺陷三态。 */
export type WireDefectStatus = 'pending' | 'endorsed' | 'rejected'

/** 复审核对结论。 */
export type WireRecheckVerdict = 'fixed' | 'unfixed' | 'partial'

/** 一位红队在卡片上的状态。 */
export interface WireExpert {
  key: string
  dimension: string
  status: string
  defectCount: number
  /** 提交过几次发言 —— collect 之前唯一有意义的数字（defectCount 那时必然是 0）。 */
  reportCount?: number
  /**
   * 这位专家实际使用的模型路由。
   *
   * 未显式指定时（继承主持人）host 不写这两个字段 —— 那**不是**缺失信息，而是
   * "跟随主持人"这一事实本身，卡片据此显示"继承"而不是一个猜出来的 provider。
   */
  provider?: string
  model?: string
  /** 用户补充的角色定位（专家列表里可编辑；进 persona 的「你的角色定位」段）。 */
  role?: string
  note?: string
}

/** 一条缺陷（卡片上的一张子卡）。 */
export interface WireDefect {
  id: string
  expertKey: string
  dimension: string
  /** true = 落库时维度被归一化过（原始值不可识别）。 */
  dimensionFallback?: boolean
  content: string
  quote?: string
  evidence?: { kind: 'repro' | 'argument'; text: string }
  /** true = 这条缺陷打穿了用户立场里的某条理由。 */
  strikesStance?: boolean
  status: WireDefectStatus
  rejectReason?: string
  recheck?: { pass: number; verdict?: WireRecheckVerdict; note?: string }
}

/** 一场评审的卡片快照（与 host `ReviewSnapshot` 对应）。 */
export interface WireReview {
  reviewId: string
  status: WireReviewStatus
  subjectTitle: string
  subjectContent: string
  subjectSource: string
  stanceText: string
  stanceOrigin: string
  dimensions: string[]
  intensity: Intensity
  intensityLabel: string
  reviewPass: number
  maxReviewPass: number
  experts: WireExpert[]
  defects: WireDefect[]
  counts: { total: number; pending: number; endorsed: number; rejected: number; strikes: number }
  budget: { maxRounds: number; maxTokens: number; usedRounds: number; usedTokens: number }
  startedAt: number
  updatedAt: number
  /** 这份评审所在的状态根；回传它可让 host 免去一次工作区遍历。 */
  stateRoot: string
}

/** `crossfire/reviews.list` 的返回载荷。 */
export interface WireReviewList {
  reviews: WireReview[]
  note?: string
}

/** 快照路由（GET，卡片轮询它）。必须与 host `rpc.ts` 的 `STATE_ROUTE` 一致。 */
export const STATE_ROUTE = '/plugins/dsh-plugin-crossfire/state'

/** 拉一次评审快照列表。失败一律返回空列表（卡片宁可空着也不该崩）。 */
export async function fetchReviews(
  session: string,
  signal?: AbortSignal,
): Promise<WireReviewList> {
  try {
    const query = session === '' ? '' : `?session=${encodeURIComponent(session)}`
    // `no-cache` 而不是 `no-store`：`no-store` 让浏览器**根本不存副本**，于是
    // `If-None-Match` 永远不会被回传 —— 主机侧 `sendJsonConditional`（src/etag.ts）
    // 的 ETag/304 优化静默失效，卡片每 2s 一次全量读盘 + 全量序列化 + 全量传输。
    // `no-cache` 的语义仍是"每次回源校验"，但允许保存副本，304 才会发生。
    const response = await fetch(`${STATE_ROUTE}${query}`, {
      cache: 'no-cache',
      ...(signal === undefined ? {} : { signal }),
    })
    const body = await response.json() as WireReviewList | null
    if (body === null || typeof body !== 'object' || !Array.isArray(body.reviews)) {
      return { reviews: [], note: `state route returned ${response.status}` }
    }
    return body
  } catch (error: unknown) {
    return { reviews: [], note: error instanceof Error ? error.message : String(error) }
  }
}

/** 推进状态机的四个步骤（O1 直推）。 */
export type AdvanceStep = 'attack' | 'collect' | 'finish' | 'recheck'
