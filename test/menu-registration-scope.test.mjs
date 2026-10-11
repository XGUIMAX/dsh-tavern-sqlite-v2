// 真作者模块完整词法作用域：不造getter、不往global注入ctx，实际渲染register→dock→more→rollback。
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { parse } from '../lib/vendor/acorn/acorn.mjs'
import { clientCoreWrites } from '../deploy/client-seams.mjs'

const author = new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/', import.meta.url)
// 只走**真实生产链**取产物（clientCoreWrites 缺省即真实 fs 读有限 client 程序），不手工 dedent/拼变换；
// 一次共享，供 source/built 两叶按相对路径取用。
const writes = clientCoreWrites(fileURLToPath(new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/', import.meta.url)))
function feature(text) {
  const matches = []
  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'createPlayControlsFeatureModule') matches.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') walk(value)
    }
  }
  walk(parse(text, { ecmaVersion: 'latest', sourceType: 'module' }))
  assert.equal(matches.length, 1, '完整真实factory必须唯一')
  return text.slice(matches[0].start, matches[0].end)
}
function elementNamed(tree, name) {
  if (!tree || typeof tree !== 'object') return null
  if (tree.type?.name === name) return tree
  for (const child of tree.children || []) {
    const found = elementNamed(child, name)
    if (found) return found
  }
  return null
}
const target = { chatId: 'chat-synthetic', sessionId: 'session-synthetic', kind: 'native-only', turn: 7, endSeq: 9, eventCount: 10 }
function registerAndRender(source, service, ordinary = false, expectOld = false) {
  const registrations = new Map(), errors = [], calls = { get: 0, rpc: 0, wait: 0 }
  const React = {
    Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: value => [value, () => {}], useRef: current => ({ current }),
    useEffect() {}, useLayoutEffect() {}, useMemo: fn => fn(), useCallback: fn => fn,
  }
  const view = { canRollback: true, canClearIncompleteReply: !ordinary, rollbackTargetTurn: 7, failureTarget: target }
  const realm = vm.createContext({
    React, console, createTurnHistoryProjection: () => ({ rolledBack() {} }),
    window: { __ModuleLoader__: { load() {} } }, // built 布局的 factory 外壳引用 window（仅边界，不参与菜单接线）
    createBackgroundSuppressionPoller: () => () => {}, // factory 顶层立即引用的作者内部 helper（仅边界 stub，不参与菜单接线）
    TavernPluginComposerActions: () => null, // 同上：factory 立即引用的同文件组件，仅边界
    createTavernFrameSlashExecutor: () => () => {}, useTavernSessionMode: () => 'play', isPlayMode: () => true,
    latestTavernAssistantMessageId: () => null, useLiveTavernView: () => ({ view }), useRegenPanel: () => null,
    useTavernCoordination: () => ({ view: {} }), describeTavernActivity: () => ({ busy: false }),
    setCandidatePanel() {}, setRegenPanel() {}, setCandidateGuidePanel() {},
    liveTavernView: { invalidate() {}, rebase() {}, refresh() {} }, tavernCoordination: { invalidate() {} },
    tavernErrorHub: { report: (label, error) => errors.push({ label, error }) },
    notifyTavernDataChanged() {}, rpc: async () => { calls.rpc++; return { view: { rolledBack: { sync: {} } } } },
  })
  assert.equal(vm.runInContext('typeof ctx', realm), 'undefined', '无global ctx，不能掩盖作用域缺陷')
  const module = vm.runInContext('(' + source + ')()', realm)
  const sessions = { subagentAddress: () => undefined, waitForTavernRollbackSync: async () => { calls.wait++ } }
  const slots = { inject: (_name, supply) => supply(), register: (definition, render) => { registrations.set(definition.id, render); return () => {} } }
  const ctx = {
    sessions, slots, betterSidebar: { registerTab: () => () => {} },
    effect: effect => effect(), remote: { commands: { execute() {} } },
    get(name) { if (name === 'tavernStorageUi') { calls.get++; return service } },
  }
  module.register({ ctx, slots })
  const dockRender = registrations.get('dsh-tavern-candidate-actions')
  assert.equal(typeof dockRender, 'function')
  const dock = dockRender({ sessionId: target.sessionId, useChat: () => null, useSession: () => false })
  assert.equal(dock.type.name, 'CandidateDockActions')
  const more = elementNamed(dock.type(dock.props), 'TavernMoreActions')
  assert.ok(more, '必须实际渲染dock到more')
  const rollback = elementNamed(more.type(more.props), 'TavernRollbackAction')
  assert.ok(rollback, '必须实际渲染more到rollback')
  // 旧(0.4.4)反证形态里 dock 不注入 getter ⇒ 透传后该 props 本就为 undefined，不主张同引用相等；
  // 但"取用函数必须是函数"这条在 source/new 与旧形态都成立（旧形态由点击后的 ReferenceError 兜住）。
  if (!expectOld) assert.equal(rollback.props.storageUi, dock.props.storageUi, '合法getter经同一props透传')
  assert.equal(typeof rollback.props.storageUi, 'function')
  const button = rollback.type(rollback.props)
  assert.equal(typeof button.props.onClick, 'function', '使用完整真实组件内callback')
  return { click: button.props.onClick, errors, calls }
}

