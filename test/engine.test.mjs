/**
 * 引擎单测（O1 直推的核心）。
 *
 * 这个文件守护的是"工具与浏览器 RPC 走同一段逻辑"这件事：`planExperts` 与
 * `collectDefects` 是两条入口唯一的公共面，一旦它们被复制成两份，卡片按钮和
 * 工具调用就会给出不同结果 —— 那是最难发现的一类分叉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyCollected, collectDefects, collectWithConcurrency, planExperts } from '../src/engine.ts'
import { splitByMarkers, splitUtterance, stanceMarkerStrikes } from '../src/split.ts'
import { newRecord } from '../src/review.ts'

function baseRecord(overrides = {}) {
  const record = newRecord({
    reviewId: 'x-engine',
    title: '某方案',
    content: '正文',
    source: 'manual',
    dimensions: ['安全', '性能'],
    intensity: 'standard',
    maxRounds: 6,
    maxTokens: 150000,
  })
  return Object.assign(record, overrides)
}

function utterance(overrides = {}) {
  return {
    id: 'u1',
    expertKey: '安全',
    kind: 'speech',
    content: '观点 1（指向 A，维度安全）：密钥硬编码在源码里，需要移到环境变量。',
    pass: 1,
    ts: 1,
    ...overrides,
  }
}

const splitConfig = { provider: 'test', model: 'test', maxOpinions: 3 }

/**
 * 一个受控的假 LLM：记录调用次数与**同时在飞**的峰值。
 *
 * 用于钉住"拆分阶段真的有界并发"这件事 —— 此前是串行 `await`，一场 21 条发言的评审
 * 就是 21 次串行往返（红队评审抓出的性能缺陷）。这类语义只有断言能钉住：功能测试全绿
 * 也照样能跑出串行实现。
 *
 * 形状必须与 `SplitLlmLike` 一致：`stream()` 产出 chunk，其中
 * `{ type: 'block-end', block: { type: 'tool-call', arguments } }` 是拆分器优先采用的
 * 终态整块（`split.ts` 的 `callSplitLlm` 读的就是它）。
 */
function fakeStreamLlm({ delayMs = 5, failOn = new Set() } = {}) {
  const state = { calls: 0, inflight: 0, peak: 0 }
  return {
    state,
    llm: {
      stream(options) {
        const userText = options?.messages?.[0]?.content?.[0]?.text ?? ''
        state.calls += 1
        state.inflight += 1
        state.peak = Math.max(state.peak, state.inflight)
        return (async function* generate() {
          try {
            await new Promise((resolve) => { setTimeout(resolve, delayMs) })
            if ([...failOn].some((marker) => String(userText).includes(marker))) throw new Error('boom')
            yield {
              type: 'block-end',
              block: {
                type: 'tool-call',
                arguments: JSON.stringify({
                  defects: [{
                    content: `拆分结果（来源于 ${String(userText).slice(0, 12)}）`,
                    dimension: '安全',
                    evidence: { kind: 'argument', text: '论证链' },
                  }],
                }),
              },
            }
          } finally {
            state.inflight -= 1
          }
        })()
      },
    },
  }
}

/** n 条互不相同的专家发言（内容里带上序号，便于断言顺序）。 */
function utterances(n, overrides = {}) {
  return Array.from({ length: n }, (_, index) => utterance({
    id: `u${index + 1}`,
    content: `观点 1（指向 P${index + 1}，维度安全）：第 ${index + 1} 条缺陷的正文足够长以便拆分。`,
    ...overrides,
  }))
}

/* ------------------------------------------------------------------ *
 * planExperts
 * ------------------------------------------------------------------ */

test('planExperts：每维一位，顺序与 record.dimensions 一致', () => {
  const experts = planExperts(baseRecord(), 7)
  assert.deepEqual(experts.map((expert) => expert.key), ['安全', '性能'])
  assert.deepEqual(experts.map((expert) => expert.dimension), ['安全', '性能'])
  assert.ok(experts.every((expert) => expert.status === 'pending' && expert.defectCount === 0))
})

test('planExperts：规模上限按维度顺序截断（用户排在前面的优先）', () => {
  const one = planExperts(baseRecord(), 1)
  assert.equal(one.length, 1)
  assert.equal(one[0]?.key, '安全')
})

