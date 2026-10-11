// 业务接线结果→局部最小区块：**按行 Myers 差分**（含 D 资源上限与 patience 回退），
// 仅用 Acorn 的**位置范围**把差分两端提升到最近独立完整语句边界（不做等价/指纹比较、不 stringify、不深拷）。
// anchor 为 JS UTF-16 offset（与 String.prototype.slice 一致，不是字节）；body 为 after 对应文本；删除＝mode:'replace' + body:''。
import { parse } from '../lib/vendor/acorn/acorn.mjs'

const MAX_D = 1200 // Myers trace 深度上限（超限转 patience 唯一行分段，不吞整文件）
const lineStart = (s, i) => s.lastIndexOf('\n', i - 1) + 1
const lineEnd = (s, i) => { const n = s.indexOf('\n', i); return n < 0 ? s.length : n + 1 }
const splitLines = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
const offsets = lines => { const out = new Array(lines.length + 1); out[0] = 0; for (let i = 0; i < lines.length; i++) out[i + 1] = out[i] + lines[i].length; return out }
const lineOf = (offs, offset) => { let lo = 0, hi = offs.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= offset) lo = mid; else hi = mid - 1 } return lo }

/** 只看**位置**的语法事实：容器子语句范围 + 不可注入跨度（注释/模板/字符串/正则）。 */
function locate(source) {
  const comments = []
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, onComment: comments })
  const ranges = []
  const opaque = comments.map(c => ({ start: c.start, end: c.end, comment: true }))
  const items = (node, keys) => {
    const list = []
    for (const key of keys) if (Array.isArray(node[key])) for (const child of node[key]) if (child && typeof child.start === 'number') list.push({ start: child.start, end: child.end })
    return list
  }
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (typeof node.start === 'number' && typeof node.end === 'number') {
      if (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock') ranges.push({ start: node.start, end: node.end, items: items(node, ['body']) })
      else if (node.type === 'SwitchCase') ranges.push({ start: node.start, end: node.end, items: items(node, ['consequent']) })
      else if (node.type === 'SwitchStatement') ranges.push({ start: node.start, end: node.end, items: items(node, ['cases']) })
      else if (node.type === 'ClassBody') ranges.push({ start: node.start, end: node.end, items: items(node, ['body']) })
      if (node.type === 'TemplateLiteral' || (node.type === 'Literal' && (typeof node.value === 'string' || node.regex !== undefined))) opaque.push({ start: node.start, end: node.end })
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
      if (value && typeof value === 'object') visit(value)
    }
  }
  visit(ast)
  return { ranges, opaque }
}
const CAP = Symbol('cap')
/** Myers O((N+M)·D)（trace 快照，非 N×M 矩阵）；D 超上限抛 CAP 供 patience 分段。 */
function myersMatches(a, b, alo, ahi, blo, bhi) {
  const n = ahi - alo, m = bhi - blo
  const v = new Map([[1, 0]])
  const trace = []
  const limit = Math.min(n + m, MAX_D)
  for (let d = 0; d <= limit; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[alo + x] === b[blo + y]) { x++; y++ }
      v.set(k, x)
      if (x >= n && y >= m) return backtrack(trace, a, b, alo, blo, n, m)
    }
  }
  throw CAP
}
function backtrack(trace, a, b, alo, blo, n, m) {
  let x = n, y = m
  const matches = []
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d]
    const k = x - y
    const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))
    const prevK = down ? k + 1 : k - 1
    const prevX = v.get(prevK) ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { matches.push([alo + x - 1, blo + y - 1]); x--; y-- }
    x = prevX; y = prevY
  }
  while (x > 0 && y > 0 && a[alo + x - 1] === b[blo + y - 1]) { matches.push([alo + x - 1, blo + y - 1]); x--; y-- }
  return matches.reverse()
}
/** patience：唯一非空行锚点（b 侧单调），用于超限区段再分段。 */
function patienceAnchors(a, b, alo, ahi, blo, bhi) {
  const countA = new Map(), countB = new Map(), posB = new Map()
  for (let i = alo; i < ahi; i++) countA.set(a[i], (countA.get(a[i]) ?? 0) + 1)
  for (let j = blo; j < bhi; j++) { const line = b[j]; countB.set(line, (countB.get(line) ?? 0) + 1); if (!posB.has(line)) posB.set(line, j) }
  const out = []
  let last = -1
  for (let i = alo; i < ahi; i++) {
    const line = a[i]
    if (/^\s*$/.test(line) || countA.get(line) !== 1 || countB.get(line) !== 1) continue
    const j = posB.get(line)
    if (j > last) { out.push([i, j]); last = j }
  }
  return out
}
function diffRegion(a, b, alo, ahi, blo, bhi, rel) {
  if (alo >= ahi || blo >= bhi) return []
  let matches
  try { matches = myersMatches(a, b, alo, ahi, blo, bhi) } catch (error) {
    if (error !== CAP) throw error
    const anchors = patienceAnchors(a, b, alo, ahi, blo, bhi)
    if (!anchors.length) throw Error('差分超出资源上限且区段内无唯一行可分段，拒绝生成整文件块：' + rel)
    const out = []
    let ca = alo, cb = blo
    for (const [ai, bi] of anchors) {
      out.push(...diffRegion(a, b, ca, ai, cb, bi, rel), [ai, bi])
      ca = ai + 1; cb = bi + 1
    }
    out.push(...diffRegion(a, b, ca, ahi, cb, bhi, rel))
    return out
  }
  return matches
}
/**
 * 按位置把 [start,end) 提升到最近独立完整语句**行边界**。
 * 注释跨度由语句提升覆盖；模板/字符串/正则**先尝试提升到包住它的最近完整语句**，包不住才拒。
 */
