/**
 * 启动前确认卡（plan.ts）纯函数测试。
 *
 * 这个文件守的是"用户在点「确定开始」之前看到的东西必须是真的"：
 * - 两张表把**将要发生什么**完整摊开（标题/来源/强度/维度/立场/人数、逐行专家）；
 * - 提示词列给摘要、超长正文截断并明说"完整正文随评审落盘"（截断不能静默）；
 * - revised 卡片必须回答"这次改了什么"，没有 changes 就明说"未标注"，不假装有变更；
 * - 三态解析：approved / revise / unavailable，标签必须与 intent 逐字一致。
 *
 * 零新依赖：Node 内建 `node:test` + `node:assert/strict`，Node 原生剥离类型，
 * 因此可以直接 import 源码里的 .ts 模块。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatReviewDraft,
  PLAN_APPROVE_LABEL,
  PLAN_REVISE_LABEL,
  resolvePlanConfirmation,
  SUBJECT_PREVIEW_MAX,
} from '../src/plan.ts'
import { newRecord, readRecord, writeRecord } from '../src/review.ts'

/** 一份最小可渲染的草案；每个用例只覆盖自己关心的字段。 */
function draft(overrides = {}) {
  return {
    title: '把鉴权换成 JWT',
    content: '方案正文：把会话改成无状态 JWT，过期时间 7 天。',
    source: 'manual',
    dimensions: ['安全', '性能'],
    intensity: 'standard',
    stance: '',
    experts: [
      { key: '安全', dimension: '安全' },
      { key: '性能', dimension: '性能' },
    ],
    maxRounds: 6,
    maxTokens: 150000,
    changes: [],
    revised: false,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * 表 1 · 评审设置
 * ------------------------------------------------------------------ */

test('表 1 把每一项评审设置都摊开（标题 / 来源 / 强度 / 维度 / 立场 / 人数）', () => {
  const card = formatReviewDraft(draft({
    source: 'file',
    sourceRef: 'src/tools.ts',
    dimensions: ['安全', '性能', '兼容'],
    stance: '我认为 JWT 是无状态的，所以不会有一致性问题。',
    experts: [
      { key: '安全', dimension: '安全' },
      { key: '性能', dimension: '性能' },
      { key: '兼容', dimension: '兼容' },
    ],
  }))
  assert.ok(card.includes('## 表 1 · 评审设置'), '必须有表 1 标题')
  assert.ok(card.includes('| 项 | 值 |'), '表 1 的表头')
  assert.ok(card.includes('`把鉴权换成 JWT`'), '评审标题（用代码包裹，避免被当成格式）')
  assert.ok(card.includes('file（引用：src/tools.ts）'), '来源与引用必须一起显示')
  assert.ok(
    card.includes('standard（每维 1 位专家 / 复审上限 2 / 预算 6 轮 · 150000 tokens）'),
    '强度行必须写出这一档真正生效的数字（每维专家数 / 复审上限 / 轮数 / Token）',
  )
  assert.ok(card.includes('安全、性能、兼容（3 个）'), '维度清单与数量')
  assert.ok(card.includes('有（我认为 JWT 是无状态的，所以不会有一致性问题。）'), '立场摘要')
  assert.ok(card.includes('| 红队人数 | 3 位 |'), '红队人数')
})

test('表 1：没有立场时明说「无」（而不是留空）', () => {
  const card = formatReviewDraft(draft())
  assert.ok(card.includes('| 立场 | 无 |'))
})

/* ------------------------------------------------------------------ *
 * 表 2 · 红队阵容
 * ------------------------------------------------------------------ */

test('表 2 逐行列出红队阵容（维度 / key / 模型 / 角色 / 提示词）', () => {
  const card = formatReviewDraft(draft({
    experts: [
      {
        key: '安全',
        dimension: '安全',
        provider: 'zai-coding-cn',
        model: 'glm-5.2',
        role: '密钥与权限',
        prompt: '只盯密钥轮换',
      },
      { key: '性能', dimension: '性能' },
    ],
  }))
  assert.ok(card.includes('## 表 2 · 红队阵容'), '必须有表 2 标题')
  assert.ok(card.includes('| # | 维度 | 专家 key | 模型 | 角色 | 提示词 |'), '表 2 的表头')
  assert.ok(
    card.includes('| 1 | 安全 | `安全` | zai-coding-cn/glm-5.2 | 密钥与权限 | 只盯密钥轮换 |'),
    '显式路由显示实际 provider/model',
  )
  assert.ok(
    card.includes('| 2 | 性能 | `性能` | 继承主持人 | （未填） | 自动（九条硬约束） |'),
    '没填的列显示"继承主持人 / 未填 / 自动"，而不是空白',
  )
})

test('表 2：只填了一半路由时如实显示（不折叠成"继承主持人"）', () => {
  const card = formatReviewDraft(draft({
    experts: [
      { key: '安全', dimension: '安全', provider: 'zai-coding-cn' },
      { key: '性能', dimension: '性能', model: 'glm-5.2' },
    ],
  }))
  assert.ok(card.includes('zai-coding-cn（模型随该 provider 默认）'), '只填 provider：模型由该 provider 决定')
  assert.ok(card.includes('glm-5.2（provider 继承主持人）'), '只填 model：provider 继承主持人')
})

test('提示词列：超过 40 字截断并带省略号', () => {
  const longPrompt = '甲'.repeat(45)
  const card = formatReviewDraft(draft({ experts: [{ key: '安全', dimension: '安全', prompt: longPrompt }] }))
  assert.ok(card.includes(`| ${'甲'.repeat(40)}… |`), '摘要 = 前 40 字 + 省略号')
  assert.equal(card.includes(longPrompt), false, '完整提示词不该挤进表格（正文另有说明）')
})

test('表格单元格转义：| 与换行不得破坏表结构', () => {
  const card = formatReviewDraft(draft({
    experts: [{ key: '安全', dimension: '安全', role: '甲|乙\n丙', prompt: 'p|q' }],
  }))
  const row = card.split('\n').find((line) => line.startsWith('| 1 | 安全 |'))
  assert.ok(row !== undefined, '专家行必须真的是一行')
  assert.ok(row.includes('| 甲\\|乙 丙 |'), '角色单元格：竖线转义 + 换行压成空格')
  assert.ok(row.includes('| p\\|q |'), '提示词单元格同样转义')
})

test('阵容为空时给出占位行，而不是一张没有内容的表', () => {
  const card = formatReviewDraft(draft({ experts: [] }))
  assert.ok(card.includes('| — | （无） | — | — | — | — |'))
  assert.ok(card.includes('| 红队人数 | 0 位 |'))
})

/* ------------------------------------------------------------------ *
 * 待验证正文 / 立场全文 / 修改说明
 * ------------------------------------------------------------------ */

test('待验证正文：不超过上限时全文显示', () => {
  const card = formatReviewDraft(draft({ content: '很短的正文。' }))
  assert.ok(card.includes('## 待验证正文'))
  assert.ok(card.includes('很短的正文。'))
  assert.equal(card.includes('此处已截断'), false)
})

test('待验证正文：超过上限时截断，并注明「完整正文随评审落盘」', () => {
  const head = '甲'.repeat(SUBJECT_PREVIEW_MAX)
  const tail = '尾部唯一标记'
  const card = formatReviewDraft(draft({ content: head + tail }))
  assert.ok(card.includes(head), '前 1200 字必须出现')
  assert.equal(card.includes(tail), false, '截断之后不得漏出尾部')
  assert.ok(card.includes('完整正文随评审落盘'), '必须告诉用户评审用的是全文')
  assert.ok(card.includes('此处已截断'), '截断不能静默发生')
})

test('立场：表 1 给 60 字摘要，表下方给全文', () => {
  const stance = `${'立'.repeat(70)}结尾理由`
  const card = formatReviewDraft(draft({ stance }))
  assert.ok(card.includes(`有（${'立'.repeat(60)}…）`), '表 1 里是 60 字摘要')
  assert.ok(card.includes(stance), '表下方是全文（一字不少）')
})

test('没有立场时，表下方明说红队只按维度攻击', () => {
  const card = formatReviewDraft(draft())
  assert.ok(card.includes('## 立场全文'))
  assert.ok(card.includes('本次未填写立场'))
})

test('修改说明指向「仍需修改」并在改写后再次弹卡', () => {
  const card = formatReviewDraft(draft())
  assert.ok(card.includes('## 修改说明'))
  assert.ok(card.includes(`选「${PLAN_REVISE_LABEL}」`))
  assert.ok(card.includes('会再弹一次'))
})

/* ------------------------------------------------------------------ *
 * 修改回显（revised / changes）
 * ------------------------------------------------------------------ */

test('revised：标题标注已更新，顶部逐条列出本次变更', () => {
  const card = formatReviewDraft(draft({
    revised: true,
    changes: ['reviewer 模型：zai/glm-5.2 → deepseek/deepseek-chat', 'Token 预算：200000 → 100000'],
  }))
  assert.ok(card.startsWith('# 评审设置确认 · 把鉴权换成 JWT（已按你的意见更新）'))
  assert.ok(card.includes('> 本次变更：'))
  assert.ok(card.includes('> - reviewer 模型：zai/glm-5.2 → deepseek/deepseek-chat'))
  assert.ok(card.includes('> - Token 预算：200000 → 100000'))
  assert.equal(card.includes('本次未标注具体变更'), false)
})

test('revised 但没有 changes：明说「未标注」，不假装有变更', () => {
  const card = formatReviewDraft(draft({ revised: true }))
  assert.ok(card.includes('（本次未标注具体变更）'))
})

test('未 revised 时没有变更段（哪怕传了 changes）', () => {
  const card = formatReviewDraft(draft({ changes: ['某种变更'] }))
  assert.equal(card.includes('本次变更'), false)
  assert.equal(card.includes('某种变更'), false)
  assert.ok(card.includes('确认后才会真正开始评审'))
})

/* ------------------------------------------------------------------ *
 * 三态解析
 * ------------------------------------------------------------------ */

test('标签常量：确定开始 / 仍需修改（与 intent.approve 逐字一致）', () => {
  assert.equal(PLAN_APPROVE_LABEL, '确定开始')
  assert.equal(PLAN_REVISE_LABEL, '仍需修改')
})

test('resolvePlanConfirmation：approved / revise / unavailable 三态', () => {
  assert.deepEqual(resolvePlanConfirmation(undefined), { kind: 'unavailable', note: '' })
  assert.deepEqual(resolvePlanConfirmation({ selected: [PLAN_APPROVE_LABEL] }), { kind: 'approved' })
  assert.deepEqual(
    resolvePlanConfirmation({ selected: ['仍需修改'], custom: '把「安全」换成 glm-5.2' }),
    { kind: 'revise', note: '把「安全」换成 glm-5.2' },
  )
})

test('resolvePlanConfirmation：只有 custom 文本也算 revise', () => {
  assert.deepEqual(
    resolvePlanConfirmation({ selected: [], custom: '  强度改成 quick  ' }),
    { kind: 'revise', note: '强度改成 quick' },
  )
})

test('resolvePlanConfirmation：纯空白 custom 不算 revise（退回 unavailable）', () => {
  assert.deepEqual(resolvePlanConfirmation({ selected: [], custom: '   ' }), { kind: 'unavailable', note: '' })
  assert.deepEqual(resolvePlanConfirmation({ selected: [] }), { kind: 'unavailable', note: '' })
})

test('resolvePlanConfirmation：批准标签优先于 custom 文本', () => {
  assert.deepEqual(
    resolvePlanConfirmation({ selected: [PLAN_APPROVE_LABEL], custom: '随便改改' }),
    { kind: 'approved' },
  )
})

/* ------------------------------------------------------------------ *
 * 确认后的阵容必须能落盘读回
 *
 * 这守的是 `review.ts` 的净化白名单：`expertRoster` 是新字段，漏登记就会"写进
 * JSON 却读不回来"——用户确认过的阵容在 `crossfire_attack` 读记录时凭空消失，
 * 而除往返断言外没有任何东西会报错。
 * ------------------------------------------------------------------ */

test('expertRoster 写盘往返（含 dimension / prompt / 半配置路由）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crossfire-plan-roster-'))
  const record = newRecord({
    reviewId: 'x-plan',
    title: 't',
    content: 'c',
    source: 'manual',
    dimensions: ['安全', '性能'],
    intensity: 'standard',
    maxRounds: 6,
    maxTokens: 150000,
  })
  record.expertRoster = [
    {
      key: 'crypto-auditor',
      dimension: '安全',
      role: '密钥管理',
      provider: 'zai-coding-cn',
      model: 'glm-5.2',
      prompt: '只盯密钥轮换',
    },
    { key: '性能', dimension: '性能', model: 'deepseek-flash' },
  ]
  await writeRecord(root, record)

  const reloaded = await readRecord(root, 'x-plan')
  assert.deepEqual(reloaded.expertRoster, record.expertRoster, '确认过的阵容必须逐字段读回')
})

test('没有 expertRoster 的老记录读回后仍然没有该字段（形状不变）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crossfire-plan-roster-empty-'))
  const record = newRecord({
    reviewId: 'x-plan-old',
    title: 't',
    content: 'c',
    source: 'manual',
    dimensions: ['安全'],
    intensity: 'standard',
    maxRounds: 6,
    maxTokens: 150000,
  })
  await writeRecord(root, record)
  const reloaded = await readRecord(root, 'x-plan-old')
  assert.equal(reloaded.expertRoster, undefined, '不写空数组，保持与老记录逐字相同的形状')
})