test('planExperts：三档强度都不改变阵容宽度（每维一位）', () => {
  for (const intensity of ['quick', 'standard', 'deep']) {
    assert.equal(planExperts(baseRecord({ intensity }), 7).length, 2, intensity)
  }
})

test('planExperts：纯函数，不修改记录', () => {
  const record = baseRecord()
  planExperts(record, 7)
  assert.deepEqual(record.experts, [])
})

test('collectDefects：拆分阶段有界并发，且结果顺序与发言顺序一致', async () => {
  const { state, llm } = fakeStreamLlm({ delayMs: 8 })
  const outcome = await collectDefects({
    record: baseRecord(),
    transcript: utterances(8),
    malformed: 0,
    splitConfig,
    llm,
    llmConcurrency: 3,
  })
  assert.equal(state.calls, 8, '八条发言各拆一次')
  assert.ok(state.peak > 1, `并发上限应被用起来（实测峰值 ${state.peak}）`)
  assert.ok(state.peak <= 3, `峰值不得超过上限（实测 ${state.peak}）`)
  assert.equal(outcome.splitAttempts, 8)
  // 顺序：拆出的缺陷必须按发言顺序排列，而不是按完成先后（并发最容易在这里出错）。
  assert.deepEqual(
    outcome.added.map((defect) => defect.utteranceId),
    ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'],
  )
})

test('collectDefects：llmConcurrency=1 退化为串行（峰值恰好 1）', async () => {
  const { state, llm } = fakeStreamLlm({ delayMs: 4 })
  const outcome = await collectDefects({
    record: baseRecord(),
    transcript: utterances(4),
    malformed: 0,
    splitConfig,
    llm,
    llmConcurrency: 1,
  })
  assert.equal(state.peak, 1, '设 1 就应该真的串行（排障时的可预期行为）')
  assert.equal(outcome.added.length, 4)
})

test('collectDefects：单条拆分失败只让那一条退到本地兜底，不影响其余', async () => {
  const { state, llm } = fakeStreamLlm({ delayMs: 4, failOn: new Set(['P3']) })
  const outcome = await collectDefects({
    record: baseRecord(),
    transcript: utterances(5),
    malformed: 0,
    splitConfig,
    llm,
    llmConcurrency: 3,
  })
  // 五条都发起了调用（`splitAttempts` 记的是**尝试**：`splitUtterance` 内部把异常
  // 吞掉并返回 null，所以失败的那条也算一次尝试）。
  assert.equal(state.calls, 5)
  assert.equal(outcome.splitAttempts, 5, '尝试次数 = 发言条数')
  assert.equal(outcome.added.length, 5, '一条失败不得丢掉内容')
  // 区分两条路径的**可观测差异**：走 LLM 的缺陷内容带"拆分结果"前缀，退到本地兜底的
  // 则是从发言正文里按标记切出来的原文。
  const viaLlm = outcome.added.filter((defect) => defect.content.includes('拆分结果'))
  const viaFallback = outcome.added.filter((defect) => !defect.content.includes('拆分结果'))
  assert.equal(viaLlm.length, 4, '其余四条走 LLM 拆分')
  assert.equal(viaFallback.length, 1, '失败的那条退到本地兜底')
  assert.ok(viaFallback[0].content.includes('第 3 条'), '兜底的那条正是内容里含 P3 的发言')
  assert.equal(outcome.added.length, 5, '一条失败不得丢掉内容')
})

test('collectWithConcurrency：并发 3 明显快于串行（微基准，阈值刻意宽松）', async () => {
  // 这条把"串行改并发"的**收益**也变成可观测的，而不只是断言形状。阈值刻意宽松
  // （只要求并发比串行快 30% 以上），避免在繁忙机器上变成随机失败。
  const N = 9
  const DELAY = 12
  const work = async () => { await new Promise((resolve) => { setTimeout(resolve, DELAY) }) }
  const items = Array.from({ length: N }, (_, index) => index)

  const t0 = Date.now()
  await collectWithConcurrency(items, 1, work)
  const serial = Date.now() - t0

  const t1 = Date.now()
  await collectWithConcurrency(items, 3, work)
  const parallel = Date.now() - t1

  assert.equal(parallel < serial * 0.7, true,
    `并发 3 (${parallel}ms) 应明显快于串行 (${serial}ms)：理论上有界并发把 N×delay 压到约 N/3×delay`)
})

/* ------------------------------------------------------------------ *
 * collectDefects
 * ------------------------------------------------------------------ */

