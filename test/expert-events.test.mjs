/**
 * 专家归属索引与宽限查询的测试。
 *
 * 这里守护的是**红队在真实评审里抓出的竞态修复**：归属索引是在 `spawnExpert`
 * 返回之后才登记的，而宿主的 `startContinuable` 文档写明它 "resolve at initial
 * idle" —— 子代理可能在那几毫秒里就已经跑完第一轮并提交发言。没有宽限查询时，
 * `crossfire_report` 会抛错、`subagent/end` 会被丢弃，代价是**丢掉一整位专家的
 * 工作**，且无法复现、无法从外部诊断。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetExpertIndexForTests,
  forgetExpertChild,
  locateExpertChild,
  locateExpertChildWithGrace,
  registerExpertChild,
} from '../src/expert-events.ts'

test('登记后立即可查；未登记返回 undefined', () => {
  __resetExpertIndexForTests()
  assert.equal(locateExpertChild('c1'), undefined)
  registerExpertChild('c1', { stateRoot: '/s', reviewId: 'x-1' })
  assert.deepEqual(locateExpertChild('c1'), { stateRoot: '/s', reviewId: 'x-1' })
})

test('空 id 不登记也不查（避免把空串当键）', () => {
  __resetExpertIndexForTests()
  registerExpertChild('', { stateRoot: '/s', reviewId: 'x-1' })
  assert.equal(locateExpertChild(''), undefined)
})

test('forgetExpertChild 之后查不到（专家被移除或拉起失败回滚）', () => {
  __resetExpertIndexForTests()
  registerExpertChild('c2', { stateRoot: '/s', reviewId: 'x-2' })
  forgetExpertChild('c2')
  assert.equal(locateExpertChild('c2'), undefined)
})

test('宽限查询：命中时走快路径，不付出等待', async () => {
  __resetExpertIndexForTests()
  registerExpertChild('c3', { stateRoot: '/s', reviewId: 'x-3' })
  const started = Date.now()
  const found = await locateExpertChildWithGrace('c3', 5000)
  assert.deepEqual(found, { stateRoot: '/s', reviewId: 'x-3' })
  assert.ok(Date.now() - started < 100, '命中不该落进等待分支')
})

test('宽限查询：窗口内迟到的登记能被查到（竞态修复的核心）', async () => {
  __resetExpertIndexForTests()
  // 模拟"子代理先发言、spawnExpert 稍后才登记"的时序
  setTimeout(() => {
    registerExpertChild('c4', { stateRoot: '/s', reviewId: 'x-4' })
  }, 30)
  const found = await locateExpertChildWithGrace('c4', 400)
  assert.deepEqual(found, { stateRoot: '/s', reviewId: 'x-4' })
})

test('宽限查询：始终没有登记时返回 undefined，且等待有上界', async () => {
  __resetExpertIndexForTests()
  const started = Date.now()
  const found = await locateExpertChildWithGrace('never-registered', 60)
  assert.equal(found, undefined)
  const waited = Date.now() - started
  assert.ok(waited >= 50, `应当等满窗口（实际 ${waited}ms）`)
  assert.ok(waited < 2000, `等待必须有上界（实际 ${waited}ms）`)
})

test('宽限查询不会把别人的归属张冠李戴', async () => {
  __resetExpertIndexForTests()
  registerExpertChild('c5', { stateRoot: '/s', reviewId: 'x-5' })
  registerExpertChild('c6', { stateRoot: '/s', reviewId: 'x-6' })
  assert.equal((await locateExpertChildWithGrace('c5', 10))?.reviewId, 'x-5')
  assert.equal((await locateExpertChildWithGrace('c6', 10))?.reviewId, 'x-6')
})
