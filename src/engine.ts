/**
 * 评审引擎：不依赖 `exec.agent` 的核心动作。
 *
 * ## 为什么需要它
 *
 * 工具（`tools.ts`）和浏览器 RPC（`rpc.ts`）必须能驱动**同一套**状态机 —— 这正是
 * O1 决策（卡片按钮直推 host，不等 AI 回合）的落点。工具拿到的是 `exec.agent`，
 * RPC 拿到的是 `sessionId`，两者唯一的公共面就是"一段纯逻辑 + 一个 ctx"。
 *
 * 所以这里放的是：**凡是两条入口都需要、且复制一份就会分叉的**逻辑。
 * - {@link planExperts}：按强度档与维度算阵容（决定谁去攻击）；
 * - {@link collectDefects}：拆分 + 噪音过滤 + 维度归一化 + 历史去重（决定用户看到
 *   什么）—— 这一块是整个插件里最容易分叉的地方，所以它是单点实现。
 *
 * 不放在这里的是：状态机门禁、写盘时序、专家拉起（那些短且各自语境不同）。
 *
 * @module dsh-plugin-crossfire/engine
 */

import { resolveDimension } from './dimensions.ts'
import { isNoiseUtterance } from './noise.ts'
import { dropRejectedDuplicates, rejectedContents } from './review.ts'
import { splitByMarkers, splitUtterance, type ReviewSplitConfig, type SplitLlmLike } from './split.ts'
import { INTENSITY_SPECS } from './types.ts'
import type { CrossfireRecord, Defect, ExpertUtterance, RedTeamExpert } from './types.ts'

/**
 * 一位专家的"人选来源"：把用户偏好里的角色 / 模型路由喂给阵容规划。
 *
 * ## 为什么需要它（这是红队评审抓出的真实缺陷）
 *
 * 设置页的角色预设与阵容预设此前是**只写不读**的：`preferences.ts` 存了它们，
 * `SettingsView` 能增删改，但 `planExperts` 从不消费 —— 于是"编辑专家提示词"这件事
 * 在数据上根本没有出口，`expert.provider`/`expert.model` 也永远缺席（快照里那个
 * 品牌块因此只能显示中性 `?`）。这里把它接上。
 */
export interface ExpertRosterEntry {
  /**
   * 匹配键：与**维度名**比较。
   *
   * 用维度名而不是顺序匹配，是因为维度是用户直接输入的东西，而阵容成员的 `key`
   * 本来就是自由文本（设置页提示了"专家 key"）—— 让 key 就是维度名是最省心的用法。
   * 匹配不到时退回**顺序**兜底（见 {@link planExperts}），两种写法都能用。
   */
  key: string
  /** 用户补充的角色定位（进 persona 的「你的角色定位」段）。 */
  role?: string
  provider?: string
  model?: string
  /**
   * 预设名（只有角色预设带它）。
   *
   * 角色预设的主标识是 `name`，阵容成员的主标识是 `key`；这一层刻意**两种都收**，
   * 于是调用方不必先做一次形状转换 —— 形状分歧是缺陷的温床（红队抓出的"预设只写
   * 不读"就属于这类缝隙）。
   */
  name?: string
}

/**
 * 按强度档与维度算出这一轮要拉起谁。
 *
 * 纯函数（可单测）：同样一份记录 + 同一份 roster 永远得到同一份阵容。规模上限按
 * `record.dimensions` 的顺序截断，所以**用户排在前面的维度优先** —— 这是可预期的，
 * 而不是随机丢人。
 *
 * 人选来源两条，按优先级：
 * 1. `roster` 里 `key` 等于维度名的那一条（精确指定，最符合直觉）；
 * 2. 否则按**顺序**取 roster 的第 i 条（i = 维度序号）—— 用户不必把 key 改名成
 *    维度名也能用上一份现成的阵容；
 * 3. 都取不到时只写维度与状态（专家继承主持人路由、无补充定位），与从前完全一致。
 *
 * @param roster - 可选人选来源；缺席或为空时行为与从前逐字一致。
 */
