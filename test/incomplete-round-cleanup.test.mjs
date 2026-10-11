// 合成身份；验证静止门、遗留轮签名及真实生产转换，不读用户数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {applyStandardSeams,uninstallStandardSeams} from '../deploy/standard-seams.mjs'
import {prepareCommentAuthorTree,activeSource} from './fixtures/comment-author-tree.mjs'
import {queryFailureCleanup} from '../lib/chat-query-service.js'
import {createSessionWindowProjector,REQUIRED_FUNCTIONS,REQUIRED_VALUES,createActivitySummaryBridge} from '../lib/session-window-projector.js'
import {inspectNativeFailureTail} from '../lib/clean-rollback.js'
import {applyLatestFailureHostTransform,applyLatestFailureViewTransform} from '../deploy/latest-failure-transform.mjs'
import {applyForegroundQuiescenceTransform,applySettlementQuiescenceTransform} from '../deploy/rollback-quiescence-transform.mjs'
import {composedFailureViewText,readLatestFailureSource} from './support/latest-failure-source.mjs'
const chatOf=()=>({id:'chat-incomplete',sessionId:'session-incomplete',_storageRevision:11,mode:'story',variables:{hp:6},messages:[{role:'user',text:'u6'},{role:'assistant',turn:6,text:'a6'}],timeline:{schemaVersion:1,branchId:'branch-live',revision:6,participants:{},operations:{body6:{id:'body6',kind:'body',status:'completed',turn:6,background:{phase:'completed'}}},checkpoints:[{id:'cp6',turn:6}]}})
const eventsOf=()=>[
 {seq:0,type:'turn/start',data:{turn:6}}, {seq:1,type:'turn/end',data:{turn:6,reason:{kind:'completed'}}},
 {seq:2,type:'turn/start',data:{turn:7}}, {seq:3,type:'user/message',data:{id:'u7',role:'user',content:[{type:'text',text:'u7'}],source:{kind:'user'}},surfaceOp:'append'},
 {seq:4,type:'assistant/message',data:{turn:7,step:1,message:{id:'a7',role:'assistant',content:[{type:'reasoning',text:'synthetic reasoning'},{type:'text',text:'a7'}]}},surfaceOp:'append'},
 {seq:5,type:'turn/end',data:{turn:7,reason:{kind:'completed'}}}]
