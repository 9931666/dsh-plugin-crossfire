/**
 * 数据层单测：构造、净化、去重、复审递进、三态门禁。
 *
 * 重点覆盖三条契约：
 * 1. **脏数据必须被收敛成可用记录**（界面宁可由空列表组成，也不能整张卡消失）；
 * 2. **落库维度必须 ∈ 本次采用维度**（越界者归一化并留 fallback 标记）；
 * 3. **历史只用于去重与递进**（D8），绝不做用户画像。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRecheckItems,
  countDefects,
  dropRejectedDuplicates,
  isSameDefect,
  knownFlaws,
  lastEndorsedDefects,
  newRecord,
  normalizeRecord,
  readRecord,
  rejectedContents,
  setDefectStatus,
  writeRecord,
} from '../src/review.ts'
import { DIMENSION_POOL, INTENSITY_SPECS } from '../src/types.ts'

const POOL = [...DIMENSION_POOL]

/** 造一条缺陷。 */
function defect(overrides = {}) {
  return {
    id: 'd1',
    utteranceId: 'u1',
    expertKey: '安全',
    content: '密钥硬编码在源码里。',
    dimension: '安全',
    status: 'pending',
    ts: 1,
    seq: 1,
    ...overrides,
  }
}

async function tempRoot() {
  return await mkdtemp(join(tmpdir(), 'crossfire-review-'))
}

test('newRecord：draft / 第 1 轮 / 复审上限由强度档决定', () => {
  const record = newRecord({
    reviewId: 'x-test',
    title: '某方案',
    content: '正文',
    source: 'manual',
    dimensions: ['安全', '性能'],
    intensity: 'deep',
    maxRounds: 6,
    maxTokens: 150000,
    ownerSessionId: 'sess-1',
  })
  assert.equal(record.status, 'draft')
  assert.equal(record.reviewPass, 1)
  assert.equal(record.maxReviewPass, INTENSITY_SPECS.deep.maxReviewPass)
  assert.deepEqual(record.dimensions, ['安全', '性能'])
  assert.equal(record.ownerSessionId, 'sess-1')
  assert.deepEqual(record.defects, [])
  assert.deepEqual(record.experts, [])
})

test('newRecord：空维度退回固定池全集（绝不留空）', () => {
  const record = newRecord({
    reviewId: 'x-test', title: 't', content: 'c', source: 'manual',
    dimensions: [], intensity: 'quick', maxRounds: 1, maxTokens: 1000,
  })
  assert.equal(record.dimensions.length, DIMENSION_POOL.length)
})

test('normalizeRecord：垃圾输入也产出可用记录', () => {
  for (const raw of [null, undefined, 42, 'string', [], { defects: 'not-an-array' }]) {
    const record = normalizeRecord(raw, 'x-dir')
    assert.equal(record.reviewId, 'x-dir')
    assert.equal(record.schemaVersion, 1)
    assert.equal(record.status, 'draft')
    assert.deepEqual(record.defects, [])
    assert.deepEqual(record.experts, [])
    assert.ok(record.dimensions.length > 0)
    assert.equal(typeof record.subject.title, 'string')
  }
})

test('normalizeRecord：越界维度被归一化并标 fallback', () => {
  const record = normalizeRecord({
    dimensions: ['安全'],
    defects: [defect({ dimension: '维度②' }), defect({ id: 'd2', dimension: '性能' })],
  }, 'x-dir')
  assert.equal(record.defects[0].dimension, '安全')
  assert.equal(record.defects[0].dimensionFallback, true, '越界维度必须有可见标记')
  assert.equal(record.defects[1].dimension, '安全', '不在本次采用清单里的维度也要归一化')
  assert.equal(record.defects[1].dimensionFallback, true)
})

test('normalizeRecord：内容为空的缺陷被丢弃，其余保留', () => {
  const record = normalizeRecord({
    dimensions: ['安全'],
    defects: [defect(), { id: 'x', content: '   ' }, null, 'nope'],
  }, 'x-dir')
  assert.equal(record.defects.length, 1)
})

