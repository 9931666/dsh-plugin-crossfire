/**
 * Crossfire（针锋）—— host 插件入口。
 *
 * 它是一个**只做对抗式评审**的 host 插件：把一个已定稿的成果摆上台，让红队
 * 专家从指定维度分头攻击，把攻击拆成逐条可裁决的缺陷，由人逐条认定或驳回。
 *
 * 与圆桌会议（`@huanlin/dsh-plugin-roundtable`）的关系：**零代码耦合**。针锋是从
 * 圆桌里长出来的一件东西，但它不 import 圆桌的任何模块、不读圆桌的状态目录、
 * 不改圆桌的任何文件。两者共存的唯一代价是各自维护一份内核。
 *
 * 批 1 交付：插件骨架（Config + 偏好存储 + 一条 RPC web 路由 + 系统提示段）。
 * 批 2 加数据模型与 `crossfire_*` 工具；批 3 加轨迹内卡片；批 4 加立场区与
 * 设置页全量。
 *
 * @module dsh-plugin-crossfire
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.systemPrompt / ctx.tools / ctx.subagents visible.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-agent'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { attachExpertEvents } from './expert-events.ts'
import { sendJsonConditional } from './etag.ts'
import { usageSectionText } from './prompt.ts'
import { createPreferenceStore, defaultPreferences, type CrossfirePreferences } from './preferences.ts'
import { collectSnapshots, RPC_ROUTE, registerRpc, STATE_ROUTE, type CrossfireRuntime } from './rpc.ts'
import { registerCrossfireTools } from './tools.ts'
import { fenceProbe, MAX_RPC_BODY_BYTES, rejectWebRequest } from './web-guard.ts'
import { WEB_SERVER_KEYS, WORKSPACE_KEYS, effectWithOptionalDisposer, webRouteHostOf } from './harness-compat.ts'

/** 插件名（cordis entry id / 日志前缀 / bundle patch 里的 id）。 */
export const name = 'crossfire'

/**
 * REQUIRED services only —— 这份清单是**加载门禁**，所以它必须短。
 *
 * cordis 没有"可选注入"这种形式（`Inject` 只有 `string[] | Record`，而 record
 * 形式是拦截配置），因此写在这里的每个名字都会让整个插件 fiber 保持 PENDING
 * 直到该服务存在：没有工具、没有 `/plugins/dsh-plugin-crossfire/*` 路由、没有
 * 卡片、也没有设置页。而缺一个**可选**能力却写在这里，在用户眼里就是"针锋整个
 * 不见了"，且任何地方都不报错。
 *
 * 所以 `llm` / `webServer` / `workspaceRegistry` / `connection` 一律**不列**，
 * 全部经 `ctx.get(...)` 或 harness-compat 的探测层懒取：
 *   - `llm` 缺席时，观点拆分退到本地启发式兜底（零 token、确定性）；
 *   - `webServer` 缺席时，只有设置页与卡片失联，host 侧与工具照常工作；
 *   - `connection` 缺席时，RPC 只走插件自有路由。
 */
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt']

/** 插件配置。 */
export interface Config {
  /** 评审状态目录名（相对会话工作区，默认 `.crossfire`）。 */
  stateDir?: string
  /** `ctx.subagents` 里用于拉起红队专家的 provider（默认 `spawn`）。 */
  memberProvider?: string
  /** 一场评审的专家数硬上限（默认 7，与固定维度池同宽）。 */
  maxExperts?: number
  /** 默认攻击强度档（默认 `standard`）。 */
  defaultIntensity?: 'quick' | 'standard' | 'deep'
  /** 专家子代理的委派深度上限（默认 1：专家不得再招人）。 */
  memberMaxDepth?: number
  /** 用法段在全局系统提示里的排序位（默认 117，避开圆桌的 116）。 */
  promptSectionOrder?: number
}

/**
 * 配置 schema（schemastery）。
 *
 * 刻意**不**写 `: z<Config>` 注解：schemastery 的 `.default()` 会把字段推导成
 * `T | Volatile<T>`（例如 `string | Volatile<string>`），而手写接口写的是
 * `string | undefined`，二者不兼容会让 `tsc --emitDeclarationOnly` 以 TS2322
 * 失败 —— 注意 `--noEmit` **不报**这个错，所以它只在生成声明时暴露。
 * schema 自己就是配置形状的权威来源；下面的 `Config` 接口只用于 `apply` 的签名。
 */
export const Config = z.object({
  stateDir: z.string().default('.crossfire'),
  memberProvider: z.string().default('spawn'),
  maxExperts: z.natural().min(1).default(7),
  defaultIntensity: z.union(['quick', 'standard', 'deep']).default('standard'),
  memberMaxDepth: z.natural().default(1),
  promptSectionOrder: z.natural().default(117),
})

