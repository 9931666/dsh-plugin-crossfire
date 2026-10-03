/**
 * Crossfire 的浏览器面：一个 `dispatch`（RPC）+ 一个快照收集器（GET）。
 *
 * ## 两条传输，同一份 dispatch
 *
 * 1. 插件自有的 web POST 路由 `/plugins/dsh-plugin-crossfire/rpc`（首选：任何带 web
 *    服务的 profile 都可达）；
 * 2. 宿主通用 connection 通道（兜底，经 `ctx.get` 懒取）。
 *
 * ## O1：卡片按钮**直推** host 状态机
 *
 * 这是 crossfire 与圆桌会议最重要的编排差异。圆桌的 UI 只能写"用户行为队列"，
 * 等主持人下一轮执行；针锋的按钮直接调用这里的 `crossfire/review.advance`，
 * 因此用户点"开审"不必等一整个模型回合。
 *
 * 代价是：**RPC 路径没有 `exec.agent`**。凡是需要父 Agent 的动作（拉起子代理）
 * 就得先按会话 id 把 Agent 找回来（`ctx.agents.get`）；找不到（会话已冷）时如实
 * 失败并让用户改用对话触发，而不是假装成功。
 *
 * ## 一条不可越界的规则
 *
 * `crossfire/defect.setStatus` **只允许人从界面调用**。它没有对应的 agent 工具，
 * 也永远不该有：表态权是这个插件存在的理由本身。
 *
 * @module dsh-plugin-crossfire/rpc
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { applyCollected, collectDefects, planExperts, rosterFrom } from './engine.ts'
import { registerExpertChild } from './expert-events.ts'
import { spawnExpert } from './members.ts'
import { effectiveDimensions, type PreferenceStore } from './preferences.ts'
import {
  buildRecheckItems,
  countDefects,
  exportFile,
  exportTextFile,
  mutateRecord,
  newRecord,
  readRecord,
  readTranscriptReport,
  setDefectStatus,
  setRecheckVerdict,
  writeRecord,
} from './review.ts'
import { resolveDimensions } from './dimensions.ts'
import { renderReviewMarkdown } from './export-md.ts'
import type { ToolsConfig } from './tools.ts'
import {
  listReviewIds,
  newReviewId,
  reviewLockKey,
  stateRootOf,
  withCrossfireLock,
  writeTextAtomic,
  writeTextAtomicWithBom,
} from './state.ts'
import { DIMENSION_POOL, INTENSITY_SPECS, type CrossfireRecord, type Intensity } from './types.ts'
import { workspaceRegistryOf } from './harness-compat.ts'
import type { SplitLlmLike } from './split.ts'
import { assertBudget, beginPass } from './budget.ts'

/** 插件自有 RPC 路由（浏览器半体优先走这条）。 */
export const RPC_ROUTE = '/plugins/dsh-plugin-crossfire/rpc'

/** 插件自有快照路由（卡片每秒轮询它）。 */
export const STATE_ROUTE = '/plugins/dsh-plugin-crossfire/state'

/** 运行时依赖：偏好存储 + 工具/引擎共用的配置（单一来源）。 */
export interface CrossfireRuntime {
  prefs: PreferenceStore
  tools: ToolsConfig
}

/** RPC 失败包封。 */
export interface RpcFailure {
  ok: false
  error: { code: string; message: string }
}

/** RPC 结果包封（成功 / 失败二选一）。 */
export type RpcResult = { ok: true; value: unknown } | RpcFailure

function ok(value: unknown): RpcResult {
  return { ok: true, value }
}

function fail(message: string, code = 'internal'): RpcResult {
  return { ok: false, error: { code, message } }
}

/** dispatch 的类型：端点名 + 载荷 → 结果包封。 */
export type RpcDispatch = (endpoint: string, payload: unknown) => Promise<RpcResult>

/** 卡片所需的评审快照（刻意不含 workspace 绝对路径之外的任何隐私内容）。 */
export interface ReviewSnapshot {
  reviewId: string
  status: CrossfireRecord['status']
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
  experts: {
    key: string
    dimension: string
    status: string
    defectCount: number
    reportCount?: number
    /** 实际模型路由；未指定（继承主持人）时两个字段都不出现。 */
    provider?: string
    model?: string
    /** 用户补充的角色定位（专家列表里可编辑）。 */
    role?: string
    note?: string
  }[]
  defects: {
    id: string
    expertKey: string
    dimension: string
    dimensionFallback?: boolean
    content: string
    quote?: string
    evidence?: { kind: 'repro' | 'argument'; text: string }
    strikesStance?: boolean
    status: 'pending' | 'endorsed' | 'rejected'
    rejectReason?: string
    /** 复审核对结论；`verdict` 缺席 = 尚未判断（**不是**"未修复"）。 */
    recheck?: { pass: number; verdict?: string; note?: string }
  }[]
  counts: { total: number; pending: number; endorsed: number; rejected: number; strikes: number }
  budget: { maxRounds: number; maxTokens: number; usedRounds: number; usedTokens: number }
  startedAt: number
  updatedAt: number
  /** 这份评审所在的状态根（客户端回传后可免去再次遍历工作区）。 */
  stateRoot: string
}

