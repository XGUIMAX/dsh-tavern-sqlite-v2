// 原创模拟卡与假远程响应，验证真实服务端执行消费者；不读取实际卡/档或启动GUI。
//
// 结构（2026-10-13 改造，本文件独占）：顶层只保留**纯读取与夹具定义** —— 依赖加载（lodash/YAML/zod）、
// 夹具工厂、脚本内容字面量、作者源码 readFileSync；**顶层不执行任何业务调用**（不构造 execution、不发命令）。
// 全部断言改为具名 node:test 叶用例：门禁可用 `--file esm-server-consumer.test.mjs --name '<叶名>'` 精确选叶，
// 不再"加载期跑整文件 + 零叶"。每个叶自带 execution/数组/cleanup（finally disposeAll）。
// ⚠ 原期待一字未删、未放宽、未改写：断言文本与被断言的夹具字面量均按原文保留；与 VM/ESM 相关的叶在缺
//   --experimental-vm-modules 时沿用原 if/else 语义（拒绝分支单独具名，见下方条件叶）。
import assert from 'node:assert/strict'
import vm from 'node:vm'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createServerExecution, classifyCardScript, projectServerScripts, storageBrowserScripts } from '../lib/server-execution.js'
import { createCardScriptRuntime } from '../lib/mvu/mvu-card-runtime.js'
import { applyRuntimeTransform } from '../deploy/core-runtime-transform.mjs'
const require = createRequire(new URL('../../../tools/mvu-server-core/package.json',import.meta.url))
const lodash=require('lodash')
const YAML=require('yaml')
// 作者已有发布资源仅用于本地API消费者夹具，不冒认裁剪B2.4树具有完整资源。
const zod=await import('../../../dsh-tavern-main/tavern-plugin/lib/vendor/runtime-assets/zod/index.mjs')

// ── 公共夹具：只定义，不执行；可变状态（exec/数组/标记）一律在叶内新建 ──────────────
const logger={info(){},warn(){},error(){}}
const chat=()=>({id:'esm-owned-chat',sessionId:'esm-owned-session',cardPath:'esm-owned-card',cardDefinitionSnapshot:{name:'夹具卡',extensions:{fixture:true}},messages:[{role:'assistant',text:'正文',swipeId:0,swipes:['正文'],variables:[{stat_data:{hp:1},schema:{}}]}]})
const root={id:'schema-script',name:'schema脚本',content:`import { derived } from 'https://modules.example/derived.mjs';
import { eventOn, Mvu, getVariables, getScriptVariables, getChatMessages, insertVariables, deleteVariable, replaceScriptVariables } from 'tavern-helper';
await Promise.resolve();
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, async (_before, after) => {
  after.stat_data.derived=derived(getVariables().stat_data.hp);
  after.stat_data.global=getVariables({type:'global'}).score;
  after.stat_data.character=getVariables({type:'character'}).flag;
  after.stat_data.floor=getChatMessages('0-{{lastMessageId}}')[0].message;
  await replaceScriptVariables({registered: true});
  after.stat_data.owner=getScriptVariables().registered ? 1 : 0;
  await insertVariables({extra:1});
  await deleteVariable('extra');
});`}
const ui={id:'ui-script',name:'界面',content:"import x from 'https://modules.example/ui.mjs'; document.querySelector('#app')"}
const hookDom={id:'hook-dom',name:'钩子依赖界面',content:"import {eventOn,Mvu} from 'tavern-helper';eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, async()=> { await import('https://hook-ui.example/widget.mjs') })"}
const backgroundRoot={id:'background-import',name:'不等待导入',content:"import {eventOn,Mvu} from 'tavern-helper';eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,()=> { import('https://missing.example/bad.mjs').catch(()=>{}) })"}
const domRoot={id:'domroot',name:'依赖界面',content:"import 'https://ui.example/widget.mjs'"}
const promptRoot={id:'prompt',name:'提示词模块',content:"import {eventOn,Mvu,injectPrompts} from 'tavern-helper';eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,()=>injectPrompts([{id:'fixture-prompt',content:'fixture'}],{once:true}))"}
const regexRoot={id:'regex',name:'正则模块',content:"import {eventOn,Mvu,getTavernRegexes,replaceTavernRegexes} from 'tavern-helper';eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,async(_before,after)=>{after.stat_data.regexes=getTavernRegexes({type:'global'}).length;await replaceTavernRegexes([], {type:'global'})})"}
const schemaRoot={id:'schema-api',name:'schema/YAML模块',content:"import {eventOn,Mvu,z,YAML} from 'tavern-helper';const schema=z.object({hp:z.number()});eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,(_before,after)=>{after.stat_data.schemaHp=schema.parse(YAML.parse('hp: 12')).hp})"}
// 作者源码只读（纯 read；变换调用在叶内，不在顶层执行）。
const authorAdapterSource=readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-script-host-adapter.js',import.meta.url),'utf8')

