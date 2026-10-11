// 只把作者活动判定体转接至同一纯内核；timeline.inspect仍由作者负责，不改变取数/任务协调。
import { parse } from '../lib/vendor/acorn/acorn.mjs'
const MARKER = '// [dsh-tavern-activity-state:v1]'
export function applyActivityStateTransform(source) {
  const importLine = "import { activityFromSmallRows } from './storage-native-data.js'"
  const nextBody = '{\n    return activityFromSmallRows(timeline.inspect({ chat }))\n  }'
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2 || !source.includes(importLine) || !source.includes('function activity(chat) ' + nextBody)) throw new Error('活动内核接线标记不完整')
    return source
  }
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const factory = ast.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'createBackgroundTaskCoordinator')?.declaration
  const matches = factory?.body?.body?.filter(node => node.type === 'FunctionDeclaration' && node.id?.name === 'activity') || []
  if (matches.length !== 1) throw new Error('活动内核接线缺少唯一作者activity')
  const fn = matches[0]
  if (fn.params.length !== 1 || fn.params[0].name !== 'chat' || !source.slice(fn.body.start, fn.body.end).includes('timeline.inspect({ chat })')) throw new Error('活动内核接线作者输入合同漂移')
  return importLine + '\n' + MARKER + '\n' + source.slice(0, fn.body.start) + nextBody + source.slice(fn.body.end)
}