function promote(source, layout, start, end, rel) {
  const fallback = { start: lineStart(source, start), end: lineEnd(source, Math.max(start, end - 1)) }
  let best = null
  for (const range of layout.ranges) {
    if (range.start <= start && end <= range.end && (!best || range.end - range.start < best.end - best.start)) best = range
  }
  if (best) {
    let first = null, last = null
    for (const item of best.items) {
      if (item.end <= start) continue
      if (item.start >= end) break
      if (!first) first = item
      last = item
    }
    if (first) return { start: lineStart(source, Math.min(start, first.start)), end: lineEnd(source, Math.max(start, end - 1, last.end - 1)) }
  }
  for (const span of layout.opaque) {
    if (span.comment) continue
    const overlaps = span.start < end && span.end > start
    const covers = start <= span.start && end >= span.end
    if (overlaps && !covers) throw Error('差分区间落在模板/字符串内部且无法提升到完整语句，拒绝：' + rel)
  }
  return fallback
}
/** 提升后的行索引区间；空区间原样返回（零宽，绝不吞下一行）。 */
function settle(source, layout, offs, start, end, rel) {
  if (start === end) { const at = lineOf(offs, start); return { from: at, to: at } }
  const promoted = promote(source, layout, start, end, rel)
  const from = lineOf(offs, promoted.start), to = lineOf(offs, promoted.end)
  return to > from ? { from, to } : { from: lineOf(offs, start), to: lineOf(offs, end) }
}

/**
 * 最小多段区块（insert/replace；删除按要求落 replace + body:''）。
 * 两端用 Myers 共同行对映射同步扩大，直到 A/B 都停在独立完整语句边界 ⇒ 中间不变行不会丢。
 * @returns {Array<{format:1,revision:1,owner:string,id:string,mode:'insert'|'replace',purpose:string,anchor:{type:'TextRange',start:number,end:number},body:string}>}
 */
