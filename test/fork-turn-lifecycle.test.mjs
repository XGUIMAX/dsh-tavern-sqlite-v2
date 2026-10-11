// 官方分叉header→正式标准施缝request hook→真实作者prepare/finalize/handoff→合成SQL；不读真实档、不请求模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams, maintenanceTargets } from '../deploy/standard-seams.mjs'
import { activeSource } from './fixtures/comment-author-tree.mjs'
import { activityFromSmallRows } from '../lib/activity-state.js'
const authorRoot = fileURLToPath(new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/', import.meta.url))
const domain = pathToFileURL(path.join(authorRoot, 'tavern-plugin/lib/domain/'))
const runtimeRequire=createRequire(path.join(process.env.DSH_TAVERN_TEST_DESKTOP_RUNTIME || 'D:/Program Files (x86)/DSH-Tavern/runtime-9be856025c1522cb-setup7-5ae29095747f4f4a9fc3f12a68611fd7/resources/app','package.json'))
const runtime = name => import(pathToFileURL(runtimeRequire.resolve(name)).href)
// 未调用的显示DOM和卡工作台依赖严格占位，核心SQL/时间线/编排不替换。
registerHooks({ resolve(spec, context, next) {
 if(spec==='./tavern-macro-engine.js')return {url:'fork-fixture:macros',shortCircuit:true}
 if(['jsdom','marked'].includes(spec))return {url:'fork-fixture:display',shortCircuit:true}
 if(['dsh-mnemon-source-runtime','dsh-mnemon-source-documents'].includes(spec))return {url:'fork-fixture:memory',shortCircuit:true}
 return next(spec,context)
}, load(url, context, next) {
 if(url==='fork-fixture:macros')return {format:'module',source:"export const renderTavernMacros=()=>{throw Error('未调用的显示宏边界')}",shortCircuit:true}
 if(url==='fork-fixture:display')return {format:'module',source:"const fail=()=>{throw Error('未调用的DOM边界')};export const JSDOM=fail;export const marked=fail;export const VirtualConsole=fail",shortCircuit:true}
 if(url==='fork-fixture:memory')return {format:'module',source:"const fail=()=>{throw Error('未调用的卡记忆边界')};export const createRuntimeMemorySource=fail;export const createDocumentsMemorySource=fail",shortCircuit:true}
 return next(url,context)
}})

test('分叉新轮完整接线：标准施缝真hook准备提交SQL、后台排队与普通回退同轮，卸载保用户修改', async t => {
 const root=mkdtempSync(path.join(os.tmpdir(),'fork-turn-lifecycle-')), appDir=path.join(root,'app')
 let archive,ctx
 t.after(async()=>{archive?.dispose();await ctx?.fiber.dispose();assert.ok(path.basename(root).startsWith('fork-turn-lifecycle-'));rmSync(root,{recursive:true,force:true})})
 for(const rel of [...maintenanceTargets,'tavern-plugin/package.json']){
  const from=path.join(authorRoot,rel);if(!existsSync(from))continue
  const to=path.join(appDir,rel);mkdirSync(path.dirname(to),{recursive:true});writeFileSync(to,readFileSync(from,'utf8'),'utf8')
 }
 const requestRel='tavern-plugin/lib/hooks/request.js', requestFile=path.join(appDir,requestRel)
 const original=readFileSync(requestFile,'utf8')+'\n// 用户自有说明必须保留\n';writeFileSync(requestFile,original,'utf8')
 const installed=applyStandardSeams({appDir,assertStopped:()=>true});assert.equal(installed.ready,true);assert.equal(checkStandardSeams({appDir}).ready,true)
 const req=activeSource(readFileSync(requestFile,'utf8'),requestRel)
 const module=async(name,source)=>{
  const rewritten=source.replace(/from '(\.[^']+)'/g,(_,spec)=>{
   let url=new URL(spec,domain).href
   if(spec==='./storage-rollback-business.js')url=new URL('../lib/rollback-business-state.js',import.meta.url).href
   if(spec==='./storage-failure-state.js')url=new URL('../lib/failure-state.js',import.meta.url).href
   return 'from '+JSON.stringify(url)
  }).replace("import { CARD_MEMORY_TOOLS } from '../../packages/dsh-tavern-card-memory/index.js'",'const CARD_MEMORY_TOOLS=[]')
  const file=path.join(root,name+'.mjs');writeFileSync(file,rewritten,'utf8');return import(pathToFileURL(file).href)
 }
 const persistence=await module('persistence',readFileSync(new URL('chat-persistence.js',domain),'utf8'))
 const timelineModule=await module('timeline',activeSource(readFileSync(path.join(appDir,'tavern-plugin/lib/domain/story-timeline.js'),'utf8')))
 const turnModule=await module('turn',activeSource(readFileSync(path.join(appDir,'tavern-plugin/lib/domain/turn-orchestration.js'),'utf8')))
 const handoffModule=await module('handoff',activeSource(readFileSync(path.join(appDir,'tavern-plugin/lib/domain/foreground-handoff.js'),'utf8')))
 const helpers={...await import(new URL('copy-json-tree.js',domain)),...await import(new URL('json-mutation.js',domain)),...await import(new URL('chat-session-state.js',domain)),...await import(new URL('tavern-helper-context.js',domain)),...await import(new URL('scoped-messages.js',domain))}
 archive=createChatSqliteStore({dataRoot:path.join(root,'data'),helpers});const records=persistence.createChatPersistence({store:archive})
 const {Context}=await runtime('@deepseek-ai/cordis'),{SessionStore}=await runtime('@deepseek-ai/dsh-session')
 ctx=new Context();const sessions=new SessionStore(ctx),parent=sessions.create('synthetic-parent')
 parent.append('turn/start',{turn:6});parent.append('turn/end',{turn:6,reason:{kind:'completed'}})
 const session=sessions.fork(parent,parent.snapshotEvents().at(-1).seq,'synthetic-game')
 assert.equal(session.header.parentSession,parent.id)
 const chatId='synthetic-fork-chat',branch='synthetic-after-clean-branch'
 await archive.update(chatId,()=>({id:chatId,sessionId:session.id,_storageRevision:1,updatedAt:100,mode:'story',cardPath:'cards/synthetic.json',cardName:'合成卡',backgroundConfigVersion:1,conversationFeaturesVersion:1,variables:{hp:6},messages:[{role:'user',text:'前轮输入'},{role:'assistant',turn:6,text:'前轮正文',swipeId:0,swipes:['前轮正文']}],timeline:{schemaVersion:1,branchId:branch,revision:6,operations:{},participants:{},checkpoints:[]}}))
 const owners=new Map(),timeline=timelineModule.createStoryTimeline({id:prefix=>prefix+'-new',now:()=>100})
 const store={chatForSession:async id=>id===session.id?records.read(chatId):undefined,readCard:async()=>({name:'合成卡'}),writeChat:records.write,writeChatHeader:records.writeHeader,updateChat:records.update}
 const {createForegroundFrameBuilder}=await import(new URL('agent-input-frame.js',domain))
 const orchestrator=turnModule.createTurnOrchestrator({store,timeline,frameBuilder:createForegroundFrameBuilder(),recordRollbackBodySignal:owner=>owners.set(owner.sessionId,owner),planner:{plan:async()=>({text:'合成正文规则'})},resolvePresetRegexScripts:async()=>[],projectReply:text=>({sourceText:text,projectionText:text,sessionText:text,displayText:text,warnings:[]})})
 let queued=0,callback,queuedOwner
 const handoff=handoffModule.createForegroundHandoff({store,turns:orchestrator,tasks:{activity:chat=>activityFromSmallRows(timeline.inspect({chat}))},queueBackground:async(id,owner)=>{assert.equal(id,chatId);queued++;queuedOwner=owner},defer:fn=>{callback=fn}})
 const {createNativePlayOrchestrationStrategy}=await import(new URL('foreground-orchestration-strategies.js',domain)),{createForegroundFrameSessionAdapter}=await import(new URL('foreground-frame-session-adapter.js',domain))
 let frame
 const strategy=createNativePlayOrchestrationStrategy({modeFor:async()=> 'story',filterMessages:messages=>messages,resolvePreset:async()=>null,prepareTurn:input=>handoff.prepare(input),appendFrame:input=>createForegroundFrameSessionAdapter().append(input),recordFrame:(_id,value)=>{frame=value}})
 const sandbox={console,randomUUID:()=> 'synthetic-recall',synchronizeTemplateHistory:async()=>{},synchronizeBodyEdits:async()=>{},lastRoundVariableChanges:()=>''}
 vm.createContext(sandbox);vm.runInContext(req.replace(/^import .*$/gm,'').replace(/^export /gm,''),sandbox)
 const handlers=new Map();sandbox.registerRequestHooks({ctx:{on:(name,fn)=>handlers.set(name,fn)},backgroundAgentRunner:{owns:()=>false},cardMemory:{appendRecall:async({decision})=>decision},chatForSession:store.chatForSession,foregroundStrategies:strategy,requestCoordinates:new Map(),requestIdForMessages:()=> 'synthetic-request7',sessionStore:sessions,tavernRetryLimiter:{handle(){}}})
 const input={id:'synthetic-input7',role:'user',content:[{type:'text',text:'合成新输入'}],source:{kind:'user',rpcId:'synthetic-request7'}}
 session.append('turn/start',{turn:7})
 const decision=await handlers.get('agent/pre-step')({agent:{session},turn:7,step:1,messages:[input]},async()=>({kind:'enter',messages:[input]}))
 assert.equal(frame.turn,7);assert.equal(frame.branchId,branch);assert.equal(owners.get(session.id).operationId,frame.operationId)
 for(const message of decision.messages)session.append('user/message',message,{surfaceOp:'append'})
 const prepared=await archive.read(chatId);assert.equal(prepared.timeline.operations[frame.operationId].status,'running');assert.equal(prepared.timeline.operations[frame.operationId].turn,7)
 const saved=await handoff.finalize({sessionId:session.id,turn:7,requestId:'synthetic-request7',userText:'合成新输入',assistantText:'合成新正文',rollbackBodyOwner:owners.get(session.id)})
 assert.equal(saved.saved,true)
 session.append('assistant/message',{turn:7,step:1,message:{id:'synthetic-reply7',role:'assistant',content:[{type:'text',text:'合成新正文'}],source:{kind:'model',provider:'synthetic',model:'synthetic'}},stream:[]},{surfaceOp:'append'})
 session.append('turn/end',{turn:7,reason:{kind:'completed'}})
 const complete=await archive.read(chatId);assert.equal(complete.messages.at(-1).turn,7);assert.equal(complete.timeline.operations[frame.operationId].background.phase,'pending');assert.equal(activityFromSmallRows(timeline.inspect({chat:complete})).role,'settlement')
 handoff.end({sessionId:session.id,turn:7,reason:'completed',rollbackBodyOwner:owners.get(session.id)});callback();await handoff.whenIdle(session.id)
 assert.equal(queued,1);assert.equal(queuedOwner.turn,7);assert.equal(queuedOwner.branchId,branch)
 const {rollbackAvailability}=await import(new URL('rollback-surface.js',domain));const availability=rollbackAvailability(complete,{events:session.snapshotEvents(),nodes:session.surface.nodes})
 assert.equal(availability.canRollback,true);assert.equal(availability.target.turn,7)
 const uninstall=uninstallStandardSeams({appDir,assertStopped:()=>true});assert.equal(uninstall.legacySeamsRemain,false);assert.equal(readFileSync(requestFile,'utf8'),original)
})
