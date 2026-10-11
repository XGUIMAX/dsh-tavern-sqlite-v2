// 只读失败尾判定：正文操作沿既有基准回退；纯守卫或有无输出证据的请求扩展准备错误可物理清一轮。
// 无基准不能用当前业务值冒充历史；请求扩展可能在正文准备之后失败，必须额外证明本档没有该轮业务写入。
import { ledgerFailureState } from './failure-state.js'
export const FAILED_BODY_PREPARATION_ERROR = '失败正文必须先统一物理清理，再准备新回合；禁止直接重试覆盖回退基准'
export const REQUEST_EXTENSION_PREPARATION_ERROR = 'DeepSeek request extension preparation failed'
const EMPTY_TAIL_EVENTS = new Set(['turn/start', 'turn/end', 'user/message', 'agent/inbox/spliced', 'session/end-seed'])
const REQUEST_PREPARATION_EVENTS = new Set([...EMPTY_TAIL_EVENTS, 'step/start', 'step/end', 'request/header', 'system/message', 'assistant/attempt'])
function isRequestPreparationError(error) {
  return error?.code === 'REQUEST_EXTENSION' && error.message === REQUEST_EXTENSION_PREPARATION_ERROR
}
// 只接受宿主已落盘的终止错误帧；任何开始/文本/思考/工具/未知帧均不能冒认未发请求。
function isEmptyPreparationAttempt(event, turn) {
  if (event.data?.turn !== turn || event.data.step !== 1 || !Array.isArray(event.data.stream) || event.data.stream.length !== 1) return false
  const frame = event.data.stream[0]
  const chunk = frame?.type === 'chunk' ? frame.chunk : null
  return chunk?.type === 'finish' && chunk.reason?.kind === 'error' && isRequestPreparationError(chunk.reason.failure)
}
// 作者清除上一轮临时上下文时替换旧 foreground-frame；引用必须全部留在前轮，截尾后按保留前缀重折。
function isPriorForegroundReplacement(event, events, boundaryIndex, turn, chatId) {
  const source = event.data?.source, op = event.surfaceOp
  if (event.type !== 'user/message' || source?.kind !== 'plugin' || source.plugin !== 'dsh-tavern'
    || source.form !== 'foreground-frame' || source.trace?.chatId !== chatId
    || event.data.role !== 'user' || !Array.isArray(event.data.content) || event.data.content.length !== 0
    || !Number.isSafeInteger(source.trace?.turn) || source.trace.turn >= turn
    || typeof source.trace.operationId !== 'string' || !source.trace.operationId
    || typeof source.trace.frameId !== 'string' || !source.trace.frameId
    || op?.op !== 'replace' || !Number.isSafeInteger(op.startSeq) || op.startSeq !== op.endSeq
    || op.startSeq < 0 || op.startSeq > boundaryIndex
    || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length !== 1 || event.sourceEventSeqs[0] !== op.startSeq) return false
  const previous = events[op.startSeq], owner = previous?.data?.source
  return previous?.type === 'user/message' && previous.surfaceOp === 'append'
    && owner?.kind === 'plugin' && owner.plugin === 'dsh-tavern'
    && owner.form === 'foreground-frame' && owner.trace?.chatId === chatId
    && owner.trace?.operationId === source.trace.operationId && owner.trace?.turn === source.trace.turn
    && owner.trace?.frameId === source.trace.frameId && owner.trace?.branchId === source.trace.branchId
    && owner.trace?.basedOnRevision === source.trace.basedOnRevision
}
const TURN_FIELDS = ['runtimeInputs', 'foregroundFrames', 'nativeCommits', 'pendingCardChanges', 'compatibilityTraces', 'historyRecallCooldowns', 'taskMailbox', 'worldBookReads']
const SINGLE_TURN_FIELDS = ['foregroundError', 'promptTemplateInput', 'promptTemplateInitialVariables', 'lastSettle', 'lastWorldBookRecall', 'preparedWorldBook', 'worldBookRandomState', 'contextCompaction', 'candidateAgent']

