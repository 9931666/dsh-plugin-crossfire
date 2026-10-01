/**
 * 状态层单测：评审 id、原子写、坏行计数、锁串行。
 *
 * 零新依赖（Node 原生 `node:test` + `node:assert/strict`）—— 这是刻意的：
 * 该工作区曾受 pnpm store 故障困扰，加测试框架依赖是有风险的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendJsonLine,
  crossfireRootOf,
  listReviewIds,
  newReviewId,
  readJsonFile,
  readJsonLines,
  reviewDirOf,
  sanitizeKey,
  stateRootOf,
  withCrossfireLock,
  writeJsonAtomic,
  writeTextAtomic,
} from '../src/state.ts'

/** 每个用例一个独立临时目录。 */
async function tempDir() {
  return await mkdtemp(join(tmpdir(), 'crossfire-test-'))
}

test('newReviewId 形如 x-<yyyymmdd>-<hhmmss>-<4位>', () => {
  const id = newReviewId(Date.UTC(2026, 8, 30, 12, 34, 56), 'a1b2-c3d4')
  assert.match(id, /^x-\d{8}-\d{6}-[a-z0-9]{4}$/)
  assert.equal(id.endsWith('-a1b2'), true, '随机段应当只保留 4 位且小写')
})

test('newReviewId 在极端随机值下仍然可用（不得退化成空后缀）', () => {
  assert.match(newReviewId(0, '----'), /-r000$/)
})

test('sanitizeKey 保留中文、丢弃标点、空值有兜底', () => {
  assert.equal(sanitizeKey('登录流程 Review!!'), '登录流程-review')
  assert.equal(sanitizeKey('   '), 'review')
})

test('stateRootOf / crossfireRootOf / reviewDirOf 逐层拼接', () => {
  const root = stateRootOf('/ws', '.crossfire')
  assert.equal(root, join('/ws', '.crossfire'))
  assert.equal(crossfireRootOf(root), join('/ws', '.crossfire', 'crossfire'))
  assert.equal(reviewDirOf(root, 'x-1'), join('/ws', '.crossfire', 'crossfire', 'x-1'))
})

test('writeJsonAtomic + readJsonFile 往返，且读损坏文件返回 undefined', async () => {
  const dir = await tempDir()
  const file = join(dir, 'review.json')
  await writeJsonAtomic(file, { a: 1, 中文: '值' })
  assert.deepEqual(await readJsonFile(file), { a: 1, 中文: '值' })

  await writeTextAtomic(file, '{ 这不是 JSON')
  assert.equal(await readJsonFile(file), undefined)
  assert.equal(await readJsonFile(join(dir, '不存在.json')), undefined)
})

test('writeTextAtomic 不留下 tmp 残留', async () => {
  const dir = await tempDir()
  await writeTextAtomic(join(dir, 'a.txt'), 'hello')
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(dir)
  assert.deepEqual(entries, ['a.txt'])
})

test('readJsonLines 计数被丢弃的坏行（不许静默吞掉）', async () => {
  const file = join(await tempDir(), 'user-actions.jsonl')
  await writeTextAtomic(file, '{"n":1}\n{半行\n{"n":2}\n\n')
  const report = await readJsonLines(file)
  assert.equal(report.items.length, 2)
  assert.equal(report.malformed, 1)
})

test('readJsonLines 对不存在的文件返回空集而不是抛错', async () => {
  const report = await readJsonLines(join(await tempDir(), 'missing.jsonl'))
  assert.deepEqual(report, { items: [], malformed: 0 })
})

test('appendJsonLine 可被 readJsonLines 读回，且自动建目录', async () => {
  const dir = await tempDir()
  const file = join(dir, 'nested', 'transcript.jsonl')
  await appendJsonLine(file, { kind: 'speech', text: '第一条' })
  await appendJsonLine(file, { kind: 'speech', text: '第二条' })
  const report = await readJsonLines(file)
  assert.deepEqual(report.items.map((item) => item.text), ['第一条', '第二条'])
  assert.equal(report.malformed, 0)
})

test('listReviewIds 只认 x- 前缀目录并排序', async () => {
  const root = await tempDir()
  const base = crossfireRootOf(root)
  await mkdir(join(base, 'x-20260930-120000-aaaa'), { recursive: true })
  await mkdir(join(base, 'x-20260930-110000-bbbb'), { recursive: true })
  await mkdir(join(base, 'not-a-review'), { recursive: true })
  const ids = await listReviewIds(root)
  assert.deepEqual(ids, ['x-20260930-110000-bbbb', 'x-20260930-120000-aaaa'])
})

test('withCrossfireLock 让同一 key 的操作严格串行', async () => {
  const order = []
  const task = (n) => withCrossfireLock('同一个key', async () => {
    order.push(`start${n}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    order.push(`end${n}`)
  })
  await Promise.all([task(1), task(2), task(3)])
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3'])
})

test('withCrossfireLock 在前一个操作抛错后仍然放行后续操作', async () => {
  const failed = withCrossfireLock('失败key', async () => {
    throw new Error('boom')
  })
  await assert.rejects(failed, /boom/)
  const value = await withCrossfireLock('失败key', async () => 'ok')
  assert.equal(value, 'ok')
})

test('原子写覆盖已有文件后内容完整（无截断）', async () => {
  const file = join(await tempDir(), 'review.json')
  await writeTextAtomic(file, 'a'.repeat(5000))
  await writeTextAtomic(file, 'b')
  assert.equal(await readFile(file, 'utf8'), 'b')
})
