// 安装入口单源：模板 + 获取器源（deploy/bootstrap.mjs） + 当前 manifest 版本 → 包内二入口与外部发行 SH。
//   · 包内二入口（install.sh、deploy/install.sh）：URL/SHA 保持占位 —— 包内 tgz 摘要一旦内嵌即自引用。
//   · 外部发行件（dist/install.sh）：tgz 产出后由**同一个** renderInstallSh 填一次地址与摘要，不二次哈希。
//   · 源码树两入口不是内嵌副本，而是本地 wrapper（只读当前 package.json 与 deploy/bootstrap.mjs；
//     无版本号、无 URL/SHA、无获取器副本）——"只换版本"式的内嵌件仍会漂移，故由本模块给出唯一文本。
// 用法（构建器）：const inputs = installShInputs(root); renderInstallSh({ ...inputs }) / renderInstallSh({ ...inputs, url, sha256 })
import fs from 'node:fs'
import path from 'node:path'

export const PACKAGE_NAME = 'dsh-tavern-sqlite-v2'
export const TEMPLATE_REL = 'deploy/install.template.sh'
export const BOOTSTRAP_REL = 'deploy/bootstrap.mjs'
/** 包内二入口（同一份渲染文本，缺一即包不完整）。 */
export const PACK_INSTALL_ENTRIES = Object.freeze(['install.sh', 'deploy/install.sh'])
export const PLACEHOLDER_VERSION = '__DSH_RELEASE_VERSION__'
export const PLACEHOLDER_BOOTSTRAP = '__DSH_BOOTSTRAP_SOURCE__'
export const PLACEHOLDER_URL = '__DSH_RELEASE_URL__'
export const PLACEHOLDER_SHA256 = '__DSH_RELEASE_SHA256__'
export const HEREDOC_OPEN = "<<'DSH_STORAGE_BOOTSTRAP'"
export const HEREDOC_CLOSE = 'DSH_STORAGE_BOOTSTRAP'
const PLACEHOLDER = /__DSH_(?:RELEASE_(?:VERSION|URL|SHA256)|BOOTSTRAP_SOURCE)__/
const SHA256 = /^[0-9a-f]{64}$/
const VERSION = /^[0-9][0-9A-Za-z.\-+]*$/
const fail = message => { throw new Error('安装入口渲染：' + message) }
const count = (text, needle) => text.split(needle).length - 1

/** 本次渲染输入：必须取**当前** manifest 版本与源文件，不接受调用方另传版本。 */
export function installShInputs(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (manifest.name !== PACKAGE_NAME) fail('包身份不符：' + String(manifest.name))
  if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) fail('manifest 版本不合法：' + String(manifest.version))
  return {
    version: manifest.version,
    template: fs.readFileSync(path.join(root, TEMPLATE_REL), 'utf8'),
    bootstrap: fs.readFileSync(path.join(root, BOOTSTRAP_REL), 'utf8'),
  }
}

/** 内嵌获取器体（heredoc 之间），渲染件里必须与 bootstrap 源逐字节一致。 */
export function installShBody(text, label = 'install.sh') {
  if (typeof text !== 'string') fail(label + ' 不是文本')
  const open = text.indexOf(HEREDOC_OPEN)
  if (open < 0) fail(label + ' 缺内嵌获取器 heredoc（源码树入口应为本地 wrapper）')
  const start = text.indexOf('\n', open) + 1
  const close = text.indexOf('\n' + HEREDOC_CLOSE, start)
  if (close < 0) fail(label + ' 的 heredoc 未闭合')
  return text.slice(start, close)
}

