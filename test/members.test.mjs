/**
 * 专家生命周期单测：路由决定（A5 + B3）与 persona 落盘（A1）。
 *
 * 这两件事都必须**可单测**，因为它们的缺陷形态都是"静默"的：
 * - 路由写回错了，界面显示的模型名与实际跑的不是同一个，而两边都不报错；
 * - persona 没落盘（或落了却被净化层丢掉），"查看原提示词"会显示一份**现场重建**
 *   出来的文本 —— 它看起来完全正常，只是不是原文。
 *
 * 用最小假 `ctx.subagents`（`spawnExpert` 只用到 provider 探测 + startContinuable），
 * 因此不需要真实宿主。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveExpertRoute, spawnExpert } from '../src/members.ts'
import { newRecord, readRecord, writeRecord } from '../src/review.ts'

/** 假 ctx：`spawnExpert` 只碰 logger 与 subagents。
 *  注意职责分裂：provider 探测走 `getProvider()`，真正的拉起走 `ctx.subagents.startContinuable`。 */
function fakeCtx(provider) {
  return {
    logger: { warn() {} },
    subagents: {
      getProvider: () => provider,
      list: () => ['spawn'],
      startContinuable: (options) => provider.startContinuable(options),
    },
  }
}

/** 假 provider：只实现 `spawnExpert` 真正探测/调用的那几个成员。 */
function fakeProvider(overrides = {}) {
  return {
    capabilities: { persona: true, toolFilter: true },
    prepareContinuable: () => {},
    startContinuable: async () => ({ childId: 'child-1' }),
    ...overrides,
  }
}

function record() {
  return newRecord({
    reviewId: 'x-members',
    title: '某方案',
    content: '正文',
    source: 'manual',
    dimensions: ['安全', '性能'],
    intensity: 'standard',
    maxRounds: 6,
    maxTokens: 150000,
  })
}

function expert(overrides = {}) {
  return { key: '安全', dimension: '安全', status: 'pending', defectCount: 0, ...overrides }
}

const CONFIG = { provider: 'spawn', defaultProvider: 'deepseek-official', defaultModel: 'deepseek-flash' }

/** 跑一次 spawnExpert，并把下发给宿主的那份 request 抓回来。 */
async function spawnCapturing(config, expertSpec, limits = { maxOpinions: 3 }) {
  const captured = { options: undefined }
  const provider = fakeProvider({
    startContinuable: async (options) => {
      captured.options = options
      return { childId: 'child-1' }
    },
  })
  const target = expert(expertSpec)
  const record_ = record()
  const childId = await spawnExpert(
    fakeCtx(provider),
    { ...CONFIG, ...config },
    record_,
    target,
    {},
    new AbortController().signal,
    limits,
  )
  return { captured, target, record: record_, childId }
}

/* ------------------------------------------------------------------ *
 * B3 / A5：resolveExpertRoute —— 四种组合都必须有确定行为
 * ------------------------------------------------------------------ */

test('resolveExpertRoute：provider + model 都给了 → 记录与下发逐字段一致', () => {
  assert.deepEqual(
    resolveExpertRoute({ provider: 'p', model: 'm' }, { defaultProvider: 'dp', defaultModel: 'dm' }),
    { provider: 'p', model: 'm', agentOptions: { provider: 'p', model: 'm' } },
  )
})

test('resolveExpertRoute：只给 provider → 下发只带 provider，**不拿默认 model 顶替**', () => {
  // 这是 A5 的核心：旧实现把记录写成 defaultProvider + defaultModel，界面于是显示
  // "跑 A"、实际跑的是 B。现在只给 provider 时记录的 model 保持缺席 —— 那是诚实的
  // "不知道"（provider 自会选它的默认模型，我们没有任何依据知道是哪一个）。
  assert.deepEqual(
    resolveExpertRoute({ provider: 'p' }, { defaultProvider: 'dp', defaultModel: 'dm' }),
    { provider: 'p', agentOptions: { provider: 'p' } },
  )
})

test('resolveExpertRoute：只给 model → 补默认 provider，且补上的那个写回记录', () => {
  assert.deepEqual(
    resolveExpertRoute({ model: 'm' }, { defaultProvider: 'dp', defaultModel: 'dm' }),
    { provider: 'dp', model: 'm', agentOptions: { provider: 'dp', model: 'm' } },
  )
})

test('resolveExpertRoute：都没给 → agentOptions 为空（真继承），记录写宿主默认路由', () => {
  // 唯一一处刻意的不对称：纯继承时**不替宿主做决定**（真正的继承必须保持是继承），
  // 而记录写的是配置里声明的"继承主持人时实际生效的模型路由" —— 只为把"继承"画成
  // 真实品牌块（否则头像永远是中性灰 `?`，那是用户报过的缺陷）。
  assert.deepEqual(
    resolveExpertRoute({}, { defaultProvider: 'dp', defaultModel: 'dm' }),
    { provider: 'dp', model: 'dm', agentOptions: {} },
  )
})

