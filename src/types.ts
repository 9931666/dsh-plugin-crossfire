/**
 * Crossfire（针锋）的领域类型。
 *
 * 设计边界（与圆桌会议刻意不同，务必守住）：
 * - 没有 nodes / edges / topology —— 专家是行，不是图。
 * - 没有 charter 的多模式 —— 只有一种角色：红队。
 * - 没有 kb / skill / proxy-thinking 字段 —— 这个插件不读知识库、不传 skill。
 *
 * @module dsh-plugin-crossfire/types
 */

/* ------------------------------------------------------------------ *
 * 0. 维度池（攻击覆盖面）
 * ------------------------------------------------------------------ */

/**
 * 固定维度池。
 *
 * 为什么必须固定：抽样 5 份真实圆桌 `review.json`，`dimension` 实值是
 * `维度②`(×5) / `维度④`(×1) / `其他`(×4) / 空串(×1) —— 只有 1 份给出了
 * 有意义的 `架构/产品/成本`。原因是 LLM 拆分经常失败并退到本地启发式兜底，
 * 而兜底把段首的圆圈数字直接当成了维度名。用户看到的因此是一堆编号。
 * 固定池 + 落库归一化是这件事的唯一可靠解法。
 */
export const DIMENSION_POOL = ['安全', '数据', '交互', '性能', '兼容', '流程', '反例'] as const

/** 池内维度的字面值类型。 */
export type PoolDimension = (typeof DIMENSION_POOL)[number]

/** 一次评审实际采用的维度（池内值，或用户在设置页自建的自定义维度）。 */
export type Dimension = string

/* ------------------------------------------------------------------ *
 * 1. 强度与状态机
 * ------------------------------------------------------------------ */

/** 攻击强度：只影响专家数、额外轮次与复审上限，不改变界面结构。 */
export type Intensity = 'quick' | 'standard' | 'deep'

/** 强度的生效规则（单一来源，客户端与服务端共用同一张表）。 */
export interface IntensitySpec {
  /** 每个维度拉几位专家。 */
  expertsPerDimension: number
  /** 收集之后是否自动追加一轮交叉质证。 */
  crossExamination: boolean
  /** 闭环复审上限（首轮 + 最多复审 maxReviewPass-1 次）。 */
  maxReviewPass: number
  /** 界面上一句话说明。 */
  label: string
}

/** 三档强度的完整定义。 */
export const INTENSITY_SPECS: Readonly<Record<Intensity, IntensitySpec>> = {
  quick: { expertsPerDimension: 1, crossExamination: false, maxReviewPass: 1, label: '快审：一轮出结论，不复审' },
  standard: { expertsPerDimension: 1, crossExamination: false, maxReviewPass: 2, label: '标准：一轮攻击，可复审一次' },
  deep: { expertsPerDimension: 1, crossExamination: true, maxReviewPass: 3, label: '深挖：加一轮交叉质证，可复审两次' },
}

/**
 * 评审状态机。
 *
 *   draft → attacking → judging → settled
 *                          ↑          │
 *                          └──────────┘  recheck（复审：只核对旧账）
 *
 * 表态（认定/驳回）只允许发生在 `judging`；`settled` 之后要改结论必须走复审。
 */
export type ReviewStatus = 'draft' | 'attacking' | 'judging' | 'settled'

/** 缺陷三态：用户没有表态 / 认定是真缺陷 / 审阅后否定。三态可互切。 */
export type DefectStatus = 'pending' | 'endorsed' | 'rejected'

/** 复审核对结论（第二轮起，只针对上一轮已认定的缺陷）。 */
export type RecheckVerdict = 'fixed' | 'unfixed' | 'partial'

/* ------------------------------------------------------------------ *
 * 2. 评审记录
 * ------------------------------------------------------------------ */

/**
 * 证据分级（C1）。
 *
 * `repro` = 可复现步骤（代码/bug 类）；`argument` = 论证链（设计类）。
 * 这道分级是为了挡住最廉价的红队噪音：让设计类缺陷**不许**编造
 * "运行某命令即可复现"这类伪复现步骤。
 */
export interface CrossfireEvidence {
  kind: 'repro' | 'argument'
  /** 证据正文：编号复现步骤，或论证链。≤600 字符。 */
  text: string
}