test('collectDefects：无 LLM 时走本地标记切分，不记 splitAttempts', async () => {
  const outcome = await collectDefects({
    record: baseRecord(),
    transcript: [utterance()],
    malformed: 0,
    splitConfig,
  })
  assert.equal(outcome.added.length, 1)
  assert.equal(outcome.splitAttempts, 0)
  assert.equal(outcome.added[0].dimension, '安全')
  assert.equal(outcome.added[0].status, 'pending')
  assert.equal(outcome.added[0].expertKey, '安全')
})

test('collectDefects：auto-capture 与行首进度叙述被拦下，真缺陷不受影响', async () => {
  const outcome = await collectDefects({
    record: baseRecord(),
    transcript: [
      utterance({ id: 'u1', kind: 'auto-capture' }),
      utterance({ id: 'u2', content: '[当前状态] 已收到主持人任务，完成对 17 项清单的审查。' }),
      utterance({ id: 'u3', content: '观点 1（指向 A，维度安全）：真正的缺陷在这里，需要处理。' }),
    ],
    malformed: 0,
    splitConfig,
  })
  assert.equal(outcome.skippedNoise, 2)
  assert.equal(outcome.added.length, 1)
})

test('collectDefects：只收本轮（pass 不匹配的跳过且不计噪音）', async () => {
  const outcome = await collectDefects({
    record: baseRecord({ reviewPass: 2 }),
    transcript: [utterance({ pass: 1 })],
    malformed: 0,
    splitConfig,
  })
  assert.equal(outcome.added.length, 0)
  assert.equal(outcome.skippedNoise, 0)
})

test('collectDefects：幂等 —— 已收集过的 utteranceId 直接跳过', async () => {
  const record = baseRecord()
  const first = await collectDefects({ record, transcript: [utterance()], malformed: 0, splitConfig })
  assert.equal(first.added.length, 1)

  applyCollected(record, first.added)
  const second = await collectDefects({ record, transcript: [utterance()], malformed: 0, splitConfig })
  assert.equal(second.added.length, 0)
  assert.equal(second.alreadyCollected, 1)
})

test('collectDefects：上一轮被驳回的同一观点不再弹出（D8 的唯一历史用法）', async () => {
  const record = baseRecord()
  record.defects = [{
    id: 'old', utteranceId: 'old', expertKey: '安全',
    content: '密钥硬编码在源码里，需要移到环境变量',
    dimension: '安全', status: 'rejected', rejectReason: '已确认过', ts: 1, seq: 1,
  }]
  const outcome = await collectDefects({ record, transcript: [utterance()], malformed: 0, splitConfig })
  assert.equal(outcome.droppedDuplicates, 1)
  assert.equal(outcome.added.length, 0)
})

test('collectDefects：复审轮不新增缺陷（那一轮只核对旧账）', async () => {
  const record = baseRecord({
    reviewPass: 2,
    history: [{
      pass: 1, subject: 's', stanceText: '', dimensions: ['安全'], intensity: 'standard',
      finishedAt: 1,
      defects: [{ id: 'keep', utteranceId: 'k', expertKey: '安全', content: '旧账', dimension: '安全', status: 'endorsed', ts: 1, seq: 1 }],
    }],
  })
  const outcome = await collectDefects({ record, transcript: [utterance()], malformed: 0, splitConfig })
  assert.equal(outcome.added.length, 0)
  assert.equal(outcome.droppedDuplicates, 0, '不是被判重，而是复审轮本就不收新缺陷')
})

test('collectDefects：没有固定标记的发言整条兜底（seq = 0，宁可粗也不丢）', async () => {
  const outcome = await collectDefects({
    record: baseRecord(),
    transcript: [utterance({ content: '这里没有任何观点标记，但确实是一条需要被裁决的缺陷描述。' })],
    malformed: 0,
    splitConfig,
  })
  assert.equal(outcome.added.length, 1)
  assert.equal(outcome.added[0].seq, 0)
  assert.equal(outcome.added[0].dimensionFallback, true)
  assert.equal(outcome.added[0].dimension, '安全', '兜底维度取本次采用的第一个')
})

test('collectDefects：坏行数原样带回（不许静默吞掉）', async () => {
  const outcome = await collectDefects({
    record: baseRecord(),
    transcript: [],
    malformed: 3,
    splitConfig,
  })
  assert.equal(outcome.malformedLines, 3)
})

