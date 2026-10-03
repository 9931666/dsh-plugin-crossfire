/**
 * RPC dispatch 的回归门禁。
 *
 * 红队批评过一件事：这个仓库**没有任何测试驱动 `rpc.ts` 的 dispatch**，于是端点
 * 路由、参数校验与错误包封全靠人工点一遍；下一次改动可以在静默中把它们弄坏。
 * 这个文件补上那一层 —— 用最小假 ctx（dispatch 只在真正用到时才碰 ctx 成员），
 * 覆盖所有**不需要真实工作区**的分支：偏好读写、参数校验、未知端点、缺失记录。
 *
 * 需要真实文件系统的路径（表态、推进、导出）由 `test/review.test.mjs` 与人工
 * 端到端验收覆盖，这里不重复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerRpc } from '../src/rpc.ts'
import { registerCrossfireTools } from '../src/tools.ts'
import { createPreferenceStore, defaultPreferences } from '../src/preferences.ts'
import { appendTranscript, newRecord, readRecord, writeRecord } from '../src/review.ts'

/** 最小假 ctx：`logger` 供错误路径用，`get`/`agents` 供可选能力探测用。
 *  `agent` 可注入，用来分别驱动"会话活着"与"会话已冷"两条分支；
 *  `subagents` 可注入，用来驱动攻击路径（真正拉起专家需要它）。 */
function fakeCtx(agent, subagents) {
  return {
    logger: { warn() {} },
    get() {
      return undefined
    },
    agents: {
      get() {
        return agent
      },
    },
    ...(subagents === undefined ? {} : { subagents }),
  }
}

/**
 * 假子代理 provider（攻击路径用）。
 *
 * `state` 可变：`fail` 用来造"整批失败后用户重试"的场景，`delayMs` 用来把一次攻击
 * 拉长到足以让第二个并发请求排在锁后面。
 */
function spawnRig() {
  const calls = []
  const state = { fail: false, delayMs: 0 }
  const provider = {
    capabilities: { persona: true, toolFilter: true },
    prepareContinuable: () => {},
    startContinuable: async (request) => {
      calls.push(request)
      if (state.delayMs > 0) await new Promise((resolve) => { setTimeout(resolve, state.delayMs) })
      if (state.fail) throw new Error('spawn boom')
      return { childId: `child-${calls.length}` }
    },
  }
  return {
    state,
    calls,
    subagents: {
      getProvider: () => provider,
      list: () => ['spawn'],
      startContinuable: (request) => provider.startContinuable(request),
    },
  }
}

/** 一个活着的调用方 Agent（攻击路径需要它当 parent）。 */
function callerAgent(id = 'session-owner') {
  return { id, session: { header: { cwd: '/tmp' } } }
}

/** 一个只带偏好存储与工具配置的运行时（临时偏好文件，不碰用户真实数据）。 */
async function makeRuntime() {
  const file = join(await mkdtemp(join(tmpdir(), 'crossfire-rpc-')), 'preferences.json')
  const runtime = {
    prefs: createPreferenceStore({ base: defaultPreferences('standard'), file }),
    tools: {
      stateDir: '.crossfire',
      memberProvider: 'spawn',
      maxExperts: 7,
      reviewSplit: { provider: 'test', model: 'test', maxOpinions: 3 },
      getDefaults: () => ({
        intensity: 'standard',
        maxRounds: 6,
        maxTokens: 150000,
        expertMaxTokens: 0,
        expertMaxOpinions: 3,
        customDimensions: [],
      }),
    },
  }
  await runtime.prefs.ready()
  return { runtime, file }
}

test('prefs.get：返回固定池、实际维度与三档强度规则', async () => {
  const { runtime } = await makeRuntime()
  const result = await registerRpc(fakeCtx(), runtime)('crossfire/prefs.get', {})
  assert.equal(result.ok, true)
  assert.ok(Array.isArray(result.value.pool))
  assert.ok(result.value.pool.includes('安全'), '固定池必须在')
  assert.ok(result.value.dimensions.length >= 7, '实际维度至少覆盖固定池')
  assert.equal(result.value.intensities.quick.maxReviewPass, 1)
  assert.equal(result.value.intensities.deep.crossExamination, true)
})

