/** Frozen production install in a publication-only workspace mirror. */
import {globSync,existsSync} from 'node:fs'
import {readFile,mkdir,cp,copyFile,mkdtemp,writeFile} from 'node:fs/promises'
import {join,dirname,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {materializeDesktopWorkspaces,verifyDesktopClosure} from './desktop-closure.mjs'

/**
 * Install locked dependencies without modifying the source workspace, then flatten workspace packages.
 * @param root - Built source repository.
 * @param runtime - New runtime directory.
 * @param run - Shell-free command runner accepting executable, arguments and cwd.
 * @param pnpm - Absolute pnpm JavaScript entry point.
 * @returns Frozen-install metadata saved with the runtime.
 */
export async function buildFrozenDesktopRuntime(root,runtime,run,pnpm){
  const mirror=await mkdtemp(join(dirname(runtime),'.desktop-workspace-'))
  for(const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'])await copyFile(join(root,name),join(mirror,name))
  await cp(join(root,'patches'),join(mirror,'patches'),{recursive:true})
  for(const file of globSync(['vendor/*/package.json','packages/*/*/package.json','apps/*/package.json','native/landlock-run/package.json','native/landlock-run/packages/*/package.json','examples/package.json','python/sdk-runtime/package.json','website/package.json'],{cwd:root})){
    const source=dirname(join(root,file)),destination=dirname(join(mirror,file))
    const manifest=JSON.parse(await readFile(join(root,file),'utf8'))
    await mkdir(destination,{recursive:true})
    for(const name of globSync([...(manifest.files??[]),'package.json','README*','LICENSE*'],{cwd:source})){
      const path=join(source,name)
      if(path.split(sep).includes('node_modules'))continue
      await mkdir(dirname(join(destination,name)),{recursive:true})
      await cp(path,join(destination,name),{recursive:true,dereference:false,filter:p=>!p.split(sep).includes('node_modules')&&!p.split(sep).includes('.git')})
    }
  }
  await run(process.execPath,[pnpm,'--filter','@polus-ai/corch-dsh-desktop...','install','--prod','--frozen-lockfile','--ignore-scripts','--config.node-linker=hoisted'],mirror)
  await run(process.execPath,[pnpm,'rebuild','node-pty','koffi'],mirror)
  if(existsSync(runtime))throw new Error(`Runtime output already exists: ${runtime}`)
  await mkdir(runtime)
  await cp(join(mirror,'node_modules'),join(runtime,'node_modules'),{recursive:true,dereference:false})
  await copyFile(join(root,'apps/desktop/package.json'),join(runtime,'package.json'))
  const workspacePackages=await materializeDesktopWorkspaces(root,runtime,mirror)
  const packages=await verifyDesktopClosure(runtime,root)
  const lock=createHash('sha256').update(await readFile(join(root,'pnpm-lock.yaml'))).digest('hex')
  const receipt={frozen_install:true,lock_sha256:lock,packages,workspace_packages:workspacePackages.length}
  await writeFile(join(runtime,'DESKTOP-CLOSURE.json'),JSON.stringify(receipt,null,2)+'\n')
  return receipt
}