/** 把记录收敛成卡片快照。 */
export function snapshotOf(record: CrossfireRecord, stateRoot: string): ReviewSnapshot {
  return {
    reviewId: record.reviewId,
    status: record.status,
    subjectTitle: record.subject.title,
    subjectContent: record.subject.content,
    subjectSource: record.subject.source,
    stanceText: record.stance.text,
    stanceOrigin: record.stance.origin,
    dimensions: [...record.dimensions],
    intensity: record.intensity,
    intensityLabel: INTENSITY_SPECS[record.intensity].label,
    reviewPass: record.reviewPass,
    maxReviewPass: record.maxReviewPass,
    experts: record.experts.map((expert) => ({
      key: expert.key,
      dimension: expert.dimension,
      status: expert.status,
      defectCount: expert.defectCount,
      ...(expert.reportCount === undefined ? {} : { reportCount: expert.reportCount }),
      // 模型路由只为了让卡片能画一个品牌块（缩写 + 品牌色）。缺失即"继承主持人"，
      // 刻意不填一个默认 provider —— 那会让界面显示一个并非事实的路由。
      ...(expert.provider === undefined ? {} : { provider: expert.provider }),
      ...(expert.model === undefined ? {} : { model: expert.model }),
      // 用户的补充角色定位：卡片上的"专家列表"要能显示与编辑它。
      ...(expert.role === undefined ? {} : { role: expert.role }),
      ...(expert.note === undefined ? {} : { note: expert.note }),
    })),
    defects: record.defects.map((defect) => ({
      id: defect.id,
      expertKey: defect.expertKey,
      dimension: defect.dimension,
      ...(defect.dimensionFallback === true ? { dimensionFallback: true } : {}),
      content: defect.content,
      ...(defect.quote === undefined ? {} : { quote: defect.quote }),
      ...(defect.evidence === undefined ? {} : { evidence: defect.evidence }),
      ...(defect.strikesStance === true ? { strikesStance: true } : {}),
      status: defect.status,
      ...(defect.rejectReason === undefined ? {} : { rejectReason: defect.rejectReason }),
      ...(defect.recheck === undefined ? {} : { recheck: defect.recheck }),
    })),
    counts: countDefects(record),
    budget: { ...record.budget },
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    stateRoot,
  }
}

/* ------------------------------------------------------------------ *
 * 工作区解析（RPC 没有 exec.agent，只能靠会话 id 或遍历）
 * ------------------------------------------------------------------ */

/** 会话活着时，直接从它的 Agent 拿到工作区（最精确）。 */
function workspaceOfSession(ctx: Context, session: string): string | undefined {
  if (session === '') return undefined
  const agent = ctx.agents.get(session as SessionId)
  if (agent === undefined) return undefined
  const header = (agent.session as unknown as { header?: { cwd?: string } }).header
  return header?.cwd
}

/** 会话活着时把 Agent 找回来（拉起专家需要它当 parent）。 */
function agentOfSession(ctx: Context, session: string): Agent | undefined {
  if (session === '') return undefined
  return ctx.agents.get(session as SessionId)
}

/** 身份判定的结果。 */
export type ActorVerdict =
  | { ok: true; bound: boolean }
  | { ok: false; code: 'no-actor' | 'foreign-owner'; message: string }

/**
 * 判定"谁在操作这一场评审"。
 *
 * ## 为什么必须是严格的（这里出过一个真实的安全缺陷）
 *
 * 会话 id 在这个插件里**同时是凭据和权限**：`load()` 用它做归属校验，
 * `review.advance` 的 attack 分支又用它换回 live Agent 去拉起专家。原先的写法把
 * 空会话当成"跳过校验"，于是当客户端没把 session 送进来时：
 *
 * - 归属校验整条短路（任何会话都能操作任何记录）；
 * - 而 attack 又会退回用**记录里的 owner** 换 Agent，照样把专家拉起来。
 *
 * 结果是一条能真正干活的越权通道，而且它的成功响应与合法调用完全同形 —— 验收时
 * 根本分不出来。红队在验收流程里抓到了这一点。
 *
 * 所以现在的规则是：**必须声称一个会话**。规则本身是纯函数，因此可以被测试直接
 * 钉住（`test/rpc-identity.test.mjs`），而不是只靠人工点一次按钮。
 *
 * @param ownerSessionId - 记录里的 owner（早期数据可能没有）。
 * @param actorSession - 调用方声称的会话 id（缺失时为 `''`）。
 */
