// 发送准备期只检测失败尾；物理清理由已有统一回退入口执行，不能停正在prepare的Agent。
const MARKER='// [dsh-tavern-failure-input-guard:v1]'
const ORIGINAL=`    clearFailedTurns: async function (sessionId) {
      const mode = await turnOrchestrator.modeFor(sessionId)
      if (mode !== 'story' && mode !== 'script') return 0
      const session = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      const chat = session && await chatForSession(sessionId)
      if (!chat) return 0
      const availability = rollbackAvailability(chat, { events: sessionEvents(session), nodes: session.surface?.nodes || [] })
      let cleared = 0
      for (const turn of availability.unclearedTurns || []) cleared += clearFailedTurnSurface({ session, turn })
      if (cleared) await sessionStore.flush(session)
      else if (!availability.canRollback && availability.reason && /失败回合/.test(availability.reason)) console.warn('dsh-tavern: 上一次失败回合的残留无法清理，本轮请求可能带上它:', availability.reason)
      return cleared
    },`
const REPLACEMENT=`    clearFailedTurns: async function (sessionId) {
      ${MARKER}
      const mode = await turnOrchestrator.modeFor(sessionId)
      if (mode !== 'story' && mode !== 'script') return 0
      const session = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      const chat = session && await chatForSession(sessionId)
      if (!chat) return 0
      const ledger = inputFailureState(chat)
      if (chat.rollbackPending || ledger.pendingCleanupTurns.length) throw new Error('上轮失败输入尚未统一物理清理：请先清理或完成回退，再继续发送')
      const events = sessionEvents(session)
      const availability = rollbackAvailability(chat, { events, nodes: session.surface?.nodes || [] })
      if (availability.unclearedTurns?.length) throw new Error('失败输入尚未物理清理：请先统一清理，再继续发送')
      const tail = events.findLast(event => event.type === 'turn/end')
      const body = (chat.messages || []).findLast(message => message.role === 'assistant' && !message.greeting)
      if (['error', 'aborted'].includes(tail?.data?.reason?.kind) && Number(tail.data.turn) > Number(body?.turn || 0)) throw new Error('原生失败尾尚未物理清理：请先统一清理，再继续发送')
      return 0
    },`
// 被遗留的模板输入必须先撤销，再捕获下一轮物理回退基准；沿用作者restore不复制语义。
export function applyTemplateRollbackInputOrderTransform(source) {
 const marker='// [dsh-tavern-template-before-rollback-capture:v1]'
 if(!source.includes('function restoreTemplateInput(chat)'))return source
 if(source.includes(marker))return source
 const capture='    const rollbackBusinessBefore = timeline.captureBusiness ? timeline.captureBusiness(chat) : captureRollbackBusinessState(chat)'
 if(source.split(capture).length!==2)throw Error('模板撤销与业务基准接缝未命中/不唯一')
 return source.replace(capture,`    ${marker}\n    if (chat.promptTemplateInput && chat.promptTemplateInput.turn !== turn) restoreTemplateInput(chat)\n${capture}`)
}
export function applyUpstreamFailureInputTransform(source) {
 if(source.includes(MARKER)){
  if(!source.includes('ledger.pendingCleanupTurns.length') || !source.includes('return 0') || source.includes('cleared += clearFailedTurnSurface'))throw Error('失败输入接缝标记存在但消费者不完整')
  return source
 }
 if(!source.includes('    clearFailedTurns: async function (sessionId) {'))return source
 if(source.split(ORIGINAL).length!==2)throw Error('新增失败输入接缝未命中/不唯一')
 return "import { ledgerFailureState as inputFailureState } from './domain/storage-failure-state.js'\n"+source.replace(ORIGINAL,REPLACEMENT)
}
