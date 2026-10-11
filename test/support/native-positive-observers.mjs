// 同源正向观察复用阶段快照；不注册其他场景、不共享业务状态。
import assert from 'node:assert/strict'
import { activeSource } from '../fixtures/comment-author-tree.mjs'
import { isNativeDataApplied } from '../../deploy/native-data-transform.mjs'
import { COMMENT_SEAMS_RECORD } from '../../deploy/comment-seam-files.mjs'
const INDEX = 'tavern-plugin/lib/index.js'
const BRIDGE = 'tavern-plugin/lib/domain/storage-native-data.js'
const RECORD = COMMENT_SEAMS_RECORD
export function registerNativeTests(test, lifecycle) {
  test('S1 S2标准装卸保持同store能力桥并恢复作者字节', async () => {
    const installed = await lifecycle.ensureInstalled()
    const restored = await lifecycle.ensureRestored()
    const edit = await lifecycle.ensureUserEdit()
    const indexBefore = installed.before[INDEX]
    const indexSeamed = installed.installed[INDEX]
    const bridgeAfter = installed.installed[BRIDGE]
    assert.equal(installed.before[BRIDGE], null, '装配前不应存在该桥（作者树无此文件）')

    // ① 装配：桥写入、记录归属（owned-new + 注释块）、check ready（前置：装配前原字节未应用转换）
    assert.equal(isNativeDataApplied(indexBefore), false, '前置（装配前原字节）：尚未应用 native-data 转换')
    assert.equal(installed.applyResult.changed, true)
    assert.equal(bridgeAfter !== null, true, '装配后桥必须存在')
    // 桥是 projector 工厂入口（不是"同 store 摘要"本身）：同 store 的实际证明在 index 的 store 调用
    assert.match(bridgeAfter, /storagePackage\('session-window-projector'\)/, '桥必须接同一 store 能力包（session-window-projector）')
    assert.match(bridgeAfter, /createSessionWindowProjector/, '桥必须暴露 S2 窗口投影工厂')
    assert.match(bridgeAfter, /createActivitySummaryBridge/, '桥必须暴露 S1 活动摘要工厂')
    // 作者 index 上的 native-data 转换：装配后读**实际** index，必须已应用且真实调用同一 store
    assert.equal(isNativeDataApplied(indexSeamed), true, '装配后实际 index 必须已应用 native-data 转换')
    assert.match(indexSeamed, /chatJournalStore\.readActivitySummary/, 'index 必须真实调用同一 store 的 readActivitySummary')
    assert.match(indexSeamed, /chatJournalStore\.readOpeningWindow/, 'index 必须真实调用同一 store 的 readOpeningWindow')
    assert.match(indexSeamed, /storage-native-data\.js/, 'index 必须 import 新桥（projector 工厂）')
    const record = installed.record
    assert.equal(record.format, 1)
    assert.equal(record.owner, 'dsh-tavern-sqlite-v2')
    assert.ok(Object.hasOwn(record.owned, BRIDGE), 'owned-new 归属必须记新桥：' + BRIDGE)
    assert.equal(record.owned[BRIDGE].mode, 'owned-new')
    // 新契约：owned 记录只留 metadata 四键（不存 body）；实现字节从现场 owned-file 块的 ACTIVE 投影读。
    assert.deepEqual(Object.keys(record.owned[BRIDGE]).sort(), ['format', 'mode', 'owner', 'rel'], 'owned 记录只留 metadata 四键')
    assert.equal(Object.hasOwn(record.owned[BRIDGE], 'body'), false, 'owned 记录不得保存 body 历史')
    assert.match(activeSource(bridgeAfter, BRIDGE), /storagePackage\('session-window-projector'\)/, 'ACTIVE 投影必须承载真实自有实现')
    assert.ok(Object.hasOwn(record.files, INDEX), '作者 index 必须记成注释块文件')
    assert.ok(record.files[INDEX].blocks.length > 0, 'index 必须至少一个接缝块')
    assert.equal(installed.ready.ready, true, '装配后应 ready')

    // ② 卸载：桥移除、记录清理、作者 index 逐字节回原（不残留旧全 timeline 形态）
    assert.equal(restored.uninstallResult.changed, true)
    assert.equal(restored.restored[BRIDGE] !== null, false, '卸载后桥必须移除')
    assert.equal(restored.restored[RECORD] !== null, false, '卸载后不应残留标准记录')
    assert.deepEqual(restored.restored[INDEX], indexBefore + edit.appended, '作者 lib/index.js 必须逐字节恢复')
    const indexAfter = restored.restored[INDEX]
    assert.equal(/session-window-projector|createActivitySummaryBridge/.test(indexAfter), false, '卸载后 index 不得残留新桥引用')
  })
}
