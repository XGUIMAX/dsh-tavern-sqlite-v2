// 固定7e349新增实际源码接缝链，仅有限软件fixture；不加载作者业务/模型/真实数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
import {prepareStandardSeams,writePreparedStandardSeams,maintenanceTargets} from '../deploy/standard-seams.mjs'
import {parseSeamSource} from '../deploy/comment-seam-blocks.mjs'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
import {needsPluginTaskSeams} from '../deploy/plugin-task-quiescence-transform.mjs'
const active=(source,rel)=>{let result=source;for(const block of [...parseSeamSource(source,{rel,ast:false}).blocks].reverse())result=result.slice(0,block.start)+source.slice(block.regions.active.beginEnd,block.regions.active.endStart)+result.slice(block.end);return result}
test('上游7e349真实接缝：cycle与pending保留，manualAPI受管与失败忙证明就位，当前安装卸载恢复现场',()=>{
 const fixture=fileURLToPath(new URL('../../../tmp/upstream-7e349-review/source/',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'upstream-7e349-seams-')),before=new Map()
 try{
  for(const rel of [...maintenanceTargets,'tavern-plugin/package.json']){
   const file=path.join(fixture,rel);if(!fs.existsSync(file))continue
   const text=fs.readFileSync(file,'utf8'),out=path.join(root,rel);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,text,'utf8');before.set(rel,text)
  }
  const plan=prepareStandardSeams({appDir:root,operation:'install'}),apiRel='tavern-plugin/lib/plugin-api.js',indexRel='tavern-plugin/lib/index.js',jobsRel='tavern-plugin/lib/domain/settlement-jobs.js'
  assert.ok(plan.changes.some(c=>c.rel===apiRel),'新API实际加入受管施缝')
  writePreparedStandardSeams(plan)
  const source=rel=>active(fs.readFileSync(path.join(root,rel),'utf8'),rel),index=source(indexRel),api=source(apiRel),jobs=source(jobsRel)
  assert.ok(index.includes('run: runSettlementCycle, onSettled: onSettlementSettled, onIdle:'))
  assert.ok(jobs.includes('start, pending, cancel, dispose, isBusy:'))
  assert.ok(index.includes("phase: 'before'"));assert.ok(index.includes("phase: 'after'"))
  assert.ok(index.includes('const backgroundActive = settlementJobs.isBusy(chatId) === true || pluginTaskJobs.has(chatId)'))
  assert.ok(index.includes('await quiescePluginTasks(chat)'))
  assert.ok(index.includes("pluginTaskJobs.get(chat.id)?.controller.abort(new Error('玩家停止了插件任务'))"))
  assert.ok(api.includes('await taskWork.catch(() => {})'));assert.ok(api.includes('assertPluginTaskWritable()'));assert.ok(api.includes('pluginTaskWrites.run(taskScope'))
  for(const rel of [indexRel,apiRel,jobsRel,'tavern-plugin/lib/domain/storage-native-data.js'])parse(source(rel),{ecmaVersion:'latest',sourceType:'module'})
  assert.equal(prepareStandardSeams({appDir:root,operation:'install'}).changes.length,0,'当前源码再计划不得重复注入API/忙证明')
  writePreparedStandardSeams(prepareStandardSeams({appDir:root,operation:'uninstall'}))
  for(const rel of [indexRel,apiRel,jobsRel])assert.equal(fs.readFileSync(path.join(root,rel),'utf8'),before.get(rel),'新增路径卸载保现场作者原文：'+rel)
 }finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('upstream-7e349-seams-'));fs.rmSync(root,{recursive:true,force:true})}
})

test('上游7e349任务接缝负例：cycle存在但manualMap漂移必须源码零写拒绝',()=>{
 const fixture=fileURLToPath(new URL('../../../tmp/upstream-7e349-review/source/',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'upstream-7e349-negative-')),before=new Map()
 try{
  for(const rel of [...maintenanceTargets,'tavern-plugin/package.json']){const input=path.join(fixture,rel);if(!fs.existsSync(input))continue;let text=fs.readFileSync(input,'utf8');if(rel==='tavern-plugin/lib/index.js')text=text.replace('  const pluginTaskJobs = new Map()','  const renamedJobs = new Map()');const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,'utf8');before.set(rel,text)}
  assert.equal(needsPluginTaskSeams('const old = runSettlement'),false)
  assert.throws(()=>prepareStandardSeams({appDir:root,operation:'install'}),/静止Map锚点缺失/)
  for(const [rel,text]of before)assert.equal(fs.readFileSync(path.join(root,rel),'utf8'),text)
  assert.equal(fs.existsSync(path.join(root,'.tavern-comment-seams.json')),false)
 }finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('upstream-7e349-negative-'));fs.rmSync(root,{recursive:true,force:true})}
})
