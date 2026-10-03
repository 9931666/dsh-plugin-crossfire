/**
 * "查看专家原提示词"的展开状态机。
 *
 * ## 它修的是什么
 *
 * 展开区此前用"`promptViews[key]` 是否存在"同时表达两件事：**是否有缓存**和
 * **是否展开**。一个变量两个含义，于是两处都错：
 *
 * 1. 命中缓存时直接 `delete`，注释承诺的"只拉一次"变成"每次收起都丢掉缓存"，
 *    再点就是一次新的 RPC；
 * 2. 收起发生在请求返回**之前**时，条目被删掉，但异步回调**无条件**把结果写回，
 *    界面在用户已经收起之后又自己冒出来（反弹）。
 *
 * 修法是显式三态（`loading` / `ready` / `error`）+ 两个纯函数：
 * - {@link togglePromptView}：**看有无条目**决定"发起加载"还是"收起"，绝不二义；
 * - {@link applyPromptResult}：只在**该键仍处于 loading**时写回结果 —— 用户已收起
 *   （键被删）或已经拿到别的结果时，迟到的响应一律丢弃，不再靠 `alive` ref 兜底
 *   （那个只在组件卸载时变化，挡不住"收起"）。
 *
 * 状态转移与 React 无关，因此可以脱离渲染直接单测。
 */

/** 一个 viewKey 对应的展开状态。`loading` 的条目存在 = 已展开且正在等结果。 */
export type PromptView =
  | { status: 'loading' }
  | { status: 'ready'; persona: string }
  | { status: 'error'; message: string }

/** 展开表：键为 `${reviewId}::${expertKey}`。 */
export type PromptViewTable = Record<string, PromptView>

/**
 * 一次点击的结果：新的展开表 + 这次点击**是否需要真的发请求**。
 *
 * `start` 为 false 即"这只是一次收起"，调用方不得发 RPC。
 */
export interface PromptViewToggle {
  readonly table: PromptViewTable
  readonly start: boolean
}

/**
 * 点击"查看原提示词"：无条目 → 写入 `loading` 并要求发请求；有条目 → 删除该条目
 * （收起），`start` 为 false。
 *
 * 三态一律同样对待：`ready` / `error` / 正在 `loading` 的条目，再点都是收起。
 * 失败后保留 `error` 条目正是为此 —— 用户再点即收起，而不是无限重拉。
 */
export function togglePromptView(table: PromptViewTable, key: string): PromptViewToggle {
  if (table[key] !== undefined) {
    const next = { ...table }
    delete next[key]
    return { table: next, start: false }
  }
  return { table: { ...table, [key]: { status: 'loading' } }, start: true }
}

/**
 * 把一次 RPC 结果写回展开表。
 *
 * **只有该键仍处于 `loading` 时才写回**。用户已收起（键不存在）、或该键已经处于
 * 终态时，返回原表**引用不变** —— 这样 `setState` 不会触发一次无意义的重渲染。
 */
export function applyPromptResult(
  table: PromptViewTable,
  key: string,
  result: { readonly ok: true; readonly persona: string } | { readonly ok: false; readonly message: string },
): PromptViewTable {
  const current = table[key]
  if (current === undefined || current.status !== 'loading') return table
  const next: PromptView = result.ok ? { status: 'ready', persona: result.persona } : { status: 'error', message: result.message }
  return { ...table, [key]: next }
}
