// T4 共同生命周期（薄准备）：一次有限复制作者源 → 按阶段懒执行 apply/check/noop/uninstall/repeat，
// 只产出**只读快照与结果**，不写任何业务断言（业务契约留给各独立消费者）。
// 阶段（同一次 source、同 process，每阶段只跑一次；失败按同 error 缓存，不重跑）：
//   ensureInstalled()  前检（check ready=false + 完整零写快照）→ apply → check ready=true → installed 快照 + record
//   ensureNoop()       installed 之上再 apply ⇒ changed=false，且 full snapshot 与 installed 逐条相同（零写）
//   ensureUserEdit()   INDEX 追加用户说明（模拟用户改动，供复原阶段验证"只解除自有层"）
//   ensureRestored()   卸载 → restored 快照；check ready=false
//   ensureRepeat()     再卸载 ⇒ changed=false，afterRepeat 快照与 restored 相同（零写）
// 计数 copies/apply/check/uninstall/noop 与各阶段毫秒（performance.now 差值，不做百分比）。
// 输出冻结：text 为字符串（不可变）+ record/结果对象深度冻结；不暴露活 Map（记录一律 plain object）。
// cleanup 只删本模块自建 mkdtemp（不做未选阶段的卸载）。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commentAuthorTreeSource, prepareCommentAuthorTree } from '../fixtures/comment-author-tree.mjs'
import { applyStandardSeams, checkStandardSeams, inspectStandardSeamsPlan, maintenanceTargets, uninstallStandardSeams } from '../../deploy/standard-seams.mjs'
import { COMMENT_SEAMS_RECORD } from '../../deploy/comment-seam-files.mjs'

const INDEX = 'tavern-plugin/lib/index.js'
const AUTHOR_PACKAGE = 'tavern-plugin/package.json'
let sourceRoot = null
let ownedRels = []          // 装配后由 record 发现的 owned 目标（装配前其快照按作者源判定 null/原文）
const steps = []            // 有序阶段记录（约束：noop 在 restore 之前；restore 之后不得再 noop）
const counts = { copies: 0, apply: 0, check: 0, uninstall: 0, noop: 0 }
const phases = []
let appDir = null
let stages = {}          // 每阶段 lazily 生成，结构 { promise, error }
let disposed = false

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}
const phase = (label, run) => {
  const started = performance.now()
  try { return run() } finally { phases.push({ label, ms: Number((performance.now() - started).toFixed(3)) }) }
}
const fileOf = rel => path.join(appDir, ...rel.split('/'))
/** 快照：目标文本或 null（文件不存在＝null，不用活 Map 表达）。 */
const snap = rel => (existsSync(fileOf(rel)) ? readFileSync(fileOf(rel), 'utf8') : null)
const writeSet = () => [...new Set([...maintenanceTargets, INDEX, AUTHOR_PACKAGE, COMMENT_SEAMS_RECORD, ...ownedRels])]
const snapAll = () => Object.fromEntries(writeSet().map(rel => [rel, snap(rel)]))
const sameSet = (a, b) => writeSet().every(rel => a[rel] === b[rel])
/** 装配前状态（含 owned 目标）：作者源有该文件 ⇒ 原文；没有 ⇒ null（owned 由本次装配新建）。 */
const preStateOf = rel => {
  if (!sourceRoot) return null
  const from = path.join(sourceRoot, ...rel.split('/'))
  return existsSync(from) ? readFileSync(from, 'utf8') : null
}
/** 完整前置快照：写集全量 + owned 目标按作者源回填（不缺项）。 */
const preStateAll = () => Object.fromEntries(writeSet().concat(ownedRels).map(rel => [rel, preStateOf(rel)]))

/** 每阶段 lazy singleton：同一次执行、失败同 error（不重跑）。 */
function stage(name, run) {
  if (!stages[name]) {
    let entry
    entry = { promise: Promise.resolve().then(run).catch(error => { entry.error = error; throw error }) }
    stages[name] = entry
  }
  return stages[name].promise
}

