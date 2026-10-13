// 卡脚本宿主 API 的跨线程调用原语。
//
// 语义目标（与进程内实现**逐字对齐**）：宿主 API 分两种形态——
//   · 同步返回（`getvar` 这类读）：脚本必须立刻拿到值；
//   · 返回 Promise（`replaceVariables` 这类写）：**同步前缀**（到第一个 await 之前）仍须在
//     脚本下一条语句前跑完，异步尾部稍后结算。
// 因此这里不按成员硬编码，而按**每次调用的实际返回形态**自适应：
//   1) Worker 把请求写进共享环的某个槽，postMessage 通知宿主，然后 `Atomics.wait` 阻塞；
//   2) 宿主在事件循环里同步调用宿主函数：
//      · 返回值不是 thenable ⇒ 立刻写回该槽 ＋ notify（Worker 拿到值，同步语义保住）；
//      · 返回值是 thenable   ⇒ 同步前缀已执行完，回一张 ticket；异步尾部完成后再 postMessage
//        通知 Worker（Worker 侧代理的 Promise 届时才 resolve）。
//
// ── 协议（2026-10-13 重构：单槽 → 多槽配对）────────────────────────────────
// 旧单槽的失效模式：响应与新请求共用同一块 payload，迟到响应会覆盖下一个请求的载荷；
// Worker 超时后继续复用同一槽，永远无法证明读到的是**本次**请求的响应。
// 现在：
//   · **默认单槽**（`slotCount` 可调）：请求按 seq 轮流占槽，构造器一次性
//     分配「控制区 + N×(槽头+载荷)」。安全性来自配对、回显与作废，不依赖多槽。
//   · **请求序号写入槽头**（`S_SEQ`），响应把同一个序号写进**独立的响应回显字段**
//     （`S_RESP_SEQ`）；Worker 只接受「槽序号 === 本次请求号」**且**「回显号 === 本次请求号」的
//     响应，任一不等即协议错响亮失败（不猜、不采信）。
//   · **hostcall 与槽配对**：通知消息必须带 `{seq, slot}`，且宿主校验该槽处于 REQUEST 且
//     `S_SEQ === seq`；不配对（迟到/重复/伪造）**一律不执行宿主 API**，只记 `C_SPURIOUS` 计数。
//   · **请求被"消费"**：配对成功后槽立刻转 SERVING ⇒ 同一 seq 的第二次 hostcall 必然被拒，
//     API 不会被重复执行。
//   · **迟到响应不污染下一请求**的必要条件（三条合起来才充分，**不是**靠槽数）：
//     ① 写响应前校验槽仍持有本次请求（`S_SEQ === seq`）且状态仍是 SERVING；
//     ② 响应带独立回显号，Worker 侧回程校验；
//     ③ 同步超时/协议错 ⇒ **通道作废且不重用**（置 `C_INVALID`、唤醒阻塞等待、拒绝在飞 ticket、
//        之后一切 `call()` 响亮失败）。
//     `slotCount > 1` 只是**可选**的槽轮转（降低槽复用频率），默认 1 槽；它对上述安全性既非
//     必要也非充分，不得当成安全论证。
//   · **等待有界且不 busy spin**：单次调用只有一个 deadline；被通知唤醒（含虚假/重复通知）
//     只累计消耗该 deadline，超过 `MAX_WAIT_RECHECKS` 次即协议错；宿主作废通道时会 notify
//     唤醒阻塞中的等待，Worker 在循环里先读 `C_INVALID`。
//   · **长度校验双向**：宿主读请求、Worker 读响应都校验 `0 ≤ length ≤ payloadBytes`。
//   · **序号空间 fail-closed**：请求号与 ticket 号都是 int32 槽位，超出 `MAX_REQUEST_SEQ`
//     一律拒绝（绝不 writearound 成负数后被误当成合法序号）。
//   · **ticket 带请求序号**：结算消息带 `{id, ticket, seq, slot}`，Worker 侧序号不匹配即拒结算，
//     错配累计超过 `MAX_TICKET_MISPAIRS` 次则作废通道；不可克隆/发送失败的 ticket 结果改发
//     失败 ticket，绝不在宿主里造出 unhandledRejection。
//
// 死锁护栏：宿主**永远不阻塞**（不调用 Atomics.wait）；Worker 的等待带超时，超时即响亮失败
// （宿主 bug/死锁时不会静默挂死）。
import { Buffer } from 'node:buffer'
import v8 from 'node:v8'

const CONTROL_INTS = 16
const CONTROL_BYTES = CONTROL_INTS * 4
const SLOT_INTS = 16
const SLOT_BYTES = SLOT_INTS * 4

