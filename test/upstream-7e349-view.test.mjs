// 最新作者字段与latestTurnFields作为真对照；DI沿既有native-opening夹具，仅合成窗口/会话。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
import {viewAssemblerSource} from '../deploy/view-assembler-source.mjs'
import {createSessionWindowProjector} from '../lib/session-window-projector.js'
const read=rel=>fs.readFileSync(new URL(rel,import.meta.url),'utf8')
function functionText(source,name){let found;const visit=n=>{if(!n||typeof n!=='object')return;if(n.type==='FunctionDeclaration'&&n.id?.name===name)found=n;for(const value of Object.values(n))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value)};visit(parse(source,{ecmaVersion:'latest',sourceType:'module'}));assert.ok(found,name);return source.slice(found.start,found.end)}
function assembler(source){return new Function(viewAssemblerSource(source).replace('export async function','async function')+'\nreturn assembleTavernView')()}
test('上游7e349轮次投影：真作者新旧字段统一最新12条，缓存隔离及追加回退最新轮和消息ID同步',async()=>{
 const latest=read('../../../tmp/upstream-7e349-review/index.js'),old=read('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/lib/index.js')
 const support=read('./native-opening-view.test.mjs'),buildFixture=new Function(functionText(support,'buildFixture')+';return buildFixture')()
 const assembleNew=assembler(latest),assembleOld=assembler(old)
 const buildDeps=new Function('assembleTavernView',functionText(support,'buildDeps')+';return buildDeps')(assembleNew)
 const live={id:'synthetic'},str=x=>x===undefined||x===null?'':String(x),assistantResultForTurn=(_live,turn)=>({event:{data:{message:{id:'message-'+turn}}}})
 const fields=new Function('str','sessionStore','agentRegistry','assistantResultForTurn',functionText(latest,'latestTurnFields')+';return latestTurnFields')(str,{get:()=>live},{get:()=>null},assistantResultForTurn)
 for(const assembleTavernView of [assembleNew,assembleOld]){
  const fixture=buildFixture(),deps=buildDeps(fixture);deps.assembleTavernView=assembleTavernView;deps.liveSessionFor=()=>live;deps.assistantResultForTurn=assistantResultForTurn
  const projector=createSessionWindowProjector(deps)
  let messages=Array.from({length:13},(_,i)=>({role:'assistant',turn:i+1,sourceText:'正文 '+(i+1)}))
  const project=async(revision,sessionId='session-1')=>{const chat={...fixture.chat,sessionId,messages,timeline:{branchId:'b',revision}},window={...fixture.window,messageCount:messages.length,to:messages.length-1,revision};const result=await projector.project({chat,window,activity:fixture.activity,resourceKey:'card-revision'});assert.equal(result.kind,'value');const actual=fields(chat);assert.deepEqual(result.view.debugTurns,actual.debugTurns);assert.equal(result.view.latestAssistantTurn,actual.latestAssistantTurn);assert.equal(result.view.latestAssistantMessageId,actual.latestAssistantMessageId);return result.view}
  const first=await project(1);assert.deepEqual(first.debugTurns.map(t=>t.turn),[13,12,11,10,9,8,7,6,5,4,3,2]);first.debugTurns[0].preview='调用方修改'
  const cached=await project(1);assert.notEqual(cached.debugTurns,first.debugTurns);assert.equal(cached.debugTurns[0].preview,'正文 13')
  messages=[...messages,{role:'assistant',turn:14,text:'正文 14'}];await project(2)
  messages=messages.slice(0,1);const rewind=await project(3);assert.equal(rewind.latestAssistantTurn,1);assert.equal(rewind.latestAssistantMessageId,'message-1')
  messages=[{role:'assistant',turn:7,text:'独立会话'}];const other=await project(3,'session-other');assert.equal(other.latestAssistantTurn,7)
 }
})

test('上游7e349字段接缝负例：旧slice只认12且不接受reverse带实参',()=>{
 const old=read('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/lib/index.js')
 assert.throws(()=>viewAssemblerSource(old.replace('debugTurns.slice(-12).reverse()', 'debugTurns.slice(-5).reverse()')),/debugTurns字段形状未知/)
 assert.throws(()=>viewAssemblerSource(old.replace('debugTurns.slice(-12).reverse()', 'debugTurns.slice(-12).reverse(1)')),/debugTurns字段形状未知/)
})
