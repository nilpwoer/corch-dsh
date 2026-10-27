/** Package the built CLI/Web dependency closure with pinned official macOS ARM64 runtimes. */
import {spawn,execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream,createWriteStream,existsSync} from 'node:fs'
import {mkdir,readFile,writeFile,readdir,lstat,copyFile,rename,mkdtemp,rm,realpath} from 'node:fs/promises'
import {dirname,join,resolve,relative,sep,isAbsolute,basename} from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {parseArgs} from 'node:util'
import {copyPortableDesktopRuntime,desktopDependencyFile,sanitizeDesktopDebugLabels,verifyDesktopClosure} from './desktop-closure.mjs'
import {buildFrozenDesktopRuntime} from './desktop-frozen-build.mjs'

const root=resolve(import.meta.dirname,'..')
const {values}=parseArgs({options:{out:{type:'string'},cache:{type:'string'},closure:{type:'string'},'sign-identity':{type:'string'},'notary-profile':{type:'string'}}})
const out=resolve(values.out??join(root,'dist/macos/Corch DSH.app'))
const cache=resolve(values.cache??join(root,'.tmp/desktop-downloads'))
const signingIdentity=values['sign-identity']
const notaryProfile=values['notary-profile']
const archive=out+'.zip'
const notarizationArchive=out+'.notary.zip'
if(existsSync(out))throw new Error(`Output already exists: ${out}; choose a new directory`)
if(existsSync(archive)||existsSync(archive+'.sha256')||existsSync(notarizationArchive))throw new Error(`Archive output already exists for ${out}; choose a new directory`)
if(out===root||root.startsWith(out+sep))throw new Error('Output cannot contain the repository')
if(process.platform!=='darwin')throw new Error('Package macOS ARM64 on macOS')
const releaseSigning=Boolean(signingIdentity||notaryProfile)
if(releaseSigning&&(!signingIdentity||!notaryProfile))throw new Error('--sign-identity and --notary-profile must be supplied together')
if(releaseSigning&&!signingIdentity.startsWith('Developer ID Application:'))throw new Error('--sign-identity must name a Developer ID Application certificate')
if(releaseSigning&&!execFileSync('/usr/bin/security',['find-identity','-v','-p','codesigning'],{encoding:'utf8'}).includes(`"${signingIdentity}"`))throw new Error(`No valid signing identity named ${JSON.stringify(signingIdentity)} is available`)
const applicationSignature=releaseSigning?'developer-id':'adhoc'
const applicationNotarized=releaseSigning
const target={os:'darwin',cpu:'arm64'}
const binaries=[
  {name:'electron-v44.7.2-darwin-arm64.zip',sha:'07d73d3d6dd0b8679c2f1849e30df179ea50c1d6b17630fcc398ae05221f0bd2',url:'https://github.com/electron/electron/releases/download/v44.7.2/electron-v44.7.2-darwin-arm64.zip'},
  {name:'node-v24.18.0-darwin-arm64.tar.gz',sha:'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1',url:'https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz'},
]
const run=(bin,args,cwd=root,extraEnv)=>new Promise((resolve,reject)=>{
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)&&!/^(DSH_|DEEPSEEK_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)))
  const child=spawn(bin,args,{cwd,env:{...env,...extraEnv,LC_ALL:'en_US.UTF-8',LANG:'en_US.UTF-8'},stdio:'inherit'})
  child.once('error',reject)
  child.once('exit',code=>code===0?resolve():reject(new Error(`${bin} exited ${code}`)))
})
async function sha(path){
  const hash=createHash('sha256')
  for await(const chunk of createReadStream(path))hash.update(chunk)
  return hash.digest('hex')
}
try{
await mkdir(cache,{recursive:true})
for(const item of binaries){
  const path=join(cache,item.name)
  if(!existsSync(path)){
    const response=await fetch(item.url)
    if(!response.ok)throw new Error(`Runtime download failed: ${response.status}`)
    await pipeline(Readable.fromWeb(response.body),createWriteStream(path,{flags:'wx'}))
  }
  if(await sha(path)!==item.sha)throw new Error(`Runtime SHA256 mismatch: ${item.name}`)
}
await mkdir(dirname(out),{recursive:true})
const extracted=await mkdtemp(join(dirname(out),'.electron-'))
try{
  await run('/usr/bin/ditto',['-x','-k',join(cache,binaries[0].name),extracted])
  await rename(join(extracted,'Electron.app'),out)
}finally{
  await rm(extracted,{recursive:true,force:true})
}
const contents=join(out,'Contents')
const resources=join(contents,'Resources')
await rename(join(contents,'MacOS','Electron'),join(contents,'MacOS','Corch DSH'))
const info=join(contents,'Info.plist')
for(const [key,value] of [['CFBundleDisplayName','Corch DSH'],['CFBundleExecutable','Corch DSH'],['CFBundleIdentifier','ai.polus.corch-dsh'],['CFBundleName','Corch DSH']])await run('/usr/bin/plutil',['-replace',key,'-string',value,info])
const runtime=join(resources,'runtime')
let closureReceipt
if(values.closure){
  const closure=resolve(values.closure)
  const manifest=JSON.parse(await readFile(join(closure,'package.json'),'utf8'))
  if(manifest.name!=='@polus-ai/corch-dsh-desktop')throw new Error('Unexpected deployed closure')
  closureReceipt=JSON.parse(await readFile(join(closure,'DESKTOP-CLOSURE.json'),'utf8'))
  if(!closureReceipt.frozen_install||closureReceipt.lock_sha256!==await sha(join(root,'pnpm-lock.yaml')))throw new Error('Closure was not built with the current frozen lockfile')
  await copyPortableDesktopRuntime(closure,runtime)
}else{
  const pnpm=process.env.npm_execpath
  if(!pnpm||!/\.[cm]?js$/.test(pnpm))throw new Error('Run through pnpm run package:mac')
  closureReceipt=await buildFrozenDesktopRuntime(root,runtime,run,pnpm,target)
}
const debugFilesSanitized=await sanitizeDesktopDebugLabels(runtime)
const closurePackages=await verifyDesktopClosure(runtime,root)
console.log(JSON.stringify({closure_packages:closurePackages,frozen_install:true,target}))
const required=['@deepseek-ai/dsh/lib/bin.js','@deepseek-ai/dsh-web-frontend/dist/index.html','@polus-ai/dsh-client-ui-teaching-reform/lib/client.js','dsh-better-sidebar/lib/client.js']
for(const item of required)if(!existsSync(join(runtime,'node_modules',item)))throw new Error(`Missing built runtime: ${item}`)
await mkdir(join(resources,'node'))
await run('/usr/bin/tar',['-xzf',join(cache,binaries[1].name),'-C',join(resources,'node'),'--strip-components','1','node-v24.18.0-darwin-arm64/bin/node','node-v24.18.0-darwin-arm64/LICENSE'])
const appDir=join(resources,'app')
await mkdir(appDir)
const manifest=JSON.parse(await readFile(join(root,'apps/desktop/package.json'),'utf8'))
await writeFile(join(appDir,'package.json'),JSON.stringify({name:manifest.name,productName:'Corch DSH',version:manifest.version,type:'module',main:'main.mjs',license:'MIT'},null,2)+'\n')
for(const name of ['main.mjs','policy.mjs','backend.mjs','module-resolution.mjs','publisher.mjs','publisher-vault.mjs','publisher-preload.cjs'])await copyFile(join(root,'apps/desktop',name),join(appDir,name))
for(const name of ['README.md','README.zh.md'])await copyFile(join(root,'apps/desktop',name),join(resources,name))
await copyFile(join(root,'LICENSE'),join(resources,'LICENSE-CORCH-DSH'))
await copyFile(join(root,'THIRD_PARTY_NOTICES.md'),join(resources,'THIRD_PARTY_NOTICES.md'))
const files=[]
async function inventory(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,entry.name)
    const local=relative(out,path).split(sep).join('/')
    const stat=await lstat(path)
    if(stat.isSymbolicLink()){
      if(!local.startsWith('Contents/Frameworks/'))throw new Error(`Link in portable payload: ${local}`)
      const actual=await realpath(path),owned=relative(out,actual)
      if(owned.startsWith('..')||isAbsolute(owned))throw new Error(`Framework link escaped package: ${local}`)
      continue
    }
    if(stat.isDirectory()){
      if(entry.name==='.git'||['data','dsh-home'].includes(local))throw new Error(`Private directory in package: ${local}`)
      await inventory(path)
    }else{
      if(/^\.env$|^\.credentials\.yaml$|^settings\.yaml$/.test(entry.name))throw new Error(`Private configuration in package: ${local}`)
      if(!desktopDependencyFile(path))throw new Error(`Development file in portable payload: ${local}`)
      files.push({path:local,sha256:await sha(path)})
    }
  }
}
await inventory(out)
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()
await writeFile(join(resources,'BUILD-MANIFEST.json'),JSON.stringify({version:manifest.version,target:'macos-arm64',source_commit:commit,source_dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',runtimes:binaries,lock_sha256:await sha(join(root,'pnpm-lock.yaml')),closure_packages:closurePackages,frozen_install:closureReceipt.frozen_install,debug_comment_files_sanitized:debugFilesSanitized,source_maps_included:false,built_client_sha256:await sha(join(runtime,'node_modules/@polus-ai/dsh-client-ui-teaching-reform/lib/client.js')),application_signature:applicationSignature,application_notarized:applicationNotarized,private_data_included:false,files},null,2)+'\n')
if(releaseSigning)await run('/usr/bin/codesign',['--force','--deep','--options','runtime','--timestamp','--sign',signingIdentity,out])
else await run('/usr/bin/codesign',['--force','--deep','--sign','-',out])
await run('/usr/bin/codesign',['--verify','--deep','--strict',out])
if(releaseSigning)try{
  await run('/usr/bin/ditto',['-c','-k','--keepParent',out,notarizationArchive])
  await run('/usr/bin/xcrun',['notarytool','submit',notarizationArchive,'--keychain-profile',notaryProfile,'--wait'])
  await run('/usr/bin/xcrun',['stapler','staple',out])
  await run('/usr/sbin/spctl',['--assess','--type','execute','--verbose=4',out])
}finally{await rm(notarizationArchive,{force:true})}
await run('/usr/bin/ditto',['-c','-k','--keepParent',out,archive])
const hash=await sha(archive)
await writeFile(archive+'.sha256',`${hash}  ${basename(archive)}\n`)
console.log(JSON.stringify({directory:out,archive,sha256:hash,files:files.length,application_signature:applicationSignature,application_notarized:applicationNotarized,private_data_included:false}))
}catch(error){
  await Promise.all([rm(out,{recursive:true,force:true}),rm(archive,{force:true}),rm(archive+'.sha256',{force:true}),rm(notarizationArchive,{force:true})])
  throw error
}
