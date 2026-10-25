/** Real packaged EXE and Edge against task-local SQL/Workers and synthetic models. Files are retained. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {parseArgs} from 'node:util'
import {backendEnvironment} from './policy.mjs'
const require=createRequire(new URL('../web/package.json',import.meta.url))
const {_electron:electron,chromium}=require('playwright')
const {values}=parseArgs({options:{exe:{type:'string'},data:{type:'string'},out:{type:'string'},fixture:{type:'string'}}})
for(const name of ['exe','data','out','fixture'])assert.ok(values[name],name)
const exe=resolve(values.exe),data=resolve(values.data),out=resolve(values.out)
assert.equal(existsSync(data),false,'Fresh task-owned desktop profile required')
await mkdir(out,{recursive:true})
const fixture=JSON.parse(await readFile(resolve(values.fixture),'utf8'))
for(const name of ['origin','baseline_origin','control_origin'])assert.equal(new URL(fixture[name]).hostname,'127.0.0.1')
const checks=[],screens=[],errors=[],settingsProof=[]
let desktop,page,edge,manager,participant,passed=false,generation=0
const captured=[],promptProof=[]
const check=name=>{checks.push(name);console.log('PASS '+name)}
const safe=value=>String(value).replace(/dsh_pub_[a-f0-9]{64}/g,'[KEY MASKED]').replace(/#code=[^\s"<>]+/g,'#code=[MASKED]').replaceAll(fixture.synthetic_password,'[PASSWORD MASKED]')
async function shot(p,name){await writeFile(join(out,name+'.aria.txt'),safe(await p.locator('body').ariaSnapshot()));await p.screenshot({path:join(out,name+'.png'),fullPage:true,mask:[p.locator('input,code,pre,[class*="shareCode"]')],maskColor:'#CBD5E1'});screens.push(name+'.png')}
async function control(body){const r=await fetch(fixture.control_origin+'/__control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json()}
async function modelCalls(){return(await(await fetch(fixture.control_origin+'/__state')).json()).model_calls}
async function context(p){return p.evaluate(async()=>await(await fetch('/portal/api/session'+location.search)).json())}
async function mark(p,branch){await control({action:'mark',branch,interviewID:(await context(p)).interview_id})}
async function login(p,origin,key){await p.goto(origin+'/admin/?configure='+key);if(await p.locator('#login').isVisible()){await p.getByLabel('密码',{exact:true}).fill(fixture.synthetic_password);await p.getByRole('button',{name:'登录',exact:true}).click()}await p.locator('#policy-count').waitFor({state:'visible'})}
async function settings(p,origin,key){await p.goto(origin+'/admin/?configure='+key);await p.locator('#policy-count').waitFor({state:'visible'})}
async function save(p,n,scope='per_question'){await p.locator('#policy-inherit').uncheck();await p.locator('#policy-scope').selectOption(scope);await p.locator('#policy-count').fill(String(n));await p.getByRole('button',{name:'保存配置',exact:true}).click();await p.locator('#settings-message').filter({hasText:'已保存'}).waitFor()}
async function settingsValue(p,key,n,scope){assert.equal(await p.locator('#policy-count').inputValue(),String(n));const v=await p.evaluate(async key=>await(await fetch('/admin/api/packs/'+key+'/settings',{cache:'no-store'})).json(),key);assert.equal(v.policy.maxFollowups,n);assert.equal(v.policy.scope,scope);return{policy:v.policy,revision:v.revision}}
async function persistence(origin,branch,key,n,scope,ctx){
  await save(manager,n,scope);const first=await settingsValue(manager,key,n,scope)
  await manager.reload();await manager.locator('#policy-count').waitFor({state:'visible'});assert.deepEqual(await settingsValue(manager,key,n,scope),first)
  await manager.close();manager=await ctx.newPage();await login(manager,origin,key);assert.deepEqual(await settingsValue(manager,key,n,scope),first)
  await control({action:'restart',branch});await manager.reload();await manager.locator('#policy-count').waitFor({state:'visible'});assert.deepEqual(await settingsValue(manager,key,n,scope),first)
  settingsProof.push({branch,key,...first,hard_reload:true,reopen:true,worker_restart:true});await shot(manager,branch+'-saved-settings');check(branch+' save GET/hard reload/reopen/restart persists '+scope+'='+n)
}
const sourceRefs=[{sourceType:'model_inference',title:'合成验收题',rationale:'本机模型替身生成，无真实专家资料',confidence:'low',requiresConfirmation:true}]
const questions=[
  {title:'授权确认',type:'授权确认',question:'是否同意本次合成验收？',options:['同意','不同意']},
  {title:'纯选择题',type:'单项选择',question:'请选择合成类别。',options:['甲','乙']},
  {title:'条件其他',type:'多项选择',question:'请选择场景，其他可填写说明。',options:['甲','其他（请说明）']},
  {title:'开放文本',type:'开放回忆',question:'请描述合成方案核对过程。'},
  {title:'失败恢复',type:'开放回忆',question:'请描述另一个合成案例。'},
].map(q=>({...q,sourceRefs}))
const provider=createServer(async(req,res)=>{
  if(req.url.endsWith('/models')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'policy-fixture-model',object:'model',created:0,owned_by:'synthetic'}]}));return}
  let raw='';for await(const chunk of req)raw+=chunk
  const input=JSON.parse(raw||'{}');generation++;captured.push(input.messages)
  const content='```json\n'+JSON.stringify({questions})+'\n```'
  if(input.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');res.end()}
  else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'synthetic',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]}))}
})
await new Promise(r=>provider.listen(0,'127.0.0.1',r))
try{
  edge=await chromium.launch({channel:'msedge',headless:false})
  const ctx=await edge.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',timezoneId:'UTC'})
  ctx.on('page',p=>p.on('pageerror',e=>errors.push(e.message)))
  await ctx.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort())
  manager=await ctx.newPage();await login(manager,fixture.baseline_origin,fixture.baseline_key)
  await manager.locator('#policy-inherit').check();await manager.getByRole('button',{name:'保存配置',exact:true}).click();await manager.locator('#settings-message').filter({hasText:'已保存'}).waitFor()
  const old=await ctx.newPage();await old.goto(fixture.baseline_origin+'/?fieldnoteId='+fixture.baseline_key+'#code=000000');await old.locator('#answer').waitFor();await mark(old,'baseline')
  await persistence(fixture.baseline_origin,'baseline',fixture.baseline_key,0,'per_question',ctx)
  await old.reload();await old.locator('#answer').waitFor();assert.equal((await context(old)).snapshot_template.pack.policy.maxFollowups,2)
  const fresh=await ctx.newPage();await fresh.goto(fixture.baseline_origin+'/?fieldnoteId='+fixture.baseline_key+'&preview=new#code=000000');await fresh.locator('#answer').waitFor();assert.equal((await context(fresh)).snapshot_template.pack.policy.maxFollowups,0);await old.close();await fresh.close();check('baseline reproduces frozen old session=2 while new session=0; no admin persistence loss reproduced')
  await login(manager,fixture.origin,fixture.baseline_key)
  await manager.getByRole('link',{name:'API Key',exact:true}).click();await manager.locator('#publisher-key-name').fill('合成追问验收');await manager.getByRole('button',{name:'创建 API Key',exact:true}).click();await manager.locator('#publisher-key-once').waitFor({state:'visible'});const key=await manager.locator('#publisher-key-token').inputValue();await manager.getByRole('button',{name:'已保存，关闭',exact:true}).click()
  desktop=await electron.launch({executablePath:exe,args:['--data-dir',data,'--lang=zh-CN'],env:backendEnvironment(process.env,join(data,'unused')),timeout:45000})
  page=await desktop.firstWindow({timeout:60000});page.setDefaultTimeout(20000)
  desktop.context().on('page',p=>p.on('pageerror',e=>errors.push(e.message)))
  await desktop.context().route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort())
  await page.getByRole('button',{name:'继续',exact:true}).click();await page.getByRole('dialog',{name:'添加一个 API Key 开始使用'}).getByRole('button',{name:'稍后配置',exact:true}).click()
  await page.getByRole('button',{name:'专家访谈',exact:true}).click();await page.getByRole('button',{name:'新建专家访谈',exact:false}).click();await page.getByRole('heading',{name:'新建实践专家访谈',exact:true}).waitFor()
  await page.getByRole('button',{name:'设置',exact:true}).first().click();const prefs=page.getByRole('dialog',{name:'设置',exact:true});await prefs.getByRole('button',{name:'模型',exact:true}).click();await prefs.getByRole('button',{name:'添加自定义提供方',exact:true}).click()
  for(const[label,value]of [['Provider ID','policy-fixture'],['显示名称','Policy synthetic fixture'],['API 地址','http://127.0.0.1:'+provider.address().port+'/v1'],['API 密钥','synthetic-only-no-paid-key']])await prefs.getByLabel(label,{exact:true}).last().fill(value)
  await prefs.getByLabel('API 协议',{exact:true}).selectOption('openai-completions');await prefs.getByRole('button',{name:'获取可用模型',exact:true}).last().click();const picker=page.getByRole('dialog',{name:'选择要添加的模型',exact:true});await picker.getByRole('checkbox').check();await picker.getByRole('button',{name:'添加所选',exact:true}).click();await prefs.getByRole('button',{name:'创建提供方',exact:true}).click();await prefs.getByRole('button',{name:'编辑 Policy synthetic fixture (policy-fixture)',exact:true}).waitFor();await prefs.getByRole('button',{name:'关闭',exact:true}).click()
  await page.getByRole('button',{name:/选择模型/}).click();await page.getByRole('menuitem',{name:/模型/}).click();await page.getByRole('menuitemradio',{name:/policy-fixture-model/}).click()
  for(const[id,value]of [['expert-name','合成文献专家'],['expert-industry','合成课程'],['expert-role','合成教师'],['expert-years','10'],['expert-experience','只用于本机验收的合成经历。']])await page.locator('#'+id).fill(value)
  await page.locator('#expert-stage').selectOption('成熟期');await page.getByRole('button',{name:'生成问题包',exact:true}).click();await page.getByRole('button',{name:'问题包',exact:true}).click();await page.getByRole('heading',{name:'问题包已准备好',exact:true}).waitFor({timeout:60000})
  const rows=await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh.practice-expert-interviews.v2')));const generated=rows.find(r=>r.questions?.length===5);assert.ok(generated);assert.equal(generation>0,true);assert.deepEqual(generated.questions.map(q=>q.followupPolicy.input),['none','none','other','text','text']);await shot(page,'desktop-generated-package');check('actual EXE model selection/generation/parser produces text-only per-question policies')
  await page.getByRole('button',{name:'访谈设置',exact:true}).click();await page.getByRole('button',{name:'Worker 发布',exact:true}).click();await page.getByPlaceholder('https://worker.example.com').fill(fixture.origin);await page.getByLabel('发布 API Key',{exact:true}).fill(key);await page.getByRole('button',{name:'保存发布授权',exact:true}).click();await page.getByRole('status').filter({hasText:'发布授权已保存'}).waitFor();await page.getByRole('button',{name:'返回访谈',exact:true}).click();await page.getByRole('button',{name:'问题包',exact:true}).click()
  const opened=desktop.waitForEvent('window',{timeout:30000});await page.getByRole('button',{name:'发布并打开 SPA',exact:true}).click();participant=await opened;participant.setDefaultTimeout(20000);await participant.locator('[data-option]').first().waitFor();assert.equal(await participant.locator('#portal-start').count(),0);assert.equal(await participant.locator('#answer').count(),0)
  const share=await page.getByLabel('Worker 访谈地址',{exact:true}).inputValue(),packKey=new URL(share).searchParams.get('fieldnoteId');const entered=await context(participant);assert.deepEqual(entered.snapshot_template.pack.policy,{scope:'per_question',maxFollowups:2});assert.equal(new URL(participant.url()).searchParams.has('preview'),false);await mark(participant,'current');await shot(participant,'spa-direct-consent');await shot(page,'desktop-published-share');check('real EXE native upload opens usable SPA directly with default2, no manager configuration or participant confirmation')
  let calls=await modelCalls();await participant.locator('[data-option="0"]').check();await participant.locator('#confirm').click();await participant.getByText('本题没有可追问的文字输入，回答已保存，可继续。',{exact:true}).waitFor();assert.equal(await modelCalls(),calls);await participant.locator('#confirm').click();assert.equal(await participant.locator('#answer').count(),0);await participant.locator('[data-option="0"]').check();await participant.locator('#confirm').click();await participant.getByText('本题没有可追问的文字输入，回答已保存，可继续。',{exact:true}).waitFor();assert.equal(await modelCalls(),calls);await participant.locator('#confirm').click();check('consent and pure choices have no textarea and make zero model calls')
  assert.equal(await participant.locator('#answer').count(),0);await participant.locator('[data-option="1"]').check();await participant.locator('#answer').waitFor();await participant.locator('#confirm').click();await participant.getByText('本题没有可追问的文字输入，回答已保存，可继续。',{exact:true}).waitFor();assert.equal(await modelCalls(),calls)
  await participant.locator('#answer').fill('合成其他场景说明');await participant.locator('#confirm').click();await participant.locator('#supplement').waitFor();assert.equal(await modelCalls(),calls+2);await shot(participant,'spa-other-written-followup');await participant.locator('#continue').click();check('conditional Other needs selected option and written text; empty Other costs zero model calls')
  calls=await modelCalls();await participant.locator('#answer').fill('负责方案审查，以验收记录确认质量。');await participant.locator('#confirm').click();await participant.locator('#supplement').waitFor();await participant.locator('#supplement').fill('合成补充一');await participant.locator('#supplement-submit').click();await participant.locator('#supplement').waitFor();await participant.locator('#supplement').fill('合成补充二');await participant.locator('#supplement-submit').click();await participant.getByText(/已达到本次追问上限/).waitFor();assert.equal(await participant.locator('#supplement').count(),0);assert.equal(await modelCalls(),calls+4);await shot(participant,'spa-two-followups-limit');await participant.locator('#confirm').click();check('text question receives at most two followups; third judgment makes zero additional model calls')
  await control({action:'mode',mode:'invalid'});await participant.locator('#answer').fill('保留这个合成失败案例回答。');await participant.locator('#confirm').click();await participant.locator('#continue-after-error').waitFor();await participant.reload();await participant.locator('#continue-after-error').waitFor();assert.equal(await participant.locator('#answer').inputValue(),'保留这个合成失败案例回答。');await shot(participant,'spa-failure-retains-answer');await participant.locator('#continue-after-error').click();await participant.getByRole('heading',{name:'确认本次访谈',exact:true}).waitFor();assert.equal((await participant.locator('body').innerText()).includes('保留这个合成失败案例回答。'),true);await control({action:'mode',mode:'normal'});check('malformed local model response survives reload; keep-answer-and-continue opens review with answer retained')
  await settings(manager,fixture.origin,packKey);assert.equal(await manager.locator('#policy-inherit').isChecked(),true);assert.equal(await manager.locator('#policy-count').inputValue(),'2');await persistence(fixture.origin,'current',packKey,1,'interview',ctx)
  await participant.reload();assert.equal((await context(participant)).snapshot_template.pack.policy.maxFollowups,2)
  const preview=await ctx.newPage();await preview.goto(await manager.locator('#settings-preview').getAttribute('href'));await preview.locator('[data-option]').first().waitFor();assert.deepEqual((await context(preview)).snapshot_template.pack.policy,{scope:'interview',maxFollowups:1});const firstID=(await context(preview)).interview_id;await preview.reload();await preview.locator('[data-option]').first().waitFor();assert.equal((await context(preview)).interview_id,firstID);await shot(preview,'spa-new-session-current-settings');check('new preview adopts interview=1 while old frozen interview stays2; reload keeps same interview')
  await save(manager,0);const resetResponse=preview.waitForResponse(r=>r.url().endsWith('/portal/api/session/reset')&&r.request().method()==='POST');await preview.locator('#reset').click();const reset=await(await resetResponse).json();assert.notEqual(reset.interview_id,firstID);await preview.getByText('访谈会话 · '+reset.interview_id,{exact:true}).waitFor();assert.deepEqual((await context(preview)).snapshot_template.pack.policy,{scope:'per_question',maxFollowups:0});await preview.locator('[data-go="3"]').click();await preview.locator('#answer').fill('禁用追问时保存的合成文本');calls=await modelCalls();await preview.locator('#confirm').click();await preview.getByText(/已达到本次追问上限/).waitFor();assert.equal(await modelCalls(),calls);check('saved0/new session disables followups without discarding typed answer')
  const defaultMessage=captured.flat().find(m=>m.role==='user'&&String(m.content).includes('你现在是 DSH 的实践专家访谈问题包 Agent。'))
  assert.ok(defaultMessage,'Default client template must reach actual outbound user message')
  const refs=generated.questionPackMeta.globalReferences;assert.equal(refs.length,14)
  for(const ref of refs){assert.match(ref.sourceHash,/^[a-f0-9]{64}$/);for(const x of ref.excerpts)assert.ok(defaultMessage.content.includes(x.text),'Actual selected source passage must reach outbound request')}
  promptProof.push({case:'default',role:'user',all14SourcesUsed:true,verbatimExcerptsVerified:true,chars:defaultMessage.content.length})
  await page.getByRole('button',{name:'访谈设置',exact:true}).click();await page.getByRole('button',{name:'全局基础文献池',exact:true}).click()
  await page.getByLabel('检索文献全文或章节',{exact:true}).fill('Havighurst')
  const sourceCard=page.locator('article').filter({has:page.getByText('GREF-S1',{exact:true})});await sourceCard.getByRole('button',{name:'预览',exact:true}).click();await page.getByText(/发展性任务理论（Havighurst）/).first().waitFor();await shot(page,'real-document-search-preview')
  await page.getByLabel('检索文献全文或章节',{exact:true}).fill('')
  const cards=page.locator('article').filter({has:page.locator('span').filter({hasText:/^GREF-/})})
  for(const card of await cards.all())if(!(await card.innerText()).includes('GREF-S1')){const toggle=card.getByRole('button',{name:'停用',exact:true});if(await toggle.count())await toggle.click()}
  await page.getByRole('button',{name:'系统提示词',exact:true}).click();const template=await page.getByLabel('全局问题包生成系统提示词模板',{exact:true}).inputValue()
  assert.ok(template.includes('{{global_reference_pool}}'))
  const markerA='CORCH_CLIENT_PROMPT_A_20261016',markerB='CORCH_CLIENT_PROMPT_B_20261016'
  await page.getByLabel('全局问题包生成系统提示词模板',{exact:true}).fill(template+'\n'+markerA);await page.getByRole('button',{name:'保存并应用',exact:true}).click();await page.getByRole('button',{name:'已保存',exact:true}).waitFor();await shot(page,'client-template-saved')
  await desktop.close();desktop=await electron.launch({executablePath:exe,args:['--data-dir',data,'--lang=zh-CN'],env:backendEnvironment(process.env,join(data,'unused')),timeout:45000});page=await desktop.firstWindow({timeout:60000});page.setDefaultTimeout(20000)
  await desktop.context().route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort())
  if(await page.getByRole('dialog',{name:'添加一个 API Key 开始使用'}).count())await page.getByRole('button',{name:'稍后配置',exact:true}).click()
  await page.getByRole('button',{name:'专家访谈',exact:true}).click();await page.getByRole('button',{name:'访谈设置',exact:true}).click();await page.getByRole('button',{name:'系统提示词',exact:true}).click();assert.equal(await page.getByLabel('全局问题包生成系统提示词模板',{exact:true}).inputValue(),template+'\n'+markerA);await page.getByRole('button',{name:'返回访谈',exact:true}).click()
  async function generateAnother(name,expected,absent){
    await page.getByRole('button',{name:'新建专家访谈',exact:false}).click();await page.getByRole('heading',{name:'新建实践专家访谈',exact:true}).waitFor();await page.getByRole('button',{name:/选择模型/}).click();await page.getByRole('menuitem',{name:/模型/}).click();await page.getByRole('menuitemradio',{name:/policy-fixture-model/}).click()
    for(const[id,value]of [['expert-name',name],['expert-industry','合成课程'],['expert-role','合成教师'],['expert-years','10'],['expert-experience','只用于本机验收。']])await page.locator('#'+id).fill(value)
    await page.locator('#expert-stage').selectOption('成熟期');const before=captured.length;await page.getByRole('button',{name:'生成问题包',exact:true}).click();await page.getByRole('button',{name:'问题包',exact:true}).click();await page.getByRole('heading',{name:'问题包已准备好',exact:true}).waitFor({timeout:60000})
    const request=captured.slice(before).find(messages=>messages.some(m=>m.role==='user'&&String(m.content).includes(expected)));assert.ok(request)
    const actual=request.filter(m=>m.role==='user').map(m=>m.content).join('\n');assert.equal(actual.split(expected).length-1,1);if(absent)assert.equal(actual.includes(absent),false);assert.equal(request.some(m=>m.role==='system'&&String(m.content).includes(expected)),false)
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh.practice-expert-interviews.v2')));const current=saved.find(r=>r.profile.name===name);assert.equal(current.questionPackMeta.globalReferences.length,1);assert.equal(current.questionPackMeta.globalReferences[0].id,'GREF-S1');for(const x of current.questionPackMeta.globalReferences[0].excerpts)assert.ok(actual.includes(x.text))
    promptProof.push({case:expected,role:'user',occurrences:1,enabledSources:['GREF-S1'],verbatimExcerptsVerified:true,chars:actual.length})
    return current
  }
  await generateAnother('合成提示词甲',markerA,markerB);check('custom client template and source selection survive actual EXE restart and reach outbound generation request once')
  await page.getByRole('button',{name:'访谈设置',exact:true}).click();await page.getByRole('button',{name:'系统提示词',exact:true}).click();await page.getByLabel('全局问题包生成系统提示词模板',{exact:true}).fill(template+'\n'+markerB);await page.getByRole('button',{name:'保存并应用',exact:true}).click();await page.getByRole('button',{name:'已保存',exact:true}).waitFor();await page.getByRole('button',{name:'返回访谈',exact:true}).click()
  const latest=await generateAnother('合成提示词乙',markerB,markerA)
  const openedFinal=desktop.waitForEvent('window',{timeout:30000});await page.getByRole('button',{name:'发布并打开 SPA',exact:true}).click();const finalSpa=await openedFinal;await finalSpa.locator('[data-option]').first().waitFor();assert.deepEqual((await context(finalSpa)).pack.questionPackMeta.globalReferences,latest.questionPackMeta.globalReferences);await shot(page,'custom-template-published-provenance');await finalSpa.close();check('modified client template is used by next generation; selected real excerpts and source map survive native publish and Worker read')
  await writeFile(join(out,'prompt-outbound-verification.json'),JSON.stringify({passed:true,uiField:'客户端专家访谈→访谈设置→系统提示词',outboundRole:'user',workerFollowupOrReportSystemChanged:false,proof:promptProof,paid_model_calls:0},null,2)+'\n')
  assert.equal(errors.length,0,errors.join('\n'));passed=true
}catch(e){if(manager&&!manager.isClosed())await shot(manager,'failure-manager').catch(()=>{});if(page&&!page.isClosed())await shot(page,'failure-desktop').catch(()=>{});if(participant&&!participant.isClosed())await shot(participant,'failure-spa').catch(()=>{});await writeFile(join(out,'failure.txt'),safe(e.stack));throw e}
finally{await writeFile(join(out,'verification.json'),JSON.stringify({passed,checks,screens,settingsProof,page_errors:errors,actual_packaged_exe:true,actual_edge_browser:true,real_mysql:true,synthetic_generation_calls:generation,paid_model_calls:0,production_changed:false,files_deleted:false},null,2)+'\n');await desktop?.close();await edge?.close();await new Promise(r=>provider.close(r));await control({action:'finish',passed}).catch(()=>{})}
