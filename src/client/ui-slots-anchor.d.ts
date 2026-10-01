/**
 * Type-anchor shim for `@deepseek-ai/dsh-client-ui-slots` (+ the `ctx.effect`
 * overloads a consumer build drops).
 *
 * ## 为什么这个文件必须保持 GLOBAL SCRIPT（关键约束，勿加 import/export）
 *
 * 本文件声明了 ambient module `@deepseek-ai/dsh-client-ui-slots`。按 TypeScript
 * 的规则，`declare module '...'` 只有在文件**没有顶层 import/export** 时才是
 * ambient 模块声明；加一行 import 就变成 module augmentation，必须解析到一个
 * 真实模块，并以 `TS2664` 失败。
 *
 * 这个区分在这里是承重的：`src/client/locales.ts` 要增强同一个模块名来登记
 * `LocaleNamespaceMap`，它的增强能解析，正是因为本文件提供了那个 ambient 模块。
 * 实测：在本文件加一行 `import type` 会让本文件与 `locales.ts` 同时以
 * `TS2664: module '@deepseek-ai/dsh-client-ui-slots' cannot be found` 报错。
 *
 * 所以：永远不要给本文件加顶层 import/export，也永远不要删它 ——
 * `@deepseek-ai/dsh-client-ui-slots` 确实没有发布（node_modules、npx 缓存与
 * lockfile 里都没有；它只作为 dsh-client-ui-renderer 的 devDependency 类型锚，
 * 以及 web 壳 bundle 里的种子条目存在）。
 *
 * ## 与圆桌会议那份的关系
 *
 * 本文件是 `@y9931666/dsh-plugin-roundtable` 的 `ui-slots-anchor.d.ts` 的结构性
 * 副本，类型名改成 `Crossfire*` 前缀以免两个插件在同一 TS 程序里发生接口合并
 * 冲突。**mirror 关系必须与宿主真实 face 逐成员一致**：曾经（圆桌 v0.2.2）手写
 * 一个 2 成员的精简 face，结果它赢下了接口合并、把宿主真正的 `SlotRegistry`
 * 遮蔽掉，`entries`/`subscribe`/`snapshot` 等成员全部消失。
 *
 * ## 已知的宿主侧限制
 *
 * `SlotRegistry['register']` 对所有消费者都退化成 `any`，因为宿主把它声明为
 * `SlotCore['register']`，而 `SlotCore` 住在未发布的 ui-slots 包里。所以下面
 * 保留的精确签名是**从宿主运行时实测**的，而不是 import 来的：
 * `dsh-client-ui-renderer/lib/client.js` → `_register(options, component)`，返回
 * 一个 disposer（`() => void`）。
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Registry of locale namespaces -> dictionary key unions, merged by every client package. */
  interface LocaleNamespaceMap {}
  /** Registry of declared slot keys, merged by every client package. */
  interface SlotMap {}
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Renderer-owned UI composition registry — mirror of the host's real `SlotRegistry`. */
    slots: CrossfireSlotsService
    /**
     * Fiber effect registration. cordis ships this merge from its internal
     * `fiber.d.ts`, but loading any client package augmentation (locale,
     * ui-conversation, …) drops it in a consumer build; redeclare the
     * callable overloads here so `ctx.effect(...)` keeps typechecking.
     */
    effect(execute: () => () => void, label?: string): unknown
    effect(execute: () => unknown, label?: string): unknown
  }
}

/**
 * One synchronous effect installed while an injected slot declaration is live.
 * Matches the host's `SlotInjectionEffect`: a disposer, or an iterable of them.
 */
type CrossfireSlotInjectionEffect = (() => void) | Iterable<() => void>

/**
 * Registration descriptor consumed by `register` (host `SlotSpec` subset this
 * plugin uses; `name`/`id` required, `order`/`label`/`locale`/`inject`/`store`
 * carried through to the SlotCore entry).
 */
interface CrossfireSlotEntry {
  name: string
  /**
   * Entry id for `id`-dispatched slots (`settings.section`, `conversation.view`).
   * Optional because a **keyed** slot is claimed with `key` instead — the host's
   * own official example registers `tool.call.toolview` as
   * `{ name: 'tool.call.toolview', key: '<tool name>' }` **without** an `id`.
   */
  id?: string
  /**
   * Dispatch key for a `keyed` slot. For `tool.call.toolview` the key IS the wire
   * tool name, and the key domain is open: registering one of your OWN tool names
   * is additive, a key the shipped composition already covers is replaced, and an
   * unclaimed key falls back to the generic tool row.
   *
   * 反面警告（实测）：`conversation.chat.node` 看起来也能插卡片，但它的 key 域是
   * **宿主固定表**（`ChatNodeKind`：tool-call / user / assistant-step / …），插件
   * 加不了新 kind；强行占用等于遮蔽官方渲染。所以轨迹内卡片只有 toolview 一条路。
   */
  key?: string
  order?: number
  label?: string | (() => string)
  locale?: string
  inject?: () => unknown
  children?: Record<string, unknown>
  store?: unknown
  registrant?: string
}

/**
 * Mirror of the host `SlotRegistry` service face (0.2.0-rc.2), restricted to
 * the members a plugin may call. Registration APIs are the documented ones;
 * the `install*`/`provide*`/`bind*`/`renderSlot` boot APIs belong to the shell
 * and are intentionally omitted until this plugin needs them.
 */
interface CrossfireSlotsService {
  /**
   * The single registration API (descriptor + rendered component).
   * Measured from the host runtime; upstream type degrades to `any`.
   */
  register(entry: CrossfireSlotEntry, component: unknown): () => void
  /**
   * Install an effect for each declaration lifetime of a slot. The callback
   * runs synchronously when the declaration already exists, otherwise inside
   * the declaring `register()` call.
   */
  inject(key: keyof SlotMap & string, callback: () => CrossfireSlotInjectionEffect): () => void
  /** Snapshot entries for a key (render-erased view). */
  entries(key: keyof SlotMap & string): readonly unknown[]
  /** Shadowing winners per cell for a key. */
  entriesOfSlot(key: keyof SlotMap & string): readonly unknown[]
  /** Export the current JSON-safe Slot declaration tree for read-only inspection. */
  snapshot(root?: string): unknown[]
  /** Observe entry boundary crashes; the returned unsubscribe is caller-owned. */
  onEntryError(fn: (key: string, entry: unknown, error: unknown, info: { abdicated: boolean }) => void): () => void
  /** Look up a declared spec (register-declared or the built-in 'root'). */
  spec(key: keyof SlotMap & string): unknown
  /** Subscribe to a key's registration changes (microtask-batched). */
  subscribe(key: keyof SlotMap & string, fn: () => void): () => void
  /** Version counter for uSES pairing. */
  getVersion(key: keyof SlotMap & string): number
}
