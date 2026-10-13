// Linux真实目录复制/加载行/原systemd状态链；只替代外部进程命令，不造源码/SDK资格。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createLinuxDriver} from '../deploy/maintenance/linux-driver.mjs'
import {pluginDirFor} from '../deploy/maintenance/standard-installation.mjs'
import {runtimeFor,options} from '../deploy/maintenance/target.mjs'

test('Linux简单驱动：缺SDK版本VM仍复制真实包，原任意systemd配置保留并恢复运行停态',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'simple-linux-driver-')),home=path.join(root,'home'),app=path.join(home,'apps','dsh-tavern'),profileDir=path.join(home,'profiles','tavern'),evidence=path.join(home,'maintenance','op')
 try{
  fs.mkdirSync(profileDir,{recursive:true});fs.mkdirSync(app,{recursive:true});fs.mkdirSync(evidence,{recursive:true})
  fs.writeFileSync(path.join(profileDir,'package.json'),JSON.stringify({name:'fixture',dependencies:{keep:'*'},dsh:{profile:{bundles:['keep']}}})+'\n','utf8');fs.writeFileSync(path.join(profileDir,'cordis.patch.yml'),'[]\n','utf8')
  fs.mkdirSync(path.join(app,'tavern-plugin'),{recursive:true});fs.writeFileSync(path.join(app,'tavern-plugin','package.json'),'{"name":"dsh-tavern-plugin"}\n','utf8')
  const located=options(['install','--home',home],{platform:'linux',cwd:root,env:{},userHome:root})
  assert.equal(located.app,app,'不依赖缺失的profile酒馆解析链接');assert.equal(located.simpleMaintenance,true)
  const op={home,app,profileDir,profile:'tavern',host:'cli',action:'install','systemd-unit':'fixture.service'}
  assert.equal(runtimeFor(op,{platform:'linux'}).cli,path.join(home,'runtime','bin','dsh'),'不读缺失SDK清单')
  const calls=[];let active=true
  const runCommand=(exe,args)=>{calls.push([exe,...args].join(' '));if(args[0]==='show')return 'MainPID=0\nActiveState='+(active?'active':'inactive')+'\n';if(args[0]==='stop')active=false;if(args[0]==='start')active=true;return ''}
  const product=fileURLToPath(new URL('../',import.meta.url)),adapter={packageName:'dsh-tavern-sqlite-v2'}
  const driver=createLinuxDriver(op,adapter,product,evidence,{processFinder:()=>null,runCommand,alive:()=>false})
  assert.equal((await driver.preflight('install')).wasRunning,true)
  await driver.stop();await driver.manage('install');await driver.start()
  const dir=pluginDirFor({home,packageName:adapter.packageName})
  assert.equal(fs.existsSync(path.join(dir,'plugin.js')),true)
  assert.match(fs.readFileSync(path.join(profileDir,'cordis.patch.yml'),'utf8'),/dsh-tavern-storage-standard-host-v2/)
  assert.equal(fs.readlinkSync(path.join(dir,'node_modules','@deepseek-ai','dsh-session')),path.join(home,'runtime','lib','node_modules','@deepseek-ai','dsh-session'),'直接建立必需模块路径，不探resolve能力')
  assert.ok(!calls.some(line=>/ExecStart|KillMode|daemon-reload|experimental-vm|HTTP/.test(line)))
  assert.ok(calls.includes('systemctl stop fixture.service')&&calls.includes('systemctl start fixture.service'))
  active=false;calls.length=0
  const stopped=createLinuxDriver(op,adapter,product,path.join(evidence,'uninstall'),{processFinder:()=>null,runCommand,alive:()=>false})
  assert.equal((await stopped.preflight('uninstall')).wasRunning,false)
  await stopped.manage('uninstall');await stopped.start()
  assert.equal(fs.existsSync(dir),false);assert.ok(!calls.includes('systemctl start fixture.service'))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profileDir,'package.json'),'utf8')).dependencies,{keep:'*'})
 }finally{assert.ok(path.basename(root).startsWith('simple-linux-driver-'));fs.rmSync(root,{recursive:true,force:true})}
})

// 失败补偿：stop 抛错（原进程在停服窗口内没退出）后 runner 仍会调 start()；此时代理必须拒绝代启第二份进程。
// 判据落在 linux-driver.start() 单一入口（POSIX 驱动“不并起第二进程”在 Linux 简单路径的等价物）。
test('Linux简单驱动：停服未确证且原PID仍活时拒绝重复spawn（恢复不并起第二进程）',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'simple-linux-stopfail-'))
 try{
  const home=path.join(root,'home'),app=path.join(home,'apps','dsh-tavern'),profileDir=path.join(home,'profiles','tavern'),evidence=path.join(home,'maintenance','op')
  fs.mkdirSync(profileDir,{recursive:true});fs.mkdirSync(app,{recursive:true});fs.mkdirSync(evidence,{recursive:true})
  fs.writeFileSync(path.join(profileDir,'package.json'),JSON.stringify({name:'fixture',dependencies:{},dsh:{profile:{bundles:[]}}})+'\n','utf8')
  fs.writeFileSync(path.join(profileDir,'cordis.patch.yml'),'[]\n','utf8')
  fs.mkdirSync(path.join(app,'tavern-plugin'),{recursive:true});fs.writeFileSync(path.join(app,'tavern-plugin','package.json'),'{"name":"dsh-tavern-plugin"}\n','utf8')
  const op={home,app,profileDir,profile:'tavern',host:'cli',action:'install','systemd-unit':'fixture.service'}
  let aliveNow=true
  const spawned=[],commands=[]
  const identity={pid:4242,argv:['/usr/bin/node',path.join(home,'runtime','bin','dsh'),'--profile','tavern','--port','3081'],cwd:app,env:{},start:'x',cgroup:'0::/system.slice/fixture.service'}
  const driver=createLinuxDriver(op,{packageName:'dsh-tavern-sqlite-v2'},fileURLToPath(new URL('../',import.meta.url)),evidence,{
   processFinder:()=>identity,
   runCommand:(exe,args)=>{commands.push([exe,...args].join(' '));return args[0]==='show'?'MainPID=4242\nActiveState=active\n':''},
   alive:()=>aliveNow,
   stopWindowMs:40,
   spawnProcess:(exe,args)=>{spawned.push([exe,...args]);return{once(){},unref(){}}},
  })
  assert.equal((await driver.preflight('install')).wasRunning,true,'原实例在跑：wasRunning 必须为真')
  await assert.rejects(driver.stop(),/尚未停止/,'停服窗口内未退出必须拒绝注入')
  assert.equal(driver.stopped,false,'停服未确证：stopped 必须保持 false')
  const skipped=await driver.start()
  assert.equal(skipped.skipped,'original-still-alive','原PID仍活时不得代启')
  assert.deepEqual(spawned,[],'不得 spawn 第二个进程')
  assert.ok(!commands.includes('systemctl start fixture.service'),'原PID仍活时不得发 start')
  aliveNow=false
  const started=await driver.start()
  assert.equal(started.state,'running','原进程确已退出后仍要按原管理方式恢复运行状态')
  assert.ok(commands.includes('systemctl start fixture.service'),'恢复须走原管理方式')
  assert.deepEqual(spawned,[],'systemd 目标不得旁路 spawn')
 }finally{assert.ok(path.basename(root).startsWith('simple-linux-stopfail-'));fs.rmSync(root,{recursive:true,force:true})}
})
