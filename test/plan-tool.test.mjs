/**
 * 启动前确认卡的工具层契约（`tools.ts`）。
 *
 * plan.test.mjs 守的是**渲染与解析**（纯函数），这个文件守的是**接线**：
 * - `crossfire_plan_review` 真的经 `ctx.get('userQuestions')` 弹卡，并把
 *   确认后的完整配置（含逐行专家）原样交回主持人；
 * - 服务缺席 / 抛错 / 用户没答都落到 `decision="unavailable"`（不抛错、不建记录）；
 * - 它**不落盘**（确认前不产生任何状态）；
 * - `crossfire_open` 把 `experts[]` 落成 `record.expertRoster`，`crossfire_attack`
 *   优先消费它 —— 于是用户在卡上改的模型 / 角色 / 提示词真的进到下发的那份 persona。
 *
 * 零新依赖：Node 内建 `node:test` + `node:assert/strict`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRecord, newRecord, writeRecord } from '../src/review.ts'
import { registerCrossfireTools } from '../src/tools.ts'

const DEFAULTS = {
  intensity: 'standard',
  maxRounds: 6,
  maxTokens: 150000,
  expertMaxTokens: 0,
  expertMaxOpinions: 3,
  customDimensions: [],
}

/** 一个临时工作区（工具靠 `exec.agent.session.header.cwd` 定位状态根）。 */
async function workspace() {
  return await mkdtemp(join(tmpdir(), 'crossfire-plan-tool-'))
}

/** 注册全部工具；`userQuestions` 由 `ask` 决定是否挂载。 */
function registeredTools(ask) {
  const tools = {}
  const ctx = {
    logger: { warn() {} },
    get: (name) => (name === 'userQuestions' && ask !== undefined ? { ask } : undefined),
    tools: { register: (tool) => { tools[tool.name] = tool } },
  }
  registerCrossfireTools(ctx, {
    stateDir: '.crossfire',
    memberProvider: 'spawn',
    maxExperts: 7,
    reviewSplit: { provider: 'test', model: 'test', maxOpinions: 3 },
    getDefaults: () => DEFAULTS,
  })
  return tools
}

/**
 * 一个会答应/拒绝的假卡片服务。
 *
 * `questionId` 从请求里回读：真实服务也是把同一个 id 回填进 answers，用它才能
 * 证明工具按 id 取答复（而不是取第一条）。
 */
function fakeAsk({ selected, custom }) {
  const requests = []
  return {
    requests,
    ask: async (request) => {
      requests.push(request)
      return { answers: [{ id: request.questions[0].id, selected, ...(custom === undefined ? {} : { custom }) }] }
    },
  }
}

function exec(workspacePath, signal = new AbortController().signal) {
  return { agent: { id: 'session-owner', session: { header: { cwd: workspacePath } } }, signal }
}

const CONTENT = '方案正文：把会话改成无状态 JWT。'

/* ------------------------------------------------------------------ *
 * crossfire_plan_review：确认 / 修改 / 不可用
 * ------------------------------------------------------------------ */

test('plan_review：用户点「确定开始」→ approved + 完整配置（专家逐行合并、空列成空串）', async () => {
  const ws = await workspace()
  const card = fakeAsk({ selected: ['确定开始'] })
  const tools = registeredTools(card.ask)

  const result = await tools.crossfire_plan_review.execute({
    title: '把鉴权换成 JWT',
    content: CONTENT,
    dimensions: ['安全', '性能'],
    stance: '我认为 JWT 是无状态的。',
    source: 'file',
    source_ref: '方案.md',
    experts: [
      // 只改安全这一行的模型与提示词；性能那一行不写 = 沿用默认（继承主持人）。
      { dimension: '安全', model: 'glm-5.2', prompt: '只盯密钥轮换' },
    ],
  }, exec(ws))

  assert.equal(result.decision, 'approved')
  assert.equal(result.user_note, '')
  assert.equal(result.title, '把鉴权换成 JWT')
  assert.equal(result.content, CONTENT)
  assert.deepEqual(result.dimensions, ['安全', '性能'])
  assert.equal(result.intensity, 'standard')
  assert.equal(result.stance, '我认为 JWT 是无状态的。')
  assert.equal(result.source, 'file')
  assert.equal(result.source_ref, '方案.md')
  assert.equal(result.max_rounds, DEFAULTS.maxRounds)
  assert.equal(result.max_tokens, DEFAULTS.maxTokens)

  // 默认每维一位；用户只改了安全那一行，其余列原样保留（含 key = 维度名）。
  assert.equal(result.experts.length, 2)
  assert.deepEqual(result.experts[0], {
    key: '安全',
    dimension: '安全',
    role: '',
    provider: '',
    model: 'glm-5.2',
    prompt: '只盯密钥轮换',
  })
  assert.deepEqual(result.experts[1], {
    key: '性能',
    dimension: '性能',
    role: '',
    provider: '',
    model: '',
    prompt: '',
  })
})