const idle={cleanupIdle:true,foregroundActive:false,backgroundActive:false,activity:{phase:'idle',busy:false}}
const evidenceOf=(events=eventsOf(),flags={})=>({session:{header:{id:'session-incomplete'}},events,...idle,...flags})
const inspect=(chat=chatOf(),evidence=evidenceOf())=>inspectNativeFailureTail(chat,evidence,chat._storageRevision)
const bodyFailed=()=>{const chat=chatOf();chat.messages.push({role:'assistant',turn:7,text:'a7'});chat.timeline.operations.body7={id:'body7',kind:'body',status:'completed',turn:7,committedBranchId:'branch-live',background:{phase:'failed'},businessBefore:{version:1,fields:{variables:{hp:6}},messageCount:2,participants:{},operationIds:['body6'],operationStates:{body6:chat.timeline.operations.body6}}};chat.timeline.checkpoints.push({id:'cp7',turn:7});return chat}
test('不完整清理A：仅前后台静止与明确未登记完整尾轮可签，部分推进和未知事件拒绝',()=>{
 const chat=chatOf(),result=inspect(chat)
 assert.deepEqual(result.target,{kind:'native-only',incomplete:true,chatId:chat.id,sessionId:chat.sessionId,turn:7,branchId:'branch-live',revision:11,endSeq:5,eventCount:6})
 for(const flags of [{cleanupIdle:false},{foregroundActive:true},{backgroundActive:true},{activity:{phase:'pending',busy:false}},{activity:{phase:'running',busy:true}}])assert.equal(inspect(chat,evidenceOf(undefined,flags)).target,null)
 for(const modify of [c=>{c.messages.push({role:'assistant',turn:7})},c=>{c.timeline.checkpoints.push({turn:7})},c=>{c.timeline.participants.p={turn:7}},c=>{c.regeneratedDshTurns={7:8}},c=>{c.timeline.operations.partial={kind:'agent',turn:7}}]){const c=chatOf();modify(c);assert.equal(inspect(c).target,null)}
 for(const type of ['tool/result','assistant/action','unknown/event','user/message']){const events=eventsOf();events.push({seq:6,type,data:{turn:8}});assert.equal(inspect(chat,evidenceOf(events)).target,null)}
 const broken=eventsOf();broken[3].seq=9;assert.equal(inspect(chat,evidenceOf(broken)).target,null)
 assert.equal(inspect(chat,evidenceOf(eventsOf().slice(0,-1))).target,null)
 assert.equal(inspect(chat,{events:eventsOf()}).target,null)
})
test('不完整清理原生尾：用户入队与旧帧精确替换可保前缀，工具块或错误引用拒绝',()=>{
 const chat=chatOf(),trace={chatId:chat.id,turn:6,operationId:'operation6',frameId:'frame6',branchId:'prior',basedOnRevision:5},source={kind:'plugin',plugin:'dsh-tavern',form:'foreground-frame',trace}
 const old={seq:0,type:'user/message',data:{id:'frame',role:'user',source,content:[{type:'text',text:'old context'}]},surfaceOp:'append'}
 const events=[old,{seq:1,type:'turn/start',data:{turn:6}},{seq:2,type:'turn/end',data:{turn:6,reason:{kind:'completed'}}},
  {seq:3,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'queued',source:{kind:'user'}}]}},
  {seq:4,type:'turn/start',data:{turn:7}},
  {seq:5,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},
  {seq:6,type:'user/message',data:{...old.data,content:[{type:'text',text:'retained old context'}]},sourceEventSeqs:[0],surfaceOp:{op:'replace',startSeq:0,endSeq:0}},
  ...eventsOf().slice(3).map((event,index)=>({...event,seq:7+index}))]
 assert.equal(inspect(chat,evidenceOf(events)).target?.incomplete,true)
 const unsafe=structuredClone(events);unsafe[6].sourceEventSeqs=[5];unsafe[6].surfaceOp.startSeq=5;unsafe[6].surfaceOp.endSeq=5;assert.equal(inspect(chat,evidenceOf(unsafe)).target,null)
 const foreign=structuredClone(events);foreign[3].data.inserted[0].source={kind:'plugin',plugin:'unknown'};assert.equal(inspect(chat,evidenceOf(foreign)).target,null)
 const tool=eventsOf();tool[4].data.message.content.push({type:'tool-call',name:'unknown'});assert.equal(inspect(chat,evidenceOf(tool)).target,null)
})
test('正常结算轮：已登记正文的后台失败、成功、未更新与重试均不新增异常清理',()=>{
 const db=new DatabaseSync(':memory:')
 try {
  db.exec('CREATE TABLE archive_timeline_nodes(node_key TEXT,value_json TEXT); CREATE TABLE archive_messages(message_json TEXT)')
  for(const phase of ['failed','completed','pending','running',undefined]) {
   const chat=bodyFailed();chat.timeline.operations.body7.background.phase=phase
   assert.equal(inspect(chat).target,null)
   db.exec('DELETE FROM archive_timeline_nodes')
   db.prepare('INSERT INTO archive_timeline_nodes VALUES (?,?)').run('operations:body7',JSON.stringify(chat.timeline.operations.body7))
   assert.equal(queryFailureCleanup(db,{revision:11,timeline:chat.timeline}).cleanable,false)
  }
 } finally {db.close()}
 const rowOnly=chatOf();rowOnly.messages.push({role:'assistant',turn:7,mvu:{receipt:{status:'unchanged'}}});assert.equal(inspect(rowOnly).target,null)
})
test('不完整清理接线：真实视图helper将遗留错误轮接入，活动态与正常成功全不显示',async()=>{
 const source=applyLatestFailureViewTransform(await composedFailureViewText())
 assert.equal(applyLatestFailureViewTransform(source),source)
 const gateStart=source.indexOf('  // 前后台静止门'),gateEnd=source.indexOf('  // 终止失败生命周期',gateStart)
 const reasonStart=source.indexOf('  // 活动态不提示错误'),reasonEnd=source.indexOf('  // native 挡住',reasonStart)
 const oldReason=`  // 活动/成功/无轮先截断说明（pending-retry 说明仍优先）：不让 native inspector 对 running body 的“须清理”文案漏出
  if ((ending === 'active' || ending === 'completed' || ending === 'none') && !(chat.rollbackPending && chat.rollbackPending.failureTarget)) return ''
  const native = inspectNativeFailureTail(chat, evidence, revision)
`
 const previous=source.slice(0,gateStart)+source.slice(gateEnd,reasonStart)+oldReason+source.slice(reasonEnd)
 assert.equal(applyLatestFailureViewTransform(previous),source,'045完整旧helper可原位升级')
 assert.throws(()=>applyLatestFailureViewTransform(previous.replace('function latestFailureTarget(', 'function missingTarget(')),/不完整/)
 const begin=source.indexOf('function latestFailureTarget('),end=source.indexOf("import ",begin)
 const context=vm.createContext({inspectNativeFailureTail})
 vm.runInContext(source.slice(begin,end)+'\n globalThis.targetOf=latestFailureTarget;globalThis.reasonOf=latestFailureCleanupReason;',context)
 assert.equal(context.targetOf(chatOf(),null,evidenceOf()).incomplete,true)
 assert.match(context.reasonOf(chatOf(),null,evidenceOf()),/未登记/)
 assert.equal(context.targetOf(chatOf(),null,undefined),null)
 assert.equal(context.targetOf(bodyFailed(),null,evidenceOf()),null)
 const toolEvidence=evidenceOf();toolEvidence.events[4].data.message.content.push({type:'tool-call'});assert.match(context.reasonOf(chatOf(),null,toolEvidence),/工具调用/)
 assert.match(source,/canRollback: rollbackState.canRollback \|\| latestFailureTarget/)
 assert.match(source,/rollbackTargetTurn: latestFailureTarget\(chat, replayTarget, evidence\)\?\.turn/)
 for(const flags of [{cleanupIdle:false},{foregroundActive:true},{backgroundActive:true},{activity:{phase:'pending',busy:false}},{activity:{phase:'running',busy:true}}])assert.equal(context.targetOf(chatOf(),null,evidenceOf(undefined,flags)),null)
 const normal=bodyFailed();normal.timeline.operations.body7.background.phase='completed';assert.equal(context.targetOf(normal,null,evidenceOf()),null)
 for(const flags of [{backgroundActive:true},{activity:{phase:'pending',busy:false}}])assert.equal(context.reasonOf(chatOf(),null,evidenceOf(undefined,flags)),'')
})
test('不完整清理接线：标准装卸真实作者树导出运行器与实时DI，保留现场源码',()=>{
 const f=prepareCommentAuthorTree();assert.ok(f)
 try {
   const installed=applyStandardSeams({appDir:f.appDir,authorUnloaded:true});assert.equal(installed.ready,true)
   const read=rel=>activeSource(readFileSync(path.join(f.appDir,rel),'utf8'),rel)
   const host=read('tavern-plugin/lib/index.js'),round=read('tavern-plugin/lib/domain/round-history.js')
   assert.match(host,/isFailureCleanupIdle: chat =>/)
   assert.match(host,/readFailureEvidence\(chat.sessionId, chat.id\), activity/)
   assert.match(round,/isFailureCleanupIdle,\n/)
   assert.match(read('tavern-plugin/lib/domain/foreground-handoff.js'),/whenIdle, isBusy/)
   assert.match(read('tavern-plugin/lib/domain/settlement-jobs.js'),/isBusy: chatId => jobs.has\(chatId\)/)
   assert.equal(applyStandardSeams({appDir:f.appDir,authorUnloaded:true}).changed,false)
   uninstallStandardSeams({appDir:f.appDir,authorUnloaded:true})
   for(const rel of ['tavern-plugin/lib/index.js','tavern-plugin/lib/domain/round-history.js','tavern-plugin/lib/domain/foreground-handoff.js','tavern-plugin/lib/domain/settlement-jobs.js','tavern-plugin/lib/domain/chat-session-state.js'])assert.equal(readFileSync(path.join(f.appDir,rel),'utf8'),f.original.get(rel))
 } finally {f.cleanup()}
})
test('不完整清理接线：共享UI真实控件活动时隐藏，目标坐标漂移零RPC',async()=>{
 const source=readFileSync(new URL('../client.js',import.meta.url),'utf8')
 let plugin,ui,snapshot={view:{failureTarget:inspect().target,activity:{phase:'idle',busy:false}}},requests=0,waited=0
 const handle={getSnapshot:()=>snapshot,subscribe:()=>()=>{}}
 const React={createElement:(type,props,...children)=>({type,props,children}),useMemo:f=>f(),useSyncExternalStore:(_s,get)=>get(),useRef:value=>({current:value}),useState:value=>[value,()=>{}],useEffect:()=>{}}
 const regs=[];const context=vm.createContext({window:{__ModuleLoader__:{load:def=>{plugin=def.factory(name=>name==='react'?React:{})}}}})
 vm.runInContext(source,context)
 const bridge={apiVersion:2,selectFailure:()=>handle,refresh:async()=>{},request:async(_method,args)=>{requests++;return {view:{rolledBack:{alreadyClean:true,cleanedFailureTarget:args.failureTarget}}}}}
 plugin.apply({sessions:{subagentAddress:()=>null,waitForTavernRollbackSync:async()=>{waited++}},get:name=>name==='tavernStorageView'?bridge:undefined,provide:(_key,value)=>{ui=value},effect:fn=>fn(),emit:()=>{},slots:{inject:(_name,fn)=>fn(),register:(meta,render)=>{regs.push({meta,render});return ()=>{}}}})
 const render=()=>{const wrapper=regs.find(reg=>reg.meta.id.endsWith(':failure-clean')).render({sessionId:'session-incomplete',useSession:fn=>fn({running:false})});return wrapper.type(wrapper.props)}
 assert.ok(render())
 for(const activity of [{phase:'pending',busy:false},{phase:'running',busy:true},{phase:'failed',busy:true}]){snapshot={view:{...snapshot.view,activity}};assert.equal(render(),null);await assert.rejects(ui.cleanFailure('session-incomplete',7,inspect().target),/活动/)}
 snapshot={view:{failureTarget:inspect().target,activity:{phase:'idle',busy:false}}}
 await assert.rejects(ui.cleanFailure('session-incomplete',7,{...inspect().target,incomplete:undefined}),/不一致/)
 await assert.rejects(ui.cleanFailure('session-incomplete',7,{...inspect().target,endSeq:6,eventCount:7}),/不一致/)
 assert.equal(requests,0);assert.equal(waited,0)
 await ui.cleanFailure('session-incomplete',7,inspect().target);assert.equal(requests,1)
})
test('不完整清理窗口：真实投影将chat身份与同快照后台活动送往唯一签名函数',async()=>{
 const deps={};for(const key of REQUIRED_FUNCTIONS){let owner=deps;const parts=key.split('.');for(const part of parts.slice(0,-1))owner=owner[part]??=( {} );owner[parts.at(-1)]=()=>null}
 for(const key of REQUIRED_VALUES){let owner=deps;const parts=key.split('.');for(const part of parts.slice(0,-1))owner=owner[part]??={};owner[parts.at(-1)]={}}
 Object.assign(deps,{helperMessageColdWindow:8,str:value=>String(value??''),activityBridge:createActivitySummaryBridge(),groupOfMode:()=> 'play',readTavernSettings:async()=>({}),readChatCard:async()=>({}),readCardExtensions:async()=>({regexScripts:[],helperScripts:[]}),replyProjectionsOf:()=>[],composeTavernRegexScripts:()=>[],withLegacyPresentationProjection:(_chat,values)=>values,hasTavernScriptRuntime:()=>false,cardUpdateStatus:async()=>({available:false})})
 deps.tavernRemoteAssets={pinExtensions:async()=>({helperScripts:[],regexScripts:[],diagnostics:[],pins:[]})}
 deps.incrementalReplyView={project:async()=>({projections:[],statusViews:[]})};deps.liveCardUpdate={project:async(_chat,_card,display)=>display}
 deps.inputFieldsProjection={project:()=>({inputSources:[],inputTemplateDisplays:[]})}
 const calls=[];deps.readFailureEvidence=async(s,c)=>{calls.push([s,c]);return evidenceOf()}
 deps.rollbackViewFields=(chat,evidence)=>({target:inspectNativeFailureTail(chat,evidence,chat.windowRevision)?.target??null,evidence})
 deps.assembleTavernView=async values=>({debugTurns:values.debugTurns,...values.rollbackFields})
 const chat={...chatOf(),backgroundConfigVersion:1,conversationFeaturesVersion:1},window={from:0,to:1,messageCount:2,revision:11,nativeFailureCheckpointTurn:6}
 const projector=createSessionWindowProjector(deps)
 const result=await projector.project({chat,window,activity:idle.activity})
 assert.equal(result.view.target?.incomplete,true);assert.deepEqual(calls,[[chat.sessionId,chat.id]])
 const pending={phase:'pending',busy:false};const active=await projector.project({chat,window,activity:pending});assert.equal(active.view.evidence.activity,pending);assert.equal(active.view.target,null)
})
test('不完整清理接线：实际宿主闭包读取前台和后台运行器，缺证明明确拒绝',async()=>{
 const raw=readLatestFailureSource('tavern-plugin/lib/index.js'),source=applyLatestFailureHostTransform(raw)
 assert.equal(applyLatestFailureHostTransform(source),source)
 const begin=source.indexOf('async function readFailureEvidence('),end=source.indexOf('\n  function sessionDebugEvidence(',begin)
 const agents=new Map(),front=new Set(),back=new Set()
 const context=vm.createContext({readFailureEvidenceFromQuery:async()=>evidenceOf(),sessionDebugEvidence:()=>({}),ctx:{get:()=>({})},sessionPatch:null,foldSurfaceForEvidence:()=>({nodes:[]}),agentRegistry:agents,foregroundHandoff:{isBusy:id=>front.has(id)},settlementJobs:{isBusy:id=>back.has(id)}})
 vm.runInContext(source.slice(begin,end)+'\n globalThis.readEvidence=readFailureEvidence;',context)
 assert.equal((await context.readEvidence('s','c')).cleanupIdle,true)
 agents.set('s',{phase:{kind:'running'}});assert.equal((await context.readEvidence('s','c')).cleanupIdle,false);agents.clear()
 front.add('s');assert.equal((await context.readEvidence('s','c')).cleanupIdle,false);front.clear()
 back.add('c');assert.equal((await context.readEvidence('s','c')).cleanupIdle,false);back.clear()
 assert.equal((await context.readEvidence('s','c')).cleanupIdle,true)
 await assert.rejects(context.readEvidence('s'),/静止接线/)
 context.foregroundHandoff={};await assert.rejects(context.readEvidence('s','c'),/静止接线/)
})
test('不完整清理接线：真实结算作业直到收尾完成均busy，旧标记升级和归属隔离',async()=>{
 const raw=readLatestFailureSource('tavern-plugin/lib/domain/settlement-jobs.js')
 const source=applySettlementQuiescenceTransform(raw),context=vm.createContext({AbortController,AbortSignal,Promise})
 assert.equal(applySettlementQuiescenceTransform(source),source)
 const old=source.replace(', isBusy: chatId => jobs.has(chatId)','')
 assert.equal(applySettlementQuiescenceTransform(old),source)
 vm.runInContext(source.replace('export function','function')+'\n globalThis.create=createSettlementJobs;',context)
 let releaseRun,releaseFinish
 const run=new Promise(resolve=>{releaseRun=resolve}),finish=new Promise(resolve=>{releaseFinish=resolve})
 let notified=0
 const jobs=context.create({run:()=>run,onSettled:()=>finish,onIdle:id=>{assert.equal(id,'c');assert.equal(jobs.isBusy(id),false);notified++}}),task=jobs.start('c')
 assert.equal(jobs.isBusy('c'),true);assert.equal(jobs.isBusy('other'),false)
 releaseRun();await Promise.resolve();await Promise.resolve();assert.equal(jobs.isBusy('c'),true)
 releaseFinish();await task;assert.equal(jobs.isBusy('c'),false);assert.equal(notified,1)
 const foregroundRaw=readLatestFailureSource('tavern-plugin/lib/domain/foreground-handoff.js'),foreground=applyForegroundQuiescenceTransform(foregroundRaw)
 assert.equal(applyForegroundQuiescenceTransform(foreground),foreground)
 const oldForeground=foreground.replace('  // 只读成员：前台该 session 是否还有未完成的延迟交接任务（静止证明用，不新增服务/事件/轮询）。\n  function isBusy(sessionId) { return [...pending.values()].includes(sessionId) }','').replace('whenIdle, isBusy })','whenIdle })')
 const upgraded=applyForegroundQuiescenceTransform(oldForeground);assert.equal(applyForegroundQuiescenceTransform(upgraded),upgraded)
 // 抽出生产实现的队列函数，保留真实defer/Promise顺序，避免制造agent或业务副作用。
 const from=foreground.indexOf('  const pending = new Map()'),to=foreground.indexOf('\n\n',foreground.indexOf('function isBusy(sessionId)',from))
 const deferred=[];const idleCalls=[];const fc=vm.createContext({defer:f=>deferred.push(f),logger:{error:()=>{}},options:{onIdle:id=>idleCalls.push(id)},Promise})
 vm.runInContext(foreground.slice(from,to)+'\n globalThis.queue={later,whenIdle,isBusy};',fc)
 let release;const held=new Promise(resolve=>{release=resolve})
 fc.queue.later(()=>held,'synthetic','s');assert.equal(fc.queue.isBusy('s'),true);assert.equal(fc.queue.isBusy('other'),false)
 deferred[0]();const waiting=fc.queue.whenIdle('s');release();await waiting;assert.equal(fc.queue.isBusy('s'),false);assert.deepEqual(idleCalls,['s'])
})
