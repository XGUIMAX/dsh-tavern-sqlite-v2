import assert from 'node:assert/strict'
// 薄入口（T4 标准子集）：标准接入集成原第 1 条用例的**同名**入口；断言体在
// support/standard-positive-observers.mjs，全部按共享生命周期（support/standard-positive-lifecycle.mjs）的阶段快照核。
import test from 'node:test'
import { standardPositiveLifecycle } from './support/standard-positive-lifecycle.mjs'
import { registerStandardTests } from './support/standard-positive-observers.mjs'

registerStandardTests(test, standardPositiveLifecycle)
import { registerDbTests } from './support/db-positive-observers.mjs'
import { registerNativeTests } from './support/native-positive-observers.mjs'
import { registerFailureTests } from './support/failure-positive-observers.mjs'
import { registerPr13InstallObservers } from './support/pr13-positive-observers.mjs'

// 注册顺序＝执行顺序：standard 组先跑完全部阶段（含 noop 缓存），DB 组随后复用同一份阶段快照
// （DB 的磁盘断言读的是卸载后现场 ⇒ 顺序不影响其语义；反序会因"复原后不得再 noop"而违背顺序合同）。
// DB 组如单独选中，则先 await ensureNoop() 再 ensureRestored()（见 support/db-positive-observers.mjs 的 group needs）。
registerFailureTests(test, standardPositiveLifecycle)
registerDbTests(test, standardPositiveLifecycle)
registerNativeTests(test, standardPositiveLifecycle)
// PR13 安装合同第 1 叶：只观察同一份阶段快照（installed/edit/restored），不重装、不 live 读盘；置于末尾以复用缓存快照
registerPr13InstallObservers(test, standardPositiveLifecycle)

test.after(() => {
  const metrics = standardPositiveLifecycle.metrics()
  assert.ok(metrics.copies <= 1, '共享准备至多一次有限复制，实际=' + metrics.copies)
  standardPositiveLifecycle.dispose()
  console.log('标准/DB 共享生命周期指标：' + JSON.stringify(metrics))
})
