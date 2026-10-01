/**
 * 预设/阵容合并规则单测。
 *
 * 这一层修的是一个**真实的静默数据丢失**：设置页编辑既有预设后保存，界面报"已保存"，
 * 但改动其实被丢掉了。链路是
 *   客户端 append 同 id 条目 → host `sanitizeRolePresets` 按 id 去重保留第一个
 *   （= 编辑前的旧值）→ 界面拿到回包里的旧值，用户的编辑无声消失。
 * 症状与"保存失败"完全不同（没有任何错误提示），所以只有断言能钉住它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergePreset, mergeSquad } from '../src/client/merge.ts'

const preset = (id, name, role) => ({ id, name, role })

test('mergePreset：新 id 追加到末尾', () => {
  const list = [preset('a', 'A', 'r')]
  const next = mergePreset(list, preset('b', 'B', 'r2'))
  assert.deepEqual(next.map((item) => item.id), ['a', 'b'])
  assert.equal(next.length, 2)
})

test('mergePreset：同 id 就地替换（编辑必须生效，且不得出现重复项）', () => {
  const list = [preset('a', 'A', 'r'), preset('b', 'B', 'r2')]
  const next = mergePreset(list, preset('a', 'A2', 'r3'))
  assert.deepEqual(next.map((item) => item.id), ['a', 'b'], '不得追加出第二个 a')
  assert.equal(next.length, 2, '长度不变 —— 追加会让同 id 出现两份')
  assert.equal(next[0].name, 'A2', '同 id 的那一项必须是**新值**')
  assert.equal(next[0].role, 'r3')
  // 位置不变：编辑不应把条目挪到末尾（否则列表顺序会在每次编辑后跳动）。
  assert.equal(next[1].name, 'B')
})

test('mergePreset：编辑文本与原值相同时也走替换路径（不产生重复）', () => {
  // 旧实现按"值是否与原值逐字相同"来选路径，这条用例专门覆盖那个判据的另一侧。
  const list = [preset('a', 'A', 'r')]
  const next = mergePreset(list, preset('a', 'A', 'r'))
  assert.equal(next.length, 1)
  assert.deepEqual(next[0], preset('a', 'A', 'r'))
})

test('mergePreset：不修改传入数组（纯函数）', () => {
  const list = [preset('a', 'A', 'r')]
  const frozen = [...list]
  mergePreset(list, preset('a', 'A2', 'r2'))
  assert.deepEqual(list, frozen, '入参必须保持不变')
})

test('mergeSquad：同 id 就地替换，新 id 追加', () => {
  const squad = (id, name, keys) => ({ id, name, members: keys.map((key) => ({ key, role: '' })) })
  const list = [squad('s1', 'S1', ['security'])]
  const replaced = mergeSquad(list, squad('s1', 'S1b', ['security', 'data']))
  assert.equal(replaced.length, 1, '不得追加出第二个 s1')
  assert.equal(replaced[0].name, 'S1b')
  assert.equal(replaced[0].members.length, 2, '成员变更必须落进那一项')
  const appended = mergeSquad(list, squad('s2', 'S2', ['data']))
  assert.deepEqual(appended.map((item) => item.id), ['s1', 's2'])
})
