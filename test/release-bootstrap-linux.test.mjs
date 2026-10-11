// 发行SH从bootstrap源生成；只验Linux直接入口门槛，不跑构建/网络/酒馆。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
test('发行Linux获取器：实际模板生成体只认包身份和维护入口，保其它平台旧门槛',()=>{
 const source=fs.readFileSync(new URL('../deploy/bootstrap.mjs',import.meta.url),'utf8'),template=fs.readFileSync(new URL('../deploy/install.template.sh',import.meta.url),'utf8'),pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'))
 const embedded=template.replace('__DSH_RELEASE_VERSION__',()=>pkg.version).replace('__DSH_BOOTSTRAP_SOURCE__',()=>source)
 assert.ok(embedded.includes(source));assert.ok(source.includes("process.platform === 'linux' ? '使用本地插件包；定位接缝后直接维护，完成后保持原运行状态。'"))
 const node=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.find(n=>n.type==='ExportNamedDeclaration'&&n.declaration?.id?.name==='validatePackage').declaration
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-bootstrap-linux-'))
 try{
  fs.mkdirSync(path.join(root,'deploy'));fs.writeFileSync(path.join(root,'deploy','maintenance.mjs'),'// 合成执行入口\n','utf8')
  const file=path.join(root,'package.json'),good={name:'dsh-tavern-sqlite-v2',dependencies:{synthetic:'*'}};fs.writeFileSync(file,JSON.stringify(good),'utf8')
  const validate=platform=>vm.runInNewContext(source.slice(node.start,node.end)+'\nvalidatePackage',{fs,path,process:{platform},NAME:'dsh-tavern-sqlite-v2'})
  assert.equal(validate('linux')(root).name,good.name);assert.throws(()=>validate('win32')(root),/不是完整V2包/)
  fs.writeFileSync(file,JSON.stringify({name:'other'}),'utf8');assert.throws(()=>validate('linux')(root),/未找到本插件安装入口/)
  fs.writeFileSync(file,JSON.stringify(good),'utf8');const entry=path.resolve(root,'deploy','maintenance.mjs');assert.ok(entry.startsWith(root+path.sep));fs.unlinkSync(entry);assert.throws(()=>validate('linux')(root),/未找到本插件安装入口/)
 }finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('release-bootstrap-linux-'));fs.rmSync(root,{recursive:true,force:true})}
})
