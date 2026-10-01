/**
 * 偏好层单测：净化、归一化、存储读写与订阅。
 *
 * 重点覆盖"非法输入不许污染既有设置"这一条 —— 一次错误的提交不能把用户的其它
 * 偏好顺手清掉，这是 `normalizePreferences(layer, base)` 用 base 而不是默认值
 * 兜底的原因。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CUSTOM_DIMENSION_MAX,
  DEFAULT_TEST_BASE,
  createPreferenceStore,
  defaultPreferences,
  effectiveDimensions,
  normalizePreferences,
  sanitizeCustomDimensions,
  sanitizeRolePresets,
  sanitizeSquads,
} from './helpers/preferences-harness.mjs'

test('sanitizeCustomDimensions 丢弃空值/超长/与固定池重名/重复', () => {
  const out = sanitizeCustomDimensions([
    '合规',        // ok
    '  ',          // 空
    '安全',        // 与固定池重名
    '合规',        // 重复
    'x'.repeat(20), // 超长
    '成本',        // ok
  ])
  assert.deepEqual(out, ['合规', '成本'])
})

test('sanitizeCustomDimensions 非数组输入返回空集', () => {
  assert.deepEqual(sanitizeCustomDimensions('不是数组'), [])
  assert.deepEqual(sanitizeCustomDimensions(null), [])
})

test('sanitizeCustomDimensions 截断到上限', () => {
  const many = Array.from({ length: CUSTOM_DIMENSION_MAX + 5 }, (_, i) => `维度${i}`)
  assert.equal(sanitizeCustomDimensions(many).length, CUSTOM_DIMENSION_MAX)
})

test('sanitizeRolePresets 丢弃缺 name/role 的条目并去重 id', () => {
  const out = sanitizeRolePresets([
    { id: 'a', name: '安全审查', role: '从安全视角挑毛病' },
    { id: 'b', name: '', role: '空名字' },
    { id: 'c', name: '有名字', role: '' },
    { id: 'a', name: '重复 id', role: '重复' },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].name, '安全审查')
})

test('sanitizeSquads 丢弃没有合法成员的阵容', () => {
  const out = sanitizeSquads([
    { id: 's1', name: '三人组', members: [{ key: 'Architect', role: '架构' }, { key: 'bad key!', role: 'x' }] },
    { id: 's2', name: '空阵容', members: [] },
  ])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].members.map((m) => m.key), ['architect'])
})

test('normalizePreferences：非法字段退回 base，而不是默认值', () => {
  const base = { ...DEFAULT_TEST_BASE, maxRounds: 42, defaultIntensity: 'deep' }
  const next = normalizePreferences({ maxRounds: -5, defaultIntensity: '胡说', maxTokens: 123 }, base)
  assert.equal(next.maxRounds, 42, '非法 maxRounds 应保留 base 值')
  assert.equal(next.defaultIntensity, 'deep', '非法强度应保留 base 值')
  assert.equal(next.maxTokens, 123, '合法字段应生效')
})

test('normalizePreferences：缺字段沿用 base，不重置', () => {
  const base = { ...DEFAULT_TEST_BASE, maxRounds: 7 }
  const next = normalizePreferences({}, base)
  assert.equal(next.maxRounds, 7)
})

test('effectiveDimensions = 固定池 + 自定义，且顺序稳定', () => {
  const prefs = { ...DEFAULT_TEST_BASE, customDimensions: ['成本'] }
  const dims = effectiveDimensions(prefs)
  assert.equal(dims[0], '安全')
  assert.equal(dims[dims.length - 1], '成本')
  assert.equal(dims.length, 8)
})

test('createPreferenceStore：写入后能读回，且 watch 收到通知', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'cf-prefs-')), 'preferences.json')
  const store = createPreferenceStore({ base: defaultPreferences('standard'), file })
  await store.ready()
  const seen = []
  const off = store.watch((value) => seen.push(value.defaultIntensity))
  await store.update({ defaultIntensity: 'deep' })
  assert.equal(store.get().defaultIntensity, 'deep')
  assert.deepEqual(seen, ['deep'])
  off()
  await store.update({ defaultIntensity: 'quick' })
  assert.deepEqual(seen, ['deep'], '退订后不应再收到通知')

  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.defaultIntensity, 'quick')
})

test('createPreferenceStore：坏 JSON 退回默认值而不是抛错', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'cf-prefs-bad-')), 'preferences.json')
  await writeFile(file, '{ 坏掉的内容', 'utf8')
  const store = createPreferenceStore({ base: defaultPreferences('quick'), file })
  await store.ready()
  assert.equal(store.get().defaultIntensity, 'quick')
  assert.deepEqual(store.get().customDimensions, [])
})

test('createPreferenceStore：并发提交串行落盘，最后一次胜出', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'cf-prefs-race-')), 'preferences.json')
  const store = createPreferenceStore({ base: defaultPreferences('standard'), file })
  await store.ready()
  await Promise.all([
    store.update({ maxRounds: 1 }),
    store.update({ maxRounds: 2 }),
    store.update({ maxRounds: 3 }),
  ])
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.maxRounds, store.get().maxRounds)
})