for (const [layout, rel] of [['source', 'src/client/features/play-controls.js'], ['built', 'lib/client.js']]) {
  test('菜单真实注册scope ' + layout + '：完整组件链成功/缺服务/抛错与普通分支无需共享服务', async () => {
    // 真实生产链产物（clientCoreWrites 已含全部前置缝），按 layout 取 source / built 相对路径
    const next = feature(writes.get('tavern-plugin/' + rel))
    for (const mode of ['success', 'missing', 'throws']) {
      let delegated = 0
      const failure = new Error('共享清理synthetic失败')
      const service = mode === 'missing' ? undefined : { async cleanFailure(sessionId, turn, ft) {
        delegated++
        assert.equal(sessionId, target.sessionId)
        assert.equal(turn, target.turn)
        assert.deepEqual(JSON.parse(JSON.stringify(ft)), target)
        if (mode === 'throws') throw failure
        return { view: { rolledBack: { alreadyClean: true, cleanedFailureTarget: target } } }
      } }
      const probe = registerAndRender(next, service)
      await probe.click()
      assert.equal(probe.calls.get, 1, mode + '必须由register闭包实际取服务')
      assert.equal(probe.calls.rpc, 0, '清理不走第二套RPC')
      assert.equal(probe.calls.wait, 0, '菜单不重复wait')
      assert.equal(delegated, mode === 'missing' ? 0 : 1)
      assert.equal(probe.errors.length, mode === 'success' ? 0 : 1)
      if (mode === 'missing') assert.match(String(probe.errors[0].error), /找不到共享 tavernStorageUi/)
      if (mode === 'throws') assert.equal(probe.errors[0].error, failure)
    }
    const normal = registerAndRender(next, undefined, true)
    await normal.click()
    assert.equal(normal.calls.get, 0, '普通回退无共享服务读取')
    assert.equal(normal.calls.rpc, 1)
    assert.equal(normal.calls.wait, 1)
    assert.equal(normal.errors.length, 0)
    // 用此前044的真实错误接线形态反证此叶能发现ReferenceError，不能只测callback。
    const old = next.replace('React.createElement(CandidateDockActions, Object.assign({}, props, { storageUi: function () { return ctx.get("tavernStorageUi") },', 'React.createElement(CandidateDockActions, Object.assign({}, props, {')
      .replace('React.createElement(TavernRollbackAction, props)', 'React.createElement(TavernRollbackAction, Object.assign({}, props, { storageUi: function () { return ctx.get("tavernStorageUi") } }))')
    // 该 getter 只在 callback（点击）时才求值 ⇒ 必须真点击后断言错误，不能 assert.throws(render)
    const oldProbe = registerAndRender(old, { cleanFailure() {} }, false, true)
    await oldProbe.click()
    assert.equal(oldProbe.errors.length, 1, '旧作用域错误必须在点击时暴露一次')
    assert.match(String(oldProbe.errors[0] && oldProbe.errors[0].error && oldProbe.errors[0].error.message), /ctx is not defined/, '旧接线必须报 ctx is not defined（自由变量）')
  })
}