test('prefs.set：改动能落盘，并回传新值', async () => {
  const { runtime, file } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(), runtime)
  const result = await dispatch('crossfire/prefs.set', { session: 's1', patch: { maxRounds: 9 } })
  assert.equal(result.ok, true)
  assert.equal(result.value.prefs.maxRounds, 9)
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.maxRounds, 9, '必须真的写进文件')
})

test('prefs.set：无会话身份时拒绝，且不落盘', async () => {
  // 这条断言是**回归防线**（红队评审抓出的真实缺陷）：此前的用例把"不带 session
  // 也能写全局偏好"钉成了通过行为，而这条端点是公开 HTTP 路由、写的是 $DSH_HOME
  // 下的全局设置 —— 于是任何能 POST 到本机端口的调用者都能改全局配置。
  const { runtime, file } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(), runtime)
  const result = await dispatch('crossfire/prefs.set', { patch: { maxRounds: 9 } })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /session identity/)
  // 被拒的调用绝不能留下落盘副作用。文件**不存在**是最干净的形态（连创建都没发生），
  // 所以这里两种情况都接受：没建文件，或者建了但值不是被拒的那次提交。
  const persisted = await readFile(file, 'utf8').then(
    (text) => JSON.parse(text),
    () => undefined,
  )
  assert.notEqual(persisted?.maxRounds, 9, '被拒的调用绝不能留下落盘副作用')
})

test('prefs.set：非法值退回 base 而不是默认值（不会顺手清掉其它设置）', async () => {
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(), runtime)
  await dispatch('crossfire/prefs.set', { session: 's1', patch: { maxRounds: 9, maxTokens: 5000 } })
  const result = await dispatch('crossfire/prefs.set', { session: 's1', patch: { maxRounds: -1 } })
  assert.equal(result.ok, true)
  assert.equal(result.value.prefs.maxRounds, 9, '非法值应保留既有值')
  assert.equal(result.value.prefs.maxTokens, 5000, '同一次提交里合法的字段要生效')
})

test('prefs.set：缺 patch 时拒绝', async () => {
  const { runtime } = await makeRuntime()
  const result = await registerRpc(fakeCtx(), runtime)('crossfire/prefs.set', { session: 's1' })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /patch/)
})

test('未知端点：结构化失败，绝不抛错', async () => {
  const { runtime } = await makeRuntime()
  const result = await registerRpc(fakeCtx(), runtime)('crossfire/nope', {})
  assert.equal(result.ok, false)
  assert.match(result.error.message, /unknown endpoint/)
})

test('defect.setStatus：非法状态被拒；缺 defectId 被拒', async () => {
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(), runtime)
  const bad = await dispatch('crossfire/defect.setStatus', { reviewId: 'x', defectId: 'd', status: '胡说' })
  assert.equal(bad.ok, false)
  assert.match(bad.error.message, /status must be/)
  const missing = await dispatch('crossfire/defect.setStatus', { reviewId: 'x', status: 'endorsed' })
  assert.equal(missing.ok, false)
  assert.match(missing.error.message, /defectId/)
})

test('recheck.setVerdict：非法 verdict 被拒', async () => {
  const { runtime } = await makeRuntime()
  const result = await registerRpc(fakeCtx(), runtime)('crossfire/recheck.setVerdict', {
    reviewId: 'x', defectId: 'd', verdict: '胡说',
  })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /verdict/)
})

test('review.advance：非法 step 被拒', async () => {
  const { runtime } = await makeRuntime()
  const result = await registerRpc(fakeCtx(), runtime)('crossfire/review.advance', { reviewId: 'x', step: '胡说' })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /step must be/)
})

test('缺 reviewId：可读错误而不是崩溃', async () => {
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(), runtime)
  for (const endpoint of ['crossfire/review.get', 'crossfire/review.export', 'crossfire/stance.set']) {
    const result = await dispatch(endpoint, {})
    assert.equal(result.ok, false, endpoint)
    assert.match(result.error.message, /reviewId/, endpoint)
  }
})

test('评审不存在：报告 no review，而不是静默成功', async () => {
  const { runtime } = await makeRuntime()
  const result = await registerRpc(fakeCtx(), runtime)('crossfire/review.get', { reviewId: 'x-does-not-exist' })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /no review/)
})