test('plan_review：卡片的 detail 就是两张表（审批前用户看得到阵容）', async () => {
  const ws = await workspace()
  const card = fakeAsk({ selected: ['确定开始'] })
  const tools = registeredTools(card.ask)

  await tools.crossfire_plan_review.execute({
    title: '把鉴权换成 JWT',
    content: CONTENT,
    dimensions: ['安全'],
    experts: [{ dimension: '安全', provider: 'zai-coding-cn', model: 'glm-5.2', role: '密钥' }],
  }, exec(ws))

  assert.equal(card.requests.length, 1)
  const question = card.requests[0].questions[0]
  assert.equal(question.intent.kind, 'plan-review')
  assert.equal(question.intent.approve, '确定开始')
  assert.deepEqual(question.options.map((option) => option.label), ['确定开始', '仍需修改'])
  assert.ok(question.detail.includes('## 表 1 · 评审设置'))
  assert.ok(question.detail.includes('## 表 2 · 红队阵容'))
  assert.ok(question.detail.includes('| 1 | 安全 | `安全` | zai-coding-cn/glm-5.2 | 密钥 |'))
})

test('plan_review：用户点「仍需修改」→ revise + 用户原话', async () => {
  const ws = await workspace()
  const card = fakeAsk({ selected: ['仍需修改'], custom: '  把安全换成 glm-5.2  ' })
  const tools = registeredTools(card.ask)

  const result = await tools.crossfire_plan_review.execute({
    title: 't', content: CONTENT, dimensions: ['安全'],
  }, exec(ws))
  assert.equal(result.decision, 'revise')
  assert.equal(result.user_note, '把安全换成 glm-5.2', '必须原样带回用户的话（首尾空白去掉）')
  assert.equal(result.experts.length, 1, '未确认也要把当前草案交回，主持人据此改')
})

test('plan_review：userQuestions 未挂载 → unavailable + 完整配置（不抛错）', async () => {
  const ws = await workspace()
  const tools = registeredTools(undefined)

  const result = await tools.crossfire_plan_review.execute({
    title: 't', content: CONTENT, dimensions: ['安全'],
  }, exec(ws))
  assert.equal(result.decision, 'unavailable')
  assert.match(result.user_note, /userQuestions/)
  assert.deepEqual(result.dimensions, ['安全'])
  assert.equal(result.experts.length, 1, '配置照常返回，主持人可改用文字确认')
})

test('plan_review：卡片服务抛错 → unavailable（一次失败不该让整个评审开不了）', async () => {
  const ws = await workspace()
  const tools = registeredTools(async () => { throw new Error('卡被中止') })

  const result = await tools.crossfire_plan_review.execute({
    title: 't', content: CONTENT, dimensions: ['安全'],
  }, exec(ws))
  assert.equal(result.decision, 'unavailable')
  assert.match(result.user_note, /设置卡片不可用.*卡被中止/)
})

test('plan_review：确认前不落盘（工作区里不得出现状态目录）', async () => {
  const ws = await workspace()
  const card = fakeAsk({ selected: ['确定开始'] })
  const tools = registeredTools(card.ask)

  await tools.crossfire_plan_review.execute({
    title: 't', content: CONTENT, dimensions: ['安全'],
  }, exec(ws))
  const created = await stat(join(ws, '.crossfire')).catch(() => undefined)
  assert.equal(created, undefined, '确认卡只渲染，不创建评审记录')
})

test('plan_review：正文为空直接拒绝（没有东西可评审）', async () => {
  const ws = await workspace()
  const tools = registeredTools(fakeAsk({ selected: ['确定开始'] }).ask)
  await assert.rejects(
    tools.crossfire_plan_review.execute({ title: 't', content: '   ' }, exec(ws)),
    /content must not be empty/,
  )
})

/* ------------------------------------------------------------------ *
 * crossfire_open → crossfire_attack：确认卡阵容的落盘与消费
 * ------------------------------------------------------------------ */

