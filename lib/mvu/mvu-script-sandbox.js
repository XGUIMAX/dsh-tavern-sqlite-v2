// MVU 卡脚本服务端沙箱（第二阶段 M2）—— **兼容垫片**
//
// ⚠ 2026-10-13：本文件原先自带一套 `vm.createContext(sandbox)`（旧 :6-15/:58-96/:96），把
//   `globalThis.crypto`（旧 :87）与宿主 hostApi 函数/对象（旧 :60 `...(hostApi || {})`）
//   **裸穿**进 context realm，且旧 :96 未设 `codeGeneration`。那条路径是真实的 realm 逃逸面，
//   **不能只靠 @deprecated 留洞** ⇒ 旧公开 API 一律**委托现役 `createCardScriptRuntime`**，
//   由它统一做 toContext 包装 / constructor 遮蔽 / codeGeneration 关闭 / 定时器与预算受控。
//   本文件**不再自建 vm**：没有第二套沙箱实现，就不会再有第二套逃逸面。
//
// 实例语义：**每次调用都新建**（直接 `createCardScriptRuntime`，不经 `getOrCreateRuntime`）。
//   旧实现每次 `createScriptRuntime` 都是全新 context；用按 cardPath 缓存的 `getOrCreateRuntime`
//   会让**同一 scriptId 的两次调用共用同一个 vm 上下文**（闭包/变量状态跨会话串档）——那正是
//   `mvu-card-runtime.js` 文件头第 2 条禁止的。这里不做任何实例缓存/复用。
//
// 定时器接管（2026-10-13 更正，此前写成"ceiling=0 就管不了 dispose"是**不实**的）：
//   现役运行时的**所有** timer handle（短/长延迟、`setInterval`、RAF）都经 `trackTimer` 登记进同一个
//   `timers` Map，`dispose()` 遍历该 Map 逐个 `clearTimeout/clearInterval` 后才 `timers.clear()`
//   ⇒ **ceiling 与 dispose 能否清定时器无关**；`timerCeilingMs` 只控制两件事：①短延迟是否进"待办表"
//   （`pendingTasks`，决定 `drainPendingTasks` 是否 join 它）②回执里的 `clearedTimers` 计数来源仍是被清
//   的 handle 总数（与 ceiling 无关）。这里保留 `timerCeilingMs = 3000` 的**唯一理由**是旧兼容采用
//   V1 sticky 的**预算**（ceiling 内的短延迟可被 drain join，与旧垫片"短定时器会被等等看"的观感一致）；
//   它**不是** dispose 正确性的前提，改成 0 也不会漏清定时器。
//
// 旧实现把 `setTimeout/setInterval/RAF` 回调直接交给宿主定时器，`dispose()` 只清数组（旧 :133-137）。
//   现役运行时不但清 handle，还在 dispose 后拒绝新回调 ⇒ 这一项是**收紧**，不是靠 ceiling 换来的。
//
// 兼容合同（公开导出面不变：`createScriptRuntime`、`bridgeServerEvents`；package.json exports
// "./mvu-script-sandbox" 仍指向本文件）：
//   createScriptRuntime({ scriptId, sources, hostApi, timeoutMs?, logger? }) → {
//     scriptId, events, errors, compiled, timeoutMs, dispatchEvent(event, ...args), dispose() }
//   · scriptId   ：调用方原值（字符串化）
//   · events     ：`[{ event, handler, source }]`（`source` 为**新增**字段，旧版无）
//   · errors     ：加载期错误 `[{ source, error, domProbe? }]`（现役形状；旧版 `error` 已是字符串化）
//   · compiled   ：由 `runtime.sources` **映射** —— `[{ name, ok, error }]`，`error` 为字符串或 null
//   · timeoutMs  ：现役运行时的生效值
//   · dispose()  ：释放现役运行时；**dispose 后 `events`/`errors`/`compiled` 一律为空数组**（旧可见合同）
//
// ⚠ **相对旧合同的新增（不得当成旧行为）**：
//   1. `dispatchEvent` **现在有回执**：返回现役 outcome 对象
//      `{ ok, event, strict, args, results, committed, startedAt, finishedAt, error }`
//      —— 旧实现返回 `undefined`（void）。**非 strict 的"吞异常、不向调用方抛、逐钩子隔离"保留**，
//      但**记账级别由现役运行时决定**：钩子异常记到 `logger.error`（旧垫片记 `logger.warn`）；
//      本垫片只把调用方 logger 原样转交，不改级别、也不吞掉记账。已释放时返回 `undefined`（不伪造 outcome）。
//   2. `dispose()` **现在有回执**：返回现役释放回执
//      `{ alreadyDisposed, clearedTimers, cancelledBudgets, closedPending }` —— 旧实现返回 `undefined`（void）。
//   3. 新增只读 `sandbox` getter（现役受控脚本 global 视图）—— 旧版没有该字段。
//   4. 不再自建 `Promise.race` 钩子超时（由现役 hookBudget 承担）；**不新增**"等待待办/续命"之类
//      旧版没有的能力（`runtimeApi` 上的 drainPendingTasks 等**不在**本垫片导出面上）。
import { createCardScriptRuntime } from './mvu-card-runtime.js'

const DEFAULT_TIMEOUT_MS = 5000
/**
 * 兼容采用 V1 sticky 的**预算**值：ceiling 内的短延迟进现役待办表（可被 `drainPendingTasks` join）。
 * ⚠ 它**不**决定 dispose 能否清定时器（所有 handle 都登记在 `timers`，dispose 一律清），也不要
 * 当成"必须设 3000 才正确"；改 0 只影响 drain 是否 join 短延迟。
 */
