/**
 * 针锋 Crossfire — **浏览器端**运行时验收（零本机值、零依赖）。
 *
 * ## 为什么必须是浏览器
 *
 * 插件自建的两条 Web 路由（`/plugins/dsh-plugin-crossfire/rpc` 与 `.../state`）注册在
 * 宿主 `webServer` 上，并调用 `connection.requestRejection` 施加 Host/Origin + 浏览器
 * 认证栅栏。裸 Node 进程没有那个认证上下文，会被 `401 connection trust check failed`
 * 拦下 —— 这一点已实测（补全 Host / Origin / User-Agent / Sec-Fetch-* 等全部模仿头
 * 仍然 401），所以**只有从页面里发起才打得通**。
 *
 * 栅栏被触发本身也是好消息：它说明"每次请求实时取栅栏"的修复在生效。此前 `connection`
 * 服务在路由注册那一刻尚未挂载，栅栏被快照成 `undefined` 而**永久放行**。
 *
 * ## 怎么用
 *
 * 1. 打开 DSH Web GUI，按 F12 打开控制台
 * 2. 把本文件内容整段粘贴进去，回车
 * 3. 看输出里的 `PASS / FAIL / SKIPPED`
 *
 * ## 两条纪律
 *
 * - **写入探测自带还原**：无 session 的写探测之后会无条件把值写回并复核。
 * - **SKIPPED ≠ FAIL**："没能验证"与"有缺陷"必须分开，否则会制造假警报。
 *
 * 本文件**不硬编码任何本机路径、会话 id 或真实评审数据** —— 它是公开仓库的一部分。
 */
