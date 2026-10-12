// 重新生成的**纯计划器**：按真实事件流算出"保留前缀 + 重放输出 + 原轮收尾"。
// 从严：未知事件类型、无法证明归属的帧、指向被删事件的引用、未知 source.kind/异档 trace 一律拒；不碰 SQL/session/fs。
// 映射规则：old seq → keep（保留前缀原样）或 keep + replay 数组下标（本批连续 append 的确定规则）。
const OUTPUT_TYPES = new Set([
  'step/start', 'step/end', 'request/header', 'request/context',
  'assistant/attempt', 'assistant/message',
  'tool/call', 'tool/result', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
  'llm/retry', 'llm/retry-started',
  'hook/invoked', 'hook/result',
])
const REGEN_PLUGIN = 'dsh-tavern-regen'
const TAVERN_PLUGIN = 'dsh-tavern'
const SYSTEM_PROMPT_PLUGIN = '@deepseek-ai/dsh-system-prompt'
const OWNED_PLUGINS = new Set([REGEN_PLUGIN, TAVERN_PLUGIN, SYSTEM_PROMPT_PLUGIN])
const OWNED_KINDS = new Set(['user', 'model', 'plugin', 'tool', 'system'])
const str = value => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw new Error('重新生成计划拒绝：' + message) }
const clone = value => (value === undefined ? undefined : structuredClone(value))
const seqOf = event => Number(event && event.seq)
const turnOf = event => (isRecord(event?.data) ? event.data.turn : undefined)

/** 归属判定：真实玩家输入、本次重生成/本档酒馆、共享宿主 system-prompt；trace.chatId 异档即拒。 */
function ownedSource(data, chatId, where) {
  const source = data?.source
  if (!isRecord(source)) return false
  const traceChat = source.trace?.chatId ?? source.chatId
  if (traceChat !== undefined && chatId !== undefined && traceChat !== chatId) fail(where + ' 的 source trace 指向其它档')
  if (source.kind === 'user') return true
  if (!OWNED_PLUGINS.has(source.plugin)) return false
  return true
}

/** inbox 片段归属：空数组、或全部来自本次重生成（含 trace 同档校验）。 */
function inboxOwned(data, chatId, where) {
  const inserted = data?.inserted
  if (inserted === undefined || (Array.isArray(inserted) && inserted.length === 0)) return true
  if (!Array.isArray(inserted)) fail(where + ' 的 inserted 形状未知')
  for (const item of inserted) {
    const traceChat = item?.source?.trace?.chatId ?? item?.source?.chatId ?? item?.chatId
    if (traceChat !== undefined && chatId !== undefined && traceChat !== chatId) fail(where + ' 的 trace 指向其它档')
    if (item?.source?.plugin !== REGEN_PLUGIN) fail(where + ' 含非本次生成注入项')
  }
  return true
}

/** 只按显式声明重写 trace：同档校验 + synthetic→oldTurn；未知 source.kind 拒；其余字段原样保留。 */
function remapSource(source, { chatId, syntheticTurn, oldTurn, where }) {
  if (source === undefined) return undefined
  if (!isRecord(source)) fail(where + ' 的 message.source 必须是对象')
  const out = clone(source)
  if (out.kind !== undefined && !OWNED_KINDS.has(out.kind)) fail(where + ' 出现未知 source.kind：' + str(out.kind))
  const traceChat = out.trace?.chatId ?? out.chatId
  if (traceChat !== undefined && chatId !== undefined && traceChat !== chatId) fail(where + ' 的 source trace 指向其它档')
  if (Number(out.turn) === syntheticTurn) out.turn = oldTurn
  if (isRecord(out.trace) && Number(out.trace.turn) === syntheticTurn) out.trace = { ...out.trace, turn: oldTurn }
  if (isRecord(out.source)) out.source = remapSource(out.source, { chatId, syntheticTurn, oldTurn, where })
  return out
}

/** 全部类型统一：显式 turn 只为 synthetic 时映射为 oldTurn；其余 data（含 stream/未知字段）原样。 */
function remapData(event, context) {
  const data = clone(event.data) ?? {}
  const where = event.type + '@' + seqOf(event)
  if (Number(data.turn) === context.syntheticTurn) data.turn = context.oldTurn
  if (isRecord(data.message)) {
    data.message = clone(data.message)
    const source = remapSource(data.message.source, { ...context, where })
    if (source !== undefined) data.message.source = source
  }
  if (isRecord(data.frame)) {
    const frameChat = data.frame.chatId ?? data.frame.sessionId
    if (frameChat !== undefined && context.chatId !== undefined && frameChat !== context.chatId) fail(where + ' 的 frame 指向其它档')
  }
  return data
}

