/**
 * 快照路由的条件请求支持（ETag / If-None-Match）。
 *
 * ## 要解决的问题
 *
 * 卡片每秒轮询快照，而一次快照的代价是"把工作区下所有评审的 `review.json` 读一遍并
 * **整包重发**"—— 其中绝大多数字节从未变化（红队评审抓出的性能缺陷）。
 *
 * 读盘那一半只能靠减少轮询次数缓解（已做：可见性感知 + 间隔放宽）。**传输**这一半
 * 可以用 ETag 解决：内容没变时返回 `304 Not Modified`，浏览器直接把已有响应交给
 * 调用方，省掉整个响应体的传输与解析。
 *
 * ## 为什么是弱校验
 *
 * 摘要只覆盖 `JSON.stringify(payload)` 的字节。同一份内容若换了键序就会算出不同的
 * ETag —— 那只会**少省一次**传输，不会给出错误数据（宁可多发，不可发错）。
 *
 * @module @huanlin/dsh-plugin-crossfire/etag
 */

import { createHash } from 'node:crypto'

/** 计算一个内容摘要，用作 ETag 的取值（不带引号，由调用方按需包）。 */
export function contentDigest(body: string): string {
  return createHash('sha1').update(body).digest('hex')
}

/** 最小化的响应面：只要能用任意状态码 + 响应头把 body 发出去。 */
export interface ConditionalResponse {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(body?: string): unknown
}

/**
 * 发送一个 JSON 响应，并在内容未变时改发 `304 Not Modified`。
 *
 * @param requestHeaders - 入站请求头（读 `if-none-match`）。
 * @returns `true` 表示请求已被处理（200 或 304 都已发出）；调用方**不要**再写响应。
 *
 * 两条边界：
 * - **没有 `if-none-match` 时行为与从前逐字相同**（只是多一个 ETag 头），所以这是
 *   可增量上线的改动；客户端不需要同时改。
 * - `cache-control` 用 `no-cache` 而不是 `no-store`：前者允许浏览器存副本但**每次
 *   都必须回源校验**（我们因此能收到 `if-none-match`），语义上依然是"不直接用陈旧
 *   数据"。`no-store` 会让浏览器根本不存，ETag 也就永远不会被回传。
 */
export function sendJsonConditional(
  requestHeaders: Record<string, string | string[] | undefined>,
  res: ConditionalResponse,
  payload: unknown,
  status = 200,
): boolean {
  const body = JSON.stringify(payload)
  const etag = `"${contentDigest(body)}"`
  const ifNoneMatch = requestHeaders['if-none-match']
  const sent = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : (ifNoneMatch ?? '')

  if (sent !== '' && sent.split(',').map((part) => part.trim()).includes(etag)) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' })
    res.end()
    return true
  }

  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    etag,
    'cache-control': 'no-cache',
  })
  res.end(body)
  return true
}
