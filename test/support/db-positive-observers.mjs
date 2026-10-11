// DB 交换桥标准接缝（原 db-save-latest-seams 第 2 条「DB标准接缝桥为owned-new且卸载逐字节还原」）迁移：
// 断言全部改从**共享生命周期阶段快照**读（before/installed/record/ready/restored），不再自行 copy/apply/uninstall。
// 本模块只注册用例；无 node:test 顶层自注册、无全局 test.after 指标（入口统一）。
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { activeSource, commentAuthorTreeSource } from '../fixtures/comment-author-tree.mjs'

const BRIDGE = 'tavern-plugin/lib/domain/storage-db-save.js'
const INDEX = 'tavern-plugin/lib/index.js'
const BRIDGE_BODY = '// [dsh-tavern-standard-owned:v1]\nimport { storagePackage } from \'./storage-package.js\'\nexport const { createDbSaveExchange, createDbSaveRegistration, createDbSaveResourceTransfer } = await storagePackage(\'db-save-exchange\')\n'
const NEEDLE = "case 'exportGameSave': return await exportGameSave("

/** 目标代判据（不触发任何准备阶段）：作者源 index 不含该 RPC 字面量则 skip，不假跑。 */
export function dbTargetGenerationSkipReason() {
  const root = commentAuthorTreeSource()
  if (!root) return '无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）'
  return null
}

