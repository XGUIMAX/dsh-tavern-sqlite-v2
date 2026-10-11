// 简单接缝：文本行差分最小区块 + TextRange 锚点，并核 plan 安装/卸载保现场 ORIGINAL 与块外修改。
// 依赖：deploy/comment-seam-descriptors.mjs、deploy/comment-seam-plan.mjs（TextRange 接缝 API）。单叶；不读真实档、不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeSeamChanges, sameSeamProgram } from '../deploy/comment-seam-descriptors.mjs'
import { planSeamInstall, planSeamUninstall } from '../deploy/comment-seam-plan.mjs'

const OWNER = 'test-owner'
const describe1 = (before, after) => describeSeamChanges(before, after, { rel: 'fixture.js', owner: OWNER })
const at = (source, anchor) => source.slice(anchor.start, anchor.end)

test('简单接缝：行差分最小区块（插入不吞原行/替换/删除/重复行/模板整语句）并保ORIGINAL', () => {
  // ① 纯插入：不得吞掉原行，anchor 为零宽插入点，body 只含新增行
  const before1 = 'export function a() {\n  return 1\n}\n'
  const after1 = 'export function a() {\n  // 插件接线\n  return 1\n}\n'
  const blocks1 = describe1(before1, after1)
  assert.equal(blocks1.length, 1, '① 应只有一个最小区块')
  assert.equal(blocks1[0].mode, 'insert')
  assert.equal(blocks1[0].anchor.type, 'TextRange')
  assert.equal(blocks1[0].anchor.start, blocks1[0].anchor.end, '① 插入必须零宽，不得吞下一行')
  assert.equal(blocks1[0].body, '  // 插件接线\n')
  assert.equal(before1.slice(0, blocks1[0].anchor.start), 'export function a() {\n')
  assert.ok(after1.includes(before1.slice(0, blocks1[0].anchor.start) + '  // 插件接线\n' + before1.slice(blocks1[0].anchor.start)), '① 插入行必须正好落在原行之间')

  // ② 替换：只覆盖被改的那一整条语句行
  const before2 = 'const keep = 1\nconst target = 2\nconst tail = 3\n'
  const after2 = 'const keep = 1\nconst target = 20\nconst tail = 3\n'
  const blocks2 = describe1(before2, after2)
  assert.equal(blocks2.length, 1)
  assert.equal(blocks2[0].mode, 'replace')
  assert.equal(at(before2, blocks2[0].anchor), 'const target = 2\n', '② 替换块必须恰为被改语句')
  assert.equal(blocks2[0].body, 'const target = 20\n')
  assert.equal(blocks2[0].id, 'statement-0')
  assert.equal(blocks2[0].owner, OWNER)
  assert.equal(blocks2[0].format, 1)
  assert.equal(blocks2[0].revision, 1)

  // ③ 删除：按要求 mode=replace 且 body 为空，anchor 覆盖被删语句
  const before3 = 'const keep = 1\nconst gone = 2\nconst tail = 3\n'
  const after3 = 'const keep = 1\nconst tail = 3\n'
  const blocks3 = describe1(before3, after3)
  assert.equal(blocks3.length, 1)
  assert.equal(blocks3[0].mode, 'replace', '③ 协议不加 delete：删除用 replace + 空 body')
  assert.equal(blocks3[0].body, '')
  assert.equal(at(before3, blocks3[0].anchor), 'const gone = 2\n')

  // ④ 重复行：同为 ping() 的多次出现只改一处 ⇒ 单行最小块，不得整文件一块
  const before4 = 'ping()\nconst a = 1\nping()\nconst b = 2\nping()\n'
  const after4 = 'ping()\nconst a = 1\nping(9)\nconst b = 2\nping()\n'
  const blocks4 = describe1(before4, after4)
  assert.equal(blocks4.length, 1, '④ 重复行下仍然只有一处最小改动')
  assert.equal(at(before4, blocks4[0].anchor), 'ping()\n', '④ 改动块必须恰为一行 ping()')
  assert.equal(blocks4[0].body, 'ping(9)\n')
  assert.equal(blocks4[0].anchor.end - blocks4[0].anchor.start, 'ping()\n'.length, '④ 不得把整文件当一块')
  assert.ok(blocks4[0].anchor.end <= before4.length, '④ 块尾不得越出源文本')

  // ⑤ 多行调用 + 模板行内改动：提升到包含该模板的最近完整语句，块内保留中间不变行
  const before5 = 'const cfg = load({\n  name: "x",\n  text: `a\nb`,\n  rest: 1,\n})\nconst tail = 5\n'
  const after5 = 'const cfg = load({\n  name: "x",\n  text: `a\nc`,\n  rest: 1,\n})\nconst tail = 5\n'
  const blocks5 = describe1(before5, after5)
  assert.equal(blocks5.length, 1, '⑤ 模板行内改动只产生一块')
  assert.equal(at(before5, blocks5[0].anchor), 'const cfg = load({\n  name: "x",\n  text: `a\nb`,\n  rest: 1,\n})\n', '⑤ 必须提升到完整语句，含中间不变行')
  assert.ok(!blocks5[0].body.includes('const tail'), '⑤ 块外不变行不得被吞')

  // ⑥ 文本相等语义
  assert.equal(sameSeamProgram(before2, before2), true)
  assert.equal(sameSeamProgram(before2, after2), false)

  // ⑦ plan 安装/卸载：同一源上描述 → 安装 → 现场改 ORIGINAL 与块外 → 卸载还原编辑后原文
  const original = 'const keep = 1\nfunction api() {\n  return 1\n}\nconst outside = 7\n'
  const target = original.replace('return 1', 'return 20')
  const blocks7 = describe1(original, target)
  assert.equal(blocks7.length, 1, '⑦ 同源描述必须只产生一块')
  const install = planSeamInstall(original, { rel: 'fixture.js', owner: OWNER, descriptors: blocks7 })
  assert.ok(install.source.includes('return 20'), '⑦ 安装必须落地新文本')
  assert.ok(install.source.includes(OWNER), '⑦ 安装产物必须带 owner 记录')
  // 现场：块外 keep 改动 + ORIGINAL 注释区内 return 1 → return 7（本机制只加一层 //）
  let onSite = install.source.replace('const keep = 1', 'const keep = 100')
  onSite = onSite.replace(/\/\/\s*return 1/, '//   return 7')
  assert.ok(onSite.includes('const keep = 100'), '⑦ 前置：块外修改已就位')
  assert.ok(onSite.includes('return 7'), '⑦ 前置：ORIGINAL 内现场编辑已就位')
  const uninstall = planSeamUninstall(onSite, { rel: 'fixture.js', owner: OWNER })
  assert.equal(uninstall.changed, true, '⑦ 卸载必须真的撤块')
  assert.ok(uninstall.source.includes('const keep = 100'), '⑦ 卸载必须保留块外用户修改')
  assert.ok(uninstall.source.includes('return 7'), '⑦ 卸载必须还原 ORIGINAL 的现场编辑（return 7）')
  assert.ok(!uninstall.source.includes('return 20'), '⑦ 卸载不得保留插件注入文本')
  assert.ok(!uninstall.source.includes(OWNER), '⑦ 卸载后不得残留自有块标记')
})