test('resolveExpertRoute：取不到生效值的字段一律不写（不编造 provider / model）', () => {
  assert.deepEqual(resolveExpertRoute({ model: 'm' }, {}), { model: 'm', agentOptions: { model: 'm' } })
  assert.deepEqual(resolveExpertRoute({}, {}), { agentOptions: {} })
})

test('resolveExpertRoute：空串与纯空白等同于缺席', () => {
  assert.deepEqual(
    resolveExpertRoute({ provider: '   ', model: '' }, { defaultProvider: 'dp', defaultModel: 'dm' }),
    { provider: 'dp', model: 'dm', agentOptions: {} },
  )
})

/* ------------------------------------------------------------------ *
 * A5：spawnExpert 把路由真的交给宿主，并**原样**写回记录
 * ------------------------------------------------------------------ */

test('spawnExpert：只给 provider 时下发与写回一致，model 保持缺席', async () => {
  const { captured, target } = await spawnCapturing({}, { provider: 'p-only' })
  assert.deepEqual(captured.options.request.agentOptions, { provider: 'p-only' })
  assert.equal(target.provider, 'p-only')
  assert.equal(target.model, undefined, '不得用 config.defaultModel 顶替（记录必须等于真正下发的值）')
})

test('spawnExpert：只给 model 时补上的 provider 同时进 agentOptions 与记录', async () => {
  const { captured, target } = await spawnCapturing({}, { model: 'm-only' })
  assert.deepEqual(captured.options.request.agentOptions, { provider: 'deepseek-official', model: 'm-only' })
  assert.equal(target.provider, 'deepseek-official', '补上的 provider 必须写回记录（否则界面说跑 A、实际跑 B）')
  assert.equal(target.model, 'm-only')
})

test('spawnExpert：两者都给时逐字段一致', async () => {
  const { captured, target } = await spawnCapturing({}, { provider: 'p', model: 'm' })
  assert.deepEqual(captured.options.request.agentOptions, { provider: 'p', model: 'm' })
  assert.equal(target.provider, 'p')
  assert.equal(target.model, 'm')
})

test('spawnExpert：纯继承时不传 agentOptions，但把生效路由写回记录（可观测性）', async () => {
  const { captured, target } = await spawnCapturing({}, {})
  assert.equal(captured.options.request.agentOptions, undefined, '真继承 = 完全不干预路由')
  assert.equal(target.provider, 'deepseek-official')
  assert.equal(target.model, 'deepseek-flash')
})

test('spawnExpert：maxTokens 只在整个 agentOptions 为空时才单独出现', async () => {
  const { captured } = await spawnCapturing({}, {}, { maxTokens: 4096, maxOpinions: 3 })
  assert.deepEqual(captured.options.request.agentOptions, { maxTokens: 4096 })
})

/* ------------------------------------------------------------------ *
 * A1：persona 的下发 = 落盘（逐字）
 * ------------------------------------------------------------------ */

test('spawnExpert：下发给宿主的 persona 与落盘的是同一次调用的返回值（A1）', async () => {
  const { captured, target, childId } = await spawnCapturing({}, { role: '只盯密钥轮换' })
  assert.equal(childId, 'child-1')
  assert.equal(typeof captured.options.request.persona, 'string')
  assert.ok(captured.options.request.persona.includes('红队专家'), 'persona 真的生成了')
  assert.equal(
    target.persona,
    captured.options.request.persona,
    '落盘的必须与下发的是**同一个字符串**（不是"看起来一样"，而是同一次调用的结果）',
  )
})

test('spawnExpert 落盘的 persona 能穿过净化层读回（字段白名单必须登记 persona）', async () => {
  // 这条往返断言是 A1 的关键防线：persona 落了盘但没登记进 `sanitizeExpert()` 的
  // 显式字段白名单时，功能会**静默失效**（写进 JSON 却读不回来），除它以外没有任何
  // 断言抓得到。
  const { captured, target, record: record_ } = await spawnCapturing({}, { role: '只盯权限边界' })
  const root = await mkdtemp(join(tmpdir(), 'crossfire-members-'))
  record_.experts = [target]
  await writeRecord(root, record_)

  const reloaded = await readRecord(root, 'x-members')
  assert.equal(reloaded.experts.length, 1)
  assert.equal(
    reloaded.experts[0].persona,
    captured.options.request.persona,
    '写入 → readRecord 读回：persona 必须逐字相同',
  )
})

test('spawnExpert：拉起失败时不留 persona（不落任何状态）', async () => {
  const provider = fakeProvider({
    startContinuable: async () => {
      throw new Error('boom')
    },
  })
  const target = expert()
  await assert.rejects(
    spawnExpert(
      fakeCtx(provider),
      CONFIG,
      record(),
      target,
      {},
      new AbortController().signal,
      { maxOpinions: 3 },
    ),
    /boom/,
  )
  assert.equal(target.persona, undefined, '没发出去的 persona 不许落盘（否则"原文"是伪造的）')
})
