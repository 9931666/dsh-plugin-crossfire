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
 *
 * 追加的三组（同一批红队缺陷）：
 * - C1：状态药丸此前四态恒为 brand 蓝，与抬头 badge 的四态四色冲突（同一句「攻击中」
 *       一屏两色），因此补一条 CSS 契约断言：四个状态各有自己的 `--dsw-alias-*` 底色。
 * - C2：`.defectTitle` 此前没有任何单行约束，80 字标题会折成 2–4 行、长英文 token 还会
 *       横向溢出；样式无法在无 DOM 环境里跑，所以断言规则体里那四条声明仍在。
 * - C3：`fetchReviews` 曾用 `cache: 'no-store'`，浏览器因此不存副本、`If-None-Match`
 *       永不回传，主机侧 `etag.ts` 的 304 静默失效（每 2s 一次全量读盘 + 全量传输）。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defectTitle } from '../src/client/defectTitle.ts'
import { applyPromptResult, togglePromptView } from '../src/client/promptView.ts'
import { fetchReviews, STATE_ROUTE } from '../src/client/wire.ts'

// ---------------------------------------------------------------- B2：标题

test('B2 正常信封仍取前缀（编号 + 定位 + 维度），不受空括号判据影响', () => {
  const content = '观点 1（指向 src/x.ts:10，维度 安全）：这里有个洞'
  // 原标题压缩：完整路径留在正文，标题只取 文件名:行号 + 维度（见下方"标题压缩"用例组）。
  assert.equal(defectTitle(content), '观点 1 · x.ts:10 · 安全')
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

// ------------------------------------------------- 标题压缩（用户实测反馈）

/**
 * 用户反馈的原始现象：折叠态标题**过长导致后面显示不全**，而且"有很多无用信息，
 * 比如路径的位置"。
 *
 * 根因不在提示词、也不在红队：红队写完整路径是**对的**（审计要能定位到文件），
 * 问题在于 `defectTitle()` 把整个信封前缀原样当标题返回。现在标题压缩成
 * `观点 N · 文件名:行号 · 维度`，完整路径仍留在缺陷正文里可追溯。
 */
test('标题压缩：完整路径只留在正文，标题只取文件名+行号+维度', () => {
  const content = '观点 2（指向 dsh-plugin-crossfire/src/client/ReviewCard.module.css:106-176，维度 交互）：药丸与主行动按钮并不"同色配对"……'
  assert.equal(defectTitle(content), '观点 2 · ReviewCard.module.css:106-176 · 交互')
})

test('标题压缩：Windows 反斜杠路径同样压成文件名（且不以路径开头）', () => {
  const title = defectTitle('观点 1（指向 dsh-plugin-crossfire\\src\\client\\wire.ts:205-215，维度 性能）：每 2 秒全量重拉')
  assert.equal(title, '观点 1 · wire.ts:205-215 · 性能')
  assert.ok(!title.includes('dsh-plugin-crossfire'), '标题里不应再出现仓库路径')
})

test('标题压缩：普通相对路径与裸文件名都成立', () => {
  assert.equal(defectTitle('观点 3（指向 src/a.ts:10，维度 安全）：x'), '观点 3 · a.ts:10 · 安全')
  assert.equal(defectTitle('观点 4（指向 README.md，维度 流程）：y'), '观点 4 · README.md · 流程')
})

test('标题压缩：形状不认识时退回原始前缀，绝不硬拼残缺标题', () => {
  // 括号里没有 `指向 / 维度` 的旧格式：原样返回，不猜。
  assert.equal(defectTitle('观点 2 (指向 y)：正文'), '观点 2 (指向 y)')
  assert.equal(defectTitle('观点 3（维度 性能）：正文'), '观点 3（维度 性能）')
  // 有 `指向` 但缺 `维度`：同样退回原始前缀。
  assert.equal(defectTitle('观点 5（指向 src/b.ts:1）：z'), '观点 5（指向 src/b.ts:1）')
})

test('标题压缩：结果必须显著短于原始长信封（这是用户要解决的问题）', () => {
  const long = '观点 1（指向 dsh-plugin-crossfire/src/client/ReviewCard.module.css:1479-1564 与 RoundTableView.tsx:1747-1811，维度 兼容）：圆桌的三个表态按钮颜色映射与文字语义相反……'
  const title = defectTitle(long)
  assert.ok(title.length < long.length, '压缩后必须更短')
  assert.ok(title.length <= 80, `压缩后仍须受 ${80} 字上限约束，实际 ${title.length}`)
  assert.ok(!title.includes('dsh-plugin-crossfire/'), '标题里不再出现长路径')
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

// ------------------------------------------------- C1/C2：两条卡片 CSS 硬约束

const CSS_PATH = new URL('../src/client/ReviewCard.module.css', import.meta.url)

/**
 * 取出一条类规则的规则体。正则要求选择器后面紧跟 `{`，所以 `.defectTitle:hover`
 * 与注释里出现的类名都不会被误取。
 */
function cssBlock(selector) {
  const css = readFileSync(CSS_PATH, 'utf8')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  assert.ok(match !== null, `ReviewCard.module.css 里找不到 ${selector} 规则`)
  return match[1]
}

test('C1 状态药丸按状态取色：四个态各有自己的令牌底色（此前四态同一个蓝）', () => {
  // judging 走缺省值：与主行动按钮同为品牌色。
  assert.ok(cssBlock('.statusState').includes('--dsw-alias-brand-primary'),
    'statusState 缺省底色必须是品牌色令牌（judging）')
  const cases = [
    ['.statusState_draft', '--dsw-alias-state-idle-primary'],
    ['.statusState_attacking', '--dsw-alias-state-warn-primary'],
    ['.statusState_settled', '--dsw-alias-state-success-primary'],
  ]
  for (const [selector, token] of cases) {
    const block = cssBlock(selector)
    assert.match(block, /background:/, `${selector} 必须给出底色`)
    assert.ok(block.includes(token), `${selector} 的底色必须来自 ${token}`)
    // 颜色只许走主题令牌：新增规则里不允许出现硬编码 hex（品牌块是唯一的例外，且不在此处）。
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), `${selector} 不允许硬编码 hex 颜色`)
  }
  // 四态底色必须两两不同，否则又回到"四态一个颜色"的老缺陷。
  const backgrounds = ['.statusState', ...cases.map(([selector]) => selector)]
    .map((selector) => cssBlock(selector).match(/background:\s*([^;]+);/)[1].trim())
  assert.equal(new Set(backgrounds).size, 4, backgrounds.join(' | '))
})

test('C2 折叠态标题被钉死在单行（长标题不撑高折叠体）', () => {
  const block = cssBlock('.defectTitle')
  for (const declaration of [
    'white-space: nowrap',
    'overflow: hidden',
    'text-overflow: ellipsis',
    'overflow-wrap: anywhere',
  ]) {
    assert.ok(block.includes(declaration), `.defectTitle 缺少 ${declaration}`)
  }
})

// ------------------------------------------------- C3：快照请求的缓存头

/** 装上假 fetch 抓 init、跑完一定还原（`--test-isolation=none` 下所有用例共用一个进程）。 */
async function withFakeFetch(run) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve({ status: 200, json: async () => ({ reviews: [] }) })
  }
  try {
    const result = await run()
    return { calls, result }
  } finally {
    globalThis.fetch = original
  }
}

test('C3 fetchReviews 发 cache: no-cache —— no-store 会让 If-None-Match 永不回传', async () => {
  const { calls, result } = await withFakeFetch(() => fetchReviews('sess-1'))
  assert.deepEqual(result, { reviews: [] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${STATE_ROUTE}?session=sess-1`)
  assert.equal(calls[0].init.cache, 'no-cache')
  // 本缺陷的签名：no-store 让浏览器根本不存副本 → 主机侧 etag.ts 的 304 永不发生。
  assert.notEqual(calls[0].init.cache, 'no-store')
})

test('C3 空 session 不拼 query，AbortSignal 原样透传', async () => {
  const controller = new AbortController()
  const { calls } = await withFakeFetch(() => fetchReviews('', controller.signal))
  assert.equal(calls[0].url, STATE_ROUTE)
  assert.equal(calls[0].init.signal, controller.signal)
})

test('C3 路由不可达时返回空列表与 note（卡片宁可空着也不崩）', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'))
  try {
    const failed = await fetchReviews('s')
    assert.deepEqual(failed.reviews, [])
    assert.equal(failed.note, 'ECONNREFUSED')
  } finally {
    globalThis.fetch = original
  }
})
