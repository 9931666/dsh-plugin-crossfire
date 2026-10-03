/**
 * Locale dictionaries for the Crossfire browser UI.
 *
 * 命名空间 `crossfire` 与圆桌会议的 `roundtable` **完全分开**：两个插件共享一个
 * 命名空间会让任意一方加键就撞上另一方。
 *
 * @module dsh-plugin-crossfire/client/locales
 */

export const NS = 'crossfire'

/** 本插件用到的全部文案键。新增键必须同时补 zh 与 en，否则 Record 类型会报错。 */
export type CrossfireKey =
  | 'renderFailed'
  | 'renderFailedHint'
  | 'tab'
  | 'settingsNav'
  | 'settingsTitle'
  | 'settingsIntro'
  | 'boundaryTitle'
  | 'boundaryLine1'
  | 'boundaryLine2'
  | 'boundaryLine3'
  | 'boundaryLine4'
  | 'defaultIntensity'
  | 'intensityQuick'
  | 'intensityStandard'
  | 'intensityDeep'
  | 'intensityHint'
  | 'intensityPerDimension'
  | 'intensityCrossYes'
  | 'intensityCrossNo'
  | 'intensityRecheckCap'
  | 'dimensionsTitle'
  | 'dimensionsHint'
  | 'poolLabel'
  | 'customLabel'
  | 'customEmpty'
  | 'customPlaceholder'
  | 'customAdd'
  | 'customRemove'
  | 'customLimit'
  | 'customInvalid'
  | 'budgetTitle'
  | 'budgetHint'
  | 'budgetRounds'
  | 'budgetTokens'
  | 'expertMaxTokens'
  | 'expertMaxOpinions'
  | 'unlimited'
  | 'loading'
  | 'loadFailed'
  | 'saved'
  | 'saveFailed'
  | 'batchNote'
  | 'cardTitle'
  | 'statusDraft'
  | 'statusAttacking'
  | 'statusJudging'
  | 'statusSettled'
  | 'statusNext'
  | 'statusStrip'
  | 'statusHintDraft'
  | 'statusHintAttacking'
  | 'statusHintJudging'
  | 'statusHintSettled'
  | 'passBadge'
  | 'subjectLabel'
  | 'stanceLabel'
  | 'stanceEmpty'
  | 'dimensionsLabel'
  | 'expertsLabel'
  | 'expertPending'
  | 'expertRunning'
  | 'expertDone'
  | 'expertFailed'
  | 'expertSilent'
  | 'expertDefects'
  | 'expertReported'
  | 'expertSubmitted'
  | 'expertNoOutput'
  | 'impactTitle'
  | 'countEndorsed'
  | 'countRejected'
  | 'countPending'
  | 'defectEmpty'
  | 'defectsTitle'
  | 'evidenceRepro'
  | 'evidenceArgument'
  | 'strikesStance'
  | 'dimensionFallback'
  | 'recheckLabel'
  | 'recheckNote'
  | 'verdictFixed'
  | 'verdictUnfixed'
  | 'verdictPartial'
  | 'verdictUndecided'
  | 'recheckNoteNeedsVerdict'
  | 'btnAttack'
  | 'btnCollect'
  | 'btnFinish'
  | 'btnRecheck'
  | 'btnExport'
  | 'btnEndorse'
  | 'btnReject'
  | 'btnPending'
  | 'rejectPrompt'
  | 'rejectPlaceholder'
  | 'rejectConfirm'
  | 'rejectCancel'
  | 'busyWorking'
  | 'noReviews'
  | 'cardHint'
  | 'actionFailed'
  | 'cardFooterNote'
  | 'noSessionHint'
  | 'expand'
  | 'collapse'
  | 'expandSection'
  | 'collapseSection'
  | 'expertsTitle'
  | 'expertRosterHint'
  | 'expertRoleLabel'
  | 'expertRolePlaceholder'
  | 'expertRoleEdit'
  | 'expertRoleSaved'
  | 'expertRoleFromRoster'
  | 'expertPromptView'
  | 'expertPromptTitle'
  | 'stanceSectionTitle'
  | 'stanceExpand'
  | 'stanceCollapse'
  | 'explainDismiss'
  | 'recheckApprovalAsk'
  | 'recheckApprovalYes'
  | 'recheckApprovalNo'
  | 'settingsExplainTitle'
  | 'settingsExplainRestore'
  | 'settingsExplainNone'
  | 'settingsExplainCount'
  | 'stanceEdit'
  | 'stanceSave'
  | 'stanceSaved'
  | 'stanceHint'
  | 'exportDone'
  | 'exportFailed'
  | 'settingsPresetsTitle'
  | 'settingsPresetsHint'
  | 'settingsPresetsEmpty'
  | 'presetName'
  | 'presetRole'
  | 'presetProvider'
  | 'presetModel'
  | 'modelInherit'
  | 'presetAdd'
  | 'presetAddCount'
  | 'presetLimitInline'
  | 'modelRoute'
  | 'modelCatalogLoading'
  | 'modelCatalogFailed'
  | 'modelCatalogEmpty'
  | 'presetProviderNeeded'
  | 'presetSave'
  | 'presetCancel'
  | 'presetEdit'
  | 'presetDelete'
  | 'presetInvalid'
  | 'presetLimit'
  | 'presetSaved'
  | 'settingsSquadsTitle'
  | 'settingsSquadsHint'
  | 'settingsSquadsEmpty'
  | 'squadAdd'
  | 'squadAddCount'
  | 'squadName'
  | 'squadMembers'
  | 'squadMemberKey'
  | 'squadMemberRole'
  | 'squadAddMember'
  | 'squadRemoveMember'
  | 'squadSave'
  | 'squadCancel'
  | 'squadEdit'
  | 'squadDelete'
  | 'squadInvalid'
  | 'squadSaved'
  | 'squadLimit'
  | 'squadMemberCount'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The crossfire settings page copy. */
    crossfire: CrossfireKey
  }
}

