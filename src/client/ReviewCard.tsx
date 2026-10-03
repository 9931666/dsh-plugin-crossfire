/**
 * 针锋的 Chat 卡片（注册在 `tool.call.toolview`，key = `crossfire_open`）。
 *
 * ## 为什么卡片只认领一个工具名
 *
 * 宿主的 toolview 是按 **wire 工具名** dispatch 的，一次工具调用渲染一张。如果给
 * 七个工具都注册，同一场评审会沿轨迹长出七张一模一样的卡。所以只认领
 * `crossfire_open`（卡片第一次出现的位置），后续的 attack / collect / finish
 * 调用渲染成通用工具行；而卡片本身**每秒轮询快照**，内容自动跟着状态机走。
 *
 * ## 四态与直推（O1）
 *
 * `draft → attacking → judging → settled`，卡片按当前态只给出**下一步**那一个按钮，
 * 点击即经 RPC 直推 host 状态机 —— 不必等一个模型回合。这正是针锋比圆桌简洁的
 * 地方。
 *
 * ## 一条不可越界的规则
 *
 * 表态（认定 / 驳回 / 待定）只能在这里发生。卡片是唯一入口，因为**没有对应的
 * agent 工具**，也永远不该有。
 *
 * @module dsh-plugin-crossfire/client/ReviewCard
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  callRpc,
  fetchReviews,
  type AdvanceStep,
  type RpcCaller,
  type WireDefect,
  type WireExpert,
  type WirePrefs,
  type WireReview,
  type WireRecheckVerdict,
  type WireReviewStatus,
} from './wire.ts'
import { providerBrand, routeText } from './brand.ts'
import { defectTitle } from './defectTitle.ts'
import {
  applyPromptResult,
  togglePromptView,
  type PromptViewTable,
} from './promptView.ts'
import styles from './ReviewCard.module.css'

/**
 * 卡片收到的注入面（`tool.call.toolview` 不保证给 inject，因此组件对它容错）。
 *
 * `sessionId` **不是**我们注入的：它是宿主给每个 slot 组件的**标准注入** ——
 * 运行时 `Slots.listSubTree` 在 `tool.call.toolview` 的 `standardProps` 里列出的
 * 正是 `sessionId: SessionId`（已核实，不是推断）。圆桌的 tab 组件同样从 props 取它。
 * 组件用 `Partial<>` 同时接住两类来源。
 */
export interface CrossfireCardInjected {
  rpc: RpcCaller
  t: (key: string) => string
  /** 当前会话 id（宿主标准注入提供；拿不到时组件退化为空串）。 */
  sessionId?: string
}

