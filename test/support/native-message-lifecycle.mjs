// T2 共享：S5 两条 domain 文件的**一次**真实有限复制 + apply/check/uninstall 生命周期。
// 纪律：
//   · 有限复制＝只复制受管目标与作者 package.json（不搬 node_modules/整树），并**逐文件核对 copy 字节 == 源字节**（来源可证）；
//   · 生命周期只跑一次（懒 singleton promise ＋ 失败按 same error 缓存），两个用例从**同一阶段的快照**各自断言；
//   · 快照只暴露不可变 `text`；`bytes` 为 getter ⇒ 每次读取返回**独立 Buffer**（消费者之间不共享 Buffer 实例）； 
//   · `copied` Map 私有，仅经 getter 返回一次性副本；`record` 递归冻结；返回对象整体冻结（不冻结 Buffer/Map 本体）；
//   · 本模块无副作用（不 import node:test、不注册用例、不碰真实档），清理由调用方 dispose()。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COMMENT_SEAMS_RECORD } from '../../deploy/comment-seam-files.mjs'
import { applyStandardSeams, uninstallStandardSeams, maintenanceTargets } from '../../deploy/standard-seams.mjs'
import { activeSource, commentAuthorTreeSource } from '../fixtures/comment-author-tree.mjs'
import { isNativeMessageApplied, MESSAGE_FILES, MESSAGE_MARKER, MESSAGE_ANCHORS } from '../../deploy/native-data-transform.mjs'
import { AUTHOR_VERSION } from '../../lib/standard-host.js'

export const S5_DOMAIN_FILES = {
  turnOrchestration: 'tavern-plugin/lib/domain/turn-orchestration.js',
  backgroundCoordinator: 'tavern-plugin/lib/domain/background-task-coordinator.js',
}
export const S5_NAME_OF = { turnOrchestration: 'appendMessages', backgroundCoordinator: 'setMessageFloor' }
export { COMMENT_SEAMS_RECORD, MESSAGE_FILES, MESSAGE_MARKER, MESSAGE_ANCHORS, activeSource, isNativeMessageApplied, maintenanceTargets }

/** S5 自身计数（与 S4/S1S2 分开；每项都在**真实步骤之前**记一次）。 */
export const s5Metrics = { copies: 0, apply: 0, uninstall: 0, cleanups: 0 }

const AUTHOR_PACKAGE = 'tavern-plugin/package.json'
let state = { promise: null, error: null, dir: null }