// 协议 ABI（导出仅供**诊断与负例测试**构造/检视原始槽；生产代码一律走 createHostChannel/
// createWorkerChannel 的配对接口，不得直接读写这些偏移）。
export const CONTROL_BYTES_EXPORT = CONTROL_BYTES
export const SLOT_INTS_EXPORT = SLOT_INTS
export const SLOT_BYTES_EXPORT = SLOT_BYTES
export const SLOT_INDEX_SEQ = 0
export const SLOT_INDEX_STATE = 1
export const SLOT_INDEX_LENGTH = 2
export const SLOT_INDEX_TICKET = 3
/** 响应独立回显的请求号（与 `SLOT_INDEX_SEQ` 分离：请求号由 Worker 写，回显号由宿主写）。 */
export const SLOT_INDEX_RESP_SEQ = 4

/** 共享槽布局版本：不匹配即响亮失败（旧单槽 SAB 不会被误按新协议读写）。 */
export const LAYOUT_VERSION = 2

/** 控制区槽位（所有槽共用） */
const C_VERSION = 0
const C_INVALID = 1
const C_SLOT_COUNT = 2
const C_PAYLOAD = 3
const C_SPURIOUS = 4
const C_MISPAIRED = 5

/** 每槽头部槽位 */
const S_SEQ = 0
const S_STATE = 1
const S_LENGTH = 2
const S_TICKET = 3
const S_RESP_SEQ = SLOT_INDEX_RESP_SEQ

/** 状态值：IDLE=空闲可复用；REQUEST=Worker 已发布请求；SERVING=宿主已消费、正在执行；
 *  VALUE/TICKET/ERROR=终态响应（均带独立回显号 S_RESP_SEQ）。 */
export const STATE_IDLE = 0
export const STATE_REQUEST = 1
export const STATE_SERVING = 2
export const STATE_VALUE = 3
export const STATE_TICKET = 4
export const STATE_ERROR = 5

/** 请求/响应载荷容量缺省 8 MiB（**每槽**）：同步返回值（单楼变量树等）远小于此；超限**响亮失败**，不静默截断。 */
export const DEFAULT_PAYLOAD_BYTES = 8 * 1024 * 1024
/** 槽数默认 **1**（单槽 8 MiB，最小协议即可）：安全性来自「配对 + 响应回显 + 超时作废不重用」，
 *  不来自槽数；`slotCount > 1` 仅是可选的槽轮转（多占 (N-1)×payload 内存），不是安全前提。 */
export const DEFAULT_SLOT_COUNT = 1
export const MIN_SLOT_COUNT = 1
export const MAX_SLOT_COUNT = 8
const MIN_PAYLOAD_BYTES = 64 * 1024

/** 单次同步调用内允许被通知唤醒的次数上限（虚假/重复通知累计到上限即协议错，不无限重等）。 */
export const MAX_WAIT_RECHECKS = 64
/** 同一通道允许的 ticket 错配次数（超出即作废通道）。 */
export const MAX_TICKET_MISPAIRS = 2
/** 请求号/ticket 号是 int32 槽位：超过此值必须 fail-closed（否则 Atomics.store 会写回负数）。 */
export const MAX_REQUEST_SEQ = 0x7fffffff
const isValidSeq = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_REQUEST_SEQ

export const IPC_ERRORS = {
  timeout: 'RUNTIME_IPC_TIMEOUT',
  oversize: 'RUNTIME_IPC_OVERSIZE',
  protocol: 'RUNTIME_IPC_PROTOCOL',
  invalid: 'RUNTIME_IPC_INVALID',
  unpaired: 'RUNTIME_IPC_UNPAIRED',
}

export function ipcFail(code, message) {
  return Object.assign(new Error(`[runtime-ipc] ${message}`), { code })
}

function assertSlotCount(slotCount) {
  if (!Number.isInteger(slotCount) || slotCount < MIN_SLOT_COUNT || slotCount > MAX_SLOT_COUNT) {
    throw ipcFail(IPC_ERRORS.protocol, `共享环槽数必须是 ${MIN_SLOT_COUNT}..${MAX_SLOT_COUNT} 的整数：${slotCount}`)
  }
  return slotCount
}

function assertPayloadBytes(payloadBytes) {
  if (!Number.isInteger(payloadBytes) || payloadBytes < MIN_PAYLOAD_BYTES) {
    throw ipcFail(IPC_ERRORS.protocol, `载荷容量不合理：${payloadBytes}`)
  }
  return payloadBytes
}

