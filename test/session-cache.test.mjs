/**
 * 会话身份缓存单测。
 *
 * 这几条断言守的是一个**用户实测报出的 Bug**：设置页的角色预设 / 阵容预设 /
 * 强度 / 预算**全部保存失败**。根因不在设置页的 UI，而在身份：
 * 宿主 slot 契约里 `settings.section` 的 standardProps **不含 `sessionId`**
 * （只有 conversation.view / tool.call.toolview 含），而 `crossfire/prefs.set`
 * 要求"必须声称一个身份"—— 于是设置页每一次提交都被宿主拒掉。
 *
 * 修法是把**真实**身份从卡片侧缓存过来补给设置页，而不是伪造一个。因此这里
 * 必须同时钉住两件事：缓存能正确传递身份；缓存为空时**绝不**编造身份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  knownSessionId,
  rememberSessionId,
  resetSessionIdCache,
  withSessionIdentity,
} from '../src/client/session-cache.ts'

test('缓存为空时不得编造身份（宁可让宿主按自己的规则拒绝）', () => {
  resetSessionIdCache()
  assert.equal(knownSessionId(), '')
  assert.deepEqual(withSessionIdentity({ patch: {} }), { patch: {} })
  assert.equal('session' in withSessionIdentity({ patch: {} }), false)
})

test('记下身份后，提交时自动声明它', () => {
  resetSessionIdCache()
  assert.equal(rememberSessionId('session-abc'), true)
  assert.equal(knownSessionId(), 'session-abc')
  assert.deepEqual(withSessionIdentity({ patch: { maxRounds: 7 } }), {
    patch: { maxRounds: 7 },
    session: 'session-abc',
  })
})

test('payload 自己带了 session 时不覆盖（显式优先）', () => {
  resetSessionIdCache()
  rememberSessionId('session-from-cache')
  assert.deepEqual(withSessionIdentity({ session: 'session-explicit', patch: {} }), {
    session: 'session-explicit',
    patch: {},
  })
})

test('空串 / 纯空白 / 非字符串一律视为"还没观察到"，不得写入缓存', () => {
  resetSessionIdCache()
  assert.equal(rememberSessionId(''), false)
  assert.equal(rememberSessionId('   '), false)
  assert.equal(rememberSessionId(undefined), false)
  assert.equal(rememberSessionId(null), false)
  assert.equal(rememberSessionId(42), false)
  assert.equal(knownSessionId(), '', '上面几次调用都不该留下身份')
})

test('同一个身份重复写入返回 false（供调用方避免无意义的重渲染）', () => {
  resetSessionIdCache()
  assert.equal(rememberSessionId('session-x'), true)
  assert.equal(rememberSessionId('session-x'), false)
  assert.equal(rememberSessionId('  session-x  '), false, '两侧空白不算新身份')
})

test('切换会话会替换身份（用户换了一个会话后，设置页声明的是新的那个）', () => {
  resetSessionIdCache()
  rememberSessionId('session-1')
  assert.equal(rememberSessionId('session-2'), true)
  assert.equal(knownSessionId(), 'session-2')
  assert.equal(withSessionIdentity({ patch: {} }).session, 'session-2')
})

test('withSessionIdentity 不修改传入对象（纯函数）', () => {
  resetSessionIdCache()
  rememberSessionId('session-abc')
  const original = { patch: { a: 1 } }
  const next = withSessionIdentity(original)
  assert.deepEqual(original, { patch: { a: 1 } }, '入参必须保持不变')
  assert.notEqual(next, original, '必须返回新对象而不是就地改')
})
