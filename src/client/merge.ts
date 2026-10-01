/**
 * 预设 / 阵容的列表合并规则（纯函数）。
 *
 * ## 为什么单独一个模块
 *
 * 它修的是一个**静默数据丢失**：设置页编辑既有条目后保存，界面报"已保存"，改动却被
 * 丢掉。链路是
 *   客户端 append 同 id 条目（旧比较判据在编辑场景下必然走 append）
 *   → host `sanitizeRolePresets` 按 id 去重、保留**第一个**（= 编辑前的旧值）
 *   → 界面拿到回包里的旧值，用户的编辑无声消失。
 *
 * 症状与"保存失败"完全不同（没有任何错误提示），所以只有断言能钉住它。
 *
 * 放在独立的 `.ts` 里而不是 `SettingsView.tsx` 内：Node 的 type stripping 支持 `.ts`，
 * 但**不支持 `.tsx`**（JSX 无法剥离），所以测试只能 import `.ts` 模块。
 *
 * @module dsh-plugin-crossfire/client/merge
 */

import type { WireRolePreset, WireRoleSquad } from './wire.ts'

/**
 * 把一条预设并入数组：**同 id 就地替换，新 id 才追加**。
 *
 * 位置保持不变（编辑不应把条目挪到末尾，否则列表顺序会在每次编辑后跳动）。
 */
export function mergePreset(
  list: readonly WireRolePreset[],
  preset: WireRolePreset,
): WireRolePreset[] {
  const exists = list.some((item) => item.id === preset.id)
  return exists ? list.map((item) => (item.id === preset.id ? preset : item)) : [...list, preset]
}

/** 阵容版本：与 {@link mergePreset} 同一规则（同 id 就地替换，新 id 追加）。 */
export function mergeSquad(list: readonly WireRoleSquad[], squad: WireRoleSquad): WireRoleSquad[] {
  const exists = list.some((item) => item.id === squad.id)
  return exists ? list.map((item) => (item.id === squad.id ? squad : item)) : [...list, squad]
}
