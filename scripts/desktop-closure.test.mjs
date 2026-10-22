import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,writeFile,rm,readFile,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {desktopDependencyFile,materializeDesktopWorkspaces,sanitizeDesktopDebugLabels,verifyDesktopClosure} from './desktop-closure.mjs'
import {buildFrozenDesktopRuntime} from './desktop-frozen-build.mjs'

test('portable dependencies exclude compiler state and maps while retaining runtime and declarations',()=>{
  assert.equal(desktopDependencyFile(join('runtime','lib','tsconfig.tsbuildinfo')),false)
  assert.equal(desktopDependencyFile(join('runtime','lib','client.js.map')),false)
  assert.equal(desktopDependencyFile(join('runtime','lib','client.js')),true)
  assert.equal(desktopDependencyFile(join('runtime','lib','types','index.d.ts')),true)
})

test('portable debug cleanup preserves code and license comments',async()=>{
  const root=await mkdtemp(join(tmpdir(),'corch-closure-'))
  try{
    await writeFile(join(root,'index.js'),'/*! MIT license */\n//#region C:\\Users\\builder\\project\\style.css\nexport const value = "untouched"\n//# sourceMappingURL=index.js.map\n')
    assert.equal(await sanitizeDesktopDebugLabels(root),1)
    assert.equal(await readFile(join(root,'index.js'),'utf8'),'/*! MIT license */\nexport const value = "untouched"\n')
  }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'corch-closure-'));await rm(root,{recursive:true})}
})

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

test('frozen install staging stays outside the portable payload',async()=>{
  const root=await mkdtemp(join(tmpdir(),'corch-closure-'))
  try{
    const source=join(root,'repo'),resources=join(source,'dist/windows/client/resources'),runtime=join(resources,'runtime')
    await mkdir(join(source,'apps/desktop'),{recursive:true})
    await mkdir(join(source,'patches'))
    await mkdir(resources,{recursive:true})
    await writeFile(join(source,'package.json'),JSON.stringify({name:'fixture-repository',private:true}))
    await writeFile(join(source,'pnpm-lock.yaml'),'lockfileVersion: "9.0"\npackages: {}\n')
    await writeFile(join(source,'pnpm-workspace.yaml'),'packages:\n  - apps/*\n')
    await writeFile(join(source,'apps/desktop/package.json'),JSON.stringify({
      name:'@polus-ai/corch-dsh-desktop',version:'1.0.0',dependencies:{},files:[],
    }))
    const calls=[]
    const receipt=await buildFrozenDesktopRuntime(source,runtime,async(bin,args,cwd)=>{
      calls.push({bin,args,cwd})
      await mkdir(join(cwd,'node_modules'),{recursive:true})
    },'fixture-pnpm.mjs')
    assert.equal(receipt.frozen_install,true)
    assert.equal(receipt.packages,1)
    assert.equal(calls.length,2)
    assert.ok(calls[0].args.includes('--frozen-lockfile'))
    assert.ok(calls[0].cwd.startsWith(join(source,'.tmp')+sep+'desktop-workspace-'))
    assert.equal(calls[1].cwd,calls[0].cwd)
    assert.deepEqual(await readdir(resources),['runtime'])
    assert.equal(JSON.parse(await readFile(join(runtime,'DESKTOP-CLOSURE.json'),'utf8')).packages,1)
  }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'corch-closure-'));await rm(root,{recursive:true})}
})
