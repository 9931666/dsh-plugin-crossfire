/**
 * 维度归一化：把模型自由输出的维度标签收敛到**本次评审实际采用的维度**里。
 *
 * ## 为什么必须有这一层
 *
 * 抽样 5 份真实圆桌 `review.json`，`dimension` 的实值是：
 *
 *   `维度②` ×5   `维度④` ×1   `其他` ×4   空串 ×1
 *
 * 只有 1 份给出了有意义的 `架构/产品/成本`。根因是 LLM 拆分经常失败并退到本地
 * 启发式兜底，而兜底把段首的圆圈数字（①②）直接当成了维度名。用户看到的因此
 * 是一堆编号而不是维度 —— 这直接废掉了"按维度看覆盖面"这件事。
 *
 * 所以 crossfire 的规则是：**落库的 `dimension` 必须是本次采用维度之一**，
 * 越界值归一化到最近的一项并留下 `dimensionFallback` 标记（可见、可统计，
 * 而不是静默污染）。
 *
 * @module dsh-plugin-crossfire/dimensions
 */

import { DIMENSION_POOL } from './types.ts'

/** 归一化命中的方式（诊断与测试用）。 */
export type DimensionMatch = 'exact' | 'normalized' | 'alias' | 'contains' | 'default'

/** 一次维度归一化的结果。 */
export interface DimensionResolution {
  /** 归一化后的维度。只要 `allowed` 非空，它一定 ∈ allowed。 */
  dimension: string
  /** true = 原始值不在 allowed 中，被归一化过（调用方应记 `dimensionFallback`）。 */
  fallback: boolean
  /** 命中方式。 */
  how: DimensionMatch
}

/**
 * 固定池维度的同义词表（中英混合，含常见越界说法）。
 *
 * 顺序有意义：一个词命中多个维度时取**先定义**的那个（例如「迁移」同时像
 * 「数据」与「兼容」，这里判给「数据」，因为 schema/字段迁移是数据面的事）。
 */
const DIMENSION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  安全: ['security', 'secure', '安全', '安全审查', '权限', '鉴权', '授权', '隐私', '密钥', '凭据', '注入', '漏洞', '攻击面', '越权', '加密', '合规风险'],
  数据: ['data', '数据', 'schema', '字段', '表结构', '迁移', '一致性', '持久化', '备份', '丢失', '序列化', '编码'],
  交互: ['ux', 'ui', '交互', '体验', '可用性', '入口', '提示', '文案', '无障碍', '键盘', '布局', '反馈'],
  性能: ['performance', 'perf', '性能', '延迟', '吞吐', '内存', 'cpu', '缓存', '并发', '扩展性', '规模', '耗时'],
  兼容: ['compat', 'compatibility', '兼容', '版本', '平台', 'windows', 'macos', 'linux', '浏览器', '宿主', '升级', '跨平台'],
  流程: ['process', '流程', '发布', '回滚', '部署', 'ci', '持续集成', '测试', '验收', '灰度', '评审流程', '协作', '职责'],
  反例: ['counter', 'counterexample', '反例', '边界', '极端', '失败路径', '异常', '空值', '假设', '前提', '反直觉', '误导'],
}

/** 判断一个值是否是固定池维度。 */
export function isPoolDimension(value: string): boolean {
  return (DIMENSION_POOL as readonly string[]).includes(value)
}

/** 规范化：去空白、去包裹引号、小写。 */
function normalizeKey(value: string): string {
  return value
    .replace(/[\s\u3000]+/g, '')
    .replace(/^[「【"'“”『\[(（]+|[」】"'“”』\])）]+$/g, '')
    .toLowerCase()
}

/**
 * 把一个自由文本维度收敛到 `allowed` 里。
 *
 * @param raw - 模型/用户给出的原始维度（任意值，非字符串会被当作缺失）。
 * @param allowed - 本次评审实际采用的维度清单（固定池 + 自定义）。
 * @returns 归一化结果；`allowed` 为空时退回固定池。
 */
export function resolveDimension(raw: unknown, allowed: readonly string[]): DimensionResolution {
  const pool = allowed.length > 0 ? allowed : (DIMENSION_POOL as readonly string[])
  const source = typeof raw === 'string' ? raw : ''
  const key = normalizeKey(source)

  if (key === '') {
    const first = pool[0] ?? '其他'
    return { dimension: first, fallback: true, how: 'default' }
  }

  // ① 原样精确命中（allowed 是权威字面值，优先保真）。
  for (const candidate of pool) {
    if (source.trim() === candidate) return { dimension: candidate, fallback: false, how: 'exact' }
  }

  // ② 规范化后命中（大小写、空白、包裹符号差异）。
  for (const candidate of pool) {
    if (normalizeKey(candidate) === key) return { dimension: candidate, fallback: false, how: 'normalized' }
  }

  // ③ 同义词命中：固定池每个维度带一张别名表；只有该维度在 allowed 里才算。
  for (const [poolDimension, aliases] of Object.entries(DIMENSION_ALIASES)) {
    if (!pool.includes(poolDimension)) continue
    if (!aliases.some((alias) => normalizeKey(alias) === key)) continue
    return { dimension: poolDimension, fallback: poolDimension !== source.trim(), how: 'alias' }
  }

  // ④ 包含关系：模型常输出「安全风险」「性能问题」这类带后缀的说法。
  for (const candidate of pool) {
    const candidateKey = normalizeKey(candidate)
    if (candidateKey === '') continue
    if (key.includes(candidateKey) || candidateKey.includes(key)) {
      return { dimension: candidate, fallback: true, how: 'contains' }
    }
  }

  // ⑤ 兜底：本次采用的第一个维度，并明确标记为 fallback。
  const first = pool[0] ?? '其他'
  return { dimension: first, fallback: true, how: 'default' }
}

/**
 * 把一组候选维度收敛成"本次实际采用"的清单。
 *
 * 用于 `crossfire_open`：用户给的维度可能重复、越界、或全是垃圾。结果永远非空
 * （最差退回固定池全集），因为"没有维度"会让分发逻辑无处安放。
 */
export function resolveDimensions(raw: unknown, customAllowed: readonly string[]): string[] {
  const pool: string[] = [...DIMENSION_POOL]
  for (const extra of customAllowed) {
    if (!pool.includes(extra)) pool.push(extra)
  }
  if (!Array.isArray(raw)) return pool
  const out: string[] = []
  for (const item of raw) {
    const { dimension } = resolveDimension(item, pool)
    if (!out.includes(dimension)) out.push(dimension)
  }
  return out.length > 0 ? out : pool
}
