// 重生成保留原逻辑轮的发轮前基准与全部后台切点；物理回退仍删除原轮起的完整原生尾。
const MARKER='// [dsh-tavern-regeneration-rollback:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('重生成回退接缝缺失/不唯一：'+old.slice(0,90));return source.replace(old,next)}
export function applyRegenerationRollbackTransform(source){
 if(source.includes(MARKER)){
  for(const key of ['const regenerationCheckpoint =','retainRegenerationRollbackState(next, originalChat, regenerationCheckpoint)'])if(!source.includes(key))throw Error('重生成回退接缝不完整')
  return source
 }
 const helper=`${MARKER}
  function retainRegenerationRollbackState(next, original, checkpoint) {
    if (!checkpoint?.businessBefore && !checkpoint?.rowBefore) throw new Error('重生成缺少原轮完整回退基准')
    // 基准仍在同一SQL账本中，书版本引用不会在临时业务恢复时被当作孤儿回收。
    next.timeline.checkpoints = [...original.timeline.checkpoints.filter(cp => Number(cp.turn) < Number(checkpoint.turn)), structuredClone(checkpoint)]
    const cuts = structuredClone(original.rollbackSessionCuts || {})
    for (const [turn, entries] of Object.entries(next.rollbackSessionCuts || {})) {
      const owned = cuts[turn] ||= {}
      for (const [id, boundary] of Object.entries(entries)) {
        if (!Number.isSafeInteger(boundary)) throw new Error('重生成后台切点无效')
        owned[id] = Object.hasOwn(owned, id) ? Math.min(owned[id], boundary) : boundary
      }
    }
    next.rollbackSessionCuts = cuts
    return next
  }

`
 let next=once(source,'  async function regenBody(chatId, guidance, sessionId) {',helper+'  async function regenBody(chatId, guidance, sessionId) {')
 const begin=next.indexOf('  async function regenBody(chatId, guidance, sessionId) {'),end=next.indexOf('  async function regenRecent(',begin)
 const body=next.slice(begin,end<0?next.length:end)
 const modified=once(body,'    const { eventStart, msgs0, oldAssistantIndex, oldSeq, oldTurn, oldSource } = selection',`    const { eventStart, msgs0, oldAssistantIndex, oldSeq, oldTurn, oldSource } = selection
    const regenerationCheckpoint = chat.timeline?.checkpoints?.findLast(cp => Number(cp.turn) === Number(oldTurn))
    if (!regenerationCheckpoint || (!regenerationCheckpoint.businessBefore && !regenerationCheckpoint.rowBefore)) throw new Error('原正文缺少回退基准，未开始重生成')`)
 next=next.slice(0,begin)+modified+(end<0?'':next.slice(end))
 next=once(next,"      const preview = session.constructor.fromRestore(session.id, structuredClone(sessionEvents(session)), structuredClone(session.header), session.inheritedEventCount, 'detached')",`      const preview = typeof sessionPatch?.restoreStoredSession === 'function'
        ? sessionPatch.restoreStoredSession({ header: session.header, events: sessionEvents(session), inheritedEventCount: session.inheritedEventCount })
        : session.constructor.fromRestore(session.id, structuredClone(sessionEvents(session)), structuredClone(session.header), session.inheritedEventCount, 'detached')`)
 next=once(next,'      const next = storyTimeline.apply({ chat: current, intent: rollbackIntent }).chat','      const next = storyTimeline.apply({ chat: current, intent: rollbackIntent }).chat\n      retainRegenerationRollbackState(next, originalChat, regenerationCheckpoint)')
 next=once(next,'        const next = merged.chat','        const next = merged.chat\n        retainRegenerationRollbackState(next, originalChat, regenerationCheckpoint)')
 return next
}
