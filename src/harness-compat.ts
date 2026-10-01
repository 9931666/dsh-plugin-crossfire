/**
 * 宿主兼容与能力边界（Host compatibility boundary）——「可选能力的懒探测层，绝不成为加载门禁」。
 *
 * **所有与 DSH 版本相关的形状都集中在这个文件里。**
 * 理由与做法直接借鉴社区项目 dsh-agent-teams 的 `src/harness-compat.ts`：
 *
 * > Keep version-specific shapes here: **API presence alone is not a promise of
 * > support for future versions.**
 *
 * 我们的宿主是 **rc 线**，API 尚未冻结，破坏性变更属于常态。所以在写任何
 * `ctx.get(...)` / `ctx.on(...)` / 服务方法调用之前，先问一句：**这个形状在别的
 * rc 上还成立吗？** 如果答案需要翻源码，那它就应该写进本文件，而不是散进业务代码。
 *
 * 两条铁律：
 *   1. **探测绝不成为新的加载门禁**。这里没有 `inject`、没有静态导入宿主包，
 *      缺失的能力一律降级（返回 `undefined`），进程照常起来 ——「整个界面消失」
 *      这类事故的根因就是可选能力被当成必需能力。本文件只做**懒探测**：
 *      调用方用到哪条路由、哪份工作区列表，才在那一步探测一次。
 *   2. **降级由调用方留痕**。这里刻意**不打日志、不维护审计表**（探测点常落在
 *      tick / 轮询路径上，见文末说明）：本层只负责把"能不能用"如实回答成
 *      `undefined` 或服务面，把"为什么没用上"交给拿到 `undefined` 的调用方
 *      记一条告警，让"某个功能为什么没生效"有一个能查的答案。
 *
 * @module @y9931666/dsh-plugin-crossfire/harness-compat
 */

import type { Context } from '@deepseek-ai/cordis'

/* ------------------------------------------------------------------ *
 * 1. 服务读取（绝不成为加载门禁）
 * ------------------------------------------------------------------ */

/**
 * 读一个**可选**宿主服务。
 *
 * 统一走 `ctx.get`（cordis 核心、非严格：缺失返回 `undefined`）而不是属性访问
 * —— 后者在没有 `inject` 时会**直接抛错**：
 * `cannot get property "connection" without inject`。
 *
 * 三种失败一律折成 `undefined`，**本函数不产生任何副作用**：
 *   - 宿主 `Context` 上连 `get` 都没有（形状变化）；
 *   - `ctx.get(name)` 自己抛错；
 *   - 服务未挂载（返回 `null` / `undefined`）。
 * 调用方拿到 `undefined` 后自行决定降级行为与是否留下一条诊断。
 */
export function optionalService<T>(ctx: Context, name: string): T | undefined {
  const getter = (ctx as unknown as { get?: (service: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  let service: unknown
  try {
    service = getter.call(ctx, name)
  } catch {
    return undefined
  }
  if (service === undefined || service === null) return undefined
  return service as T
}

/** 可选服务键的结构式候选（宿主可能改名；按序取第一个可用的）。 */
export const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
export const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const

/** webServer 服务面（只声明我们真正调用的部分）。
 *
 *  `register` 的返回值刻意只声明为 `() => void`：宿主不同 rc 上返回过
 *  disposer 与 `unknown`，而调用处一律以 `ctx.effect(() => webServer.register(…))`
 *  的形式**忽略返回值**——effect 自带卸载。声明成 `unknown` 会让
 *  `ctx.effect` 的重载解析失败（它要求回调返回具体 Effect，不接受 unknown），
 *  所以这里保留"当它是清理函数"的写法。 */
export interface WebRouteHost {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> | void
  }): () => void
}

/** workspace 注册表面。 */
export interface WorkspaceListHost {
  list(): { title: string; path: string }[]
}

/**
 * 解析 webServer 服务面。
 *
 * 服务键是**结构式候选**而非固定名：宿主可能把 `webServer` 换成别的名字，
 * 所以按 `WEB_SERVER_KEYS` 顺序探测。headless profile 下取不到属预期，
 * 只降级不报错（返回 `undefined`，本函数不抛错也不打日志）。
 */
export function webRouteHostOf(ctx: Context): WebRouteHost | undefined {
  for (const key of WEB_SERVER_KEYS) {
    const host = optionalService<WebRouteHost>(ctx, key)
    if (host !== undefined && typeof host.register === 'function') return host
  }
  return undefined
}

/** 解析 workspace 注册表面（同上：结构式候选 + 静默降级为 `undefined`）。 */
export function workspaceRegistryOf(ctx: Context): WorkspaceListHost | undefined {
  for (const key of WORKSPACE_KEYS) {
    const host = optionalService<WorkspaceListHost>(ctx, key)
    if (host !== undefined && typeof host.list === 'function') return host
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * 2. 清理函数形状判定（宿主返回值随 rc 变化）
 * ------------------------------------------------------------------ */

/**
 * 判定一个 `rpc.handle(...)` 返回值能不能当清理函数用。
 *
 * 宿主签名在 rc 线上变过：0.1.1 时代第三参 `{ authority }` 被移除，返回值在
 * 不同版本里出现过 `disposer` / `undefined` / Promise。这里只做**形状判定**，
 * 不 import 宿主类型：合法就交出去，不合法就交给调用方记一条降级。
 */
export function asDisposer(value: unknown): (() => void) | undefined {
  return typeof value === 'function' ? (value as () => void) : undefined
}

/**
 * 在可选的清理函数存在时注册一个 effect。
 *
 * `connection.rpc.handle` 的返回值形状随版本变化，直接 `ctx.effect(() => () =>
 * release())` 会在返回值不是函数时静默留下一个永远不执行的清理器（通道泄漏）。
 *
 * @returns `true` 表示已注册 effect；`false` 表示返回值不是清理函数、**没有**注册
 * （调用方据此决定是否报告一次降级）。
 */
export function effectWithOptionalDisposer(
  ctx: { effect(callback: () => () => void, label?: string): unknown },
  disposer: unknown,
  label: string,
): boolean {
  const release = asDisposer(disposer)
  if (release === undefined) return false
  ctx.effect(() => () => {
    release()
  }, label)
  return true
}

/* ------------------------------------------------------------------ *
 * 3. 为什么这里没有审计表
 * ------------------------------------------------------------------ */

/**
 * 圆桌插件曾在本文件维护一张进程级能力审计表（`capabilityAudit` /
 * `noteCapability` / `formatCapabilityAudit`），让 `status` 与 `doctor` 能打印
 * "每个探测点第一次被看到时是什么状态"。
 *
 * crossfire 不搬这套：本文件现在的定位是**纯粹的可选能力懒探测层** ——
 * 只回答"这个服务此刻能不能用"，不留全局状态、不写日志、不参与加载决策。
 * 诊断信息由**探测的调用方**在拿到 `undefined` 时按自己的上下文报告；
 * 这样探测层不持有跨调用状态，也不会在轮询路径上积累内存。
 */
