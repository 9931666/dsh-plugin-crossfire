/**
 * 版本一致性门禁。
 *
 * 为什么需要它：圆桌会议那边 `renderReviewMarkdown` 的导出头部曾长期硬编码一个
 * 过期版本号，而 package.json 早已走远 —— 导出物里的版本号说了谎，却没有任何
 * 测试会发现。这里把"源码常量 / package.json / compatibility.json"三者钉在一起。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { HARNESS_RANGE, PLUGIN_ID, PLUGIN_VERSION } from '../src/version.ts'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const compat = JSON.parse(await readFile(new URL('../compatibility.json', import.meta.url), 'utf8'))

test('PLUGIN_VERSION 与 package.json 的 version 逐字一致', () => {
  assert.equal(pkg.version, PLUGIN_VERSION)
})

test('PLUGIN_ID 由包名与版本组成', () => {
  assert.equal(PLUGIN_ID, `${pkg.name} v${PLUGIN_VERSION}`)
})

test('HARNESS_RANGE 与 compatibility.json 的 recommendedHost 一致', () => {
  assert.ok(
    HARNESS_RANGE.includes(compat.recommendedHost),
    `HARNESS_RANGE(${HARNESS_RANGE}) 必须包含 recommendedHost(${compat.recommendedHost})`,
  )
})

test('compatibility.json 的必需能力与插件 inject 声明一致', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const match = /export const inject = \[([^\]]*)\]/.exec(source)
  assert.ok(match !== null, 'src/index.ts 必须显式声明 inject')
  const declared = match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item !== '')
  assert.deepEqual([...compat.capabilities.required].sort(), [...declared].sort())
})

test('bundle patch 里的 entry 名与包名一致', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.ok(patch.includes(pkg.name), `cordis.patch.yml 必须引用 ${pkg.name}`)
  assert.ok(patch.includes('stateDir: .crossfire'), 'crossfire 的状态目录不能与圆桌的 .roundtable 混淆')
})
