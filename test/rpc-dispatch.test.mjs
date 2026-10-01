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
import { createPreferenceStore, defaultPreferences } from '../src/preferences.ts'
import { newRecord, writeRecord } from '../src/review.ts'

/** 最小假 ctx：`logger` 供错误路径用，`get`/`agents` 供可选能力探测用。
 *  `agent` 可注入，用来分别驱动"会话活着"与"会话已冷"两条分支。 */
function fakeCtx(agent) {
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
  }
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