/** 夹具工厂（只定义）：每次调用返回独立 exec 与写日志数组，不跨叶共享可变状态。 */
function executionFixture(scripts, esm={}) {
  const writes=[]
  const exec=createServerExecution({logger,lodash,hookLoadBudgetMs:1,
    host:{updateVariables:async (_session,option,value)=> {if(option.type==='script')writes.push(option.script_id);return {updated:true}}, updateMessages:async()=>({updated:true})},
    readResourceSnapshot:async()=>({globalVariables:{score:9}}),readCardExtensions:async()=>({helperScripts:scripts,variables:{flag:7}}),project:scripts=>({scripts}),
    esm:{lookupImpl:async()=>[{address:'8.8.8.8',family:4}],fetchImpl:async()=>new Response('export const derived = hp => hp + 10'),...esm},
    executeCommand:async (_text,variables,emit)=>{variables.stat_data.hp=3;await emit('mag_variable_update_ended',variables,variables);return true},
  })
  return {exec,writes}
}
const execute=(exec,draft=chat())=>exec.executeMvuUpdate({sessionId:draft.sessionId,draft,transaction:{eventId:'mvu-work:esm-owned'},messageId:0,swipeId:0,commandText:'受控命令'})

// ── 叶用例 ────────────────────────────────────────────────────────────────

test('分类与两侧消费者投影：静态 import 与首行注释的分派不改', () => {
  assert.equal(classifyCardScript('// schema脚本说明\n'+root.content),'esm','首行注释不能让静态import漏分派')
  assert.equal(classifyCardScript(root.content),'esm')
  assert.equal(classifyCardScript(ui.content),'browser-ui')
  assert.deepEqual(projectServerScripts([root,ui]).map(x=>x.id),[root.id])
  assert.deepEqual(storageBrowserScripts([root,ui]).map(x=>x.id),[ui.id])
})

test('缺 flag：真实服务端 ESM 消费者必须明确拒绝（原断言具名保留）', async t => {
  t.diagnostic('原日志：esm-server-consumer: 缺flag真实消费者明确拒绝通过')
  if (typeof vm.SourceTextModule==='function') {
    // 原文件用 if/else 分叉：带 flag 时该拒绝分支的前提不成立。此处保持原语义，不另加断言、也不 skip。
    t.diagnostic('本运行带 --experimental-vm-modules：缺-flag 拒绝分支不适用（原断言保留在另一分支）')
    return
  }
  const {exec}=executionFixture([root])
  try{await assert.rejects(execute(exec),/experimental-vm-modules/)}finally{exec.disposeAll()}
})

test('服务端 ESM 消费者：真实模块派生钩子与同步快照（脚本变量 owner、read-your-writes）', async () => {
  const {exec,writes}=executionFixture([root,ui])
  try{
    const outcome=await execute(exec)
    assert.equal(outcome.variables.stat_data.derived,13)
    assert.equal(outcome.variables.stat_data.global,9)
    assert.equal(outcome.variables.stat_data.character,7)
    assert.equal(outcome.variables.stat_data.floor,'正文')
    assert.equal(outcome.variables.extra,undefined)
    assert.deepEqual(writes,['schema-script'],'模块钩子默认脚本变量必须带真实owner')
    assert.equal(outcome.variables.stat_data.owner,1,'脚本变量读取同步且read-your-writes')
  }finally{exec.disposeAll()}
})