test('applyCollected：并入缺陷并把条数分派给对应专家', () => {
  const record = baseRecord()
  record.experts = [
    { key: '安全', dimension: '安全', status: 'done', defectCount: 0 },
    { key: '性能', dimension: '性能', status: 'done', defectCount: 0 },
  ]
  applyCollected(record, [{
    id: 'd1', utteranceId: 'u1', expertKey: '安全', content: 'x', dimension: '安全',
    status: 'pending', ts: 1, seq: 1,
  }])
  assert.equal(record.defects.length, 1)
  assert.equal(record.experts[0].defectCount, 1)
  assert.equal(record.experts[1].defectCount, 0)
})

/* ------------------------------------------------------------------ *
 * A5：阵容成员的半配置路由
 * ------------------------------------------------------------------ */

test('planExperts：只填 provider 的成员不再被整条丢弃（半配置是合法输入）', () => {
  // 这条断言守的是一个真实缺陷：此前 provider 与 model 必须**成对**才写入，于是
  // 用户"只填了 provider"的阵容成员被整条静默丢弃 —— 界面上什么都没发生、也没有
  // 任何提示，而 `AgentOptions` 的 provider?/model? 本来就是各自独立可选的。
  const experts = planExperts(baseRecord(), 7, [{ key: '安全', provider: 'deepseek-official' }])
  const secure = experts.find((expert) => expert.key === '安全')
  assert.equal(secure.provider, 'deepseek-official', 'provider 有就写')
  assert.equal(secure.model, undefined, '没有 model 就保持缺席（不许拿默认值编造）')
  const other = experts.find((expert) => expert.key === '性能')
  assert.equal(other.provider, undefined, '没配到的维度照旧什么都不写')
})

test('planExperts：只填 model 的成员同样写入（不再要求成对）', () => {
  const experts = planExperts(baseRecord(), 7, [{ key: '安全', model: 'deepseek-flash' }])
  const secure = experts.find((expert) => expert.key === '安全')
  assert.equal(secure.model, 'deepseek-flash')
  assert.equal(secure.provider, undefined, '没有 provider 就不写 —— 补齐发生在 members.ts（要能写回记录）')
})

test('planExperts：provider 与 model 都填时两者都写入，并去空白', () => {
  const experts = planExperts(baseRecord(), 7, [{
    key: '安全', provider: ' p1 ', model: ' m1 ',
  }])
  const secure = experts.find((expert) => expert.key === '安全')
  assert.equal(secure.provider, 'p1')
  assert.equal(secure.model, 'm1')
})

test('planExperts：空白 provider / model 一律视为缺席（不写空串）', () => {
  const experts = planExperts(baseRecord(), 7, [{ key: '安全', provider: '   ', model: '' }])
  const secure = experts.find((expert) => expert.key === '安全')
  assert.equal(secure.provider, undefined)
  assert.equal(secure.model, undefined)
})

/* ------------------------------------------------------------------ *
 * A2：collect 的幂等
 * ------------------------------------------------------------------ */

test('applyCollected：同 id 的缺陷不重复追加，返回值是实际新增条数（A2）', () => {
  // 这是 collect 幂等的**第二道闸**（第一道是 collectDefects 的 utteranceId 幂等键）。
  // 两道都需要：并发请求可以在第一道闸之后、第二道闸之前交错。
  const record = baseRecord()
  const batch = [{
    id: 'u1#1', utteranceId: 'u1', expertKey: '安全', content: '重复项', dimension: '安全',
    status: 'pending', ts: 1, seq: 1,
  }]
  assert.equal(applyCollected(record, batch), 1, '第一次追加 1 条')
  assert.equal(applyCollected(record, batch), 0, '同一批再合并一次：一条都不新增')
  assert.equal(record.defects.length, 1, '裁决面不得出现重复项')
})

