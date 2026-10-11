// S4单一薄入口：22项独立结果共用一次真实施缝文本，场景DB/deps保持隔离。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createNativeS4Prepare, nativeS4Metrics } from './support/native-s4-prepare.mjs'
import { isNativeDataApplied } from '../deploy/native-data-transform.mjs'
import { AUTHOR_VERSION } from '../lib/standard-host.js'

const { seamSource } = createNativeS4Prepare({
  index: 'tavern-plugin/lib/index.js', authorVersion: AUTHOR_VERSION, isNativeDataApplied,
  registerCleanup: cleanup => test.after(cleanup), label: 'S4共同准备',
})
const pending = new Map()
let hook
function setupResolver() {
  if (hook) return
  const requireFixture = createRequire(new URL('../../../tools/sql-test-kit/package.json', import.meta.url))
  hook = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL?.includes('/release-034-20261008/author-fixture/')
        || specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('data:')) throw error
      return next(pathToFileURL(requireFixture.resolve(specifier)).href, context)
    }
  } })
}
const registrations = {
  "story": [
    "S4 storyContext命中真store窗口且不回落完整档",
    "S4 真store出口readStoryInput契约与作者scoped楼层对齐",
    "S4 storyContext未命中时显式回落完整档",
    "S4 hookChatForSession首钩整档与两次重试语义保持",
    "S4 两链不再直连boundedHistory且normalizeChat就地等价"
  ],
  "template": [
    "S4模板reader级委托恰一次且返回值原样透传",
    "S4模板reader出口缺失时装配期响亮失败",
    "S4模板reader的links与access票据由宿主闭包透传",
    "S4模板reader的historyFrom闭包与真库窗口透传",
    "S4模板真出口直连全链贯通"
  ],
  "candidate": [
    "S4候选上下文命中原生出口且不直连作者宽读",
    "S4候选上下文出口未命中时作者readChat兜底",
    "S4候选上下文出口缺失或形状非法时响亮失败",
    "S4候选上下文作者适用性门槛仍在reader内",
    "S4候选上下文消费点拿到真库chat",
    "S4候选真出口直连全链贯通"
  ],
  "settlement": [
    "S4结算取数命中原生出口且传入宿主世界书深度",
    "S4结算取数fallback显式回作者readChat",
    "S4结算取数出口缺失或形状非法时响亮失败",
    "S4结算取数不再直连作者宽读参数",
    "S4结算取数value来自真库chat",
    "S4结算真出口直连全链贯通"
  ]
}
async function callbacks(group) {
  if (!pending.has(group)) pending.set(group, (async () => {
    setupResolver()
    const module = await import('./support/native-' + group + '-host.mjs')
    const collect = new Map()
    const register = (name, callback) => {
      assert.equal(collect.has(name), false, '不许重复注册同名S4结果')
      collect.set(name, callback)
    }
    await module['register' + group[0].toUpperCase() + group.slice(1) + 'Tests'](register, seamSource)
    assert.deepEqual([...collect.keys()], registrations[group], '注册名与原领域逐字一致')
    return collect
  })())
  return pending.get(group)
}
for (const [group, names] of Object.entries(registrations)) {
  for (const name of names) test(name, async t => {
    const available = await callbacks(group)
    return available.get(name)(t)
  })
}
test.after(t => {
  hook?.deregister()
  assert.ok(nativeS4Metrics.preparations <= 1, '整组只能真实准备一次，失败也不得重跑')
  t.diagnostic('S4准备计数：' + JSON.stringify(nativeS4Metrics))
})
test('S4文件收尾：未选业务不准备且可撤解析钩子', () => {
  assert.ok(nativeS4Metrics.preparations <= 1, '文件收尾不能新增业务施工')
  setupResolver()
  assert.ok(hook, '真实解析钩子已注册')
  hook.deregister()
  hook = undefined
})
