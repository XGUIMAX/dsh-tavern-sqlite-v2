// Linux装卸只记录目标原状态，停止后施工，按原管理方式恢复；不审查运行资格。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { command, findProcess, processAlive } from './process.mjs'
import { systemdOwner, parseSystemdProperties } from './systemd.mjs'
import { runtimeFor } from './target.mjs'
import { createStandardInstallation } from './standard-installation.mjs'
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
export function createLinuxDriver(op,adapter,packageRoot,evidence,{processFinder=findProcess,runCommand=command,alive=processAlive,spawnProcess=spawn,stopWindowMs=30000}={}){
 const context={...op,...runtimeFor({...op,simpleMaintenance:true},{platform:'linux'}),simpleMaintenance:true}
 const assembly=createStandardInstallation({op,adapter,packageRoot,evidence,simple:true,linkPeers:()=>{
  // 安装必要模块路径只建链接，不作resolve/版本/能力验证，不下载第二份宿主。
  const sourceRoot=path.join(op.home,'runtime','lib','node_modules','@deepseek-ai')
  const destination=path.join(op.home,'profile-data','tavern','data','plugins',adapter.packageName,'node_modules','@deepseek-ai')
  fs.mkdirSync(destination,{recursive:true})
  for(const name of ['dsh-tools','dsh-session','dsh-session-persistence','dsh-session-persistence-jsonl','dsh-session-query']){
   const link=path.join(destination,name);fs.symlinkSync(path.join(sourceRoot,name),link,process.platform==='win32'?'junction':'dir')
  }
 }})
 let original=null,unit=op['systemd-unit']||'',wasRunning=false,stopped=false
 const properties=()=>parseSystemdProperties(runCommand('systemctl',['show',unit,'-p','MainPID','-p','ActiveState'],{timeout:5000}))
 return {
  simpleMaintenance:true,
  async preflight(action){
   original=processFinder(context);unit=unit||systemdOwner(original?.cgroup||'')||''
   wasRunning=unit?properties().ActiveState==='active':!!original
   await assembly.preflight(action)
   return {wasRunning,noop:false}
  },
  async stop(){
   if(!wasRunning)return
   if(unit)runCommand('systemctl',['stop',unit],{timeout:30000})
   else if(original&&alive(original.pid))process.kill(original.pid,'SIGTERM')
   if(original){const until=Date.now()+stopWindowMs;while(alive(original.pid)&&Date.now()<until)await pause(50);if(alive(original.pid))throw Error('原酒馆尚未停止，未注入')}
   stopped=true
  },
  async start(){
   if(!wasRunning)return {state:'stopped'}
   // 停服未确证（stop 抛错/未走到确认）且原PID仍活：绝不代启第二份进程，保持原运行状态，恢复不冒认成功。
   if(!stopped&&original&&alive(original.pid))return {state:'running',skipped:'original-still-alive',pid:original.pid}
   if(unit)runCommand('systemctl',['start',unit],{timeout:10000})
   else{
    const fd=fs.openSync(path.join(evidence,'startup.log'),'a',0o600)
    try{const child=spawnProcess(original.argv[0],original.argv.slice(1),{cwd:original.cwd,env:original.env,detached:true,stdio:['ignore',fd,fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});child.unref()}finally{fs.closeSync(fd)}
   }
   stopped=false;return {state:'running'}
  },
  manage:action=>assembly.manage(action),restorePackage:()=>assembly.restore(),
  get wasRunning(){return wasRunning},get stopped(){return stopped},
 }
}
