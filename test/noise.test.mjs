/**
 * 噪音过滤单测（R4 第 2 条）。
 *
 * 这一层同样在修一个真实缺陷：圆桌的数据里出现了
 *   `[当前状态] 已收到主持人任务，完成对 17 项清单的四维红队审查；按…`
 * 被当成缺陷收进裁决列表，污染了用户的表态面。
 *
 * 但反过来"误杀"的代价更大 —— 把一条真缺陷过滤掉，用户永远不会知道它存在。
 * 所以下面的用例里既有"必须拦下"也有"绝不能拦下"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNoiseUtterance, noiseReason } from '../src/noise.ts'

test('auto-capture 一律是噪音（它的内容通常是过程叙述）', () => {
  assert.equal(isNoiseUtterance('auto-capture', '观点 1（指向 A，维度安全）：密钥硬编码'), true)
  assert.equal(noiseReason('auto-capture', '任何内容'), 'auto-capture')
})

test('行首进度标记是噪音（半角与全角方括号都认）', () => {
  const samples = [
    '[当前状态] 已收到主持人任务，完成对 17 项清单的四维红队审查；按…',
    '【当前状态】已收到主持人任务',
    '[任务] 开始审查',
    '[进度] 3/5',
    '[汇报] 本轮无新增',
    '[确认] 收到',
  ]
  for (const sample of samples) {
    assert.equal(isNoiseUtterance('speech', sample), true, sample)
    assert.equal(noiseReason('speech', sample), 'progress-report', sample)
  }
})

test('进度标记出现在句中时**不**判噪音（只认行首）', () => {
  const sample = '缺陷是流程里缺少一步：任务完成后没有【确认】环节，导致状态悬空。'
  assert.equal(isNoiseUtterance('speech', sample), false)
})

test('空白/空串是噪音', () => {
  assert.equal(isNoiseUtterance('speech', ''), true)
  assert.equal(isNoiseUtterance('speech', '   \n\t '), true)
  assert.equal(noiseReason('speech', '  '), 'empty')
})

test('极短客套是噪音', () => {
  for (const sample of ['收到', '明白', '好的，开始', '已收到任务']) {
    assert.equal(isNoiseUtterance('speech', sample), true, sample)
    assert.equal(noiseReason('speech', sample), 'acknowledgement', sample)
  }
})

test('绝不能误杀：短的真缺陷', () => {
  const samples = [
    '密钥硬编码在源码里。',
    '缺少回滚预案。',
    '并发写会丢数据。',
    '版本号写错了。',
  ]
  for (const sample of samples) {
    assert.equal(isNoiseUtterance('speech', sample), false, `误杀：${sample}`)
  }
})

test('绝不能误杀：长句里出现客套词', () => {
  const sample = '收到任务后我复核了流程，发现在开始运行前没有校验密钥是否已配置，这会让首次启动直接失败。'
  assert.equal(sample.length > 24, true)
  assert.equal(isNoiseUtterance('speech', sample), false)
})

test('绝不能误杀：正常长度的缺陷表述', () => {
  const samples = [
    '观点 1（指向 state.ts，维度数据）：并发写入没有加锁，两个窗口同时提交会互相截断。',
    '加密只覆盖了传输层，落盘的凭据仍是明文，读一次配置文件就能拿到。',
  ]
  for (const sample of samples) {
    assert.equal(isNoiseUtterance('speech', sample), false, sample)
  }
})

test('未知 kind 不会被当成噪音', () => {
  assert.equal(isNoiseUtterance('speech', '正常内容，足够长以避开客套判定。'), false)
  assert.equal(isNoiseUtterance('some-future-kind', '正常内容，足够长以避开客套判定。'), false)
})
