// PR13 安装合同第 1 叶迁移入口（原 test/pr13-install-contract.test.mjs 的同名用例）：
// 不再自己 prepareCommentAuthorTree + applyStandardSeams/uninstallStandardSeams，
// 改为**只观察共享生命周期（support/standard-positive-lifecycle.mjs）的阶段快照**：
//   ensureInstalled() ＝ 真装后（含 ready/record/installed/before），ensureUserEdit() ＝ 共享夹具的块外改动，
//   ensureRestored() ＝ 真卸后。不读活磁盘、不重装、不复制夹具；本模块只注册用例，不含 node:test 顶层副作用。
import assert from 'node:assert/strict'
import { activeSource } from '../fixtures/comment-author-tree.mjs'

const INDEX = 'tavern-plugin/lib/index.js'
const TURN = 'tavern-plugin/lib/domain/turn-orchestration.js'
const BRIDGE = 'tavern-plugin/lib/domain/storage-failure-state.js'
const RECORD = '.tavern-comment-seams.json'
// 快照必须真的含目标；缺字段不能当成已删除（null）。
const field = (snapshot, name) => {
  assert.ok(Object.hasOwn(snapshot, name), '阶段快照缺少目标：' + name)
  return snapshot[name]
}

/** 把原 PR13 安装合同第 1 叶挂到共享生命周期的 installed/edit/restored 三阶段快照上。 */
export function registerPr13InstallObservers(test, lifecycle) {
  test('PR13安装合同1：首装后storage-failure-state桥ACTIVE且ready，卸载后桥消失而作者原目标文本保留', async () => {
    const installed = await lifecycle.ensureInstalled()
    const edit = await lifecycle.ensureUserEdit()
    const restored = await lifecycle.ensureRestored()

    // ① 首装就绪（阶段快照，不重装）
    assert.equal(installed.applyResult.ready, true, '真实施缝必须就绪')
    assert.equal(installed.ready.ready, true, '首装后 seams 必须 ready')

    // ② 桥存在，且其**ACTIVE 投影**真承载业务依赖（不是被注释掉的 ORIGINAL 区）
    const bridge = field(installed.installed, BRIDGE)
    assert.equal(typeof bridge, 'string', '首装后必须存在 storage-failure-state 桥：' + BRIDGE)
    assert.ok(activeSource(bridge, BRIDGE).includes("await storagePackage('failure-state')"), '该依赖必须位于 ACTIVE 区（真正的实现，而非注释原文）')

    // ③ 消费者接线：turn 编排导入守卫判据、作者入口注入迁移 store
    assert.ok(activeSource(field(installed.installed, TURN), TURN).includes("import { ledgerFailureState } from './storage-failure-state.js'"), 'turn 编排必须接线到 storage-failure-state 守卫')
    assert.ok(activeSource(field(installed.installed, INDEX), INDEX).includes('store: authorMigrationStore'), '作者入口必须注入 authorMigrationStore')

    // ④ 卸载后：桥消失、记录清空、**所有被观测原目标**回到原值（INDEX 额外含共享夹具的块外改动）
    assert.equal(field(restored.restored, BRIDGE), null, '卸载后桥必须消失：' + BRIDGE)
    assert.equal(field(restored.restored, RECORD), null, '卸载后不得留记录（阶段快照）')
    assert.equal(restored.ready.ready, false, '卸载后不得 ready')
    const targets = Object.entries(installed.before).filter(([, before]) => before !== null)
    assert.ok(targets.length > 0, '必须观测到非空原目标')
    assert.ok(Object.hasOwn(installed.before, INDEX), '原目标必须包含作者入口：' + INDEX)
    for (const [rel, before] of targets) {
      const expected = rel === INDEX ? before + edit.appended : before
      assert.equal(field(restored.restored, rel), expected, '卸载后必须逐字节回到原值：' + rel)
    }
  })
}
