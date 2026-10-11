// 一次性标准目录装配：程序单份落 data/plugins，正常启动只加载已保存行/区块。
// 仅操作本包确切目录和具名 patch 行；本次快照用于失败恢复，不是卸载原文资产。
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync, readlinkSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseDocument, YAMLSeq } from '../../lib/vendor/yaml/dist/index.js'

export const ORDINARY_ROW_ID = 'tavern-user-plugin-dsh-tavern-sqlite-v2'
// 不能用 tavern-user-plugin- 前缀：作者同步目录时会整批重写该前缀的行。
export const PERSISTED_ROWS = Object.freeze([
  { id: 'dsh-tavern-sqlite-v2', file: 'bootstrap/session-persistence.js' },
  { id: 'dsh-tavern-storage-host-patch-v2', file: 'bootstrap/host-patch.js' },
  { id: 'dsh-tavern-storage-standard-host-v2', file: 'bootstrap/standard-host.js' },
])
const DISABLED_IDS = ['session-persistence-jsonl', 'dsh-tavern']
const LEGACY_ROWS = new Map([
  ['dsh-tavern-sqlite-v2', 'dsh-tavern-sqlite-v2'],
  ['dsh-tavern-storage-host-patch-v2', 'dsh-tavern-sqlite-v2/host-patch'],
  ['dsh-tavern-storage-host-actions-v2', 'dsh-tavern-sqlite-v2/host-actions'],
  ['dsh-tavern-storage-save-routes-v2', 'dsh-tavern-sqlite-v2/save-routes'],
  ['dsh-tavern-storage-standard-host-v2', 'dsh-tavern-sqlite-v2/standard-host'],
])
const stat = file => { try { return lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const bytes = file => existsSync(file) ? readFileSync(file) : null
const same = (a, b) => a === null ? b === null : b !== null && a.equals(b)
const json = file => JSON.parse(readFileSync(file, 'utf8'))
export const pluginDirFor = ({ home, packageName }) => path.join(path.resolve(home), 'profile-data', 'tavern', 'data', 'plugins', packageName)
export const patchFileFor = ({ home, profileName = 'tavern' }) => path.join(path.resolve(home), 'profiles', profileName, 'cordis.patch.yml')
export function parsePatch(text) {
  const doc = parseDocument(text?.trim() ? text : '[]\n')
  if (doc.errors.length || !(doc.contents instanceof YAMLSeq)) throw Error('cordis.patch.yml 须是可解析列表：' + (doc.errors[0]?.message || '顶层不是列表'))
  return doc
}
function pathName(name, expected) {
  return typeof name === 'string' && path.isAbsolute(name) && path.resolve(name) === path.resolve(expected)
}
/**
 * 普通行（ORDINARY_ROW_ID）的当前状态。**只读判定，不修改**：唯一、归属（plugin.js 或 guard）、启用、可控入口存在。
 * 旧 044 只有三条 early ⇒ 这里给出 absent，供 preflight 判"可升级"；由 assertAssembly('install') 决定是否强拒。
 */
function ordinaryState(doc, dir) {
  // 顶层同 id 行（非 insert 的覆盖形态）优先参与判定：用户显式 disabled **或任何影响接线/行为的键**
  // （name/inject/config/...）都必须被看见——否则安装器会先 strip 普通行、却让外部 override 生效，等于静默改变接线。
  const overrides = doc.contents.items.filter(op => !op?.get?.('insert', true) && op?.get?.('id') === ORDINARY_ROW_ID)
  if (overrides.some(row => row.get?.('disabled') === true)) return { present: true, ok: false, reason: 'top-level-disabled' }
  for (const row of overrides) {
    const keys = (row.items ?? []).map(item => String(item?.key?.value ?? item?.key ?? ''))
    if (keys.some(key => key !== '' && key !== 'id' && key !== 'disabled')) return { present: true, ok: false, reason: 'override-conflict' }
  }
  const rows = inserted(doc).filter(row => row.get?.('id') === ORDINARY_ROW_ID)
  if (rows.length === 0) return { present: false, ok: false, reason: 'absent' }
  if (rows.length !== 1) return { present: true, ok: false, reason: 'duplicate' }
  const row = rows[0]
  const name = row.get?.('name')
  const ownedByPlugin = pathName(name, path.join(dir, 'plugin.js'))
  const ownedByGuard = pathName(name, path.join(dir, '.tavern-entry.mjs'))
  if (!ownedByPlugin && !ownedByGuard) return { present: true, ok: false, reason: 'foreign-owner' }
  if (row.get?.('disabled') === true) return { present: true, ok: false, reason: 'disabled' }
  const entry = ownedByPlugin ? ORDINARY_ENTRY_FILES[0] : ORDINARY_ENTRY_FILES[1]
  const file = path.join(dir, entry)
  const info = stat(file)
  if (!info) return { present: true, ok: false, reason: 'entry-missing' }
  // 名字对不算归属：symlink/目录/其他非普通文件不得借名认领我们自己的入口（缺入口可复修，冒充不行）。
  if (info.isSymbolicLink() || !info.isFile()) return { present: true, ok: false, reason: 'entry-not-regular' }
  return { present: true, ok: true, reason: 'ok', entry }
}
function inserted(doc) {
  return doc.contents.items.flatMap(op => {
    const rows = op?.get?.('insert', true)
    return rows instanceof YAMLSeq ? rows.items : []
  })
}
/**
 * 普通行（`ORDINARY_ROW_ID`）的宿主入口只有这两个确切绝对路径是"我方归属"：
 * · `plugin.js`：7cdd287 及更早的 scanner 直接指向真实入口；
 * · `.tavern-entry.mjs`：a2008bf 起的 scanner 指向它生成的 guard（真实入口在 guard 的 `new URL(main)` 里）。
 * 只做严格 resolve 相等比较——不放宽成目录前缀，`stripRows` 的外部占用判据必须保持有效。
 */
export const ORDINARY_ENTRY_FILES = Object.freeze(['plugin.js', '.tavern-entry.mjs'])
function ownedRow(row, pluginDir) {
  const id = String(row?.get?.('id') || ''), name = row?.get?.('name')
  const early = PERSISTED_ROWS.find(item => item.id === id)
  if (early && pathName(name, path.join(pluginDir, early.file))) return true
  if (LEGACY_ROWS.get(id) === name) return true
  if (id === ORDINARY_ROW_ID && ORDINARY_ENTRY_FILES.some(file => pathName(name, path.join(pluginDir, file)))) return true
  return false
}
function stripRows(doc, pluginDir) {
  for (let i = doc.contents.items.length - 1; i >= 0; i--) {
    const op = doc.contents.items[i], rows = op?.get?.('insert', true)
    if (!(rows instanceof YAMLSeq)) continue
    rows.items = rows.items.filter(row => {
      const id = String(row?.get?.('id') || '')
      if (!LEGACY_ROWS.has(id) && id !== ORDINARY_ROW_ID) return true
      if (!ownedRow(row, pluginDir)) throw Error('本包行 id 被其他入口占用，拒绝覆盖/删除：' + id)
      return false
    })
    if (!rows.items.length) doc.contents.items.splice(i, 1)
  }
}
/**
 * 顶层同 id 覆盖行的用户冲突（安装前拒，且零写）。
 * 只认 insert 之外、id === ORDINARY_ROW_ID 的顶层行；本包合同保证普通行只以顶层插入存在，不解析 group 子树。
 */
function assertNoOrdinaryOverrideConflict(doc) {
  // insert 形态的普通行被显式 disabled 同样是用户冲突（首装直连 manage 也必须拒，不能等 preflight）。
  const insertedRow = inserted(doc).find(row => row.get?.('id') === ORDINARY_ROW_ID)
  if (insertedRow?.get?.('disabled') === true) throw Error('普通入口行被用户显式 disabled（配置冲突），拒绝安装/静默重置：' + ORDINARY_ROW_ID)
  for (const op of doc.contents.items) {
    if (op?.get?.('insert', true) || op?.get?.('id') !== ORDINARY_ROW_ID) continue
    if (op.get?.('disabled') === true) throw Error('普通入口行被用户显式 disabled（配置冲突），拒绝安装/静默重置：' + ORDINARY_ROW_ID)
    const extra = (op.items ?? [])
      .map(item => String(item?.key?.value ?? item?.key ?? ''))
      .filter(key => key !== '' && key !== 'id' && key !== 'disabled')
    if (extra.length > 0) throw Error('普通入口行被用户顶层覆盖（' + extra.join(',') + '）影响接线，拒绝安装：' + ORDINARY_ROW_ID)
  }
}
function print(doc, original) {
  doc.contents.flow = false
  const text = doc.toString({ lineWidth: 0 })
  return { text: text === (original || '') ? null : text, changed: text !== (original || '') }
}
export function installOwnedRows(text, { pluginDir, home } = {}) {
  const doc = parsePatch(text)
  // 先于 stripRows 判用户冲突：任何"非 insert 的同 id 覆盖行"（disabled 或 name/inject/config 等影响接线的键）
  // 都拒绝安装，且不写出任何字节——首装（state.absent）同样不得静默 reset 掉用户的显式配置。
  assertNoOrdinaryOverrideConflict(doc)
  stripRows(doc, pluginDir)
  const overrides = DISABLED_IDS.map(id => doc.contents.items.filter(op => op?.get?.('id') === id && !op?.get?.('insert')))
  for (let i = 0; i < overrides.length; i++) {
    if (overrides[i].length > 1) throw Error('禁用行重复，拒绝猜优先级：' + DISABLED_IDS[i])
    // 不覆盖用户现有配置；已有 disabled:true 可以共存，卸载时保留。
    if (overrides[i].length && overrides[i][0].get('disabled') !== true) throw Error('用户层显式启用了接管目标，拒绝覆盖：' + DISABLED_IDS[i])
    if (!overrides[i].length) {
      const op = doc.createNode({ id: DISABLED_IDS[i], disabled: true })
      op.commentBefore = ' dsh-tavern-sqlite-v2: 安装器禁用原入口'
      doc.contents.items.push(op)
    }
  }
  const rows = PERSISTED_ROWS.map(row => ({ id: row.id, name: path.join(pluginDir, row.file) }))
  rows[0].config = { root: path.join(home, 'profile-data', 'tavern', 'sessions') }
  rows[2].inject = ['loader', 'sessionPersistence', 'tavernStorageBootstrapReady']
  rows[2].config = { persistedSeams: true }
  // 普通行（作者 data/plugins 扫描的 apply 入口）：同 id 直接指向本包 plugin.js。
  //   · 不另造 guard 文件/不复制一份入口；作者侧 syncUserPlugins 之后同 id 会转成其 guard 形式，
  //     两者都在 ORDINARY_ENTRY_FILES 归属清单内（installedOwned 同一判据）。
  //   · 第一次桌面进程尚无作者 sync ⇒ 先用 plugin.js 起来；后续进程从 guard 读同一 id，不双源。
  rows.push({ id: ORDINARY_ROW_ID, name: path.join(pluginDir, 'plugin.js') })
  const op = doc.createNode({ insert: rows })
  op.commentBefore = ' dsh-tavern-sqlite-v2: 持久启动装配；安装一次，正常启动自动加载，无额外安装命令'
  doc.contents.items.push(op)
  return print(doc, text)
}
export function uninstallOwnedRows(text, { pluginDir } = {}) {
  const doc = parsePatch(text)
  stripRows(doc, pluginDir)
  doc.contents.items = doc.contents.items.filter(op => {
    if (!DISABLED_IDS.includes(op?.get?.('id'))) return true
    if (!String(op.commentBefore || '').includes('dsh-tavern-sqlite-v2: 安装器禁用原入口')) return true
    if (op.get('disabled') !== true || op.items.length !== 2) throw Error('本包禁用行已被外部修改，拒绝删除')
    return false
  })
  return print(doc, text)
}
function assertSafe(file, home) {
  const resolved = path.resolve(file), root = path.resolve(home)
  if (!resolved.startsWith(root + path.sep)) throw Error('本包装配路径越界：' + resolved)
  for (let parent = path.dirname(resolved); parent !== path.dirname(root); parent = path.dirname(parent)) {
    if (stat(parent)?.isSymbolicLink()) throw Error('装配父目录是链接，拒绝修改：' + parent)
    if (parent === root) break
  }
  return resolved
}
function manifestAt(dir, name) {
  if (!existsSync(path.join(dir, 'package.json')) || json(path.join(dir, 'package.json')).name !== name) throw Error('不能认领无清单或其他包目录：' + dir)
}
/**
 * 本包自有完整性准入：`bootstrap/` 自带独立清单，而宿主活动插件包身份解析（活动 Loader 条目 →
 * 模块最近 package.json）要求其 name 与 version 都非空字符串，缺一个就在**请求扩展准备**期抛
 * （表现为「装配成功、启动正常，下一轮发消息直接失败」）。故在安装预检拦截；只判非空字符串
 * （与宿主同口径），不要求等于根包版本，也不引入作者版本或原版认证。
 */
function assertBootstrapManifestComplete(root) {
  const file = path.join(root, 'bootstrap', 'package.json')
  if (!existsSync(file)) throw Error('本包不完整：启动入口缺清单 ' + file)
  let manifest
  try { manifest = json(file) } catch (error) { throw Error('启动入口清单无法解析：' + file + '（' + String(error && error.message) + '）') }
  for (const field of ['name', 'version']) {
    if (typeof manifest?.[field] !== 'string' || manifest[field].length === 0) {
      throw Error(`启动入口清单缺非空 ${field}（宿主活动插件包身份解析要求 name 与 version 都非空）：${file}；缺 version 会让装配后的首个请求在请求扩展准备期失败`)
    }
  }
}
export function createStandardInstallation({ op, adapter, packageRoot, evidence, linkPeers = () => {} }) {
  const name = adapter.packageName, pluginDir = pluginDirFor({ home: op.home, packageName: name })
  const link = path.join(op.profileDir, 'node_modules', name), oldDir = path.join(op.home, 'plugins', name)
  const profileFile = path.join(op.profileDir, 'package.json'), patchFile = path.join(op.profileDir, 'cordis.patch.yml')
  let before, expected, state, incoming = packageRoot, moves = [], currentDir = null, captured = false, restored = false
  const paths = [pluginDir, link, oldDir]
  let residualPaths = null
  function residualPath(file, evidenced) {
    const entry = stat(file)
    if (!entry) return null
    assertSafe(file, op.home)
    if (!entry.isDirectory() && !entry.isSymbolicLink()) throw Error('残留包路径不是目录/链接：' + file)
    const manifest = bytes(path.join(file, 'package.json'))
    let owner = null
    if (manifest) {
      try { owner = JSON.parse(manifest.toString('utf8')).name } catch { /* 损坏清单只在明确装配证据下可撤 */ }
    }
    if (owner && owner !== name) throw Error('残留装配指向另一包，不能认领：' + file)
    if ((!manifest || !owner) && !evidenced) throw Error('没有本包装配证据，不能认领无有效清单目录/链接：' + file)
    return { file, symbolic: entry.isSymbolicLink(), linkTarget: entry.isSymbolicLink() ? readlinkSync(file) : null, manifest }
  }
  const current = () => ({ profile: bytes(profileFile), patch: bytes(patchFile) })
  const assertUnchanged = () => {
    const now = current()
    if (!same(expected.profile, now.profile) || !same(expected.patch, now.patch)) throw Error('装配预检后 profile/patch 有外部改动，拒绝覆盖')
  }
  function inspect() {
    const pkg = json(profileFile), dep = !!pkg.dependencies?.[name], bundle = !!pkg.dsh?.profile?.bundles?.includes(name), linked = !!stat(link), standard = !!stat(pluginDir)
    if (standard) {
      assertSafe(pluginDir, op.home)
      if (stat(pluginDir).isSymbolicLink()) throw Error('标准插件目录不能是外部链接')
      manifestAt(pluginDir, name)
      if (dep || bundle || linked || stat(oldDir)) throw Error('同时存在标准目录与同名 profile/旧目录装配，拒绝双源')
      const doc = parsePatch(bytes(patchFile)?.toString('utf8'))
      const rows = inserted(doc)
      for (const early of PERSISTED_ROWS) {
        const found = rows.filter(row => row.get('id') === early.id)
        if (found.length !== 1 || !pathName(found[0].get('name'), path.join(pluginDir, early.file))) throw Error('标准启动装配缺失/重复/归属错误：' + early.id)
      }
      if (rows.find(row => row.get('id') === PERSISTED_ROWS[0].id)?.get('config')?.get('root') !== path.join(op.home, 'profile-data', 'tavern', 'sessions')) throw Error('SQLite 会话根装配漂移，拒绝修改数据库位置')
      if (rows.find(row => row.get('id') === PERSISTED_ROWS[2].id)?.get('config')?.get('persistedSeams') !== true) throw Error('标准启动未声明持久区块合同')
      for (const id of DISABLED_IDS) if (!doc.contents.items.some(row => row.get?.('id') === id && row.get?.('disabled') === true)) throw Error('标准接管缺少禁用原入口：' + id)
      // 普通行只作为**状态**登记（旧 044 仅 early ⇒ absent 合法可升级）；强拒放在 assertAssembly('install')。
      const ordinary = ordinaryState(doc, pluginDir)
      return { present: true, layout: 'standard', dir: pluginDir, ordinary }
    }
    if (dep || bundle || linked) {
      if (!(dep && bundle && linked)) throw Error('旧 profile 装配不完整，拒绝猜测')
      assertSafe(link, op.home); manifestAt(link, name)
      if (stat(oldDir)) { assertSafe(oldDir, op.home); manifestAt(oldDir, name) }
      return { present: true, layout: 'legacy', dir: realpathSync(link) }
    }
    if (stat(oldDir)) throw Error('旧程序目录存在但无装配，不冒认；请先按旧维护入口卸载')
    return { present: false, layout: 'absent', dir: null }
  }
  function capture() {
    if (captured) return
    before = current(); expected = { ...before }; captured = true
  }
  function writeState(profile, patch) {
    writeFileSync(profileFile, profile)
    // 每一步成功后只更新该文件的本次预期；下一步失败仍能恢复已写 profile，不吞外部改动。
    expected.profile = Buffer.from(profile)
    if (patch !== null) writeFileSync(patchFile, patch)
    else if (stat(patchFile)) rmSync(patchFile) // 确切受管 profile patch，恢复其原本不存在的状态。
    expected.patch = patch === null ? null : Buffer.from(patch)
  }
  function archive(file) {
    if (!stat(file)) return
    assertSafe(file, op.home)
    const residualItem = residualPaths?.get(file)
    if (state?.layout === 'residual') {
      const now = residualPath(file, true)
      if (!residualItem || now.symbolic !== residualItem.symbolic || now.linkTarget !== residualItem.linkTarget || !same(now.manifest, residualItem.manifest)) throw Error('残留程序预检后身份变化，不覆盖：' + file)
    } else manifestAt(file, name)
    const dest = path.join(evidence, 'assembly-before', String(moves.length))
    if (stat(dest)) throw Error('本次装配归档目的已占用：' + dest)
    mkdirSync(path.dirname(dest), { recursive: true })
    // 移动确切本包目录/最终链接，不跟随链接删除共享依赖目录；仅供本次恢复。
    const symbolic = stat(file).isSymbolicLink(), linkTarget = symbolic ? readlinkSync(file) : null
    const manifest = residualItem ? residualItem.manifest : readFileSync(path.join(file, 'package.json'))
    renameSync(file, dest)
    moves.push({ file, dest, symbolic, linkTarget, manifest })
  }
  function clearCurrent() {
    if (currentDir && stat(currentDir)) {
      assertSafe(currentDir, op.home)
      if (stat(currentDir).isSymbolicLink()) throw Error('本次安装目的被替换成外部链接，拒绝清理')
      // 本次确切新建目录可能因复制失败尚无清单；有清单时必须仍属于本包。
      if (existsSync(path.join(currentDir, 'package.json'))) manifestAt(currentDir, name)
      rmSync(currentDir, { recursive: true, force: true })
    }
    currentDir = null
  }
  async function manage(action, root = incoming) {
    if (!['install', 'uninstall'].includes(action)) throw Error('标准装配动作必须是 install/uninstall')
    capture(); assertUnchanged()
    // 直连 manage 也必须看见磁盘上的用户冲突（不依赖调用方传入 text，也不依赖先跑 preflight）：
    // 拒绝发生在任何 clearCurrent/writeState 之前 ⇒ 零写。
    if (action === 'install') assertNoOrdinaryOverrideConflict(parsePatch(bytes(patchFile)?.toString('utf8') ?? '[]'))
    // 进入写阶段即视作"本次安装"：清掉上一次 restore 的标记，否则同一 helper 先 restore 再 install
    // 会因 restored=true 跳过新普通入口验收（写前、冲突拒之后）。
    restored = false
    // 写/移程序前先验所有父目录；不能清掉旧装配之后才发现标准目的越界。
    for (const file of [...paths, profileFile, patchFile]) assertSafe(file, op.home)
    const pkg = json(profileFile)
    if (pkg.dependencies) delete pkg.dependencies[name]
    if (Array.isArray(pkg.dsh?.profile?.bundles)) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(item => item !== name)
    const patch = uninstallOwnedRows(expected.patch?.toString('utf8'), { pluginDir })
    // incoming 已在 preflight 按需脱离，卸载不能删正在执行/准备安装的原代程序。
    clearCurrent()
    // 残留双源时先归档最终链接本体，再移程序目标，避免把本次移目标造成的悬空误认成外改。
    const archivePaths = state?.layout === 'residual'
      ? [...paths.filter(file => stat(file)?.isSymbolicLink()), ...paths.filter(file => !stat(file)?.isSymbolicLink())] : paths
    for (const file of archivePaths) if (stat(file)) archive(file)
    const text = patch.text ?? expected.patch?.toString('utf8') ?? null
    writeState(Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), text === null ? null : Buffer.from(text))
    if (action === 'uninstall') return { present: false }
    if (action !== 'install') throw Error('标准装配动作必须是 install/uninstall')
    const { copyPackage, samePackage } = await import('./runner.mjs')
    const source = root === packageRoot ? incoming : root
    manifestAt(source, name)
    assertSafe(pluginDir, op.home)
    if (stat(pluginDir)) throw Error('标准安装目的已存在，拒绝覆盖')
    currentDir = pluginDir
    copyPackage(source, pluginDir)
    const bootstrap = json(path.join(pluginDir, 'bootstrap', 'package.json'))
    if (bootstrap.dsh?.client || bootstrap.name === name) throw Error('启动入口不得拥有第二个浏览器来源')
    await linkPeers(json(path.join(pluginDir, 'package.json')), pluginDir)
    const installed = installOwnedRows(text, { pluginDir, home: op.home })
    writeState(expected.profile, Buffer.from(installed.text ?? text ?? '[]\n'))
    if (!samePackage(source, pluginDir)) throw Error('标准目录程序与本次选定程序不一致')
    return assertAssembly('install')
  }
  function assertAssembly(action) {
    const now = inspect()
    if (now.present !== (action === 'install') || (action === 'install' && now.layout !== 'standard' && !(restored && state?.layout === 'legacy'))) throw Error('标准插件目录/持久装配回读不一致')
    // 仅**本次安装**强核普通入口合同：唯一 + 归属(plugin.js/guard) + 启用 + 常规入口存在。
    // 卸载/restore 不回填新行、不强迫首启合同（restore 后的旧 early-only 合法状态照旧通过）。
    if (action === 'install' && now.layout === 'standard' && !restored) {
      const ordinary = now.ordinary ?? { ok: false, reason: 'absent' }
      if (!ordinary.ok) throw Error('标准普通入口装配不符（' + ordinary.reason + '）：需要唯一且启用、归属 plugin.js 或 .tavern-entry.mjs、入口文件存在')
    }
    return now
  }
  async function preflight(action) {
    if (!['install', 'uninstall'].includes(action)) throw Error('标准装配动作必须是 install/uninstall')
    if (captured) assertUnchanged()
    for (const file of [...paths, profileFile, patchFile]) assertSafe(file, op.home)
    state = inspect(); capture()
    // 本包自有清单完整性：标准目录/持久装配变更之前先拒（缺非空 name/version 的启动入口清单会让
    // 装配后的首个请求在宿主请求扩展准备期失败）。只判输入包根；copyPackage 逐字节复制，故无需再判 incoming。
    if (action === 'install') assertBootstrapManifestComplete(packageRoot)
    // 用户配置冲突（普通入口行 disabled / 顶层 override 带接线键）与现场是否已装无关：
    // 首装（state.absent）也必须响亮拒绝，不能"看不见"就静默 reset 用户显式配置。此处仍零写。
    if (action === 'install') {
      const conflict = ordinaryState(parsePatch(expected.patch?.toString('utf8') ?? '[]'), pluginDir)
      if (conflict.reason === 'disabled' || conflict.reason === 'top-level-disabled') throw Error('普通入口行被用户显式 disabled（配置冲突），拒绝静默启用：' + ORDINARY_ROW_ID)
      if (conflict.reason === 'override-conflict') throw Error('普通入口行被用户顶层覆盖影响接线，拒绝安装：' + ORDINARY_ROW_ID)
    }
    // 提前校验归属/配置冲突，不在停服后才发现不可安装的 patch。
    if (action === 'install') installOwnedRows(expected.patch?.toString('utf8'), { pluginDir, home: op.home })
    else uninstallOwnedRows(expected.patch?.toString('utf8'), { pluginDir })
    if (action === 'install' && state.present) {
      const { samePackage, copyPackage } = await import('./runner.mjs')
      state.upgrading = state.layout !== 'standard' || !samePackage(packageRoot, state.dir)
      // 普通入口缺席/坏入口（旧 044 仅 early、或归属/唯一/入口丢失）同样是**升级**，不能因 samePackage=true 就 noop。
      const ordinary = state.ordinary ?? { ok: false, reason: 'absent' }
      if (ordinary.ok !== true) {
        if (ordinary.reason === 'disabled' || ordinary.reason === 'top-level-disabled') throw Error('普通入口行被显式 disabled（用户配置冲突），拒绝静默启用：' + ORDINARY_ROW_ID)
        state.upgrading = true
      }
      if (incoming === packageRoot && (path.resolve(packageRoot) === path.resolve(state.dir) || realpathSync(packageRoot) === realpathSync(state.dir))) {
        incoming = path.join(evidence, 'assembly-input-package')
        if (stat(incoming)) throw Error('本次输入程序目录已占用')
        copyPackage(packageRoot, incoming)
      }
    }
    return state
  }
  async function restore() {
    if (!captured) return
    assertUnchanged(); clearCurrent()
    for (const item of [...moves].reverse()) {
      const archived = stat(item.dest)
      if (stat(item.file) || !archived || archived.isSymbolicLink() !== item.symbolic
        || (item.symbolic && readlinkSync(item.dest) !== item.linkTarget)
        || (!item.symbolic && !same(bytes(path.join(item.dest, 'package.json')), item.manifest))) {
        throw Error('原装配目的/归档变化，不覆盖：' + item.file)
      }
      mkdirSync(path.dirname(item.file), { recursive: true })
      renameSync(item.dest, item.file)
      if (item.symbolic && !same(bytes(path.join(item.file, 'package.json')), item.manifest)) throw Error('原链接恢复后的目标包变化：' + item.file)
    }
    moves = []
    writeState(before.profile, before.patch)
    restored = true
    // 残留维护允许原本就是半装的状态；恢复只要求本次归档和配置回原位，不能用完整安装准入拒绝原状态。
    return state?.layout === 'residual' ? state : inspect()
  }
  function residual() {
    capture(); assertUnchanged()
    for (const file of [...paths, profileFile, patchFile]) assertSafe(file, op.home)
    // 残留维护不要求旧包能运行。明确同名装配/自有行允许悬空最终链接或缺清单；有效外包清单仍拒绝。
    uninstallOwnedRows(expected.patch?.toString('utf8'), { pluginDir }) // 先拒同 id 外部入口与被改过的安装器覆盖
    const doc = parsePatch(expected.patch?.toString('utf8')), pkg = json(profileFile)
    const evidenced = !!pkg.dependencies?.[name] || !!pkg.dsh?.profile?.bundles?.includes(name)
      || inserted(doc).some(row => ownedRow(row, pluginDir))
    residualPaths = new Map(paths.map(file => [file, residualPath(file, evidenced)]).filter(([, item]) => item))
    const present = residualPaths.size > 0 || evidenced
      || doc.contents.items.some(op => String(op?.commentBefore || '').includes('dsh-tavern-sqlite-v2: 安装器禁用原入口'))
    state = { present, layout: 'residual', dir: null }
    return { present, uninstall: () => manage('uninstall'), restore,
      verify: () => {
        const doc = parsePatch(bytes(patchFile)?.toString('utf8'))
        if (paths.some(file => stat(file)) || json(profileFile).dependencies?.[name] || json(profileFile).dsh?.profile?.bundles?.includes(name)
          || inserted(doc).some(row => LEGACY_ROWS.has(row.get('id')) || row.get('id') === ORDINARY_ROW_ID)
          || doc.contents.items.some(op => String(op?.commentBefore || '').includes('dsh-tavern-sqlite-v2: 安装器禁用原入口'))) throw Error('本包残留装配未清理')
      } }
  }
  return { preflight, manage, assertAssembly, restore, residual }
}
