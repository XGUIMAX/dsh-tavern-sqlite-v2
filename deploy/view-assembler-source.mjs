// 从本次作者view抽取最终字段组装；插件只准备SQL窗口/资源输入，不维护第二份字段表。
import { parse } from '../lib/vendor/acorn/acorn.mjs'
export function viewAssemblerSource(source) {
  const ast = parse(source, {ecmaVersion:'latest',sourceType:'module'})
  const matches = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'view') matches.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(ast)
  if (matches.length !== 1) throw Error('作者最终view缺少唯一函数')
  const returns = matches[0].body.body.filter(node=>node.type==='ReturnStatement' && node.argument?.type==='ObjectExpression')
  if (returns.length !== 1) throw Error('作者最终view字段布局未知')
  const fields = returns[0].argument
  const names = fields.properties.filter(p=>p.type==='Property').map(p=>p.key.name || p.key.value)
  for (const key of ['chatId','tavernHelper','tavernStatusViews','activity','settleStatus']) if (!names.includes(key)) throw Error('作者最终view字段合同缺失：'+key)
  const values = ['chat','card','str','deferResources','resourceRevision','activePresetSnapshot','cardUpdate','debugTurns','latestAssistantMessageId','forkTurnsByMessageId','latestStoryTurn','inputSources','inputTemplateDisplays','rollbackFields','replyDisplay','helperContext','helperWorldbook','cardExtensions','helperRuntime','runtimeSettings','activity','scriptProgress',
    'cardViewOf','sessionResources','readLedger','manualLedger','projectCharacterDesignDocument','manualCharacterDesign','phoneChat','mvuReceiptsOf','sessionOpeningDescriptor','readPromptTemplateGlobalVariables','TAVERN_COMPATIBILITY_CAPABILITIES','tavernExtensionSettings','OFFICIAL_MVU_VERSION','TAVERN_RELEASE_CAPABILITIES','rescueHistoryNotice','settlementTurn']
  // debugTurns 新旧作者兼容（不改作者 index 本体，只在生成的 fields 片段内以源码区间 splice）：
  // 旧作者 `debugTurns.slice(-12).reverse()`（末尾12条再倒序）与新作者裸 `debugTurns`（已最新优先）统一输出
  // `values.debugTurns`（**最新优先、最多12行**，由我方 projector 提供），其余形状一律拒。
  const debugProps = fields.properties.filter(p=>p.type==='Property' && (p.key.name || p.key.value) === 'debugTurns')
  if (debugProps.length !== 1) throw Error('作者最终view的debugTurns字段不唯一或缺失')
  const debugValue = debugProps[0].value
  const bare = debugValue.type === 'Identifier' && debugValue.name === 'debugTurns'
  const sliceCall = debugValue.callee?.object
  const legacy = !bare && debugValue.type === 'CallExpression'
    && debugValue.callee?.type === 'MemberExpression' && debugValue.callee.property?.name === 'reverse'
    && debugValue.callee.object?.type === 'CallExpression'
    && sliceCall?.callee?.type === 'MemberExpression' && sliceCall.callee.property?.name === 'slice'
    && sliceCall.callee.object?.type === 'Identifier' && sliceCall.callee.object.name === 'debugTurns'
    && debugValue.arguments.length === 0 && !debugValue.callee.computed && !sliceCall.callee.computed
    && sliceCall.arguments?.length === 1 && source.slice(sliceCall.arguments[0].start, sliceCall.arguments[0].end) === '-12'
  if (!bare && !legacy) throw Error('作者最终view的debugTurns字段形状未知（须为裸 debugTurns 或 debugTurns.slice(-N).reverse()）')
  let fieldsText = source.slice(fields.start, fields.end)
  if (legacy) {
    const from = debugValue.start - fields.start, to = debugValue.end - fields.start
    fieldsText = fieldsText.slice(0, from) + 'debugTurns' + fieldsText.slice(to)
  }
  return 'export async function assembleTavernView(values) {\nconst {' + values.join(',') + '} = values\nreturn ' + fieldsText + '\n}\n'
}
