/**
 * 品牌标识单测（§5.4）。
 *
 * 这一层是**纯展示**逻辑，但它有一个真实的退化风险：provider 名来自宿主，
 * 形态不受本插件控制。一个没见过的 provider 名不该让界面出现空白块，也不该
 * 让缩写长到把行撑断 —— 所以下面的用例重点是**兜底路径**，而不是那几个已知品牌
 * 的正则命中（那部分错了肉眼立刻能看出来）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerBrand, routeAbbr, routeText } from '../src/client/brand.ts'

test('已知 provider 映射到品牌缩写与品牌色（同源圆桌的那一份）', () => {
  assert.equal(providerBrand('deepseek-official').abbr, 'DS')
  assert.equal(providerBrand('deepseek-official').color, '#4D6BFE')
  assert.equal(providerBrand('anthropic').abbr, 'CLD')
  assert.equal(providerBrand('glm-4').abbr, 'GLM')
  // 大小写不敏感：宿主给的是 id，不是展示名。
  assert.equal(providerBrand('DeepSeek').abbr, 'DS')
})

test('一个 provider 名只命中第一个匹配的品牌（顺序即优先级）', () => {
  // `zai` 同时含 `zai` 与……不含 glm；确保没有落到中性兜底。
  assert.notEqual(providerBrand('zai').color, '#8A8A8A')
})

test('未识别的 provider 退化为中性块 + 至多 2 位大写缩写', () => {
  const brand = providerBrand('my-custom-vendor')
  assert.equal(brand.abbr, 'MY')
  assert.equal(brand.color, '#8A8A8A')
})

test('空值/纯标点的 provider 不产生空块（显示 `?`，不编造缩写）', () => {
  for (const value of [undefined, '', '   ', '***', '---']) {
    assert.equal(providerBrand(value).abbr, '?', String(value))
  }
})

test('缩写长度封顶 3 位（长缩写会把行撑断，块只有 18px）', () => {
  for (const provider of ['deepseek-official', 'anthropic-claude', 'glm', 'moonshot-kimi', 'unknown-provider-name']) {
    assert.ok(providerBrand(provider).abbr.length <= 3, provider)
  }
})

test('routeAbbr 只表达 provider：块不能同时冒充模型', () => {
  // 这条断言是**回归防线**：初版实现把模型名首字母（deepseek-v4-flash → DSFL）写进
  // 了 provider 的品牌色块里 —— 一个块表达了两个身份。块的底色只属于 provider，
  // 字母因此也必须只属于 provider；模型由块右边的 routeText 回答。
  assert.equal(routeAbbr('deepseek-official', 'deepseek-v4-flash'), 'DS')
  assert.equal(routeAbbr('anthropic', 'claude-sonnet-4'), 'CLD')
  assert.equal(routeAbbr('openai', 'gpt'), 'GPT')
})

test('routeAbbr 在模型缺失时行为不变，且绝不返回空串', () => {
  assert.equal(routeAbbr('deepseek-official', undefined), 'DS')
  assert.equal(routeAbbr('deepseek-official', ''), 'DS')
  // provider 与 model 都拿不到时仍然有一个可显示的标记。
  assert.ok(routeAbbr(undefined, undefined).length > 0)
  assert.ok(routeAbbr('***', '***').length > 0)
})

test('routeText 拼出完整路由，缺一侧时不留下悬空分隔符', () => {
  assert.equal(routeText('deepseek-official', 'deepseek-v4-flash'), 'deepseek-official / deepseek-v4-flash')
  assert.equal(routeText('deepseek-official', undefined), 'deepseek-official')
  assert.equal(routeText(undefined, 'deepseek-v4-flash'), 'deepseek-v4-flash')
  assert.equal(routeText(undefined, undefined), '')
  assert.equal(routeText('', '   '), '')
})