const COMPAT_TIMER_CEILING_MS = 3000

const text = value => (typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value)))

/** `runtime.sources` → 旧 `compiled` 形状（`{name, ok, error}`；`error` 字符串或 null）。 */
function toCompiled(runtime, sources, fallbackKey) {
  const rows = Array.isArray(runtime?.sources) ? runtime.sources : []
  return sources.map((src, index) => {
    const row = rows[index] ?? {}
    const name = text(row.name) || text(src?.name) || fallbackKey + ':script'
    return { name, ok: row.ok === true, error: row.ok === true ? null : text(row.error ?? '脚本执行失败') }
  })
}

/**
 * 旧公开 API：创建卡脚本运行时（**委托**现役 `createCardScriptRuntime`）；每次调用都是**新实例**。
 *
 * @deprecated 现役替代 = `mvu-card-runtime.js` 的 `createCardScriptRuntime`（配套 `server-execution`；
 *   in-process / worker 由 `lib/mvu/vm-capability.js` 按能力选路）。本函数仅作旧签名/旧可见字段的
 *   兼容垫片保留：**不再自建 vm**，实现全部转交现役运行时；新代码请直接用现役入口，勿新增消费者。
 *
 * @param {{scriptId?:string, sources?:Array<{name?:string,code?:string}>, hostApi?:object,
 *          timeoutMs?:number, logger?:object}} options
 * @returns {{scriptId:string, events:Array, errors:Array, compiled:Array, sandbox:object|undefined,
 *           timeoutMs:number, dispatchEvent:(event:string, ...args:any[])=>Promise<object|undefined>,
 *           dispose:()=>object}}
 */
export function createScriptRuntime({ scriptId, sources, hostApi, timeoutMs = DEFAULT_TIMEOUT_MS, logger = console } = {}) {
  const scriptIdText = text(scriptId)
  const sourceList = Array.isArray(sources) ? sources : (sources ? [...sources] : [])
  const runtime = createCardScriptRuntime({
    cardPath: scriptIdText,
    sources: sourceList,
    hostApi: hostApi || {},
    timeoutMs,
    logger,
    timerCeilingMs: COMPAT_TIMER_CEILING_MS,
    timerCountMax: 256,
  })
  let disposed = false

  return {
    scriptId: scriptIdText,
    get events() { return disposed ? [] : (Array.isArray(runtime.events) ? runtime.events : []) },
    get errors() { return disposed ? [] : (Array.isArray(runtime.errors) ? runtime.errors : []) },
    // dispose 后不得再映射 sourceList（否则会凭实例残留的 sources 行报出失败条目，违背"清空数组"旧合同）。
    get compiled() { return disposed ? [] : toCompiled(runtime, sourceList, scriptIdText || '(unnamed)') },
    /** 现役运行时的受控脚本 global 视图（新增只读回读位；写入仍经 toContext，不是裸宿主对象）。 */
    get sandbox() { return disposed ? undefined : runtime.sandbox },
    timeoutMs: runtime.timeoutMs ?? timeoutMs,
    /**
     * 触发本 runtime 的某事件钩子。非 strict：**不向调用方抛**，逐钩子失败隔离并交调用方 logger 记账
     * （级别由现役运行时决定，当前为 `logger.error`；旧垫片为 `logger.warn`）。
     * 已释放：告警并返回 `undefined`（不伪造 outcome）。
     * 返回值是**新增回执**（旧实现 void），见文件头"相对旧合同的新增"第 1 条。
     */
    async dispatchEvent(event, ...args) {
      const name = text(event)
      if (disposed || runtime.disposed === true) {
        try { logger?.warn?.(`[mvu-sandbox] 运行已释放，忽略派发 ${scriptIdText}/${name}`) } catch {}
        return undefined
      }
      return await runtime.dispatchEvent(name, ...args)
    },
    /**
     * 释放：清定时器/在飞预算/待办（现役 dispose 清的是 `timers` Map 里的**全部** handle，与本垫片
     * 传入的 `timerCeilingMs` 无关）；随后 `events`/`errors`/`compiled` 一律空数组（旧可见合同）。
     * 返回值是**新增回执**（旧实现 void），见文件头"相对旧合同的新增"第 2 条。
     */
    dispose() {
      if (disposed) return { alreadyDisposed: true, clearedTimers: 0, cancelledBudgets: 0, closedPending: 0 }
      disposed = true
      return typeof runtime.dispose === 'function'
        ? runtime.dispose()
        : { alreadyDisposed: false, clearedTimers: 0, cancelledBudgets: 0, closedPending: 0 }
    },
  }
}

/**
 * 创建多个 runtime 的事件桥：服务端事件 → 各 runtime 的同名钩子。
 * 兼容保留：**不改监听协议**（沿用 `for...of serverEvents` + `serverEvents.on(event, handler)`，
 * 逐 runtime `try/catch` 隔离失败，返回值仍为 `undefined`）。
 */
export function bridgeServerEvents(serverEvents, runtimes) {
  for (const event of serverEvents) {
    serverEvents.on(event, async (...args) => {
      for (const rt of runtimes) {
        try { await rt.dispatchEvent(event, ...args) } catch { /* 钩子异常已逐个记录 */ }
      }
    })
  }
}