test('reviews.list：拿不到任何工作区时返回空集 + note（降级而不抛错）', async () => {
  const { runtime } = await makeRuntime()
  const result = await registerRpc(fakeCtx(), runtime)('crossfire/reviews.list', { session: 'session-x' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.reviews, [])
  assert.equal(typeof result.value.note, 'string')
})

test('reviews.list：不带身份时返回空集（保守失败，而不是"跳过过滤"交出全部）', async () => {
  const { runtime } = await makeRuntime()
  const result = await registerRpc(fakeCtx(), runtime)('crossfire/reviews.list', {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.reviews, [])
  assert.match(result.value.note, /no session identity/)
})

test('review.open：不带身份时拒绝（否则产出无主评审，对任何会话开放）', async () => {
  const { runtime } = await makeRuntime()
  const result = await registerRpc(fakeCtx(), runtime)('crossfire/review.open', {
    title: 't', content: 'c', workspace: 'F:\\tmp',
  })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /session identity/)
})

/** 往一个临时状态根里写一场评审（不碰用户真实数据）。 */
async function seedReview(reviewId, mutate) {
  const root = await mkdtemp(join(tmpdir(), 'crossfire-rpc-state-'))
  const record = newRecord({
    reviewId,
    title: 't',
    content: 'c',
    source: 'manual',
    dimensions: ['安全'],
    intensity: 'quick',
    maxRounds: 1,
    maxTokens: 1000,
    ownerSessionId: 'session-owner',
  })
  if (mutate !== undefined) mutate(record)
  await writeRecord(root, record)
  return root
}

test('session-offline：声称了一个正确但非 live 的会话 → 立即失败，不再退回记录 owner', async () => {
  // 这条分支正是"移除 owner 兜底"真正新增的行为：旧代码在这里会退回记录里的
  // ownerSessionId 继续把专家拉起来，新代码必须直接失败。红队指出过：不覆盖它，
  // 就分不清新旧代码 —— 两者在"会话活着"时返回同形的成功响应。
  const root = await seedReview('x-offline')
  const result = await registerRpc(fakeCtx(undefined), await makeRuntime().then((r) => r.runtime))(
    'crossfire/review.advance',
    { reviewId: 'x-offline', session: 'session-owner', stateRoot: root, step: 'attack' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'session-offline')
})

test('settled 的评审不允许直接重新攻击（必须先走 recheck 开新轮）', async () => {
  // 卡片在 settled 上只渲染「开复审」按钮，所以放行 attack 等于造出一条谁也点不到、
  // 却能被直接调用的路径（红队在验收里指出过）。这里给它一道断言。
  const root = await seedReview('x-settled', (record) => {
    record.status = 'settled'
  })
  const { runtime } = await makeRuntime()
  const liveAgent = { id: 'session-owner', session: { header: { cwd: '/tmp' } } }
  const result = await registerRpc(fakeCtx(liveAgent), runtime)('crossfire/review.advance', {
    reviewId: 'x-settled', session: 'session-owner', stateRoot: root, step: 'attack',
  })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /cannot send in the red team now/)
})

/* ================================================================== *
 * A1：专家原提示词必须是"真正下发的那一份"
 * ================================================================== */

test('expert.prompt：返回落盘的 persona 原文（逐字），不因记录后续改动而变化（A1）', async () => {
  // 这是 A1 的核心断言。persona 是现场重建的，而攻击开始后用户还能改 role、改立场
  // —— 已下发的那一份不会变。所以端点必须优先返回落盘的那份，且**逐字**返回。
  const original = '这是真正下发过的那份 persona 原文。\n第二行：只盯密钥轮换。'
  const root = await seedReview('x-prompt', (record) => {
    record.status = 'attacking'
    record.stance = { text: '开打之后才改的立场', origin: 'edited', updatedAt: 1 }
    record.experts = [{
      key: '安全', dimension: '安全', status: 'running', defectCount: 0,
      persona: original,
      role: '开打之后才改的角色定位',
    }]
  })
  const { runtime } = await makeRuntime()
  const result = await registerRpc(fakeCtx(), runtime)('crossfire/expert.prompt', {
    reviewId: 'x-prompt', session: 'session-owner', stateRoot: root, expertKey: '安全',
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.persona, original, '必须逐字返回落盘的那份原文')
  assert.equal(result.value.rebuilt, false, '不得走现场重建（重建出来的不是原文）')
})

test('expert.prompt：旧记录（无 persona）现场重建，参数与真实下发同源（A1）', async () => {
  const root = await seedReview('x-prompt-legacy', (record) => {
    // 维度 3 个、专家只 2 位（被上限截断过）：这正是旧写法
    // `record.experts.map(item => item.dimension)` 会取错形状的场景。
    record.dimensions = ['安全', '性能', '交互']
    record.experts = [
      { key: '安全', dimension: '安全', status: 'done', defectCount: 0 },
      { key: '性能', dimension: '性能', status: 'done', defectCount: 0 },
    ]
  })
  const { runtime } = await makeRuntime()
  // 条数上限必须是**被读到的那个运行时值**，而不是硬编码的 3。
  const base = runtime.tools.getDefaults()
  runtime.tools.getDefaults = () => ({ ...base, expertMaxOpinions: 5 })
  const result = await registerRpc(fakeCtx(), runtime)('crossfire/expert.prompt', {
    reviewId: 'x-prompt-legacy', session: 'session-owner', stateRoot: root, expertKey: '安全',
  })
  assert.equal(result.ok, true, '旧记录必须走重建路径且不报错')
  assert.equal(result.value.rebuilt, true)
  assert.equal(typeof result.value.persona, 'string')
  assert.ok(result.value.persona.includes('交互'), '维度取自 record.dimensions（截断后的 experts.map 会漏掉它）')
  assert.ok(result.value.persona.includes('最多 5 条'), '条数取自运行时 expertMaxOpinions，不是硬编码 3')
})

test('review.advance(attack) → expert.prompt：落盘的就是下发的那份（A1 端到端）', async () => {
  const root = await seedReview('x-attack-prompt', (record) => {
    record.dimensions = ['安全']
  })
  const rig = spawnRig()
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(callerAgent(), rig.subagents), runtime)
  const attacked = await dispatch('crossfire/review.advance', {
    reviewId: 'x-attack-prompt', session: 'session-owner', stateRoot: root, step: 'attack',
  })
  assert.equal(attacked.ok, true)
  const sent = rig.calls[0].request.persona

  const asked = await dispatch('crossfire/expert.prompt', {
    reviewId: 'x-attack-prompt', session: 'session-owner', stateRoot: root, expertKey: '安全',
  })
  assert.equal(asked.ok, true)
  assert.equal(asked.value.persona, sent, '端点返回的必须与真正下发到宿主的字符串逐字相同')
  assert.equal(asked.value.rebuilt, false)
})

/* ================================================================== *
 * A2：collect 的幂等（重复 / 并发都不产生重复缺陷）
 * ================================================================== */

test('review.advance(collect)：同一条发言连续 collect 两次，缺陷不重复且 collected 如实归零（A2）', async () => {
  const root = await seedReview('x-collect-twice', (record) => {
    record.status = 'attacking'
  })
  await appendTranscript(root, 'x-collect-twice', {
    id: 'u1', expertKey: '安全', kind: 'speech', pass: 1, ts: 1,
    content: '观点 1（指向 A，维度安全）：密钥硬编码在源码里，需要移到环境变量。',
  })
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(), runtime)
  const payload = { reviewId: 'x-collect-twice', session: 'session-owner', stateRoot: root, step: 'collect' }

  const first = await dispatch('crossfire/review.advance', payload)
  assert.equal(first.ok, true)
  assert.equal(first.value.collected, 1, '第一次真的新增 1 条')

  const second = await dispatch('crossfire/review.advance', payload)
  assert.equal(second.ok, true)
  assert.equal(second.value.collected, 0, '第二次一条都不该新增（collected 必须如实报 0）')

  const record = await readRecord(root, 'x-collect-twice')
  assert.equal(record.defects.length, 1, '裁决面不得出现重复项')
  assert.equal(record.status, 'judging')
})

