// PR13实际标准装卸与作者迁移入口；缺作者源码显式失败，不读用户存档。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { applyStandardSeams, uninstallStandardSeams, checkStandardSeams } from '../deploy/standard-seams.mjs'
import { prepareCommentAuthorTree, commentAuthorTreeSource } from './fixtures/comment-author-tree.mjs'
import { wrapAuthorMigrationStore } from '../lib/author-migration-adapter.js'

function authorTavernPlugin() {
  const explicit = process.env.AUTHOR_TAVERN_PLUGIN?.trim()
  const from = commentAuthorTreeSource()
  if (!explicit && !from) throw new Error('缺少作者夹具：请设置 DSH_TAVERN_TEST_APP 或 AUTHOR_TAVERN_PLUGIN')
  return explicit || path.join(from, 'tavern-plugin')
}

test('PR13安装合同1：首装后storage-failure-state桥ACTIVE且ready，卸载后桥消失而作者原目标文本保留', () => {
  const prepared = prepareCommentAuthorTree()
  if (!prepared) throw new Error('缺少作者夹具：请设置 DSH_TAVERN_TEST_APP')
  const { appDir, cleanup } = prepared
  try {
    const applied = applyStandardSeams({ appDir, assertStopped: () => true })
    assert.equal(applied.ready, true)
    assert.equal(checkStandardSeams({ appDir }).ready, true)
    const bridge = path.join(appDir, 'tavern-plugin/lib/domain/storage-failure-state.js')
    assert.equal(existsSync(bridge), true)
    assert.ok(readFileSync(bridge, 'utf8').includes("await storagePackage('failure-state')"))
    const turnSource = readFileSync(path.join(appDir, 'tavern-plugin/lib/domain/turn-orchestration.js'), 'utf8')
    assert.ok(turnSource.includes("import { ledgerFailureState } from './storage-failure-state.js'"))
    assert.ok(readFileSync(path.join(appDir, 'tavern-plugin/lib/index.js'), 'utf8').includes('store: authorMigrationStore'))
    uninstallStandardSeams({ appDir, assertStopped: () => true })
    assert.equal(existsSync(bridge), false)
    for (const [rel, original] of prepared.original) {
      assert.equal(readFileSync(path.join(appDir, rel), 'utf8'), original, '卸载保留作者文本：' + rel)
    }
  } finally { cleanup() }
})

test('PR13安装合同2：真作者conversation-migration下status报native、migrate零写且legacy原档拒', async () => {
  const source = readFileSync(path.join(authorTavernPlugin(), 'lib/domain/conversation-migration.js'), 'utf8')
  const author = await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))
  assert.equal(typeof author.createConversationMigration, 'function')
  let writes = 0
  const notifications = [], idleChecks = []
  const wrapped = wrapAuthorMigrationStore({
    version: async id => id === 'legacy-pr13' ? 'legacy:10:20' : 'sqlite:gen:12',
    read: async id => ({ id }),
    migrateNative: async () => { writes++; throw new Error('禁止原store迁移写入') },
  })
  const created = author.createConversationMigration({ store: wrapped, assertIdle: chat => idleChecks.push(chat.id), notify: id => notifications.push(id) })
  assert.equal((await created.status('chat-pr13')).format, 'native')
  assert.equal(created.start('chat-pr13').phase, 'running')
  await created.dispose()
  assert.equal((await created.status('chat-pr13')).phase, 'completed')
  assert.deepEqual(notifications, ['chat-pr13'])
  assert.equal((await created.status('legacy-pr13')).format, 'legacy')
  created.start('legacy-pr13')
  await created.dispose()
  const refused = await created.status('legacy-pr13')
  assert.equal(refused.phase, 'failed')
  assert.match(refused.error, /同 ID 原地迁移|显式分叉/)
  assert.deepEqual(idleChecks, ['legacy-pr13'])
  assert.equal(writes, 0)
})