/** 版本/地址/摘要/内嵌体的语义断言；渲染与闸门共用同一判据。 */
export function assertInstallShSemantics(text, { version, bootstrap = null, url = PLACEHOLDER_URL, sha256 = PLACEHOLDER_SHA256, label = 'install.sh' } = {}) {
  if (typeof version !== 'string' || !VERSION.test(version)) fail(label + ' 版本语义不合法：' + String(version))
  if (url === PLACEHOLDER_URL ? sha256 !== PLACEHOLDER_SHA256 : !(/^https:\/\//.test(url) && SHA256.test(sha256))) fail(label + ' 的 URL/SHA 必须同为占位或同为发行值')
  if (count(text, "VERSION='") !== 1) fail(label + ' 必须恰好一行 VERSION')
  if (!text.includes("VERSION='" + version + "'\n")) fail(label + ' 的 VERSION 不等于本次 manifest 版本 ' + version)
  for (const [key, value] of [['RELEASE_URL', url], ['RELEASE_SHA256', sha256]]) {
    if (count(text, key + "='") !== 1 || !text.includes(key + "='" + value + "'\n")) fail(label + ' 的 ' + key + ' 与本次渲染输入不一致')
  }
  if (text.includes(PLACEHOLDER_VERSION) || text.includes(PLACEHOLDER_BOOTSTRAP)) fail(label + ' 残留未替换占位符')
  if (count(text, HEREDOC_OPEN) !== 1 || count(text, '\n' + HEREDOC_CLOSE) !== 1) fail(label + ' 必须恰好一个内嵌获取器 heredoc')
  const body = installShBody(text, label)
  if (bootstrap !== null && body !== bootstrap) fail(label + ' 内嵌获取器与 bootstrap 源不同文本（漂移）')
  if (bootstrap === null && !body.trim()) fail(label + ' 内嵌获取器为空')
  return true
}

/**
 * 渲染安装 SH。包内二入口与外部发行件走同一函数：唯一区别就是 url/sha256 两个入参；
 * 未给地址/摘要时保持占位（包内形态），给了则必须成对且合法（发行形态）。
 */
export function renderInstallSh({ template, bootstrap, version, url = PLACEHOLDER_URL, sha256 = PLACEHOLDER_SHA256 } = {}) {
  if (typeof template !== 'string' || !template.includes(PLACEHOLDER_BOOTSTRAP) || !template.includes(PLACEHOLDER_VERSION)) fail('模板缺占位符')
  if (typeof bootstrap !== 'string' || !bootstrap.trim() || PLACEHOLDER.test(bootstrap)) fail('获取器源不合法')
  // 替换一律函数形式：replacement 字符串里的 $&/$` 等会被当替换模式展开。
  const text = template
    .replace(PLACEHOLDER_VERSION, () => version)
    .replace(PLACEHOLDER_BOOTSTRAP, () => bootstrap)
    .replace(PLACEHOLDER_URL, () => url)
    .replace(PLACEHOLDER_SHA256, () => sha256)
  assertInstallShSemantics(text, { version, bootstrap, url, sha256 })
  return text
}

/**
 * 源码树/本地安装入口的唯一文本（install.sh 与 deploy/install.sh 同文本）：
 * 只读当前 manifest 与 bootstrap，不写死版本/URL/SHA，也不内嵌获取器副本；离线仍可装卸。
 */
const LOCAL_ENTRY_LINES = [
  '#!/bin/sh',
  '# 源码树/本地安装入口（单源）：只读当前 package.json 与 deploy/bootstrap.mjs，不固定版本/URL/SHA、不内嵌获取器副本。',
  '# 包内正式入口（install.sh 与 deploy/install.sh）由 scripts/render-install-sh.mjs 从模板＋获取器源＋当前版本渲染。',
  'set -eu',
  "PACKAGE_NAME='dsh-tavern-sqlite-v2'",
  "BOOTSTRAP_REL='deploy/bootstrap.mjs'",
  "SELF_DIR=''",
  'case "$0" in',
  '  */*) SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) ;;',
  'esac',
  "command -v node >/dev/null 2>&1 || { echo '需要已有酒馆使用的Node.js 22.19+；本脚本不另装运行时。' >&2; exit 1; }",
  '# 交给 node 的路径要按它的平台形态给出（Git Bash/MSYS 下用 cygpath，原生 POSIX 原样透传）。',
  'native_path() {',
  '  if command -v cygpath >/dev/null 2>&1; then',
  '    converted=$(cygpath -w -- "$1" 2>/dev/null) || converted=$1',
  '  else',
  '    converted=$1',
  '  fi',
  '  printf \'%s\' "$converted"',
  '}',
  '# 用户显式 --package 时不覆盖；未给时由本次定位到的包目录补上，保证与当前 manifest/获取器同源。',
  "explicit_package=''",
  'wanted_package=0',
  "previous=''",
  'for argument in "$@"; do',
  "  if [ \"$previous\" = '--package' ]; then explicit_package=$argument; wanted_package=1; fi",
  "  if [ \"$argument\" = '--package' ]; then wanted_package=1; fi",
  '  previous=$argument',
  'done',
  'manifest_name() {',
  '  node --input-type=module -e \'import fs from "node:fs";let value;try{value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}if(typeof value.name!=="string"){process.exit(1)}process.stdout.write(value.name)\' "$(native_path "$1")/package.json" 2>/dev/null',
  '}',
  'is_package() {',
  '  if [ -z "$1" ]; then return 1; fi',
  '  if [ ! -f "$1/package.json" ]; then return 1; fi',
  '  if [ ! -f "$1/$BOOTSTRAP_REL" ]; then return 1; fi',
  '  if [ "$(manifest_name "$1")" != "$PACKAGE_NAME" ]; then return 1; fi',
  '  return 0',
  '}',
  "PACKAGE_ROOT=''",
  'for candidate in "$SELF_DIR" "$SELF_DIR/.." "$explicit_package"; do',
  '  if is_package "$candidate"; then PACKAGE_ROOT=$(CDPATH= cd -- "$candidate" && pwd); break; fi',
  'done',
  'if [ -z "$PACKAGE_ROOT" ]; then',
  "  echo '未定位本插件包（需 package.json 与 '\"$BOOTSTRAP_REL\"'）：请在包目录内直接运行本脚本，或加 --package <包目录>。' >&2",
  '  exit 1',
  'fi',
  'if [ "$wanted_package" = 1 ]; then',
  '  exec node "$(native_path "$PACKAGE_ROOT/$BOOTSTRAP_REL")" "$@"',
  'fi',
  'exec node "$(native_path "$PACKAGE_ROOT/$BOOTSTRAP_REL")" "$@" --package "$(native_path "$PACKAGE_ROOT")"',
]
export function localInstallEntrySh() {
  return LOCAL_ENTRY_LINES.join('\n') + '\n'
}