export function registerDbTests(test, lifecycle) {
  test('DB标准接缝桥为owned-new且卸载逐字节还原', async t => {
    const reason = dbTargetGenerationSkipReason()
    if (reason) return t.skip(reason)
    const installed = await lifecycle.ensureInstalled()
    t.diagnostic('共享生命周期：已装配（copy 一次）')
    if (!installed.before[INDEX].includes(NEEDLE)) return t.skip('当前夹具不是目标作者代：请用 DSH_TAVERN_TEST_APP 指向该代作者源码')
    const restored = await lifecycle.ensureRestored()
    const edit = await lifecycle.ensureUserEdit()

    // 注释块协议：raw 里 BEGIN/END 标记与 ORIGINAL 注释会打断连续字面 ⇒ 业务字节一律看 ACTIVE 投影；
    // raw 只承担"块标记计数"这类协议层断言（marker 恰一处、RPC case 不重复等）。
    const rawIndex = installed.installed[INDEX], bridge = installed.installed[BRIDGE]
    const index = activeSource(rawIndex, INDEX)
    // ① 桥：自有新文件以完整 owned-file 注释区块承载；ACTIVE 投影逐字等于自有实现（业务字节不变）。
    assert.ok(bridge.includes('[dsh-tavern-seam:BEGIN]') && bridge.includes('id=owned-file') && bridge.includes('[dsh-tavern-seam:END]'), '自有桥必须是完整 owned-file 注释区块')
    const record = installed.record
    assert.equal(record.format, 1); assert.equal(record.owner, 'dsh-tavern-sqlite-v2')
    assert.deepEqual(Object.keys(record).sort(), ['files', 'format', 'owned', 'owner'])
    assert.equal(record.owned[BRIDGE]?.mode, 'owned-new', '自有桥必须以 owned-new 记录')
    // 新契约：owned 记录只留 metadata 四键（不存 body）；实现字节从现场 owned-file 块的 ACTIVE 投影读。
    assert.deepEqual(Object.keys(record.owned[BRIDGE]).sort(), ['format', 'mode', 'owner', 'rel'], 'owned 记录只留 metadata 四键')
    assert.equal(Object.hasOwn(record.owned[BRIDGE], 'body'), false, 'owned 记录不得保存 body 历史')
    assert.equal(activeSource(bridge, BRIDGE), BRIDGE_BODY, 'ACTIVE 投影必须逐字等于自有实现（业务字节不变）')
    assert.ok(record.files[INDEX]?.blocks?.length >= 1, 'index 必须以块记录承载接缝')
    assert.equal(record.files[BRIDGE], undefined, '自有新文件不进 blocks 表')
    // ①b index：marker 唯一（raw 计数）+ 3 factory import + 3 个 dbSave 常量装配（ACTIVE 投影看字节）
    assert.equal(rawIndex.split('// [dsh-tavern-db-save:v1]').length - 1, 1)
    assert.equal(rawIndex.split('[dsh-tavern-seam:BEGIN]').length - 1, rawIndex.split('[dsh-tavern-seam:END]').length - 1)
    assert.ok(index.includes("import { createDbSaveExchange, createDbSaveRegistration, createDbSaveResourceTransfer } from './domain/storage-db-save.js'"))
    assert.ok(index.includes('const dbSaveExchange = createDbSaveExchange({'))
    // ② 两个 consumer RPC transport 保留、images 传输语义不改
    assert.equal(index.split("case 'exportGameSave'").length - 1, 1)
    assert.equal(index.split("case 'importGameSave'").length - 1, 1)
    assert.ok(index.includes("case 'exportGameSave': return await exportGameSave(args && args.sessionId, { images: args && args.images !== false })"))
    assert.ok(index.includes("case 'importGameSave': return await importGameSave(args)"))
    assert.ok(index.includes('  async function exportGameSave(sessionId, options = {}) {\n    return await dbSaveExchange.exportGameSave(sessionId, options)\n  }'))
    assert.ok(index.includes('  async function importGameSave(args) {\n    return await dbSaveExchange.importGameSave(args)\n  }'))
    // ③ 登记补偿与资源桥接在同一注入点，sceneFiles 旧 dep 不残留
    for (const literal of [
      'const dbSaveRegistration = createDbSaveRegistration({ store: profileData })',
      'const dbSaveResources = createDbSaveResourceTransfer({',
      'resources: dbSaveResources,',
      "attachments: ctx.get('attachments'),",
      'computeSceneTarget,',
      "validateCard: async payload => { const card = await cardPreparation.create({ kind: 'import', payload }); return { raw: cardPreparation.present({ card, as: 'raw' }), definition: cardPreparation.project(card) } }",
      'unpublish: identity => dbSaveRegistration.discard(identity)',
      'await tavernScriptHostAdapter.whenIdle(chat.sessionId)'
    ]) assert.ok(index.includes(literal), '缺接缝字面：' + literal)
    assert.equal(index.includes('sceneFiles:'), false)
    // 删局消费接在真实 deleteChat 上，位于 registry.remove 之前且唯一
    const deleteCall = index.indexOf('dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId')
    assert.ok(deleteCall > 0, '缺删局预检消费')
    assert.ok(deleteCall < index.indexOf('const result = await conversationRegistry.remove(chatId)'), '删局预检未在 registry.remove 之前')
    assert.equal(index.split('dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId').length - 1, 1)
    // ④ 官方锚点与 Set cache consumer 未被串改
    for (const literal of [
      installed.before[INDEX].split('\n').find(line => line.startsWith('import { computeSceneTarget, createSceneIllustrations, sceneTarget') && line.endsWith("from './domain/scene-illustration.js'")),
      'const importingGameSaves = new Set()',
      'const deletedChatIds = new Set()',
      'const original = sceneTarget(historical, target.turn)'
    ]) assert.ok(index.includes(literal), '官方锚点被串改：' + literal)
    assert.equal(index.split('const importingGameSaves = new Set()').length - 1, 1)
    assert.equal(index.split('const deletedChatIds = new Set()').length - 1, 1)
    // ⑤ 卸载必须按块记录与 owned body 逐字节还原到接缝前
    assert.equal(restored.uninstallResult.changed, true)
    const bridgeOriginal = installed.before[BRIDGE]
    if (bridgeOriginal === undefined || bridgeOriginal === null) assert.equal(restored.restored[BRIDGE], null, '卸载后 owned-new 文件必须被删除')
    else assert.equal(restored.restored[BRIDGE], bridgeOriginal, '卸载后桥必须逐字节还原作者原文')
    assert.equal(restored.restored[INDEX], installed.before[INDEX] + edit.appended, '卸载后 index 必须逐字节还原作者原文（块外用户编辑保留）')
    assert.equal(restored.ready.ready, false, '卸载后不得 ready')
    assert.equal(installed.ready.ready, true, '装配后必须 ready')
    assert.equal(existsSync(`${lifecycle.appDir}/${BRIDGE}`), false, '卸载后 owned 文件不得留在磁盘')
  })
}