test('review.advance(collect)：并发两次 collect 加起来也只新增一条（A2）', async () => {
  // 旧实现在锁外读快照、锁外拆分，两个并发请求都会基于同一份旧记录算出同一批缺陷，
  // 再各自拼进 defects —— 于是列表里出现两条一模一样的缺陷。这里的断言能区分新旧。
  const root = await seedReview('x-collect-parallel', (record) => {
    record.status = 'attacking'
  })
  await appendTranscript(root, 'x-collect-parallel', {
    id: 'u1', expertKey: '安全', kind: 'speech', pass: 1, ts: 1,
    content: '观点 1（指向 A，维度安全）：密钥硬编码在源码里，需要移到环境变量。',
  })
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(), runtime)
  const payload = { reviewId: 'x-collect-parallel', session: 'session-owner', stateRoot: root, step: 'collect' }

  const [left, right] = await Promise.all([
    dispatch('crossfire/review.advance', payload),
    dispatch('crossfire/review.advance', payload),
  ])
  assert.equal(left.ok && right.ok, true, '两条路径都应当成功（幂等，不是互相报错）')
  assert.equal(left.value.collected + right.value.collected, 1, '两次加起来只允许新增一条')

  const record = await readRecord(root, 'x-collect-parallel')
  assert.equal(record.defects.length, 1, '并发不得产生重复缺陷')
})