/** 一条缺陷（可能是一条专家发言拆分而来）。 */
export interface Defect {
  /** 行 id：`${utteranceId}#${seq}`（拆分后 seq≥1；整条未拆则 seq=0）。 */
  id: string
  /** 来源发言 id（collect 的幂等键：同一发言只收集一次）。 */
  utteranceId: string
  /** 提出该缺陷的专家 key。 */
  expertKey: string
  /** 缺陷内容（单条，只含一个缺陷）。 */
  content: string
  /** 维度标签。**必须**是本次评审采用的维度之一（见 normalizeDimension）。 */
  dimension: Dimension
  /** 维度越界时置 true：表示落库时被归一化到最近的池内值。 */
  dimensionFallback?: boolean
  /** 原文引用子串（≤120 字符，规范化后必须是发言原文的子串）。 */
  quote?: string
  /** 证据分级。 */
  evidence?: CrossfireEvidence
  /** 是否打穿了用户立场中的某条理由（R5）。 */
  strikesStance?: boolean
  /** 三态。 */
  status: DefectStatus
  /** 驳回理由（驳回必填；改回其它态时不清除，供追溯）。 */
  rejectReason?: string
  /** 复审核对结果（第二轮起才有）。 */
  /**
   * 复审核对结论。
   *
   * `verdict` **刻意是可选的**，而且"缺席"是一个有意义的状态：**尚未判断**。
   *
   * 它此前是必填、且开轮时被机器写成 `'unfixed'`（"未被证明修复之前都算没修"），
   * 于是复审轮一打开，每条核对项的三态按钮里"未修复"就已经是高亮选中态，而备注框
   * 旁那个"保存"按钮会把这个**机器默认值**当作人做的表态提交上去（红队评审抓出的
   * 真实缺陷）。那正好违背本插件最核心的边界：**结论只能由人下**。
   *
   * 现在的语义：
   * - `verdict` 缺席 = 人还没判断（按钮不高亮，且不允许借"保存备注"顺手落一个结论）；
   * - 有值 = 人明确选过（含 `unfixed` —— 那才是"人判定为未修复"）。
   */
  recheck?: { pass: number; verdict?: RecheckVerdict; note?: string }
  ts: number
  /** 发言内序号：0=整条未拆分；≥1=拆分出的第 N 条。 */
  seq: number
}

/** 用户的立场与理由（针锋的"锋"：红队必须逐条回应这里的每条理由）。 */
export interface Stance {
  /** 正文。≤2000 字符。 */
  text: string
  /** 来源：手写 / 自动提炼 / 提炼后手改。`edited` 之后不再被自动提炼覆盖。 */
  origin: 'manual' | 'distilled' | 'edited'
  distilledAt?: number
  updatedAt: number
}

/** 一位红队专家在本场评审里的状态。 */
export interface RedTeamExpert {
  /** 专家 key（同时是子代理 label 的一部分）。 */
  key: string
  /** 这位专家负责的维度。 */
  dimension: Dimension
  /**
   * 宿主的子会话 id（`startContinuable` 的 `childId`）。
   *
   * 拉起失败时为空 —— 此时 `status` 必为 `failed` 且 `note` 有可读原因。
   * `expert-events.ts` 靠它把 `subagent/end` 事件认回是哪位专家。
   */
  childId?: string
  provider?: string
  model?: string
  /**
   * 这位专家的**用户补充角色定位**（来自角色预设或阵容成员，可空）。
   *
   * 它被追加进 persona，用来把"安全维度的红队"细化成"熟悉密钥管理的那位红队"。
   * 它有两条硬边界，实现在 `redteam.ts`：
   * 1. 只能**补充专长**，不能覆盖九条硬约束（只读、不产出方案、不迎合等）——
   *    否则用户只要写一句"你可以修改文件"，专家就能越过只读边界；
   * 2. 缺席时 persona 与从前逐字一致（老记录不受影响）。
   */
  role?: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'silent'
  /**
   * 这位专家产出的**缺陷**条数。
   *
   * 它只在 `crossfire_collect` 之后才有值：一条发言可能拆成多条缺陷，所以在收集
   * 之前这个数字**必然是 0** —— 那不是"专家什么都没找到"，而是"还没拆"。卡片因此
   * 必须同时显示 {@link reportCount}，否则用户会读到一句谎话（真实评审里出现过：
   * 专家报告"已提交 3 条"，卡面却写 0，且这笔 token 已经计过费）。
   */
  defectCount: number
  /** 这位专家**提交过几次发言**（`crossfire_report` 的次数，实时更新）。 */
  reportCount?: number
  /** 失败/静默原因（诊断用）。 */
  note?: string
}

