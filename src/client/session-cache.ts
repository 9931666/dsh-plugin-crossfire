/**
 * 会话身份的**浏览器侧缓存**（设置页保存失败的真实修复）。
 *
 * ## 它修的是什么
 *
 * `crossfire/prefs.set` 在宿主侧要求"必须声称一个身份"（`judgeActor(undefined, session)`）。
 * 而宿主的 slot 契约决定了设置页**结构上拿不到** `sessionId` —— 运行时 slot 目录里：
 *
 *   conversation.view   → standardProps 含 `sessionId: SessionId`
 *   tool.call.toolview  → 含
 *   settings.section    → **不含**（只有 useResource / useWorkspaces / usePanelInfo /
 *                          useSessions / useSessionStatus / useSessionRetainInfo）
 *
 * 于是卡片（conversation.view / toolcall）保存偏好成功，而设置页的每一次保存都被
 * 拒成"保存失败"—— Bug 的真实形态：**角色预设 / 阵容预设 / 强度 / 预算全部存不进去**。
 *
 * ## 为什么用一个模块级缓存而不是给设置页造假身份
 *
 * 设置页确实是全局的（偏好也是全局的），但它不能在**不知道自己是谁**的情况下写入。
 * 而会话标签页（`conversation.view`）与轨迹卡片（`tool.call.toolview`）都拿到了宿主
 * 注入的真实 `sessionId` —— 用户打开过任意一个，就等于把身份告诉了插件。这里把它记下来，
 * 供设置页在提交时声明。
 *
 * ## 诚实的边界
 *
 * 冷启动后**直接**打开设置页、且本次会话从未渲染过上述任一入口时，缓存是空的，
 * 保存仍会被宿主拒绝（这是刻意的：插件不编造身份）。绕开方式很简单——先看一眼
 * 「针锋」标签页或对话卡片，再回来保存。
 */

/** 最近一次从宿主注入里观察到的会话 id（空串 = 还不知道）。 */
let lastKnownSessionId = ''

/**
 * 记下宿主注入的会话 id。
 *
 * 只接受非空字符串；重复值不产生副作用。返回是否**发生了变化**，便于调用方避免
 * 无意义的重渲染。
 */
export function rememberSessionId(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === lastKnownSessionId) return false
  lastKnownSessionId = trimmed
  return true
}

/** 当前已知的会话 id（空串 = 尚未观察到，调用方不得据此编造一个）。 */
export function knownSessionId(): string {
  return lastKnownSessionId
}

/** 仅供测试：把缓存恢复到初始状态。 */
export function resetSessionIdCache(): void {
  lastKnownSessionId = ''
}

/**
 * 把一个 payload 补上会话身份（已有 `session` 时不覆盖）。
 *
 * 这是设置页真正用得上的那个函数：它只在**确实知道**身份时才附加字段，否则原样返回，
 * 让宿主按它自己的规则拒绝 —— 而不是伪造一个 `session: ''` 去骗过存在性检查。
 */
export function withSessionIdentity<T extends Record<string, unknown>>(
  payload: T,
): T & { session?: string } {
  if ('session' in payload) return payload
  const known = knownSessionId()
  if (known === '') return payload
  return { ...payload, session: known }
}
