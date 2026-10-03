/**
 * client 侧两项缺陷的单测（红队评审结论 A3 / B2）。
 *
 * 这两处都**发生在渲染之外**（一个字符串函数、一个状态转移），所以把逻辑抽成纯函数
 * 后可以直接测 —— 本仓库没有 jsdom / react 测试环境，也不该为了测它们而引入。
 *
 * A3：`"查看原提示词"` 的展开状态此前用"缓存里有没有这个条目"同时表达"有缓存"与
 *     "已展开"，于是收起即丢缓存（再点变成重新请求），且收起后迟到的响应会把面板
 *     重新弹出来（反弹）。
 * B2：`defectTitle` 接受空括号信封（标题退化成无信息串），且截断不处理换行 ——
 *     而标题按钮是**折叠态唯一可见内容**，内嵌换行直接把卡片撑成多行大块。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defectTitle } from '../src/client/defectTitle.ts'
import { applyPromptResult, togglePromptView } from '../src/client/promptView.ts'

// ---------------------------------------------------------------- B2：标题

test('B2 正常信封仍取前缀（编号 + 定位 + 维度），不受空括号判据影响', () => {
  const content = '观点 1（指向 src/x.ts:10，维度 安全）：这里有个洞'
  assert.equal(defectTitle(content), '观点 1（指向 src/x.ts:10，维度 安全）')
  // 半角括号 + 冒号同义，且多余空白被裁掉。
  assert.equal(defectTitle('观点 2 (指向 y)：正文'), '观点 2 (指向 y)')
  assert.equal(defectTitle('  观点 3（维度 性能）：正文  '), '观点 3（维度 性能）')
})

test('B2 空括号信封不算命中，回退首句（不再返回无信息串）', () => {
  for (const bracket of ['（）', '()', '（ ）', '(  )', '（\t）', '（\u3000）']) {
    // ① 核心回归：信封形状但括号为空、后面接着一长段没有句末标点的正文 —— 旧实现
    //    把 `观点 1（）` 当合法信封直接返回，于是标题就是那条无信息串；新实现走
    //    首句兜底，因此返回的是被截断的**正文**，绝不会只剩括号前缀。
    const long = `观点 1${bracket}${'甲'.repeat(200)}`
    const title = defectTitle(long)
    assert.ok(title.length > `观点 1${bracket}`.length, `${bracket} 标题不应退化成空括号前缀`)
    assert.ok(title.endsWith('…'), bracket)
    assert.ok(title.length <= 81, bracket)
    // ② 空括号后面跟着真内容时，标题取首句（前缀没被当成合法抬头，因此留在句内）。
    const content = `观点 1${bracket}真正的首句。第二句。`
    assert.equal(defectTitle(content), `观点 1${bracket}真正的首句。`, content)
  }
})

test('B2 短文本的空括号信封不再被当成合法信封（判据严格性）', () => {
  // 括号内没有任何非空白、非右括号的字符 → 一律不命中。整串就是首句时返回值与
  // 输入相同是正确的兜底结果；关键是**不能**出现"截断成前缀"的签名（那说明命中了）。
  for (const content of ['观点 1（）', '观点 1（ ）', '观点 1（\u3000）', '观点 1()']) {
    const title = defectTitle(content)
    assert.equal(title, content, content)
    assert.ok(!title.endsWith('…'), content)
  }
  // 合法短信封仍然命中（不能把严格判据做得过头）。
  assert.equal(defectTitle('观点1（维度安全）'), '观点1（维度安全）')
  assert.equal(defectTitle('观点 1 (x)'), '观点 1 (x)')
})

test('B2 含换行的长首段标题不含换行（折叠态标题必须是一行）', () => {
  const longFirstParagraph =
    '这一段故意写得比较长而且故意不写任何句末标点于是整段都会被当作首句候选一二三四五六七八九十'
  const content = `${longFirstParagraph}\r\n第二行\n第三行`
  const title = defectTitle(content)
  assert.ok(!title.includes('\n'), title)
  assert.ok(!title.includes('\r'), title)
  assert.equal(title, '这一段故意写得比较长而且故意不写任何句末标点于是整段都会被当作首句候选一二三四五六七八九十')
})

test('B2 超长单句仍截断并补省略号，上限 80 字符', () => {
  // 首行 200 字且无句末标点 → 截到 80 + 省略号。
  const content = '甲'.repeat(200)
  const title = defectTitle(content)
  assert.equal(title.length, 81)
  assert.equal(title, `${'甲'.repeat(80)}…`)
  // 恰好 80 字不截断：省略号只在**真的截掉了内容**时出现。
  assert.equal(defectTitle('乙'.repeat(80)), '乙'.repeat(80))
  assert.ok(!defectTitle('乙'.repeat(80)).endsWith('…'))
})

test('B2 非信封内容回退首句；空输入不抛错也不返回 undefined', () => {
  assert.equal(defectTitle('第一句。第二句。'), '第一句。')
  assert.equal(defectTitle('单行没有标点'), '单行没有标点')
  // 空串必须安全（"绝不返回空串"这条只针对有内容的输入；空输入不能抛）。
  for (const empty of ['', '   ', '\n\n', '\r\n\r\n']) {
    assert.equal(typeof defectTitle(empty), 'string', JSON.stringify(empty))
    assert.equal(defectTitle(empty), '')
  }
})

// ------------------------------------------------- A3：原提示词展开状态机

const KEY = 'x-1::redteam'
/** 只读快照，用于断言"原表未被就地改动"。 */
const snapshot = (table) => JSON.parse(JSON.stringify(table))