/** 一轮已完成的评审快照（闭环复审的核对依据）。 */
export interface PassSnapshot {
  pass: number
  subject: string
  stanceText: string
  dimensions: Dimension[]
  intensity: Intensity
  defects: Defect[]
  finishedAt: number
  /** 该轮修订说明（定稿时附，供下一轮核对旧缺陷是否修复）。 */
  revisedSummary?: string
}

/** 待验证对象。 */
export interface Subject {
  /** 一句话标题（卡片抬头 + 导出标题）。 */
  title: string
  /** 正文：方案、成果、代码摘要或文件内容。 */
  content: string
  /** 来源：手动粘贴 / 当前对话提炼 / 某个交付文件。 */
  source: 'manual' | 'chat' | 'file'
  /** 来源引用（文件路径，或对话锚点）。 */
  sourceRef?: string
}

/** 预算。 */
export interface CrossfireBudget {
  maxRounds: number
  maxTokens: number
  usedRounds: number
  usedTokens: number
}

/** 一场针锋评审的完整记录（`<stateRoot>/crossfire/<reviewId>/review.json`）。 */
export interface CrossfireRecord {
  /**
   * schema 版本。**缺失视为 1**（与圆桌同款判定），当前为 1。
   *
   * 这是新插件的起点：刻意**不继承**圆桌 review.json 的 v1→v2 迁移包袱。
   * crossfire 的目录是独立的，不可能读到圆桌的记录。
   */
  schemaVersion: 1
  reviewId: string
  status: ReviewStatus
  subject: Subject
  stance: Stance
  /** 本次采用的维度（池内 + 自定义）。 */
  dimensions: Dimension[]
  intensity: Intensity
  experts: RedTeamExpert[]
  defects: Defect[]
  /** 当前第几轮（首轮 = 1）。 */
  reviewPass: number
  /** 复审上限（由强度档决定）。 */
  maxReviewPass: number
  /** 之前各轮的已定稿快照。 */
  history: PassSnapshot[]
  budget: CrossfireBudget
  /** 从圆桌会议移交时记录来源会议 id（v0.1.0 只写不读）。 */
  sourceMeeting?: string
  /**
   * 开启这场评审的会话 id。
   *
   * 用途只有一个：**校验调用者**。主持人工具都要求传 `review_id`，若没有这层，
   * 任何会话都能操作别人的评审。它与人无关、不含任何用户信息，因此不构成"用户
   * 画像"。缺失（旧记录）时跳过校验而不是拒绝。
   */
  ownerSessionId?: string
  startedAt: number
  updatedAt: number
  /** 定稿时间（status → settled 时写）。 */
  settledAt?: number
}

/** 一条专家发言（`transcript.jsonl` 的一行）。 */
export interface ExpertUtterance {
  id: string
  /** 发言专家的 key。 */
  expertKey: string
  /**
   * `speech` = 专家主动调用 `crossfire_report` 提交；
   * `auto-capture` = 宿主 `subagent/end` 自动补捕（专家没 report 就结束了）。
   *
   * 关键：`auto-capture` **绝不进入缺陷收集**。圆桌的真实数据里出现过
   * `[当前状态] 已收到主持人任务，完成对 17 项清单的四维红队审查…` 这类过程
   * 叙述被当成缺陷收进裁决列表，污染了用户的表态面。
   */
  kind: 'speech' | 'auto-capture'
  content: string
  /** 属于第几轮评审。 */
  pass: number
  ts: number
}

/** 一条轻量用户行为记录（`user-actions.jsonl`）。 */
export interface UserAction {
  id: string
  ts: number
  kind: string
  text: string
}

/* ------------------------------------------------------------------ *
 * 3. 专家预设（保留圆桌那套干净的边界）
 * ------------------------------------------------------------------ */

/** 用户自建的角色预设：只描述"一位专家该怎么配"。 */
export interface RolePreset {
  id: string
  /** 预设名称，如"安全审查"。 */
  name: string
  /** 角色说明（写进红队 persona）。 */
  role: string
  provider?: string
  model?: string
}

/** 阵容预设里的一位成员。 */
export interface RoleSquadMember {
  key: string
  role: string
  provider?: string
  model?: string
}

/**
 * 用户自建的阵容预设：一次把多位专家排进队列。
 *
 * 与 {@link RolePreset} 的分工用类型钉死——阵容只回答"谁来"，不描述"怎么开"：
 * 它保存 key/角色/模型，没有维度、没有流程、没有轮次。这条边界在圆桌里已经
 * 被证明有效（否则"阵容"会演化成第二套会议配置）。
 */
export interface RoleSquad {
  id: string
  name: string
  members: RoleSquadMember[]
}
