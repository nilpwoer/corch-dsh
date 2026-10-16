/** Actual portable EXE, separate Edge profile and real Worker HTTP/assets with synthetic storage. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { backendEnvironment } from './policy.mjs'
const require=createRequire(new URL('../web/package.json',import.meta.url))
const { _electron:electron,chromium }=require('playwright')
const {values}=parseArgs({options:{exe:{type:'string'},data:{type:'string'},out:{type:'string'},'worker-fixture':{type:'string'}}})
for(const name of ['exe','data','out','worker-fixture'])assert.ok(values[name],name)
const exe=resolve(values.exe),data=resolve(values.data),out=resolve(values.out),handoff=resolve(values['worker-fixture'])
assert.equal(existsSync(data),false,'Fresh owned test profile required')
await mkdir(out,{recursive:true})
const fixture=JSON.parse(await readFile(handoff,'utf8'))
assert.equal(new URL(fixture.origin).hostname,'127.0.0.1')
const recordKey='dsh.practice-expert-interviews.v2'
const errors=[],checks=[],screens=[]
let desktop,page,edge,manager,passed=false,key,token,share,firstSession
const check=(name)=>{checks.push(name);console.log('PASS '+name)}
const safe=value=>String(value).replace(/dsh_pub_[a-f0-9]{64}/g,'[KEY MASKED]').replace(/[a-f0-9]{40}/g,'[INVITATION MASKED]').replace(/#code=[^\s"<>]+/g,'#code=[MASKED]').replaceAll(fixture.synthetic_password,'[PASSWORD MASKED]')
async function shot(p,name){
  await p.waitForTimeout(150)
  await writeFile(join(out,name+'.aria.txt'),safe(await p.locator('body').ariaSnapshot()))
  await p.screenshot({path:join(out,name+'.png'),fullPage:true,mask:[p.locator('input,code,pre,[class*="shareCode"]')],maskColor:'#CBD5E1'})
  screens.push(name+'.png')
}
async function launch(){
  desktop=await electron.launch({executablePath:exe,args:['--data-dir',data,'--lang=zh-CN'],env:backendEnvironment(process.env,join(data,'unused')),timeout:45000})
  page=await desktop.firstWindow({timeout:60000});page.setDefaultTimeout(20000)
  desktop.context().on('page',p=>p.on('pageerror',e=>errors.push(e.message)))
  page.on('pageerror',e=>errors.push(e.message))
  await desktop.context().route('**/*',route=>['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort())
}
async function openInterview(title='合成课程课堂核对访谈'){
  await page.getByRole('button',{name:'专家访谈',exact:true}).click()
  await page.getByRole('button').filter({hasText:title}).click()
  await page.getByRole('button',{name:'问题包',exact:true}).click()
}
async function settings(){
  await page.getByRole('button',{name:'访谈设置',exact:true}).click()
  await page.getByRole('button',{name:'Worker 发布',exact:true}).click()
}
async function saveKey(value){
  await settings();await page.getByPlaceholder('https://worker.example.com').fill(fixture.origin)
  await page.getByLabel('发布 API Key',{exact:true}).fill(value)
  await page.getByRole('button',{name:'保存发布授权',exact:true}).click()
  await page.getByRole('status').filter({hasText:'发布授权已保存'}).waitFor()
  assert.equal(await page.getByLabel('发布 API Key',{exact:true}).inputValue(),'')
  await shot(page,'03-desktop-publisher-settings')
  await page.getByRole('button',{name:'返回访谈',exact:true}).click()
}
async function createKey(name,expiry){
  await manager.getByRole('link',{name:'API Key',exact:true}).click()
  await manager.locator('#publisher-key-name').fill(name)
  if(expiry)await manager.locator('#publisher-key-expiry').fill(expiry)
  await manager.getByRole('button',{name:'创建 API Key',exact:true}).click()
  await manager.locator('#publisher-key-once').waitFor({state:'visible'})
  const value=await manager.locator('#publisher-key-token').inputValue()
  assert.match(value,/^dsh_pub_[a-f0-9]{64}$/)
  return value
}
async function publish(){
  const window=desktop.waitForEvent('window')
  await page.getByRole('button',{name:'发布并打开 SPA',exact:true}).click()
  const participant=await window;participant.setDefaultTimeout(20000)
  await participant.locator('#portal-code').waitFor()
  await page.getByRole('heading',{name:'分享链接',exact:true}).waitFor()
  return participant
}
async function failPublish(text){
  const before=desktop.windows().length
  await page.getByRole('button',{name:'问题包',exact:true}).click()
  await page.getByRole('button',{name:'发布并打开 SPA',exact:true}).click()
  await page.getByLabel('发布反馈',{exact:true}).getByRole('alert').filter({hasText:text}).waitFor()
  assert.equal(desktop.windows().length,before)
  assert.equal(await page.getByRole('button',{name:'配置发布授权',exact:true}).isVisible(),true)
}
try{
  await launch()
  await page.getByRole('dialog',{name:'欢迎使用 Corch DSH'}).waitFor();await shot(page,'01-product-welcome')
  await page.getByRole('button',{name:'继续',exact:true}).click()
  const onboarding=page.getByRole('dialog',{name:'添加一个 API Key 开始使用'});await onboarding.waitFor();await onboarding.getByRole('button',{name:'以后再说',exact:true}).click()
  assert.equal((await page.title()).includes('Corch Dev Build'),false)
  await page.getByRole('button',{name:'专家访谈',exact:true}).click()
  const ids=[]
  for(let n=0;n<2;n++){
    await page.getByRole('button',{name:'新建专家访谈',exact:false}).click()
    await page.getByRole('heading',{name:'新建实践专家访谈',exact:true}).waitFor()
    const rows=await page.evaluate(async()=>{const method='session.list';const r=await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{}})});return(await r.json()).result.value.items})
    ids.push(rows.find(r=>!ids.includes(r.sessionId)).sessionId)
  }
  firstSession=ids[0]
  const row=(id,fieldnote,title,publication)=>({record:{id,fieldnoteId:fieldnote,title,expert:'合成专家',industry:'合成课程',status:'已确认问题包',updated:'合成'},profile:{name:'合成专家',role:'合成教师',industry:'合成课程',years:'10',stage:'成熟期',experience:'合成课堂核对'},questions:[{id:'Q01',title:'课堂核对',type:'开放回答',question:'请描述课堂核对过程。',sourceRefs:[]},{id:'Q02',title:'判断依据',type:'开放回答',question:'如何判断核对结果？',sourceRefs:[]},{id:'Q03',title:'责任边界',type:'开放回答',question:'如何界定责任边界？',sourceRefs:[]}],questionPackMeta:{packId:'synthetic-ui-pack-'+fieldnote,version:1,generatedAt:'2026-10-16T00:00:00Z',sourceSessionId:id,checksum:'synthetic',globalReferences:[]},publication})
  const fresh=row(firstSession,'FN-ui','合成课程课堂核对访谈',{})
  const legacy=row(ids[1],'FN-legacy','既有口令访谈',{goal:'保留原有访谈目标',scope:'per_question',count:'2'});legacy.invitation={code:'000000',createdAt:'2026-10-15T00:00:00Z',status:'active'}
  await page.evaluate(({key,rows})=>{localStorage.setItem(key,JSON.stringify(rows));window.dispatchEvent(new Event('storage'))},{key:recordKey,rows:[fresh,legacy]})
  await page.getByRole('button',{name:'原生会话',exact:true}).click();await openInterview()
  await page.getByRole('heading',{name:'问题包已准备好',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'确认问题并生成 SPA',exact:true}).count(),0)
  assert.equal((await page.locator('body').innerText()).includes('A—J'),false)
  assert.equal((await page.locator('body').innerText()).includes('AGENT DRAFT'),false)
  await shot(page,'02-ready-question-package');check('ready state and single publication action')
  await settings();await page.getByPlaceholder('https://worker.example.com').fill(fixture.origin);await page.getByRole('button',{name:'保存地址',exact:true}).click();await page.getByRole('button',{name:'返回访谈',exact:true}).click()
  await failPublish('访谈设置');await shot(page,'04-missing-key-inline');check('missing Key gives inline settings shortcut without login')
  edge=await chromium.launch({channel:'msedge',headless:false})
  const adminContext=await edge.newContext({viewport:{width:1280,height:900},locale:'zh-CN',timezoneId:'UTC',acceptDownloads:true})
  manager=await adminContext.newPage();manager.setDefaultTimeout(20000)
  await adminContext.route('**/*',route=>new URL(route.request().url()).origin===fixture.origin?route.continue():route.abort())
  await manager.goto(fixture.origin+'/admin/?view=publisher-keys')
  await manager.getByLabel('密码',{exact:true}).fill(fixture.synthetic_password);await manager.getByRole('button',{name:'登录',exact:true}).click()
  token=await createKey('合成桌面首发 Key')
  await shot(manager,'05-admin-create-key-once')
  await manager.getByRole('button',{name:'已保存，关闭',exact:true}).click();await manager.reload()
  assert.equal(await manager.locator('#publisher-key-token').inputValue(),'')
  const list=await manager.evaluate(async()=>await(await fetch('/admin/api/publisher-keys')).json())
  assert.equal(JSON.stringify(list).includes(token),false)
  check('admin creates Key once; reload/list cannot reveal plaintext')
  assert.equal((await desktop.context().cookies(fixture.origin)).filter(c=>c.name==='teaching_admin').length,0)
  await saveKey(token)
  await desktop.close();desktop=undefined
  const vault=JSON.parse(await readFile(join(data,'worker-publisher.json'),'utf8'))
  assert.equal(JSON.stringify(vault).includes(token),false)
  await launch();await openInterview()
  await settings();await page.getByText('已保存 '+token.slice(0,16)+'… · '+fixture.origin,{exact:true}).waitFor();assert.equal(await page.getByLabel('发布 API Key',{exact:true}).inputValue(),'');await page.getByRole('button',{name:'返回访谈',exact:true}).click()
  const encrypted=await desktop.evaluate(({safeStorage},{record,expected})=>({available:safeStorage.isEncryptionAvailable(),matches:JSON.parse(safeStorage.decryptString(Buffer.from(record.ciphertext,'base64'))).token===expected}),{record:vault,expected:token})
  assert.deepEqual(encrypted,{available:true,matches:true});check('actual Electron OS encryption persists across restart with no plaintext browser storage')
  let participant=await publish()
  assert.equal((await desktop.context().cookies(fixture.origin)).filter(c=>c.name==='teaching_admin').length,0)
  assert.equal(await participant.evaluate(()=>window.corchPublication===undefined&&typeof process==='undefined'),true)
  share=await page.getByLabel('Worker 访谈地址',{exact:true}).inputValue();key=new URL(share).searchParams.get('fieldnoteId')
  assert.equal(share.includes(token),false)
  await shot(page,'06-published-share');await shot(participant,'07-spa-entry')
  await page.getByRole('button',{name:'复制链接',exact:true}).click()
  assert.equal(await desktop.evaluate(({clipboard})=>clipboard.readText()),share)
  check('first configured no-Cookie publish opens participant; actual clipboard equals share URL')
  await participant.locator('#portal-start button').click();await participant.locator('#portal-error').filter({hasText:'追问策略'}).waitFor()
  await manager.goto(fixture.origin+'/admin/?configure='+key)
  assert.equal(await manager.locator('#advanced-prompts').evaluate(e=>e.open),false)
  assert.equal(await manager.locator('#reports-page').isVisible(),false)
  await manager.locator('#policy-scope').selectOption('per_question');await manager.locator('#policy-count').fill('0');await manager.getByRole('button',{name:'保存配置',exact:true}).click();await manager.locator('#settings-message').filter({hasText:'已保存'}).waitFor()
  await shot(manager,'08-package-settings-collapsed')
  await participant.locator('#portal-start button').click();await participant.locator('#answer').waitFor();check('explicit package policy remains required and participant entry succeeds after configuration')
  await participant.close()
  const wrong=await adminContext.newPage();await wrong.goto(fixture.origin+'/?fieldnoteId='+key);await wrong.locator('#portal-code').fill('synthetic-wrong');await wrong.locator('#portal-start button').click();await wrong.locator('#portal-error').filter({hasText:'口令不正确'}).waitFor();await shot(wrong,'09-invalid-invitation-chinese');await wrong.close()
  for(const [label,view]of [['题包管理','packs'],['访谈报告','reports'],['API Key','keys'],['系统设置','settings']]){
    await manager.getByRole('link',{name:label,exact:true}).click();assert.equal(await manager.locator('#admin-nav [aria-current=page]').getAttribute('data-view'),view);await manager.reload();assert.equal(await manager.locator('#admin-nav [aria-current=page]').getAttribute('data-view'),view)
    assert.equal(await manager.locator('#workspace>section:visible').count(),1)
  }
  await manager.getByRole('link',{name:'访谈报告',exact:true}).click();await manager.getByRole('button',{name:'网页预览',exact:true}).click();await manager.frameLocator('#report-frame').getByRole('heading',{name:'合成访谈报告',exact:true}).waitFor()
  const download=manager.waitForEvent('download');await manager.getByRole('link',{name:'下载 PDF',exact:true}).click();const file=await download;await file.saveAs(join(out,'synthetic-report.pdf'));assert.equal((await readFile(join(out,'synthetic-report.pdf'))).subarray(0,5).toString(),'%PDF-')
  await shot(manager,'10-report-page-separated')
  await manager.getByRole('link',{name:'题包管理',exact:true}).click();await manager.locator('[data-settings="'+key+'"]').click();await manager.goBack();assert.equal(await manager.locator('#pack-list').isVisible(),true)
  await manager.setViewportSize({width:390,height:844});await manager.getByRole('link',{name:'API Key',exact:true}).click();await shot(manager,'11-admin-menu-narrow');assert.equal(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await manager.getByRole('link',{name:'系统设置',exact:true}).focus();await manager.keyboard.press('Enter');await manager.locator('#settings-title').filter({hasText:'系统设置'}).waitFor();check('four selected menus, separate reports/settings, refresh/back, keyboard and narrow screen')
  await manager.setViewportSize({width:1280,height:900})
  await manager.getByRole('link',{name:'API Key',exact:true}).click();manager.once('dialog',d=>d.accept());await manager.locator('[data-revoke-publisher]').first().click();await manager.locator('#publisher-key-message').filter({hasText:'已撤销'}).waitFor()
  await failPublish('已撤销');await shot(page,'12-revoked-key-inline');check('revoked Key never opens a login or participant window')
  await saveKey('dsh_pub_'+'f'.repeat(64));await failPublish('无效');check('invalid Key blocked inline')
  const expiry=new Date(Date.now()+8000).toISOString().slice(0,19)
  const expiring=await createKey('合成短期 Key',expiry);await saveKey(expiring)
  while(Date.now()<new Date(expiry+'Z').getTime()+200)await page.waitForTimeout(200)
  await failPublish('已过期');check('expired Key blocked inline')
  token=await createKey('合成重试 Key');await saveKey(token)
  await fetch(fixture.origin+'/__publisher_test_mode',{method:'POST',headers:{'X-Synthetic-Mode':'network'}})
  await failPublish('连接 Worker 失败');await shot(page,'13-network-failure-retry');check('real connection drop gives retryable inline network error')
  await fetch(fixture.origin+'/__publisher_test_mode',{method:'POST',headers:{'X-Synthetic-Mode':'delay'}})
  await desktop.context().clearCookies()
  const opened=desktop.waitForEvent('window')
  await page.getByRole('button',{name:'发布并打开 SPA',exact:true}).evaluate(button=>{button.click();button.click()})
  participant=await opened;await participant.locator('#portal-code').waitFor();await page.getByRole('heading',{name:'分享链接',exact:true}).waitFor();await participant.close()
  const retryShare=await page.getByLabel('Worker 访谈地址',{exact:true}).inputValue();assert.equal(retryShare,share);check('same-byte network retry and duplicate click preserve receipt and open once')
  await page.getByRole('button',{name:'问题包',exact:true}).click();await page.getByRole('heading',{name:'当前版本已发布',exact:true}).waitFor()
  await page.getByRole('button',{name:'编辑问题',exact:true}).first().click();await page.getByRole('button',{name:'保存修改',exact:true}).click()
  let saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),recordKey);assert.equal(saved.find(r=>r.record.id===firstSession).questionPackMeta.version,1)
  await page.getByRole('button',{name:'编辑问题',exact:true}).first().click();await page.getByRole('textbox',{name:'问题正文',exact:true}).fill('请描述修改后的课堂核对过程。');await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.getByRole('heading',{name:'问题包已准备好',exact:true}).waitFor()
  await page.getByRole('button',{name:'原生会话',exact:true}).click();await openInterview();await page.getByText('请描述修改后的课堂核对过程。',{exact:true}).waitFor();await shot(page,'14-edited-version-ready');check('no-op save preserves version; real edit survives reopen and resets published status')
  const allStorage=await page.evaluate(()=>JSON.stringify(localStorage));assert.equal(allStorage.includes(token),false)
  assert.equal((await readFile(join(data,'backend.log'),'utf8')).includes(token),false)
  assert.equal(errors.length,0)
  passed=true
  await writeFile(join(out,'verification.json'),JSON.stringify({passed,version:'0.1.5',actual_packaged_exe:true,actual_edge_browser:true,actual_worker_http_assets:true,account_and_key_storage:'synthetic; SQL verified separately',checks,screens,page_errors:errors,production_changed:false,real_model_tested:false,microphone_tested:false},null,2)+'\n')
}catch(error){
  if(page&&!page.isClosed()){await shot(page,'failure-redacted').catch(()=>undefined);await writeFile(join(out,'failure.txt'),safe(error.stack))}
  throw error
}finally{
  await edge?.close();await desktop?.close()
  await writeFile(handoff+'.done',JSON.stringify({passed})+'\n')
}