export const zh: Record<CrossfireKey, string> = {
  renderFailed: '针锋的这一块渲染失败了',
  renderFailedHint: '这不是数据丢失：刷新页面即可重试。若反复出现，请把控制台里 [crossfire] 开头的那行错误一并反馈。',

  tab: '针锋',
  settingsNav: '针锋',
  settingsTitle: '针锋 Crossfire',
  settingsIntro: '针锋只做一件事：把一个已经定稿的成果或方案摆上台，让红队专家从指定维度分头攻击，把攻击拆成逐条可裁决的缺陷。下面的设置是**默认值**，只影响新建的评审；已经开始的评审不受影响。',

  boundaryTitle: '四条边界',
  boundaryLine1: '1. 表态永远由人做：认定 / 驳回只能在卡片上由你操作，没有"代表认定缺陷"的工具。',
  boundaryLine2: '2. 针锋不产出方案、不改代码、不自动修复——它是验收器，不是执行器。',
  boundaryLine3: '3. 红队专家只读：它们只挑错，不动你的工作区。',
  boundaryLine4: '4. 你的历史表态只用于去重与复审递进，绝不会被喂给红队当"用户画像"。',

  defaultIntensity: '默认强度',
  intensityQuick: '快审',
  intensityStandard: '标准',
  intensityDeep: '深挖',
  intensityHint: '强度只改变专家数、是否追加交叉质证、以及闭环复审的上限，不改变界面结构。',
  intensityPerDimension: '每维 {n} 位专家',
  intensityCrossYes: '含交叉质证',
  intensityCrossNo: '无交叉质证',
  intensityRecheckCap: '复审上限 {n} 轮',

  dimensionsTitle: '维度池',
  dimensionsHint: '维度决定红队从哪些方向攻击。固定池保证覆盖面，自定义维度用来补你自己关心的角度。',
  poolLabel: '固定维度（始终可用）',
  customLabel: '自定义维度',
  customEmpty: '（还没有自定义维度）',
  customPlaceholder: '如「合规」「成本」',
  customAdd: '＋ 添加',
  customRemove: '删除',
  customLimit: '自定义维度最多 {max} 个，每个不超过 {len} 字',
  customInvalid: '维度名不能为空、不能超过 {len} 字，也不能与固定维度重名',

  budgetTitle: '预算',
  budgetHint: '预算是熔断线：达到上限后本场评审会被静音，未完成的攻击直接停止。',
  budgetRounds: '轮数上限',
  budgetTokens: 'token 预算',
  expertMaxTokens: '专家单轮输出上限（token）',
  expertMaxOpinions: '专家单轮最多提几条缺陷',
  unlimited: '0 = 不限制',

  loading: '读取设置中…',
  loadFailed: '读取设置失败。针锋的 host 侧可能没装上，或这一页拿不到插件路由。',
  saved: '已保存',
  saveFailed: '保存失败',

  batchNote: '当前为批 1 骨架：默认强度、维度池与预算可用。专家管理、角色预设与阵容预设将在后续批次补齐。',

  cardTitle: '针锋',
  statusDraft: '待开审',
  statusAttacking: '攻击中',
  statusJudging: '待裁决',
  statusSettled: '已定稿',
  statusNext: '下一步',
  statusStrip: '当前状态与下一步',
  statusHintDraft: '红队还没上场。先确认台上的对象与你的立场，再送他们上去。',
  statusHintAttacking: '红队正在分头攻击。等他们提交后收集观点，才会拆成可裁决的缺陷。',
  statusHintJudging: '该你了：逐条认定或驳回。机器只负责挑错，结论永远由你下。',
  statusHintSettled: '已定稿，本轮的认定结果已固化为旧账清单。复审只核对这份旧账，不许开新战线。',
  passBadge: '第 {pass}/{max} 轮',
  subjectLabel: '待验证对象',
  stanceLabel: '我的立场与理由',
  stanceEmpty: '（没有填写立场——红队因此少了一个靶子）',
  dimensionsLabel: '攻击维度',
  expertsLabel: '红队',
  expertPending: '待命',
  expertRunning: '攻击中',
  expertDone: '已提交',
  expertFailed: '拉起失败',
  expertSilent: '无产出',
  expertDefects: '{n} 条缺陷',
  expertReported: '已提交 {n} 次发言（待收集）',
  expertSubmitted: '{done}/{total} 位已提交',
  expertNoOutput: '尚无产出',
  impactTitle: '表态',
  countEndorsed: '认定',
  countRejected: '驳回',
  countPending: '待定',
  defectEmpty: '还没有可裁决的缺陷。',
  defectsTitle: '待裁决缺陷',
  evidenceRepro: '可复现步骤',
  evidenceArgument: '论证链',
  strikesStance: '打穿立场',
  dimensionFallback: '维度已归一化',
  recheckLabel: '复核',
  recheckNote: '核对说明（可选）',
  verdictFixed: '已修复',
  verdictUnfixed: '未修复',
  verdictPartial: '部分修复',
  verdictUndecided: '尚未判断',
  recheckNoteNeedsVerdict: '先选一个核对结论，再保存备注（结论只能由你下）',
  btnAttack: '送红队上场',
  btnCollect: '收集观点',
  btnFinish: '定稿',
  btnRecheck: '开复审',
  btnExport: '导出',
  btnEndorse: '认定',
  btnReject: '驳回',
  btnPending: '待定',
  rejectPrompt: '请写明驳回理由（必填）',
  rejectPlaceholder: '为什么这条不成立？',
  rejectConfirm: '确认驳回',
  rejectCancel: '取消',
  busyWorking: '正在推进…',
  noReviews: '这个会话还没有针锋评审',
  cardHint: '在对话里说「用针锋评审一下……」就会开一场。',
  actionFailed: '操作失败',
  cardFooterNote: '表态只能由你做：机器只负责挑错。',
  noSessionHint: '这一页拿不到会话身份，写操作会被拒绝（这是有意的：会话 id 同时是权限凭据）。请刷新页面后重试。',
  expand: '展开',
  collapse: '收起',
  expandSection: '展开',
  collapseSection: '收起',
  expertsTitle: '红队专家',
  expertRosterHint: '每位专家负责一个维度。角色定位会在开打时写进它的系统提示，用来收窄它的专长（例如"只盯密钥轮换"）——它不能放宽"只读、不产出方案"这些硬约束。',
  expertRoleLabel: '角色定位',
  expertRolePlaceholder: '如：只盯密钥轮换与权限边界；已有结论不再复述',
  expertRoleEdit: '改角色定位',
  expertRoleSaved: '角色定位已保存',
  expertRoleFromRoster: '（来自阵容预设）',
  expertPromptView: '查看原提示词',
  expertPromptTitle: '这位专家的原提示词（只读）',
  stanceSectionTitle: '我的立场与理由',
  stanceExpand: '展开看全文',
  stanceCollapse: '收起立场',
  explainDismiss: '不再显示这段说明',
  recheckApprovalAsk: '已达复审上限，继续会超出本轮设定的轮次。确认开新的一轮？',
  recheckApprovalYes: '确认继续复审',
  recheckApprovalNo: '取消',
  settingsExplainTitle: '已隐藏的说明文字',
  settingsExplainRestore: '恢复显示',
  settingsExplainNone: '（没有隐藏任何说明）',
  settingsExplainCount: '你在卡片上关掉了 {n} 段解释性说明，它们不会再出现。',

  stanceEdit: '我的立场与理由（可编辑）',
  stanceSave: '保存立场',
  stanceSaved: '立场已保存',
  stanceHint: '写清你的判断与理由：红队必须逐条回应，并标注是否被打穿。留空则红队只按维度攻击，不会虚构立场。',
  exportDone: '已生成导出文件',
  exportFailed: '导出失败',

  settingsPresetsTitle: '角色预设',
  settingsPresetsHint: '自己建几个常用红队角色，开新评审时一次填好角色说明与模型。预设是全局偏好，插件不预置任何内置角色。',
  settingsPresetsEmpty: '（还没有预设）',
  presetName: '预设名称',
  presetRole: '角色说明',
  presetProvider: '模型路由',
  presetModel: '模型名',
  modelInherit: '继承主持人',
  presetAdd: '＋ 新建预设',
  presetAddCount: '＋ 新建预设（{count}/{max}）',
  presetLimitInline: '已达上限 {max} 条，删掉不用的才能再建。',
  modelRoute: '模型路由',
  modelCatalogLoading: '正在读取模型目录…',
  modelCatalogFailed: '读取模型目录失败（{reason}）。两个框因此只剩「继承主持人」—— 这通常是 host 侧还是旧版本：这条端点需要重启 Harness 才会出现（刷新页面不够）。留空即继承主持人，不影响保存预设。',
  modelCatalogEmpty: '宿主没有报出任何 provider，两个框只剩「继承主持人」。留空即继承主持人，不影响保存预设。',
  presetProviderNeeded: '先选模型路由（provider），再选模型名',
  presetSave: '保存',
  presetCancel: '取消',
  presetEdit: '编辑',
  presetDelete: '删除',
  presetInvalid: '预设名称与角色说明都不能为空',
  presetLimit: '预设数量已达上限（{max} 条），请先删除不用的',
  presetSaved: '预设已保存',

  settingsSquadsTitle: '阵容预设',
  settingsSquadsHint: '阵容只回答「谁来」：它保存几位专家的 key、角色与模型，一次套用。它不描述「怎么开」——没有维度、没有流程。',
  settingsSquadsEmpty: '（还没有阵容）',
  squadAdd: '＋ 新建阵容',
  squadAddCount: '＋ 新建阵容（{count}/{max}）',
  squadName: '阵容名称',
  squadMembers: '成员',
  squadMemberKey: '专家 key',
  squadMemberRole: '角色说明',
  squadAddMember: '＋ 加一位成员',
  squadRemoveMember: '移除',
  squadSave: '保存',
  squadCancel: '取消',
  squadEdit: '编辑',
  squadDelete: '删除',
  squadInvalid: '阵容名称与每位成员的 key 都不能为空',
  squadSaved: '阵容已保存',
  squadLimit: '最多 {max} 个阵容，每个最多 {members} 位成员',
  squadMemberCount: '{count} 位成员',
}

