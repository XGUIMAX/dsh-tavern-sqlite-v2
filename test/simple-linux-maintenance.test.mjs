// 本轮Linux简单施工调用链：不探环境/不预演/不重复验收，真实复制与区块调用分别在对应叶验证。
import test from 'node:test'
import assert from 'node:assert/strict'
import { executeSimpleMaintenance } from '../deploy/maintenance/runner.mjs'
import { invocation } from '../deploy/maintenance/process.mjs'

test('Linux简单装卸：一次定位直接写入复制并恢复原状态，不检查VM参数HTTP或重复计划', async()=>{
 const calls=[]
 const adapter={packageName:'fixture',line:'v2',execution:'server',prepareStandardSeams({operation}){calls.push('plan:'+operation);return {changes:[]}},writePreparedStandardSeams(){calls.push('write');return {ready:true}},restorePreparedStandardSeams(){calls.push('undo')},checkStandardSeams(){throw Error('禁止重复计划')},inspectStandardSeamsPlan(){throw Error('禁止重复计划')}}
 const driver={async preflight(){calls.push('locate');return {wasRunning:true}},async stop(){calls.push('stop')},async manage(action){calls.push('copy:'+action)},async start(){calls.push('start')},async restorePackage(){calls.push('restore')}}
 const result=await executeSimpleMaintenance({action:'install',adapter,driver,appDir:'/fixture'})
 assert.deepEqual(calls,['locate','plan:install','stop','write','copy:install','start']);assert.equal(result.finalState,'running');assert.equal(result.runtimeVerified,false)
 calls.length=0
 driver.preflight=async()=>{calls.push('locate');return {wasRunning:false}}
 await executeSimpleMaintenance({action:'uninstall',adapter,driver,appDir:'/fixture'})
 assert.deepEqual(calls,['locate','plan:uninstall','write','copy:uninstall'])
 calls.length=0
 driver.preflight=async()=>{calls.push('locate');return {wasRunning:true}}
 driver.manage=async()=>{calls.push('copy:install');throw Error('写失败')}
 await assert.rejects(executeSimpleMaintenance({action:'install',adapter,driver,appDir:'/fixture'}),/写失败/)
 assert.deepEqual(calls,['locate','plan:install','stop','write','copy:install','restore','undo','start'])
 calls.length=0
 driver.restorePackage=async()=>{calls.push('restore');throw Error('包恢复失败')}
 await assert.rejects(executeSimpleMaintenance({action:'install',adapter,driver,appDir:'/fixture'}),/装卸失败且恢复未完成/)
 assert.deepEqual(calls,['locate','plan:install','stop','write','copy:install','restore','undo','start'],'包恢复失败仍尝试源码/运行状态恢复')
 calls.length=0
 driver.manage=async()=>{calls.push('copy:install')}
 driver.restorePackage=async()=>{calls.push('restore')}
 let starts=0
 driver.start=async()=>{calls.push('start');if(starts++===0)throw Error('启动命令失败')}
 await assert.rejects(executeSimpleMaintenance({action:'install',adapter,driver,appDir:'/fixture'}),/启动命令失败/)
 assert.deepEqual(calls,['locate','plan:install','stop','write','copy:install','start','restore','undo','start'],'原启动命令失败恢复程序源码并再恢复原运行状态')
 const argv=['/usr/bin/node','--inspect=127.0.0.1:9229','--max-old-space-size=3072','/fixture/runtime/bin/dsh','--profile','tavern','--host','127.0.0.1','--port','3081','--no-open','--trusted-host','example.invalid']
 assert.deepEqual(invocation(argv,{cliEntries:['/fixture/runtime/bin/dsh'],profile:'tavern',simpleMaintenance:true}),{host:'127.0.0.1',port:3081})
})