test('A3 无条目时点击 = 展开并请求（写入 loading）', () => {
  const first = togglePromptView({}, KEY)
  assert.equal(first.start, true)
  assert.deepEqual(first.table[KEY], { status: 'loading' })
})

test('A3 已有 ready 条目时点击 = 收起且不触发新请求（缓存不丢）', () => {
  const loaded = { [KEY]: { status: 'ready', persona: '你是红队专家' } }
  const before = snapshot(loaded)
  const toggled = togglePromptView(loaded, KEY)
  // 关键断言：收起不重新请求 —— 这正是"再点收起变成再点重新请求"那条缺陷。
  assert.equal(toggled.start, false)
  assert.deepEqual(toggled.table, {})
  // 原表不可变：togglePromptView 必须返回新对象，不能就地 delete。
  assert.deepEqual(loaded, before)
})

test('A3 error 条目存在时点击 = 收起（失败态不被当成"未加载"无限重拉）', () => {
  const failed = { [KEY]: { status: 'error', message: 'rpc 超时' } }
  const toggled = togglePromptView(failed, KEY)
  assert.equal(toggled.start, false)
  assert.deepEqual(toggled.table, {})
})

test('A3 loading 期间点击 = 收起（不是重复发起第三个请求）', () => {
  const toggled = togglePromptView({ [KEY]: { status: 'loading' } }, KEY)
  assert.equal(toggled.start, false)
  assert.deepEqual(toggled.table, {})
})

test('A3 收起后迟到的响应不得写回（反弹缺陷的回归防线）', () => {
  // 用户点开（loading）→ 又点收起（键被删）→ 响应这才回来。
  const collapsed = togglePromptView(togglePromptView({}, KEY).table, KEY).table
  assert.deepEqual(collapsed, {})
  const after = applyPromptResult(collapsed, KEY, { ok: true, persona: '你是红队专家' })
  assert.deepEqual(after, {})
  // 引用不变：React 的 setState 因此不会触发一次无意义的重渲染。
  assert.equal(after, collapsed)
})

test('A3 仍处于 loading 时写回成功/失败，未展开的键一律丢弃', () => {
  const loading = { [KEY]: { status: 'loading' }, other: { status: 'loading' } }
  const ready = applyPromptResult(loading, KEY, { ok: true, persona: 'P' })
  assert.deepEqual(ready[KEY], { status: 'ready', persona: 'P' })
  // 只动自己的键。
  assert.deepEqual(ready.other, { status: 'loading' })
  const failed = applyPromptResult(loading, KEY, { ok: false, message: 'rpc 超时' })
  assert.deepEqual(failed[KEY], { status: 'error', message: 'rpc 超时' })
  // 从没请求过的键：写回是空操作（否则会凭空冒出一个面板）。
  const untouched = applyPromptResult(loading, 'never::asked', { ok: true, persona: 'P' })
  assert.equal(untouched, loading)
})

test('A3 终态不被迟到的响应覆盖（不出现 ready ↔ error 抖动）', () => {
  const settled = { [KEY]: { status: 'ready', persona: 'P' } }
  const late = applyPromptResult(settled, KEY, { ok: false, message: '迟到的失败' })
  assert.equal(late, settled)
  assert.deepEqual(late[KEY], { status: 'ready', persona: 'P' })
})
