// 冷视图失败证据（只读）：失败清理目标需要**真实原生 events**，而作者 sessionDebugEvidence 只查已装载注册表
// （index.js:1484-1498：sessions.get(id) / agentRegistry），冷档返回 {loaded:false, events:[]} ⇒ inspector 只能回 null。
// 本模块只做一件事：live 就用 live；cold 就经宿主只读观察口取一次 lease，读完必须释放。
// 不建 Agent/Session、不调 loadRollbackSession/assertWritable、不读归档、不写库、不做通用缓存（不造第二权威）。
const DISPOSE = Symbol.dispose

/** live 判定：loaded !== false 且确实带已装载 Session（snapshotEvents/events）。空事件也算 live（新会话合法为空），不再观察。 */
export function isLiveFailureEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || evidence.loaded === false) return false
  const session = evidence.session
  return Boolean(session && (typeof session.snapshotEvents === 'function' || Array.isArray(session.events)))
}

/** 宿主只读观察口是冷视图的**必需**能力：缺就响亮失败，绝不退回收窄摘要冒充失败尾。 */
export function requireFailureEvidenceQuery(query) {
  if (!query || typeof query.observeSession !== 'function') throw new Error('冷视图失败证据缺少宿主只读观察接口 sessionQuery.observeSession')
  return query
}

/**
 * 取失败证据：live 原样返回；cold 用 query.observeSession(id,{projectionMode:'none'}) 取 lease。
 * lease 形状 {header, events, [Symbol.dispose]}（`sessionQuery.observeSession` 真身不公开 surface/nodes，
 * 见 @deepseek-ai/dsh-session-query SessionObservationReader.preparedLease/live）⇒ 冷档在释放前用宿主注入的
 * **真 fold** 推导 `nodes`（当前模型面 seq 列表，唯一权威仍是 events）并随证据返回；作者 2.5 `rollbackViewFields`
 * 经 `applyLatestFailureViewTransform` 的 `session?.surface?.nodes ?? evidence.nodes` 消费它。
 * 释放必须在 finally 真调用且**不吞异常**；缺释放方法在读取前即抛（避免半观察泄漏）。
 * @param {{loaded?:boolean,session?:object,events?:unknown[]}} liveEvidence 作者 sessionDebugEvidence(sessionId, true)
 * @param {{observeSession?:Function}} query 宿主 sessionQuery
 * @param {string} sessionId
 * @param {(sessionId:string, events:unknown[])=>(number[]|undefined)} [deriveSurfaceNodes] 宿主真实 foldSurface 返回的有序 nodes
 */
export async function readFailureEvidence(liveEvidence, query, sessionId, deriveSurfaceNodes = undefined) {
  const id = typeof sessionId === 'string' ? sessionId : ''
  if (id === '') throw new Error('冷视图失败证据缺少 sessionId')
  if (isLiveFailureEvidence(liveEvidence)) return liveEvidence
  const source = requireFailureEvidenceQuery(query)
  const observation = await source.observeSession(id, { projectionMode: 'none' })
  if (!observation || typeof observation !== 'object' || typeof observation[DISPOSE] !== 'function') {
    throw new Error('宿主只读观察 lease 不合法：缺少释放方法')
  }
  try {
    // 身份与形状校验必须在 try 内：异身份/非数组同样要先释放 lease（不得半观察泄漏）。
    const header = observation.header
    if (!header || header.id !== id) throw new Error('宿主只读观察会话身份不一致：' + String(header && header.id))
    if (!Array.isArray(observation.events)) throw new Error('宿主只读观察未返回事件数组')
    const evidence = { sessionId: id, loaded: true, events: observation.events, header, session: null }
    if (typeof deriveSurfaceNodes === 'function') {
      const nodes = deriveSurfaceNodes(id, observation.events)
      if (nodes !== undefined) {
        // 真 fold 返回当前模型面 seq 列表；形状不合法即拒绝：不可信节点不得进入作者可用性判定。
        if (!Array.isArray(nodes) || nodes.some(seq => !Number.isSafeInteger(seq))) throw new Error('冷视图失败证据节点推导未返回合法 seq 列表')
        // 普通可枚举属性：作者消费方（窗口投影等）会 spread 证据对象，非枚举字段会在 spread 时丢失。
        evidence.nodes = nodes
      }
    }
    return evidence
  } finally {
    // 释放恰一次、不吞异常；校验/推导失败也先释放再抛出。
    observation[DISPOSE]()
  }
}
