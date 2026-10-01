/**
 * 偏好层测试的装配层。
 *
 * 存在的理由只有一个：给测试一个**固定的基底偏好**（`DEFAULT_TEST_BASE`），
 * 免得每个用例各写一遍 `defaultPreferences(...)` 并在改动默认值时集体失修。
 * 其余符号原样转出 `src/preferences.ts`，测试里因此只需要 import 一处。
 */
import { defaultPreferences } from '../../src/preferences.ts'

/** 测试基底：强度固定为 standard，其它字段取产品默认值。 */
export const DEFAULT_TEST_BASE = defaultPreferences('standard')

export {
  CUSTOM_DIMENSION_MAX,
  createPreferenceStore,
  defaultPreferences,
  effectiveDimensions,
  normalizePreferences,
  sanitizeCustomDimensions,
  sanitizeRolePresets,
  sanitizeSquads,
} from '../../src/preferences.ts'