export function apply(ctx: Context, config: Config): void {
  const resolved = {
    stateDir: config.stateDir ?? '.crossfire',
    memberProvider: config.memberProvider ?? 'spawn',
    maxExperts: config.maxExperts ?? 7,
    defaultIntensity: config.defaultIntensity ?? 'standard',
    memberMaxDepth: config.memberMaxDepth ?? 1,
  }

  // 用法段进全局系统提示。文本住在 prompt.ts，便于测试断言体积。
  ctx.systemPrompt.section({
    name: 'crossfire:usage',
    order: config.promptSectionOrder ?? 117,
    text: usageSectionText(),
  })

  // 偏好存储：插件 Config 是组合基准，用户偏好赢。在工具/路由注册之前创建，
  // 这样它们的闭包能读到实时值。
  const prefsStore = createPreferenceStore({
    base: defaultPreferences(resolved.defaultIntensity),
    log: (message, error) => {
      if (error === undefined) ctx.logger.warn(message)
      else ctx.logger.warn(message, error)
    },
  })

  // 工具与浏览器 RPC **共用同一份**运行时配置：两条入口必须驱动同一套状态机
  // （O1 直推），所以配置只能有一处来源，否则迟早分叉。
  const runtime: CrossfireRuntime = {
    prefs: prefsStore,
    tools: {
      stateDir: resolved.stateDir,
      memberProvider: resolved.memberProvider,
      maxExperts: resolved.maxExperts,
      ...(resolved.memberMaxDepth === undefined ? {} : { memberMaxDepth: resolved.memberMaxDepth }),
      // 观点拆分的 LLM 路由：默认 deepseek-official/deepseek-v4-flash（圆桌实测可用）。
      // 取不到 llm 服务或该路由不可用时，collect 自动退到本地启发式兜底（零 token、
      // 确定性），因此这不是加载门禁。批 4 会把它做成设置项。
      reviewSplit: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        maxOpinions: 3,
      },
      // 每次调用实时读偏好：改设置对下一场评审立即生效，不需要重启宿主。
      getDefaults: () => {
        const prefs = prefsStore.get()
        return {
          intensity: prefs.defaultIntensity,
          maxRounds: prefs.maxRounds,
          maxTokens: prefs.maxTokens,
          expertMaxTokens: prefs.expertMaxTokens,
          expertMaxOpinions: prefs.expertMaxOpinions,
          customDimensions: prefs.customDimensions,
        }
      },
    },
  }

  // 偏好里的 defaultIntensity 就是"设置页那一层"：用户一改，后续新建评审立即采用。
  const applyDefaultIntensity = (preference: CrossfirePreferences): void => {
    if (preference.defaultIntensity === 'quick'
      || preference.defaultIntensity === 'standard'
      || preference.defaultIntensity === 'deep') {
      resolved.defaultIntensity = preference.defaultIntensity
    }
  }
  runtime.prefs.watch(applyDefaultIntensity)
  // 读盘是异步的：首次加载完成后补同步一次 —— 用户上次选定的强度档不该等到他
  // 再动一次设置才生效。
  void runtime.prefs.ready().then(() => {
    applyDefaultIntensity(runtime.prefs.get())
  }).catch(() => {
    // ready() 内部已把读失败降级为默认值，这里无事可做。
  })

  // 工具面：6 个主持人工具 + 1 个专家工具（crossfire_report）。
  registerCrossfireTools(ctx, runtime.tools)
  // 专家产出自动落盘（即使它没调 crossfire_report 或被中断），失败原因写进专家备注。
  attachExpertEvents(ctx)

  // 同一份 dispatch 会挂到 web 路由上（批 3 起，卡片与工具也会共用它）。
  const dispatchRpc = registerRpc(ctx, runtime)

  // 宿主的通用 rpc 通道 `/crossfire`。
  //
  // 客户端把它当"自有 web 路由不可达时的降级传输"（见 client/index.ts 的注释），
  // 而**这个通道此前从未被注册**：客户端那一行 `connection.rpc.call('/crossfire', …)`
  // 必然失败、被 catch 吞掉，用户可见行为与"根本没有兜底"完全相同；为它写好的
  // `effectWithOptionalDisposer` 也就成了死代码（红队评审抓出的真实缺陷）。
  //
  // 现在真正接上：`connection` 是可选服务（**不列进 inject**，缺席只是少一条传输），
  // 注册失败/返回非法 disposer 时记一条降级，而不是让插件 PENDING。
  const crossfireChannel = (ctx.get('connection') as unknown as {
    rpc?: { handle?: (channel: string, dispatch: unknown) => unknown }
  } | undefined)?.rpc?.handle
  if (typeof crossfireChannel === 'function') {
    const connection = ctx.get('connection') as unknown as {
      rpc: { handle: (channel: string, dispatch: unknown) => unknown }
    }
    const released = effectWithOptionalDisposer(
      ctx,
      connection.rpc.handle('/crossfire', (endpoint: string, payload: unknown) => dispatchRpc(endpoint, payload)),
      'crossfire: rpc channel',
    )
    if (!released) {
      ctx.logger.warn('crossfire: connection.rpc.handle returned no disposer — the fallback channel may leak')
    }
  } else {
    ctx.logger.warn('crossfire: connection.rpc.handle is unavailable — the card will only reach the host over its own web route')
  }

  // Web 面：设置页与（批 3 起的）卡片都靠它。headless profile 可能根本不挂
  // web 服务 —— 那就按服务可用性惰性注册，插件其余部分照常工作。
  let rpcRouteRegistered = false
  let stateRouteRegistered = false
  const registerWebSurface = (): void => {
    const webServer = webRouteHostOf(ctx)
    if (webServer === undefined) {
      // 「降级由调用方留痕」：harness-compat 的探测层是零副作用的，所以这里
      // 必须自己说清楚发生了什么，否则设置页静默打不开而无人能诊断。
      ctx.logger.warn('crossfire: no web route host available — the settings page will not reach the host')
      return
    }
    // 宿主 webserver 不会自动施加 Host/Origin + 浏览器认证栅栏，必须由路由自己
    // 调 `connection.requestRejection`。取不到该服务时放行（最小 profile 不能
    // 因此瘫痪），但只要能取到就一定要用。
    //
    // **刻意在每次请求时实时取，而不是在注册时快照一个闭包**（修红队评审抓出的
    // fail-open 窗口）：路由只在第一次 `registerWebSurface` 时注册（标记位堵死重
    // 注册），若那一刻 `connection` 还没挂载，快照下来的 `undefined` 就会让这两条
    // 路由**永久**失去信任栅栏 —— 而宿主稍后挂上 connection 也不会重新注册。实时取
    // 之后，栅栏一旦可用就立即生效，代价只是一次属性探测。
    // 「降级由调用方留痕」：实时取的同时只提醒一次，避免每个请求刷一条日志。
    const currentFence = fenceProbe(
      () => ctx.get('connection'),
      () => ctx.logger.warn('crossfire: connection.requestRejection is unavailable — plugin web routes run without the Host/Origin + browser-auth fence'),
    )

    if (!rpcRouteRegistered) {
      rpcRouteRegistered = true
      ctx.effect(() => webServer.register({
      kind: 'exact',
      path: RPC_ROUTE,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const send = (status: number, body: unknown): void => {
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(body))
        }
        const rejection = rejectWebRequest(currentFence(), req.headers)
        if (rejection !== undefined) {
          send(rejection, { ok: false, error: { code: 'forbidden', message: 'connection trust check failed' } })
          return
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          send(405, { ok: false, error: { code: 'internal', message: 'this route accepts POST only' } })
          return
        }
        let body: unknown
        try {
          const chunks: Buffer[] = []
          let size = 0
          for await (const chunk of req) {
            size += (chunk as Buffer).length
            // 无上限的请求体等于让任何本机页面把整包塞进内存。
            if (size > MAX_RPC_BODY_BYTES) {
              send(413, { ok: false, error: { code: 'internal', message: 'request body too large' } })
              return
            }
            chunks.push(chunk as Buffer)
          }
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        } catch {
          send(400, { ok: false, error: { code: 'internal', message: 'body must be JSON' } })
          return
        }
        const message = body as { endpoint?: unknown; payload?: unknown } | null
        if (message === null || typeof message !== 'object' || typeof message.endpoint !== 'string') {
          send(400, { ok: false, error: { code: 'internal', message: 'body must be { endpoint, payload? }' } })
          return
        }
        // dispatch 自身绝不抛错（见 rpc.ts）。
        send(200, await dispatchRpc(message.endpoint, message.payload))
      },
      }), 'crossfire: rpc route')
    }

    if (!stateRouteRegistered) {
      stateRouteRegistered = true
      // 快照路由：卡片每秒轮询它。虽然是 GET（只读），仍必须过同一道栅栏 ——
      // 这条会吐出评审正文与用户立场，不能对本机任意页面开放。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const send = (status: number, payload: unknown): void => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(payload))
          }
          const rejection = rejectWebRequest(currentFence(), req.headers)
          if (rejection !== undefined) {
            send(rejection, { reviews: [], note: 'connection trust check failed' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://x')
          const session = url.searchParams.get('session') ?? ''
          const collected = await collectSnapshots(ctx, resolved.stateDir, session)
          // 条件请求：内容未变时回 304，省掉整个响应体的传输与解析（卡片每秒轮询它）。
          // 没有 `if-none-match` 时行为与从前逐字相同 —— 因此这是可增量上线的改动。
          sendJsonConditional(req.headers, res, collected)
        },
      }), 'crossfire: snapshot route')
    }
  }
  registerWebSurface()
  ctx.on('internal/service', (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName as (typeof WEB_SERVER_KEYS)[number])
      || WORKSPACE_KEYS.includes(serviceName as (typeof WORKSPACE_KEYS)[number])) {
      registerWebSurface()
    }
  })
}
