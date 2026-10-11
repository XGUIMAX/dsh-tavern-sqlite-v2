// 直接提取只读作者夹具的最终字段表，为独立projector消费者提供真实组装器。
import fs from 'node:fs'
import {viewAssemblerSource} from '../../deploy/view-assembler-source.mjs'
const source=fs.readFileSync(new URL('../../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/lib/index.js',import.meta.url),'utf8')
export const {assembleTavernView}=await import('data:text/javascript;base64,'+Buffer.from(viewAssemblerSource(source),'utf8').toString('base64'))
