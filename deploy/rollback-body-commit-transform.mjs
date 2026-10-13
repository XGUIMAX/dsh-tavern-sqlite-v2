// 正文提交与完成后排队沿用发轮身份，不通过当前同号轮反推旧结果所属任务。
function once(source,old,next){if(source.split(old).length!==2)throw Error('正文提交归属锚点缺失/不唯一：'+old.slice(0,100));return source.replace(old,next)}
export function applyRollbackBodyCommitTurnTransform(source){
 const marker='// [dsh-tavern-body-commit-owner:v1]'
 if(source.includes(marker)){
  for(const fragment of ['function rollbackBodyCommitMatches(chat,input)', '!rollbackBodyCommitMatches(current,input)', '!rollbackBodyCommitMatches(chat,input)', '!rollbackBodyAdoptMatches(current,input)', '!rollbackBodyAdoptMatches(chat,input)', 'base.committedBranchId!==chat.timeline?.branchId']) {
   if(source.split(fragment).length!==2)throw Error('正文提交归属消费者缺失/重复：'+fragment)
  }
  // 快路径行在场的源码（537e878）必须同时带补记拒绝；旧代源无该行则不要求。
  if(source.includes('      if (!before || !selected.denseMessages')&&!source.includes('if (input.adopt === true || !before'))throw Error('补记快路径拒绝缺失')
  return source
 }
 let next=marker+`\nfunction rollbackBodyCommitMatches(chat,input) {
 const owner=input.rollbackBodyOwner,op=chat.timeline?.operations?.[owner?.operationId]
 return !!owner && !chat.rollbackPending && owner.chatId===chat.id && owner.sessionId===chat.sessionId && owner.turn===Number(input.turn) && owner.branchId===chat.timeline?.branchId && op?.kind==='body' && ['running','completed'].includes(op.status) && Number(op.turn)===owner.turn && op.basedOn?.branchId===owner.branchId
}
// 上游 537e878 对账补记（#196）：reconcileStory 在 idle 时把“模型侧已完成、存档漏写”的轮补写进存档。
// 它不是在途发轮提交，因此没有 rollbackBodyOwner；但它同样改正文，必须满足同等护栏：
// 同 session、无进行中回退、该轮没有在途 body operation（真实发轮仍只能走 owner 通道）、回合内容齐全。
// 上游玩家轮允许空文本+附件（turn-lifecycle 只拼 text 块），附件-only 轮必须放行。
// 干净回退语义：插件回退必换 branch，且存档不留回退轮痕迹；对账 report 不携带生成时的 branch 身份，
// 因此补记只能落在“当前 branch 上已有更早已提交正文轮”的存档上（commitBody 在 operation 上记
// committedBranchId）——回退后的新 branch 上没有任何已提交轮，report 过期（生成后发生过回退）
// 时在此被拒，已删轮不会复活。
// CAS/旧写隔离/分支校验不在此放宽，仍由 updateChat 与 expectedTimeline 负责。
function rollbackBodyAdoptMatches(chat,input) {
  if(input?.adopt!==true)return false
  if(!chat||typeof chat!=='object'||chat.rollbackPending)return false
  if(!['story','script'].includes(chat.mode||'story'))return false
  const turn=Number(input.turn)
  if(!Number.isSafeInteger(turn)||turn<1)return false
  if(typeof input.sessionId!=='string'||input.sessionId===''||input.sessionId!==chat.sessionId)return false
  if(typeof input.userText!=='string'||typeof input.assistantText!=='string'||input.assistantText==='')return false
  if(!Array.isArray(input.userContent))return false
  if(input.userText===''&&!input.userContent.some(block=>block&&block.type!=='text'))return false
  const ops=Object.values(chat.timeline?.operations||{})
  for(const op of ops){
    if(op?.kind==='body'&&Number(op.turn)===turn&&['running','completed'].includes(op.status))return false
  }
  const base=ops.filter(op=>op?.kind==='body'&&op.status==='completed'&&Number(op.turn)<turn).pop()
  if(!base||base.committedBranchId!==chat.timeline?.branchId)return false
  return true
}
`+source
 next=once(next,'    await store.updateChat(chat.id, async current => {',`    await store.updateChat(chat.id, async current => {
      if(!rollbackBodyCommitMatches(current,input)&&!rollbackBodyAdoptMatches(current,input)){result={saved:false,reason:'stale-body-owner'};return undefined}`)
 const snapshots=['  async function finalizeSnapshot(input, chat, writeChat, expectedTimeline) {','  async function finalizeSnapshot(input, chat, writeChat, expectedTimeline, history) {']
 if(snapshots.reduce((count,anchor)=>count+next.split(anchor).length-1,0)!==1)throw Error('正文提交归属：未知/重复finalizeSnapshot签名')
 const snapshot=snapshots.find(anchor=>next.includes(anchor))
 next=once(next,snapshot,snapshot+`\n    if(['story','script'].includes(chat.mode || 'story') && !rollbackBodyCommitMatches(chat,input)&&!rollbackBodyAdoptMatches(chat,input))return {saved:false,reason:'stale-body-owner'}`)
 // 补记必须走完整快照路径：finalizeAppend 的 header-only chat（messages:[]）会让 adopt 分支的
 // body.begin 捕获 messageCount=0 的假业务回退基准，回退时按 0 截正文删空存档；
 // 完整路径从 chatForSession 读全量 chat，基准取真实楼数。旧代源无此快路径行则原样通过。
 if(next.includes('      if (!before || !selected.denseMessages')){
  if(next.split('      if (!before || !selected.denseMessages').length!==2)throw Error('补记快路径锚点缺失/不唯一')
  next=once(next,'      if (!before || !selected.denseMessages','      // [dsh-tavern-adopt-full-path:v1]\n      if (input.adopt === true || !before || !selected.denseMessages')
 }
 return next
}
export function applyRollbackBodyCommitHandoffTransform(source){
 const marker='// [dsh-tavern-body-commit-handoff:v1]'
 if(source.includes(marker))return source
 let next=marker+'\n'+once(source,'        if (chat === undefined) return',`        if (chat === undefined) return
        if(['story','script'].includes(chat.mode || 'story')){
          const owner=rollbackBodyOwner,op=chat.timeline?.operations?.[owner?.operationId]
          if(!owner || chat.rollbackPending || owner.chatId!==chat.id || owner.sessionId!==chat.sessionId || owner.turn!==Number(input.turn) || owner.branchId!==chat.timeline?.branchId || op?.kind!=='body' || op.status!=='completed' || Number(op.turn)!==owner.turn || op.basedOn?.branchId!==owner.branchId)return
        }`)
 return once(next,'          await queueBackground(chat.id)','          await queueBackground(chat.id,rollbackBodyOwner)')
}
export function applyRollbackBodyCommitJobsTransform(source){
 const marker='// [dsh-tavern-body-commit-jobs:v1]'
 if(source.includes(marker))return source
 let next=marker+'\n'+once(source,'  function start(chatId) {','  function start(chatId,rollbackBodyOwner) {')
 next=once(next,'      return run(chatId, signal)',`      return Promise.resolve(run(chatId, signal,rollbackBodyOwner)).then(result=>{job.staleBody=result===false;return result})`)
 return once(next,'if (!disposed && !signal.aborted) await onSettled(chatId, signal)','if (!disposed && !signal.aborted && !job.staleBody) await onSettled(chatId, signal)')
}
export function applyRollbackBodyCommitHooksTransform(source){
 const marker='// [dsh-tavern-body-commit-hooks:v1]'
 const next='    const saved = await foregroundHandoff.finalize({\n      rollbackBodyOwner,\n      sessionId,'
 if(source.includes(marker)){if(!source.includes(next))throw Error('正文hooks提交归属标记不完整');return source}
 return marker+'\n'+once(source,'    const saved = await foregroundHandoff.finalize({\n      sessionId,',next)
}
export function applyRollbackBodyCommitHostTransform(source){
 const marker='// [dsh-tavern-body-commit-host:v1]'
 if(source.includes(marker))return source
 let next=marker+'\n'+(source.includes('  registerTurnLifecycleHooks({')?source:applyRollbackBodyCommitHooksTransform(source))
 next=once(next,'  function queueSettlement(chatId) { return settlementJobs.start(chatId) }','  function queueSettlement(chatId,rollbackBodyOwner) { return settlementJobs.start(chatId,rollbackBodyOwner) }')
 next=once(next,'  async function runSettlement(chatId, signal) {','  async function runSettlement(chatId, signal,rollbackBodyOwner) {')
 return once(next,'      if (snapshot === undefined) return',`      if (snapshot === undefined) return
      if(rollbackBodyOwner){
        // settlement-input可能仅投影消息，不假设其保留timeline；确切chat权威另读。
        const current=await readChat(chatId),owner=rollbackBodyOwner,op=current?.timeline?.operations?.[owner.operationId]
        if(!current || current.rollbackPending || owner.chatId!==current.id || owner.sessionId!==current.sessionId || owner.branchId!==current.timeline?.branchId || op?.kind!=='body' || op.status!=='completed' || Number(op.turn)!==owner.turn || op.basedOn?.branchId!==owner.branchId)return false
      }`)
}
