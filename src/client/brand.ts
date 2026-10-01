/**
 * Provider 品牌标识（彩色圆角块 + 缩写）—— 零资源依赖。
 *
 * ## 为什么不用真 logo
 *
 * 圆桌会议的做法是 `PROVIDER_BRAND`（正则 → key）+ `brand-logos.generated.ts`
 * （**330 KB 的 base64 图片**）。本插件刻意**不复制那个文件**：它会把包体积撑大
 * 约三倍，而收益只是"块里换成图片"。这里只取同一份方案的**缩写 + 品牌色**：
 * 品牌色圆角块 + 2–3 字母缩写，代价为零。
 *
 * ## 一条必须守住的边界
 *
 * 品牌色是**第三方商标色**，不是主题令牌 —— 主题令牌无法表达"DeepSeek 是蓝的"。
 * 因此它只用于**小面积的身份标记**（头像块），文字一律保持 `currentColor`：
 * 浅色/深色主题下可读性由底色与白字的对比度保证，与主题无关。
 * 除此之外本模块不产生任何颜色。
 *
 * 与圆桌 `RoundTableView.tsx` 的 `PROVIDER_BRAND` 保持同源，但**不共享代码**：
 * 两个插件各自独立演进，跨插件 import 会把一份 1888 行的客户端模块拖进本包的
 * 类型程序（`tsconfig.client.json` 只 include `src/client`）。
 *
 * @module dsh-plugin-crossfire/client/brand
 */

/** 品牌色前的 `#` 省略写法留在这里，便于统一校验（全部为 6 位十六进制）。 */
const HEX = '#'

/**
 * Provider → 品牌。顺序即优先级，**首个命中即返回**。
 *
 * 正则刻意写宽：宿主的 provider id 形态不统一（`deepseek-official`、
 * `zai`、`glm`、`anthropic`…），宽匹配比精确表更耐用。
 */
const PROVIDER_BRAND: readonly { readonly match: RegExp; readonly abbr: string; readonly color: string }[] = [
  { match: /deepseek/i, abbr: 'DS', color: `${HEX}4D6BFE` },
  { match: /zhipu|glm|z\.ai|智谱/i, abbr: 'GLM', color: `${HEX}3859FF` },
  { match: /\bzai\b|zai\//i, abbr: 'ZAI', color: `${HEX}3859FF` },
  { match: /openai|gpt/i, abbr: 'GPT', color: `${HEX}10A37F` },
  { match: /anthropic|claude/i, abbr: 'CLD', color: `${HEX}D97757` },
  { match: /qwen|通义/i, abbr: 'QW', color: `${HEX}6E56CF` },
  { match: /moonshot|kimi/i, abbr: 'KM', color: `${HEX}16181D` },
  { match: /gemini|google/i, abbr: 'GM', color: `${HEX}4285F4` },
  { match: /minimax/i, abbr: 'MX', color: `${HEX}0A0A0A` },
]

/** 未知 provider 的中性底色（与 `--dsw-alias-state-idle-*` 同调）。 */
const NEUTRAL_COLOR = `${HEX}8A8A8A`

/** 一位 provider（或一个模型路由）的展示用品牌标识。 */
export interface Brand {
  /** 2–3 字母缩写（最长 3 位，保证块内不折行）。 */
  abbr: string
  /** 品牌底色（圆角块背景）；文字固定白色。 */
  color: string
}

/**
 * provider 名 → 品牌标识。空 / 未识别时退化为中性块。
 *
 * 未识别的兜底与圆桌一致：取名称里的字母数字前两位大写；一个字符都没有时（例如
 * provider 为 `***`）用 `?`，宁可不说话也不编一个假缩写。
 */
export function providerBrand(provider: string | undefined): Brand {
  if (provider === undefined || provider.trim() === '') return { abbr: '?', color: NEUTRAL_COLOR }
  for (const brand of PROVIDER_BRAND) {
    if (brand.match.test(provider)) return { abbr: brand.abbr, color: brand.color }
  }
  const abbr = provider.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase()
  return abbr === '' ? { abbr: '?', color: NEUTRAL_COLOR } : { abbr, color: NEUTRAL_COLOR }
}

/**
 * provider + model 的**路由标记**缩写。
 *
 * 刻意**只返回 provider 的缩写**：这个块画的是 provider 的品牌色，若里面写的是模型名
 * 的首字母（`deepseek-v4-flash` → `DEFL`），一个颜色块就同时表达了两个互相矛盾的身份
 * —— 用户会以为 `DEFL` 是某个 provider。块的语义必须单一：**底色与字母都只属于
 * provider**；模型是哪一档由块右边那行完整路由文本回答（`routeText`）。
 *
 * 参数收下 `model` 只为了在模型缺失时也能给出同一个标记（两者行为一致），
 * 保留它是为了让调用点读起来是"给一个路由"，而不是"给一个 provider"。
 */
export function routeAbbr(provider: string | undefined, model: string | undefined): string {
  void model
  return providerBrand(provider).abbr
}

/**
 * provider + model 的完整可读串（`deepseek-official / deepseek-v4-flash`）。
 *
 * 缩写块有 `title`，但 `title` 在触屏上读不到 —— 列表行因此同时给出完整路由文本。
 */
export function routeText(provider: string | undefined, model: string | undefined): string {
  const parts = [provider, model].filter((part): part is string => part !== undefined && part.trim() !== '')
  return parts.join(' / ')
}
