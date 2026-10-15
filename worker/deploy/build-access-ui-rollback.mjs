/** Build a schema4-compatible backend with explicitly selected earlier management/SPA assets. */
import {execFileSync} from 'node:child_process'
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {parseArgs} from 'node:util'
const {values}=parseArgs({options:{base:{type:'string'},out:{type:'string'},go:{type:'string'}}})
if(!values.base||!values.out)throw Error('--base and --out are required')
const root=resolve(import.meta.dirname,'../..'),out=resolve(values.out)
if(existsSync(out))throw Error('Rollback output must be new')
const baseline=execFileSync('git',['rev-parse',values.base+'^{commit}'],{cwd:root,encoding:'utf8'}).trim()
mkdirSync(out,{recursive:true})
const scratch=mkdtempSync(join(tmpdir(),'corch-access-ui-overlay-'))
const Replace={}
for(const name of ['management.html','management.js','management.css']){
 const raw=execFileSync('git',['show',baseline+':worker/internal/service/'+name],{cwd:root})
 const target=join(scratch,name);writeFileSync(target,raw);Replace[join(root,'worker/internal/service',name)]=target
}
const overlay=join(scratch,'overlay.json');writeFileSync(overlay,JSON.stringify({Replace}))
const env={...process.env,GOOS:'linux',GOARCH:'amd64',CGO_ENABLED:'0'}
for(const key of Object.keys(env))if(/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key))delete env[key]
execFileSync(values.go??'go',['build','-trimpath','-buildvcs=false','-overlay='+overlay,'-o',join(out,'teaching-worker'),'.'],{cwd:join(root,'worker'),env,stdio:'inherit'})
const worker=execFileSync('git',['show',baseline+':apps/web/public/practice-expert-worker.js'],{cwd:root})
writeFileSync(join(out,'practice-expert-worker.js'),worker)
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex')
const metadata={purpose:'UI-only emergency rollback; retains schema4 access authority and all new data',backend_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),backend_source_dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',ui_baseline_commit:baseline,schema:4,database_restore_required:false,binary_sha256:hash(join(out,'teaching-worker')),worker_script_sha256:hash(join(out,'practice-expert-worker.js')),limitations:['Existing participant links and reports remain available.','New client publication rejects the earlier management protocol; old clients retain legacy publication.','This does not undo backend access changes or repair arbitrary backend defects; those need a schema4-compatible fix.']}
writeFileSync(join(out,'manifest.json'),JSON.stringify(metadata,null,2)+'\n')
console.log(JSON.stringify(metadata))
