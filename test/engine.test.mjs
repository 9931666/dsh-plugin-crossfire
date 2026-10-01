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