function layoutOf(sab) {
  if (!(sab instanceof SharedArrayBuffer)) throw ipcFail(IPC_ERRORS.protocol, '通道需要 SharedArrayBuffer')
  const control = new Int32Array(sab, 0, CONTROL_INTS)
  const version = Atomics.load(control, C_VERSION)
  if (version !== LAYOUT_VERSION) {
    throw ipcFail(IPC_ERRORS.protocol, `共享环布局版本不匹配（${version} != ${LAYOUT_VERSION}）：旧单槽 SAB 不得按新协议使用`)
  }
  const slotCount = assertSlotCount(Atomics.load(control, C_SLOT_COUNT))
  const payloadBytes = assertPayloadBytes(Atomics.load(control, C_PAYLOAD))
  if (sab.byteLength < CONTROL_BYTES + slotCount * (SLOT_BYTES + payloadBytes)) {
    throw ipcFail(IPC_ERRORS.protocol, `共享环尺寸不足：${sab.byteLength} < ${CONTROL_BYTES + slotCount * (SLOT_BYTES + payloadBytes)}`)
  }
  return { control, slotCount, payloadBytes }
}

function slotView(sab, layout, slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= layout.slotCount) {
    throw ipcFail(IPC_ERRORS.protocol, `非法槽号：${slot}`)
  }
  const base = CONTROL_BYTES + slot * (SLOT_BYTES + layout.payloadBytes)
  return { header: new Int32Array(sab, base, SLOT_INTS), payload: new Uint8Array(sab, base + SLOT_BYTES, layout.payloadBytes) }
}

/** 新建共享环（宿主侧创建，传给 Worker）。 */
export function createSharedRing({ payloadBytes = DEFAULT_PAYLOAD_BYTES, slotCount = DEFAULT_SLOT_COUNT } = {}) {
  assertPayloadBytes(payloadBytes)
  assertSlotCount(slotCount)
  const sab = new SharedArrayBuffer(CONTROL_BYTES + slotCount * (SLOT_BYTES + payloadBytes))
  const control = new Int32Array(sab, 0, CONTROL_INTS)
  Atomics.store(control, C_VERSION, LAYOUT_VERSION)
  Atomics.store(control, C_SLOT_COUNT, slotCount)
  Atomics.store(control, C_PAYLOAD, payloadBytes)
  return sab
}

/** 旧名兼容：`createSharedSlot(payloadBytes)` 现在返回**多槽环**（默认 2 槽）。 */
export function createSharedSlot(payloadBytes = DEFAULT_PAYLOAD_BYTES, slotCount = DEFAULT_SLOT_COUNT) {
  return createSharedRing({ payloadBytes, slotCount })
}

/** 诊断/测试用：只读快照（不含任何写入）。 */
export function inspectChannel(sab) {
  const layout = layoutOf(sab)
  const slots = []
  for (let slot = 0; slot < layout.slotCount; slot += 1) {
    const { header } = slotView(sab, layout, slot)
    slots.push({
      slot,
      seq: Atomics.load(header, S_SEQ),
      state: Atomics.load(header, S_STATE),
      length: Atomics.load(header, S_LENGTH),
      ticket: Atomics.load(header, S_TICKET),
      respSeq: Atomics.load(header, S_RESP_SEQ),
    })
  }
  return {
    version: Atomics.load(layout.control, C_VERSION),
    invalid: Atomics.load(layout.control, C_INVALID) === 1,
    spurious: Atomics.load(layout.control, C_SPURIOUS),
    mispaired: Atomics.load(layout.control, C_MISPAIRED),
    slotCount: layout.slotCount,
    payloadBytes: layout.payloadBytes,
    slots,
  }
}

/** 值编码：v8.serialize（保真度高于 JSON，支持 Date/Map/二进制等；函数仍不可跨线程，按错误响亮失败） */
export function encodeValue(value) {
  try {
    return v8.serialize(value)
  } catch (error) {
    throw ipcFail(IPC_ERRORS.protocol, '同步返回值无法跨线程编码（含函数/句柄等）：' + (error && error.message))
  }
}

export function decodeValue(bytes) {
  return v8.deserialize(Buffer.from(bytes.buffer ? bytes : Buffer.from(bytes)))
}

/** 错误编码（跨线程只传身份与文本，不传栈对象） */
export function encodeError(error) {
  return {
    name: String((error && error.name) || 'Error'),
    message: String((error && error.message) || error || '未知错误'),
    code: (error && error.code) || undefined,
    stack: typeof (error && error.stack) === 'string' ? String(error.stack).split('\n').slice(0, 6).join('\n') : undefined,
  }
}

// ─────────────── 共享活动计数（唯一实现：宿主 wrapGenerateRaw 与 Worker hookBudget 同源）───────────────
// 要求：① 原子 add/sub（不能是 get-then-set 的陈旧 RMW）；② 保留 plain `{pending}` 对象兼容；
//      ③ 不要在多个文件里各写一份计数器实现。
const ACTIVITY_ADD = Symbol.for('dsh.tavern.activity.add')
const ACTIVITY_SUB = Symbol.for('dsh.tavern.activity.sub')