test('normalizeRecord：三态只认三个合法值', () => {
  const record = normalizeRecord({
    dimensions: ['安全'],
    defects: [
      defect({ id: 'a', status: 'endorsed' }),
      defect({ id: 'b', status: 'rejected', rejectReason: '不成立' }),
      defect({ id: 'c', status: '胡说' }),
    ],
  }, 'x-dir')
  assert.equal(record.defects[0].status, 'endorsed')
  assert.equal(record.defects[1].status, 'rejected')
  assert.equal(record.defects[1].rejectReason, '不成立')
  assert.equal(record.defects[2].status, 'pending', '非法状态退回 pending')
})

test('isSameDefect：完全相同即同一条（哪怕很短），部分包含才要长度门槛', () => {
  assert.equal(isSameDefect('密钥硬编码在源码里', '密钥硬编码在源码里。'), true, '仅标点差异')
  assert.equal(isSameDefect('密钥硬编码在源码里，需要移到环境变量', '密钥硬编码在源码里'), true, '长句包含短句')
  // 完全相同的短句仍是同一条：用户驳回过"缺日志"，就不该第二次弹出来。
  assert.equal(isSameDefect('缺日志', '缺日志'), true)
  // 但"短句包含"不判重：否则"缺日志"会吞掉同族但不同的缺陷。
  assert.equal(isSameDefect('缺日志', '缺日志且没有轮转机制'), false)
  assert.equal(isSameDefect('', '任何内容'), false)
})

test('dropRejectedDuplicates：上轮被驳回的观点不再重复出现', () => {
  const candidates = [
    defect({ id: 'n1', content: '密钥硬编码在源码里，需要移到环境变量' }),
    defect({ id: 'n2', content: '缺少回滚预案，发布失败后无法恢复' }),
  ]
  const { kept, dropped } = dropRejectedDuplicates(candidates, ['密钥硬编码在源码里'])
  assert.equal(dropped, 1)
  assert.deepEqual(kept.map((item) => item.id), ['n2'])
})

test('dropRejectedDuplicates：没有历史时原样返回', () => {
  const candidates = [defect()]
  assert.deepEqual(dropRejectedDuplicates(candidates, []).kept.length, 1)
})

test('countDefects / knownFlaws：统计与产出清单', () => {
  const record = normalizeRecord({
    dimensions: ['安全'],
    defects: [
      defect({ id: 'a', status: 'endorsed' }),
      defect({ id: 'b', status: 'rejected', rejectReason: 'x' }),
      defect({ id: 'c', status: 'pending' }),
      defect({ id: 'd', status: 'endorsed', strikesStance: true }),
    ],
  }, 'x-dir')
  const counts = countDefects(record)
  assert.deepEqual(counts, { total: 4, pending: 1, endorsed: 2, rejected: 1, strikes: 1 })
  assert.deepEqual(knownFlaws(record).map((item) => item.id), ['a', 'd'])
})

test('rejectedContents：历史与本轮的驳回都算进去', () => {
  const record = normalizeRecord({
    dimensions: ['安全'],
    defects: [defect({ id: 'now', status: 'rejected', rejectReason: '本轮否掉' })],
    history: [{
      pass: 1,
      subject: 's',
      stanceText: '',
      dimensions: ['安全'],
      intensity: 'standard',
      finishedAt: 1,
      defects: [defect({ id: 'old', content: '历史里被否掉的观点', status: 'rejected', rejectReason: '旧' })],
    }],
  }, 'x-dir')
  const contents = rejectedContents(record)
  assert.equal(contents.length, 2)
  assert.ok(contents.includes('历史里被否掉的观点'))
})

test('buildRecheckItems：只取上一轮已认定项，且**不预置结论**', () => {
  const record = normalizeRecord({
    dimensions: ['安全'],
    reviewPass: 2,
    defects: [],
    history: [{
      pass: 1,
      subject: 's',
      stanceText: '',
      dimensions: ['安全'],
      intensity: 'standard',
      finishedAt: 1,
      defects: [
        defect({ id: 'keep', status: 'endorsed' }),
        defect({ id: 'skip', status: 'rejected', rejectReason: 'x' }),
        defect({ id: 'skip2', status: 'pending' }),
      ],
    }],
  }, 'x-dir')
  assert.deepEqual(lastEndorsedDefects(record).map((item) => item.id), ['keep'])
  const items = buildRecheckItems(record)
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'keep')
  // 回归防线（红队评审抓出的缺陷）：开轮时**刻意不写 verdict**。此前写死
  // `'unfixed'`，于是复审轮一打开，"未修复"就已经是高亮选中态，而备注框旁的保存
  // 按钮会把这个机器默认值当作人的表态提交 —— 结论本该只能由人下。
  assert.deepEqual(items[0].recheck, { pass: 1 })
  assert.equal('verdict' in items[0].recheck, false, 'verdict 不能在开轮时被机器预置')
  assert.equal(items[0].status, 'endorsed')
})

