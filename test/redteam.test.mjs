/**
 * 红队边界契约测试。
 *
 * 这个文件守护的是**这个插件为什么存在**：机器只挑错，判断由人下，专家不许动手。
 * 三条契约各自都有过真实教训：
 * 1. 白名单里一旦混进 `write`/`bash`，红队就能改动被测对象 —— 验收器变成了执行器；
 * 2. 黑名单一旦与注册的工具名漂移（改名后忘了同步），专家会失去唯一的发言通道
 *    或者反过来拿到主持人工具；
 * 3. 一旦出现 `crossfire_decide` 这类"代表态"工具，表态权就不在用户手里了。
 *
 * 工具名从 `src/tools.ts` 源码里正则提取，因此**改了工具名这个测试会立刻失败**，
 * 而不是等到运行时才发现白名单失效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  EXPERT_TOOL_ALLOW,
  EXPERT_TOOL_DENY,
  expertPersona,
  expertToolRestriction,
  reportEnvelopeSpec,
} from '../src/redteam.ts'

const source = await readFile(new URL('../src/tools.ts', import.meta.url), 'utf8')
const registered = [...source.matchAll(/name:\s*'(crossfire_[a-z_]+)'/g)].map((match) => match[1])
const hostTools = registered.filter((name) => name !== 'crossfire_report')

const EXPECTED = [
  'crossfire_open',
  'crossfire_attack',
  'crossfire_collect',
  'crossfire_finish',
  'crossfire_recheck',
  'crossfire_export',
  'crossfire_stance',
  'crossfire_report',
]

test('工具面恰好是 7 个主持人工具 + 1 个专家工具', () => {
  assert.deepEqual([...registered].sort(), [...EXPECTED].sort())
})

test('不存在任何"代表态"的工具（表态权只在人手里）', () => {
  const verdictTools = registered.filter((name) => /decide|endorse|reject|vote|adjudicate|set_status/.test(name))
  assert.deepEqual(verdictTools, [], `这些工具名看起来能代表用户表态：${verdictTools.join(', ')}`)
})

test('专家白名单恰好 5 个只读工具，不含任何写/执行/联网工具', () => {
  assert.deepEqual([...EXPERT_TOOL_ALLOW].sort(), ['crossfire_report', 'glob', 'grep', 'read', 'read_image'])
  const forbidden = ['write', 'edit', 'bash', 'pwsh', 'terminal_open', 'web_search', 'web_fetch', 'todo_write', 'spawn_teammate', 'subagent']
  for (const name of forbidden) {
    assert.equal(EXPERT_TOOL_ALLOW.includes(name), false, `白名单里不该有 ${name}`)
  }
})

test('黑名单恰好覆盖 7 个主持人工具，且不含专家工具', () => {
  assert.deepEqual([...EXPERT_TOOL_DENY].sort(), [...hostTools].sort())
  assert.equal(EXPERT_TOOL_DENY.includes('crossfire_report'), false, 'crossfire_report 是专家的唯一发声通道，绝不能被禁')
})

test('黑名单里没有拼错的死条目（每一项都是真实注册的工具）', () => {
  for (const name of EXPERT_TOOL_DENY) {
    assert.ok(registered.includes(name), `黑名单里的 "${name}" 不是任何已注册的工具——多半是改名后忘了同步`)
  }
})

test('expertToolRestriction 同时给出 allow 与 deny（两者是"与"关系）', () => {
  const restriction = expertToolRestriction()
  assert.ok(Array.isArray(restriction.allow))
  assert.ok(Array.isArray(restriction.deny))
  assert.deepEqual([...restriction.allow].sort(), [...EXPERT_TOOL_ALLOW].sort())
  assert.deepEqual([...restriction.deny].sort(), [...EXPERT_TOOL_DENY].sort())
  // 每次必须是新实例：宿主可能持有并改动它。
  assert.notEqual(expertToolRestriction().allow, expertToolRestriction().allow)
})

function personaInput() {
  return {
    reviewId: 'x-contract',
    dimension: '安全',
    title: '把鉴权换成 JWT',
    subject: '方案正文',
    stance: '我认为 JWT 是无状态的，所以不会有一致性问题。',
    dimensions: ['安全', '流程'],
    maxOpinions: 3,
  }
}

test('persona 写进了三条关键约束', () => {
  const persona = expertPersona(personaInput())
  assert.match(persona, /禁止为设计类缺陷编造/, '必须禁止伪复现步骤')
  assert.match(persona, /打穿/, '必须有立场对攻与打穿标记')
  assert.match(persona, /不许迎合|不要为了讨好/, '必须禁止迎合用户偏好')
  assert.ok(persona.includes('安全'), '必须写明这位专家负责的维度')
  assert.ok(persona.includes('crossfire_report'), '必须告诉专家唯一的提交通道')
})

test('persona 在立场为空时明说不要虚构立场', () => {
  const persona = expertPersona({ ...personaInput(), stance: '' })
  assert.match(persona, /不要虚构|没有.*立场/)
})

test('报告信封给出可切分的固定标记（本地兜底切分依赖它）', () => {
  const spec = reportEnvelopeSpec(3)
  assert.match(spec, /观点\s*N/, '必须要求 观点 N（…） 这个开头')
  assert.match(spec, /维度/)
  assert.match(spec, /3/, '必须写出条数上限')
})

test('welcome 让专家知道要提交什么', () => {
  const welcome = `${expertPersona(personaInput())}${reportEnvelopeSpec(3)}`
  assert.ok(welcome.includes('观点 N') || welcome.includes('观点'))
})
