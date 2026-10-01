/**
 * 快照路由条件请求（ETag / If-None-Match）的单测。
 *
 * 这一层的价值是**省传输**：卡片每秒轮询快照，而一次快照要把工作区下所有评审的
 * `review.json` 读一遍并整包重发，其中绝大多数字节从未变化（红队评审抓出的性能缺陷）。
 * 内容未变时回 304，浏览器直接用已有响应。
 *
 * 两条必须钉住的边界：
 * - **没有 `if-none-match` 时行为与从前逐字相同**（只是多一个 ETag 头）—— 这道保证
 *   让改动可以增量上线，客户端不必同时改；
 * - `cache-control` 必须是 `no-cache` 而不是 `no-store`：后者会让浏览器根本不存副本，
 *   ETag 永远不会被回传，整个机制静默失效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contentDigest, sendJsonConditional } from '../src/etag.ts'

/** 记录 writeHead / end 的最小响应替身。 */
function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) { res.status = status; res.headers = headers },
    end(body) { res.body = body },
  }
  return res
}

test('contentDigest：同样的内容得到同样的摘要，不同内容不同', () => {
  assert.equal(contentDigest('{"a":1}'), contentDigest('{"a":1}'))
  assert.notEqual(contentDigest('{"a":1}'), contentDigest('{"a":2}'))
})

test('首次请求（无 if-none-match）：200 + ETag，body 与输入逐字一致', () => {
  const res = fakeRes()
  const payload = { reviews: [{ reviewId: 'x-1' }] }
  sendJsonConditional({}, res, payload)
  assert.equal(res.status, 200)
  assert.equal(res.body, JSON.stringify(payload), 'body 必须原样')
  assert.match(res.headers.etag, /^"[0-9a-f]{40}"$/, 'ETag 是带引号的 sha1')
  assert.equal(res.headers['cache-control'], 'no-cache',
    'no-cache 而非 no-store：后者会让浏览器不存副本，ETag 永远回不来')
})

test('带相同 ETag 的二次请求：304，且不重发 body', () => {
  const first = fakeRes()
  const payload = { reviews: [{ reviewId: 'x-1' }] }
  sendJsonConditional({}, first, payload)

  const second = fakeRes()
  sendJsonConditional({ 'if-none-match': first.headers.etag }, second, payload)
  assert.equal(second.status, 304)
  assert.equal(second.body, undefined, '304 不得带 body')
  assert.equal(second.headers.etag, first.headers.etag, '304 也要回 ETag（便于再次校验）')
})

test('内容变化后：即使带着旧 ETag 也必须回 200 + 新内容（绝不发陈旧数据）', () => {
  const before = fakeRes()
  const p1 = { reviews: [{ reviewId: 'x-1' }] }
  sendJsonConditional({}, before, p1)

  const after = fakeRes()
  const p2 = { reviews: [{ reviewId: 'x-1' }, { reviewId: 'x-2' }] }
  sendJsonConditional({ 'if-none-match': before.headers.etag }, after, p2)
  assert.equal(after.status, 200, '内容变了就必须发新数据')
  assert.equal(after.body, JSON.stringify(p2))
  assert.notEqual(after.headers.etag, before.headers.etag, '新内容的 ETag 必须不同')
})

test('if-none-match 支持逗号分隔列表与空白', () => {
  const probe = fakeRes()
  sendJsonConditional({}, probe, { ok: true })
  const etag = probe.headers.etag

  for (const header of [`"other", ${etag}`, `"other",${etag}`, `  ${etag}  `]) {
    const res = fakeRes()
    sendJsonConditional({ 'if-none-match': header }, res, { ok: true })
    assert.equal(res.status, 304, `应命中：${JSON.stringify(header)}`)
  }
})

test('if-none-match 为通配 * 或不相干值时回 200（保守：宁可多发也不发错）', () => {
  for (const header of ['*', '"nope"', '']) {
    const res = fakeRes()
    sendJsonConditional({ 'if-none-match': header }, res, { ok: true })
    assert.equal(res.status, 200, `不应命中 304：${JSON.stringify(header)}`)
  }
})

test('if-none-match 是数组形式（重复头）时也能处理', () => {
  const probe = fakeRes()
  sendJsonConditional({}, probe, { ok: true })
  const res = fakeRes()
  sendJsonConditional({ 'if-none-match': ['"nope"', probe.headers.etag] }, res, { ok: true })
  assert.equal(res.status, 304)
})

test('自定义状态码被透传（供非 200 的成功路径复用）', () => {
  const res = fakeRes()
  sendJsonConditional({}, res, { ok: true }, 201)
  assert.equal(res.status, 201)
})
