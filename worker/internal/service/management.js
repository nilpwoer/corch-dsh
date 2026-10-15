const el=id=>document.getElementById(id)
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const api=async(path,options={})=>{
  const response=await fetch('/admin/api/'+path,{credentials:'same-origin',...options})
  const value=await response.json()
  if(!response.ok)throw Object.assign(new Error(value.error_code||`HTTP ${response.status}`),{status:response.status})
  return value
}
const action=fn=>async event=>{
  event?.preventDefault();el('error').textContent=''
  const button=event?.currentTarget instanceof HTMLButtonElement?event.currentTarget:event?.submitter
  if(button?.disabled)return
  if(button)button.disabled=true
  try{await fn(event)}catch(error){el('error').textContent=error.message}finally{if(button)button.disabled=false}
}
let authenticated=false
let transfer=null
let sessionChecked=false
let settingsView=null
let settingsGeneration=0
const setSession=active=>{
  authenticated=active;el('login').hidden=active;el('workspace').hidden=!active;el('logout').hidden=!active
  sessionChecked=true
  void publishTransferred()
}
const reportURL=(id,format)=>'/admin/api/reports/'+encodeURIComponent(id)+'/'+format
const statusLabel=r=>({queued:'等待生成',running:'生成中',succeeded:'已完成',failed:'生成失败',superseded:'已被新版本替代'}[r.status]||r.status)+(r.error_code?' · '+r.error_code:'')
const load=async()=>{
  const [data,reports]=await Promise.all([api('packs'),api('reports')])
  el('packs').innerHTML=data.packs.map(p=>`<tr><td>${esc(p.fieldnoteId)}<small>${esc(p.key)}</small></td><td>v${p.version}</td><td>${p.questions}</td><td><div class="table-actions"><button data-settings="${esc(p.key)}">访谈设置</button><a href="/?fieldnoteId=${encodeURIComponent(p.key)}" target="_blank" rel="noopener">打开访谈</a><button class="link-button danger" data-delete="${esc(p.key)}">移除</button></div></td></tr>`).join('')||'<tr><td colspan="4" class="empty">暂无题包，上传 JSON 或从 DSH 发布</td></tr>'
  el('issues').textContent=data.invalid_files.length?`未加载的文件：${data.invalid_files.join('、')}`:''
  el('reports').innerHTML=reports.map(r=>`<div class="report-row"><div><div class="report-id">${esc(r.interview_id)}</div><div class="report-meta">报告 v${r.report_version} · ${esc(statusLabel(r))}</div></div><div class="report-actions"><button data-report="${esc(r.id)}" ${r.status==='succeeded'?'':'disabled'}>网页预览</button>${r.status==='succeeded'?`<a href="${reportURL(r.id,'pdf')}" download>下载 PDF</a><a href="${reportURL(r.id,'view')}" target="_blank" rel="noopener">单独打开</a>`:''}</div></div>`).join('')||'<p class="empty">暂无报告</p>'
  document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=action(async()=>{if(confirm('移除当前目录题包？已开始的访谈仍保留原版本。')){await api('packs/'+encodeURIComponent(b.dataset.delete),{method:'DELETE'});await load()}}))
  document.querySelectorAll('[data-settings]').forEach(b=>b.onclick=action(()=>openSettings(b.dataset.settings)))
  document.querySelectorAll('[data-report]').forEach(b=>b.onclick=action(()=>{el('report-frame').src=reportURL(b.dataset.report,'view');el('report-detail').hidden=false}))
}
const settingsPath=key=>key?'packs/'+encodeURIComponent(key)+'/settings':'settings'
const updateInheritance=()=>{
  for(const kind of ['followup','report'])for(const stage of ['analyze','compose'])el(kind+'-'+stage).disabled=el(kind+'-inherit').checked
  el('policy-scope').disabled=el('policy-inherit').checked;el('policy-count').disabled=el('policy-inherit').checked
}
const openSettings=async key=>{
  const generation=++settingsGeneration
  const view=await api(settingsPath(key))
  if(generation!==settingsGeneration)return
  settingsView={...view,key}
  el('settings-title').textContent=key?'题包访谈设置':'全局默认提示词'
  el('settings-description').textContent=key?`${key} · 配置修订 ${view.revision} · 不修改已有访谈`:'题包未覆盖时使用这里的提示词；现有模型和输出校验保持不变'
  el('policy-fields').hidden=!key
  el('policy-inherit').checked=!view.settings.policy
  el('policy-scope').value=view.policy?.scope||''
  el('policy-count').value=view.policy?.maxFollowups??''
  if(key&&!view.policy){
    el('policy-inherit').checked=false
    el('settings-description').textContent=key+' · 尚未配置追问策略，请明确选择计数范围和次数（0 表示不追问）'
  }
  for(const kind of ['followup','report']){
    el(kind+'-inherit').checked=!view.settings[kind]
    for(const stage of ['analyze','compose'])el(kind+'-'+stage).value=view.effective[kind][stage]
  }
  document.querySelectorAll('.inherit-label').forEach(e=>e.textContent=key?'继承全局默认提示词':'使用服务配置中的默认提示词')
  el('settings-message').textContent='';updateInheritance();el('runtime-settings').hidden=false
  el('runtime-settings').scrollIntoView({block:'start',behavior:'instant'})
}
el('global-settings').onclick=action(()=>openSettings(''))
el('settings-close').onclick=()=>{settingsGeneration++;settingsView=null;el('runtime-settings').hidden=true}
for(const id of ['followup-inherit','report-inherit','policy-inherit'])el(id).onchange=updateInheritance
el('settings-form').onsubmit=action(async()=>{
  const view=settingsView;if(!view)return
  const settings={}
  for(const kind of ['followup','report'])if(!el(kind+'-inherit').checked)settings[kind]={analyze:el(kind+'-analyze').value,compose:el(kind+'-compose').value}
  if(view.key&&!el('policy-inherit').checked){
    const count=Number(el('policy-count').value)
    if(el('policy-count').value===''||!Number.isSafeInteger(count)||count<0||!el('policy-scope').value)throw new Error('请选择计数范围并填写非负整数次数')
    settings.policy={scope:el('policy-scope').value,maxFollowups:count}
  }
  await api(settingsPath(view.key),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:view.revision,publication_hash:view.publication_hash,settings})})
  if(settingsView===view){
    await openSettings(view.key);el('settings-message').textContent='已保存，新进入的访谈将采用此配置'
    if(transfer?.receipt&&transfer.key===view.key)await publishTransferred()
  }
})
const loadRequestedSettings=async()=>{
  await load()
  const key=new URLSearchParams(location.search).get('configure')
  if(key){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(key))throw new Error('题包文件键无效');await openSettings(key)}
}
el('login-form').onsubmit=action(async()=>{
  const f=new FormData(el('login-form'))
  try{await api('login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:f.get('username'),password:f.get('password')})})}
  catch(error){if(error.status!==401)publishFailure(error);throw error}
  el('login-form').elements.password.value='';setSession(true);if(!transfer)await loadRequestedSettings()
})
el('logout').onclick=action(async()=>{
  await api('logout',{method:'POST'});setSession(false);settingsGeneration++;settingsView=null
  el('packs').replaceChildren();el('reports').replaceChildren();el('runtime-settings').hidden=true;el('report-detail').hidden=true;el('report-frame').removeAttribute('src')
})
el('pack-file').onchange=()=>{const name=el('pack-file').files[0]?.name||'';el('pack-key').value=name.replace(/\.json$/i,'').replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,100)}
el('upload-form').onsubmit=action(async()=>{const file=el('pack-file').files[0];await api('packs/'+encodeURIComponent(el('pack-key').value),{method:'POST',headers:{'Content-Type':'application/json'},body:await file.text()});el('pack-file').value='';await load()})
el('refresh').onclick=action(load)

// A DSH click authorizes one upload; Worker credentials stay on this origin.
function publishProgress(phase,text){
  if(!transfer)return
  el('publish-status').textContent=text
  window.opener?.postMessage({type:'teaching-publish:progress',nonce:transfer.nonce,phase},transfer.origin)
}
function publishFailure(error){
  if(!transfer)return
  const message=error.status?'Worker 发布失败：'+error.message:'无法连接 Worker，请检查网络后重试'
  el('error').textContent=message
  el('publish-status').textContent='发布失败，请回到 DSH 重试'
  window.opener?.postMessage({type:'teaching-publish:error',nonce:transfer.nonce,key:transfer.key,message},transfer.origin)
}
async function publishTransferred(){
  if(!transfer?.payload||transfer.sending)return
  if(!sessionChecked){publishProgress('authorizing','正在检查登录状态…');return}
  if(!authenticated){publishProgress('login-required','请登录管理账号，登录后将自动发布');return}
  transfer.sending=true
  const {key,payload,pack,origin,nonce}=transfer
  publishProgress('uploading','正在上传题包…')
  try{
    const result=transfer.receipt||await api('packs/'+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},body:payload})
    if(result.key!==key||!/^[a-f0-9]{64}$/.test(result.hash))throw Object.assign(new Error('发布回执无效'),{status:502})
    transfer.receipt=result
    const settings=await api(settingsPath(key))
    if(!settings.policy){
      transfer.sending=false
      publishProgress('configuration-required','题包已上传，尚未配置追问策略。请先保存计数范围和次数，随后自动打开访谈。')
      await openSettings(key)
      return
    }
    const url=new URL('/',location.origin);url.searchParams.set('fieldnoteId',key)
    if(pack.invitation?.code)url.hash=new URLSearchParams({code:pack.invitation.code}).toString()
    window.opener.postMessage({type:'teaching-publish:complete',nonce,key,hash:result.hash,url:url.href},origin)
    window.opener=null
    location.replace(url.href)
  }catch(error){
    transfer.sending=false
    if(error.status===401){setSession(false);el('error').textContent='登录已过期，请重新登录后继续';return}
    publishFailure(error)
  }
}
const initializeTransfer=()=>{
  const fragment=new URLSearchParams(location.hash.slice(1))
  if(fragment.get('publish')!=='1')return
  history.replaceState(null,'',location.pathname+location.search)
  el('publish-transfer').hidden=false
  try{
    const origin=new URL(fragment.get('origin')||'')
    const nonce=fragment.get('nonce')||''
    if(!window.opener||origin.origin!==fragment.get('origin')||!['http:','https:'].includes(origin.protocol)||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||!/^[a-f0-9]{64}$/.test(nonce))throw new Error('发布来源无效，请从本机 DSH 重新打开')
    transfer={origin:origin.origin,nonce,payload:null,sending:false}
    el('publish-source').textContent='来源：'+origin.origin
    window.addEventListener('message',event=>{
      if(event.source!==window.opener||event.origin!==transfer.origin||event.data?.type!=='teaching-publish:prepare'||event.data.nonce!==transfer.nonce||transfer.payload)return
      try{
        const {key,payload}=event.data
        if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(key)||typeof payload!=='string'||new TextEncoder().encode(payload).length>2097152)throw new Error('题包传输格式无效')
        const pack=JSON.parse(payload)
        if(!Array.isArray(pack.questions)||!pack.questions.length||!Number.isSafeInteger(pack.questionPackMeta?.version)||pack.questionPackMeta.version<1||key!==`${pack.publicFieldnoteId}-v${pack.questionPackMeta.version}`)throw new Error('题包内容或版本文件键无效')
        transfer={...transfer,key,payload,pack}
        el('publish-summary').textContent=`${pack.profile?.name||'实践专家'} · ${key} · v${pack.questionPackMeta.version} · ${pack.questions.length} 题`
        void publishTransferred()
      }catch(error){publishFailure(Object.assign(error,{status:400}))}
    })
    window.opener.postMessage({type:'teaching-publish:ready',nonce,autoPublish:true},origin.origin)
  }catch(error){el('error').textContent=error.message}
}
initializeTransfer()
try{await api('session');setSession(true);if(!transfer)await loadRequestedSettings()}
catch(error){if(error.status===401)setSession(false);else{el('error').textContent=error.message;publishFailure(error)}}
