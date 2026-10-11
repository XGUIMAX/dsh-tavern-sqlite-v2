// 从本次作者源码提取纯宏/只读slash内核；不加载浏览器模块，不保存冻结算法副本。
import { parse } from '../lib/vendor/acorn/acorn.mjs'
function declaration(source, name, parent) {
  const ast = parent || parse(source, { ecmaVersion: 'latest', sourceType: 'script' })
  const matches = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) matches.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  // built是同一份include编译结果，函数位于外层client闭包；仍只认唯一具名声明。
  visit(ast)
  if (matches.length !== 1) throw Error('作者只读内核缺少唯一函数：' + name)
  return matches[0]
}
export function helperReadonlySource(macroSource, slashSource) {
  const macro = declaration(macroSource, 'installTavernHelperMacroApi')
  const executor = declaration(slashSource, 'createTavernFrameSlashExecutor')
  const functions = ['slashError', 'decodeSlashText', 'readPipeline', 'executeReadPipeline'].map(name => {
    const node = declaration(slashSource, name, executor)
    return slashSource.slice(node.start, node.end)
  })
  // executeReadPipeline唯一外部能力是只读rpc；显式适配两端世界书结果，拒绝其它调用。
  const body = functions.join('\n')
  if (!body.includes("rpc('getTavernHelperWorldbook', { name: file }, sessionId)")) throw Error('作者只读slash取书合同漂移')
  return 'export ' + macroSource.slice(macro.start, macro.end) + '\n' +
    'export function createSlashReader({getWorldbook}) {\n' +
    'const rpc = async (method, args, sessionId) => { if (method !== "getTavernHelperWorldbook") throw Error("只读管道越界"); return {worldbook:{entries:await getWorldbook(sessionId,args.name)}} }\n' +
    body + '\nreturn {readPipeline,executeReadPipeline,slashError}\n}\n'
}