test('动态依赖图：钩子内动态 import 命中 DOM 时只标当前根脚本，不退成整卡标记', async () => {
  // 实际生产标记器必须只标当前根脚本；不能把依赖URL匹配失败退成整卡标记。
  const marks=[]
  const marked=createServerExecution({logger,lodash,host:{updateVariables:async()=>({updated:true})},project:scripts=>({scripts}),readCardExtensions:async()=>({helperScripts:[hookDom]}),
    cardScriptDispatchStore:{lookupCard:()=>null,lookupScript:()=>null,markScript:(_card,id)=>marks.push(id),markCard:()=>marks.push('整卡')},
    esm:{lookupImpl:async()=>[{address:'8.8.8.8',family:4}],fetchImpl:async()=>new Response("document.querySelector('#app')")},
    executeCommand:async(_text,v,emit)=>{await emit('mag_variable_update_ended',v,v);return true},
  })
  try{await assert.rejects(execute(marked),/DOM/);assert.ok(marks.length>0);assert.ok(marks.every(id=>id==='hook-dom'))}finally{marked.disposeAll()}
})

test('未 await 的动态导入失败：模块执行失败必须原样上报', async () => {
  const {exec}=executionFixture([backgroundRoot],{fetchImpl:async()=>new Response('throw new Error("模块执行失败")')})
  try{await assert.rejects(execute(exec),/模块执行失败/)}finally{exec.disposeAll()}
})

test('根脚本静态 import 命中 DOM：拒绝执行并报浏览器脚本/界面', async () => {
  const {exec}=executionFixture([domRoot],{fetchImpl:async()=>new Response("document.querySelector('#app')")})
  try{await assert.rejects(execute(exec),/DOM|浏览器|界面/)}finally{exec.disposeAll()}
})

test('提示词成功：injectPrompts once 与事件身份随结算传递', async () => {
  const prompts=[]
  const promptExecution=createServerExecution({logger,lodash,host:{updateVariables:async()=>({updated:true}),updatePrompts:async(_session,operation,_revision,eventId)=>{await Promise.resolve();prompts.push({operation,eventId});return {updated:true}}},project:scripts=>({scripts}),readCardExtensions:async()=>({helperScripts:[promptRoot]}),executeCommand:async(_text,v,emit)=>{await emit('mag_variable_update_ended',v,v);return true}})
  try{await execute(promptExecution);assert.equal(prompts[0].operation.once,true);assert.equal(prompts[0].eventId,'mvu-work:esm-owned')}finally{promptExecution.disposeAll()}
})

test('提示词失败：写入 CAS 失败必须响亮上报', async () => {
  const failedPrompt=createServerExecution({logger,lodash,host:{updateVariables:async()=>({updated:true}),updatePrompts:async()=>{await Promise.resolve();throw new Error('提示词CAS失败')}},project:scripts=>({scripts}),readCardExtensions:async()=>({helperScripts:[promptRoot]}),executeCommand:async(_text,v,emit)=>{await emit('mag_variable_update_ended',v,v);return true}})
  try{await assert.rejects(execute(failedPrompt),/提示词CAS失败/)}finally{failedPrompt.disposeAll()}
})

test('正则拒写：MVU 结算事务内写跨存储正则设置必须被拒（原失败 regex /跨存储正则设置/ 对应叶）', async () => {
  const regex=createServerExecution({logger,lodash,host:{updateVariables:async()=>({updated:true}),saveExtensionSettings:async()=>{throw new Error('MVU结算事务不允许写入跨存储正则设置')}},project:scripts=>({scripts}),readResourceSnapshot:async()=>({extensionSettings:{regex:[]}}),readCardExtensions:async()=>({helperScripts:[regexRoot],globalRegexScripts:[{id:'g',name:'fixture',findRegex:'foo',placement:[2]}]}),executeCommand:async(_text,v,emit)=>{await emit('mag_variable_update_ended',v,v);return true}})
  try{await assert.rejects(execute(regex),/跨存储正则设置/)}finally{regex.disposeAll()}
})

test('schema/YAML：卡脚本内 z/YAML 可用且解析结果进变量', async () => {
  const schemaExecution=createServerExecution({logger,lodash,YAML,zod,host:{updateVariables:async()=>({updated:true})},project:scripts=>({scripts}),readCardExtensions:async()=>({helperScripts:[schemaRoot]}),executeCommand:async(_text,v,emit)=>{await emit('mag_variable_update_ended',v,v);return true}})
  try{assert.equal((await execute(schemaExecution)).variables.stat_data.schemaHp,12)}finally{schemaExecution.disposeAll()}
})