export const en: Record<CrossfireKey, string> = {
  renderFailed: 'This Crossfire block failed to render',
  renderFailedHint: 'No data was lost: reload the page to retry. If it keeps happening, include the console line starting with [crossfire] in your report.',

  tab: 'Crossfire',
  settingsNav: 'Crossfire',
  settingsTitle: 'Crossfire',
  settingsIntro: 'Crossfire does exactly one thing: put a settled result on the stand, let red-team experts attack it from chosen dimensions, and hand every defect to you for a verdict. The settings below are defaults for NEW reviews only — a review already under way is unaffected.',

  boundaryTitle: 'Four boundaries',
  boundaryLine1: '1. The verdict is always human: endorse / reject happens on the card, by you. There is no "endorse on my behalf" tool.',
  boundaryLine2: '2. Crossfire produces no plan, writes no code and never fixes anything — it is a verifier, not an executor.',
  boundaryLine3: '3. Red-team experts are read-only: they find flaws, they never touch your workspace.',
  boundaryLine4: '4. Your past verdicts only drive de-duplication and re-review progression; they are never fed to the red team as a "user profile".',

  defaultIntensity: 'Default intensity',
  intensityQuick: 'Quick',
  intensityStandard: 'Standard',
  intensityDeep: 'Deep',
  intensityHint: 'Intensity changes only the number of experts, whether a cross-examination round is added, and the re-review cap. It does not change the interface.',
  intensityPerDimension: '{n} expert(s) per dimension',
  intensityCrossYes: 'cross-examination included',
  intensityCrossNo: 'no cross-examination',
  intensityRecheckCap: 'up to {n} pass(es)',

  dimensionsTitle: 'Dimension pool',
  dimensionsHint: 'Dimensions decide which directions the red team attacks from. The fixed pool guarantees coverage; custom dimensions add the angles you care about.',
  poolLabel: 'Fixed dimensions (always available)',
  customLabel: 'Custom dimensions',
  customEmpty: '(no custom dimensions yet)',
  customPlaceholder: 'e.g. "compliance", "cost"',
  customAdd: '+ Add',
  customRemove: 'Remove',
  customLimit: 'Up to {max} custom dimensions, {len} characters each',
  customInvalid: 'A dimension name must be non-empty, at most {len} characters, and must not duplicate a fixed one',

  budgetTitle: 'Budget',
  budgetHint: 'The budget is a circuit breaker: once reached, the review is muted and any unfinished attack stops.',
  budgetRounds: 'Round cap',
  budgetTokens: 'Token budget',
  expertMaxTokens: 'Per-expert output cap (tokens)',
  expertMaxOpinions: 'Max defects per expert per round',
  unlimited: '0 = unlimited',

  loading: 'Loading settings…',
  loadFailed: 'Failed to load settings. The Crossfire host half may not be installed, or this page cannot reach the plugin route.',
  saved: 'Saved',
  saveFailed: 'Save failed',

  batchNote: 'Batch 1 skeleton: default intensity, dimension pool and budget are live. Expert management, role presets and squad presets arrive in later batches.',

  cardTitle: 'Crossfire',
  statusDraft: 'Ready to attack',
  statusAttacking: 'Attacking',
  statusJudging: 'Awaiting your verdict',
  statusSettled: 'Settled',
  statusNext: 'Next',
  statusStrip: 'Current state and next step',
  statusHintDraft: 'The red team is not on stage yet. Check the subject and your stance first, then send them in.',
  statusHintAttacking: 'The red team is attacking from every dimension. Collect once they report — only then do the findings become adjudicable defects.',
  statusHintJudging: 'Your turn: endorse or reject, one by one. The machine only finds flaws; the conclusion is always yours.',
  statusHintSettled: 'Settled — this pass\'s endorsements are frozen into the known-flaws checklist. A recheck only verifies that list; it never opens a new front.',
  passBadge: 'Pass {pass}/{max}',
  subjectLabel: 'Under review',
  stanceLabel: 'Your position and reasons',
  stanceEmpty: '(no stance given — the red team lacks a target)',
  dimensionsLabel: 'Dimensions',
  expertsLabel: 'Red team',
  expertPending: 'Queued',
  expertRunning: 'Attacking',
  expertDone: 'Submitted',
  expertFailed: 'Failed to start',
  expertSilent: 'No output',
  expertDefects: '{n} defect(s)',
  expertReported: '{n} report(s) submitted (awaiting collect)',
  expertSubmitted: '{done}/{total} reported',
  expertNoOutput: 'Nothing yet',
  impactTitle: 'Verdicts',
  countEndorsed: 'Endorsed',
  countRejected: 'Rejected',
  countPending: 'Pending',
  defectEmpty: 'No defects to adjudicate yet.',
  defectsTitle: 'Defects to adjudicate',
  evidenceRepro: 'Repro steps',
  evidenceArgument: 'Argument',
  strikesStance: 'Refutes your stance',
  dimensionFallback: 'dimension normalized',
  recheckLabel: 'Recheck',
  recheckNote: 'Recheck note (optional)',
  verdictFixed: 'Fixed',
  verdictUnfixed: 'Not fixed',
  verdictPartial: 'Partially fixed',
  verdictUndecided: 'Not judged yet',
  recheckNoteNeedsVerdict: 'Pick a verdict first, then save the note (only you decide)',
  btnAttack: 'Send in the red team',
  btnCollect: 'Collect findings',
  btnFinish: 'Settle',
  btnRecheck: 'Open recheck',
  btnExport: 'Export',
  btnEndorse: 'Endorse',
  btnReject: 'Reject',
  btnPending: 'Undecided',
  rejectPrompt: 'A reason is required to reject',
  rejectPlaceholder: 'Why does this not hold?',
  rejectConfirm: 'Confirm reject',
  rejectCancel: 'Cancel',
  busyWorking: 'Working…',
  noReviews: 'No Crossfire review in this session yet',
  cardHint: 'Say "put this through Crossfire" in the conversation to open one.',
  actionFailed: 'Action failed',
  cardFooterNote: 'Only you can decide: the machine just finds flaws.',
  noSessionHint: 'This page has no session identity, so writes will be refused (by design: the session id doubles as the permission credential). Reload the page and retry.',
  expand: 'Expand',
  collapse: 'Collapse',
  expandSection: 'Expand',
  collapseSection: 'Collapse',
  expertsTitle: 'Red-team experts',
  expertRosterHint: 'Each expert owns one dimension. The role text is written into its system prompt when the attack starts, to narrow its expertise (e.g. "key rotation only") — it can never relax the hard constraints (read-only, no plans).',
  expertRoleLabel: 'Role',
  expertRolePlaceholder: 'e.g. only key rotation and permission boundaries; do not repeat settled points',
  expertRoleEdit: 'Edit role',
  expertRoleSaved: 'Role saved',
  expertRoleFromRoster: '(from a squad preset)',
  expertPromptView: 'View original prompt',
  expertPromptTitle: 'This expert\'s original prompt (read-only)',
  stanceSectionTitle: 'Your position and reasons',
  stanceExpand: 'Expand full text',
  stanceCollapse: 'Collapse stance',
  explainDismiss: 'Hide this explanation',
  recheckApprovalAsk: 'The re-review cap is reached; continuing exceeds this pass\'s limit. Open one more pass?',
  recheckApprovalYes: 'Approve another pass',
  recheckApprovalNo: 'Cancel',
  settingsExplainTitle: 'Hidden explanations',
  settingsExplainRestore: 'Show again',
  settingsExplainNone: '(nothing hidden)',
  settingsExplainCount: 'You hid {n} explanation(s) on the card; they stay hidden.',

  stanceEdit: 'Your position and reasons (editable)',
  stanceSave: 'Save stance',
  stanceSaved: 'Stance saved',
  stanceHint: 'State your judgement and your reasons: the red team must answer each one and mark whether it was refuted. Leave it empty and they simply attack by dimension — they will not invent a stance.',
  exportDone: 'Export written',
  exportFailed: 'Export failed',

  settingsPresetsTitle: 'Role presets',
  settingsPresetsHint: 'Build the red-team roles you reuse, so a new review starts with the role text and model already filled in. Presets are global preferences; the plugin ships none.',
  settingsPresetsEmpty: '(no presets yet)',
  presetName: 'Preset name',
  presetRole: 'Role description',
  presetProvider: 'Provider route',
  presetModel: 'Model',
  modelInherit: 'Inherit host',
  presetAdd: '+ New preset',
  presetAddCount: '+ New preset ({count}/{max})',
  presetLimitInline: 'Limit reached ({max}) — delete one to create another.',
  modelRoute: 'Model route',
  modelCatalogLoading: 'Loading the model catalog…',
  modelCatalogFailed: 'Could not load the model catalog ({reason}). Both fields therefore offer only "Inherit host" — usually the host half is still an older build: this endpoint only appears after restarting the Harness (reloading the page is not enough). Leaving them empty means "inherit host" and still saves fine.',
  modelCatalogEmpty: 'The host reported no providers, so both fields offer only "Inherit host". Leaving them empty means "inherit host" and still saves fine.',
  presetProviderNeeded: 'Pick a provider first, then a model',
  presetSave: 'Save',
  presetCancel: 'Cancel',
  presetEdit: 'Edit',
  presetDelete: 'Delete',
  presetInvalid: 'A preset needs both a name and a role description',
  presetLimit: 'Preset limit reached ({max}) — delete one first',
  presetSaved: 'Preset saved',

  settingsSquadsTitle: 'Squad presets',
  settingsSquadsHint: 'A squad only answers "who joins": it stores several experts\' keys, roles and models so you can apply them at once. It says nothing about how the review runs — no dimensions, no flow.',
  settingsSquadsEmpty: '(no squads yet)',
  squadAdd: '+ New squad',
  squadAddCount: '+ New squad ({count}/{max})',
  squadName: 'Squad name',
  squadMembers: 'Members',
  squadMemberKey: 'Expert key',
  squadMemberRole: 'Role description',
  squadAddMember: '+ Add a member',
  squadRemoveMember: 'Remove',
  squadSave: 'Save',
  squadCancel: 'Cancel',
  squadEdit: 'Edit',
  squadDelete: 'Delete',
  squadInvalid: 'A squad needs a name and every member needs a key',
  squadSaved: 'Squad saved',
  squadLimit: 'Up to {max} squads, {members} members each',
  squadMemberCount: '{count} member(s)',
}