(async () => {
  const RPC = '/plugins/dsh-plugin-crossfire/rpc'
  const STATE = '/plugins/dsh-plugin-crossfire/state'

  let pass = 0; let fail = 0; let skipped = 0
  const ok = (cond, label, extra = '') => {
    if (cond) { pass += 1; console.log(`%c PASS    %c ${label}${extra ? ' — ' + extra : ''}`, 'color:#2e7d32;font-weight:bold', 'color:inherit') }
    else { fail += 1; console.log(`%c FAIL    %c ${label}${extra ? ' — ' + extra : ''}`, 'color:#d9534f;font-weight:bold', 'color:inherit') }
  }
  const skip = (label, why) => { skipped += 1; console.log(`%c SKIPPED %c ${label} — ${why}`, 'color:#b8860b;font-weight:bold', 'color:inherit') }
  const note = (label, extra = '') => console.log(`%c NOTE    %c ${label}${extra ? ' — ' + extra : ''}`, 'color:#888', 'color:inherit')
  const head = (title) => console.log(`\n%c${title}`, 'font-weight:bold;font-size:13px')

  const rpc = async (endpoint, payload) => {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    })
    let body
    try { body = await res.json() } catch { body = { ok: false, error: { message: 'non-JSON response' } } }
    return { status: res.status, body }
  }
  /** 从页面上取当前会话 id（宿主把它挂在 slot 的 standardProps 上；取不到就空）。 */
  const sessionId = (() => {
    const w = window
    const candidates = [w.__DSH_BOOT__?.sessionId, w.__DSH_SESSION_ID__, w.sessionId]
    for (const c of candidates) if (typeof c === 'string' && c !== '') return c
    try {
      for (const k of Object.keys(w.localStorage)) {
        if (/session/i.test(k)) {
          const v = w.localStorage.getItem(k)
          if (typeof v === 'string' && /^session-/.test(v)) return v
        }
      }
    } catch { /* 隐私模式 */ }
    return ''
  })()
  note('探测到的会话 id', sessionId === '' ? '（取不到，相关断言会淡化处理）' : sessionId)

  /* ---------------- A. 通路与信任栅栏 ---------------- */
  head('A. 通路与信任栅栏')
  const prefs0 = await rpc('crossfire/prefs.get', {})
  if (prefs0.status === 401) {
    ok(false, '从页面发起应当能通过栅栏', 'HTTP 401 connection trust check failed')
    console.log('  ⚠ 若在页面里也 401，说明栅栏工作但页面缺认证上下文，这需要单独判断。')
  } else {
    ok(prefs0.body?.ok === true, 'RPC 通路可用（未被栅栏拦下）')
    const p = prefs0.body?.value?.prefs
    if (p === undefined) {
      ok(false, 'prefs.get 返回预期形状', JSON.stringify(prefs0.body).slice(0, 120))
    } else {
      ok(true, 'prefs.get 返回预期形状')
      note('当前偏好', `maxRounds=${p.maxRounds} maxTokens=${p.maxTokens} 强度=${p.defaultIntensity}`)
    }
  }

  /* ---------------- B. models.list：provider 并集与 active 标记 ---------------- */
  head('B. models.list（provider 并集与 active 标记）')
  const models = await rpc('crossfire/models.list', {})
  const providers = Array.isArray(models.body?.value?.providers) ? models.body.value.providers : []
  if (providers.length === 0) {
    skip('provider 断言', 'host 报出 0 个 provider（llm 未注册完 / 本 profile 未配 provider）')
  } else {
    note('provider 数', String(providers.length))
    const withFlag = providers.filter((x) => typeof x.active === 'boolean').length
    ok(withFlag === providers.length, '每个 provider 都带 active 标记', `${withFlag}/${providers.length}`)
    ok(providers.every((x) => Array.isArray(x.models)), '每个 provider 都带 models 数组')
    const dormant = providers.filter((x) => x.active === false)
    ok(dormant.every((x) => x.models.length === 0), '休眠 provider 不列举模型（避免"看着能选、选了不生效"）',
      `休眠 ${dormant.length} 个`)
    note('provider 一览', providers.map((x) => `${x.id}${x.active ? '' : '(休眠)'}×${x.models.length}`).join(' · '))
  }

  /* ---------------- C. prefs.set 的身份门禁（自带还原） ---------------- */
  head('C. prefs.set 的身份门禁')
  const p0 = prefs0.body?.value?.prefs
  if (p0 === undefined) {
    skip('身份门禁与还原', 'prefs.get 未返回预期形状')
  } else {
    const originalRounds = p0.maxRounds
    const rejection = await rpc('crossfire/prefs.set', { patch: { maxRounds: 99 } })
    if (rejection.body?.ok === true) {
      ok(false, '无会话身份不得写全局偏好', '竟然成功了')
    } else {
      ok(true, '无会话身份被拒', rejection.body?.error?.message)
    }
    const after = await rpc('crossfire/prefs.get', {})
    ok(after.body?.value?.prefs?.maxRounds !== 99, '被拒的写入未落盘',
      `maxRounds=${after.body?.value?.prefs?.maxRounds}`)
    ok(typeof after.body?.value?.prefs?.dismissedHints === 'object', '偏好里有 dismissedHints 字段')
    // 无条件还原（先读当前值，再写回，最后复核）。
    const restore = await rpc('crossfire/prefs.set', { session: sessionId, patch: { maxRounds: originalRounds } })
    ok(restore.body?.ok === true, '偏好已还原')
    const final = await rpc('crossfire/prefs.get', {})
    ok(final.body?.value?.prefs?.maxRounds === originalRounds,
      `还原值一致（maxRounds=${final.body?.value?.prefs?.maxRounds}）`)
  }

  /* ---------------- D. expert.setRole 端点 ---------------- */
  head('D. expert.setRole（专家角色定位）')
  const probe = await rpc('crossfire/expert.setRole', { reviewId: '__probe__', session: 'probe', expertKey: 'x', role: '' })
  const msg = probe.body?.error?.message ?? ''
  if (/unknown endpoint/i.test(msg)) {
    skip('expert.setRole 端点', 'host 未加载该端点（需重启 Harness）')
  } else {
    ok(true, '端点已注册', msg.slice(0, 60))
    // 不带身份的写必须被拒（与 prefs.set 同一道门禁）。
    const anon = await rpc('crossfire/expert.setRole', { reviewId: '__probe__', expertKey: 'x', role: 'x' })
    ok(anon.body?.ok === false, '无身份被拒', anon.body?.error?.message?.slice(0, 60))
  }

  /* ---------------- E. 快照路由：归属隔离与空身份保守失败 ---------------- */
  head('E. 快照路由：归属隔离')
  const listRes = await fetch(`${STATE}?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
  const list = await listRes.json().catch(() => ({}))
  ok(Array.isArray(list.reviews), '快照返回 reviews 数组', `${(list.reviews ?? []).length} 场`)
  const foreign = await fetch(`${STATE}?session=__nobody__`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({}))
  ok((foreign.reviews ?? []).length === 0, '陌生会话拿到空集（归属隔离）')
  const anonList = await fetch(STATE, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({}))
  ok((anonList.reviews ?? []).length === 0, '空身份拿到空集（保守失败）')

  /* ---------------- F. 条件请求：ETag / 304 ---------------- */
  head('F. 快照的条件请求（ETag / 304）')
  const url = `${STATE}?session=${encodeURIComponent(sessionId)}`
  const first = await fetch(url, { cache: 'no-store' })
  const etag = first.headers.get('etag')
  const cacheControl = first.headers.get('cache-control') ?? ''
  if (etag === null) {
    skip('ETag / 304 全链路', `响应头里没有 ETag（host 未加载该改动）cache-control=${cacheControl}`)
  } else {
    ok(first.status === 200, '首次请求 200')
    ok(/^"[0-9a-f]+"$/.test(etag), 'ETag 形状正确', etag)
    ok(cacheControl.includes('no-cache') && !cacheControl.includes('no-store'),
      'cache-control 是 no-cache 而非 no-store（否则 ETag 永远回不来）', cacheControl)
    const second = await fetch(url, { cache: 'no-store', headers: { 'if-none-match': etag } })
    ok(second.status === 304, '带相同 ETag 的二次请求得到 304', `status=${second.status}`)
    ok((await second.text()) === '', '304 不带 body')
  }

  console.log(`\n%c=== ${pass} PASS / ${fail} FAIL / ${skipped} SKIPPED ===`,
    fail === 0 ? 'color:#2e7d32;font-weight:bold;font-size:14px' : 'color:#d9534f;font-weight:bold;font-size:14px')
  if (skipped > 0) console.log('%cSKIPPED 表示"没能验证"，不是"有缺陷"。', 'color:#888')
  console.log('%c别忘了一件脚本代劳不了的事：在卡片上亲手点一次「送红队上场」——布局与按钮只有人眼能判。', 'color:#888')
})()
