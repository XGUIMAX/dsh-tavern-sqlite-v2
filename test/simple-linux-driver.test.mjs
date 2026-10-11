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