test('open：experts 落成 record.expertRoster（只存非空字段，读回逐字段相同）', async () => {
  const ws = await workspace()
  const tools = registeredTools(fakeAsk({ selected: ['确定开始'] }).ask)

  const opened = await tools.crossfire_open.execute({
    title: '把鉴权换成 JWT',
    content: CONTENT,
    dimensions: ['安全', '性能'],
    experts: [
      { key: 'crypto-auditor', dimension: '安全', role: '密钥', provider: 'zai-coding-cn', model: 'glm-5.2', prompt: '只盯轮换' },
      // 空串 = 没写：落盘时不该留下空字段（否则读回来像"填了但为空"）。
      { dimension: '性能', role: '', provider: '', model: '', prompt: '' },
    ],
  }, exec(ws))

  const record = await readRecord(join(ws, '.crossfire'), opened.review_id)
  assert.deepEqual(record.expertRoster, [
    { key: 'crypto-auditor', dimension: '安全', role: '密钥', provider: 'zai-coding-cn', model: 'glm-5.2', prompt: '只盯轮换' },
    { key: '性能', dimension: '性能' },
  ])
})

test('open：不传 experts 时记录里没有 expertRoster（与从前逐字一致）', async () => {
  const ws = await workspace()
  const tools = registeredTools(fakeAsk({ selected: ['确定开始'] }).ask)

  const opened = await tools.crossfire_open.execute({
    title: 't', content: CONTENT, dimensions: ['安全'],
  }, exec(ws))

  const record = await readRecord(join(ws, '.crossfire'), opened.review_id)
  assert.equal(record.expertRoster, undefined)
})

test('attack：消费 expertRoster —— 用户确认的模型 / 角色 / 提示词真的进到下发的那份 persona', async () => {
  const ws = await workspace()
  const stateRoot = join(ws, '.crossfire')
  const record = newRecord({
    reviewId: 'x-plan-roster',
    title: '把鉴权换成 JWT',
    content: CONTENT,
    source: 'manual',
    dimensions: ['安全'],
    intensity: 'standard',
    maxRounds: 6,
    maxTokens: 150000,
    ownerSessionId: 'session-owner',
  })
  record.expertRoster = [{
    key: 'crypto-auditor',
    dimension: '安全',
    provider: 'zai-coding-cn',
    model: 'glm-5.2',
    role: '熟悉密钥管理',
    prompt: '只盯密钥轮换周期。',
  }]
  await writeRecord(stateRoot, record)

  const calls = []
  const provider = {
    capabilities: {},
    prepareContinuable: () => {},
    startContinuable: async (request) => {
      calls.push(request)
      return { childId: `child-${calls.length}` }
    },
  }
  const tools = {}
  const ctx = {
    logger: { warn() {} },
    get: () => undefined,
    subagents: {
      getProvider: () => provider,
      list: () => ['spawn'],
      startContinuable: (request) => provider.startContinuable(request),
    },
    tools: { register: (tool) => { tools[tool.name] = tool } },
  }
  registerCrossfireTools(ctx, {
    stateDir: '.crossfire',
    memberProvider: 'spawn',
    maxExperts: 7,
    defaultProvider: 'deepseek-official',
    defaultModel: 'deepseek-flash',
    reviewSplit: { provider: 'test', model: 'test', maxOpinions: 3 },
    getDefaults: () => DEFAULTS,
  })

  const outcome = await tools.crossfire_attack.execute({ review_id: 'x-plan-roster' }, exec(ws))
  assert.equal(outcome.spawned, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].request.agentOptions.provider, 'zai-coding-cn', '确认过的路由必须真的下发')
  assert.equal(calls[0].request.agentOptions.model, 'glm-5.2')
  // `spawnExpert` 在旧宿主路径上把 persona 作为 request.persona 单独下发
  // （新宿主路径才会并进 prompt 的第二块），这里断言的就是真正下发的那一份。
  const persona = calls[0].request.persona
  assert.ok(persona.includes('熟悉密钥管理'), 'role 进 persona')
  assert.ok(persona.includes('只盯密钥轮换周期。'), 'prompt 进 persona')
  assert.ok(persona.includes('评审者补充提示词（只放宽专长，不放宽约束）'))

  const reloaded = await readRecord(stateRoot, 'x-plan-roster')
  assert.ok(reloaded.experts[0].persona.includes('只盯密钥轮换周期。'), '下发的 persona 与落盘的是同一份')
})