export function describeSeamChanges(before, after, { rel = 'source.js', owner } = {}) {
  if (typeof before !== 'string' || typeof after !== 'string') throw Error('差分输入必须是字符串：' + rel)
  if (typeof owner !== 'string' || owner === '') throw Error('差分必须给出 owner')
  const a = splitLines(before), b = splitLines(after)
  if (!a.length || !b.length) throw Error('空源码不能作差分基准：' + rel)
  const offA = offsets(a), offB = offsets(b)
  const layoutA = locate(before), layoutB = locate(after)
  const matches = diffRegion(a, b, 0, a.length, 0, b.length, rel)
  const hunks = []
  let ai = 0, bi = 0
  const push = (aEnd, bEnd) => {
    if (aEnd === ai && bEnd === bi) return
    const empty = aEnd === ai && bEnd === bi
    if (empty) return
    let aSide = ai === aEnd ? { from: ai, to: ai } : settle(before, layoutA, offA, offA[ai], offA[aEnd], rel)
    let bSide = bi === bEnd ? { from: bi, to: bi } : settle(after, layoutB, offB, offB[bi], offB[bEnd], rel)
    for (let round = 0; round < 4; round++) {
      const f0 = aSide.from, t0 = aSide.to, g0 = bSide.from, h0 = bSide.to
      const prev = [...matches].reverse().find(([mi,mj]) => mi < aSide.from && mj < bSide.from)
      const next = matches.find(([mi,mj]) => mi >= aSide.to && mj >= bSide.to)
      // 对齐两端扩张跨过的匹配行，既保共同行，也涵盖被多个差分共享的新增行。
      if (aSide.from < ai || bSide.from < bi) {
        aSide.from = prev ? prev[0] + 1 : 0; bSide.from = prev ? prev[1] + 1 : 0
      }
      if (aSide.to > aEnd || bSide.to > bEnd) {
        aSide.to = next ? next[0] : a.length; bSide.to = next ? next[1] : b.length
      }
      for (const [mi, mj] of matches) {
        const inA = mi >= aSide.from && mi < aSide.to
        const inB = mj >= bSide.from && mj < bSide.to
        if (inA && !inB) bSide = { from: Math.min(bSide.from, mj), to: Math.max(bSide.to, mj + 1) }
        if (inB && !inA) aSide = { from: Math.min(aSide.from, mi), to: Math.max(aSide.to, mi + 1) }
      }
      if (aSide.from !== ai || aSide.to !== aEnd) aSide = settle(before, layoutA, offA, offA[aSide.from], offA[aSide.to], rel)
      if (bSide.from !== bi || bSide.to !== bEnd) bSide = settle(after, layoutB, offB, offB[bSide.from], offB[bSide.to], rel)
      if (f0 === aSide.from && t0 === aSide.to && g0 === bSide.from && h0 === bSide.to) break
    }
    const aStart = offA[aSide.from], aStop = offA[aSide.to]
    const bStart = offB[bSide.from], bStop = offB[bSide.to]
    const body = after.slice(bStart, bStop)
    if (aStart === aStop && bStart === bStop) return
    hunks.push({ aStart, aEnd: aStop, bStart, bEnd: bStop, body })
    ai = aEnd; bi = bEnd
  }
  for (const [mi, mj] of matches) { push(mi, mj); ai = mi + 1; bi = mj + 1 }
  push(a.length, b.length)
  // 多段重叠合并（提升后可能相交）；零宽插入点不并入相邻替换段。
  const merged = []
  for (const hunk of hunks.sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd)) {
    const last = merged.at(-1)
    const zeroWidth = hunk.aStart === hunk.aEnd
    if (last && (hunk.aStart < last.aEnd || hunk.aStart === last.aStart || hunk.bStart < last.bEnd)) {
      last.aEnd = Math.max(last.aEnd, hunk.aEnd)
      last.bStart = Math.min(last.bStart, hunk.bStart)
      last.bEnd = Math.max(last.bEnd, hunk.bEnd)
      last.body = after.slice(last.bStart, last.bEnd)
    } else merged.push({ ...hunk })
  }
  const only = merged.length === 1 ? merged[0] : null
  if (only && only.aStart === 0 && only.aEnd >= before.length && only.body === after && layoutA.ranges.find(r=>r.start===0&&r.end===before.length)?.items.length > 1) {
    // 少数退役作者模块改成插件桥时全部语句确实变化，按各顶层语句分别保现场原文。
    // 不允许整文件单壳；完整业务实现只放首块，其余独立旧语句块仅注释保留。
    const program=layoutA.ranges.find(r=>r.start===0&&r.end===before.length)
    const cuts=[0,...new Set((program?.items??[]).map(item=>lineStart(before,item.start)).filter(at=>at>0)),before.length]
    if(cuts.length<3)throw Error('差分无法定位多个独立语句，拒绝整文件单块：'+rel)
    merged.splice(0,1,...cuts.slice(0,-1).map((start,i)=>({aStart:start,aEnd:cuts[i+1],bStart:i===0?0:after.length,bEnd:after.length,body:i===0?after:''})))
  }
  return merged.map((hunk, i) => ({
    format: 1,
    revision: 1,
    owner,
    id: 'statement-' + i,
    mode: (hunk.bEnd > hunk.bStart && hunk.aEnd === hunk.aStart) ? 'insert' : 'replace',
    purpose: '插件接口接线',
    anchor: { type: 'TextRange', start: hunk.aStart, end: hunk.aEnd },
    body: hunk.body,
  }))
}

/** 兼容保留：语义为**文本相等**（原 AST 等价已删；调用方将取消）。 */
export function sameSeamProgram(left, right) {
  return left === right
}
