/** Package the built CLI/Web dependency closure with pinned official Windows runtimes. */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, lstat, cp, copyFile, rename } from 'node:fs/promises'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { copyPortableDesktopRuntime, desktopDependencyFile, sanitizeDesktopDebugLabels, verifyDesktopClosure } from './desktop-closure.mjs'
import { buildFrozenDesktopRuntime } from './desktop-frozen-build.mjs'

const root = resolve(import.meta.dirname, '..')
const {values} = parseArgs({options:{out:{type:'string'},cache:{type:'string'},closure:{type:'string'}}})
const out = resolve(values.out ?? join(root,'dist/windows/Corch-DSH'))
const cache = resolve(values.cache ?? join(root,'.tmp/desktop-downloads'))
if (existsSync(out)) throw new Error(`Output already exists: ${out}; choose a new directory`)
if (out === root || root.startsWith(out+sep)) throw new Error('Output cannot contain the repository')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Package on Windows x64')
const binaries = [
  {name:'electron-v44.7.2-win32-x64.zip',sha:'10a89447ef64ac5cb9f782af48ffd83734a40ae91681259d1048ca3c9e6c5da4',url:'https://github.com/electron/electron/releases/download/v44.7.2/electron-v44.7.2-win32-x64.zip'},
  {name:'node-v24.18.0-win-x64.zip',sha:'0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821',url:'https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip'},
]
const run = (bin,args,cwd=root) => new Promise((resolve,reject)=>{
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)&&!/^(DSH_|DEEPSEEK_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)))
  const child=spawn(bin,args,{cwd,env,stdio:'inherit',windowsHide:true})
  child.once('error',reject)
  child.once('exit',code=>code===0?resolve():reject(new Error(`${bin} exited ${code}`)))
})
async function sha(path) {
  const hash=createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
await mkdir(cache,{recursive:true})
for(const item of binaries){
  const path=join(cache,item.name)
  if(!existsSync(path)){
    const response=await fetch(item.url)
    if(!response.ok) throw new Error(`Runtime download failed: ${response.status}`)
    await pipeline(Readable.fromWeb(response.body),createWriteStream(path,{flags:'wx'}))
  }
  if(await sha(path)!==item.sha) throw new Error(`Runtime SHA256 mismatch: ${item.name}`)
}
await mkdir(dirname(out),{recursive:true})
const tar=join(process.env.SystemRoot,'System32/tar.exe')
await mkdir(out)
await run(tar,['-xf',join(cache,binaries[0].name),'-C',out])
await rename(join(out,'electron.exe'),join(out,'Corch DSH.exe'))
const resources=join(out,'resources')
const runtime=join(resources,'runtime')
let closureReceipt
if(values.closure){
  const closure=resolve(values.closure)
  const manifest=JSON.parse(await readFile(join(closure,'package.json'),'utf8'))
  if(manifest.name!=='@polus-ai/corch-dsh-desktop') throw new Error('Unexpected deployed closure')
  closureReceipt=JSON.parse(await readFile(join(closure,'DESKTOP-CLOSURE.json'),'utf8'))
  if(!closureReceipt.frozen_install||closureReceipt.lock_sha256!==await sha(join(root,'pnpm-lock.yaml')))throw new Error('Closure was not built with the current frozen lockfile')
  await copyPortableDesktopRuntime(closure,runtime)
}else{
  const pnpm=process.env.npm_execpath
  if(!pnpm||!/\.[cm]?js$/.test(pnpm)) throw new Error('Run through pnpm run package:win')
  closureReceipt=await buildFrozenDesktopRuntime(root,runtime,run,pnpm)
}
const debugFilesSanitized=await sanitizeDesktopDebugLabels(runtime)
const closurePackages = await verifyDesktopClosure(runtime, root)
console.log(JSON.stringify({closure_packages:closurePackages,frozen_install:true}))
const required=['@deepseek-ai/dsh/lib/bin.js','@deepseek-ai/dsh-web-frontend/dist/index.html','@polus-ai/dsh-client-ui-teaching-reform/lib/client.js','dsh-better-sidebar/lib/client.js']
for(const item of required) if(!existsSync(join(runtime,'node_modules',item))) throw new Error(`Missing built runtime: ${item}`)
await mkdir(join(resources,'node'))
await run(tar,['-xf',join(cache,binaries[1].name),'-C',join(resources,'node'),'--strip-components','1','node-v24.18.0-win-x64/node.exe','node-v24.18.0-win-x64/LICENSE'])
const appDir=join(resources,'app')
await mkdir(appDir)
const manifest=JSON.parse(await readFile(join(root,'apps/desktop/package.json'),'utf8'))
await writeFile(join(appDir,'package.json'),JSON.stringify({name:manifest.name,productName:'Corch DSH',version:manifest.version,type:'module',main:'main.mjs',license:'MIT'},null,2)+'\n')
for(const name of ['main.mjs','policy.mjs','backend.mjs','module-resolution.mjs','publisher.mjs','publisher-vault.mjs','publisher-preload.cjs','jd-browser.mjs','jd-report.mjs']) await copyFile(join(root,'apps/desktop',name),join(appDir,name))
for(const name of ['README.md','README.zh.md']) await copyFile(join(root,'apps/desktop',name),join(out,name))
await copyFile(join(root,'LICENSE'),join(out,'LICENSE-CORCH-DSH'))
await copyFile(join(root,'THIRD_PARTY_NOTICES.md'),join(out,'THIRD_PARTY_NOTICES.md'))
const files=[]
async function inventory(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,entry.name)
    const local=relative(out,path).split(sep).join('/')
    if((await lstat(path)).isSymbolicLink()) throw new Error(`Link in portable payload: ${local}`)
    if(entry.isDirectory()){
      if(entry.name==='.git'||['data','dsh-home'].includes(local)) throw new Error(`Private directory in package: ${local}`)
      await inventory(path)
    }else{
      if(/^\.env$|^\.credentials\.yaml$|^settings\.yaml$/.test(entry.name)) throw new Error(`Private configuration in package: ${local}`)
      if(!desktopDependencyFile(path)) throw new Error(`Development file in portable payload: ${local}`)
      files.push({path:local,sha256:await sha(path)})
    }
  }
}
await inventory(out)
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()
await writeFile(join(out,'BUILD-MANIFEST.json'),JSON.stringify({version:manifest.version,source_commit:commit,source_dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',runtimes:binaries,lock_sha256:await sha(join(root,'pnpm-lock.yaml')),closure_packages:closurePackages,frozen_install:closureReceipt.frozen_install,debug_comment_files_sanitized:debugFilesSanitized,source_maps_included:false,built_client_sha256:await sha(join(runtime,'node_modules/@polus-ai/dsh-client-ui-teaching-reform/lib/client.js')),signed_application:false,private_data_included:false,files},null,2)+'\n')
const archive=out+'.zip'
if(existsSync(archive)) throw new Error(`Archive already exists: ${archive}`)
await run(join(process.env.SystemRoot,'System32/tar.exe'),['-a','-cf',archive,'-C',dirname(out),basenameSafe(out)])
const hash=await sha(archive)
await writeFile(archive+'.sha256',`${hash}  ${basenameSafe(archive)}\n`)
console.log(JSON.stringify({directory:out,archive,sha256:hash,files:files.length,application_signed:false,private_data_included:false}))
function basenameSafe(path){ return path.slice(dirname(path).length+1) }
