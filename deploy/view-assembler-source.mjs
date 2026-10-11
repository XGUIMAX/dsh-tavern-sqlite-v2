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
  return 'export async function assembleTavernView(values) {\nconst {' + values.join(',') + '} = values\nreturn ' + source.slice(fields.start,fields.end) + '\n}\n'
}