/** 以 SharedArrayBuffer(4) 为后端的原子计数器（可直接当 plain `{pending}` 对象用）。 */
export function createActivityCounter(sab = new SharedArrayBuffer(4)) {
  if (!(sab instanceof SharedArrayBuffer) || sab.byteLength < 4) {
    throw ipcFail(IPC_ERRORS.protocol, '活动计数需要 ≥4 字节 SharedArrayBuffer')
  }
  const view = new Int32Array(sab, 0, 1)
  const counter = {
    get pending() { return Atomics.load(view, 0) },
    set pending(value) { Atomics.store(view, 0, Math.max(0, Math.trunc(Number(value) || 0))) },
  }
  const add = delta => {
    const amount = Math.trunc(Number(delta) || 0)
    return Atomics.add(view, 0, amount) + amount
  }
  const sub = value => {
    const amount = Math.trunc(Number(value) || 0)
    for (;;) {
      const current = Atomics.load(view, 0)
      const next = Math.max(0, current - amount)
      if (Atomics.compareExchange(view, 0, current, next) === current) return next
    }
  }
  Object.defineProperty(counter, ACTIVITY_ADD, { value: add, configurable: true })
  Object.defineProperty(counter, ACTIVITY_SUB, { value: sub, configurable: true })
  // 兼容既有调用方使用的 `add`/`sub` 方法名（同一实现，不重复定义计数逻辑）
  Object.defineProperty(counter, 'add', { value: add, configurable: true })
  Object.defineProperty(counter, 'sub', { value: sub, configurable: true })
  return counter
}

/** 新建「SAB + 原子计数器」对（宿主创建后把 sab 交给 Worker）。 */
export function createSharedActivityCounter() {
  const sab = new SharedArrayBuffer(4)
  return { sab, activity: createActivityCounter(sab) }
}

/**
 * 唯一的增减入口：SAB 计数器走原子 add/sub，plain `{pending}` 对象走普通算术。
 * 调用方必须用本函数（或计数器的 `add`/`sub`），不要自己写 `activity.pending += 1`。
 */
export function bumpActivity(activity, delta = 1) {
  const amount = Math.trunc(Number(delta) || 0)
  if (!activity) return 0
  if (amount > 0 && typeof activity[ACTIVITY_ADD] === 'function') return activity[ACTIVITY_ADD](amount)
  if (amount < 0 && typeof activity[ACTIVITY_SUB] === 'function') return activity[ACTIVITY_SUB](-amount)
  const next = Math.max(0, (Number(activity.pending) || 0) + amount)
  activity.pending = next
  return next
}

/** 把 `{get/set pending}` 门面接到真实计数器上（原子 add/sub 一并转发；delegate 可为函数=惰性取）。 */
export function linkActivityCounter(facade, delegate) {
  if (!facade || typeof facade !== 'object') throw new TypeError('linkActivityCounter 需要目标对象')
  const read = () => (typeof delegate === 'function' ? delegate() : delegate)
  Object.defineProperty(facade, ACTIVITY_ADD, { value: delta => bumpActivity(read(), delta), configurable: true })
  Object.defineProperty(facade, ACTIVITY_SUB, { value: value => bumpActivity(read(), -Math.abs(Math.trunc(Number(value) || 0))), configurable: true })
  return facade
}

/**
 * 宿主侧通道。
 * @param options.sab 共享环（宿主创建）
 * @param options.payloadBytes 载荷容量（可省=按共享环自述；给了就必须一致）
 * @param options.slotCount 槽数（可省=按共享环自述；给了就必须一致）
 * @param options.onLog 诊断回调（可选）
 */
