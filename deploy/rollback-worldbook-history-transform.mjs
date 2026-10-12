// V2本档历史书引用只接到时间线恢复及物理回退，不改模型/Helper当前书接口。
const MARKER='// [dsh-tavern-worldbook-history-host:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('本档书历史接线锚点未命中/不唯一：'+old);return source.replace(old,next)}
export function applyRollbackWorldbookHistoryHostTransform(source){
 if(source.includes(MARKER)){
  // 旧 marker（只有世界书两读口）必须能升级到含前像读口，而不是直接拒绝。
  let next=source
  const timelineReader='readRollbackOperationSnapshot: (chat, ref) => chatJournalStore.readRollbackOperationSnapshot(chat, ref)'
  if(!next.includes(timelineReader)){
   next=once(next,'readRollbackWorldbookRef: chat => chatJournalStore.readCurrentRollbackWorldbookRef(chat)','readRollbackWorldbookRef: chat => chatJournalStore.readCurrentRollbackWorldbookRef(chat), '+timelineReader)
  }
  const chatsReader='readRollbackWorldbook: chatJournalStore.readRollbackWorldbook, readRollbackOperationSnapshot: chatJournalStore.readRollbackOperationSnapshot }'
  if(!next.includes(chatsReader)){
   next=once(next,'readRollbackWorldbook: chatJournalStore.readRollbackWorldbook },','readRollbackWorldbook: chatJournalStore.readRollbackWorldbook, readRollbackOperationSnapshot: chatJournalStore.readRollbackOperationSnapshot },')
  }
  // 完整性必须钉在**原始回调文本**上：includes 弱子串会让被替换/篡改的 ref 接线漏过去。
  if(!next.includes('readRollbackWorldbookRef: chat => chatJournalStore.readCurrentRollbackWorldbookRef(chat)'))throw Error('本档书历史接线标记不完整：缺原始当前书 ref 回调')
  if(!next.includes('readRollbackWorldbook: chatJournalStore.readRollbackWorldbook'))throw Error('本档书历史接线标记不完整：缺原始当前书读取回调')
  return next
 }
 let next=MARKER+'\n'+source
 next=once(next,'createStoryTimeline({ id: uid, now: Date.now })','createStoryTimeline({ id: uid, now: Date.now, readRollbackWorldbook: (chat, ref) => chatJournalStore.readRollbackWorldbook(chat, ref), readRollbackWorldbookRef: chat => chatJournalStore.readCurrentRollbackWorldbookRef(chat), readRollbackOperationSnapshot: (chat, ref) => chatJournalStore.readRollbackOperationSnapshot(chat, ref) })')
 return once(next,'rollbackArchivePath: chatJournalStore.rollbackArchivePath },','rollbackArchivePath: chatJournalStore.rollbackArchivePath, readRollbackWorldbook: chatJournalStore.readRollbackWorldbook, readRollbackOperationSnapshot: chatJournalStore.readRollbackOperationSnapshot },')
}
