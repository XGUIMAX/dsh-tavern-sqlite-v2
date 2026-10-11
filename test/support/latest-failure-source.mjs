// T3 共享：**只读**作者源码（不复制有限树、不注册测试、不建 Session/DB）。
// 来源仍是 fixtures/comment-author-tree.mjs 的显式来源（env DSH_TAVERN_TEST_APP 优先，其次本地 author-fixture）；
// 与 prepareCommentAuthorTree 的差别：这里直接从作者源树按路径读文本并缓存，不做任何 mkdtemp 复制。
// 组合顺序只有一种正确写法（pending → latest），由 composedFailureViewText 统一提供；
// **首跑/负例仍必须拿原始文本**（readLatestFailureSource），不得把已施缝文本误送给检验首跑转换的负例。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { commentAuthorTreeSource } from '../fixtures/comment-author-tree.mjs'

export const VIEW_REL = 'tavern-plugin/lib/domain/chat-session-state.js'
export const INDEX_REL = 'tavern-plugin/lib/index.js'

/** 准备次数计数（证明复用效果）：sourceReads 实际读盘次数、pathHits 命中缓存、treeCopies 有限树复制次数、composedBuilds 组合次数。 */
export const metrics = { sourceReads: 0, pathHits: 0, treeCopies: 0, composedBuilds: 0 }

const rawCache = new Map()
const rawErrors = new Map()
let rootCache = null
let rootError = null
let composedPromise = null

/** 作者源树根（显式来源；缺失就响亮失败，不 skip、不假 pass）。**只解析一次**，避免中途 env/来源漂移；缺根也缓存同一 error。 */
export function authorSourceRoot() {
  if (rootError !== null) throw rootError
  if (rootCache !== null) return rootCache
  const root = commentAuthorTreeSource()
  if (!root) { rootError = new Error('缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture'); throw rootError }
  rootCache = root
  return root
}

/** 按路径读作者原文（同一路径只读盘一次；失败也按 path 缓存**同一个 error**，不反复重试掩盖现场）。 */
export function readLatestFailureSource(rel) {
  if (rawErrors.has(rel)) throw rawErrors.get(rel)
  if (rawCache.has(rel)) { metrics.pathHits += 1; return rawCache.get(rel) }
  try {
    const text = readFileSync(path.join(authorSourceRoot(), rel), 'utf8')
    rawCache.set(rel, text)
    metrics.sourceReads += 1
    return text
  } catch (error) {
    rawErrors.set(rel, error)
    throw error
  }
}

/** 有限树复制计数（由仍需要真 appDir 的装卸用例调用；只读消费者不再复制）。 */
export function bumpTreeCopy() { metrics.treeCopies += 1 }

/**
 * 真变换产物（正确顺序：先 pending 视图，再 latest-failure 视图）——缓存**promise**：并发调用共用同一次组合，
 * 不会重复组合；失败也保留同一 rejected promise，后续消费者不重跑变换。
 * 需要检验"首跑转换/缺块拒绝"的地方请用 readLatestFailureSource 的原文，不要用这里。
 */
export function composedFailureViewText() {
  if (composedPromise !== null) return composedPromise
  composedPromise = (async () => {
    const { applyRollbackPendingViewTransform } = await import('../../deploy/rollback-pending-view-transform.mjs')
    const { applyLatestFailureViewTransform } = await import('../../deploy/latest-failure-transform.mjs')
    const text = applyLatestFailureViewTransform(applyRollbackPendingViewTransform(readLatestFailureSource(VIEW_REL)))
    metrics.composedBuilds += 1
    return text
  })()
  return composedPromise
}

/** 只读消费者共用的取文本入口（等价旧 read(tree, rel)，但不起有限树）。 */
export const readAuthorSource = readLatestFailureSource