export function planExperts(
  record: CrossfireRecord,
  maxExperts: number,
  roster: readonly ExpertRosterEntry[] = [],
): RedTeamExpert[] {
  const spec = INTENSITY_SPECS[record.intensity]
  const experts: RedTeamExpert[] = []
  let dimensionIndex = 0
  for (const dimension of record.dimensions) {
    const count = Math.max(1, spec.expertsPerDimension)
    // 精确命中优先；否则顺序兜底。注意顺序兜底用的是**维度序号**而不是专家序号，
    // 这样"每维 2 位"时两位专家共享同一份定位，而不是被拆成两个人设。
    const matched = roster.find((entry) => entry.key === dimension) ?? roster[dimensionIndex]
    dimensionIndex += 1
    for (let index = 0; index < count; index += 1) {
      const expert: RedTeamExpert = {
        key: count === 1 ? dimension : `${dimension}-${index + 1}`,
        dimension,
        status: 'pending',
        defectCount: 0,
      }
      if (matched !== undefined) {
        if (matched.role !== undefined && matched.role.trim() !== '') expert.role = matched.role.trim()
        // provider 与 model **各自独立**写入（A5）。
        //
        // 此前这里要求两者**成对**（`provider !== undefined && model !== undefined`），
        // 于是"只填了 provider"或"只填了 model"的阵容成员会被整条静默丢弃 ——
        // 用户配了半条路由、界面上什么都没发生，也没有任何提示。
        //
        // 成对要求本身是错的：`AgentOptions` 的 `provider?` / `model?` 各自独立可选
        // （见 `@deepseek-ai/dsh-agent` 的 runtime-types：只给 provider 时该 provider
        // 自会选它的默认模型），所以半配置是**合法**输入，不是错误输入。
        //
        // 空串/纯空白与"缺席"同义：宁可保持"缺失 = 继承"，也不要写一个空字符串让
        // 下游以为拿到了一条路由。
        if (matched.provider !== undefined && matched.provider.trim() !== '') expert.provider = matched.provider.trim()
        if (matched.model !== undefined && matched.model.trim() !== '') expert.model = matched.model.trim()
      }
      experts.push(expert)
    }
  }
  return experts.length > maxExperts ? experts.slice(0, maxExperts) : experts
}

/** 一次收集的结果。 */
export interface CollectOutcome {  /** 本次新增的缺陷（已去重）。 */
  added: Defect[]
  /** 因为"用户上一轮驳回过"而被丢弃的条数。 */
  droppedDuplicates: number
  /** 被噪音规则拦下的发言条数。 */
  skippedNoise: number
  /** 真正调用过 LLM 拆分的次数（0 表示全部走了本地兜底）。 */
  splitAttempts: number
  /** 已收集过、本次跳过的发言条数（幂等键命中）。 */
  alreadyCollected: number
  /** 解析失败的转录行数（原样带回，不许静默吞掉）。 */
  malformedLines: number
}

/** 收集所需的输入。 */
export interface CollectInput {
  record: CrossfireRecord
  /** 转录条目（已过滤掉非对象/空内容）。 */
  transcript: readonly ExpertUtterance[]
  /** 转录里被丢弃的坏行数。 */
  malformed: number
  /** LLM 服务；缺席时全部走本地启发式兜底。 */
  llm?: SplitLlmLike
  splitConfig: ReviewSplitConfig
  /**
   * 拆分阶段向 LLM 发起的最大并发数。
   *
   * **通常不必传**：缺省时读 `splitConfig.llmConcurrency`（再缺省才用 4），于是两个
   * 调用方（工具 / RPC 直推）天然一致。显式传入只用于测试与排障（`1` = 回到串行）。
   */
  llmConcurrency?: number
}

/**
 * 有界并发的 `map`（零依赖）。
 *
 * 为什么需要它：拆分一条发言要打一次 LLM（`split.ts` 每次 60s 超时），而此前是
 * **串行** `await` —— 一场 7 位专家、每人报告 3 次的评审 = 21 次串行往返，收集动作
 * 的墙钟时间 ≈ 21 × 单次往返（十秒级），期间界面只有一个禁用的"收集"按钮，既没有
 * 进度也没有取消（红队评审抓出的性能缺陷）。
 *
 * 并发上限刻意**不高**：这些请求打的是同一个 provider，并发拉满只会撞速率限制、
 * 反而更慢，而且要留出余量给界面自己的请求。
 *
 * 结果顺序与输入**逐位对应**（按下标回填，而不是按完成先后），所以拆出来的缺陷顺序
 * 与串行版本完全一致 —— 这是可测的，见 `test/engine.test.mjs`。
 */
