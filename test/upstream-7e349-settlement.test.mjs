// 上游 7e349 结算静止适配：真实新 raw（逐字取自 raw.githubusercontent.com/flizzywine/dsh-tavern/7e349fab…/tavern-plugin/lib/domain/settlement-jobs.js）
// 与由其派生的旧布局（去 pending、返回回退为 { start, cancel, dispose }）都必须被 applySettlementQuiescenceTransform 唯一命中；
// 并核运行时合同：wait:false 取消后仍 busy 直到 promise/onSettled 收尾、pending 可消费、onIdle 恰释放一次。
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { applySettlementQuiescenceTransform } from '../deploy/rollback-quiescence-transform.mjs'

const NEW_RAW = `/** Own in-memory settlement executions; durable eligibility remains in the timeline. */
export function createSettlementJobs({ run, onSettled }) {
  const jobs = new Map()
  const lifetime = new AbortController()
  let disposed = false

  function start(chatId) {
    if (disposed) return Promise.resolve()
    const existing = jobs.get(chatId)
    if (existing) return existing.promise
    const job = { controller: new AbortController(), promise: null }
    const signal = AbortSignal.any([job.controller.signal, lifetime.signal])
    job.promise = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return run(chatId, signal)
    }).finally(async () => {
      if (jobs.get(chatId) === job) jobs.delete(chatId)
      // Cancellation/deletion must not publish a new wake before their durable
      // stop is saved. Shutdown likewise cannot restart work from finally.
      if (!disposed && !signal.aborted) await onSettled(chatId, signal)
    })
    jobs.set(chatId, job)
    return job.promise
  }

  /** The running job of a chat (settled either way), or null. */
  function pending(chatId) {
    const job = jobs.get(chatId)
    return job ? job.promise.catch(() => {}) : null
  }

  async function cancel(chatId, { wait = true } = {}) {
    const job = jobs.get(chatId)
    if (!job) return false
    job.controller.abort()
    if (!wait) jobs.delete(chatId)
    else await job.promise.catch(() => {})
    return true
  }

  function dispose() {
    disposed = true
    lifetime.abort()
    for (const job of jobs.values()) job.controller.abort()
    jobs.clear()
  }

  return Object.freeze({ start, pending, cancel, dispose })
}
`
// 旧布局：与 7e349 之前的作者文件同形（去掉 pending 成员与其函数、返回串复原）
const OLD_RAW = NEW_RAW
  .replace(/  \/\*\* The running job of a chat \(settled either way\), or null\. \*\/\n  function pending\(chatId\) \{\n[\s\S]*?\n  \}\n\n/, '')
  .replace('{ start, pending, cancel, dispose }', '{ start, cancel, dispose }')

/** 在 vm 中求值（只剥 export，逻辑不动）；onIdle 换成可观测计数。 */
function evaluate(transformed) {
  const script = transformed
    .replace(/^export /gm, '')
    .replace('onIdle = () => {}', 'onIdle = chatId => { __idle.push(chatId) }')
  const sandbox = { AbortController, AbortSignal, console, __idle: [] }
  vm.createContext(sandbox)
  vm.runInContext(script, sandbox)
  return sandbox
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('上游7e349结算静止适配：新旧布局各唯一命中，wait:false仍busy至promise/onSettled收尾、pending可消费、onIdle恰一次', async () => {
  // ① 布局前提（真 raw 事实）
  assert.ok(NEW_RAW.includes('return Object.freeze({ start, pending, cancel, dispose })'), '新 raw 必须是含 pending 的新返回串')
  assert.ok(!OLD_RAW.includes('pending('), '旧派生态不得再含 pending 成员')
  assert.ok(OLD_RAW.includes('return Object.freeze({ start, cancel, dispose })'), '旧派生态必须是旧返回串')

  for (const [label, raw] of [['新布局', NEW_RAW], ['旧布局', OLD_RAW]]) {
    const out = applySettlementQuiescenceTransform(raw)
    assert.ok(out.includes('isBusy: chatId => jobs.has(chatId)'), label + '：必须注入只读 isBusy')
    if (label === '新布局') assert.ok(out.includes('start, pending, cancel, dispose, isBusy'), label + '：必须保留 pending 并追加 isBusy')
    assert.ok(out.includes('onIdle = () => {}'), label + '：必须保留 onIdle 合同')
    assert.ok(out.includes('if (wait) await job.promise.catch(() => {})'), label + '：取消必须改为「等 promise」，不再即时删 job')
    assert.ok(!out.includes('if (!wait) jobs.delete(chatId)'), label + '：wait:false 不得即时清 job（否则静止证明漏判）')
    assert.ok(out.includes('finally { if (jobs.get(chatId) === job) { jobs.delete(chatId); if (!disposed) onIdle(chatId) } }'), label + '：onIdle 必须在 onSettled 之后的收尾里释放')
    assert.equal(applySettlementQuiescenceTransform(out), out, label + '：复跑必须幂等')
  }
  // 缺新也缺旧 ⇒ 响亮拒（不猜布局）
  assert.throws(() => applySettlementQuiescenceTransform(NEW_RAW.replace('{ start, pending, cancel, dispose }', '{ start, cancel }')), /未命中\/不唯一/, '两种布局都不在时必须拒')

  // ② 运行时合同（新布局产物）
  const sandbox = evaluate(applySettlementQuiescenceTransform(NEW_RAW))
  let release, settledCount = 0
  const jobs = sandbox.createSettlementJobs({
    run: async () => { await new Promise(resolve => { release = resolve }) },
    onSettled: async () => { settledCount++ },
  })
  const first = jobs.start('chat-1')
  await tick()
  assert.equal(jobs.isBusy('chat-1'), true, '运行中必须 busy')
  const pending = jobs.pending('chat-1')
  assert.ok(pending && typeof pending.then === 'function', 'pending 必须可消费（返回 promise）')
  assert.equal(await jobs.cancel('chat-1', { wait: false }), true, 'wait:false 取消必须命中运行中的作业')
  assert.equal(jobs.isBusy('chat-1'), true, 'wait:false 后仍必须 busy（直到 promise/onSettled 收尾）')
  release()
  await pending
  await first.catch(() => {})
  await tick()
  assert.equal(jobs.isBusy('chat-1'), false, '收尾后必须释放')
  assert.equal(settledCount, 0, '被取消的作业不得再发布 onSettled')
  assert.deepEqual(sandbox.__idle, ['chat-1'], 'onIdle 必须恰释放一次且带 chatId')
  assert.equal(jobs.pending('chat-1'), null, '无作业时 pending 必须为 null')
  // 正常完成路径：onSettled 一次 + onIdle 再恰一次
  const second = jobs.start('chat-2')
  await tick()
  release()
  await second
  await tick()
  assert.equal(settledCount, 1, '未取消的作业必须发布一次 onSettled')
  assert.deepEqual(sandbox.__idle, ['chat-1', 'chat-2'], '每个作业收尾各释放一次 onIdle')
})