export function judgeActor(ownerSessionId: string | undefined, actorSession: string): ActorVerdict {
  if (actorSession === '') {
    return {
      ok: false,
      code: 'no-actor',
      message: 'this request carried no session identity — reload the page so the card can send one',
    }
  }
  // 没有 owner 的是早期数据：放行但标记为未绑定，调用方可以据此提示。
  if (ownerSessionId === undefined || ownerSessionId === '') return { ok: true, bound: false }
  if (ownerSessionId !== actorSession) {
    return {
      ok: false,
      code: 'foreign-owner',
      message: 'this review belongs to another session',
    }
  }
  return { ok: true, bound: true }
}

/** 已知的全部候选状态根（工作区注册表可用时）。 */
function candidateStateRoots(ctx: Context, stateDir: string): string[] {
  const registry = workspaceRegistryOf(ctx)
  if (registry === undefined) return []
  const roots: string[] = []
  for (const workspace of registry.list()) {
    const root = stateRootOf(workspace.path, stateDir)
    if (!roots.includes(root)) roots.push(root)
  }
  return roots
}

/**
 * 定位一场评审。
 *
 * 优先用客户端回传的 `stateRoot`（一次命中，不再遍历）；否则遍历已知工作区。
 * 评审数量天然很少，所以这个遍历不是瓶颈。
 */
async function locateReview(
  ctx: Context,
  stateDir: string,
  reviewId: string,
  preferredRoot?: string,
): Promise<{ stateRoot: string; record: CrossfireRecord } | undefined> {
  const roots: string[] = []
  if (preferredRoot !== undefined && preferredRoot !== '') roots.push(preferredRoot)
  for (const root of candidateStateRoots(ctx, stateDir)) {
    if (!roots.includes(root)) roots.push(root)
  }
  for (const root of roots) {
    const record = await readRecord(root, reviewId)
    if (record !== undefined) return { stateRoot: root, record }
  }
  return undefined
}

/** 收集全部评审快照（卡片轮询的数据源）。 */
export async function collectSnapshots(
  ctx: Context,
  stateDir: string,
  session: string,
): Promise<{ reviews: ReviewSnapshot[]; note?: string }> {
  // 身份优先：先确认"你是谁"，再谈"你能看什么"。这一步必须排在工作区解析之前 ——
  // 否则缺身份时会被报成"没有工作区"，把排查方向指向错误的层。
  if (session === '') {
    return {
      reviews: [],
      note: 'this request carried no session identity — reload the page so the card can send one',
    }
  }
  const roots: string[] = []
  const sessionWorkspace = workspaceOfSession(ctx, session)
  if (sessionWorkspace !== undefined) roots.push(stateRootOf(sessionWorkspace, stateDir))
  for (const root of candidateStateRoots(ctx, stateDir)) {
    if (!roots.includes(root)) roots.push(root)
  }
  if (roots.length === 0) {
    return {
      reviews: [],
      note: 'no workspace is known for this session (the session may be cold, and no workspace registry is mounted)',
    }
  }
  // 空会话一律返回空集：不传身份不是"跳过过滤"，而是"不知道你是谁"。原先那种
  // 写法在这种情况下会把**全部**评审交出去 —— 与会话 id 兼任权限凭据是同一类
  // 问题（红队在验收里抓到过）。卡片现在总会带上 session，所以这条退化路径只在
  // 异常时出现，而它应当是保守的那一边。（检查位置见函数开头。）
  const reviews: ReviewSnapshot[] = []
  for (const root of roots) {
    for (const reviewId of await listReviewIds(root)) {
      const record = await readRecord(root, reviewId)
      if (record === undefined) continue
      // 有归属的记录只回给它的 owner；没有归属的（早期数据）照常返回。
      if (record.ownerSessionId !== undefined && record.ownerSessionId !== ''
        && record.ownerSessionId !== session) {
        continue
      }
      reviews.push(snapshotOf(record, root))
    }
  }
  reviews.sort((left, right) => right.startedAt - left.startedAt)
  return { reviews }
}

/* ------------------------------------------------------------------ *
 * dispatch
 * ------------------------------------------------------------------ */

