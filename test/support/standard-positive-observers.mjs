// 标准接入集成（原 comment-standard-integration 第 1 条）迁移：所有断言改从**共享生命周期各阶段快照**读，
// 不再自己 copy/apply/check/uninstall；本模块只注册用例、不含 node:test 顶层副作用（注册由调用方传入 test）。
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parseSeamSource } from '../../deploy/comment-seam-blocks.mjs'

const OWNER = 'dsh-tavern-sqlite-v2'
const INDEX = 'tavern-plugin/lib/index.js'
const CLIENT_BUILT = 'tavern-plugin/lib/client.js'
const OLD_RECORDS = ['.tavern-standard-seams.json', '.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json']
const PACKAGE = 'tavern-plugin/package.json'
const identical = (left, right, label) => assert.deepEqual([...left], [...right], label)

/** 把原 28-102 的逐项断言挂到共享生命周期的对应阶段快照上（消费者只观察自己需要的阶段）。 */
export function registerStandardTests(test, lifecycle) {
  test('块产品1 真实裸树全部接缝安装卸载及源码构建双路径', async () => {
    const installed = await lifecycle.ensureInstalled()
    const noop = await lifecycle.ensureNoop()
    const edit = await lifecycle.ensureUserEdit()
    const restored = await lifecycle.ensureRestored()
    const repeat = await lifecycle.ensureRepeat()

    // ① 纯预检：只算不写
    assert.equal(installed.preflight, 'passed')
    assert.equal(installed.authorVersion, JSON.parse(installed.installed[PACKAGE]).version)
    assert.equal(installed.plan.ready, false, '裸树尚未接入')
    identical(Object.entries(installed.afterPre), Object.entries(installed.before), '预检不得改写源码')

    // ② 真实裸树安装
    assert.equal(installed.applyResult.ready, true)
    assert.equal(installed.applyResult.changed, true)
    assert.ok(installed.applyResult.written.length > 0, '安装必须真的写文件')
    assert.equal(installed.ready.ready, true)
    const record = installed.record
    assert.equal(record.format, 1)
    assert.equal(record.owner, OWNER)
    assert.equal(Object.keys(record).length, 4)
    assert.ok(Object.keys(record.files).length > 0, '必须有注释块文件')
    assert.ok(Object.keys(record.owned).length > 0, '必须有 owned-new')

    // ③ 产物只做语法/块校验（不 eval、不读用户数据）
    const after = new Map(Object.entries(installed.installed).filter(([, text]) => text !== null))
    for (const [rel, text] of after) if (rel.endsWith('.js')) parseSeamSource(text, { rel })
    for (const rel of [...Object.keys(record.files), ...Object.keys(record.owned)]) assert.ok(after.has(rel), '记录文件必须存在：' + rel)
    for (const [rel, entry] of Object.entries(record.owned)) {
      // 新契约：owned 记录只留 metadata 四键（不存 body）；自有实现从现场 owned-file 块的 ACTIVE 投影读。
      assert.deepEqual(Object.keys(entry).sort(), ['format', 'mode', 'owner', 'rel'], 'owned 记录只留 metadata 四键：' + rel)
      assert.equal(entry.mode, 'owned-new')
      const blocks = parseSeamSource(after.get(rel), { rel }).blocks
      assert.equal(blocks.length, 1, rel + ' 必须是 id=owned-file 的 insert 块')
      assert.equal(blocks[0].metadata.id, 'owned-file')
      const active = after.get(rel).slice(blocks[0].regions.active.beginEnd, blocks[0].regions.active.endStart)
      assert.ok(active.trim().length > 0, rel + ' ACTIVE 必须承载自有实现（非空）')
    }

    // ④ source / built 双路径都带真实块
    const sourceRels = Object.keys(record.files).filter(rel => rel.startsWith('tavern-plugin/src/client/'))
    assert.ok(sourceRels.length > 0, '拆分源码路径必须有块')
    assert.ok(Object.hasOwn(record.files, CLIENT_BUILT), '构建产物 lib/client.js 必须有块')
    for (const rel of [...sourceRels, CLIENT_BUILT]) assert.match(after.get(rel), /\[dsh-tavern-seam:ACTIVE_BEGIN\]/)

    // ⑤ 必要接线确实进了产物（failTarget / legacy guard / 宿主补丁共享入口）
    for (const rel of [CLIENT_BUILT, 'tavern-plugin/src/client/features/play-controls.js']) {
      assert.match(after.get(rel), /get failureTarget\(\) \{ return failureViewRef\.current\.view && failureViewRef\.current\.view\.failureTarget \|\| null \}/, rel + ' 必须用稳定 ref 活取当前视图')
      assert.doesNotMatch(after.get(rel), /get failureTarget\(\) \{ return state\.view/, rel + ' 不得回退为闭包 state.view')
      assert.match(after.get(rel), /const failureViewRef = React\.useRef\(state\);/, rel + ' 必须有跨 render 稳定 ref')
      assert.match(after.get(rel), /\[props\.sessionId, revision, failureTargetKey\]\);/, rel + ' 目标身份变化必须触发 effect 重建')
    }
    assert.match(after.get(INDEX), /installAuthorHostSessionPatch\(ctx\)/)
    assert.match(after.get('tavern-plugin/lib/domain/tavern-conversation-registry.js'), /legacyViewSeams\.assertWritable\(/)
    assert.match(after.get('tavern-plugin/lib/domain/legacy-view-seams.js'), /installAuthorHostSessionPatch/)

    // ⑥ 重装零写
    assert.equal(noop.noopResult.changed, false)
    assert.equal(noop.noopResult.written.length, 0)
    assert.equal(noop.identical, true, '重装必须零写')

    // ⑦ 块外用户编辑必须保留，卸载逐字节还原
    assert.equal(restored.restored[INDEX], installed.before[INDEX] + edit.appended, '块外编辑必须保留')
    assert.equal(restored.restored[INDEX].endsWith('// 用户说明（共享生命周期夹具）：此行必须跨卸载保留\n'), true)
    for (const rel of Object.keys(record.owned)) {
      assert.equal(restored.restored[rel], null, 'owned-new 必须删除：' + rel)
      assert.equal(restored.restoredVsSource[rel], true, 'owned 复原后应与作者源一致（无该文件 ⇒ null）：' + rel)
    }
    assert.equal(restored.oldRecords['.tavern-comment-seams.json'], null, '记录必须删除')
    for (const rel of OLD_RECORDS) assert.equal(existsSync(path.join(lifecycle.appDir, rel)), false, '不得残留旧记录：' + rel)
    assert.deepEqual(readdirSync(lifecycle.appDir).filter(name => name.startsWith('.tavern-')), [], '不得留下记录/备份')
    for (const [rel, text] of Object.entries(installed.before)) {
      if (rel === INDEX || text === null) continue
      const restoredText = restored.restored[rel]
      if (restoredText === null && installed.record.owned[rel]) continue
      assert.equal(restoredText ?? null, text, '必须逐字节还原：' + rel)
    }

    // ⑧ 重复卸载幂等
    assert.equal(repeat.repeatResult.changed, false)
    assert.equal(repeat.identical, true, '重复卸载必须零写')
  })

}