/* ================================================================== *
 * A4：attack 的并发 / 重复启动
 * ================================================================== */

test('review.advance(attack)：并发两次只有一次生效，且不产生孤儿专家（A4）', async () => {
  const root = await seedReview('x-attack-parallel', (record) => {
    record.dimensions = ['安全', '性能']
  })
  const rig = spawnRig()
  // 把一次攻击拉长：第二个请求必然排在锁后面，读到的就是第一批的最终状态。
  rig.state.delayMs = 10
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(callerAgent(), rig.subagents), runtime)
  const payload = { reviewId: 'x-attack-parallel', session: 'session-owner', stateRoot: root, step: 'attack' }

  const [left, right] = await Promise.all([
    dispatch('crossfire/review.advance', payload),
    dispatch('crossfire/review.advance', payload),
  ])
  const accepted = [left, right].filter((result) => result.ok)
  const rejected = [left, right].filter((result) => !result.ok)
  assert.equal(accepted.length, 1, '并发两次只能有一次生效')
  assert.equal(rejected.length, 1, '另一次必须被明确拒绝，而不是静默覆盖')
  assert.match(rejected[0].error.message, /already running/)
  assert.equal(accepted[0].value.spawned, 2)
  assert.equal(rig.calls.length, 2, '只有一批专家被真的拉起 —— 不得留下没人跟踪的孤儿')

  const record = await readRecord(root, 'x-attack-parallel')
  assert.equal(record.experts.length, 2)
  assert.ok(record.experts.every((expert) => expert.status === 'running'))
  assert.deepEqual(record.experts.map((expert) => expert.childId), ['child-1', 'child-2'])
})

test('review.advance(attack)：已有一批 running 时重复启动被拒（A4）', async () => {
  const root = await seedReview('x-attack-repeat', (record) => {
    record.dimensions = ['安全']
  })
  const rig = spawnRig()
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(callerAgent(), rig.subagents), runtime)
  const payload = { reviewId: 'x-attack-repeat', session: 'session-owner', stateRoot: root, step: 'attack' }

  assert.equal((await dispatch('crossfire/review.advance', payload)).ok, true)
  const again = await dispatch('crossfire/review.advance', payload)
  assert.equal(again.ok, false)
  assert.match(again.error.message, /already running/)
  assert.equal(rig.calls.length, 1, '被拒的那次绝不能真的拉起专家')
})

test('review.advance(attack)：上一批全部 failed 后重试仍可启动（A4 的放行边）', async () => {
  // 判据是"有没有 running 的专家"而不是"状态是不是 attacking"，正是为了让这条
  // 重试路径走得通：状态停在 attacking、专家全是 failed，用户当然要能再试一次。
  const root = await seedReview('x-attack-retry', (record) => {
    record.dimensions = ['安全']
  })
  const rig = spawnRig()
  rig.state.fail = true
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(callerAgent(), rig.subagents), runtime)
  const payload = { reviewId: 'x-attack-retry', session: 'session-owner', stateRoot: root, step: 'attack' }

  const first = await dispatch('crossfire/review.advance', payload)
  assert.equal(first.ok, true, '拉起失败是"专家 failed"，不是整个调用失败')
  assert.equal(first.value.spawned, 0)
  assert.equal(first.value.failed, 1)
  const failedRecord = await readRecord(root, 'x-attack-retry')
  assert.equal(failedRecord.experts[0].status, 'failed')
  assert.match(failedRecord.experts[0].note, /spawn boom/)

  rig.state.fail = false
  const second = await dispatch('crossfire/review.advance', payload)
  assert.equal(second.ok, true, '上一批全部 failed（没有 running）时必须允许重试')
  assert.equal(second.value.spawned, 1)
  const retried = await readRecord(root, 'x-attack-retry')
  assert.equal(retried.experts[0].status, 'running')
})

