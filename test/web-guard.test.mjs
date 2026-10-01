/**
 * Web 路由认证栅栏的单测。
 *
 * 这一层是**安全边界**：两条插件路由注册在宿主 `webServer` 上，而宿主不会自动施加
 * Host/Origin + 浏览器认证栅栏，必须由路由自己调 `connection.requestRejection`。
 *
 * 两个方向都必须被钉住：
 * - **不能误放行**：栅栏在场且说拒绝时，请求必须被挡下；栅栏自己抛错时按拒绝处理
 *   （安全边界不能 fail-open）。
 * - **不能永久失效**：栅栏是**每次请求实时取**的。这条修的是一个真实的 fail-open
 *   窗口 —— 路由只在第一次注册时创建且带标记位不重来，若在那一刻把栅栏快照进闭包，
 *   而当时 `connection` 尚未挂载，两条路由就会**永久**失去栅栏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionFenceOf, fenceProbe, rejectWebRequest } from '../src/web-guard.ts'

const headers = { host: '127.0.0.1:3080' }

test('rejectWebRequest：栅栏缺席时放行（最小 profile 不能因此瘫痪）', () => {
  assert.equal(rejectWebRequest(undefined, headers), undefined)
})

test('rejectWebRequest：把栅栏的判定原样转达', () => {
  assert.equal(rejectWebRequest({ requestRejection: () => 403 }, headers), 403)
  assert.equal(rejectWebRequest({ requestRejection: () => 401 }, headers), 401)
  assert.equal(rejectWebRequest({ requestRejection: () => undefined }, headers), undefined)
})

test('rejectWebRequest：栅栏抛错一律按拒绝处理（绝不 fail-open）', () => {
  const fence = {
    requestRejection: () => {
      throw new Error('boom')
    },
  }
  assert.equal(rejectWebRequest(fence, headers), 403)
})

test('connectionFenceOf：只认带 requestRejection 函数的服务', () => {
  assert.equal(connectionFenceOf(undefined), undefined)
  assert.equal(connectionFenceOf(null), undefined)
  assert.equal(connectionFenceOf({}), undefined)
  assert.equal(connectionFenceOf({ requestRejection: 'nope' }), undefined)
  const service = { requestRejection: () => 403 }
  assert.equal(connectionFenceOf(service), service)
})

test('fenceProbe：**每次调用**都重新取，栅栏后到也会立即生效', () => {
  // 这条是回归防线：把"注册时快照"变成"请求时实时取"。
  let service
  const probe = fenceProbe(() => service)
  assert.equal(probe(), undefined, '一开始没有栅栏')

  // 宿主稍后挂上 connection —— 不需要重新注册路由，下一次请求就该被拦住。
  service = { requestRejection: () => 403 }
  assert.equal(rejectWebRequest(probe(), headers), 403, '栅栏后到必须立即生效，而不是永久放行')
})

test('fenceProbe：栅栏缺席只提醒一次（避免每个请求刷一条日志）', () => {
  let warned = 0
  const probe = fenceProbe(() => undefined, () => { warned += 1 })
  probe()
  probe()
  probe()
  assert.equal(warned, 1, '只在首次缺席时留痕')
})

test('fenceProbe：栅栏在场时不提醒', () => {
  let warned = 0
  const probe = fenceProbe(() => ({ requestRejection: () => undefined }), () => { warned += 1 })
  probe()
  assert.equal(warned, 0)
})
