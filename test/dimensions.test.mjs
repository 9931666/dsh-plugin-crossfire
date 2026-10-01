/**
 * 维度归一化单测（R3）。
 *
 * 这一层是在修一个**已存在**的真实缺陷：抽样 5 份圆桌 review.json，dimension 的
 * 实值是 `维度②`×5 / `维度④`×1 / `其他`×4 / 空串×1 —— 圆圈数字被当成了维度名。
 * 所以下面的用例里，"圆圈数字必须被归一化且标 fallback"是最关键的一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPoolDimension, resolveDimension, resolveDimensions } from '../src/dimensions.ts'
import { DIMENSION_POOL } from '../src/types.ts'

const POOL = [...DIMENSION_POOL]

test('精确命中：allowed 里的字面值原样保留，且不算 fallback', () => {
  const result = resolveDimension('安全', POOL)
  assert.equal(result.dimension, '安全')
  assert.equal(result.fallback, false)
  assert.equal(result.how, 'exact')
})

test('规范化命中：空白与包裹符号差异不影响判定', () => {
  for (const raw of [' 安全 ', '「安全」', '【安全】']) {
    const result = resolveDimension(raw, POOL)
    assert.equal(result.dimension, '安全', `raw=${raw}`)
    assert.equal(result.fallback, false)
  }
})

test('同义词命中：英文与近义说法映射到池内维度', () => {
  assert.equal(resolveDimension('security', POOL).dimension, '安全')
  assert.equal(resolveDimension('性能', POOL).dimension, '性能')
  assert.equal(resolveDimension('perf', POOL).dimension, '性能')
  assert.equal(resolveDimension('无障碍', POOL).dimension, '交互')
  assert.equal(resolveDimension('回滚', POOL).dimension, '流程')
  assert.equal(resolveDimension('边界', POOL).dimension, '反例')
})

test('包含关系命中：带后缀的说法（安全风险 / 性能问题）', () => {
  const result = resolveDimension('安全风险', POOL)
  assert.equal(result.dimension, '安全')
  assert.equal(result.how, 'contains')
  assert.equal(resolveDimension('性能问题', POOL).dimension, '性能')
})

test('真实缺陷修复：圆圈数字不再被当成维度名', () => {
  for (const raw of ['维度②', '维度④', '维度2', '②']) {
    const result = resolveDimension(raw, POOL)
    assert.ok(POOL.includes(result.dimension), `${raw} → ${result.dimension} 必须落在池内`)
    assert.notEqual(result.dimension, raw)
    assert.equal(result.fallback, true, `${raw} 必须被标记为 fallback`)
  }
})

test('"其他"与空值一律归一化并标 fallback', () => {
  for (const raw of ['其他', '', '   ', undefined, null, 42, {}]) {
    const result = resolveDimension(raw, POOL)
    assert.ok(POOL.includes(result.dimension))
    assert.equal(result.fallback, true)
  }
})

test('自定义维度在 allowed 里时同样被尊重', () => {
  const allowed = [...POOL, '合规']
  assert.equal(resolveDimension('合规', allowed).dimension, '合规')
  assert.equal(resolveDimension('合规', allowed).fallback, false)
  // 不在 allowed 里时不能被选出来（否则等于放行了未采用的维度）
  assert.notEqual(resolveDimension('合规', POOL).dimension, '合规')
})

test('allowed 为空时退回固定池', () => {
  const result = resolveDimension('安全', [])
  assert.equal(result.dimension, '安全')
})

test('isPoolDimension 只认固定池字面值', () => {
  assert.equal(isPoolDimension('安全'), true)
  assert.equal(isPoolDimension('合规'), false)
  assert.equal(isPoolDimension('安全风险'), false)
})

test('resolveDimensions：去重、归一化、并上自定义维度', () => {
  const out = resolveDimensions(['安全', '安全', 'security', '合规'], ['合规', '成本'])
  assert.deepEqual(out, ['安全', '合规'].filter((item) => out.includes(item)))
  assert.ok(out.includes('安全'))
  assert.ok(out.includes('合规'))
  assert.equal(out.filter((item) => item === '安全').length, 1, '去重')
})

test('resolveDimensions：非数组/空输入退回全集（绝不留空）', () => {
  for (const raw of [undefined, null, '', 42, []]) {
    const out = resolveDimensions(raw, [])
    assert.equal(out.length, DIMENSION_POOL.length, `raw=${String(raw)}`)
  }
})

test('resolveDimensions：纯垃圾输入也不会产出空清单', () => {
  const out = resolveDimensions(['？？？', 'zzz'], [])
  assert.ok(out.length > 0)
  assert.ok(out.every((item) => typeof item === 'string' && item !== ''))
})
