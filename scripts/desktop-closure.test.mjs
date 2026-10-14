import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {materializeDesktopWorkspaces,verifyDesktopClosure} from './desktop-closure.mjs'

test('missing required peers fail even when the entry package itself exists',async()=>{
  const root=await mkdtemp(join(tmpdir(),'corch-closure-'))
  try{
    await writeFile(join(root,'package.json'),JSON.stringify({name:'desktop',dependencies:{adapter:'1'}}))
    await mkdir(join(root,'node_modules/adapter'),{recursive:true})
    const file=join(root,'node_modules/adapter/package.json')
    await writeFile(file,JSON.stringify({name:'adapter',peerDependencies:{service:'1',optional:'1'},peerDependenciesMeta:{optional:{optional:true}}}))
    await assert.rejects(verifyDesktopClosure(root),/adapter requires service/)
    await mkdir(join(root,'node_modules/service'))
    await writeFile(join(root,'node_modules/service/package.json'),JSON.stringify({name:'service'}))
    assert.equal(await verifyDesktopClosure(root),3)
  }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'corch-closure-'));await rm(root,{recursive:true})}
})

test('workspace materialization copies publication files without source-private files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'corch-closure-'))
  try{
    const source=join(root,'repo'),runtime=join(root,'runtime')
    await mkdir(join(source,'apps/desktop'),{recursive:true})
    await mkdir(join(source,'vendor/utility/lib'),{recursive:true})
    await mkdir(runtime)
    await writeFile(join(source,'apps/desktop/package.json'),JSON.stringify({dependencies:{utility:'workspace:^'}}))
    await writeFile(join(source,'vendor/utility/package.json'),JSON.stringify({name:'utility',version:'1.0.0',files:['lib/*.js']}))
    await writeFile(join(source,'vendor/utility/lib/index.js'),'export const value=1\n')
    await writeFile(join(source,'vendor/utility/.env'),'DO_NOT_COPY=private\n')
    assert.deepEqual(await materializeDesktopWorkspaces(source,runtime),['utility'])
    assert.equal(await readFile(join(runtime,'node_modules/utility/lib/index.js'),'utf8'),'export const value=1\n')
    await assert.rejects(readFile(join(runtime,'node_modules/utility/.env')), {code:'ENOENT'})
    assert.deepEqual(await materializeDesktopWorkspaces(source,runtime),[])
  }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'corch-closure-'));await rm(root,{recursive:true})}
})