test('applyCollected：部分重复时只追加新 id，并保留先到的那条', () => {
  const record = baseRecord()
  const first = {
    id: 'u1#1', utteranceId: 'u1', expertKey: '安全', content: '先到的内容', dimension: '安全',
    status: 'endorsed', ts: 1, seq: 1,
  }
  applyCollected(record, [first])
  const added = applyCollected(record, [
    { ...first, content: '后来的副本（不得顶掉已表态的那条）' },
    { id: 'u1#2', utteranceId: 'u1', expertKey: '安全', content: '真新增', dimension: '安全', status: 'pending', ts: 2, seq: 2 },
  ])
  assert.equal(added, 1, '只有新 id 被追加')
  assert.equal(record.defects.length, 2)
  assert.equal(record.defects[0].content, '先到的内容', '同 id 保留先到的实例（它的三态是用户已做出的判断）')
  assert.equal(record.defects[0].status, 'endorsed', '已表态的实例不被后来的副本重置')
})

/* ------------------------------------------------------------------ *
 * 「打穿立场」链路（strikesStance）
 *
 * 这一整段守的是一个真实缺陷：`splitUtterance` 此前**根本没有 stance 参数**，可它的
 * 提示词却要求模型判断"是否打穿立场"——拆分器被要求判断一件它看不到的信息。实测一轮
 * 15 条缺陷里有 3 位专家正文明确写了「针对立场：打穿」，落库的 strikesStance 却全是
 * false，"打穿立场"标签与优先排序从未生效。
 * ------------------------------------------------------------------ */

/** 立场原文：断言它必须逐字出现在拆分请求里。 */
const STANCE_TEXT = '我判断这个方案可以上线：① 灰度开关已经能兜住回滚；② 只在夜间发布就避开了峰值流量。'

/**
 * 会记录**收到的请求**的假 LLM（形状与 `SplitLlmLike` 一致）。
 *
 * `fakeStreamLlm` 只记调用次数与并发峰值，看不见消息体；这条链路的缺陷恰恰在消息体里
 * （立场有没有随请求交给拆分器），所以需要这个变体把 `messages` / `system` 存下来。
 */
function recordingLlm(defects) {
  const state = { requests: [] }
  return {
    state,
    llm: {
      stream(options) {
        state.requests.push({
          messages: options?.messages ?? [],
          system: options?.system ?? '',
        })
        return (async function* generate() {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', arguments: JSON.stringify({ defects }) },
          }
        })()
      },
    },
  }
}

/** 拼接一次请求里的 system + 全部 user 文本（断言提示词内容用）。 */
function requestText(request) {
  const userText = (request.messages ?? [])
    .flatMap((message) => (message?.content ?? []).map((block) => block?.text ?? ''))
    .join('\n')
  return `${request.system}\n${userText}`
}

test('splitUtterance：立场原文随请求交给拆分器（提示词不再判断它看不到的信息）', async () => {
  const { state, llm } = recordingLlm([{ content: '灰度开关只覆盖 30% 流量。', dimension: '安全' }])
  const lines = await splitUtterance(
    llm,
    splitConfig,
    '安全',
    '观点 1（指向 A，维度安全）：灰度开关的兜底范围不足。',
    ['安全', '性能'],
    STANCE_TEXT,
  )
  assert.equal(state.requests.length, 1)
  const seen = requestText(state.requests[0])
  assert.ok(seen.includes(STANCE_TEXT), '立场原文必须逐字进入拆分请求')
  assert.ok(seen.includes('立场与理由'), '请求里要有明确的「立场」段，模型才知道往哪比')
  assert.equal(lines?.length, 1)
  assert.equal(lines[0].dimension, '安全')
})

/** 空立场规则的中文表述（只在这里出现一次，避免测试自己抄错）。 */
const EMPTY_STANCE_RULE = /用户没有写立场[\s\S]{0,40}一律不得把任何一条标成打穿/

test('splitUtterance：立场为空时明说「未填写立场」，并要求一律不得标打穿', async () => {
  const { state, llm } = recordingLlm([{ content: '没有靶子就不该有打穿。', dimension: '安全' }])
  await splitUtterance(
    llm,
    splitConfig,
    '安全',
    '观点 1（指向 A，维度安全）：灰度开关的兜底范围不足。',
    ['安全'],
    '   ',
  )
  const seen = requestText(state.requests[0])
  assert.ok(seen.includes('未填写立场'), '空立场要明示，否则模型会自己编一个靶子')
  assert.ok(EMPTY_STANCE_RULE.test(state.requests[0].system), 'system 里要写死"没有立场时不得标打穿"')
})

