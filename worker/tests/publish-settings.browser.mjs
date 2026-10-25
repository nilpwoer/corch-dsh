import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'

const repo=fileURLToPath(new URL('../../',import.meta.url))
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url))
const clientRequire=createRequire(new URL('../../packages/client/ui-polus-teaching-reform/package.json',import.meta.url))
const {chromium}=require('playwright')
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href)
const [fixturePath,outputDir]=process.argv.slice(2)
const fixture=JSON.parse(await readFile(fixturePath,'utf8'))
const workerOrigin=new URL(fixture.origin).origin
assert.equal(new URL(workerOrigin).hostname,'127.0.0.1','Only the disposable Worker fixture is permitted')
await mkdir(outputDir,{recursive:true})
const temporary=await mkdtemp(join(tmpdir(),'tw-publish-browser-'))
const source=path=>'/@fs/'+join(repo,path).replaceAll('\\','/')
const record={record:{id:'synthetic-publish-session',fieldnoteId:'FN-browser-publish',title:'合成发布访谈',expert:'合成专家',industry:'合成课程',status:'已确认问题包',updated:'合成'},profile:{name:'合成专家',role:'合成教师',industry:'合成课程',years:'10',stage:'合成',experience:'合成课堂核对'},questions:[{id:'q_task',title:'课堂核对',type:'开放回答',question:'请描述课堂核对过程。',sourceRefs:[]},{id:'Q02',title:'判断依据',type:'开放回答',question:'如何判断核对结果？',sourceRefs:[]},{id:'Q03',title:'任务边界',type:'开放回答',question:'如何界定任务边界？',sourceRefs:[]}],questionPackMeta:{packId:'synthetic-browser-pack',version:7,generatedAt:'2026-10-14T00:00:00Z',sourceSessionId:'synthetic-publish-session',checksum:'synthetic',globalReferences:[]},invitation:{code:'000000',createdAt:'2026-10-14T00:00:00Z',status:'active'},publication:{goal:'核实合成课堂中的任务证据',scope:'per_question',count:'2'}}
await writeFile(join(temporary,'index.html'),'<html><head><meta charset="utf-8"></head><body><button id="fixture-settings">访谈设置</button><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>')
await writeFile(join(temporary,'entry.tsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';
import ${JSON.stringify(source('packages/client/ui-theme/src/styles/base.css'))};
import ${JSON.stringify(source('packages/client/ui-theme/src/styles/design-platform.css'))};
localStorage.setItem('dsh.practice-expert-interviews.v2',JSON.stringify([${JSON.stringify(record)}]));
window.__fixtureModelCalls=0;
const {InterviewDetails,selectInterview}=await import(${JSON.stringify(source('packages/client/ui-polus-teaching-reform/src/client/InterviewWorkbench.tsx'))});
selectInterview('synthetic-publish-session');
document.querySelector('#fixture-settings').onclick=()=>window.dispatchEvent(new CustomEvent('interview-settings-open'));
createRoot(document.querySelector('#root')).render(React.createElement(InterviewDetails,{sessionId:'synthetic-publish-session',generateInterview:()=>{window.__fixtureModelCalls++;throw new Error('Models are disabled in the publication fixture')},observeInterviewCommands:()=>()=>{}}));
`)
const vite=await createServer({configFile:false,root:temporary,logLevel:'error',resolve:{alias:{react:dirname(require.resolve('react')),'react-dom':dirname(require.resolve('react-dom/client')),'tiny-pinyin':clientRequire.resolve('tiny-pinyin')}},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[repo,temporary]}},optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','tiny-pinyin']}})
let browser
try{
  await vite.listen()
  const dshOrigin='http://127.0.0.1:'+vite.httpServer.address().port
  browser=await chromium.launch({executablePath:process.env.PORTAL_TEST_CHROMIUM,headless:true})
  const context=await browser.newContext({viewport:{width:1240,height:920},acceptDownloads:true})
  const errors=[];const network=[];let uploadBodies=[]
  const transcript={}
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)))
  context.on('request',request=>{network.push({url:request.url(),method:request.method()});if(request.method()==='POST'&&request.url()===workerOrigin+'/admin/api/packs/FN-browser-publish-v7')uploadBodies.push(request.postData())})
  await context.route('**/*',route=>{
    const origin=new URL(route.request().url()).origin
    if(![workerOrigin,dshOrigin,'http://untrusted.test'].includes(origin))return route.abort()
    return route.continue()
  })
  const dsh=await context.newPage()
  await dsh.goto(dshOrigin)
  await dsh.getByRole('button',{name:'问题包',exact:true}).click()
  const publishButton=()=>dsh.getByRole('button',{name:'发布并打开 SPA',exact:true})
  await publishButton().click()
  await dsh.getByRole('alert').filter({hasText:'填写目标地址'}).waitFor()
  await dsh.locator('#fixture-settings').click()
  await dsh.getByRole('button',{name:'Worker 发布',exact:true}).click()
  await dsh.getByPlaceholder('https://worker.example.com').fill(workerOrigin)
  await dsh.getByRole('button',{name:'保存地址',exact:true}).click()
  await dsh.getByRole('status').filter({hasText:'已保存 Worker'}).waitFor()
  await dsh.getByRole('button',{name:'返回访谈',exact:true}).click()
  await dsh.getByRole('button',{name:'问题包',exact:true}).click()
  const noReceipt=async()=>assert.equal(await dsh.evaluate(()=>JSON.parse(localStorage.getItem('dsh.practice-expert-interviews.v2'))[0].publication.worker),undefined)
  const openPublish=async(key='FN-browser-publish-v7')=>{const popup=dsh.waitForEvent('popup');await publishButton().click();const page=await popup;await page.locator('#publish-summary').filter({hasText:key}).waitFor();return page}
  let manager=await openPublish()
  assert.equal(await dsh.getByRole('button',{name:'等待 Worker 确认…',exact:true}).isDisabled(),true)
  await manager.close();await dsh.getByRole('alert').filter({hasText:'窗口已关闭'}).waitFor();await noReceipt()
  manager=await openPublish()
  const canceledPopup=manager.waitForEvent('close')
  await dsh.getByRole('button',{name:'取消发布',exact:true}).click()
  await canceledPopup;await noReceipt()
  manager=await openPublish()
  await manager.locator('input[name=password]').fill('incorrect-synthetic-password')
  await manager.getByRole('button',{name:'登录',exact:true}).click()
  await manager.locator('#error').filter({hasText:'INVALID_LOGIN'}).waitFor()
  assert.equal(await manager.locator('#publish-confirm').isDisabled(),true)
  await manager.close();await dsh.getByRole('alert').filter({hasText:'窗口已关闭'}).waitFor();await noReceipt()
  assert.equal(uploadBodies.length,0)
  manager=await openPublish()
  await manager.locator('input[name=password]').fill(fixture.synthetic_password)
  await manager.getByRole('button',{name:'登录',exact:true}).click()
  await manager.locator('#workspace').waitFor({state:'visible'})
  transcript.confirmation=await manager.locator('#publish-summary').textContent()
  await manager.screenshot({path:join(outputDir,'admin-real-worker-before-publish.png'),fullPage:true})
  await dsh.screenshot({path:join(outputDir,'dsh-publishing-locked.png'),fullPage:true})
  // A remote website cannot turn an existing admin session into a publication capability.
  const attacker=await context.newPage()
  await attacker.route('http://untrusted.test/**',route=>route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><button id="attack">open</button>'}))
  await attacker.goto('http://untrusted.test/')
  const badTarget=workerOrigin+'/admin/#'+new URLSearchParams({publish:'1',origin:'http://untrusted.test',nonce:'a'.repeat(64)})
  await attacker.evaluate(url=>{document.querySelector('#attack').onclick=()=>{window.__attack=window.open(url)}},badTarget)
  const badEvent=attacker.waitForEvent('popup');await attacker.locator('#attack').click();const bad=await badEvent
  await bad.locator('#error').filter({hasText:'发布来源无效'}).waitFor()
  await attacker.evaluate(origin=>{window.__attack.postMessage({type:'teaching-publish:prepare',nonce:'a'.repeat(64),key:'attacker-v1',payload:'{}'},origin)},workerOrigin)
  assert.equal(await bad.locator('#publish-confirm').isDisabled(),true)
  await bad.close();await attacker.close();await noReceipt()
  let failOnce=true
  await manager.route('**/admin/api/packs/FN-browser-publish-v7',route=>{
    if(route.request().method()==='POST'&&failOnce){failOnce=false;return route.fulfill({status:503,json:{error_code:'SYNTHETIC_UPLOAD_RETRY'}})}
    return route.continue()
  })
  await manager.locator('#publish-confirm').click()
  await manager.locator('#error').filter({hasText:'SYNTHETIC_UPLOAD_RETRY'}).waitFor();await noReceipt()
  await manager.locator('#publish-confirm').click()
  await manager.locator('#portal-code').waitFor()
  await dsh.getByRole('heading',{name:'分享链接',exact:true}).waitFor()
  assert.equal(await manager.locator('#portal-code').inputValue(),'000000')
  assert.equal(new URL(manager.url()).hash,'')
  assert.equal(network.filter(r=>r.method==='POST'&&r.url===workerOrigin+'/portal/api/session').length,0)
  assert.equal(uploadBodies.length,2);assert.equal(uploadBodies[0],uploadBodies[1])
  const receipt=await dsh.evaluate(()=>JSON.parse(localStorage.getItem('dsh.practice-expert-interviews.v2'))[0].publication.worker)
  assert.equal(receipt.key,'FN-browser-publish-v7');assert.equal(new URL(receipt.url).origin,workerOrigin)
  assert.equal(new URL(receipt.url).searchParams.has('code'),false)
  assert.equal(new URLSearchParams(new URL(receipt.url).hash.slice(1)).get('code'),'000000')
  assert.equal(await dsh.getByRole('heading',{level:3}).count(),2)
  transcript.share_sections=await dsh.getByRole('heading',{level:3}).allTextContents()
  transcript.share={package_key:receipt.key,query_contains_invitation:new URL(receipt.url).searchParams.has('code'),prefilled_invitation:await manager.locator('#portal-code').inputValue(),automatic_entry:false}
  await dsh.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}}))
  await dsh.getByRole('button',{name:'复制链接',exact:true}).click()
  assert.equal(await dsh.evaluate(()=>window.__copied),receipt.url)
  await dsh.screenshot({path:join(outputDir,'dsh-share-two-sections.png'),fullPage:true})
  await manager.locator('#portal-start button').click()
  await manager.locator('#answer').waitFor()
  const oldSession=await (await manager.request.get(workerOrigin+'/portal/api/session')).json()
  assert.equal(oldSession.snapshot_template.pack.policy.maxFollowups,2)
  const admin=await context.newPage();await admin.goto(workerOrigin+'/admin/')
  await admin.locator('[data-settings="FN-browser-publish-v7"]').click()
  await admin.locator('#runtime-settings').waitFor({state:'visible'})
  await admin.locator('#policy-inherit').uncheck();await admin.locator('#policy-scope').selectOption('interview');await admin.locator('#policy-count').fill('0')
  await admin.locator('#followup-inherit').uncheck();await admin.locator('#followup-analyze').fill('合成题包分析：保留引用检查');await admin.locator('#followup-compose').fill('合成题包追问：只问任务细节')
  await admin.locator('#settings-save').click();await admin.locator('#settings-message').filter({hasText:'已保存'}).waitFor()
  const configured=await (await admin.request.get(workerOrigin+'/admin/api/packs/FN-browser-publish-v7/settings')).json()
  assert.equal(configured.settings.policy.maxFollowups,0);assert.equal(configured.settings.policy.scope,'interview')
  assert.equal(configured.settings.followup.analyze,'合成题包分析：保留引用检查')
  transcript.package_settings={title:await admin.locator('#settings-title').textContent(),scope:await admin.locator('#policy-scope option:checked').textContent(),count:await admin.locator('#policy-count').inputValue(),followup_inherits:await admin.locator('#followup-inherit').isChecked(),report_inherits:await admin.locator('#report-inherit').isChecked()}
  assert.equal((await (await manager.request.get(workerOrigin+'/portal/api/session')).json()).snapshot_template.pack.policy.maxFollowups,2)
  await admin.screenshot({path:join(outputDir,'admin-pack-settings-real-worker.png'),fullPage:true})
  const participantContext=await browser.newContext({viewport:{width:390,height:900}})
  const participant=await participantContext.newPage();await participant.goto(receipt.url)
  assert.equal(await participant.locator('#portal-code').inputValue(),'000000')
  await participant.locator('#portal-start button').click();await participant.locator('#answer').waitFor()
  assert.equal((await (await participant.request.get(workerOrigin+'/portal/api/session')).json()).snapshot_template.pack.policy.maxFollowups,0)
  // Same-version publication retries retain the independently configured Worker policy.
  await dsh.getByRole('button',{name:'问题包',exact:true}).click()
  const again=await openPublish();await again.locator('#publish-confirm').click();await again.locator('#answer').waitFor()
  await dsh.getByRole('heading',{name:'分享链接',exact:true}).waitFor()
  const retained=await (await admin.request.get(workerOrigin+'/admin/api/packs/FN-browser-publish-v7/settings')).json()
  assert.equal(retained.revision,configured.revision);assert.equal(retained.settings.policy.maxFollowups,0)
  await admin.locator('#global-settings').click();await admin.locator('#settings-title').filter({hasText:'全局默认'}).waitFor()
  assert.equal(await admin.locator('#policy-fields').isVisible(),false)
  await admin.locator('#report-inherit').uncheck();await admin.locator('#report-analyze').fill('合成全局报告分析');await admin.locator('#report-compose').fill('合成全局报告组织')
  await admin.locator('#settings-save').click();await admin.locator('#settings-message').filter({hasText:'已保存'}).waitFor()
  const inherited=await (await admin.request.get(workerOrigin+'/admin/api/packs/FN-browser-publish-v7/settings')).json()
  assert.equal(inherited.effective.report.analyze,'合成全局报告分析');assert.equal(inherited.settings.report,undefined)
  await dsh.getByRole('button',{name:'问题包',exact:true}).click()
  await dsh.getByLabel('访谈目标').fill('合成新版本目标')
  assert.equal(await dsh.evaluate(()=>JSON.parse(localStorage.getItem('dsh.practice-expert-interviews.v2'))[0].record.status),'题包有未发布修改')
  await dsh.getByRole('button',{name:'创建新发布版本',exact:true}).click()
  const next=await openPublish('FN-browser-publish-v8')
  await next.locator('#publish-confirm').click()
  await dsh.getByRole('heading',{name:'分享链接',exact:true}).waitFor()
  const nextReceipt=await dsh.evaluate(()=>JSON.parse(localStorage.getItem('dsh.practice-expert-interviews.v2'))[0].publication.worker)
  assert.equal(nextReceipt.key,'FN-browser-publish-v8')
  const nextSettings=await (await admin.request.get(workerOrigin+'/admin/api/packs/FN-browser-publish-v8/settings')).json()
  assert.equal(nextSettings.revision,0);assert.equal(nextSettings.policy.maxFollowups,2)
  assert.equal(nextSettings.settings.followup,undefined)
  assert.equal(nextSettings.effective.report.analyze,'合成全局报告分析')
  assert.equal((await (await admin.request.get(workerOrigin+'/admin/api/packs/FN-browser-publish-v7/settings')).json()).revision,configured.revision)
  transcript.new_version={package_key:nextReceipt.key,initial_followups:nextSettings.policy.maxFollowups,settings_revision:nextSettings.revision,report_prompt:nextSettings.effective.report.analyze}
  await admin.locator('#settings-close').click()
  await admin.locator(`[data-report="${fixture.report_id}"]`).click()
  await admin.frameLocator('#report-frame').locator('h1').waitFor()
  const downloadEvent=admin.waitForEvent('download');await admin.locator(`a[href="/admin/api/reports/${fixture.report_id}/pdf"]`).click()
  const download=await downloadEvent;await download.saveAs(join(outputDir,'saved-report-regression.pdf'))
  assert.equal((await readFile(join(outputDir,'saved-report-regression.pdf'))).subarray(0,5).toString(),'%PDF-')
  await admin.setViewportSize({width:390,height:900});assert.ok(await admin.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
  await admin.screenshot({path:join(outputDir,'admin-mobile-real-worker.png'),fullPage:true})
  assert.equal(await dsh.evaluate(()=>window.__fixtureModelCalls),0)
  assert.equal(network.filter(r=>new URL(r.url).searchParams.has('code')||r.url.includes('000000')).length,0)
  assert.deepEqual(errors,[])
  const golden=JSON.parse(await readFile(new URL('../testdata/publish-settings-ui.golden.json',import.meta.url),'utf8'))
  assert.deepEqual(transcript,golden)
  await writeFile(join(outputDir,'ui-transcript.json'),JSON.stringify(transcript,null,2)+'\n')
  const result={passed:true,scope:'Actual DSH source components with controlled session props; real isolated Worker process and MySQL; real provider disabled',actual_dsh_publish_button:true,explicit_target_settings:true,missing_target_rejected:true,closed_window_recoverable:true,cancel_recoverable:true,failed_login_recoverable:true,untrusted_origin_cannot_publish:true,upload_failure_does_not_mark_published:true,retry_bytes_identical:true,two_share_sections:true,fragment_code_not_in_requests:true,fragment_prefill_requires_click:true,real_policy_form_saved:true,real_prompt_form_saved:true,started_session_policy_frozen:true,new_session_uses_updated_policy:true,republication_preserves_worker_settings:true,global_inheritance:true,explicit_new_version_isolated:true,saved_pdf_download:true,mobile_horizontal_overflow:false,real_model_calls:0,page_errors:errors}
  await writeFile(join(outputDir,'browser-verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{
  await browser?.close();await vite.close()
  const scope=relative(resolve(tmpdir()),resolve(temporary))
  assert.ok(scope&&!scope.startsWith('..')&&!scope.includes(':')&&scope.startsWith('tw-publish-browser-'))
  await rm(temporary,{recursive:true,force:true})
}