export async function collectWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  // 共享游标：每个工作者按需领取下一个下标，因此总并发恰好是 min(limit, items.length)。
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (item === undefined) continue
      results[index] = await worker(item, index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 把本轮专家发言收成逐条可裁决的缺陷。
 *
 * 五道处理，顺序有意义：
 * 1. **只收本轮**（`utterance.pass === record.reviewPass`）；
 * 2. **幂等**（`utteranceId` 已收集过就跳过 —— 拆分后 defect.id 会变，不能用作去重键）；
 * 3. **噪音过滤**（`auto-capture` 与进度汇报；真实数据里前者曾被当成缺陷收进裁决面）；
 * 4. **拆分**（LLM 三道防线优先 → 本地标记切分兜底 → 整条兜底 `seq = 0`）；
 * 5. **维度归一化 + 历史去重**（落库维度必须 ∈ 本次采用维度；上轮被驳回的观点不再弹）。
 *
 * 复审轮（`reviewPass > 1` 且已有历史）**不新增缺陷**：那一轮唯一的任务是核对旧账。
 */
export async function collectDefects(input: CollectInput): Promise<CollectOutcome> {
  const { record, transcript, llm } = input
  const allowed = record.dimensions
  const collectedUtterances = new Set(record.defects.map((defect) => defect.utteranceId))
  const isRecheckRound = record.reviewPass > 1 && record.history.length > 0

  const candidates: Defect[] = []
  let skippedNoise = 0
  let alreadyCollected = 0

  // 一道过滤 + 收集待拆分项：把"哪些要拆"与"怎么拆"分开，
  // 于是拆分环节可以对整批发言施加有界并发（见 collectWithConcurrency）。
  const pending: { utterance: ExpertUtterance; content: string }[] = []
  for (const utterance of transcript) {
    if (utterance.pass !== record.reviewPass) continue
    if (collectedUtterances.has(utterance.id)) {
      alreadyCollected += 1
      continue
    }
    if (isNoiseUtterance(utterance.kind, utterance.content)) {
      skippedNoise += 1
      continue
    }
    // 复审轮不新增缺陷：那一轮只核对上一轮已认定的项。
    if (isRecheckRound) continue

    const content = utterance.content.replace(/\s+/g, ' ').trim()
    if (content === '') continue
    pending.push({ utterance, content })
  }

  /**
   * 拆一条发言。返回 `usedLlm` 而不是直接改计数器 —— 并发下那会变成共享可变状态。
   */
  const collectOne = async (
    item: { utterance: ExpertUtterance; content: string },
    _index: number,
    activeLlm?: SplitLlmLike,
  ): Promise<{ lines: Awaited<ReturnType<typeof splitByMarkers>>; usedLlm: boolean }> => {
    if (activeLlm === undefined) return { lines: splitByMarkers(item.content, allowed), usedLlm: false }
    try {
      const lines = await splitUtterance(activeLlm, input.splitConfig, item.utterance.expertKey, item.content, allowed)
      return { lines, usedLlm: true }
    } catch {
      return { lines: splitByMarkers(item.content, allowed), usedLlm: false }
    }
  }

  const splitResults = await collectWithConcurrency(
    pending,
    // 并发上限的**单点读取处**：优先用显式入参（测试与排障），否则用路由配置里的值。
    // 两个调用方（工具 / RPC 直推）读的是同一份 `reviewSplit`，因此无需各自传参 ——
    // 少一个参数就少一处可能分叉的地方。
    input.llmConcurrency ?? input.splitConfig.llmConcurrency ?? 4,
    (item, index) => collectOne(item, index, llm),
  )
  const splitAttempts = splitResults.filter((item) => item.usedLlm).length

  for (const [position, item] of pending.entries()) {
    const lines = splitResults[position]?.lines ?? splitByMarkers(item.content, allowed)
    const utterance = item.utterance

    if (lines === null) {
      // 整条兜底（seq = 0）：宁可让用户看到一条大观点，也不要丢掉内容。
      candidates.push({
        id: utterance.id,
        utteranceId: utterance.id,
        expertKey: utterance.expertKey,
        content: item.content,
        dimension: allowed[0] ?? '其他',
        dimensionFallback: true,
        status: 'pending',
        ts: utterance.ts,
        seq: 0,
      })
      continue
    }

    for (const [index, line] of lines.entries()) {
      const resolved = resolveDimension(line.dimension, allowed)
      const defect: Defect = {
        id: `${utterance.id}#${index + 1}`,
        utteranceId: utterance.id,
        expertKey: utterance.expertKey,
        content: line.content,
        dimension: resolved.dimension,
        status: 'pending',
        ts: utterance.ts,
        seq: index + 1,
      }
      if (line.dimensionFallback === true || resolved.fallback) defect.dimensionFallback = true
      if (line.quote !== undefined) defect.quote = line.quote
      if (line.evidence !== undefined) defect.evidence = line.evidence
      if (line.strikesStance === true) defect.strikesStance = true
      candidates.push(defect)
    }
  }

  // 历史去重（D8 允许的唯一用法）：上轮被用户驳回的观点不再弹第二次。
  const { kept, dropped } = dropRejectedDuplicates(candidates, rejectedContents(record))

  return {
    added: kept,
    droppedDuplicates: dropped,
    skippedNoise,
    splitAttempts,
    alreadyCollected,
    malformedLines: input.malformed,
  }
}

/** 把用户偏好里的阵容与角色预设合成一份 roster。 */
export function rosterFrom(input: {
  /** 阵容预设（每套是一份完整方案；由调用方按 id 挑出要用的那一套传入）。 */
  squads?: readonly { id: string; members: readonly ExpertRosterEntry[] }[]
  /** 角色预设（阵容缺席时的平铺来源）。 */
  rolePresets?: readonly ExpertRosterEntry[]
  /**
   * 选中的阵容 id（可选）。
   *
   * 只认显式指定的那一个：`squads` 是**多个互斥的整体方案**（设置页里每个都是一套
   * 完整成员），把几套混在一起会得到一个用户从没设计过的阵容。
   *
   * **缺席时自动采用第一套**（而不是全部不用）：用户只需要维护一份阵容、不必再回
   * 设置页"选中"它 —— 少一步配置就少一处"我明明配了却不生效"的困惑。指定 id 不存在
   * 或该套成员为空时，同样退回第一套；再没有就退回角色预设。
   */
  squadId?: string
}): ExpertRosterEntry[] {
  const squads = input.squads ?? []
  const chosen = (input.squadId === undefined ? undefined : squads.find((squad) => squad.id === input.squadId))
    ?? (input.squadId === undefined ? squads[0] : undefined)
  if (chosen !== undefined && chosen.members.length > 0) return [...chosen.members]
  return (input.rolePresets ?? []).map((preset) => ({
    // 角色预设的主标识是 `name`（它没有 key），这里统一成 roster 的 `key`：
    // 于是"把预设名写成维度名"就成了精确匹配的用法，与阵容成员的写法一致。
    key: preset.key.trim() !== '' ? preset.key : (preset.name ?? ''),
    ...(preset.role === undefined ? {} : { role: preset.role }),
    ...(preset.provider === undefined ? {} : { provider: preset.provider }),
    ...(preset.model === undefined ? {} : { model: preset.model }),
  }))
}

/**
 * 把收集结果并入记录（原地修改；调用方负责落盘）。
 *
 * ## 幂等（A2）
 *
 * 此前是纯拼接（`[...record.defects, ...added]`），于是**同一条发言被收集两次**
 * 就在裁决面上出现两条一模一样的缺陷：重试、双击、两个并发请求都能触发它。
 * 用户面对的是一个"必须点两次驳回、理由还得写两遍"的列表。
 *
 * 现在按 `defect.id` 去重（`id` 由 `collectDefects` 从 `utteranceId` + 序号生成，
 * 因此同一批输入两次得到同一批 id）：**保留先到的那一条**，后来的同 id 项直接丢弃。
 * 保留先到的而不是新的，是因为"用户已经开始表态"的那一条不能被后来的副本顶掉
 * （缺陷的三态与驳回理由挂在 id 上，换掉实例等于丢掉已做出的判断）。
 *
 * `collectDefects` 里的 `utteranceId` 幂等键是第一道闸，这里的是第二道：前者防的是
 * "转录又被读了一遍"，后者防的是"合并写回被施加了同一批结果" —— 两道都需要，
 * 因为并发请求可以在第一道闸之后、第二道闸之前交错。
 *
 * @returns **实际追加的条数**（被去重丢弃的不算）。调用方必须如实上报这个数字，
 *          而不是 `added.length` —— 那会把"请求成功了但什么都没新增"报成
 *          "新增了 N 条"，用户看到条数却对不上列表。
 */
export function applyCollected(record: CrossfireRecord, added: readonly Defect[]): number {
  const known = new Set(record.defects.map((defect) => defect.id))
  const fresh: Defect[] = []
  for (const defect of added) {
    if (known.has(defect.id)) continue
    known.add(defect.id)
    fresh.push(defect)
  }
  record.defects = [...record.defects, ...fresh]
  for (const expert of record.experts) {
    expert.defectCount = record.defects.filter((defect) => defect.expertKey === expert.key).length
  }
  return fresh.length
}
