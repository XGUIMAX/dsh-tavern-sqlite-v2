// S4 四宿主消费者共享准备：真实作者 fixture → 施缝 → 懒取 ACTIVE 投影文本。
// 规则（T1 第一步，只抽准备、不动测试定义）：① 同步 ACTIVE text 懒一次并缓存；② 失败缓存同一 error，不重新准备；
// ③ cleanup 交调用方注册（如 test.after），由本模块记账；④ 暴露 metrics 供"准备次数"核对；⑤ 无选中测试就不会调用本模块 ⇒ 不 prepare。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { activeSource, prepareCommentAuthorTree } from '../fixtures/comment-author-tree.mjs'
import { applyStandardSeams } from '../../deploy/standard-seams.mjs'

export const nativeS4Metrics = { preparations: 0, cacheHits: 0, failures: 0, cleanups: 0 }

/**
 * @param {{index: string, authorVersion?: string, isNativeDataApplied: (text: string) => boolean, registerCleanup?: (fn: () => void) => void, label?: string}} options
 * @returns {{seamSource: () => string, metrics: {preparations:number,cacheHits:number,failures:number,cleanups:number}}}
 */
export function createNativeS4Prepare({ index, authorVersion, isNativeDataApplied, registerCleanup, label = 's4', metrics = nativeS4Metrics }) {
  let cached = null
  let failure = null
  return {
    metrics,
    seamSource() {
      if (cached !== null) { metrics.cacheHits += 1; return cached }
      if (failure !== null) { metrics.cacheHits += 1; throw failure }   // 同 error 原样抛出，不重新准备
      try {
        metrics.preparations += 1
        const tree = prepareCommentAuthorTree()
        assert.ok(tree, '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
        const cleanup = () => { metrics.cleanups += 1; tree.cleanup() }   // 只删 helper 自己的 mkdtemp 目录
        if (typeof registerCleanup === 'function') registerCleanup(cleanup)
        const indexFile = path.join(tree.appDir, ...index.split('/'))
        assert.equal(isNativeDataApplied(readFileSync(indexFile, 'utf8')), false, '前置：作者原字节不应已应用 native-data 转换')
        assert.equal(applyStandardSeams({ appDir: tree.appDir, authorVersion, assertStopped: () => true }).changed, true, label + '：真实施缝必须实际改动')
        const seamed = readFileSync(indexFile, 'utf8')
        assert.equal(isNativeDataApplied(seamed), true, '装配后实际 index 必须已应用 native-data 转换')
        // 切缝副本只取 ACTIVE 投影：ORIGINAL 区是注释掉的作者原文，直接切片会撞锚点/重复声明。
        // 先算 ACTIVE、先校验，**之后**才落 cached：否则校验抛错被"第二次 if (cached) return"绕过 ⇒ 首次失败被冒称成功。
        const active = activeSource(seamed, index)
        assert.equal(isNativeDataApplied(active), true, 'ACTIVE 投影必须保留 native-data 生成标记')
        cached = active
        return cached
      } catch (error) {
        metrics.failures += 1
        failure = error
        throw error
      }
    },
  }
}
