/**
 * 导出渲染单测。
 *
 * 关注点不是排版好不好看，而是**语义不能丢**：已认定缺陷必须排在最前（那才是这场
 * 评审的产出）、被驳回的观点必须单独列出（它是下一轮去重的依据）、边界声明必须
 * 在（它是对"机器不替人下结论"的书面承诺）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderReviewMarkdown } from '../src/export-md.ts'
import { countDefects, newRecord } from '../src/review.ts'

function sampleRecord() {
  const record = newRecord({
    reviewId: 'x-sample',
    title: '把鉴权换成 JWT',
    content: '第一行\n第二行',
    source: 'chat',
    sourceRef: 'session-1',
    dimensions: ['安全', '流程'],
    intensity: 'standard',
    stanceText: '我认为 JWT 是无状态的，所以不会有一致性问题。',
    maxRounds: 6,
    maxTokens: 150000,
  })
  record.status = 'judging'
  record.experts = [{ key: '安全', dimension: '安全', status: 'done', defectCount: 2, provider: 'zai-coding-cn', model: 'glm-5.2' }]
  record.defects = [
    {
      id: 'd1', utteranceId: 'u1', expertKey: '安全', content: '密钥没有轮换机制，泄露后无法作废。',
      dimension: '安全', status: 'endorsed', ts: 1, seq: 1, strikesStance: true,
      evidence: { kind: 'argument', text: '签名密钥一旦泄露，所有已签发令牌都必须作废，而方案里没有这个入口。' },
    },
    { id: 'd2', utteranceId: 'u1', expertKey: '安全', content: '缺少回滚预案。', dimension: '流程', status: 'rejected', rejectReason: '本方案不涉及发布流程', ts: 1, seq: 2 },
    { id: 'd3', utteranceId: 'u2', expertKey: '流程', content: '审计日志缺失。', dimension: '流程', status: 'pending', ts: 1, seq: 1 },
  ]
  return record
}

test('导出包含全部关键小节', () => {
  const markdown = renderReviewMarkdown(sampleRecord(), countDefects(sampleRecord()))
  for (const heading of ['## 一、待验证对象', '## 二、用户立场与理由', '## 三、已认定缺陷', '## 五、被驳回的观点', '## 六、红队阵容', '## 八、边界声明']) {
    assert.ok(markdown.includes(heading), `缺少小节：${heading}`)
  }
})

test('预填头带插件标识、轮次、强度与表态统计', () => {
  const record = sampleRecord()
  const markdown = renderReviewMarkdown(record, countDefects(record))
  assert.ok(markdown.includes('@y9931666/dsh-plugin-crossfire v'))
  assert.ok(markdown.includes('x-sample'))
  assert.ok(markdown.includes('认定 1'))
  assert.ok(markdown.includes('驳回 1'))
  assert.ok(markdown.includes('待定 1'))
})

test('已认定缺陷带证据、打穿标记与来源专家', () => {
  const record = sampleRecord()
  const markdown = renderReviewMarkdown(record, countDefects(record))
  assert.ok(markdown.includes('密钥没有轮换机制'))
  assert.ok(markdown.includes('打穿立场'))
  assert.ok(markdown.includes('论证链'))
  assert.ok(markdown.includes('`安全`'))
})

test('被驳回的观点带驳回理由，并说明不会被再次提出', () => {
  const record = sampleRecord()
  const markdown = renderReviewMarkdown(record, countDefects(record))
  assert.ok(markdown.includes('本方案不涉及发布流程'))
  assert.ok(markdown.includes('不会被再次提出'))
})

test('没有立场时明确写出"没有填写"而不是留空', () => {
  const record = newRecord({
    reviewId: 'x-empty', title: 't', content: 'c', source: 'manual',
    dimensions: ['安全'], intensity: 'quick', maxRounds: 1, maxTokens: 1000,
  })
  const markdown = renderReviewMarkdown(record, countDefects(record))
  assert.ok(markdown.includes('没有填写立场'))
  assert.ok(markdown.includes('（没有认定任何缺陷）'))
})

test('空记录也能渲染（不抛错、不缺节）', () => {
  const record = normalizeEmpty()
  const markdown = renderReviewMarkdown(record, countDefects(record))
  assert.ok(markdown.length > 200)
  assert.ok(markdown.includes('## 八、边界声明'))
})

function normalizeEmpty() {
  const record = newRecord({
    reviewId: 'x-zero', title: '', content: '', source: 'manual',
    dimensions: [], intensity: 'quick', maxRounds: 1, maxTokens: 1000,
  })
  return record
}