/** 注册 RPC 端点，返回可复用的 `dispatch`。 */
export function registerRpc(ctx: Context, runtime: CrossfireRuntime): RpcDispatch {
  const stateDir = runtime.tools.stateDir

  /** 读一个评审并校验归属。 */
  const load = async (
    reviewId: string,
    session: string,
    preferredRoot?: string,
  ): Promise<{ stateRoot: string; record: CrossfireRecord }> => {
    if (reviewId === '') throw new Error('reviewId must not be empty')
    const located = await locateReview(ctx, stateDir, reviewId, preferredRoot)
    if (located === undefined) throw new Error(`no review "${reviewId}"`)
    const verdict = judgeActor(located.record.ownerSessionId, session)
    if (!verdict.ok) throw new Error(verdict.message)
    return located
  }

  return async (endpoint: string, payload: unknown): Promise<RpcResult> => {
    try {
      const body = (payload !== null && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
      const session = typeof body.session === 'string' ? body.session : ''
      const reviewId = typeof body.reviewId === 'string' ? body.reviewId : ''
      const preferredRoot = typeof body.stateRoot === 'string' ? body.stateRoot : undefined

      switch (endpoint) {
        /* ---------------- 偏好读写（设置页） ---------------- */
        case 'crossfire/prefs.get': {
          const prefs = runtime.prefs.get()
          return ok({
            prefs,
            pool: [...DIMENSION_POOL],
            dimensions: effectiveDimensions(prefs),
            intensities: INTENSITY_SPECS,
            stateDir,
          })
        }
        case 'crossfire/prefs.set': {
          // 身份门禁（红队评审抓出的真实缺陷）：这条分支此前**是唯一不校验会话的
          // 写端点** —— 它写的是 `$DSH_HOME` 下的**全局**偏好文件，而 RPC 是公开
          // HTTP 路由，于是任何能 POST 到本机端口的调用者都能改全局设置。
          //
          // 用 `judgeActor(undefined, session)` 而不是绑定某个 owner：偏好是全局的，
          // 不属于哪一场评审，因此这里要的是"**必须声称一个身份**"（空身份一律拒），
          // 而不是"只有某场评审的 owner 能改"。
          const gate = judgeActor(undefined, session)
          if (!gate.ok) throw new Error(gate.message)
          if (body.patch === undefined) return fail('payload must be { patch }')
          const next = await runtime.prefs.update(body.patch)
          return ok({ prefs: next, dimensions: effectiveDimensions(next) })
        }

        /* ---------------- 模型目录（设置页下拉的数据源） ---------------- */
        case 'crossfire/models.list': {
          // 与圆桌的 `roundtable/models.list` 同源做法：向宿主的 llm 服务要 provider
          // 与 model 目录。某个 provider 列不出模型（例如没配 key）时它仍然出现，
          // 只是模型列表为空 —— 界面照常可用，而不是整个下拉空掉。
          //
          // **目录源必须是两条而不是一条**（红队评审抓出的真实缺陷）：宿主的
          // `LlmFace` 把"模型目录"定义为 `listProviders()`（已注册/live）与
          // `listConfigurableProviders()`（声明但休眠）的**并集**
          // （`@deepseek-ai/dsh-llm` 的 `LlmConfigurableProvider` 文档明说
          // "whether or not the route is currently registered"）。只取前者会让
          // 下拉的选项集合严格窄于它所取代的文本框：未配置的 provider 在针锋里
          // 根本选不到，而宿主的 Models 页列得出来。
          const llm = ctx.get('llm') as
            | {
                listProviders(): { id: string; name: string }[]
                listConfigurableProviders?(): { provider: string; displayName: string }[]
                listModels(provider: string): Promise<{ id: string; name: string }[]>
              }
            | undefined
          if (llm === undefined) return ok({ providers: [] })

          const merged = new Map<string, { id: string; name: string; active: boolean }>()
          for (const provider of llm.listProviders()) {
            merged.set(provider.id, { id: provider.id, name: provider.name, active: true })
          }
          // 可选探测：老宿主没有这个方法时保持"只有 live provider"的旧行为，
          // 而不是把整条端点打挂（探测式降级，不写进 inject 门禁）。
          if (typeof llm.listConfigurableProviders === 'function') {
            let declared: { provider: string; displayName: string }[] = []
            try {
              declared = llm.listConfigurableProviders()
            } catch {
              declared = []
            }
            for (const provider of declared) {
              if (merged.has(provider.provider)) continue
              merged.set(provider.provider, { id: provider.provider, name: provider.displayName, active: false })
            }
          }
          // active 的排前面：下拉里"能直接用的"应该先出现，休眠项排后并以 active=false
          // 标记（客户端据此禁用并提示"需先在宿主配置"），排序保证同一份输入顺序稳定。
          const providers: { id: string; name: string; models: { id: string; name: string }[]; active: boolean }[] = []
          for (const entry of [...merged.values()].sort((left, right) => {
            if (left.active !== right.active) return left.active ? -1 : 1
            return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
          })) {
            let models: { id: string; name: string }[] = []
            // 休眠 provider 不列举模型：它没有活路由，列举只会失败或被折叠成空数组，
            // 那正是"看起来能选、选了不生效"的来源。
            if (entry.active) {
              try {
                models = (await llm.listModels(entry.id)).map((model) => ({ id: model.id, name: model.name }))
              } catch {
                models = []
              }
            }
            providers.push({ id: entry.id, name: entry.name, models, active: entry.active })
          }
          return ok({ providers })
        }

        /* ---------------- 快照（卡片轮询） ---------------- */
        case 'crossfire/reviews.list': {
          const collected = await collectSnapshots(ctx, stateDir, session)
          return ok(collected)
        }
        case 'crossfire/review.get': {
          const located = await load(reviewId, session, preferredRoot)
          return ok({ review: snapshotOf(located.record, located.stateRoot) })
        }

        /* ---------------- 表态（**只允许人从界面调用**） ---------------- */
        case 'crossfire/defect.setStatus': {
          const defectId = typeof body.defectId === 'string' ? body.defectId : ''
          if (defectId === '') return fail('payload must be { reviewId, defectId, status }')
          const status = body.status
          if (status !== 'pending' && status !== 'endorsed' && status !== 'rejected') {
            return fail('status must be "pending" | "endorsed" | "rejected"')
          }
          const rejectReason = typeof body.rejectReason === 'string' ? body.rejectReason : ''
          if (status === 'rejected' && rejectReason.trim() === '') {
            return fail('rejecting a defect requires a non-empty reject_reason (驳回必填理由)')
          }
          const located = await load(reviewId, session, preferredRoot)
          const changed = await setDefectStatus(located.stateRoot, reviewId, defectId, status, rejectReason)
          return ok({ changed, status })
        }
        /* ---------------- 专家角色定位（卡片上的专家列表可直接编辑） ----------------
         *
         * 用户诉求："我无法对专家列表的专家提示词进行修改"。角色定位进 persona 的
         * 「你的角色定位」段（见 redteam.ts），那一段带不可覆盖的声明 —— 用户能收窄
         * 专长，但改不掉"只读、不产出方案"这些硬约束。
         *
         * 它与设置页的阵容成员 `role` 是**两条来源**：阵容是"开审前的默认值"，这里
         * 是"对某一场评审的就地调整"。后者优先级更高，因为它写在记录里。
         */
        case 'crossfire/expert.setRole': {
          const expertKey = typeof body.expertKey === 'string' ? body.expertKey : ''
          if (expertKey === '') return fail('payload must be { reviewId, expertKey, role }')
          if (typeof body.role !== 'string') return fail('payload must carry a string `role`')
          const role = body.role.trim().slice(0, 2000)
          const located = await load(reviewId, session, preferredRoot)
          const outcome = await mutateRecord(located.stateRoot, reviewId, (current) => {
            const expert = current.experts.find((item) => item.key === expertKey)
            if (expert === undefined) return { found: false, changed: false }
            const before = expert.role ?? ''
            if (before === role) return { found: true, changed: false }
            // 空串 = 清除该定位（回到"只有维度"的原始 persona），而不是留一个空字段。
            if (role === '') delete expert.role
            else expert.role = role
            return { found: true, changed: true }
          })
          if (outcome === undefined) return fail(`no review "${reviewId}"`)
          if (!outcome.found) return fail(`no expert "${expertKey}" in this review`)
          return ok({ changed: outcome.changed })
        }
        case 'crossfire/recheck.setVerdict': {          const defectId = typeof body.defectId === 'string' ? body.defectId : ''
          const verdict = body.verdict
          if (defectId === '' || (verdict !== 'fixed' && verdict !== 'unfixed' && verdict !== 'partial')) {
            return fail('payload must be { reviewId, defectId, verdict: fixed | unfixed | partial }')
          }
          const located = await load(reviewId, session, preferredRoot)
          const note = typeof body.note === 'string' ? body.note : ''
          const changed = await setRecheckVerdict(located.stateRoot, reviewId, defectId, verdict, note)
          return ok({ changed })
        }

        /* ---------------- 立场（批 4 的 UI 用，端点先就位） ---------------- */
        case 'crossfire/stance.set': {
          const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : ''
          const located = await load(reviewId, session, preferredRoot)
          await mutateRecord(located.stateRoot, reviewId, (record) => {
            // 人改过之后 origin 变 edited：自动提炼**不再覆盖**它（批 4）。
            record.stance = {
              text,
              origin: 'edited',
              ...(record.stance.distilledAt === undefined ? {} : { distilledAt: record.stance.distilledAt }),
              updatedAt: Date.now(),
            }
            return undefined
          })
          return ok({ saved: true })
        }

        /* ---------------- 从界面直接开一场评审 ---------------- */
        case 'crossfire/review.open': {
          // 刻意**不转发** `body.workspace`：写入根只能由会话推导（见
          // `openReviewFromRpc` 的注释 —— 那是红队抓出的一条无人使用的逃逸通道）。
          return await openReviewFromRpc(ctx, runtime, {
            session,
            title: typeof body.title === 'string' ? body.title : '',
            content: typeof body.content === 'string' ? body.content : '',
            ...(body.dimensions === undefined ? {} : { dimensions: body.dimensions }),
            ...(body.intensity === undefined ? {} : { intensity: body.intensity }),
            ...(typeof body.stance === 'string' ? { stance: body.stance } : {}),
          })
        }

        /* ---------------- 导出（卡片上的下载按钮） ---------------- */
        case 'crossfire/review.export': {
          const located = await load(reviewId, session, preferredRoot)
          // 导出是收尾路径：预算熔断时也必须可用。
          assertBudget(located.record, { allowMuted: true })
          const markdown = renderReviewMarkdown(located.record, countDefects(located.record))
          const path = exportFile(located.stateRoot, reviewId)
          await writeTextAtomic(path, markdown)
          // 人读副本：`.txt` + UTF-8 BOM，双击直接进记事本（.md 常被别的程序抢走）。
          let textPath: string
          try {
            textPath = exportTextFile(located.stateRoot, reviewId)
            await writeTextAtomicWithBom(textPath, markdown)
          } catch {
            // 副本写不成不影响导出本身：`.md` 已经在盘上了。
            textPath = ''
          }
          return ok({ path, textPath, bytes: Buffer.byteLength(markdown, 'utf8'), markdown })
        }

        /* ---------------- O1 直推：推进状态机 ---------------- */
        case 'crossfire/review.advance': {
          const step = body.step
          if (step !== 'attack' && step !== 'collect' && step !== 'finish' && step !== 'recheck') {
            return fail('step must be "attack" | "collect" | "finish" | "recheck"')
          }
          const located = await load(reviewId, session, preferredRoot)
          return await advance(ctx, runtime, located, step, body, session)
        }

        default:
          return fail(`unknown endpoint "${endpoint}"`)
      }
    } catch (error: unknown) {
      // dispatch 绝不抛错：调用方拿到的永远是一个结构化的失败。
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`crossfire: rpc "${endpoint}" failed`, error)
      return fail(message)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 状态机直推
 * ------------------------------------------------------------------ */

/**
 * 卡片按钮推进状态机。
 *
 * 四个步骤各自的门禁与工具端**完全一致**（同一套 review/engine 函数），差别只在
 * "谁是被授权者"：工具用 `exec.agent`，这里用会话 id 换回来的 Agent。
 */
async function advance(
  ctx: Context,
  runtime: CrossfireRuntime,
  located: { stateRoot: string; record: CrossfireRecord },
  step: 'attack' | 'collect' | 'finish' | 'recheck',
  body: Record<string, unknown>,
  session: string,
): Promise<RpcResult> {
  const { stateRoot } = located
  const reviewId = located.record.reviewId
  const defaults = runtime.tools.getDefaults()

  if (step === 'attack') {
    const record = await readRecord(stateRoot, reviewId)
    if (record === undefined) return fail(`no review "${reviewId}"`)
    // 拉起子代理必须有父 Agent。身份已由 load() 严格校验过，这里直接用调用方声称
    // 的会话 —— **刻意不退回记录里的 owner**：那把凭据同时是权限，退回它等于给空
    // 会话开一条能真正拉起专家的越权通道（红队在验收流程里抓到的真实缺陷）。
    const agent = agentOfSession(ctx, session)
    if (agent === undefined) {
      return fail(
        'the session that owns this review is not live right now, so Crossfire cannot send in the red team '
        + 'from the card — ask in the conversation instead (crossfire_attack)',
        'session-offline',
      )
    }

    // 状态门禁与写入必须在**同一个临界区**里。锁外检查、锁内重读却不重校，会留下一个
    // TOCTOU 窗口：两个并发请求都能通过检查，各自拉起一批专家，第二批覆盖第一批的
    // experts，第一批就成了没人跟踪的孤儿。
    const planned = await withCrossfireLock(reviewLockKey(stateRoot, reviewId), async () => {
      const current = await readRecord(stateRoot, reviewId)
      if (current === undefined) throw new Error(`no review "${reviewId}"`)
      // 只允许 draft 与 attacking：
      // - draft 是卡片上那个攻击按钮**唯一可见**的状态；
      // - attacking 是复审轮（recheck 之后）的起点。
      // **刻意不含 settled**：对已定稿的评审直接重新攻击会绕过复审流程（不开新轮、
      // 不清缺陷），而卡片在 settled 上根本没有攻击按钮 —— 放行它只会造出一条谁也
      // 点不到、却能被直接调用的路径。
      if (current.status !== 'draft' && current.status !== 'attacking') {
        throw new Error(
          `review "${reviewId}" is "${current.status}" — cannot send in the red team now `
          + '(call crossfire_recheck to open a new pass on a settled review)',
        )
      }
      // 阵容来源：用户偏好里的**第一套阵容**（没有阵容时退回角色预设，按顺序平铺）。
      // 这一步修的是红队抓出的"预设只写不读"：此前 `rolePresets`/`squads` 在主流程
      // 零消费点，`ExpertPersonaInput` 没有 role 字段，`expert.provider`/`expert.model`
      // 也永远缺席 —— 设置页因此是个存了不用的仓库。
      const prefs = runtime.prefs.get()
      const roster = rosterFrom({
        squads: prefs.squads.map((squad) => ({
          id: squad.id,
          members: squad.members.map((member) => ({
            key: member.key,
            ...(member.role === undefined ? {} : { role: member.role }),
            ...(member.provider === undefined ? {} : { provider: member.provider }),
            ...(member.model === undefined ? {} : { model: member.model }),
          })),
        })),
        rolePresets: prefs.rolePresets.map((preset) => ({
          key: preset.name,
          ...(preset.role === undefined ? {} : { role: preset.role }),
          ...(preset.provider === undefined ? {} : { provider: preset.provider }),
          ...(preset.model === undefined ? {} : { model: preset.model }),
        })),
      })
      const experts = planExperts(current, runtime.tools.maxExperts, roster)
      const isRecheck = current.reviewPass > 1 && current.history.length > 0
      if (isRecheck && current.defects.length === 0) current.defects = buildRecheckItems(current)
      current.experts = experts
      current.status = 'attacking'
      await writeRecord(stateRoot, current)
      return { record: current, experts }
    })

    const failures: string[] = []
    for (const expert of planned.experts) {
      const controller = new AbortController()
      try {
        const childId = await spawnExpert(
          ctx,
          {
            provider: runtime.tools.memberProvider,
            ...(runtime.tools.memberMaxDepth === undefined ? {} : { maxDepth: runtime.tools.memberMaxDepth }),
            // 专家继承主持人时的生效路由：写回记录后卡片才能把"继承"画成真实品牌块
            // （否则头像永远是中性灰 `?`，这条是用户反馈的缺陷）。
            ...(runtime.tools.defaultProvider === undefined ? {} : { defaultProvider: runtime.tools.defaultProvider }),
            ...(runtime.tools.defaultModel === undefined ? {} : { defaultModel: runtime.tools.defaultModel }),
          },
          planned.record,
          expert,
          agent,
          controller.signal,
          { maxTokens: defaults.expertMaxTokens, maxOpinions: defaults.expertMaxOpinions },
        )
        expert.childId = childId
        expert.status = 'running'
        registerExpertChild(childId, { stateRoot, reviewId })
      } catch (error: unknown) {
        expert.status = 'failed'
        expert.note = error instanceof Error ? error.message : String(error)
        failures.push(`${expert.key}: ${expert.note}`)
      }
    }
    await mutateRecord(stateRoot, reviewId, (current) => {
      current.experts = planned.experts
      return undefined
    })
    return ok({
      spawned: planned.experts.filter((expert) => expert.status === 'running').length,
      failed: failures.length,
      failures,
    })
  }

  if (step === 'collect') {
    const record = await readRecord(stateRoot, reviewId)
    if (record === undefined) return fail(`no review "${reviewId}"`)
    if (record.status !== 'attacking' && record.status !== 'judging') {
      return fail(`review "${reviewId}" is "${record.status}" — cannot collect now`)
    }
    const transcript = await readTranscriptReport(stateRoot, reviewId)
    const llm = ctx.get('llm') as SplitLlmLike | undefined
    const outcome = await collectDefects({
      record,
      transcript: transcript.items,
      malformed: transcript.malformed,
      llm,
      // 拆分阶段的有界并发上限住在 `reviewSplit` 里（engine 单点读取），
      // 因此这里不必单独传参 —— 工具侧读同一份配置，两边行为一致。
      splitConfig: runtime.tools.reviewSplit,
    })
    await mutateRecord(stateRoot, reviewId, (current) => {
      applyCollected(current, outcome.added)
      current.status = 'judging'
      return undefined
    })
    return ok({
      collected: outcome.added.length,
      droppedDuplicates: outcome.droppedDuplicates,
      skippedNoise: outcome.skippedNoise,
      splitAttempts: outcome.splitAttempts,
      recheckRound: record.reviewPass > 1 && record.history.length > 0,
    })
  }

  if (step === 'finish') {
    const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
    const record = await readRecord(stateRoot, reviewId)
    if (record === undefined) return fail(`no review "${reviewId}"`)
    if (record.status !== 'judging' && record.status !== 'attacking' && record.status !== 'settled') {
      return fail(`review "${reviewId}" is "${record.status}" — cannot settle now`)
    }
    const result = await mutateRecord(stateRoot, reviewId, (current) => {
      current.history = [...current.history, {
        pass: current.reviewPass,
        subject: current.subject.content,
        stanceText: current.stance.text,
        dimensions: [...current.dimensions],
        intensity: current.intensity,
        defects: current.defects.map((defect) => ({ ...defect })),
        finishedAt: Date.now(),
        ...(summary === '' ? {} : { revisedSummary: summary }),
      }]
      current.status = 'settled'
      current.settledAt = Date.now()
      return countDefects(current)
    })
    return ok({ settled: true, counts: result ?? countDefects(record) })
  }

  // step === 'recheck'
  const record = await readRecord(stateRoot, reviewId)
  if (record === undefined) return fail(`no review "${reviewId}"`)
  if (record.status !== 'settled') return fail(`review "${reviewId}" is "${record.status}" — only a settled review can be re-checked`)
  const approved = body.approved === true
  const nextPass = record.reviewPass + 1
  if (nextPass > record.maxReviewPass && !approved) {
    return fail(
      `re-review cap reached (pass ${nextPass} > max ${record.maxReviewPass}) — the user must approve continuing`,
      'cap-reached',
    )
  }
  const result = await mutateRecord(stateRoot, reviewId, (current) => {
    const items = buildRecheckItems(current)
    current.reviewPass = beginPass(current)
    if (approved) current.maxReviewPass = Math.max(current.maxReviewPass, current.reviewPass)
    current.defects = items
    current.experts = []
    current.status = 'attacking'
    current.settledAt = undefined
    return { pass: current.reviewPass, items: items.length }
  })
  return ok({ reviewPass: result?.pass ?? nextPass, recheckItems: result?.items ?? 0 })
}

/* ------------------------------------------------------------------ *
 * 供批 4 复用：新建评审（RPC 侧）
 * ------------------------------------------------------------------ */

/**
 * 从界面直接开一场评审。
 *
 * 与 `crossfire_open` 工具同源，区别只是工作区来自会话 id 而不是 `exec.agent`。
 */
export async function openReviewFromRpc(
  ctx: Context,
  runtime: CrossfireRuntime,
  input: {
    session: string
    title: string
    content: string
    dimensions?: unknown
    intensity?: unknown
    stance?: string
  },
): Promise<RpcResult> {
  // 新建同样必须声称身份：否则会产出一场 `ownerSessionId` 为空的"无主评审"，
  // 而按归属规则，无主评审对任何会话都开放。
  if (input.session === '') {
    return fail('this request carried no session identity — reload the page so the card can send one', 'no-actor')
  }
  // 工作区**只由会话推导**，刻意不接受调用方传入（红队评审抓出的真实缺陷）：
  // 此前 dispatch 会把请求体里的 `workspace` 原样传进来，于是任何能 POST 到本机
  // 端口的调用者都能指定任意目录当写入根，在该目录下创建 `.crossfire/crossfire/x-*`。
  // 而卡片**从不**发送这个字段（`src/client` 全目录检索 `workspace` 只命中一句文案），
  // 所以这条通道没有任何正当用法 —— 没有调用者的写权限入口就是纯粹的逃逸面。
  //
  // 以后若真要做"对任意目录开审"，正确做法是**先把该目录注册成工作区**、再从这里
  // 经 `workspaceRegistryOf(ctx)` 查出来，而不是把路径本身交给调用方。
  const workspace = workspaceOfSession(ctx, input.session)
  if (workspace === undefined || workspace === '') {
    return fail('cannot determine the workspace for this session', 'no-workspace')
  }
  const defaults = runtime.tools.getDefaults()
  const content = input.content.trim()
  if (content === '') return fail('content must not be empty')
  const intensity: Intensity = input.intensity === 'quick' || input.intensity === 'deep' ? input.intensity : defaults.intensity
  const stateRoot = stateRootOf(workspace, runtime.tools.stateDir)
  const reviewId = newReviewId()
  const record = newRecord({
    reviewId,
    title: input.title.trim() || content.slice(0, 40),
    content,
    source: 'manual',
    dimensions: resolveDimensions(input.dimensions, defaults.customDimensions),
    intensity,
    stanceText: input.stance ?? '',
    maxRounds: defaults.maxRounds,
    maxTokens: defaults.maxTokens,
    ownerSessionId: input.session,
  })
  await withCrossfireLock(reviewLockKey(stateRoot, reviewId), async () => {
    await writeRecord(stateRoot, record)
  })
  return ok({ review: snapshotOf(record, stateRoot) })
}

/** 导出路径（批 4 的下载按钮用）。 */
export { exportFile }