/** 一次准备（惰性；只有真正取阶段时才复制作者树）。 */
function ensureTree() {
  return stage('tree', () => {
    const root = commentAuthorTreeSource()
    if (!root) throw new Error('缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
    const tree = prepareCommentAuthorTree()
    if (!tree) throw new Error('作者 source fixture 无法准备（prepareCommentAuthorTree 返回 null）')
    appDir = tree.appDir
    sourceRoot = root
    counts.copies += 1
    return { sourceRoot: root, appDir, tree }
  })
}

export const standardPositiveLifecycle = {
  /** 阶段：一次准备 + 前检 + 装配（installed 快照）。 */
  ensureInstalled() {
    return stage('installed', async () => {
      const prepared = await ensureTree()
      const before = phase('before-snapshot', preStateAll)
      const pre = phase('preflight-check', () => (counts.check += 1, checkStandardSeams({ appDir: prepared.appDir })))
      if (pre.ready !== false) throw new Error('前置异常：装配前 checkStandardSeams 不应 ready=true')
      const plan = phase('preflight-plan', () => inspectStandardSeamsPlan({ appDir: prepared.appDir }))
      if (plan.preflight !== 'passed') throw new Error('前置异常：inspectStandardSeamsPlan 必须 preflight=passed，实际=' + String(plan.preflight) + '（' + String(plan.reason || '') + '）')
      const afterPre = phase('after-pre-snapshot', snapAll)
      const applyResult = phase('apply', () => (counts.apply += 1, applyStandardSeams({ appDir: prepared.appDir, assertStopped: () => true })))
      const ready = phase('post-check', () => (counts.check += 1, checkStandardSeams({ appDir: prepared.appDir })))
      const record = JSON.parse(snap(COMMENT_SEAMS_RECORD) ?? 'null')
      ownedRels = Object.keys(record && record.owned ? record.owned : {})
      // owned 目标在装配前不存在 ⇒ before/afterPre 都补 null（两侧 keys 必须一致，便于 deepEqual）；
      // 取值一律来自作者源判定（preStateOf），**不**从装配后的 live 快照回填。
      const rebuilt = rel => preStateOf(rel)
      for (const rel of ownedRels) { before[rel] = rebuilt(rel); afterPre[rel] = rebuilt(rel) }
      const ordered = writeSet()
      const reorder = source => Object.fromEntries(ordered.map(rel => [rel, source[rel] ?? null]))
      stages.beforeOrdered = reorder(before)
      stages.afterPreOrdered = reorder(afterPre)
      const installed = snapAll()
      steps.push('installed')
      return deepFreeze({ sourceRoot: prepared.sourceRoot, authorVersion: plan.authorVersion, preflight: plan.preflight,
        before: stages.beforeOrdered, afterPre: stages.afterPreOrdered, pre, plan, applyResult, ready, installed, record, ownedRels: [...ownedRels] })
    })
  },
  /** 阶段：installed 之上再 apply ⇒ 零写（changed=false 且快照逐条相同）。 */
  ensureNoop() {
    return stage('noop', async () => {
      if (steps.includes('restored')) throw new Error('顺序合同：ensureRestored 之后不得再 ensureNoop（会装入新代）；消费者必须先 await ensureNoop 再 restore')
      const installed = await standardPositiveLifecycle.ensureInstalled()
      const noopResult = phase('noop-apply', () => (counts.apply += 1, counts.noop += 1, applyStandardSeams({ appDir, assertStopped: () => true })))
      const afterNoop = snapAll()
      return deepFreeze({ noopResult, afterNoop, identical: sameSet(installed.installed, afterNoop) })
    })
  },
  /** 阶段：模拟用户在 INDEX 追加说明（供复原阶段核对只解除自有层）。 */
  ensureUserEdit() {
    return stage('user-edit', async () => {
      await standardPositiveLifecycle.ensureInstalled()
      const note = '\n// 用户说明（共享生命周期夹具）：此行必须跨卸载保留\n'
      phase('user-edit', () => writeFileSync(fileOf(INDEX), snap(INDEX) + note, 'utf8'))
      return deepFreeze({ appended: note, afterUserEdit: snapAll() })
    })
  },
  /** 阶段：卸载（restored 快照 + check ready=false）。 */
  ensureRestored() {
    return stage('restored', async () => {
      await standardPositiveLifecycle.ensureUserEdit()
      const uninstallResult = phase('uninstall', () => (counts.uninstall += 1, uninstallStandardSeams({ appDir, assertStopped: () => true })))
      const restored = snapAll()
      const ready = phase('restore-check', () => (counts.check += 1, checkStandardSeams({ appDir })))
      // 复原核对材料：标准记录必须消失（null）、owned/目标必须回到作者原文或 null
      const oldRecords = { [COMMENT_SEAMS_RECORD]: restored[COMMENT_SEAMS_RECORD] }
      const restoredVsSource = Object.fromEntries(writeSet().map(rel => [rel, restored[rel] === preStateOf(rel)]))
      const rootPrefix = path.basename(appDir)
      steps.push('restored')
      return deepFreeze({ uninstallResult, restored, ready, oldRecords, restoredVsSource, rootPrefix })
    })
  },
  /** 阶段：再卸载 ⇒ 零写（changed=false 且快照与 restored 相同）。 */
  ensureRepeat() {
    return stage('repeat', async () => {
      const restored = await standardPositiveLifecycle.ensureRestored()
      const repeatResult = phase('repeat-uninstall', () => (counts.uninstall += 1, uninstallStandardSeams({ appDir, assertStopped: () => true })))
      const afterRepeat = snapAll()
      return deepFreeze({ repeatResult, afterRepeat, identical: sameSet(restored.restored, afterRepeat) })
    })
  },
  /** 只读快照口（消费者按需取，不触发未选阶段）。 */
  snapshot(rel) { return snap(rel) },
  get appDir() { return appDir },
  metrics: () => deepFreeze({ ...counts, steps: [...steps], phases: phases.map(row => ({ ...row })) }),
  dispose() {
    if (disposed) return false
    disposed = true
    if (appDir && existsSync(appDir)) rmSync(appDir, { recursive: true, force: true })
    return true
  },
}
