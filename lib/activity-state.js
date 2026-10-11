// 唯一活动判定内核：SQL窄行与作者timeline.inspect输入共用；不负责取数或状态写入。
export function activityFromSmallRows({ operations: operationsObject, branchId, revision, updatedAt } = {}) {
  const str = value => typeof value === 'string' ? value : (value == null ? '' : String(value))
  const allOperations = Object.values(operationsObject || {})
  const agents = allOperations.filter(operation => operation && operation.kind === 'agent')
    .sort((left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0))
  const running = agents.find(operation => operation.status === 'running')
  const body = allOperations.filter(operation => operation && operation.kind === 'body' &&
    (operation.status === 'foreground-completed' || operation.status === 'completed') && operation.background &&
    str(operation.committedBranchId || (operation.basedOn && operation.basedOn.branchId)) === branchId)
    .sort((left, right) => (Number(right.completedAt) || 0) - (Number(left.completedAt) || 0))[0]
  const background = body && body.background
  if (running === undefined && background && background.phase === 'failed') {
    return { phase: 'failed', busy: false, role: str(background.role), operationId: str(body.id), basedOn: null,
      updatedAt: Number(background.updatedAt) || 0, ...(background.reason ? { reason: str(background.reason) } : {}) }
  }
  if (running === undefined && background && (background.phase === 'pending' || background.phase === 'running')) {
    return { phase: background.phase, busy: background.phase === 'running', role: str(background.role), operationId: str(body.id),
      basedOn: { branchId, revision: Number(body.committedRevision) || revision },
      updatedAt: Number(background.updatedAt) || Number(body.completedAt) || 0 }
  }
  const current = running || agents[0]
  if (current === undefined) return { phase: 'idle', busy: false, role: '', operationId: '', basedOn: null, updatedAt: Number(updatedAt) || 0 }
  return {
    phase: running !== undefined ? 'running' : (current.status === 'failed' || (current.status === 'interrupted' && current.role === 'settlement') ? 'failed' : 'idle'),
    busy: running !== undefined, role: str(current.role), operationId: str(current.id), basedOn: current.basedOn || null,
    updatedAt: Number(current.completedAt) || Number(current.createdAt) || Number(updatedAt) || 0,
    ...(current.status === 'interrupted' && current.role === 'settlement' ? { reason: 'interrupted' } : {})
  }
}
