import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve} from 'node:path'
const {chromium}=createRequire(new URL('../../apps/web/package.json',import.meta.url))('playwright')
const output=resolve(process.argv[2]||'.artifacts/retired-options');await mkdir(output,{recursive:true})
const source=await readFile(new URL('../../apps/web/public/practice-expert-worker.js',import.meta.url),'utf8')
const previewTemplate=await readFile(new URL('../../apps/web/public/practice-expert-interview-spa.html',import.meta.url),'utf8')
const template=previewTemplate.replace('<script>','<script>window.__TEACHING_PORTAL__=true;</script><script>')
const labelFixture=JSON.parse(await readFile(new URL('../../packages/client/ui-polus-teaching-reform/tests/fixtures/control-option-labels.json',import.meta.url),'utf8'))
const aliases=[...new Set([...labelFixture.observed,...labelFixture.requested])]
const questions=aliases.map((label,i)=>({id:`Q${String(i+1).padStart(2,'0')}`,title:`合成退出项 ${i+1}`,type:'单项选择',answerMode:'other',question:'说明不适用条件时，保留正常业务内容。',options:['正常选项','核对不适用条款的业务分类','其他（请说明）',label],followupPolicy:{input:'other',otherOptions:['其他（请说明）'],maxFollowups:2}}))
const pack={fieldnoteId:'synthetic-retired-aliases',profile:{name:'合成专家',role:'合成测试'},questionPackMeta:{version:1},questions}
const origin='http://127.0.0.1:43169',errors=[],submissions=[],tasks=new Map()
const browser=await chromium.launch({headless:true,executablePath:process.env.PORTAL_TEST_CHROMIUM||undefined})
let escapes=0
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage()
 page.on('pageerror',e=>errors.push(e.message))
 const value={interview_id:'synthetic-retired-aliases',frozen:false,tasks:[],poll_interval_ms:10,pack,snapshot:{input_version:1,answers:questions.map((q,i)=>({question_id:q.id,text:'历史文字 '+i,text_input:'历史文字 '+i,selected_options:[q.options[3]],supplements:[],confirmed:false}))},snapshot_template:{questions:questions.map(q=>({id:q.id,text:q.question,options:q.options,followup_policy:q.followupPolicy})),pack:{key:'synthetic',goal:'合成回归',hash:'synthetic',policy:{scope:'per_question',maxFollowups:2}}}}
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){escapes++;return route.abort()}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:template})
  if(url.pathname==='/practice-expert-worker.js')return route.fulfill({contentType:'text/javascript',body:source})
  if(url.pathname==='/portal/api/session')return route.fulfill({json:value})
  if(url.pathname==='/portal/api/tasks'&&route.request().method()==='POST'){
   const body=route.request().postDataJSON();submissions.push(body)
   const task={id:'synthetic-'+submissions.length,kind:body.kind,question_id:body.question_id,input_version:body.snapshot.input_version,status:'succeeded',output:{status:'complete'}}
   tasks.set(task.id,task);return route.fulfill({status:202,json:{id:task.id}})
  }
  if(url.pathname.startsWith('/portal/api/tasks/'))return route.fulfill({json:tasks.get(url.pathname.split('/').at(-1))})
  escapes++;return route.abort()
 })
 await page.goto(origin+'/?fieldnoteId=synthetic-retired-aliases')
 for(let i=0;i<aliases.length;i++){
  await page.locator('[data-go="'+i+'"]').click();assert.equal(await page.locator('#answer').inputValue(),'历史文字 '+i)
  assert.equal(await page.locator('[data-option="3"]').count(),0,aliases[i])
  assert.equal(await page.locator('[data-option="1"]').count(),1,'Substantive middle label must remain')
  assert.equal(await page.locator('[data-option="2"]').count(),0,'Generic Other must be a text field, never a selectable option')
  await page.locator('#confirm').click();await page.getByRole('button',{name:'继续下一步',exact:true}).waitFor()
  const saved=submissions.at(-1).snapshot.answers.find(a=>a.question_id===questions[i].id)
  assert.deepEqual(saved.selected_options,[aliases[i]]);assert.equal(saved.text_input,'历史文字 '+i)
  await page.locator('[data-option="1"]').check();await page.locator('#answer').fill('正常业务文字中的不适用仍保留 '+i)
  await page.locator('#confirm').click();await page.getByRole('button',{name:'继续下一步',exact:true}).waitFor()
  const edited=submissions.at(-1).snapshot.answers.find(a=>a.question_id===questions[i].id)
  assert.deepEqual(edited.selected_options,['核对不适用条款的业务分类']);assert.equal(edited.text_input,'正常业务文字中的不适用仍保留 '+i)
 }
 await page.screenshot({path:resolve(output,'worker-retired-aliases.png'),fullPage:true});await context.close()
 const previewContext=await browser.newContext(),preview=await previewContext.newPage();preview.on('pageerror',e=>errors.push(e.message))
 await preview.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){escapes++;return route.abort()}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:previewTemplate})
  if(url.pathname==='/interviews/synthetic-retired-aliases.json')return route.fulfill({json:pack})
  escapes++;return route.abort()
 })
 await preview.goto(origin+'/?fieldnoteId=synthetic-retired-aliases')
 for(let i=0;i<aliases.length;i++){
  await preview.locator('button.step').nth(i).click();assert.equal(await preview.locator('[data-option="3"]').count(),0,aliases[i]);assert.equal(await preview.locator('[data-option="1"]').count(),1)
  await preview.locator('#answer').fill('预览业务文字中的不适用保留 '+i);await preview.locator('[data-option="1"]').check()
 }
 await preview.reload();await preview.locator('button.step').nth(9).click();assert.equal(await preview.locator('#answer').inputValue(),'预览业务文字中的不适用保留 9')
 await previewContext.close();assert.deepEqual(errors,[]);assert.equal(escapes,0)
 const proof={passed:true,aliases,actual_observed_labels:labelFixture.observed.length,generic_other_controls_hidden:true,worker_and_preview:true,original_indices_preserved:true,historical_retired_selections_and_text_preserved:true,substantive_options_and_question_text_preserved:true,production_requests:0,model_calls:0}
 await writeFile(resolve(output,'verification.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof))
}finally{await browser.close()}
