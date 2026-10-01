/**
 * dsh-plugin-crossfire dev/CI tsdown config: emits two artifacts:
 *
 *   - `lib/index.js`  — node half (plain ESM, bundles src/index.ts)
 *   - `lib/client.js` — browser half (CJS wrapped in DSH's
 *                        `window.__ModuleLoader__.load({id, factory})`)
 *
 * The browser bundle externals React and the DSH platform modules; the
 * loader's module table provides them at runtime. CSS Modules are inlined as
 * a hashed class map + a `<style data-plugin>` tag injected at factory
 * execution (mirroring the DSH clientBundle CSS pipeline).
 *
 * 与圆桌会议的那份配置刻意保持一致（同一套已验证的产物形状），只有插件 ID
 * 与产物名不同：两份配置分叉意味着两份构建坑，而这里没有任何值得分叉的理由。
 */
import { defineConfig, type UserConfig } from 'tsdown'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'

const ID = '@y9931666/dsh-plugin-crossfire'

/** DSH platform modules that stay external in the browser bundle.
 *
 *  多列无害：只有被真正 import 的模块才会参与解析，而 `dsh.client.inject`
 *  才是"浏览器侧必须先加载哪些包"的权威清单。把后续批次（卡片 toolview、
 *  会话 Tab）会用到的包先留在这里，避免批 3 再回来改构建配置。 */
const CLIENT_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-tool/client',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-web-react',
]

/** Virtual-id wrapper keeping module CSS away from rolldown's CSS pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Minimal CSS-modules transform: hash local names, return class map + raw CSS. */
function transformCssModules(filename: string, source: Buffer): { classMap: Record<string, string>; cssText: string } {
  const rawHash = Array.from(filename).reduce((acc, ch) => ((acc << 5) - acc + ch.charCodeAt(0)) | 0, 0).toString(36).replace('-', '')
  const hash = `d${rawHash}`
  const cssText = source.toString('utf8')
  const classMap: Record<string, string> = {}
  const classPattern = /\.([a-zA-Z_][a-zA-Z0-9_-]*)/g
  let match: RegExpExecArray | null
  while ((match = classPattern.exec(cssText)) !== null) {
    const local = match[1]
    if (local !== undefined && classMap[local] === undefined) {
      classMap[local] = `${hash}_${local}`
    }
  }
  const transformedCss = cssText.replace(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g, (full, name: string) => {
    if (classMap[name] !== undefined) return `.${classMap[name]}`
    return full
  })
  return { classMap, cssText: transformedCss }
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  return resolvePath(dirname(importer), source)
}

const cssModulesPlugin = {
  name: 'dsh-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
    return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  async load(virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(fileId)
    const source = await readFile(fileId)
    const { classMap, cssText } = transformCssModules(fileId, source)
    const tagId = `${ID}/${basename(fileId)}`
    return [
      `const css = ${JSON.stringify(cssText)};`,
      `const classMap = ${JSON.stringify(classMap)};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
      '  const tag = document.createElement(\'style\');',
      `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      'export default classMap;',
    ].join('\n')
  },
}

const libConfig: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
}

const clientBundleConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  // sourcemap 默认关闭：这份产物是发给用户的。浏览器半体由宿主从
  // /plugins/... 直接加载 bundle，默认不会去取 .map；真正的排查手段是
  // slot-boundary.tsx 渲染出来的可读报错面板。
  sourcemap: process.env.CF_SOURCEMAP === '1',
  clean: false,
  external: CLIENT_EXTERNALS,
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [cssModulesPlugin],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([libConfig, clientBundleConfig])
