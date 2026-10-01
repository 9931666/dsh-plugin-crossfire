/**
 * RPC 身份判定的测试。
 *
 * 这里守护的是一个**真实发生过的安全缺陷**：会话 id 在本插件里同时是凭据和权限
 * （`load()` 用它校验归属，`review.advance` 又用它换 live Agent 拉专家）。原先把
 * 空会话当作"跳过校验"，于是客户端没送 session 时，归属校验整条短路，而 attack
 * 又会退回用记录里的 owner 换 Agent —— 一条能真正拉起专家的越权通道，且成功响应
 * 与合法调用完全同形。
 *
 * 这些用例把规则钉死在纯函数上，因此下一次改动不可能静默地把它打回去。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeActor } from '../src/rpc.ts'

test('空会话一律拒绝 —— 它是越权通道的入口', () => {
  const verdict = judgeActor('session-a', '')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'no-actor')
  assert.match(verdict.message, /reload the page/)
})

test('空会话 + 记录没有 owner 也拒绝（不能因为缺少校验数据就放行）', () => {
  assert.equal(judgeActor(undefined, '').ok, false)
  assert.equal(judgeActor('', '').ok, false)
})

test('owner 与会话一致：放行并标记已绑定', () => {
  assert.deepEqual(judgeActor('session-a', 'session-a'), { ok: true, bound: true })
})

test('声称别的会话：拒绝（跨会话操作）', () => {
  const verdict = judgeActor('session-a', 'session-b')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'foreign-owner')
  assert.match(verdict.message, /another session/)
})

test('记录没有 owner（早期数据）：放行但标记未绑定', () => {
  assert.deepEqual(judgeActor(undefined, 'session-a'), { ok: true, bound: false })
  assert.deepEqual(judgeActor('', 'session-a'), { ok: true, bound: false })
})

test('判定是纯函数：同样输入永远同样输出', () => {
  const first = judgeActor('session-a', 'session-b')
  const second = judgeActor('session-a', 'session-b')
  assert.deepEqual(first, second)
})