test('sanitizeRecheck：读盘时不得把"未判断"改写成"未修复"', () => {
  // 同一缺陷的另一半：此前 sanitizeRecheck 把任何非 fixed/partial 的值都归一成
  // 'unfixed'，所以人还没判断的状态每读一次盘就被机器改写成"人判定为未修复"。
  const record = normalizeRecord({
    dimensions: ['安全'],
    reviewPass: 2,
    defects: [
      { id: 'a', expertKey: '安全', dimension: '安全', content: 'c1', status: 'endorsed', ts: 1, seq: 1, recheck: { pass: 1 } },
      { id: 'b', expertKey: '安全', dimension: '安全', content: 'c2', status: 'endorsed', ts: 1, seq: 2, recheck: { pass: 1, verdict: 'bogus' } },
      { id: 'c', expertKey: '安全', dimension: '安全', content: 'c3', status: 'endorsed', ts: 1, seq: 3, recheck: { pass: 1, verdict: 'fixed', note: '已改' } },
    ],
  }, 'x-dir')
  const byId = new Map(record.defects.map((item) => [item.id, item]))
  assert.deepEqual(byId.get('a').recheck, { pass: 1 }, '缺席必须保持缺席')
  assert.deepEqual(byId.get('b').recheck, { pass: 1 }, '非法值不能变成 unfixed')
  assert.deepEqual(byId.get('c').recheck, { pass: 1, verdict: 'fixed', note: '已改' }, '合法值原样保留')
})

test('setDefectStatus：驳回必须给理由（数据层强制）', async () => {
  const stateRoot = await tempRoot()
  const reviewId = 'x-lock'
  const record = newRecord({
    reviewId, title: 't', content: 'c', source: 'manual',
    dimensions: ['安全'], intensity: 'quick', maxRounds: 1, maxTokens: 1000,
  })
  record.defects = [defect()]
  record.status = 'judging'
  await writeRecord(stateRoot, record)

  await assert.rejects(
    () => setDefectStatus(stateRoot, reviewId, 'd1', 'rejected', '   '),
    /requires a non-empty reason/,
  )
})

test('setDefectStatus：三态可互切，驳回理由改回后仍保留', async () => {
  const stateRoot = await tempRoot()
  const reviewId = 'x-three'
  const record = newRecord({
    reviewId, title: 't', content: 'c', source: 'manual',
    dimensions: ['安全'], intensity: 'quick', maxRounds: 1, maxTokens: 1000,
  })
  record.defects = [defect()]
  record.status = 'judging'
  await writeRecord(stateRoot, record)

  assert.equal(await setDefectStatus(stateRoot, reviewId, 'd1', 'endorsed'), true)
  assert.equal((await readRecord(stateRoot, reviewId)).defects[0].status, 'endorsed')
  assert.equal(await setDefectStatus(stateRoot, reviewId, 'd1', 'endorsed'), false, '同状态不算变更')

  assert.equal(await setDefectStatus(stateRoot, reviewId, 'd1', 'rejected', '理由成立'), true)
  const rejected = (await readRecord(stateRoot, reviewId)).defects[0]
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.rejectReason, '理由成立')

  // 改回待定：理由**不清除**（它供追溯，清掉就再也说不出"当时为什么否"）。
  await setDefectStatus(stateRoot, reviewId, 'd1', 'pending')
  const reverted = (await readRecord(stateRoot, reviewId)).defects[0]
  assert.equal(reverted.status, 'pending')
  assert.equal(reverted.rejectReason, '理由成立')

  assert.equal(await setDefectStatus(stateRoot, reviewId, '不存在', 'endorsed'), false)
})