/** 轮询间隔。与圆桌一致：本机 HTTP，1 秒足够跟手。 */
export function CrossfireCard(props: Partial<CrossfireCardInjected>): ReactElement {
  // 容错：`tool.call.toolview` 的 inject face 不是契约的一部分，拿不到就退回插件
  // 自己的 web 路由调用与"原样返回 key"的翻译器 —— 界面会显示英文 key，但绝不崩。
  const rpc: RpcCaller = typeof props.rpc === 'function' ? props.rpc : callRpc
  const t = typeof props.t === 'function' ? props.t : (key: string): string => key
  /**
   * 当前会话 id —— 来自宿主的**标准注入**（`tool.call.toolview` 的 `standardProps`
   * 里就列着 `sessionId: SessionId`，已用运行时槽查询核实，不是从别处推断的）。
   *
   * 它有两个不可省的用途，而且两个都是真实缺陷的修复：
   * 1. **快照过滤**：不传就会把别的会话的评审一并显示出来；
   * 2. **O1 直推**：`review.advance` 的 attack 分支要用会话 id 换回 live Agent 才能
   *    拉起子代理 —— 不传的话按钮必然拿到 `session-offline`。
   *
   * 拿不到时退化为空串；此时 host 侧**一律拒绝**写操作。刻意不再有"退回记录 owner"
   * 的兜底 —— 那把凭据同时是权限，退回它会开出一条能真正拉起专家的越权通道
   * （见 rpc.ts 的 judgeActor）。
   */
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''

  const [reviews, setReviews] = useState<WireReview[]>([])
  const [note, setNote] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  // 上一条反馈是失败还是成功。成功与失败共用同一个渲染位置（状态区，离刚点的按钮
  // 最近），但**颜色必须分开** —— 红队抓出的缺陷是"成功的导出被以错误色渲染"。
  const [noticeIsError, setNoticeIsError] = useState(true)
  const [busy, setBusy] = useState(false)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectDraft, setRejectDraft] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // 当前详细展开的那一场；null = 用列表第一场（快照按 startedAt 倒序，即最新那场）。
  const [activeReview, setActiveReview] = useState<string | null>(null)
  // 立场草稿：只有被用户改过的评审才进入"草稿模式"，之后轮询不再覆盖它 ——
  // 否则用户正在打字时会被服务端值冲掉。
  const [stanceDrafts, setStanceDrafts] = useState<Record<string, string>>({})
  // "立场已保存"是一次性回执：任何新的输入/操作都要把它清掉，否则它会一直挂在
  // 状态区里，看起来像上一次操作刚发生。
  const [stanceSaved, setStanceSaved] = useState(false)
  // 复核说明草稿（可选）：与立场草稿同一套"改过才进草稿模式"的做法。
  const [recheckNotes, setRecheckNotes] = useState<Record<string, string>>({})
  // 角色定位草稿：键是 `${reviewId}::${expertKey}`。
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({})
  // 正在编辑角色定位的专家（同一时刻只开一个编辑器，避免整页变成表单）。
  const [roleEditing, setRoleEditing] = useState<string | null>(null)
  // 立场全貌展开：用户反馈"无法展开看全貌，能滑动看见的区域特别小"。
  const [stanceExpanded, setStanceExpanded] = useState<Record<string, boolean>>({})
  // 超出复审上限时的就地确认位：host 要求显式批准，而卡片此前没有任何控件能表达它
  // （红队抓出的交互死路 —— 用户被留在一个永远点不通的按钮前）。
  const [recheckApproval, setRecheckApproval] = useState<string | null>(null)
  // 被用户关掉的解释性说明（键 → true）。它持久化在偏好里：用户说过"删了之后就不
  // 会再显示"，所以刷新页面也不能回来（恢复入口留在设置页）。
  const [dismissedHints, setDismissedHints] = useState<Record<string, boolean>>({})
  // 已展开的观点（键 = `${reviewId}::${defectId}`）。
  //
  // 用"展开集合"而不是"折叠集合"，是为了让**默认全部折叠**成为天然行为：集合为空即
  // 全部折叠（用户选择），新收集到的观点也自动折叠，不会因为状态里没有它而突然全展开。
  const [expandedDefects, setExpandedDefects] = useState<Record<string, boolean>>({})
  // 展开查看的专家原提示词（键 = `${reviewId}::${expertKey}`）。
  // 值是**显式三态**（loading / ready / error），不是"缓存里有没有"：那样一个变量
  // 同时表达"有缓存"与"已展开"两件事，导致"收起即丢缓存、再点变重新请求"，以及
  // 收起后迟到的响应把面板重新弹出来。状态转移在 promptView.ts 里，可脱离渲染单测。
  // host 用同一段 expertPersona() 现场生成，因此不会与真正下发给专家的那份产生偏差
  // （用户诉求："我无法看见它的原本提示词是什么"）。
  const [promptViews, setPromptViews] = useState<PromptViewTable>({})
  const [dismissBusy, setDismissBusy] = useState(false)
  const alive = useRef(true)

  /**
   * 记录一次反馈。
   *
   * 状态区里同时有"失败"与"已保存"两个位置，它们是互斥的：任何新反馈都先清掉上一条
   * 一次性回执，否则"立场已保存"会一直挂在那里，看起来像刚才又保存了一次。
   */
  const reportNotice = (message: string | undefined): void => {
    setNotice(message)
    setNoticeIsError(true)
    setStanceSaved(false)
  }

  /** 记录一次**成功**反馈：与失败共用位置，但以正常色渲染（不是红色错误）。 */
  const reportOk = (message: string | undefined): void => {
    setNotice(message)
    setNoticeIsError(false)
    setStanceSaved(false)
  }

  useEffect(() => {
    alive.current = true
    let inflight = false
    const tick = async (): Promise<void> => {
      if (inflight) return
      // 页面不可见时**不发请求**。这条卡被注册在两个槽位（`conversation.view` 标签页
      // 与 `tool.call.toolview` 轨迹卡片），两个实例各自持有一条定时器；而一次快照的
      // 代价是"把工作区下所有评审的 review.json 读一遍并整包重发"（无 ETag、无变更
      // 检测）。浏览器把后台标签页的 1 秒定时器按 1 次/分钟节流，但"页面可见却不在
      // 前台区域"（被挡住、被拖到另一个显示器）不在节流范围内 —— 那种情况下继续轮询
      // 纯属白付（红队评审抓出的性能缺陷）。
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      inflight = true
      const result = await fetchReviews(sessionId)
      inflight = false
      if (!alive.current) return
      setReviews(result.reviews)
      setNote(result.note)
    }
    void tick()
    const timer = window.setInterval(() => {
      void tick()
    }, POLL_MS)
    // 回到可见时立刻补一次：否则用户切回来会看到最长一个轮询间隔的陈旧状态
    // （那看起来像"按钮没生效"）。
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [sessionId])

  // 偏好侧读取：`dismissedHints` 是持久值，拉一次就够，不必进轮询（轮询每秒一次，
  // 每次都取偏好会白付一次 RPC）。挂载时读一次、隐藏动作后本地乐观更新。
  useEffect(() => {
    void (async () => {
      const prefs = await rpc<{ prefs: WirePrefs }>('crossfire/prefs.get', {})
      if (!alive.current) return
      if (prefs.ok && prefs.value?.prefs !== undefined) setDismissedHints(prefs.value.prefs.dismissedHints ?? {})
    })()
  }, [rpc])

  /**
   * 关掉一段解释性说明。
   *
   * 写回偏好（而不是只改本地状态），因为用户要的是"删了之后就不会再显示"——刷新页面
   * 也不该回来。写回时把本地已知的键与当前偏好**并集**：否则会覆盖掉设置页那边的恢复
   * 操作（两端各持一份快照，后写者不该把对方的选择抹掉）。
   */
  const dismissHint = async (key: string): Promise<void> => {
    setDismissedHints((previous) => ({ ...previous, [key]: true }))
    setDismissBusy(true)
    const current = await rpc<{ prefs: WirePrefs }>('crossfire/prefs.get', {})
    if (!alive.current) return
    const merged = { ...(current.ok ? current.value.prefs.dismissedHints ?? {} : {}), [key]: true }
    const saved = await rpc<{ prefs: WirePrefs }>('crossfire/prefs.set', { session: sessionId, patch: { dismissedHints: merged } })
    if (!alive.current) return
    setDismissBusy(false)
    if (!saved.ok) {
      // 存不上就把界面回滚 —— 否则用户以为隐藏成功了，下一条消息里它又回来。
      setDismissedHints((previous) => {
        const next = { ...previous }
        delete next[key]
        return next
      })
      reportNotice(`${t('actionFailed')}：${saved.error.message}`)
    }
  }

  /** 三态表态（**只有人能触发**）。 */
  const setStatus = async (
    review: WireReview,
    defect: WireDefect,
    status: WireDefect['status'],
    reason?: string,
  ): Promise<void> => {
    setBusy(true)
    const result = await rpc<{ changed: boolean }>('crossfire/defect.setStatus', {
      reviewId: review.reviewId,
      stateRoot: review.stateRoot,
      // 会话 id 必须随每次 RPC 一起送进 host：它既是归属校验的依据，也是
      // attack 分支换回 live Agent 的唯一凭据。
      session: sessionId,
      defectId: defect.id,
      status,
      rejectReason: reason ?? '',
    })
    if (!alive.current) return
    setBusy(false)
    if (!result.ok) {
      reportNotice(`${t('actionFailed')}：${result.error.message}`)
      return
    }
    reportNotice(undefined)
    // 乐观更新；下一轮轮询会把它纠正成服务端真相。
    setReviews((previous) => previous.map((item) => (item.reviewId !== review.reviewId ? item : {
      ...item,
      defects: item.defects.map((candidate) => (candidate.id !== defect.id ? candidate : {
        ...candidate,
        status,
        ...(status === 'rejected' ? { rejectReason: reason ?? '' } : {}),
      })),
    })))
  }

  /**
   * 复审核对结论（只在复审轮出现）。
   *
   * 复审轮的唯一任务是核对**上一轮已认定**的缺陷修没修，所以这里的表态维度不是
   * 认定/驳回，而是 已修复 / 未修复 / 部分修复 —— 换一个维度问同一个问题。
   */
  const setVerdict = async (
    review: WireReview,
    defect: WireDefect,
    verdict: WireRecheckVerdict,
    note = '',
  ): Promise<void> => {
    setBusy(true)
    const result = await rpc<{ changed: boolean }>('crossfire/recheck.setVerdict', {
      reviewId: review.reviewId,
      stateRoot: review.stateRoot,
      // 会话 id 必须随每次 RPC 一起送进 host：它既是归属校验的依据，也是
      // attack 分支换回 live Agent 的唯一凭据。
      session: sessionId,
      defectId: defect.id,
      verdict,
      note,
    })
    if (!alive.current) return
    setBusy(false)
    if (!result.ok) {
      reportNotice(`${t('actionFailed')}：${result.error.message}`)
      return
    }
    reportNotice(undefined)
    setReviews((previous) => previous.map((item) => (item.reviewId !== review.reviewId ? item : {
      ...item,
      defects: item.defects.map((candidate) => (candidate.id !== defect.id ? candidate : {
        ...candidate,
        recheck: {
          pass: candidate.recheck?.pass ?? 1,
          verdict,
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        },
      })),
    })))
  }

  /** 推进状态机（O1 直推）。 */
  const advance = async (review: WireReview, step: AdvanceStep, approved = false): Promise<void> => {
    setBusy(true)
    const result = await rpc<Record<string, unknown>>('crossfire/review.advance', {
      reviewId: review.reviewId,
      stateRoot: review.stateRoot,
      // 会话 id 必须随每次 RPC 一起送进 host：它既是归属校验的依据，也是
      // attack 分支换回 live Agent 的唯一凭据。
      session: sessionId,
      step,
      approved,
    })
    if (!alive.current) return
    setBusy(false)
    if (!result.ok) {
      reportNotice(`${t('actionFailed')}：${result.error.message}`)
      return
    }
    reportNotice(undefined)
    // 乐观推进状态。卡片状态来自轮询快照，少了这一步，点完按钮要等一个轮询间隔才
    // 有反馈 —— 看起来像按钮没生效（红队在验收流程里指出过）。失败路径在上面已经
    // return，所以这里不会留下假状态；下一轮快照会把它纠正成服务端真相。
    const nextStatus: WireReviewStatus | undefined = step === 'attack' || step === 'recheck'
      ? 'attacking'
      : step === 'collect'
        ? 'judging'
        : step === 'finish'
          ? 'settled'
          : undefined
    if (nextStatus !== undefined) {
      setReviews((previous) => previous.map((item) => (item.reviewId !== review.reviewId
        ? item
        : { ...item, status: nextStatus })))
    }
  }

  /** 保存立场。人改过之后 host 会把 origin 记为 edited，自动提炼不再覆盖它。 */
  const saveStance = async (review: WireReview, text: string): Promise<void> => {
    setBusy(true)
    const result = await rpc<{ saved: boolean }>('crossfire/stance.set', {
      reviewId: review.reviewId,
      stateRoot: review.stateRoot,
      // 会话 id 必须随每次 RPC 一起送进 host：它既是归属校验的依据，也是
      // attack 分支换回 live Agent 的唯一凭据。
      session: sessionId,
      text,
    })
    if (!alive.current) return
    setBusy(false)
    if (!result.ok) {
      reportNotice(`${t('actionFailed')}：${result.error.message}`)
      return
    }
    // 立场保存**成功**的反馈不走 notice（那是错误通道）：它由状态区里的一次性
    // 回执行表达，位置就在刚点的动作附近。
    reportNotice(undefined)
    setStanceSaved(true)
    // 保存成功后退出草稿模式，回到服务端真相。
    setStanceDrafts((previous) => {
      const next = { ...previous }
      delete next[review.reviewId]
      return next
    })
  }

  /**
   * 保存一位专家的角色定位。
   *
   * 它进 persona 的「你的角色定位」段 —— 用户诉求是"我无法对专家列表的专家提示词进行
   * 修改"。两条边界写在这里：**正在攻击中的专家不受影响**（它的 persona 在拉起那一刻
   * 就固定了），改动对下一轮生效；空串表示清除该定位。
   */
  const saveExpertRole = async (review: WireReview, expert: WireExpert, role: string): Promise<void> => {
    setBusy(true)
    const result = await rpc<{ changed: boolean }>('crossfire/expert.setRole', {
      reviewId: review.reviewId,
      stateRoot: review.stateRoot,
      session: sessionId,
      expertKey: expert.key,
      role,
    })
    if (!alive.current) return
    setBusy(false)
    if (!result.ok) {
      reportNotice(`${t('actionFailed')}：${result.error.message}`)
      return
    }
    reportNotice(undefined)
    setRoleEditing(null)
    // 乐观更新：下一轮快照会纠正成服务端真相。
    setReviews((previous) => previous.map((item) => (item.reviewId !== review.reviewId ? item : {
      ...item,
      experts: item.experts.map((candidate) => {
        if (candidate.key !== expert.key) return candidate
        const next = { ...candidate }
        if (role === '') delete next.role
        else next.role = role
        return next
      }),
    })))
  }

  /** 导出为 Markdown 并触发下载（盘上同时落 `export.md` 与带 BOM 的 `export.txt`）。 */
  const exportReview = async (review: WireReview): Promise<void> => {
    setBusy(true)
    const result = await rpc<{ path: string; textPath?: string; markdown: string }>('crossfire/review.export', {
      reviewId: review.reviewId,
      stateRoot: review.stateRoot,
      // 会话 id 必须随每次 RPC 一起送进 host：它既是归属校验的依据，也是
      // attack 分支换回 live Agent 的唯一凭据。
      session: sessionId,
    })
    if (!alive.current) return
    setBusy(false)
    if (!result.ok) {
      reportNotice(`${t('exportFailed')}：${result.error.message}`)
      return
    }
    // 导出成功是"成功"，不该用错误通道渲染成红色（红队抓出的缺陷：成功与失败共用
    // 同一个 notice 位置与同一套错误色）。位置不变（状态区、离 footer 的导出按钮
    // 最近），只把颜色语义改对。
    //
    // 提示里明确列出**两份产物**：`.md` 给渲染器，`.txt`（UTF-8 带 BOM）给记事本
    // —— 用户反馈的正是"导出来的产物我无法用记事本查看"。
    reportOk(result.value.textPath === undefined || result.value.textPath === ''
      ? `${t('exportDone')}：${result.value.path}`
      : `${t('exportDone')}：${result.value.path} ＋ ${result.value.textPath}`)
    try {
      // 下载 `.txt` 那一份：它带 BOM、扩展名是 .txt，双击就能进记事本。
      const blob = new Blob([result.value.markdown], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${review.reviewId}.txt`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      // 下载失败不影响结论：文件已经落在评审目录里。
    }
  }

/**
 * 轮询间隔（毫秒）。
 *
 * 从 1s 放宽到 2s：这张卡注册在**两个**槽位（`conversation.view` 标签页与
 * `tool.call.toolview` 轨迹卡片），两个实例各持一条定时器；而一次快照要把工作区下
 * 所有评审的 `review.json` 读一遍并整包重发（无 ETag、无变更检测）。1s 意味着每秒
 * 2+ 次全量读盘 + 全量传输，而其中绝大多数字节从未变化。
 *
 * 放宽间隔**不会让界面变迟钝**：所有写操作（表态 / 立场 / 角色定位 / 推进状态机）
 * 都走本地乐观更新，点完立刻见效，轮询只负责把它纠正成服务端真相（含别的窗口的
 * 改动）—— 那种场景下 2s 与 1s 的差别用户感知不到。
 *
 * 彻底的解法是给快照加变更检测（ETag / If-None-Match 或版本号短路），那需要改传输
 * 协议，留给下一轮；这条只是把白付的代价减半。
 */
const POLL_MS = 2000

const STATUS_LABEL_KEY: Readonly<Record<WireReviewStatus, string>> = {
  draft: 'statusDraft',
  attacking: 'statusAttacking',
  judging: 'statusJudging',
  settled: 'statusSettled',
}

const EXPERT_STATUS_KEY: Readonly<Record<string, string>> = {
  pending: 'expertPending',
  running: 'expertRunning',
  done: 'expertDone',
  failed: 'expertFailed',
  silent: 'expertSilent',
}

const VERDICT_KEY: Readonly<Record<string, string>> = {
  fixed: 'verdictFixed',
  unfixed: 'verdictUnfixed',
  partial: 'verdictPartial',
}

/**
 * 每一态的一句话说明：**现在是什么局面、为什么必须由人来做下一步**。
 *
 * 状态区里"态名 + 唯一主行动"已经表达了"能做/该做什么"，这一行补的是"为什么" ——
 * 卡片上信息很多，缺的是分层，不是内容。
 */
const STATUS_HINT_KEY: Readonly<Record<WireReviewStatus, string>> = {
  draft: 'statusHintDraft',
  attacking: 'statusHintAttacking',
  judging: 'statusHintJudging',
  settled: 'statusHintSettled',
}

/** 复审核对结论的三个选项（顺序即界面顺序）。 */
const RECHECK_VERDICTS = ['fixed', 'unfixed', 'partial'] as const

/**
 * 从缺陷的 `expertKey` 找回它的作者专家。
 *
 * 缺陷只带 key（数据层就是这么存的），而品牌头像与模型路由在专家身上。找不到时返回
 * `undefined` —— 那条缺陷仍然会显示（用中性块），因为**内容比标识重要**：一条找不到
 * 作者的缺陷不该从裁决列表里消失。
 */
function authorOf(expertKey: string, experts: readonly WireExpert[]): WireExpert | undefined {
  return experts.find((expert) => expert.key === expertKey)
}

/** 专家模型路由的可读串；拿不到时退化为给定的兜底文案（通常是"继承主持人"）。 */
function routeOf(expert: WireExpert | undefined, fallback: string): string {
  if (expert === undefined || expert.provider === undefined) return fallback
  return routeText(expert.provider, expert.model)
}

/**
 * 缺陷排序：**打穿立场的优先**，其次按维度分组，组内保持原始顺序。
 *
 * 这是 §5.3 方向 4 的落地："按维度分组、按是否打穿立场排序，把最需要裁决的排在最前"。
 * 用 `map + index` 稳定排序，保证同一组内的相对次序与收集时一致（否则每轮表态后
 * 卡片会重排，用户会找不到刚看过的那条）。
 */
function orderDefects(defects: readonly WireDefect[]): WireDefect[] {
  return defects
    .map((defect, index) => ({ defect, index }))
    .sort((left, right) => {
      const strikeDelta = Number(right.defect.strikesStance === true) - Number(left.defect.strikesStance === true)
      if (strikeDelta !== 0) return strikeDelta
      const dimensionDelta = left.defect.dimension.localeCompare(right.defect.dimension, 'zh')
      if (dimensionDelta !== 0) return dimensionDelta
      return left.index - right.index
    })
    .map((entry) => entry.defect)
}

/** 折叠状态的键：`${reviewId}::${defectId}`。 */
function defectFoldKey(reviewId: string, defectId: string): string {
  return `${reviewId}::${defectId}`
}

  if (reviews.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <span className={styles.title}>{t('cardTitle')}</span>
        </div>
        <div className={styles.empty}>
          <div>{t('noReviews')}</div>
          <div className={styles.muted}>{t('cardHint')}</div>
          {note === undefined ? null : <div className={styles.muted}>{note}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      {/* 会话身份缺失时**整卡顶部**就要说清楚：host 会（刻意地）拒绝所有写操作，
          因为会话 id 在那里同时是凭据与权限。让用户白点一次再报错是更差的体验。
          它在状态区之外 —— 这不是某一场评审的状态，而是整张卡的前提。 */}
      {sessionId === '' ? <div className={styles.notice}>{t('noSessionHint')}</div> : null}
      {reviews.map((review) => {
        // 一次只详细展开一场：卡片列出的是本会话**全部**评审，全展开就是一堵墙
        // （验收期间攒到 5 场、12 条缺陷），而真正要操作的通常只有最上面那场。
        const activeReviewId = activeReview ?? reviews[0]?.reviewId
        if (review.reviewId !== activeReviewId) {
          return (
            <button
              type="button"
              key={review.reviewId}
              className={styles.collapsed}
              onClick={() => {
                setActiveReview(review.reviewId)
                // 切走再切回来不该看到上一场的"已保存"回执。
                setStanceSaved(false)
                reportNotice(undefined)
              }}
            >
              <span className={`${styles.badge} ${styles[`badge_${review.status}`] ?? ''}`}>
                {t(STATUS_LABEL_KEY[review.status])}
              </span>
              <span className={styles.subjectTitle}>{review.subjectTitle}</span>
              <span className={styles.muted}>
                {review.counts.total === 0
                  ? t('defectEmpty')
                  : t('expertDefects').replace('{n}', String(review.counts.total))}
              </span>
              <span className={styles.muted}>▸</span>
            </button>
          )
        }
        const isExpanded = expanded[review.reviewId] === true
        // 攻击中的进度：**已经提交过发言**的专家数。用它而不是 `defectCount`（收集前
        // 恒为 0），也不是 `status === 'done'`（专家结束不等于提交过内容）。
        const reportedCount = review.experts.filter(
          (expert) => (expert.reportCount ?? 0) > 0 || expert.defectCount > 0,
        ).length
        // 下一轮复审是否会超出本场的轮次上限。超出时 host 要求显式批准，所以界面上必须
        // 先问一次再提交 —— 判定与 host 侧一致（`nextPass > maxReviewPass`）。
        const atRecheckCap = review.reviewPass + 1 > review.maxReviewPass
        const body = isExpanded || review.subjectContent.length <= 400
          ? review.subjectContent
          : `${review.subjectContent.slice(0, 400)}…`
        return (
          <div className={styles.card} key={review.reviewId}>
            {/* ---------------- 抬头 ---------------- */}
            <div className={styles.header}>
              <span className={styles.title}>{t('cardTitle')}</span>
              <span className={styles.subjectTitle}>{review.subjectTitle}</span>
              <span className={`${styles.badge} ${styles[`badge_${review.status}`] ?? ''}`}>
                {t(STATUS_LABEL_KEY[review.status])}
              </span>
              <span className={styles.muted}>
                {t('passBadge').replace('{pass}', String(review.reviewPass)).replace('{max}', String(review.maxReviewPass))}
              </span>
            </div>

            {/* ---------------- 状态区：现在是哪一态 + 下一步做什么 ----------------
                用户反馈"信息太多……没有凸显重点、反馈没有分类"。卡片各段落现在保持
                原来的低对比与层级，只有这一区被提到卡片顶部并成为**唯一**的强对比
                区域：态名 + 一句话局面说明 + 一个主色实心按钮。原来的"下一步"按钮
                沉在整张卡最底部 —— 缺陷多的时候要先滚过十几张子卡才看得到。 */}
            <div className={styles.statusStrip} aria-label={t('statusStrip')}>
              <div className={styles.statusStripInfo}>
                <div className={styles.statusStripHead}>
                  <span className={styles.statusState}>{t(STATUS_LABEL_KEY[review.status])}</span>
                  {/* 轮次刻意不在这里重复：抬头行已经有一份（`passBadge`）。状态区
                      只放**这一态独有的**数字，重复展示等于又把信息摊平了。 */}
                  {review.status === 'judging' ? (
                    // 待裁决时最该看到的不是总数，而是"还剩几条等我表态"。
                    <span className={styles.muted}>
                      {`${t('countPending')} ${review.counts.pending} / ${t('impactTitle')} ${review.counts.total}`}
                    </span>
                  ) : null}
                  {review.status === 'attacking' ? (
                    // 攻击中唯一有意义的进度：几位专家已经提交过发言。没有它，用户
                    // 只能看到一个静止的"攻击中"，不知道能不能点收集。
                    <span className={styles.muted}>
                      {t('expertSubmitted').replace('{done}', String(reportedCount)).replace('{total}', String(review.experts.length))}
                    </span>
                  ) : null}
                </div>
                <div className={styles.statusHint}>{t(STATUS_HINT_KEY[review.status])}</div>
                {/* 写操作的反馈就地给出：出错时它离用户刚点的那个按钮只有几像素，
                    不必回头去找卡片顶部那条 notice。**成功与失败共用位置但颜色分开**
                    —— 此前成功的导出被以错误色渲染（红队抓出的缺陷）。 */}
                {notice === undefined
                  ? null
                  : <div className={noticeIsError ? styles.statusError : styles.statusOk}>{notice}</div>}
                {stanceSaved ? <div className={styles.statusOk}>{t('stanceSaved')}</div> : null}
              </div>
              <div className={styles.statusStripAction}>
                <span className={styles.statusNextLabel}>{t('statusNext')}</span>
                {/* attacking 时主行动旁边多一句"正在推进"：收集按钮在专家提交前
                    点了也只会收集到空集，用户需要知道该等。 */}
                {review.status === 'attacking' ? <span className={styles.muted}>{t('busyWorking')}</span> : null}
                {review.status === 'draft' ? (
                  <button type="button" disabled={busy} className={styles.cta} onClick={() => { void advance(review, 'attack') }}>
                    {t('btnAttack')}
                  </button>
                ) : null}
                {review.status === 'attacking' ? (
                  <button type="button" disabled={busy} className={styles.cta} onClick={() => { void advance(review, 'collect') }}>
                    {t('btnCollect')}
                  </button>
                ) : null}
                {review.status === 'judging' ? (
                  <button type="button" disabled={busy} className={styles.cta} onClick={() => { void advance(review, 'finish') }}>
                    {t('btnFinish')}
                  </button>
                ) : null}
                {review.status === 'settled' ? (
                  // 超出复审上限的轮次需要**用户显式批准**（host 侧的
                  // `user_approved_extra_pass`）。此前卡片上没有任何控件能表达这个批准：
                  // 主行动必然失败，而它给出的指引（"需要用户批准"）在卡片上做不到 ——
                  // 用户被留在一个永远点不通的按钮前（红队抓出的交互死路）。
                  // 现在超出上限时先就地问一次，确认后才带 approved 提交。
                  atRecheckCap ? (
                    recheckApproval === review.reviewId ? (
                      <>
                        <span className={styles.muted}>{t('recheckApprovalAsk')}</span>
                        <button
                          type="button"
                          disabled={busy}
                          className={styles.cta}
                          onClick={() => {
                            setRecheckApproval(null)
                            void advance(review, 'recheck', true)
                          }}
                        >
                          {t('recheckApprovalYes')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className={styles.foldButton}
                          onClick={() => setRecheckApproval(null)}
                        >
                          {t('recheckApprovalNo')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        className={styles.cta}
                        onClick={() => setRecheckApproval(review.reviewId)}
                      >
                        {t('btnRecheck')}
                      </button>
                    )
                  ) : (
                    <button type="button" disabled={busy} className={styles.cta} onClick={() => { void advance(review, 'recheck') }}>
                      {t('btnRecheck')}
                    </button>
                  )
                ) : null}
              </div>
            </div>

            {/* ---------------- 待验证对象 ---------------- */}
            <div className={`${styles.section} ${styles.sectionDivider}`}>
              <div className={styles.sectionHeadRow}>
                <span className={styles.sectionTitleStrong}>{t('subjectLabel')}</span>
              </div>
              <div className={styles.subject}>{body}</div>
              {review.subjectContent.length > 400 ? (
                // 展开/折叠做成**按钮**：纯文字链接会被当成正文内容，用户明确要求按钮化。
                <button
                  type="button"
                  className={styles.foldButton}
                  onClick={() => setExpanded((previous) => ({ ...previous, [review.reviewId]: !isExpanded }))}
                >
                  {isExpanded ? t('collapseSection') : t('expandSection')}
                </button>
              ) : null}
            </div>

            {/* ---------------- 立场（可编辑：这是"锋"的靶子） ---------------- */}
            <div className={`${styles.section} ${styles.sectionDivider}`}>
              <div className={styles.sectionHeadRow}>
                <span className={styles.sectionTitleStrong}>{t('stanceSectionTitle')}</span>
                <span className={styles.sectionCount}>{review.stanceOrigin === 'edited' ? t('stanceSaved') : ''}</span>
                <span className={styles.spacer} />
                {/* 立场原本只给 3 行输入框，长立场看不见全貌（用户反馈"能滑动能看见的
                    区域特别小"）。这里给一个显式的全貌切换：只读、可滚动、不占输入位。 */}
                {review.stanceText.trim() === '' ? null : (
                  <button
                    type="button"
                    className={styles.foldButton}
                    onClick={() => setStanceExpanded((previous) => ({ ...previous, [review.reviewId]: previous[review.reviewId] !== true }))}
                  >
                    {stanceExpanded[review.reviewId] === true ? t('stanceCollapse') : t('stanceExpand')}
                  </button>
                )}
              </div>
              {stanceExpanded[review.reviewId] === true ? (
                <div className={styles.stanceFull}>{review.stanceText}</div>
              ) : null}
              <textarea
                className={styles.stanceInput}
                rows={3}
                disabled={busy}
                value={stanceDrafts[review.reviewId] ?? review.stanceText}
                placeholder={t('stanceHint')}
                onChange={(event) => {
                  const value = event.target.value
                  setStanceDrafts((previous) => ({ ...previous, [review.reviewId]: value }))
                  // 又动过了：上一轮的"已保存"回执作废（此时的草稿尚未落库）。
                  setStanceSaved(false)
                }}
              />
              <div className={styles.actions}>
                {/* 保存按钮用主色实心：用户要求"保存立场按钮可以做得凸显一点"——
                    它此前与"取消/次要"同级，是浅描边幽灵按钮。 */}
                <button
                  type="button"
                  disabled={busy || (stanceDrafts[review.reviewId] ?? review.stanceText) === review.stanceText}
                  className={styles.cta}
                  onClick={() => {
                    void saveStance(review, stanceDrafts[review.reviewId] ?? review.stanceText)
                  }}
                >
                  {t('stanceSave')}
                </button>
                {review.stanceText.trim() === '' ? <span className={styles.muted}>{t('stanceEmpty')}</span> : null}
              </div>
              {dismissedHints.stanceHint === true ? null : (
                <div className={styles.explain}>
                  <span className={styles.explainText}>{t('stanceHint')}</span>
                  <button
                    type="button"
                    className={styles.explainClose}
                    disabled={dismissBusy}
                    title={t('explainDismiss')}
                    aria-label={t('explainDismiss')}
                    onClick={() => { void dismissHint('stanceHint') }}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>

            {/* ---------------- 攻击维度 ---------------- */}
            <div className={`${styles.section} ${styles.sectionDivider}`}>
              <div className={styles.sectionHeadRow}>
                <span className={styles.sectionTitleStrong}>{t('dimensionsLabel')}</span>
                <span className={styles.sectionCount}>{review.intensityLabel}</span>
              </div>
              <div className={styles.chips}>
                {review.dimensions.map((dimension) => (
                  <span className={styles.chip} key={dimension}>{dimension}</span>
                ))}
              </div>
            </div>

            {/* ---------------- 红队专家名单 ----------------
                用户诉求：① 每条观点要能看出是哪位专家提的 ② 要有专家列表
                ③ 能直接改专家的提示词。三者在这里一起解决：头像 + 名称 + 维度 +
                状态 + 就地可编辑的「角色定位」（它进 persona）。 */}
            {review.experts.length === 0 ? null : (
              <div className={`${styles.section} ${styles.sectionDivider}`}>
                <div className={styles.sectionHeadRow}>
                  <span className={styles.sectionTitleStrong}>{t('expertsTitle')}</span>
                  <span className={styles.sectionCount}>
                    {t('expertSubmitted').replace('{done}', String(reportedCount)).replace('{total}', String(review.experts.length))}
                  </span>
                </div>
                {dismissedHints.expertRosterHint === true ? null : (
                  <div className={styles.explain}>
                    <span className={styles.explainText}>{t('expertRosterHint')}</span>
                    <button
                      type="button"
                      className={styles.explainClose}
                      disabled={dismissBusy}
                      title={t('explainDismiss')}
                      aria-label={t('explainDismiss')}
                      onClick={() => { void dismissHint('expertRosterHint') }}
                    >
                      ×
                    </button>
                  </div>
                )}
                {review.experts.map((expert) => {
                  const roleKey = `${review.reviewId}::${expert.key}`
                  const brand = providerBrand(expert.provider)
                  const route = expert.provider === undefined ? t('modelInherit') : routeText(expert.provider, expert.model)
                  return (
                    <div className={styles.expertCard} key={expert.key}>
                      <div className={styles.expertHead}>
                        <span className={styles.brandBlock} style={{ background: brand.color }} title={route}>
                          {brand.abbr}
                        </span>
                        {/* 专家名是"这条观点是谁提的"的答案，因此用正文色加粗，而不是
                            此前那种与元数据同色的等宽小字。 */}
                        <span className={styles.expertNameStrong}>{expert.key}</span>
                        <span className={styles.chip}>{expert.dimension}</span>
                        <span className={styles.muted}>{t(EXPERT_STATUS_KEY[expert.status] ?? 'expertPending')}</span>
                        <span className={styles.muted}>
                          {expert.defectCount > 0
                            ? t('expertDefects').replace('{n}', String(expert.defectCount))
                            : expert.reportCount !== undefined && expert.reportCount > 0
                              ? t('expertReported').replace('{n}', String(expert.reportCount))
                              : t('expertNoOutput')}
                        </span>
                        <span className={styles.spacer} />
                        <button
                          type="button"
                          className={styles.foldButton}
                          disabled={busy || roleEditing === roleKey}
                          onClick={() => {
                            setRoleDrafts((previous) => ({ ...previous, [roleKey]: expert.role ?? '' }))
                            setRoleEditing(roleKey)
                          }}
                        >
                          {t('expertRoleEdit')}
                        </button>
                        {/* 查看专家原提示词：host 用同一段 expertPersona() 现场生成，
                            与真正下发给专家的那份一致（只读，不落盘）。 */}
                        <button
                          type="button"
                          className={styles.foldButton}
                          onClick={() => {
                            const viewKey = `${review.reviewId}::${expert.key}`
                            // 无条目 → 展开并拉一次；有条目（loading/ready/error）
                            // → 只收起。收起**绝不**再发请求，也不丢已拿到的结果。
                            let start = false
                            setPromptViews((previous) => {
                              const toggled = togglePromptView(previous, viewKey)
                              start = toggled.start
                              return toggled.table
                            })
                            if (!start) return
                            void (async () => {
                              const result = await rpc<{ persona: string }>('crossfire/expert.prompt', {
                                reviewId: review.reviewId,
                                stateRoot: review.stateRoot,
                                session: sessionId,
                                expertKey: expert.key,
                              })
                              // 卸载即丢弃；"等待期间收起"由 applyPromptResult 内的
                              // loading 检查负责（alive 只在卸载时变化，挡不住收起）。
                              if (!alive.current) return
                              setPromptViews((previous) =>
                                applyPromptResult(
                                  previous,
                                  viewKey,
                                  result.ok
                                    ? { ok: true, persona: result.value.persona }
                                    : { ok: false, message: result.error.message },
                                ),
                              )
                            })()
                          }}
                        >
                          {t('expertPromptView')}
                        </button>
                      </div>
                      {expert.role === undefined ? null : (
                        <div className={styles.muted}>{`${t('expertRoleLabel')}：${expert.role}`}</div>
                      )}
                      {/* 原提示词展开区：只读全文，复用 stanceFull 的可滚动样式（避免新增样式键）。 */}
                      {(() => {
                        const view = promptViews[`${review.reviewId}::${expert.key}`]
                        if (view === undefined) return null
                        if (view.status === 'error') return <div className={styles.statusError}>{view.message}</div>
                        if (view.status === 'loading') return <div className={styles.muted}>{t('loading')}</div>
                        return (
                          <div className={styles.section}>
                            <div className={styles.sectionTitle}>{t('expertPromptTitle')}</div>
                            <div className={styles.stanceFull}>{view.persona}</div>
                          </div>
                        )
                      })()}
                      {roleEditing === roleKey ? (
                        <div className={styles.roleEditor}>
                          <textarea
                            className={styles.roleInput}
                            rows={3}
                            autoFocus
                            value={roleDrafts[roleKey] ?? ''}
                            placeholder={t('expertRolePlaceholder')}
                            onChange={(event) => {
                              const value = event.target.value
                              setRoleDrafts((previous) => ({ ...previous, [roleKey]: value }))
                            }}
                          />
                          <div className={styles.actions}>
                            <button
                              type="button"
                              className={styles.btnPrimary}
                              disabled={busy}
                              onClick={() => { void saveExpertRole(review, expert, roleDrafts[roleKey] ?? '') }}
                            >
                              {t('presetSave')}
                            </button>
                            <button
                              type="button"
                              className={styles.btnGhost}
                              disabled={busy}
                              onClick={() => setRoleEditing(null)}
                            >
                              {t('presetCancel')}
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {expert.note === undefined ? null : <div className={styles.warn}>{expert.note}</div>}
                    </div>
                  )
                })}
              </div>
            )}

            {/* ---------------- 表态影响条 ---------------- */}
            <div className={styles.impactBar}>
              <span>{t('impactTitle')}</span>
              <span className={styles.countEndorsed}>{t('countEndorsed')} {review.counts.endorsed}</span>
              <span className={styles.countRejected}>{t('countRejected')} {review.counts.rejected}</span>
              <span className={styles.countPending}>{t('countPending')} {review.counts.pending}</span>
              {review.counts.strikes === 0 ? null : <span className={styles.countStrike}>{t('strikesStance')} {review.counts.strikes}</span>}
            </div>

            {/* ---------------- 待裁决缺陷 ---------------- */}
            <div className={styles.sectionDivider}>
              <div className={styles.sectionHeadRow}>
                <span className={styles.sectionTitleStrong}>{t('defectsTitle')}</span>
                <span className={styles.sectionCount}>
                  {review.defects.length === 0 ? '' : t('expertDefects').replace('{n}', String(review.defects.length))}
                </span>
              </div>
            </div>
            {review.defects.length === 0 ? (
              <div className={styles.muted}>{t('defectEmpty')}</div>
            ) : (
              orderDefects(review.defects).map((defect) => {
                // 默认折叠：只有点开过（或显式展开）的才显示细节。
                const foldKey = defectFoldKey(review.reviewId, defect.id)
                const isOpen = expandedDefects[foldKey] === true
                return (
                <div className={styles.defect} key={defect.id}>
                  <div className={styles.defectHead}>
                    <span className={styles.chip}>{defect.dimension}</span>
                    {defect.dimensionFallback === true ? <span className={styles.chipWarn}>{t('dimensionFallback')}</span> : null}
                    {defect.strikesStance === true ? <span className={styles.chipStrike}>{t('strikesStance')}</span> : null}
                    <span className={styles.spacer} />
                    {/* 用户诉求："我不能很好地看见观点是哪一个专家发表出来的" ——
                        每条观点抬头都带作者标识（品牌头像 + 专家名）。数据一直都在
                        （缺陷自带 expertKey），此前只是没有展示出来。 */}
                    <span className={styles.defectAuthor}>
                      <span
                        className={styles.brandBlock}
                        style={{ background: providerBrand(authorOf(defect.expertKey, review.experts)?.provider).color }}
                        title={routeOf(authorOf(defect.expertKey, review.experts), t('modelInherit'))}
                      >
                        {providerBrand(authorOf(defect.expertKey, review.experts)?.provider).abbr}
                      </span>
                      <span className={styles.expertNameStrong}>{defect.expertKey}</span>
                    </span>
                    {/* 折叠开关：用户要求"每条观点都可以折叠，折叠后只显示标题和对应专家"。
                        整行摘要都可点，点开才显示正文 / 证据 / 复核。 */}
                    <button
                      type="button"
                      className={styles.foldButton}
                      aria-expanded={isOpen}
                      onClick={() => setExpandedDefects((previous) => {
                        const next = { ...previous }
                        if (next[foldKey] === true) delete next[foldKey]
                        else next[foldKey] = true
                        return next
                      })}
                    >
                      {isOpen ? t('collapseSection') : t('expandSection')}
                    </button>
                  </div>

                  {/* 标题行：折叠时的唯一可见内容，也是展开时的抬头（用户诉求"最开头立一个标题"）。 */}
                  <button
                    type="button"
                    className={styles.defectTitle}
                    aria-expanded={isOpen}
                    onClick={() => setExpandedDefects((previous) => {
                      const next = { ...previous }
                      if (next[foldKey] === true) delete next[foldKey]
                      else next[foldKey] = true
                      return next
                    })}
                  >
                    {defectTitle(defect.content)}
                  </button>

                  {isOpen ? (
                    <>
                  {defect.quote === undefined ? null : <div className={styles.quote}>“{defect.quote}”</div>}
                  <div className={styles.defectContent}>{defect.content}</div>

                  {defect.evidence === undefined ? null : (
                    <div className={styles.evidence}>
                      <span className={styles.evidenceLabel}>
                        {defect.evidence.kind === 'repro' ? `[${t('evidenceRepro')}]` : `[${t('evidenceArgument')}]`}
                      </span>
                      {defect.evidence.text}
                    </div>
                  )}

                  {defect.recheck === undefined ? null : (
                    <div className={styles.recheckBox}>
                      <div className={styles.recheckHead}>
                        <span className={styles.evidenceLabel}>{t('recheckLabel')}</span>
                        {/* 核对的是"上一轮"的结论，用 # 轮次中性表达，不必新增文案键。 */}
                        <span className={styles.muted}>{`#${String(defect.recheck.pass)}`}</span>
                      </div>
                      <div className={styles.actions}>
                        {RECHECK_VERDICTS.map((verdict) => (
                          <button
                            key={verdict}
                            type="button"
                            disabled={busy}
                            /* 高亮**只**跟随人做过的判断。未判断时三个按钮都不高亮，
                               所以第一帧不会有一个被选中的"未修复"看起来像人的结论。 */
                            className={defect.recheck?.verdict === verdict ? styles.btnPrimaryOn : styles.btnGhost}
                            onClick={() => {
                              void setVerdict(review, defect, verdict, recheckNotes[defect.id] ?? '')
                            }}
                          >
                            {t(VERDICT_KEY[verdict] ?? 'verdictUnfixed')}
                          </button>
                        ))}
                        {defect.recheck?.verdict === undefined ? (
                          <span className={styles.muted}>{t('verdictUndecided')}</span>
                        ) : null}
                      </div>
                      <div className={styles.actions}>
                        <input
                          className={styles.rejectInput}
                          disabled={busy}
                          value={recheckNotes[defect.id] ?? defect.recheck?.note ?? ''}
                          placeholder={t('recheckNote')}
                          onChange={(event) => {
                            const value = event.target.value
                            setRecheckNotes((previous) => ({ ...previous, [defect.id]: value }))
                          }}
                        />
                        <button
                          type="button"
                          /* 备注**不能**顺手落一个结论：没有判断就禁用这个按钮。
                             此前它提交 `verdict ?? 'unfixed'`，等于把机器默认值当人的表态
                             （红队抓出的缺陷）。*/
                          disabled={busy || defect.recheck?.verdict === undefined
                            || (recheckNotes[defect.id] ?? defect.recheck?.note ?? '') === (defect.recheck?.note ?? '')}
                          title={defect.recheck?.verdict === undefined ? t('recheckNoteNeedsVerdict') : undefined}
                          className={styles.btnGhost}
                          onClick={() => {
                            const verdict = defect.recheck?.verdict
                            if (verdict === undefined) return
                            void setVerdict(
                              review,
                              defect,
                              verdict,
                              recheckNotes[defect.id] ?? defect.recheck?.note ?? '',
                            )
                          }}
                        >
                          {t('presetSave')}
                        </button>
                      </div>
                      {defect.recheck.note === undefined || defect.recheck.note === ''
                        ? null
                        : <div className={styles.muted}>{defect.recheck.note}</div>}
                    </div>
                  )}

                    </>
                  ) : null}

                  {defect.status === 'rejected' && defect.rejectReason !== undefined && defect.rejectReason !== '' ? (
                    <div className={styles.rejectReason}>{t('btnReject')}：{defect.rejectReason}</div>
                  ) : null}

                  {review.status === 'settled' ? null : (
                    <div className={styles.actions}>
                      {/* 用户要求：三个都做成按钮形状、各自颜色（认定绿 / 驳回红 / 待定灰），
                          点中之后整块填充该颜色、文字变白。未点中的是"该颜色描边 + 同色文字"。 */}
                      <button
                        type="button"
                        disabled={busy}
                        className={defect.status === 'endorsed' ? `${styles.verdictButton} ${styles.verdictEndorseOn}` : `${styles.verdictButton} ${styles.verdictEndorse}`}
                        onClick={() => {
                          void setStatus(review, defect, defect.status === 'endorsed' ? 'pending' : 'endorsed')
                        }}
                      >
                        {t('btnEndorse')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={defect.status === 'rejected' ? `${styles.verdictButton} ${styles.verdictRejectOn}` : `${styles.verdictButton} ${styles.verdictReject}`}
                        onClick={() => {
                          if (defect.status === 'rejected') {
                            void setStatus(review, defect, 'pending')
                            return
                          }
                          setRejectingId(defect.id)
                          setRejectDraft('')
                        }}
                      >
                        {t('btnReject')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={defect.status === 'pending' ? `${styles.verdictButton} ${styles.verdictPendingOn}` : `${styles.verdictButton} ${styles.verdictPending}`}
                        onClick={() => {
                          void setStatus(review, defect, 'pending')
                        }}
                      >
                        {t('btnPending')}
                      </button>
                    </div>
                  )}

                  {rejectingId === defect.id ? (
                    <div className={styles.rejectBox}>
                      <div className={styles.rejectPrompt}>{t('rejectPrompt')}</div>
                      <textarea
                        className={styles.rejectInput}
                        value={rejectDraft}
                        autoFocus
                        rows={2}
                        placeholder={t('rejectPlaceholder')}
                        onChange={(event) => setRejectDraft(event.target.value)}
                      />
                      <div className={styles.actions}>
                        <button
                          type="button"
                          disabled={busy}
                          className={styles.btnDangerOn}
                          onClick={() => {
                            const reason = rejectDraft.trim()
                            if (reason === '') {
                              reportNotice(t('rejectPrompt'))
                              return
                            }
                            void setStatus(review, defect, 'rejected', reason)
                            setRejectingId(null)
                            setRejectDraft('')
                          }}
                        >
                          {t('rejectConfirm')}
                        </button>
                        <button
                          type="button"
                          className={styles.btnGhost}
                          onClick={() => {
                            setRejectingId(null)
                            setRejectDraft('')
                          }}
                        >
                          {t('rejectCancel')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                )
              })
            )}

            {/* ---------------- 次要操作 ----------------
                主行动已经移到卡片顶部的状态区。这里只剩导出（不推进状态机，随时可用）
                与那句边界声明。刻意不再放"下一步"按钮：同一张卡上出现两个同样重要的
                推进按钮，正是用户说的"没有凸显重点"。 */}
            <div className={styles.footer}>
              <button type="button" disabled={busy} className={styles.btnGhost} onClick={() => { void exportReview(review) }}>
                {t('btnExport')}
              </button>
              <span className={styles.footerNote}>{t('cardFooterNote')}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
