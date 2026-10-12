// 第三方插件数据沿作者存储接口读取/恢复；这里只生成可移植载荷，不建立第二权威。
import { isDeepStrictEqual } from 'node:util'

export function visiblePluginKeys(chat, computeSceneTarget, sceneSlotKeys) {
 const keys = new Map()
 for (const message of chat.messages || []) {
  if (message?.role !== 'assistant') continue
  const turn = Number(message.turn || (message.greeting ? 1 : 0))
  const target = computeSceneTarget(chat, turn)
  // 2.6起一轮可有slot 1..5额外插图；第三方按slot key登记的回合数据同属当前可见版本。
  const expanded = typeof sceneSlotKeys === 'function' ? sceneSlotKeys([target.key]) : [target.key]
  for (const key of expanded) keys.set(turn + '\0' + key, key)
 }
 return keys
}
export function selectPluginContent(state, keys) {
 const data = state?.data ? structuredClone(state.data) : null
 if (data?.owners) for (const own of Object.values(data.owners)) own.turns = (own.turns || []).filter(item => keys.has(item.turn + '\0' + item.key))
 const media = state?.media ? structuredClone(state.media) : null
 if (media) { media.items = (media.items || []).filter(item => keys.has(item.turn + '\0' + item.key)); media.issued = {} }
 return data || media ? {version:1,data,media} : null
}
export function validatePluginContent(value, keys) {
 if (!value || value.version !== 1 || (value.data && (value.data.version !== 1 || !value.data.owners || typeof value.data.owners !== 'object')) || (value.media && (value.media.version !== 1 || !Array.isArray(value.media.items)))) throw Error('DB插件数据格式无效')
 if(value.data && (Array.isArray(value.data.owners) || Object.values(value.data.owners).some(own=>!own || typeof own!=='object' || !Array.isArray(own.turns))))throw Error('DB插件回合数据格式无效')
 const records = [...Object.values(value.data?.owners || {}).flatMap(own => own.turns || []), ...(value.media?.items || [])]
 if(records.some(item=>!item || !Number.isSafeInteger(item.turn) || item.turn<1 || typeof item.key!=='string'))throw Error('DB插件回合坐标无效')
 if (records.some(item => !keys.has(item.turn + '\0' + item.key))) throw Error('DB插件数据含非当前剧情版本')
 return value
}
export async function capturePluginContent(chat, deps, keys) {
 if (!deps.pluginData && !deps.pluginMedia) return {content:null,attachments:[],assertStable:async()=>true}
 const read = async () => ({data: await deps.pluginData.snapshot(chat.id),media: await deps.pluginMedia.snapshot(chat.id)})
 const observed = await read(), content = selectPluginContent(observed, keys)
 const refs = new Map()
 for (const item of content?.media?.items || []) if (item.attachment) {
  const ref = item.attachment, previous = refs.get(ref.attachmentId)
  if (previous && !isDeepStrictEqual(previous,ref)) throw Error('DB插件媒体附件引用冲突：'+ref.attachmentId)
  refs.set(ref.attachmentId,ref)
 }
 const attachments = []
 for (const ref of refs.values()) {
  let data
  if (ref.mediaType) data = Buffer.from((await deps.attachments.readImage(ref)).data)
  else {
   const chunks=[]
   for await (const chunk of deps.attachments.readFileStream(ref)) chunks.push(Buffer.from(chunk))
   data=Buffer.concat(chunks)
  }
  attachments.push({ref,data})
 }
 return {content,attachments,async assertStable(){if(!isDeepStrictEqual(observed,await read()))throw Error('DB插件数据在导出期间已变化')}}
}
export async function installPluginContent(bundle, sourceChat, identity, deps, sourceKeys) {
 const content=bundle.plugins
 if (!content) return {rollback:async()=>{}}
 if (!deps.pluginData || !deps.pluginMedia) throw Error('DB导入缺少插件数据恢复接口')
 if(await deps.pluginData.snapshot(identity.chatId) || await deps.pluginMedia.snapshot(identity.chatId))throw Error('DB导入目标已有插件副数据，拒绝覆盖')
 const targetKeys=visiblePluginKeys({...sourceChat,id:identity.chatId,sessionId:identity.sessionId,sceneTargets:undefined},deps.computeSceneTarget,deps.sceneSlotKeys)
 // 源/目标两侧visiblePluginKeys按同一消息序展开（turn升序、slot升序）：按turn分组下标对齐；
 // slot key是baseKey的确定性哈希，逐槽映射不跨槽猜测；旧代每turn只有主key，退化为原单键行为。
 const groupByTurn=keys=>{const grouped=new Map();for(const [coordinate,key] of keys){const turn=Number(coordinate.split('\0')[0]);if(!grouped.has(turn))grouped.set(turn,[]);grouped.get(turn).push(key)}return grouped}
 const keyMap=new Map()
 const sourceGroups=groupByTurn(sourceKeys),targetGroups=groupByTurn(targetKeys)
 for(const [turn,sourceValues] of sourceGroups){
  const targetValues=targetGroups.get(turn)||[]
  sourceValues.forEach((sourceKey,index)=>{
   const targetKey=targetValues[index]
   if(targetKey!==undefined && targetKey!==sourceKey)keyMap.set(turn+'\0'+sourceKey,targetKey)
  })
 }
 const refs=new Map()
 for(const {ref,data} of bundle.pluginAttachments || []) {
  const saved=ref.mediaType ? await deps.attachments.saveImage({data:new Uint8Array(data),mediaType:ref.mediaType,name:ref.name}) : await deps.attachments.saveFile({data:new Uint8Array(data),name:ref.name})
  refs.set(ref.attachmentId,saved)
 }
 const rollback=async()=>{
   const results=await Promise.allSettled([deps.pluginData.removeChat(identity.chatId),deps.pluginMedia.removeChat(identity.chatId)])
   const failures=results.filter(item=>item.status==='rejected').map(item=>item.reason)
   if(failures.length)throw new AggregateError(failures,'DB插件副数据清理不完整')
  }
 try {
  if(content.data)await deps.pluginData.importInto({source:content.data,targetChatId:identity.chatId,keyMap})
  if(content.media)await deps.pluginMedia.importInto({source:content.media,targetChatId:identity.chatId,targetSessionId:identity.sessionId,keyMap,attachment:ref=>refs.get(ref.attachmentId)||null})
  return {rollback}
 }catch(error){try{await rollback()}catch(cleanup){throw new AggregateError([error,cleanup],'DB插件数据恢复失败且清理不完整')}throw error}
}