/**
 * @param {{events:Array, oldTurn:number, syntheticTurn:number, eventStart:number, oldAssistantSeq:number, chatId:string}} input
 * @returns {{keep:number, events:Array<{type:string,data:object,surfaceOp?:any,sourceEventSeqs?:Array<number>}>, originalTail:Array}}
 */
export function planRegenerationEvents(input) {
  const events = Array.isArray(input?.events) ? input.events : fail('events 必须是数组')
  const oldTurn = Number(input.oldTurn), syntheticTurn = Number(input.syntheticTurn)
  const eventStart = Number(input.eventStart), oldAssistantSeq = Number(input.oldAssistantSeq)
  const chatId = input.chatId
  if (!Number.isSafeInteger(oldTurn) || oldTurn < 0) fail('oldTurn 非法')
  if (!Number.isSafeInteger(syntheticTurn) || syntheticTurn < 0) fail('syntheticTurn 非法')
  if (syntheticTurn === oldTurn) fail('syntheticTurn 必须与 oldTurn 不同（临时生成轮）')
  if (!Number.isSafeInteger(eventStart) || eventStart < 0 || eventStart > events.length) fail('eventStart 非法')
  if (!Number.isSafeInteger(oldAssistantSeq)) fail('oldAssistantSeq 非法')
  events.forEach((event, index) => { if (seqOf(event) !== index) fail('事件 seq 必须连续：' + index) })

  // ① 原轮边界与唯一真实 user（keep 为整数＝原 user 之后的事件数）
  const oldStart = events.findIndex(event => event.type === 'turn/start' && turnOf(event) === oldTurn)
  if (oldStart < 0) fail('找不到原轮 turn/start(turn=' + oldTurn + ')')
  const oldAssistantIndex = events.findIndex(event => seqOf(event) === oldAssistantSeq)
  if (oldAssistantIndex < 0) fail('找不到旧 assistant 事件')
  const oldAssistant = events[oldAssistantIndex]
  if (oldAssistant.type !== 'assistant/message' || turnOf(oldAssistant) !== oldTurn) fail('旧 assistant 必须是本轮 assistant/message')
  if (oldAssistantIndex <= oldStart) fail('旧 assistant 必须在原轮 turn/start 之后')
  let realUserIndex = -1
  for (let index = oldStart + 1; index < oldAssistantIndex; index++) {
    const event = events[index]
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
    if (realUserIndex >= 0) fail('原轮出现多条真实 kind:user')
    realUserIndex = index
  }
  if (realUserIndex < 0) fail('原轮缺少真实 kind:user')
  const keep = realUserIndex + 1

  // ② 前缀到 eventStart 属于原轮：不得再出现 turn/start 或真实 user；未知插件事件不得静默保留
  if (eventStart < keep) fail('eventStart 早于保留前缀')
  for (let index = keep; index < eventStart; index++) {
    const event = events[index]
    if (event.type === 'turn/start') fail('原轮范围内出现新的 turn/start')
    if (event.type === 'user/message') {
      const where = event.type + '@' + index
      if (event.data?.source?.kind === 'user') fail('原轮范围内出现新的真实玩家输入')
      if (!ownedSource(event.data, chatId, where)) fail('原轮范围内出现无法证明归属的 user/message')
    }
  }

  // ③ 临时轮定位（起始边界必须恰是 synthetic 的 turn/start）
  const syntheticStart = events.findIndex((event, index) => index >= eventStart && event.type === 'turn/start' && turnOf(event) === syntheticTurn)
  if (syntheticStart < 0) fail('找不到临时生成轮 turn/start(turn=' + syntheticTurn + ')')
  const syntheticEnd = events.findIndex((event, index) => index > syntheticStart && event.type === 'turn/end' && turnOf(event) === syntheticTurn)
  if (syntheticEnd < 0) fail('临时生成轮缺少 turn/end')

  // ④ eventStart→syntheticStart：只允许本次生成注入的自有/空 inbox 片段与自有 user；任意 turn 边界/未知类型拒
  for (let index = eventStart; index < syntheticStart; index++) {
    const event = events[index]
    const where = event.type + '@' + index
    if (event.type === 'agent/inbox/spliced') {
      if (!inboxOwned(event.data, chatId, where)) fail('临时 inbox 片段不是本次生成注入，拒绝删除')
      continue
    }
    if (event.type === 'user/message') {
      if (event.data?.source?.kind === 'user') fail('临时轮前出现真实玩家输入，拒绝吞掉')
      if (!ownedSource(event.data, chatId, where)) fail('临时轮前出现无法证明归属的 user/message')
      continue
    }
    fail('临时轮前出现未列举的事件类型：' + event.type)
  }

  // ⑤ 重放：白名单类型 + 全量 data/surfaceOp 拷贝 + seq 映射
  const replay = []
  const mapping = new Map()
  const mapSeq = oldSeq => {
    if (!Number.isSafeInteger(oldSeq)) fail('引用 seq 非法：' + oldSeq)
    if (oldSeq < keep) return oldSeq
    const mapped = mapping.get(oldSeq)
    if (mapped === undefined) fail('引用指向被删除的事件：' + oldSeq)
    return mapped
  }
  const mapSurface = (event, where) => {
    const out = {}
    if (event.sourceEventSeqs !== undefined) {
      if (!Array.isArray(event.sourceEventSeqs)) fail(where + ' 的 sourceEventSeqs 必须是数组')
      out.sourceEventSeqs = event.sourceEventSeqs.map(mapSeq)
    }
    if (event.surfaceOp !== undefined) {
      const op = clone(event.surfaceOp)
      if (op === 'append') out.surfaceOp = 'append'
      else if (isRecord(op) && op.op === 'replace') {
        // 真实 Session 用 startSeq/endSeq（clean-session.js planSurfaceEvent:400-401）；旧 start/end 写法兼容映射
        const startKey = op.startSeq !== undefined ? 'startSeq' : 'start'
        const endKey = op.endSeq !== undefined ? 'endSeq' : 'end'
        if (!Number.isSafeInteger(op[startKey]) || !Number.isSafeInteger(op[endKey])) fail(where + ' 的 replace 区间非法')
        out.surfaceOp = { ...op, [startKey]: mapSeq(op[startKey]), [endKey]: mapSeq(op[endKey]) }
      } else fail(where + ' 的 surfaceOp 形状未知（不允许转成 append 蒙混）')
    }
    return out
  }
  let assistantSeen = 0
  for (let index = syntheticStart + 1; index < syntheticEnd; index++) {
    const event = events[index]
    const where = event.type + '@' + index
    if (event.type === 'turn/start' || event.type === 'turn/end') continue
    if (event.type === 'agent/inbox/spliced') {
      if (!inboxOwned(event.data, chatId, where)) fail('临时轮内 inbox 片段不是本次生成注入')
      continue
    }
    if (event.type === 'user/message') {
      if (event.data?.source?.kind === 'user') fail('临时轮内出现真实玩家输入，拒绝吞掉')
      if (!ownedSource(event.data, chatId, where)) fail('临时轮内出现无法证明归属的 user/message')
      continue
    }
    if (!OUTPUT_TYPES.has(event.type)) fail('临时轮出现未列举的事件类型，拒绝重放：' + event.type)
    const mapped = mapSurface(event, where)
    const data = remapData(event, { chatId, syntheticTurn, oldTurn })
    if (event.type === 'assistant/message') {
      const content = Array.isArray(data.message?.content) ? data.message.content : []
      if (str(content.find?.(part => part?.type === 'text')?.text) !== '') assistantSeen += 1
    }
    mapping.set(index, keep + replay.length)
    replay.push({ type: event.type, data, ...mapped })
  }
  if (assistantSeen === 0) fail('新输出没有非空 assistant 正文')

  // ⑥ 收尾：真实 turn/end（含 reason）按 oldTurn 重写
  const endEvent = events[syntheticEnd]
  if (endEvent.data?.reason?.kind !== 'completed') fail('临时生成轮未完成：' + str(endEvent.data?.reason?.kind))
  const endData = clone(endEvent.data) ?? {}
  endData.turn = oldTurn
  mapping.set(syntheticEnd, keep + replay.length)
  replay.push({ type: 'turn/end', data: endData, ...mapSurface(endEvent, 'turn/end@' + syntheticEnd) })

  // ⑦ synthetic 之后：只允许 session/end-seed、本档空 inbox、本档 frame 退休 replace；其它拒
  for (let index = syntheticEnd + 1; index < events.length; index++) {
    const event = events[index]
    const where = event.type + '@' + index
    if (event.type === 'session/end-seed') continue
    if (event.type === 'agent/inbox/spliced') {
      if (!inboxOwned(event.data, chatId, where)) fail('生成轮后出现非空的 inbox 片段')
      continue
    }
    if (event.type === 'user/message' && event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
      if (!ownedSource(event.data, chatId, where)) fail('生成轮后出现无法证明归属的 frame 退休替换')
      continue
    }
    fail('生成轮后出现未列举的事件类型：' + event.type)
  }

  // ⑧ originalTail：原输出恢复材料（keep→eventStart），不含临时新轮
  const originalTail = events.slice(keep, eventStart).map(event => clone(event))
  return { keep, events: replay, originalTail }
}
