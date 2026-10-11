// wait:false不能从registry丢失仍在运行的任务；延迟交接任务可等待，不后台继续软清。
function once(source, old, next) {
  if (source.split(old).length !== 2) throw new Error('回退静止接缝锚点未命中/不唯一：'+old.slice(0,80))
  return source.replace(old,next)
}
export function applySettlementQuiescenceTransform(source) {
  const marker='// [dsh-tavern-settlement-quiescence:v1]'
  if (source.includes(marker)) {
    if (!source.includes('if (wait) await job.promise.catch(() => {})') || source.includes('if (!wait) jobs.delete(chatId)')) throw new Error('结算静止消费者不完整')
    return addSettlementIsBusy(source)
  }
  let next=marker+'\n'+once(source,'    if (!wait) jobs.delete(chatId)\n    else await job.promise.catch(() => {})','    if (wait) await job.promise.catch(() => {})')
  next=once(next,'      if (jobs.get(chatId) === job) jobs.delete(chatId)\n      // Cancellation/deletion', '      // Cancellation/deletion')
  next=once(next,'      if (!disposed && !signal.aborted) await onSettled(chatId, signal)', '      try { if (!disposed && !signal.aborted) await onSettled(chatId, signal) }\n      finally { if (jobs.get(chatId) === job) jobs.delete(chatId) }')
  return addSettlementIsBusy(next)
}
/**
 * 结算作业静止证明（生产转换内注入，不改离线作者）：`isBusy(chatId)` 只读 jobs Map 的归属查询。
 * 幂等：已带成员则原样返回；`return Object.freeze({ start, cancel, dispose })` 缺/重一律响亮拒（不猜作者布局）。
 */
function addSettlementIsBusy(source) {
  if (!source.includes('isBusy: chatId => jobs.has(chatId)')) {
    // 布局兼容：旧 `{ start, cancel, dispose }` 与新上游 7e349 `{ start, pending, cancel, dispose }`；
    // 两者**恰有一**命中才注入（保留 pending 与作者其余成员，绝不改回作者 run/取消语义）。
    const layouts=[
      '  return Object.freeze({ start, pending, cancel, dispose })',
      '  return Object.freeze({ start, cancel, dispose })',
    ]
    const hits=layouts.filter(layout=>source.split(layout).length===2)
    if(hits.length!==1)throw new Error('结算静止接缝返回锚点未命中/不唯一（旧/新布局恰需其一）：'+layouts.join(' | '))
    source=once(source,hits[0],hits[0].replace(', dispose })',', dispose, isBusy: chatId => jobs.has(chatId) })'))
  }
  if(!source.includes('onIdle = () => {}')) {
    source=once(source,'createSettlementJobs({ run, onSettled })','createSettlementJobs({ run, onSettled, onIdle = () => {} })')
    source=once(source,'finally { if (jobs.get(chatId) === job) jobs.delete(chatId) }','finally { if (jobs.get(chatId) === job) { jobs.delete(chatId); if (!disposed) onIdle(chatId) } }')
  }
  return source
}
function addForegroundIdleSignal(source) {
  if(source.includes('options.onIdle?.(sessionId)'))return source
  return once(source,'.finally(function () { pending.delete(task); settle() })','.finally(function () { pending.delete(task); settle(); try { options.onIdle?.(sessionId) } catch (error) { logger.error(\'dsh-tavern: 静止通知失败\', error) } })')
}
export function applyForegroundQuiescenceTransform(source) {
  const marker='// [dsh-tavern-foreground-quiescence:v1]'
  if (source.includes(marker)) {
    if (!source.includes('async function whenIdle(sessionId)') || !source.includes('pending.set(task, sessionId)')) throw new Error('前台延迟任务静止消费者不完整')
    if(source.includes('function isBusy(sessionId)') && source.includes('whenIdle, isBusy })'))return addForegroundIdleSignal(source)
    let upgraded=once(source,'  const pending = new Map()','  const pending = new Map()\n  function isBusy(sessionId) { return [...pending.values()].includes(sessionId) }')
    return addForegroundIdleSignal(once(upgraded,'whenIdle })','whenIdle, isBusy })'))
  }
  const old=`  function later(work, label) {
    defer(function () {
      Promise.resolve().then(work).catch(function (error) {
        logger.error('dsh-tavern: ' + label + '失败', error && error.message || error)
      })
    })
  }`
  const next=`  const pending = new Map()
  function later(work, label, sessionId) {
    let settle
    const task = new Promise(resolve => { settle = resolve })
    pending.set(task, sessionId)
    defer(function () {
      Promise.resolve().then(work).catch(function (error) {
        logger.error('dsh-tavern: ' + label + '失败', error && error.message || error)
      }).finally(function () { pending.delete(task); settle() })
    })
  }
  async function whenIdle(sessionId) {
    while (true) {
      const active = [...pending].filter(([, id]) => id === sessionId).map(([task]) => task)
      if (!active.length) return
      await Promise.all(active)
    }
  }
  // 只读成员：前台该 session 是否还有未完成的延迟交接任务（静止证明用，不新增服务/事件/轮询）。
  function isBusy(sessionId) { return [...pending.values()].includes(sessionId) }`
  let out=marker+'\n'+once(source,old,next)
  out=once(out,"      }, '启动后台结算')", "      }, '启动后台结算', input.sessionId)")
  out=once(out,"    }, '清理未完成前台回合')", "    }, '清理未完成前台回合', input.sessionId)")
  out=once(out,'      if (cleanupFailedTurn !== null) await cleanupFailedTurn(target)', '      // 失败尾部保留至用户统一物理回退；禁止追加空tombstone冒充删除。')
  out=once(out,'  return Object.freeze({ prepare, finalize, end, recover })','  return Object.freeze({ prepare, finalize, end, recover, whenIdle, isBusy })')
  return addForegroundIdleSignal(out)
}