/* ================================================================== *
 * A2/A4：工具端是**同构路径**（两条入口必须驱动同一套状态机）
 * ================================================================== */

/** 注册全部工具并把它们按名字收集起来（假 ctx 只需要 `tools.register`）。 */
function registerToolsForTest() {
  const registered = []
  const ctx = {
    logger: { warn() {} },
    get: () => undefined,
    tools: { register: (tool) => { registered.push(tool) } },
  }
  registerCrossfireTools(ctx, {
    stateDir: '.crossfire',
    memberProvider: 'spawn',
    maxExperts: 7,
    reviewSplit: { provider: 'test', model: 'test', maxOpinions: 3 },
    getDefaults: () => ({
      intensity: 'standard',
      maxRounds: 6,
      maxTokens: 150000,
      expertMaxTokens: 0,
      expertMaxOpinions: 3,
      customDimensions: [],
    }),
  })
  return Object.fromEntries(registered.map((tool) => [tool.name, tool]))
}

/** 在临时工作区里造一场评审（工具端靠 `exec.agent.session.header.cwd` 定位状态根）。 */
async function seedWorkspaceReview(reviewId, status) {
  const workspace = await mkdtemp(join(tmpdir(), 'crossfire-tool-ws-'))
  const stateRoot = join(workspace, '.crossfire')
  const record = newRecord({
    reviewId,
    title: 't',
    content: 'c',
    source: 'manual',
    dimensions: ['安全'],
    intensity: 'quick',
    maxRounds: 1,
    maxTokens: 1000,
    ownerSessionId: 'session-owner',
  })
  record.status = status
  await writeRecord(stateRoot, record)
  return { workspace, stateRoot, agent: { id: 'session-owner', session: { header: { cwd: workspace } } } }
}

test('crossfire_collect（工具端）：连续两次不产生重复缺陷，collected 如实归零（A2 同构路径）', async () => {
  // 工具端此前是"锁外读快照 → 锁外拆分 → 锁内纯拼接"，与 rpc.ts 的卡片路径同形。
  // 这条断言把两侧对齐这件事钉住：只改一边，另一边的这个测试就会红。
  const { stateRoot, agent } = await seedWorkspaceReview('x-tool-collect', 'attacking')
  await appendTranscript(stateRoot, 'x-tool-collect', {
    id: 'u1', expertKey: '安全', kind: 'speech', pass: 1, ts: 1,
    content: '观点 1（指向 A，维度安全）：密钥硬编码在源码里，需要移到环境变量。',
  })
  const tools = registerToolsForTest()

  const first = await tools.crossfire_collect.execute({ review_id: 'x-tool-collect' }, { agent })
  assert.equal(first.collected, 1, '第一次真的新增 1 条')
  const second = await tools.crossfire_collect.execute({ review_id: 'x-tool-collect' }, { agent })
  assert.equal(second.collected, 0, '第二次如实报 0 条新增')
  assert.equal(second.total_defects, 1)

  const record = await readRecord(stateRoot, 'x-tool-collect')
  assert.equal(record.defects.length, 1, '裁决面不得出现重复项')
})

test('crossfire_attack（工具端）：已有一批 running 时重复启动被拒（A4 同构路径）', async () => {
  const { stateRoot, agent } = await seedWorkspaceReview('x-tool-attack', 'draft')
  const rig = spawnRig()
  const registered = []
  const ctx = {
    logger: { warn() {} },
    get: () => undefined,
    subagents: rig.subagents,
    tools: { register: (tool) => { registered.push(tool) } },
  }
  registerCrossfireTools(ctx, {
    stateDir: '.crossfire',
    memberProvider: 'spawn',
    maxExperts: 7,
    reviewSplit: { provider: 'test', model: 'test', maxOpinions: 3 },
    getDefaults: () => ({
      intensity: 'standard', maxRounds: 6, maxTokens: 150000,
      expertMaxTokens: 0, expertMaxOpinions: 3, customDimensions: [],
    }),
  })
  const attack = registered.find((tool) => tool.name === 'crossfire_attack')

  const first = await attack.execute({ review_id: 'x-tool-attack' }, { agent })
  assert.equal(first.spawned, 1)
  await assert.rejects(
    attack.execute({ review_id: 'x-tool-attack' }, { agent }),
    /already running/,
    '工具端也必须拒绝重复启动，而不是静默覆盖正在跑的 childId',
  )
  assert.equal(rig.calls.length, 1, '被拒的那次绝不能真的拉起专家')
  const record = await readRecord(stateRoot, 'x-tool-attack')
  assert.equal(record.experts.length, 1)
  assert.equal(record.experts[0].status, 'running')
})