test('事件 once 与顺序：first/normal/once/last 稳定且 initializeGlobal 就绪', async t => {
  const trace=[]
  const rt=createCardScriptRuntime({cardPath:'event-fixture',logger,sources:[{id:'events',name:'events',kind:'esm',code:`
    import { eventOn,eventOnce,eventMakeFirst,eventMakeLast,eventClearEvent } from 'tavern-helper';
    eventOn('x',()=>trace.push('normal'));eventOnce('x',()=>trace.push('once'));eventMakeFirst('x',()=>trace.push('first'));eventMakeLast('x',()=>trace.push('last'));
    initializeGlobal('schema', {ready:true});await waitGlobalInitialized('schema');
  `}],hostApi:{trace}})
  try{await rt.ready;await rt.dispatchEvent({strict:true},'x');await rt.dispatchEvent({strict:true},'x');assert.deepEqual(trace,['first','normal','once','last','first','normal','last']);assert.equal(rt.sandbox.schema.ready,true)}finally{rt.dispose()}
  t.diagnostic('原日志：esm-server-consumer: 真实模块派生钩子/同步快照/Helper/graphDOM拒绝/事件一次及顺序通过')
})

test('变换 DI 幂等：applyRuntimeTransform 注入 readResourceSnapshot 且重复施加不变', async t => {
  const transformed=applyRuntimeTransform(authorAdapterSource)
  assert.ok(transformed.includes('readResourceSnapshot: async (sessionId, chat)'))
  assert.equal(applyRuntimeTransform(transformed),transformed)
  t.diagnostic('原日志：esm-server-consumer: 实际作者加载期资源快照DI/幂等通过')
})

test('ESM 动态 import 拒绝的跨 realm 转换：catch 到的 e 不得逃逸到宿主 process（保原 code/message），loader 故障仍响亮影响 runtime', async t => {
  const captured=[],fields=[],escapes=[]
  const code=`
    import { eventOn } from 'tavern-helper';
    eventOn('x', async () => {
      try { await import('https://bad.example/missing.mjs') } catch (error) {
        report(error);
        reportFields([String(error.name), String(error.code), String(error.message)]);
        try { reportEscape('LEAK:' + String(error.constructor.constructor('return process')())); }
        catch (inner) { reportEscape('REJECTED:' + String(inner && inner.name)); }
      }
    });
  `
  // 虚构源：lookup/fetch 全 mock，禁真实网（502 让下载器确定失败并带 ESM_FETCH_FAILED 码）。
  const rt=createCardScriptRuntime({cardPath:'esm-realm-fixture',logger,sources:[{id:'x',name:'x',kind:'esm',code}],
    hostApi:{report:value=>captured.push(value),reportFields:value=>fields.push(value),reportEscape:text=>escapes.push(text)},
    moduleOptions:{lookupImpl:async()=>[{address:'8.8.8.8',family:4}],fetchImpl:async()=>new Response('upstream error',{status:502,headers:{'content-type':'text/plain'}})}})
  try{
    await rt.ready
    // 加载期没有动态 import：故障出现在派发期，且脚本自己 catch 了它；strict 派发仍必须响亮（mustFail 不放宽）。
    let failure
    await assert.rejects(()=>rt.dispatchEvent({strict:true},'x'),
      error=>{failure=error;return /ESM模块HTTP失败：502/.test(String(error&&error.message))},
      'loader 故障必须让 strict 派发失败，不能因为脚本 catch 了 import 就被吞')
    assert.equal(failure.code,'ESM_FETCH_FAILED','loader 故障必须以原 code 影响 runtime')
    assert.equal(captured.length,1,'hook catch 到的错误必须实际到达宿主（跨 realm 转换一次）')
    assert.equal(captured[0].code,'ESM_FETCH_FAILED','宿主侧副本必须保留原 code')
    assert.match(String(captured[0].message),/ESM模块HTTP失败：502/,'宿主侧副本必须保留原 message')
    assert.deepEqual(fields[0],['Error','ESM_FETCH_FAILED','ESM模块HTTP失败：502 https://bad.example/missing.mjs'],'sandbox 内 caught e 的 name/code/message 必须保原')
    assert.equal(escapes.length,1)
    assert.match(String(escapes[0]),/^REJECTED:/,'宿主 Error 不得跨 realm 裸穿：e.constructor.constructor("return process") 必须被拒，实测='+String(escapes[0]))
    t.diagnostic('realm 逃逸实测='+String(escapes[0])+'；strict 拒绝 code='+String(failure.code))
  }finally{rt.dispose()}
})
