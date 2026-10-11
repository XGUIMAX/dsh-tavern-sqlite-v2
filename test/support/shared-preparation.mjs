// 共享准备（S5）快照隔离的独立证据：真实生命周期一次，两个消费者不得互相污染，且快照/私有 Map 不可被就地改写。
// 只 import 共享支撑模块（不 import 任何业务 DB/产品代码）；作者源用 helper 默认（682 代）。
import assert from 'node:assert/strict'
import { s5Lifecycle, disposeS5Lifecycle, s5Metrics, S5_DOMAIN_FILES } from './native-message-lifecycle.mjs'
const REL = S5_DOMAIN_FILES.turnOrchestration

// 入口显式调用（不自动注册）：与同进程内的 S5 正向用例共用同一 s5Lifecycle promise，不新增完整 cycle。
export function registerSharedPreparation(test) {
  test('共享准备：S5快照脱离且两个消费者不污染证据', async t => {
    let life
    try {
      life = await s5Lifecycle()
      const firstBytes = life.before[REL].bytes
      const firstSourceBytes = life.sourceBytes[REL]
      const firstText = life.before[REL].text
      const firstCopied = life.copied
      const originalCopiedText = firstCopied.get(REL)
      assert.equal(Buffer.isBuffer(firstBytes), true, '快照 bytes 仍是 Buffer（旧 API 不变）')
      assert.equal(Buffer.isBuffer(firstSourceBytes), true, 'sourceBytes 仍是 Buffer')
      assert.equal(typeof originalCopiedText, 'string', 'copied 仍是 Map<rel,text>')

      // ① 消费者就地改写拿到的 Buffer / Map，不得污染共享证据、源字节或后续读取
      firstBytes.fill(0)
      firstCopied.set(REL, '被篡改')
      firstCopied.set('被篡改的键', 'x')
      assert.equal(life.before[REL].bytes.equals(Buffer.from(firstText, 'utf8')), true, '改写旧副本后重新读取仍是原文')
      assert.equal(life.sourceBytes[REL].equals(firstSourceBytes), true, '源字节 getter 仍给原值')
      assert.notEqual(life.before[REL].bytes, firstBytes, '每次读取都是独立 Buffer 实例')

      // ② 第二次准备：同一 promise、同一结果对象，但 bytes 独立且等值；copied 每次给新副本且值未被篡改影响
      const p1 = s5Lifecycle()
      const p2 = s5Lifecycle()
      assert.equal(p1, p2, '两次调用共用同一次准备（同一 promise）')
      const second = await p2
      assert.equal(second, life, '第二次拿到同一结果对象')
      assert.notEqual(second.before[REL].bytes, firstBytes, 'bytes 独立实例')
      assert.equal(second.before[REL].bytes.equals(Buffer.from(firstText, 'utf8')), true, 'bytes 与原文字节相等')
      const secondCopied = second.copied
      assert.notEqual(secondCopied, firstCopied, 'copied 每次返回新 Map 副本')
      assert.equal(secondCopied.get(REL), originalCopiedText, '私有 Map 未被消费者篡改')
      assert.equal(secondCopied.has('被篡改的键'), false, '私有 Map 不接受消费者塞入的键')

      // ③ 冻结：结果对象、快照、record 及其嵌套对象赋值必须响亮抛 TypeError
      assert.equal(Object.isFrozen(life), true, '结果对象整体冻结')
      assert.equal(Object.isFrozen(life.before[REL]), true, '快照对象冻结')
      assert.throws(() => { life.before[REL].text = 'x' }, TypeError, '不得改写快照 text')
      assert.throws(() => { life.record.__probe = 1 }, TypeError, '不得改写 record 顶层')
      const nested = Object.values(life.record).find(value => value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value))
      if (nested) assert.throws(() => { nested.__probe = 1 }, TypeError, '不得改写 record 嵌套对象')
      assert.throws(() => { life.appDir = 'x' }, TypeError, '不得改写结果对象字段')

      // ④ 已发生的真实施缝/卸载：卸载后逐字还原，record 消失
      assert.ok(life.applyResult, 'apply 结果存在')
      assert.ok(life.uninstallResult, 'uninstall 结果存在')
      assert.equal(life.recordExistsAfter, false, '卸载后接缝记录消失')
      assert.equal(life.restored[REL].bytes.equals(life.before[REL].bytes), true, '卸载后字节与 before 等值')
      assert.equal(life.restored[REL].text, firstText, '卸载后文本与 before 相同')

      // ⑤ 真实阶段计数（dispose 之前）：copy/apply/uninstall 各恰一次，cleanup 尚未发生
      assert.deepEqual({ ...s5Metrics }, { copies: 1, apply: 1, uninstall: 1, cleanups: 0 }, '阶段计数：真实步骤各一次')
    } finally {
      disposeS5Lifecycle()
      assert.equal(s5Metrics.cleanups, 1, 'dispose 后清理计数恰一次')
      t.diagnostic('S5准备计数：' + JSON.stringify({ ...s5Metrics }))
    }
  })
}