/** 作者源根：显式来源（env DSH_TAVERN_TEST_APP 优先，其次本地 author-fixture＝682 代）；不猜其他代。 */
export function s5SourceRoot() {
  const root = commentAuthorTreeSource()
  if (!root) throw new Error('缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
  const appTree = path.join(root, 'tavern-plugin')
  if (!existsSync(path.join(appTree, 'lib', 'domain', 'background-task-coordinator.js'))) {
    throw new Error('作者源树不含 background-task-coordinator.js：' + appTree)
  }
  return appTree
}

/** 有限复制：受管目标 + 作者 package.json，逐文件比对源字节（来源与 copy 字节都必须可证）。
 *  注意两套相对路径：`rel` 带 `tavern-plugin/` 前缀（appDir 与 MESSAGE_FILES/record 的键都按它），
 *  而 appTree 已指向作者树的 `tavern-plugin/` 本身 ⇒ 读源时必须去掉前缀。
 *  返回的 Map 只由本模块私有持有；对外只经 getter 给一次性副本。 */
function finiteCopy(appTree, appDir) {
  const rels = [AUTHOR_PACKAGE, ...maintenanceTargets]
  const copied = new Map()
  for (const rel of rels) {
    const from = path.join(appTree, ...rel.replace(/^tavern-plugin\//, '').split('/'))
    if (!existsSync(from) || !statSync(from).isFile()) continue
    const to = path.join(appDir, ...rel.split('/'))
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(from, to)
    const sourceBytes = readFileSync(from)
    const copiedBytes = readFileSync(to)
    if (Buffer.compare(sourceBytes, copiedBytes) !== 0) throw new Error('有限复制字节不一致（来源不可信）：' + rel)
    copied.set(rel, sourceBytes.toString('utf8'))
  }
  return copied
}

/** 作者源树里某个受管目标的源路径。 */
export function s5SourcePath(appTree, rel) {
  return path.join(appTree, ...rel.replace(/^tavern-plugin\//, '').split('/'))
}

/** 快照：只存不可变 text；`bytes` 是 getter ⇒ 每次读都得到**独立 Buffer**（旧等值断言不变，且消费者间不共享实例）。 */
function snapshotOf(appDir, rel) {
  const text = readFileSync(path.join(appDir, ...rel.split('/')), 'utf8')
  return Object.freeze({
    text,
    get bytes() { return Buffer.from(text, 'utf8') },
  })
}

/** 递归冻结纯 JSON 对象（不碰 Buffer/Map/Set：不用 freeze 伪装它们的不可变）。 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Map) && !(value instanceof Set)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

/**
 * 懒 singleton：第一次调用跑完整生命周期（复制 → before 快照 → apply → installed 快照 → record → uninstall → restored 快照），
 * 之后复用同一结果；失败按同一 error 抛出（不重试、不半途重跑）。
 */
export function s5Lifecycle() {
  if (state.promise) return state.promise
  state.promise = Promise.resolve().then(() => {
    const appTree = s5SourceRoot()
    const appDir = mkdtempSync(path.join(os.tmpdir(), 'native-message-lifecycle-'))
    state.dir = appDir
    const rels = Object.values(S5_DOMAIN_FILES)
    s5Metrics.copies += 1
    const copied = finiteCopy(appTree, appDir)
    const before = {}
    const sourceBytes = {}
    for (const rel of rels) {
      before[rel] = snapshotOf(appDir, rel)
      // 源字节：getter 每次返回独立 Buffer 副本（对外 API 同旧 sourceBytes[rel]，但不共享实例）。
      const source = readFileSync(s5SourcePath(appTree, rel))
      Object.defineProperty(sourceBytes, rel, { enumerable: true, get() { return Buffer.from(source) } })
    }
    Object.freeze(sourceBytes)
    for (const rel of rels) {
      if (isNativeMessageApplied(before[rel].text, S5_NAME_OF[Object.keys(S5_DOMAIN_FILES).find(key => S5_DOMAIN_FILES[key] === rel)])) {
        throw new Error('前置失败：复制来的作者原字节已带 S5 标记：' + rel)
      }
    }
    s5Metrics.apply += 1
    const applyResult = applyStandardSeams({ appDir, authorVersion: AUTHOR_VERSION, assertStopped: () => true })
    const installed = {}
    for (const [key, rel] of Object.entries(S5_DOMAIN_FILES)) {
      const snap = snapshotOf(appDir, rel)
      const text = snap.text
      // 显式重建（spread 会把 getter 物化成共享 Buffer 实例）。
      installed[rel] = Object.freeze({
        text,
        get bytes() { return Buffer.from(text, 'utf8') },
        markerCount: text.split(MESSAGE_MARKER[S5_NAME_OF[key]]).length - 1,
        activeOldCallCount: activeSource(text, rel).split(MESSAGE_ANCHORS[S5_NAME_OF[key]]).length - 1,
        activeMarkerCount: activeSource(text, rel).split(MESSAGE_MARKER[S5_NAME_OF[key]]).length - 1,
        hasActiveBlock: /\[dsh-tavern-seam:ACTIVE_BEGIN\]/.test(text),
      })
    }
    Object.freeze(before)
    Object.freeze(installed)
    const record = deepFreeze(JSON.parse(readFileSync(path.join(appDir, ...COMMENT_SEAMS_RECORD.split('/')), 'utf8')))
    s5Metrics.uninstall += 1
    const uninstallResult = uninstallStandardSeams({ appDir, assertStopped: () => true })
    const restored = {}
    for (const rel of rels) restored[rel] = snapshotOf(appDir, rel)
    Object.freeze(restored)
    const recordExistsAfter = existsSync(path.join(appDir, ...COMMENT_SEAMS_RECORD.split('/')))
    const life = {
      appTree, appDir, before, sourceBytes, applyResult, installed, record, uninstallResult, restored, recordExistsAfter,
      relativeOf: key => S5_DOMAIN_FILES[key], nameOf: key => S5_NAME_OF[key],
    }
    // copied 私有：每次访问给一次性 Map 副本（旧 API `.copied.get(rel)` 不变，但消费者改不动内部状态）。
    Object.defineProperty(life, 'copied', { enumerable: true, get() { return new Map(copied) } })
    return Object.freeze(life)
  }).catch(error => { state.error = error; throw error })
  return state.promise
}

/** 只删本模块自建目录（幂等）。 */
export function disposeS5Lifecycle() {
  const dir = state.dir
  if (dir && existsSync(dir)) { s5Metrics.cleanups += 1; rmSync(dir, { recursive: true, force: true }) }
  state = { promise: null, error: null, dir: null }
  return dir
}

/** 已失败时的同一 error（供用例给出可比对的失败原因，不重跑）。 */
export function s5LifecycleError() { return state.error }
