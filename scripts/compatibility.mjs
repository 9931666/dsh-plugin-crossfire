#!/usr/bin/env node
/**
 * 针锋的支持矩阵与发布基线校验器（2026-11-08 补齐）。
 *
 * 与圆桌的 `scripts/compatibility.mjs` 同源，但**刻意少了 CAPABILITY_SPECS 两项**：
 * 针锋的 `src/harness-compat.ts` 只在运行时按需探测，没有把能力清单重复声明成
 * `REQUIRED_CAPABILITIES` / `OPTIONAL_CAPABILITIES` 常量，强行检查会变成"为了
 * 通过门禁去加一份没人读的常量"。这里只校验真正有第二份声明的地方：
 *
 *   1. `compatibility.json`                 —— 支持矩阵与能力清单的唯一来源
 *   2. `package.json` 的 `crossfire.hostBaseline` —— 类型基线
 *   3. `package.json` 的 `devDependencies`  —— 消费者 `npm install` 拿到的类型版本
 *   4. `package.json` 的 `peerDependencies` —— 允许的宿主区间
 *   5. `src/index.ts` 的 `inject`           —— 真正会阻塞插件加载的必需能力
 *
 * 任何一处漂移都会表现为「本机好好的、用户装完就坏」，所以宁可在这里大声失败。
 *
 * 用法：
 *   node scripts/compatibility.mjs            # 文本报告，失败退出码 1
 *   node scripts/compatibility.mjs --json     # 机器可读
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')

/** 一条校验结果。 */
function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail }
}

/** 解析 `1.2.3-rc.4` 这类版本号（刻意不支持 build metadata）。 */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value).trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNum = /^\d+$/.test(left)
    const rightNum = /^\d+$/.test(right)
    if (leftNum && rightNum) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1
    } else if (leftNum !== rightNum) {
      return leftNum ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

function compareVersion(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * 判定 `^x.y.z` 是否覆盖 `target`。
 *
 * **刻意只实现 `^`**：这个脚本是发布门禁，静默猜错比直接失败危险得多。npm 的
 * prerelease 语义是「`^0.2.2-rc.1` 只在同一个 base version 内接受更高的 rc 与
 * 正式版」，所以跨 minor / patch 一律拒绝。
 */
function rangeCovers(range, target) {
  const trimmed = String(range).trim()
  if (!trimmed.startsWith('^')) return { ok: false, reason: `unsupported range form: ${trimmed}` }
  const wanted = parseVersion(trimmed.slice(1))
  if (wanted === undefined) return { ok: false, reason: `unparseable range: ${trimmed}` }
  if (target.major !== wanted.major || target.minor !== wanted.minor) {
    return { ok: false, reason: `${target.major}.${target.minor} is outside the ${wanted.major}.${wanted.minor} line` }
  }
  if (target.patch !== wanted.patch) {
    return { ok: false, reason: `patch ${target.patch} differs from ${wanted.patch}` }
  }
  if (compareVersion(target, wanted) < 0) {
    return { ok: false, reason: `${target.major}.${target.minor}.${target.patch}-… is below ${trimmed}` }
  }
  return { ok: true, reason: '' }
}

const errors = []
const results = []

function record(result) {
  results.push(result)
  if (!result.ok) errors.push(result)
}

// ---------------------------------------------------------------- 读取

const compatibility = JSON.parse(await readFile(join(root, 'compatibility.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const indexSource = await readFile(join(root, 'src', 'index.ts'), 'utf8')

const recommendedRaw = compatibility.recommendedHost
const recommended = parseVersion(recommendedRaw)

record(check(
  'compatibility.recommendedHost 可解析',
  recommended !== undefined,
  recommended === undefined ? `无法解析版本号：${recommendedRaw}` : `${recommendedRaw} ok`,
))

/** 从一个 TS 源码里抠出 `export const NAME = [ 'a', 'b' ]` 的字符串项。 */
function stringArrayFrom(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(source)
  if (match === null) return undefined
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
}

const declaredInject = stringArrayFrom(indexSource, 'inject')

// ------------------------------------------------- 1) 基线与矩阵一致

const baselineVersion = pkg.crossfire?.hostBaseline
record(check(
  'package.json 声明了宿主基线（crossfire.hostBaseline）',
  typeof baselineVersion === 'string' && baselineVersion !== '',
  baselineVersion === undefined ? '缺失：无法判断类型基线指向哪个宿主' : baselineVersion,
))
record(check(
  'package.json 基线 == compatibility.json 的 recommendedHost',
  baselineVersion === recommendedRaw,
  `package.json=${baselineVersion} compatibility.json=${recommendedRaw}`,
))

// --------------------------------------------- 2) devDependencies 精确一致

const baselinePackages = compatibility.baseline?.packages ?? []
record(check(
  'compatibility.json 声明了基线包清单',
  Array.isArray(baselinePackages) && baselinePackages.length > 0,
  `${baselinePackages.length} 个包`,
))

for (const name of baselinePackages) {
  const dev = pkg.devDependencies?.[name]
  record(check(
    `devDependencies 精确指向基线：${name}`,
    dev === recommendedRaw,
    dev === undefined ? '未声明' : `实际 ${dev}（应为 ${recommendedRaw}）`,
  ))
}

// ------------------------------------------------ 3) peer 区间覆盖基线

for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (!name.startsWith('@deepseek-ai/dsh')) continue
  if (recommended === undefined) break
  const verdict = rangeCovers(range, recommended)
  record(check(
    `peerDependencies 覆盖基线：${name}`,
    verdict.ok,
    verdict.ok ? `${range} ⊇ ${recommendedRaw}` : `${range} 不覆盖 ${recommendedRaw}：${verdict.reason}`,
  ))
}

// ------------------------------------ 4) inject 与必需能力清单一致

record(check(
  'index.ts 的 inject 与必需能力清单一致',
  JSON.stringify(declaredInject) === JSON.stringify(compatibility.capabilities?.required),
  `inject=${JSON.stringify(declaredInject)} 必需=${JSON.stringify(compatibility.capabilities?.required)}`,
))

const required = compatibility.capabilities?.required ?? []
const optional = compatibility.capabilities?.optional ?? []
record(check(
  '能力清单非空且无重复',
  required.length > 0 && new Set([...required, ...optional]).size === required.length + optional.length,
  `必需 ${required.length} 项 / 可选 ${optional.length} 项`,
))

// ---------------------------------------------------------------- 输出

if (asJson) {
  process.stdout.write(JSON.stringify({
    recommendedHost: recommendedRaw,
    supportedHosts: compatibility.supportedHosts ?? [],
    checks: results,
    ok: errors.length === 0,
  }, null, 2) + '\n')
} else {
  const width = Math.max(...results.map((result) => result.name.length))
  for (const result of results) {
    process.stdout.write(`${result.ok ? '✓' : '✗'} ${result.name.padEnd(width)}  ${result.detail}\n`)
  }
  process.stdout.write(`\n宿主基线 ${recommendedRaw}；${results.length} 项检查，${errors.length} 项失败\n`)
}

process.exit(errors.length === 0 ? 0 : 1)
