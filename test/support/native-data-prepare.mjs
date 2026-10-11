// T4：S1S2 两消费者（SQL 快路径 / 窗口分发）共享**一次**真实施缝准备。
// 复用既有 S4 prepare factory（createNativeS4Prepare）：懒一次 + 缓存命中 + 失败同 error，且**同入口、同 process**。
// 边界：真库/store 仍每用例独立（本模块不建 store、不碰数据/真实档）；cleanup 由本模块收口，交调用方 dispose 一次。
import { createNativeS4Prepare } from './native-s4-prepare.mjs'
import { isNativeDataApplied } from '../../deploy/native-data-transform.mjs'
import { AUTHOR_VERSION } from '../../lib/standard-host.js'

const INDEX = 'tavern-plugin/lib/index.js'
let cleanupFn = null

// T4：本模块**自己的**计数对象（不与 S4 的全局 nativeS4Metrics 共用，避免互相污染计数）。
const nativeDataMetrics = { preparations: 0, cacheHits: 0, failures: 0, cleanups: 0 }

const prepare = createNativeS4Prepare({
  index: INDEX,
  authorVersion: AUTHOR_VERSION,
  isNativeDataApplied,
  registerCleanup: fn => { cleanupFn = fn },
  label: 'native-data',
  metrics: nativeDataMetrics,
})

/** 懒取共享的 ACTIVE 投影文本（第一次真实施缝，之后命中缓存；失败同 error，不重复准备）。 */
export function nativeDataSeamSource() {
  return prepare.seamSource()
}

/** 准备计数（preparations/cacheHits/failures/cleanups），供 after 钩子核对"两消费者只准备一次"。 */
export { nativeDataMetrics }

/** 只删共享准备自建的 mkdtemp 目录（幂等；未准备过则不动）。 */
export function disposeNativeDataPrepare() {
  if (typeof cleanupFn !== 'function') return false
  const fn = cleanupFn
  cleanupFn = null
  fn()
  return true
}