export function createHostChannel({ sab, payloadBytes, slotCount, onLog } = {}) {
  const layout = layoutOf(sab)
  if (payloadBytes !== undefined && assertPayloadBytes(payloadBytes) !== layout.payloadBytes) {
    throw ipcFail(IPC_ERRORS.protocol, `载荷容量与共享环不符（${payloadBytes} != ${layout.payloadBytes}）`)
  }
  if (slotCount !== undefined && assertSlotCount(slotCount) !== layout.slotCount) {
    throw ipcFail(IPC_ERRORS.protocol, `槽数与共享环不符（${slotCount} != ${layout.slotCount}）`)
  }
  const { control } = layout
  let ticketSeq = 0
  let lastSend = null
  const tickets = new Map()
  const log = message => { try { onLog?.(message) } catch { /* 诊断不影响协议 */ } }
  const isInvalidated = () => Atomics.load(control, C_INVALID) === 1

  function noteRejected(reason) {
    const total = Atomics.add(control, C_SPURIOUS, 1) + 1
    log(`拒绝未配对/重复的 hostcall（${reason}）：不执行宿主 API，累计 ${total}`)
    return total
  }

  /**
   * 写响应。**先校验后写**：槽的请求序号必须仍是本次、状态必须仍是 SERVING，
   * 否则抛协议错——迟到响应绝不覆盖新请求的载荷。
   * 响应把请求号写进**独立的回显字段** `S_RESP_SEQ`（与请求号 `S_SEQ` 分离），
   * 并先写回显、后发布状态（发布顺序即内存可见顺序）。
   */
  function writeResponse(slot, seq, state, bytes, ticketId) {
    if (bytes && bytes.length > layout.payloadBytes) {
      throw ipcFail(IPC_ERRORS.oversize, `同步返回超过共享槽容量（${bytes.length} > ${layout.payloadBytes}）`)
    }
    const { header, payload } = slotView(sab, layout, slot)
    if (Atomics.load(header, S_SEQ) !== seq) {
      throw ipcFail(IPC_ERRORS.protocol, `槽 ${slot} 已被更新的请求占用（seq ${Atomics.load(header, S_SEQ)} != ${seq}）：拒绝写入迟到响应`)
    }
    if (Atomics.load(header, S_STATE) !== STATE_SERVING) {
      throw ipcFail(IPC_ERRORS.protocol, `槽 ${slot} 状态不是 SERVING（${Atomics.load(header, S_STATE)}）：拒绝写入重复响应`)
    }
    if (bytes) payload.set(bytes, 0)
    Atomics.store(header, S_LENGTH, bytes ? bytes.length : 0)
    if (state === STATE_TICKET) Atomics.store(header, S_TICKET, ticketId)
    Atomics.store(header, S_RESP_SEQ, seq) // 独立回显：Worker 侧回程校验它，而不是复用请求号
    Atomics.store(header, S_STATE, state)
    Atomics.notify(header, S_STATE)
  }

  /**
   * 处理一次宿主 API 调用（宿主事件循环内调用，**不要 await 后再回应**）。
   * @param message Worker 的 hostcall 通知（必须带 {seq, slot}，与槽配对）
   * @param invoke (request, meta) => value | Promise<value>
   * @param send (message) => void 宿主→Worker 的消息发送（ticket 结算用）
   */
  function serve(message, invoke, send) {
    if (isInvalidated()) {
      log('通道已作废：拒绝 hostcall')
      return { ok: false, reason: 'invalidated' }
    }
    if (typeof invoke !== 'function') throw new TypeError('serve 需要 invoke 函数')
    if (typeof send !== 'function') throw new TypeError('serve 需要 send 函数')
    lastSend = send
    const seq = Number(message && message.seq)
    const slot = Number(message && message.slot)
    if (!isValidSeq(seq) || !Number.isInteger(slot) || slot < 0 || slot >= layout.slotCount) {
      noteRejected(`序号或槽号非法 seq=${message && message.seq} slot=${message && message.slot}`)
      return { ok: false, reason: 'unpaired' }
    }
    const { header, payload } = slotView(sab, layout, slot)
    if (Atomics.load(header, S_SEQ) !== seq || Atomics.load(header, S_STATE) !== STATE_REQUEST) {
      noteRejected(`消息与槽不配对或请求已被服务 slot=${slot} seq=${seq}`)
      return { ok: false, reason: 'unpaired' }
    }
    // 消费请求：同一 seq 的第二次 hostcall 必然落到这里之后 ⇒ 不再执行 API。
    Atomics.store(header, S_STATE, STATE_SERVING)

    const failResponse = error => {
      try { writeResponse(slot, seq, STATE_ERROR, encodeValue(encodeError(error))) }
      catch (cause) { log(`写错误响应失败（${cause && cause.message}）`) }
    }

    const length = Atomics.load(header, S_LENGTH)
    if (!Number.isInteger(length) || length < 0 || length > layout.payloadBytes) {
      failResponse(ipcFail(IPC_ERRORS.protocol, `宿主收到非法请求长度：${length}`))
      return { ok: false, reason: 'bad-length' }
    }
    let request
    try {
      request = decodeValue(payload.subarray(0, length))
    } catch (error) {
      failResponse(error)
      return { ok: false, reason: 'decode' }
    }
    let result
    try {
      result = invoke(request, { seq, slot })
    } catch (error) {
      failResponse(error)
      return { ok: false, reason: 'threw' }
    }
    let thenable = false
    try {
      // then-getter 可能抛：那属于宿主 API 的失败，必须走错误响应，绝不能抛出 serve 打死宿主事件循环。
      thenable = Boolean(result) && typeof result.then === 'function'
    } catch (error) {
      failResponse(error)
      return { ok: false, reason: 'then-getter' }
    }
    if (thenable) {
      // 同步前缀已执行完（async 函数体到首个 await）⇒ 与进程内语义一致；尾部走 ticket。
      if (ticketSeq >= MAX_REQUEST_SEQ) {
        invalidate('ticket 编号将达到 int32 上限')
        failResponse(ipcFail(IPC_ERRORS.protocol, `ticket 编号将达到 int32 上限（${MAX_REQUEST_SEQ}）：拒绝继续签发`))
        return { ok: false, reason: 'ticket-overflow' }
      }
      const id = ++ticketSeq
      tickets.set(id, { seq, slot })
      try {
        writeResponse(slot, seq, STATE_TICKET, null, id)
      } catch (error) {
        tickets.delete(id)
        failResponse(error)
        return { ok: false, reason: 'ticket-write' }
      }
      const settle = (ok, value) => {
        if (!tickets.delete(id)) return
        // ticket 消息带请求序号与槽号：Worker 侧据此拒绝错配结算。
        try {
          send({ type: 'ticket', id, ticket: id, seq, slot, ok, value: ok ? value : encodeError(value) })
        } catch (error) {
          // 结果不可克隆 / 发送失败：改发失败 ticket（best effort）。这里是微任务上下文，
          // 抛出去会变成 unhandledRejection ⇒ 必须在这里收口。
          try {
            send({
              type: 'ticket', id, ticket: id, seq, slot, ok: false,
              value: encodeError(ipcFail(IPC_ERRORS.protocol, '宿主异步写结果无法跨线程回传：' + (error && error.message))),
            })
          } catch (cause) {
            log(`ticket ${id} 结算通知失败（结果不可克隆且兜底也失败）：${cause && cause.message}`)
          }
        }
      }
      Promise.resolve(result).then(value => settle(true, value), error => settle(false, error))
      return { ok: true, kind: 'ticket', ticket: id, seq, slot }
    }
    try {
      writeResponse(slot, seq, STATE_VALUE, encodeValue(result))
    } catch (error) {
      failResponse(error)
      return { ok: false, reason: 'write' }
    }
    return { ok: true, kind: 'value', seq, slot }
  }

  /**
   * 通道作废：置位 + **notify 所有槽**（把阻塞在 `Atomics.wait` 的 Worker 立刻唤醒，
   * 否则它要等到自己的 deadline 才失败）+ 拒绝所有在飞 ticket（不让 Worker 侧 Promise 悬挂）。
   */
  function invalidate(reason = 'invalidated', send = lastSend) {
    if (isInvalidated()) return false
    Atomics.store(control, C_INVALID, 1)
    for (let slot = 0; slot < layout.slotCount; slot += 1) {
      try { Atomics.notify(slotView(sab, layout, slot).header, S_STATE) } catch { /* 唤醒失败不改变作废结论 */ }
    }
    for (const [id, entry] of [...tickets]) {
      tickets.delete(id)
      try {
        send?.({
          type: 'ticket', id, ticket: id, seq: entry.seq, slot: entry.slot, ok: false,
          value: encodeError(ipcFail(IPC_ERRORS.invalid, `通道已作废（${reason}）：未结算的宿主写按失败结算`)),
        })
      } catch { /* 通知失败不改变作废结论 */ }
    }
    log('通道作废：' + reason)
    return true
  }

  /** 已登记未结算的 ticket 数（诊断/收尾用） */
  function pendingTickets() {
    return tickets.size
  }

  /** 是否有槽停在 REQUEST（诊断用，识别宿主没在事件循环里服务同步调用） */
  function requestPending() {
    for (let slot = 0; slot < layout.slotCount; slot += 1) {
      if (Atomics.load(slotView(sab, layout, slot).header, S_STATE) === STATE_REQUEST) return true
    }
    return false
  }

  return {
    sab, serve, invalidate, pendingTickets, requestPending,
    get invalidated() { return isInvalidated() },
    payloadBytes: layout.payloadBytes,
    slotCount: layout.slotCount,
    log: onLog,
  }
}

