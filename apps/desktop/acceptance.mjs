/** Actual packaged desktop acceptance; only synthetic profiles, model discovery and isolated Worker data. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {parseArgs} from 'node:util'
import {backendEnvironment} from './policy.mjs'
const require=createRequire(new URL('../web/package.json',import.meta.url))
const {_electron:electron}=require('playwright')
const {values}=parseArgs({options:{exe:{type:'string'},data:{type:'string'},out:{type:'string'},'worker-fixture':{type:'string'}}})
assert.ok(values.exe&&values.data&&values.out,'Supply --exe, --data and --out absolute paths')
const exe=resolve(values.exe),data=resolve(values.data),out=resolve(values.out)
assert.ok(!existsSync(data),'Acceptance requires a new isolated data directory')
await mkdir(out,{recursive:true})
const fakeKey='synthetic-desktop-fixture-not-a-real-key'
let discovery=0,authenticatedDiscovery=0,generation=0
const provider=createServer((request,response)=>{
  if(request.method==='GET'&&new URL(request.url,'http://fixture').pathname==='/v1/models'){
    discovery++
    if(request.headers.authorization===`Bearer ${fakeKey}`)authenticatedDiscovery++
    response.writeHead(200,{'content-type':'application/json'})
    response.end(JSON.stringify({object:'list',data:[{id:'desktop-fixture-model',object:'model',created:0,owned_by:'synthetic-fixture'}]}))
  }else{generation++;response.writeHead(503);response.end('Synthetic discovery fixture has no model generation')}
})
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve))
const providerOrigin=`http://127.0.0.1:${provider.address().port}`
const fixture=values['worker-fixture']?JSON.parse(await readFile(values['worker-fixture'],'utf8')):undefined
if(fixture){const u=new URL(fixture.origin);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.protocol,'http:')}
let desktop,page,firstOrigin,firstPid,portalEntries=0
const pageErrors=[],pluginResponses=[]
async function rpc(method){
  return page.evaluate(async method=>{
    const rpcId=crypto.randomUUID()
    const result=await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method,payload:{}})})
    if(result.status!==200)throw new Error('RPC HTTP '+result.status)
    const body=await result.json()
    if(!body.result.ok)throw new Error('RPC rejected '+method)
    return body.result.value
  },method)
}
async function launch(){
  desktop=await electron.launch({executablePath:exe,args:['--data-dir',data,'--lang=zh-CN'],env:backendEnvironment(process.env,join(data,'unused')),timeout:45000})
  page=await desktop.firstWindow({timeout:60000})
  page.setDefaultTimeout(20000)
  desktop.context().on('page',child=>child.on('pageerror',error=>pageErrors.push(error.message)))
  page.on('pageerror',error=>pageErrors.push(error.message))
  page.on('response',response=>{if(new URL(response.url()).pathname==='/plugins/@polus-ai/dsh-client-ui-teaching-reform/client.js')pluginResponses.push(response.status())})
  desktop.context().on('request',request=>{if(fixture&&request.method()==='POST'&&request.url()===fixture.origin+'/portal/api/session')portalEntries++})
  await desktop.context().route('**/*',route=>{
    const url=new URL(route.request().url())
    return ['127.0.0.1','localhost','[::1]'].includes(url.hostname)?route.continue():route.abort()
  })
}
async function assertStopped(origin,pid){
  for(let i=0;i<50;i++){
    let alive=true
    try{process.kill(pid,0)}catch(error){if(error.code==='ESRCH')alive=false;else throw error}
    if(!alive){await assert.rejects(fetch(origin,{signal:AbortSignal.timeout(500)}));return}
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  assert.fail('Owned backend survived desktop close')
}
try{
  await launch()
  await page.getByRole('dialog',{name:'欢迎使用 Corch DSH'}).waitFor()
  await page.getByRole('button',{name:'继续',exact:true}).click()
  const onboarding=page.getByRole('dialog',{name:'添加一个 API Key 开始使用'})
  await onboarding.waitFor()
  await onboarding.getByRole('button',{name:'稍后配置',exact:true}).click()
  await page.getByRole('button',{name:'专家访谈',exact:true}).click()
  await page.getByRole('button',{name:'＋ 新建专家访谈',exact:true}).click()
  await page.getByRole('heading',{name:'新建实践专家访谈',exact:true}).waitFor()
  const sessions=await rpc('session.list')
  assert.equal(sessions.items.length,1)
  const sessionId=sessions.items[0].sessionId
  const plugin=await page.request.get(new URL('/plugins/@polus-ai/dsh-client-ui-teaching-reform/client.js',page.url()).href)
  assert.equal(plugin.status(),200)
  await page.screenshot({path:join(out,'expert-workbench.png')})
  await writeFile(join(out,'expert-workbench.aria.txt'),await page.locator('body').ariaSnapshot())
  await page.getByRole('button',{name:'设置',exact:true}).first().click()
  const settings=page.getByRole('dialog',{name:'设置',exact:true})
  await settings.getByRole('button',{name:'模型',exact:true}).click()
  await settings.getByRole('button',{name:'添加自定义提供方',exact:true}).click()
  await settings.getByLabel('Provider ID',{exact:true}).fill('desktop-fixture')
  await settings.getByLabel('显示名称',{exact:true}).fill('Desktop synthetic fixture')
  await settings.getByLabel('API 地址',{exact:true}).last().fill(providerOrigin+'/v1')
  await settings.getByLabel('API 协议',{exact:true}).selectOption('openai-completions')
  await settings.getByLabel('API 密钥',{exact:true}).last().fill(fakeKey)
  await settings.getByRole('button',{name:'获取可用模型',exact:true}).last().click()
  const picker=page.getByRole('dialog',{name:'选择要添加的模型',exact:true})
  await picker.waitFor()
  await picker.getByRole('checkbox').check()
  await picker.getByRole('button',{name:'添加所选',exact:true}).click()
  await settings.getByRole('button',{name:'创建提供方',exact:true}).click()
  await settings.getByRole('button',{name:'编辑 Desktop synthetic fixture (desktop-fixture)',exact:true}).waitFor()
  const saved=await readFile(join(data,'dsh/settings.yaml'),'utf8')
  const credential=await readFile(join(data,'dsh/.credentials.yaml'),'utf8')
  assert.ok(saved.includes('DESKTOP_FIXTURE_API_KEY'))
  assert.ok(!saved.includes(fakeKey))
  assert.ok(credential.includes('DESKTOP_FIXTURE_API_KEY: '+fakeKey))
  assert.equal(discovery,1);assert.equal(authenticatedDiscovery,1);assert.equal(generation,0)
  assert.ok(!(await page.content()).includes(fakeKey))
  await page.screenshot({path:join(out,'models-configured.png')})
  await settings.getByRole('button',{name:'关闭',exact:true}).click()
  let workerPassed=false
  if(fixture){
    const row={record:{id:sessionId,fieldnoteId:'FN-desktop-fixture',title:'合成桌面验收访谈',expert:'合成专家',industry:'合成课程',status:'待确认问题包',updated:'合成'},profile:{name:'合成专家',role:'合成教师',industry:'合成课程',years:'10',stage:'合成',experience:'合成课堂核对'},questions:[{id:'q_task',title:'课堂核对',type:'开放回答',question:'请描述课堂核对过程。',sourceRefs:[]},{id:'Q02',title:'判断依据',type:'开放回答',question:'如何判断核对结果？',sourceRefs:[]},{id:'Q03',title:'经验边界',type:'开放回答',question:'如何界定经验边界？',sourceRefs:[]}],questionPackMeta:{packId:'synthetic-desktop-pack',version:1,generatedAt:'2026-10-14T00:00:00Z',sourceSessionId:sessionId,checksum:'synthetic',globalReferences:[]},invitation:{code:'000000',createdAt:'2026-10-14T00:00:00Z',status:'active'},publication:{goal:'核实合成课堂中的任务证据',scope:'per_question',count:'2'}}
    await page.evaluate(row=>{localStorage.setItem('dsh.practice-expert-interviews.v2',JSON.stringify([row]));window.dispatchEvent(new Event('storage'))},row)
    await page.getByRole('button',{name:'原生会话',exact:true}).click()
    await page.getByRole('button',{name:'专家访谈',exact:true}).click()
    await page.getByRole('button').filter({hasText:'合成桌面验收访谈'}).click()
    await page.getByRole('button',{name:'访谈设置',exact:true}).click()
    await page.getByRole('button',{name:'Worker 发布',exact:true}).click()
    await page.getByPlaceholder('https://worker.example.com').fill(fixture.origin)
    await page.getByRole('button',{name:'保存地址',exact:true}).click()
    await page.getByRole('status').filter({hasText:'已保存 Worker'}).waitFor()
    await page.getByRole('button',{name:'返回访谈',exact:true}).click()
    await page.getByRole('button',{name:'问题包',exact:true}).click()
    const confirm=page.getByRole('button',{name:'确认问题并生成 SPA',exact:true})
    if(await confirm.count())await confirm.click()
    const [manager]=await Promise.all([
      desktop.waitForEvent('window',{timeout:25000}),
      page.getByRole('button',{name:'发布并打开 SPA',exact:true}).click(),
    ])
    await manager.locator('#publish-summary').filter({hasText:'FN-desktop-fixture-v1'}).waitFor()
    assert.equal(await manager.evaluate(()=>!!window.opener),true)
    await manager.locator('input[name=password]').fill(fixture.synthetic_password)
    await manager.getByRole('button',{name:'登录',exact:true}).click()
    // Successful login resumes the existing DSH transfer without another click.
    await page.getByRole('heading',{name:'分享链接',exact:true}).waitFor()
    await manager.locator('#portal-code').waitFor()
    const published=await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh.practice-expert-interviews.v2'))[0])
    const receipt=published.publication.worker
    assert.equal(receipt.key,'FN-desktop-fixture-v1')
    assert.match(receipt.hash,/^[a-f0-9]{64}$/)
    assert.equal(new URL(receipt.url).origin,fixture.origin)
    assert.equal(await manager.locator('#portal-code').inputValue(),'000000')
    assert.equal(new URL(manager.url()).hash,'')
    assert.equal(portalEntries,0)
    await page.screenshot({path:join(out,'published-share.png')})
    await manager.screenshot({path:join(out,'worker-prefilled.png')})
    await manager.locator('#portal-start button').click()
    await manager.locator('#answer').waitFor()
    assert.equal(portalEntries,1)
    assert.ok(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes(fixture.synthetic_password))
    workerPassed=true
    await manager.close()
  }
  assert.deepEqual(await page.evaluate(()=>({node:typeof process,require:typeof require})),{node:'undefined',require:'undefined'})
  const preferences=await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences())
  assert.equal(preferences.nodeIntegration,false);assert.equal(preferences.contextIsolation,true);assert.equal(preferences.sandbox,true);assert.equal(preferences.webSecurity,true)
  const runtime=JSON.parse(await readFile(join(data,'runtime.json'),'utf8'))
  firstOrigin=runtime.local_origin;firstPid=runtime.backend_pid
  await desktop.close();desktop=undefined
  await assertStopped(firstOrigin,firstPid)
  await launch()
  await page.getByRole('button',{name:'专家访谈',exact:true}).waitFor()
  const restarted=JSON.parse(await readFile(join(data,'runtime.json'),'utf8'))
  assert.equal(restarted.local_origin,firstOrigin)
  assert.equal((await rpc('session.list')).items.length,1)
  assert.equal(await page.getByRole('dialog',{name:'欢迎使用 Corch DSH'}).count(),0)
  assert.equal(await page.getByRole('dialog',{name:/API Key/}).count(),0)
  assert.equal(generation,0);assert.deepEqual(pageErrors,[])
  await desktop.close();desktop=undefined
  await assertStopped(restarted.local_origin,restarted.backend_pid)
  const result={passed:true,actual_packaged_exe:true,first_run_completed_without_key:true,expert_workbench:true,actual_host_sessions:1,plugin_http:200,synthetic_model_discovery_requests:discovery,synthetic_authorization_verified:authenticatedDiscovery===1,credentials_stored_separately:true,model_generation_requests:generation,real_model_calls:0,isolated_worker_publication:workerPassed,worker_opener_and_receipt:workerPassed,automatic_participant_entries:0,explicit_synthetic_participant_entries:portalEntries,persistent_origin_and_session:true,renderer_sandbox:true,backend_stopped_twice:true,page_errors:pageErrors,production_changed:false,existing_3082_changed:false,microphone_real_models_native_ime:'not tested'}
  if(fixture)assert.deepEqual(result,JSON.parse(await readFile(new URL('./snapshots/acceptance.expected.json',import.meta.url),'utf8')))
  await writeFile(join(out,'verification.json'),JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result))
}catch(error){
  if(page&&!page.isClosed()){await page.screenshot({path:join(out,'failure.png')}).catch(()=>undefined);await writeFile(join(out,'failure-body.txt'),await page.locator('body').innerText()).catch(()=>undefined)}
  throw error
}finally{if(desktop)await desktop.close();await new Promise(resolve=>provider.close(resolve))}
