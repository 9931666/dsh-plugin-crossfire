/**
 * dsh-plugin-crossfire — browser half.
 *
 * 批 1 只注册一个 entry：`settings.section`（id `crossfire`）—— 设置页。
 * 批 3 会加 `tool.call.toolview`（key = `crossfire_*` 工具名）承载轨迹内卡片；
 * `conversation.chat.node` **不可用**（宿主固定 key 表，插件加不了新 kind），
 * 这一点已实测，写在这里以免以后有人再试一次。
 *
 * ## inject 为什么只有两个名字
 *
 * cordis 的 `inject` 是**加载门禁**：列进去的服务必须存在，否则整个 client 插件
 * 保持 PENDING —— 表现是"设置页根本不存在"且没有任何报错。`connection` 因此
 * 刻意**不列**，改用 `ctx.get('connection')` 懒取（它就是下面 RPC 兜底传输需要
 * 的东西）。这是圆桌 v0.2.21 用一次真实故障换来的教训。
 *
 * @module dsh-plugin-crossfire/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the settings SlotMap merge ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the tool SlotMap merge ('tool.call.toolview').
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: pulls the conversation SlotMap merge ('conversation.view').
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { CrossfireCard, type CrossfireCardInjected } from './ReviewCard.tsx'
import { CrossfireSettings, type CrossfireSettingsInjected } from './SettingsView.tsx'
import { withSlotBoundary } from './slot-boundary.tsx'
import { en, NS, zh } from './locales.ts'
import { callRpc, type RpcCaller, type RpcEnvelope } from './wire.ts'

/** Required services: the two slot registries plus locale (see module doc). */
export const inject = ['slots', 'locale']

/** Client connection shape: generic RPC caller over the host `/api` channel. */
interface ConnectionHandle {
  rpc: {
    call: (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>>
  }
}

/**
 * `ctx.slots` 是宿主真实的 SlotRegistry face，在 `ui-slots-anchor.d.ts` 里被逐成员
 * 镜像（不能 import：那个 anchor 必须保持 global script，否则
 * `@deepseek-ai/dsh-client-ui-slots` 这个 ambient 模块会消失，本文件与 locales.ts
 * 的增强同时以 TS2664 崩掉）。
 */
type Slots = Context['slots']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'crossfire: dictionaries')

  const slots: Slots = ctx.slots

  // Optional transport: read lazily so this plugin loads whether or not the
  // host's generic connection channel is mounted in the current profile.
  const connection = (ctx as unknown as { get?: (name: string) => unknown })
    .get?.('connection') as ConnectionHandle | undefined

  // Preferred transport: the plugin's own web route. The host connection
  // channel `/crossfire` is the fallback, so an unreachable route degrades
  // instead of breaking the page.
  //
  // 那条通道由 host 侧 `index.ts` 用 `connection.rpc.handle('/crossfire', …)` 真实注册
  // —— 它此前**从未注册**，于是这里的调用必然失败并被吞掉，等于没有兜底（红队评审
  // 抓出的真实缺陷）。现在两条传输都指向同一份 dispatch，行为一致。
  const rpc: RpcCaller = async <T,>(endpoint: string, payload: unknown): Promise<RpcEnvelope<T>> => {
    const direct = await callRpc<T>(endpoint, payload)
    if (direct.ok || connection === undefined) return direct
    try {
      return await connection.rpc.call('/crossfire', endpoint, payload) as unknown as RpcEnvelope<T>
    } catch {
      return direct
    }
  }

  // ---- Settings page (settings.section) --------------------------------
  // Entry is wrapped in a render-failure boundary: DSH retires a slot entry
  // that throws, which would make a plugin bug look like "这一页根本不存在".
  const settingsInjected = (): CrossfireSettingsInjected => ({
    rpc,
    t: ctx.locale.bind(NS) as (key: string) => string,
  })
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'crossfire',
    order: 41,
    label: () => ctx.locale.bind(NS)('settingsNav'),
    locale: NS,
    inject: settingsInjected,
  }, withSlotBoundary(CrossfireSettings)))

  // ---- 会话标签页 (conversation.view, id-dispatched) --------------------
  // 这是**主入口**：与「圆桌会议」并排的一个常驻标签，与工具调用无关。
  //
  // 此前只注册了下面的 toolview 卡片，而卡片挂在某一次 `crossfire_open` 调用的位置
  // 上 —— 既不稳定也不显眼，用户真的会找不到它（实测反馈："我并没有看见针锋"）。
  // 两者现在都在：标签页用来随时查看与操作，卡片用来在轨迹里就地展示某次开审。
  const viewInjected = (): CrossfireCardInjected => ({
    rpc,
    t: ctx.locale.bind(NS) as (key: string) => string,
  })
  slots.inject('conversation.view', () => slots.register({
    name: 'conversation.view',
    id: 'crossfire',
    order: 31,
    label: () => ctx.locale.bind(NS)('tab'),
    locale: NS,
    inject: viewInjected,
  }, withSlotBoundary(CrossfireCard)))

  // ---- Chat 卡片 (tool.call.toolview, keyed by wire tool name) -----------
  // 只认领 `crossfire_open`：那是卡片第一次出现的位置。七个工具全注册会让一场
  // 评审沿轨迹长出七张同样的卡，所以其余调用渲染成通用工具行，而卡片本身每秒
  // 轮询快照、内容自动跟着状态机走。
  //
  // 注册自己的工具名是 additive：未认领的 key 才回退到通用 tool 行，因此这不影响
  // 任何其他工具。槽不存在时 inject 回调不执行，属安全降级。
  const cardInjected = (): CrossfireCardInjected => ({
    rpc,
    t: ctx.locale.bind(NS) as (key: string) => string,
  })
  slots.inject('tool.call.toolview', () => slots.register({
    name: 'tool.call.toolview',
    key: 'crossfire_open',
    inject: cardInjected,
  }, withSlotBoundary(CrossfireCard)))
}