/**
 * Worker 侧通道。
 * @param options.sab 宿主传来的共享环
 * @param options.notify (message) => void  Worker→宿主 的消息发送（请求通知）
 * @param options.timeoutMs 单次同步调用等待上限（超时 ⇒ 响亮失败并作废通道）
 * @param options.payloadBytes / options.slotCount 可省=按共享环自述；给了就必须一致
 */
export function createWorkerChannel({ sab, notify, timeoutMs = 30000, payloadBytes, slotCount, onLog } = {}) {
  const layout = layoutOf(sab)
  if (payloadBytes !== undefined && assertPayloadBytes(payloadBytes) !== layout.payloadBytes) {
    throw ipcFail(IPC_ERRORS.protocol, `载荷容量与共享环不符（${payloadBytes} != ${layout.payloadBytes}）`)
  }
  if (slotCount !== undefined && assertSlotCount(slotCount) !== layout.slotCount) {
    throw ipcFail(IPC_ERRORS.protocol, `槽数与共享环不符（${slotCount} != ${layout.slotCount}）`)
  }
  if (typeof notify !== 'function') throw new TypeError('createWorkerChannel 需要 notify 函数')
  const { control } = layout
  const budgetMs = Math.max(1, Number(timeoutMs) || 0)
  let seqCounter = 0
  let deadReason = null
  let mispairedTickets = 0
  const pendingTickets = new Map()
  const log = message => { try { onLog?.(message) } catch { /* 诊断不影响协议 */ } }
  const isInvalidated = () => deadReason !== null || Atomics.load(control, C_INVALID) === 1

  function rejectPendingTickets(message) {
    for (const [id, entry] of [...pendingTickets]) {
      pendingTickets.delete(id)
      try { entry.reject(ipcFail(IPC_ERRORS.invalid, message)) } catch { /* 已结算 */ }
    }
  }

  /** 作废通道：置位 + 让所有在飞 ticket 响亮失败；之后 call() 一律拒绝。 */
  function invalidate(reason) {
    if (deadReason === null) {
      deadReason = String(reason || 'invalidated')
      try { Atomics.store(control, C_INVALID, 1) } catch { /* 已不可写 */ }
    }
    rejectPendingTickets(`通道已作废（${deadReason}）：宿主写不会结算`)
    return deadReason
  }

  /** 发起同步调用；返回 {kind:'value'|'ticket', seq, slot, ...}；宿主错误代码原样抛出。 */
  function call(request) {
    if (isInvalidated()) {
      throw ipcFail(IPC_ERRORS.invalid, `通道已作废（${deadReason || '宿主已释放'}）：拒绝新的宿主调用`)
    }
    const bytes = encodeValue(request)
    if (bytes.length > layout.payloadBytes) {
      throw ipcFail(IPC_ERRORS.oversize, `同步调用参数超过共享槽容量（${bytes.length} > ${layout.payloadBytes}）`)
    }
    if (seqCounter >= MAX_REQUEST_SEQ) {
      invalidate(`请求号将达到 int32 上限（${MAX_REQUEST_SEQ}）`)
      throw ipcFail(IPC_ERRORS.protocol, `请求号将达到 int32 上限（${MAX_REQUEST_SEQ}）：fail-closed，拒绝发布新请求`)
    }
    seqCounter += 1
    const seq = seqCounter
    const slot = (seq - 1) % layout.slotCount
    const { header, payload } = slotView(sab, layout, slot)
    const stateOnEntry = Atomics.load(header, S_STATE)
    // 只按槽状态判定：终态（VALUE/ERROR/TICKET）槽可复用 —— ticket 的响应早已发布，
    // 异步尾部只走消息、不占 payload，因此"槽上还有未结算 ticket"**不是**复用障碍。
    if (stateOnEntry !== STATE_IDLE && stateOnEntry !== STATE_VALUE && stateOnEntry !== STATE_ERROR && stateOnEntry !== STATE_TICKET) {
      invalidate(`槽 ${slot} 上仍有未结算请求（state=${stateOnEntry}）`)
      throw ipcFail(IPC_ERRORS.protocol, `拒绝在未结算的槽 ${slot} 上写入新请求（避免覆盖在飞请求）`)
    }
    payload.set(bytes, 0)
    Atomics.store(header, S_LENGTH, bytes.length)
    Atomics.store(header, S_TICKET, 0)
    Atomics.store(header, S_RESP_SEQ, 0) // 清掉上一次的回显：陈旧回显不得被当成本次响应
    Atomics.store(header, S_SEQ, seq)
    Atomics.store(header, S_STATE, STATE_REQUEST) // 最后发布：宿主看到的是完整请求
    notify({ type: 'hostcall', seq, slot })

    const deadline = Date.now() + budgetMs
    let rechecks = 0
    const timeoutFail = () => {
      invalidate(`同步调用超时 ${budgetMs}ms`)
      throw ipcFail(IPC_ERRORS.timeout, `宿主 API 同步调用超时 ${budgetMs}ms（宿主未在事件循环内服务：疑似死锁或宿主卡死）；通道已作废，禁止继续调用`)
    }
    const protocolFail = message => {
      invalidate(message)
      throw ipcFail(IPC_ERRORS.protocol, message)
    }
    for (;;) {
      if (Atomics.load(control, C_INVALID) === 1) {
        // 宿主作废（释放/协议错）会 notify 唤醒我们：这里必须读 C_INVALID 并立刻响亮失败，
        // 不能继续等自己的 deadline。
        const reason = invalidate('宿主已作废通道')
        throw ipcFail(IPC_ERRORS.invalid, `宿主已作废通道（${reason}）：本次同步调用作废，结果不可用`)
      }
      const state = Atomics.load(header, S_STATE)
      const slotSeq = Atomics.load(header, S_SEQ)
      if (slotSeq !== seq) protocolFail(`槽 ${slot} 的请求序号被替换（${slotSeq} != ${seq}）：响应不可信`)
      if (state === STATE_VALUE || state === STATE_ERROR || state === STATE_TICKET) {
        // 响应必须**独立回显**本次请求号（不复用请求号字段），否则视为不可信。
        const echo = Atomics.load(header, S_RESP_SEQ)
        if (echo !== seq) protocolFail(`槽 ${slot} 的响应回显序号不匹配（${echo} != ${seq}）：响应不可信`)
      }
      if (state === STATE_VALUE || state === STATE_ERROR) {
        const length = Atomics.load(header, S_LENGTH)
        if (!Number.isInteger(length) || length < 0 || length > layout.payloadBytes) protocolFail(`宿主响应长度非法：${length}`)
        let detail
        try {
          detail = decodeValue(payload.subarray(0, length))
        } catch (error) {
          protocolFail('宿主响应无法解码：' + (error && error.message))
        }
        if (state === STATE_VALUE) return { kind: 'value', value: detail, seq, slot }
        const error = new Error((detail && detail.message) || '宿主调用失败')
        if (detail && detail.name) error.name = detail.name
        if (detail && detail.code) error.code = detail.code
        if (detail && detail.stack) error.stack = detail.stack
        throw error
      }
      if (state === STATE_TICKET) {
        const ticket = Atomics.load(header, S_TICKET)
        if (!Number.isSafeInteger(ticket) || ticket <= 0) protocolFail(`ticket 编号非法：${ticket}`)
        return { kind: 'ticket', ticket, seq, slot }
      }
      if (state === STATE_REQUEST || state === STATE_SERVING) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) timeoutFail()
        const waited = Atomics.wait(header, S_STATE, state, remaining)
        if (waited === 'timed-out') timeoutFail()
        // 每次被通知唤醒（含虚假/重复通知）只消耗同一个 deadline，不重置、不 busy spin。
        rechecks += 1
        if (rechecks > MAX_WAIT_RECHECKS) protocolFail(`同步调用被通知唤醒超过 ${MAX_WAIT_RECHECKS} 次：拒绝继续等待`)
        continue
      }
      protocolFail(`槽 ${slot} 状态异常：${state}（期望 REQUEST/SERVING/VALUE/TICKET/ERROR）`)
    }
  }

  /** 把宿主返回的 thenable 变成 Worker 侧 promise：ticket 回来才结算（登记时钉死请求序号）。 */
  function awaitTicket(ticket, seq) {
    const id = Number(ticket)
    if (!Number.isSafeInteger(id) || id <= 0) throw ipcFail(IPC_ERRORS.protocol, `ticket 编号非法：${ticket}`)
    if (pendingTickets.has(id)) {
      invalidate(`ticket ${id} 重复登记`)
      throw ipcFail(IPC_ERRORS.protocol, `ticket ${id} 重复登记：拒绝覆盖在飞 Promise`)
    }
    const wantSeq = Number(seq)
    if (!isValidSeq(wantSeq)) throw ipcFail(IPC_ERRORS.protocol, `请求序号非法（必须是 1..${MAX_REQUEST_SEQ} 的整数）：${seq}`)
    return new Promise((resolve, reject) => {
      if (isInvalidated()) {
        reject(ipcFail(IPC_ERRORS.invalid, `通道已作废（${deadReason}）：宿主写不会结算`))
        return
      }
      pendingTickets.set(id, { seq: wantSeq, resolve, reject })
    })
  }

  /** 处理宿主→Worker 的消息；返回 true 表示本通道消费了它（ticket 结算）。 */
  function handleMessage(message) {
    if (!message || message.type !== 'ticket') return false
    const id = Number(message.ticket ?? message.id)
    const entry = pendingTickets.get(id)
    if (!entry) {
      log(`忽略未知/迟到的 ticket ${id}`)
      return false
    }
    if (Number(message.seq) !== entry.seq) {
      mispairedTickets += 1
      try { Atomics.add(control, C_MISPAIRED, 1) } catch { /* 诊断计数失败不影响拒绝 */ }
      log(`ticket ${id} 与请求序号不配对（${message.seq} != ${entry.seq}）：拒绝结算`)
      if (mispairedTickets > MAX_TICKET_MISPAIRS) invalidate(`ticket 错配超过 ${MAX_TICKET_MISPAIRS} 次`)
      return false
    }
    pendingTickets.delete(id)
    if (message.ok) {
      entry.resolve(message.value)
      return true
    }
    const detail = message.value || {}
    const error = new Error(detail.message || '宿主异步写失败')
    if (detail.name) error.name = detail.name
    if (detail.code) error.code = detail.code
    if (detail.stack) error.stack = detail.stack
    entry.reject(error)
    return true
  }

  return {
    sab, call, awaitTicket, handleMessage, invalidate, log,
    pendingTickets: () => pendingTickets.size,
    get invalidated() { return isInvalidated() },
    get invalidReason() { return deadReason },
    timeoutMs: budgetMs,
    payloadBytes: layout.payloadBytes,
    slotCount: layout.slotCount,
  }
}