export function inspectNativeFailureTail(chat, evidence, revision = chat?._storageRevision) {
  const events = evidence?.events ?? evidence?.session?.snapshotEvents?.()
  if (!Array.isArray(events) || events.length === 0) return null
  let turn = 0
  for (const event of events) if (Number.isSafeInteger(event?.data?.turn) && event.data.turn > 0) turn = event.data.turn
  if (!turn) return null
  const endSeq = events.at(-1)?.seq
  const info = { turn, endSeq, eventCount: events.length, cleanable: false, reason: '', target: null }
  const blocked = reason => ({ ...info, reason })
  if (events.some((event, index) => event?.seq !== index)) return blocked('原生事件坐标不连续，不能安全清理失败尾')
  if (!chat || typeof chat.id !== 'string' || !chat.id || typeof chat.sessionId !== 'string' || !chat.sessionId
    || typeof chat.timeline?.branchId !== 'string' || !chat.timeline.branchId || !Number.isSafeInteger(revision) || revision < 0) return blocked('失败清理缺少本档身份、分支或版本')
  if (evidence?.session?.header?.id !== undefined && evidence.session.header.id !== chat.sessionId) return blocked('失败清理原生会话身份不一致')
  if (evidence?.header?.id !== undefined && evidence.header.id !== chat.sessionId) return blocked('失败清理原生观察身份不一致')
  if (Number(evidence?.nativeFailureCheckpointTurn) >= turn) return blocked('该轮已有成功检查点，不能清理错误尾')
  const operations = Object.values(chat.timeline.operations || {})
  const endIndex = events.findLastIndex(event => event.type === 'turn/end' && event.data?.turn === turn)
  const ending = events[endIndex]
  if (ending?.data?.reason?.kind === 'completed') return info
  // 有 body 就必须沿业务基准路径，绝不因为基准缺失改判为空轮。
  if (operations.some(op => op?.kind === 'body' && Number(op.turn) === turn)) return blocked('当前失败正文须按该轮业务回退基准清理')
  const preparationError = isRequestPreparationError(ending?.data?.reason?.error)
  if (ending?.data?.reason?.kind !== 'error' || (!preparationError && ending.data.reason.error?.message !== FAILED_BODY_PREPARATION_ERROR)) return blocked('最新轮不是可证明未进入正文准备的守卫错误，不能无基准清理')
  if (events.slice(endIndex + 1).some(event => event.type !== 'session/end-seed')) return blocked('失败结束后已有新事件，清理目标已变化')
  const startIndex = events.findLastIndex(event => event.type === 'turn/start' && event.data?.turn === turn)
  if (startIndex < 0 || startIndex >= endIndex) return blocked('失败轮缺少完整原生开始/结束边界')
  let boundaryIndex = -1
  for (let index = 0; index < startIndex; index++) {
    const event = events[index]
    if (event.type === 'turn/end' && Number(event.data?.turn) < turn) boundaryIndex = index
  }
  if (boundaryIndex < 0) return blocked('空错误轮缺少可保留的前轮边界')
  for (let index = boundaryIndex + 1; index < startIndex; index++) if (events[index].type === 'session/end-seed') boundaryIndex = index
  const tail = events.slice(boundaryIndex + 1)
  const allowedEvents = preparationError ? REQUEST_PREPARATION_EVENTS : EMPTY_TAIL_EVENTS
  if (tail.some(event => {
    if (preparationError && isPriorForegroundReplacement(event, events, boundaryIndex, turn, chat.id)) return false
    return !allowedEvents.has(event.type)
      || (event.data?.turn !== undefined && event.data.turn !== turn)
      || (preparationError && event.data?.step !== undefined && event.data.step !== 1)
      || (event.surfaceOp !== undefined && (!(preparationError ? ['user/message', 'system/message'] : ['user/message']).includes(event.type) || event.surfaceOp !== 'append'))
      || (Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length > 0)
      || (event.type === 'assistant/attempt' && !isEmptyPreparationAttempt(event, turn))
      || (preparationError && event.type === 'user/message' && event.data?.source?.kind !== 'user')
  })) return blocked('失败尾含正文、工具执行、替换引用或其他轮事件，不能按空错误清理')
  if (preparationError) {
    const starts = tail.filter(event => event.type === 'step/start'), ends = tail.filter(event => event.type === 'step/end')
    const attempts = tail.filter(event => event.type === 'assistant/attempt')
    if (starts.length !== 1 || ends.length !== 1 || attempts.length !== 1
      || starts[0].data?.turn !== turn || starts[0].data.step !== 1 || ends[0].data?.turn !== turn || ends[0].data.step !== 1
      || starts[0].seq <= events[startIndex].seq || starts[0].seq >= attempts[0].seq
      || attempts[0].seq >= ends[0].seq || ends[0].seq >= ending.seq) return blocked('请求扩展失败缺少唯一第一步与无输出终止证据，不能无基准清理')
  }
  if (tail.filter(event => event.type === 'turn/start').length !== 1 || tail.filter(event => event.type === 'turn/end').length !== 1) return blocked('失败尾不是单一完整轮次，不能跨轮清理')
  // 旧失败正文仍在就是守卫的已知触发条件；不把其他原因的 native error 猜成无业务副作用。
  if (!preparationError && !ledgerFailureState(chat).ledgerFailed.some(failedTurn => failedTurn < turn)) return blocked('缺少触发正文准备守卫的前轮失败操作')
  if (operations.some(op => Number(op?.turn) >= turn)) return blocked('该失败轮已有任务操作，不能按空错误清理')
  if ((chat.messages || []).some(row => Number(row?.turn) >= turn)) return blocked('该失败轮已有正文行，不能按空错误清理')
  if ((chat.timeline.checkpoints || []).some(cp => Number(cp?.turn) >= turn)) return blocked('该轮已有成功检查点，不能清理错误尾')
  if (Object.keys(chat.rollbackSessionCuts || {}).some(owner => Number(owner) >= turn)
    || Object.values(chat.timeline.participants || {}).some(participant => Number(participant?.turn) >= turn)) return blocked('该失败轮已有后台参与者推进，不能按空错误清理')
  if (TURN_FIELDS.some(key => {
    const value = chat[key]
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([id, item]) => Number(item?.turn ?? (/^\d+$/.test(id) ? id : NaN)) >= turn)
  }) || SINGLE_TURN_FIELDS.some(key => Number(chat[key]?.turn) >= turn)
    || Object.entries(chat.regeneratedDshTurns || {}).some(([owner, actual]) => Number(owner) >= turn || Number(actual) >= turn)) return blocked('该失败轮已有业务运行数据，不能按空错误清理')
  const target = { kind: 'native-only', chatId: chat.id, sessionId: chat.sessionId, turn, branchId: chat.timeline.branchId, revision, endSeq, eventCount: events.length }
  return { ...info, cleanable: true, target }
}