test('collectDefects：立场从记录一路传到拆分请求（engine 调用点）', async () => {
  const { state, llm } = recordingLlm([{ content: '注意：这里刻意不回写 strikes_stance。', dimension: '安全' }])
  const record = baseRecord()
  record.stance = { text: STANCE_TEXT, origin: 'manual', updatedAt: 1 }
  const outcome = await collectDefects({
    record,
    transcript: [utterance()],
    malformed: 0,
    splitConfig,
    llm,
  })
  assert.equal(outcome.splitAttempts, 1)
  assert.ok(requestText(state.requests[0]).includes(STANCE_TEXT), 'record.stance.text 必须到达拆分器')
})

test('collectDefects：本地兜底识别「针对立场：打穿」（LLM 失败也不能丢这个信号）', async () => {
  const { llm } = fakeStreamLlm({ delayMs: 1, failOn: new Set(['打穿']) })
  const record = baseRecord()
  record.stance = { text: STANCE_TEXT, origin: 'manual', updatedAt: 1 }
  const outcome = await collectDefects({
    record,
    transcript: [utterance({
      content: '观点 1（指向 A，维度安全）：灰度开关的兜底范围不足。 证据（argument）：前提 → 推理 → 结论。 针对立场：打穿',
    })],
    malformed: 0,
    splitConfig,
    llm,
  })
  assert.equal(outcome.added.length, 1)
  assert.equal(outcome.added[0].strikesStance, true, '专家正文里写明了打穿，标签就该亮')
})

test('反例：正文写「未打穿」时不得标成打穿（"未打穿"含"打穿"三字，不能靠子串匹配）', async () => {
  const { llm } = fakeStreamLlm({ delayMs: 1, failOn: new Set(['未打穿']) })
  const record = baseRecord()
  record.stance = { text: STANCE_TEXT, origin: 'manual', updatedAt: 1 }
  const outcome = await collectDefects({
    record,
    transcript: [utterance({
      content: '观点 1（指向 A，维度安全）：灰度开关的兜底范围不足。 证据（argument）：前提 → 推理 → 结论。 针对立场：未打穿',
    })],
    malformed: 0,
    splitConfig,
    llm,
  })
  assert.equal(outcome.added.length, 1)
  assert.notEqual(outcome.added[0].strikesStance, true, '方向整个反过来就是这条断言要防的事')
  assert.equal(stanceMarkerStrikes('针对立场：未打穿'), false)
  assert.equal(stanceMarkerStrikes('针对立场：打穿'), true)
  assert.equal(stanceMarkerStrikes('针对立场：未 打穿'), false)
  assert.equal(stanceMarkerStrikes('这里只是提到打穿两个字，没有标记'), false)
})

test('本地兜底：只标写明了打穿的那一条，不把结论漏给后面每一条', async () => {
  const content = '观点 1（指向 A，维度安全）：第一条缺陷正文。 针对立场：打穿'
    + ' 观点 2（指向 B，维度安全）：第二条缺陷正文。 针对立场：未打穿'
  const lines = splitByMarkers(content, ['安全'])
  assert.equal(lines?.length, 2)
  assert.equal(lines[0].strikesStance, true)
  assert.equal(lines[1].strikesStance, undefined, '同一段发言里"打穿"不得外溢到下一条')
})

test('splitUtterance：LLM 结果漏标打穿时，专家正文里写明的结论仍然生效（只加不删）', async () => {
  // 防御性断言：专家报告里的 `针对立场：` 是比模型转述更硬的证据（信封格式固定）。
  // 模型漏标时只**补**成 true；模型自己标 true 的路径不受影响。
  const { llm } = recordingLlm([{ content: '缺陷正文。 针对立场：打穿', dimension: '安全' }])
  const lines = await splitUtterance(
    llm,
    splitConfig,
    '安全',
    '观点 1（指向 A，维度安全）：缺陷正文。 针对立场：打穿',
    ['安全'],
    STANCE_TEXT,
  )
  assert.equal(lines?.[0].strikesStance, true)
})

test('splitUtterance：模型标了打穿就照收（专家标记缺席也不许被本地判否覆盖）', async () => {
  const { llm } = recordingLlm([{ content: '缺陷正文（专家没写立场结论）。', dimension: '安全', strikes_stance: true }])
  const lines = await splitUtterance(
    llm,
    splitConfig,
    '安全',
    '观点 1（指向 A，维度安全）：缺陷正文（专家没写立场结论）。',
    ['安全'],
    STANCE_TEXT,
  )
  assert.equal(lines?.[0].strikesStance, true)
})
