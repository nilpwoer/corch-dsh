/** Real packaged UI + real Worker routes/assets; SQL/account storage is an explicit test fixture. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {parseArgs} from 'node:util'
import {backendEnvironment} from './policy.mjs'
const require=createRequire(new URL('../web/package.json',import.meta.url))
const {_electron:electron}=require('playwright')
const {values}=parseArgs({options:{exe:{type:'string'},data:{type:'string'},out:{type:'string'},'worker-fixture':{type:'string'}}})
for(const name of ['exe','data','out','worker-fixture'])assert.ok(values[name],name)
const exe=resolve(values.exe),data=resolve(values.data),out=resolve(values.out),fixturePath=resolve(values['worker-fixture'])
assert.equal(existsSync(data),false,'Fresh isolated data required')
await mkdir(out,{recursive:true})
const fixture=JSON.parse(await readFile(fixturePath,'utf8'))
assert.equal(new URL(fixture.origin).hostname,'127.0.0.1')
const recordKey='dsh.practice-expert-interviews.v2'
let desktop,page,passed=false
const errors=[],uploads=[]
let participantEntries=0
const waitFile=async path=>{for(let n=0;n<150;n++){if(existsSync(path))return readFile(path,'utf8');await new Promise(r=>setTimeout(r,100))}throw Error('Missing file '+path)}
try{
 desktop=await electron.launch({executablePath:exe,args:['--data-dir',data,'--lang=zh-CN'],env:backendEnvironment(process.env,join(data,'unused')),timeout:45000})
 page=await desktop.firstWindow({timeout:60000});page.setDefaultTimeout(25000)
 desktop.context().on('page',p=>p.on('pageerror',e=>errors.push(e.message)))
 page.on('pageerror',e=>errors.push(e.message))
 await desktop.context().route('**/*',route=>['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort())
 desktop.context().on('request',request=>{
  if(request.method()==='POST'&&request.url().startsWith(fixture.origin+'/admin/api/packs/'))uploads.push({url:request.url(),payload:request.postData()})
  if(request.method()==='POST'&&request.url()===fixture.origin+'/portal/api/session')participantEntries++
 })
 await desktop.evaluate(({session},out)=>session.defaultSession.on('will-download',(_event,item)=>item.setSavePath(out+'/'+item.getFilename())),out)
 await page.getByRole('dialog',{name:'内测声明'}).waitFor();await page.getByRole('button',{name:'继续',exact:true}).click()
 const onboarding=page.getByRole('dialog',{name:'添加一个 API Key 开始使用'});await onboarding.waitFor();await onboarding.getByRole('button',{name:'稍后配置',exact:true}).click()
 await page.getByRole('button',{name:'专家访谈',exact:true}).click()
 const sessions=async()=>page.evaluate(async()=>{
  const method='session.list';const response=await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{}})});return (await response.json()).result.value.items
 })
 await page.getByRole('button',{name:'＋ 新建专家访谈',exact:true}).click();await page.getByRole('heading',{name:'新建实践专家访谈',exact:true}).waitFor()
 const first=(await sessions())[0].sessionId
 await page.getByRole('button',{name:'＋ 新建专家访谈',exact:true}).click()
 let second;for(let n=0;n<60;n++){second=(await sessions()).find(s=>s.sessionId!==first)?.sessionId;if(second)break;await new Promise(r=>setTimeout(r,100))}assert.ok(second)
 const makeRow=(id,fieldnote,title,publication)=>({record:{id,fieldnoteId:fieldnote,title,expert:'合成专家',industry:'合成课程',status:'已确认问题包',updated:'合成'},profile:{name:'合成专家',role:'合成教师',industry:'合成课程',years:'10',stage:'合成',experience:'合成课堂核对'},questions:[{id:'q_task',title:'课堂核对',type:'开放回答',question:'请描述课堂核对过程。',sourceRefs:[]},{id:'Q02',title:'判断依据',type:'开放回答',question:'如何判断核对结果？',sourceRefs:[]},{id:'Q03',title:'责任边界',type:'开放回答',question:'如何界定责任边界？',sourceRefs:[]}],questionPackMeta:{packId:'synthetic-ui-pack-'+fieldnote,version:1,generatedAt:'2026-10-15T00:00:00Z',sourceSessionId:id,checksum:'synthetic',globalReferences:[]},invitation:{code:'000000',createdAt:'2026-10-15T00:00:00Z',status:'active'},publication})
 const fresh=makeRow(first,'FN-ui','本地界面验收访谈',{})
 const legacy=makeRow(second,'FN-legacy','旧题包兼容验收',{goal:'保留原有访谈目标',scope:'per_question',count:'2'})
 await page.evaluate(({recordKey,rows})=>{localStorage.setItem(recordKey,JSON.stringify(rows));window.dispatchEvent(new Event('storage'))},{recordKey,rows:[fresh,legacy]})
 await page.getByRole('button',{name:'原生会话',exact:true}).click();await page.getByRole('button',{name:'专家访谈',exact:true}).click()
 const open=async title=>{await page.getByRole('button').filter({hasText:title}).click();await page.getByRole('button',{name:'问题包',exact:true}).click()}
 await open(fresh.record.title)
 for(const name of ['访谈目标','初始追问范围','初始追问次数'])assert.equal(await page.getByLabel(name,{exact:true}).count(),0)
 assert.equal(await page.getByRole('heading',{name:'发布设置',exact:true}).count(),0)
 assert.equal(await page.locator('section[aria-label="题包发布设置"]').count(),0)
 await page.screenshot({path:join(out,'question-package.png')})
 const operations=page.getByLabel('问题包操作',{exact:true})
 await operations.getByRole('button',{name:'下载 JSON 题包',exact:true}).click()
 const exported=JSON.parse(await waitFile(join(out,'FN-ui-v1.json')))
 assert.equal(exported.goal,fresh.record.title);assert.equal(exported.interviewPolicy,undefined)
 await page.getByRole('button',{name:'发布并打开 SPA',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(out,'question-package-operations.png')})
 await page.getByRole('button',{name:'发布并打开 SPA',exact:true}).click()
 const feedback=page.getByLabel('发布反馈',{exact:true})
 await feedback.getByRole('alert').filter({hasText:'填写目标地址'}).waitFor()
 assert.equal(await feedback.evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}),true)
 assert.equal(desktop.windows().length,1)
 await page.screenshot({path:join(out,'missing-address-visible.png')})
 await feedback.getByRole('button',{name:'设置 Worker 地址',exact:true}).click()
 await page.getByPlaceholder('https://worker.example.com').fill(fixture.origin);await page.getByRole('button',{name:'保存地址',exact:true}).click();await page.getByRole('status').filter({hasText:'已保存 Worker'}).waitFor()
 await page.getByRole('button',{name:'返回访谈',exact:true}).click()
 await page.getByRole('button',{name:'发布并打开 SPA',exact:true}).waitFor()
 async function failedPublish(pattern,setup,cleanup){
  const before=uploads.length
  await setup()
  try{
   await page.getByRole('button',{name:'发布并打开 SPA',exact:true}).click()
   await page.getByLabel('发布反馈',{exact:true}).getByRole('alert').filter({hasText:pattern}).waitFor()
   assert.equal(uploads.length,before)
   assert.equal(await page.getByRole('button',{name:'发布并打开 SPA',exact:true}).isEnabled(),true)
  }finally{await cleanup()}
 }
 await failedPublish('阻止了发布窗口',()=>page.evaluate(()=>{window.__originalOpen=window.open;window.open=()=>null}),()=>page.evaluate(()=>{window.open=window.__originalOpen;delete window.__originalOpen}))
 const oldWorker=async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('nonce,autoPublish:true','nonce,autoPublish:false')})}
 await failedPublish('更新 Worker',()=>desktop.context().route('**/admin/management.js',oldWorker),()=>desktop.context().unroute('**/admin/management.js',oldWorker))
 const networkFailure=route=>route.abort('connectionfailed')
 await failedPublish('无法连接 Worker',()=>desktop.context().route('**/admin/api/session',networkFailure),()=>desktop.context().unroute('**/admin/api/session',networkFailure))
 let loginContinuations=0,authenticatedOneClicks=0
 async function publish(key){
  const [manager]=await Promise.all([desktop.waitForEvent('window',{timeout:25000}),page.getByRole('button',{name:'发布并打开 SPA',exact:true}).click()])
  manager.setDefaultTimeout(25000)
  if((await manager.request.get(fixture.origin+'/admin/api/session')).status()!==200){
   await manager.locator('#publish-summary').filter({hasText:key}).waitFor()
   assert.equal(await manager.locator('#publish-confirm').count(),0)
   await page.getByRole('status').filter({hasText:'登录后将自动发布'}).waitFor()
   await manager.screenshot({path:join(out,'worker-login-auto-continue.png')})
   await manager.locator('input[name=password]').fill(fixture.synthetic_password);await manager.getByRole('button',{name:'登录',exact:true}).click();loginContinuations++
  }else authenticatedOneClicks++
  await page.getByRole('heading',{name:'分享链接',exact:true}).waitFor();await manager.locator('#portal-code,#answer').first().waitFor()
  await page.getByRole('status').filter({hasText:'发布成功，已打开 SPA'}).waitFor()
  assert.deepEqual(await page.locator('[class*="shareLayout"]').getByRole('heading',{level:3}).allTextContents(),['专家访谈口令','分享链接'])
  if(await manager.locator('#portal-code').isVisible())assert.equal(await manager.locator('#portal-code').inputValue(),'000000');assert.equal(new URL(manager.url()).hash,'')
  const receipt=await page.evaluate(({recordKey,key})=>JSON.parse(localStorage.getItem(recordKey)).find(row=>row.publication?.worker?.key===key).publication.worker,{recordKey,key})
  assert.equal(receipt.key,key);assert.match(receipt.hash,/^[a-f0-9]{64}$/)
  assert.equal(new URLSearchParams(new URL(receipt.url).hash.slice(1)).get('code'),'000000')
  await page.bringToFront();await desktop.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith(origin))?.focus(),new URL(page.url()).origin)
  await page.waitForFunction(()=>document.hasFocus());await page.getByRole('button',{name:'复制链接',exact:true}).click();await page.getByRole('status').filter({hasText:'链接已复制'}).waitFor()
  let copied=false;for(let n=0;n<30;n++){copied=await desktop.evaluate(async({clipboard},url)=>(await clipboard.readText())===url,receipt.url);if(copied)break;await new Promise(r=>setTimeout(r,100))}assert.equal(copied,true,'Copied link must match the receipt including its code')
  return {manager,receipt}
 }
 let {manager,receipt}=await publish('FN-ui-v1')
 assert.equal(participantEntries,0)
 const firstPayload=uploads.at(-1).payload;assert.equal(JSON.parse(firstPayload).interviewPolicy,undefined)
 const originalPack=await readFile(join(fixture.packs_directory,'FN-ui-v1.json'),'utf8')
 await page.screenshot({path:join(out,'spa-share.png')})
 await manager.goto(fixture.origin+'/admin/');await manager.locator('[data-settings="FN-ui-v1"]').click();await manager.locator('#runtime-settings').waitFor({state:'visible'})
 await manager.locator('#policy-inherit').uncheck();await manager.locator('#policy-scope').selectOption('interview');await manager.locator('#policy-count').fill('0')
 for(const kind of ['followup','report']){await manager.locator('#'+kind+'-inherit').uncheck();await manager.locator('#'+kind+'-analyze').fill('合成分析提示词 '+kind);await manager.locator('#'+kind+'-compose').fill('合成生成提示词 '+kind)}
 await manager.locator('#settings-save').click();await manager.locator('#settings-message').filter({hasText:'已保存'}).waitFor();await manager.screenshot({path:join(out,'worker-settings.png')})
 const readSettings=()=>manager.evaluate(async()=>{const r=await fetch('/admin/api/packs/FN-ui-v1/settings');if(r.status!==200)throw Error('settings read');return r.json()})
 const before=await readSettings();assert.equal(before.policy.scope,'interview');assert.equal(before.policy.maxFollowups,0)
 assert.equal(before.settings.followup.analyze,'合成分析提示词 followup');assert.equal(before.settings.report.compose,'合成生成提示词 report')
 await manager.goto(receipt.url);await manager.locator('#portal-code').waitFor();assert.equal(await manager.locator('#portal-code').inputValue(),'000000');assert.equal(participantEntries,0)
 await manager.locator('#portal-start button').click();await manager.locator('#answer').waitFor();assert.equal(participantEntries,1);await manager.close()
 await page.getByRole('button',{name:'问题包',exact:true}).click()
 await desktop.context().route('**/admin/api/packs/FN-ui-v1',networkFailure)
 try{
  await page.getByRole('button',{name:'发布并打开 SPA',exact:true}).click()
  await page.getByLabel('发布反馈',{exact:true}).getByRole('alert').filter({hasText:'无法连接 Worker'}).waitFor()
  assert.equal(await readFile(join(fixture.packs_directory,'FN-ui-v1.json'),'utf8'),originalPack)
  await page.screenshot({path:join(out,'upload-network-failure-visible.png')})
 }finally{await desktop.context().unroute('**/admin/api/packs/FN-ui-v1',networkFailure)}
 await page.getByRole('button',{name:'问题包',exact:true}).click();({manager}=await publish('FN-ui-v1'))
 assert.equal(uploads.at(-1).payload,firstPayload);assert.equal(await readFile(join(fixture.packs_directory,'FN-ui-v1.json'),'utf8'),originalPack)
 await manager.goto(fixture.origin+'/admin/');assert.deepEqual(await readSettings(),before);await manager.close()
 await page.getByRole('button',{name:'问题包',exact:true}).click();await page.getByRole('button',{name:'创建新发布版本',exact:true}).click();({manager}=await publish('FN-ui-v2'));assert.equal(JSON.parse(uploads.at(-1).payload).interviewPolicy,undefined);await manager.close()
 await open(legacy.record.title);({manager}=await publish('FN-legacy-v1'))
 const legacyPayload=JSON.parse(uploads.at(-1).payload)
 const expectedLegacy={schemaVersion:1,fieldnoteId:'FN-legacy',publicFieldnoteId:'FN-legacy',goal:legacy.publication.goal,profile:legacy.profile,questions:legacy.questions,questionPackMeta:legacy.questionPackMeta,invitation:legacy.invitation,interviewPolicy:{scope:'per_question',maxFollowups:2},publishedAt:legacy.questionPackMeta.generatedAt}
 assert.deepEqual(legacyPayload,expectedLegacy);await manager.close()
 await page.getByRole('button',{name:'问题包',exact:true}).click();await page.getByRole('button',{name:'创建新发布版本',exact:true}).click();({manager}=await publish('FN-legacy-v2'));assert.equal(JSON.parse(uploads.at(-1).payload).interviewPolicy,undefined);await manager.close()
 const saved=await page.evaluate(recordKey=>JSON.parse(localStorage.getItem(recordKey)),recordKey)
 const savedLegacy=saved.find(row=>row.record.fieldnoteId==='FN-legacy')
 assert.equal(savedLegacy.publication.goal,legacy.publication.goal);assert.equal(savedLegacy.publication.count,'2');assert.equal(savedLegacy.publication.legacyVersion,1)
 assert.deepEqual(errors,[])
 const runtime=JSON.parse(await readFile(join(data,'runtime.json'),'utf8'))
 const result={passed:true,actual_packaged_exe:true,desktop_version:runtime.desktop_version,actual_host_sessions:2,publication_form_absent:true,single_click_publish:true,worker_confirmation_required:false,login_continuations:loginContinuations,authenticated_one_clicks:authenticatedOneClicks,missing_address_visible:true,address_setting_shortcut:true,blocked_popup_feedback:true,old_worker_rejected_before_upload:true,network_failure_feedback:true,initial_followup_fields_absent:true,question_package_operations:true,json_download:true,new_package_policy:'Worker configured',worker_http_and_assets:'real',worker_sql_and_accounts:'synthetic fixture',worker_policy_and_prompt_editor:true,same_version_retry_preserves_bytes_and_worker_settings:true,legacy_v1_payload_unchanged:true,new_versions_omit_legacy_policy:true,legacy_local_data_preserved:true,spa_sections:['专家访谈口令','分享链接'],copied_link_includes_code:true,worker_code_prefilled:true,automatic_participant_entries:0,explicit_participant_entries:participantEntries,publish_uploads:uploads.length,real_model_calls:0,page_errors:errors,production_changed:false}
 await writeFile(join(out,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));passed=true
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});await writeFile(join(out,'failure.txt'),await page.locator('body').innerText()).catch(()=>{})}throw error}
finally{if(desktop)await desktop.close();await writeFile(fixturePath+'.done',JSON.stringify({passed})+'\n')}