/* ================================================================== *
 * A6：finish / recheck 的状态门禁在锁内重校
 * ================================================================== */

test('review.advance(finish)：并发两次只产生一条 history（同一 pass 唯一）（A6）', async () => {
  const root = await seedReview('x-finish-parallel', (record) => {
    record.status = 'judging'
    record.defects = [{
      id: 'u1#1', utteranceId: 'u1', expertKey: '安全', content: '一条缺陷', dimension: '安全',
      status: 'endorsed', ts: 1, seq: 1,
    }]
  })
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(), runtime)
  const payload = { reviewId: 'x-finish-parallel', session: 'session-owner', stateRoot: root, step: 'finish' }

  const [left, right] = await Promise.all([
    dispatch('crossfire/review.advance', payload),
    dispatch('crossfire/review.advance', payload),
  ])
  assert.equal(left.ok && right.ok, true)

  const record = await readRecord(root, 'x-finish-parallel')
  assert.equal(record.status, 'settled')
  assert.equal(record.history.length, 1, '同一个 pass 在 history 里只能有一条')
  assert.equal(record.history[0].pass, 1)
  assert.equal(record.history[0].defects.length, 1)
})

test('review.advance(finish)：同一 pass 重复定稿是原地更新而不是再叠一份（A6）', async () => {
  const root = await seedReview('x-finish-again', (record) => {
    record.status = 'judging'
  })
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(), runtime)
  const base = { reviewId: 'x-finish-again', session: 'session-owner', stateRoot: root, step: 'finish' }

  assert.equal((await dispatch('crossfire/review.advance', { ...base, summary: 'v1' })).ok, true)
  assert.equal((await dispatch('crossfire/review.advance', { ...base, summary: 'v2' })).ok, true)

  const record = await readRecord(root, 'x-finish-again')
  assert.equal(record.history.length, 1, '重复定稿不得叠出第二条快照')
  assert.equal(record.history[0].revisedSummary, 'v2', '原地更新为最新一次定稿的内容')
})

test('review.advance(recheck)：并发两次只推进一轮（A6）', async () => {
  const root = await seedReview('x-recheck-parallel', (record) => {
    record.status = 'settled'
    record.maxReviewPass = 3
    record.history = [{
      pass: 1, subject: 's', stanceText: '', dimensions: ['安全'], intensity: 'quick', finishedAt: 1,
      defects: [{
        id: 'u1#1', utteranceId: 'u1', expertKey: '安全', content: '旧账', dimension: '安全',
        status: 'endorsed', ts: 1, seq: 1,
      }],
    }]
  })
  const { runtime } = await makeRuntime()
  const dispatch = registerRpc(fakeCtx(), runtime)
  const payload = { reviewId: 'x-recheck-parallel', session: 'session-owner', stateRoot: root, step: 'recheck' }

  const [left, right] = await Promise.all([
    dispatch('crossfire/review.advance', payload),
    dispatch('crossfire/review.advance', payload),
  ])
  const accepted = [left, right].filter((result) => result.ok)
  assert.equal(accepted.length, 1, '并发两次只允许开一轮')
  assert.equal(accepted[0].value.reviewPass, 2)
  assert.match([left, right].find((result) => !result.ok).error.message, /only a settled review/)

  const record = await readRecord(root, 'x-recheck-parallel')
  assert.equal(record.reviewPass, 2, '轮次只能 +1（旧实现会让两个请求各自 +1）')
  assert.equal(record.budget.usedRounds, 2, 'usedRounds 必须与 reviewPass 同进同退')
  assert.equal(record.defects.length, 1, '核对项来自上一轮已认定的缺陷')
  assert.equal(record.experts.length, 0)
  assert.equal(record.status, 'attacking')
})
