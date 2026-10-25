const el=id=>document.getElementById(id)
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const api=async(path,options={})=>{
  const response=await fetch('/admin/api/'+path,{credentials:'same-origin',cache:'no-store',...options})
  const value=await response.json()
  if(!response.ok)throw Object.assign(new Error(({INVALID_PUBLISHER_KEY:'请填写 Key 名称，并选择未来的有效期。',ADMIN_SESSION_REQUIRED:'登录已过期，请重新登录管理端。',INVALID_LOGIN:'用户名或密码不正确，请重试。',SETTINGS_REVISION_CONFLICT:'配置已在其他页面更新，请刷新后重试。'}[value.error_code])||'操作未完成，请刷新页面后重试。'),{status:response.status})
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
  authenticated=active;el('login').hidden=active;el('workspace').hidden=!active;el('logout').hidden=!active;el('admin-nav').hidden=!active
  for(const id of ['pack-list','runtime-settings','reports-page','publisher-keys-page'])el(id).hidden=true
  sessionChecked=true
  void publishTransferred()
}
const reportURL=(id,format)=>'/admin/api/reports/'+encodeURIComponent(id)+'/'+format
const statusLabel=r=>({queued:'等待生成',running:'生成中',succeeded:'已完成',failed:'生成失败',superseded:'已被新版本替代'}[r.status]||r.status)+(r.error_code?' · '+r.error_code:'')
const showPage=(view,title,description)=>{
  for(const id of ['pack-list','runtime-settings','reports-page','publisher-keys-page'])el(id).hidden=id!==view
  const selected=view==='reports-page'?'reports':view==='publisher-keys-page'?'keys':view==='runtime-settings'&&!settingsView?.key?'settings':'packs'
  document.querySelectorAll('#admin-nav a').forEach(link=>{if(link.dataset.view===selected)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current')})
  el('page-title').textContent=title;el('page-description').textContent=description
}
const load=async()=>{
  const data=await api('packs')
  el('packs').innerHTML=data.packs.map(p=>`<tr><td>${esc(p.fieldnoteId)}<small>${esc(p.key)}</small></td><td>v${p.version}</td><td>${p.questions}</td><td><div class="table-actions"><button data-settings="${esc(p.key)}">访谈设置</button><a href="/?fieldnoteId=${encodeURIComponent(p.key)}" target="_blank" rel="noopener">打开访谈</a><button class="link-button danger" data-delete="${esc(p.key)}">移除</button></div></td></tr>`).join('')||'<tr><td colspan="4" class="empty">暂无题包，上传 JSON 或从 DSH 发布</td></tr>'
  el('issues').textContent=data.invalid_files.length?`未加载的文件：${data.invalid_files.join('、')}`:''
  document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=action(async()=>{if(confirm('移除当前目录题包？已开始的访谈仍保留原版本。')){await api('packs/'+encodeURIComponent(b.dataset.delete),{method:'DELETE'});await load()}}))
  document.querySelectorAll('[data-settings]').forEach(b=>b.onclick=action(()=>{history.pushState(null,'','?configure='+encodeURIComponent(b.dataset.settings));return openSettings(b.dataset.settings)}))
  showPage('pack-list','题包管理','发布题包并管理访谈设置')
}
const loadReports=async()=>{
  const reports=await api('reports')
  el('reports').innerHTML=reports.map(r=>`<div class="report-row"><div><div class="report-id">${esc(r.interview_id)}</div><div class="report-meta">报告 v${r.report_version} · ${esc(statusLabel(r))}</div></div><div class="report-actions"><button data-report="${esc(r.id)}" ${r.status==='succeeded'?'':'disabled'}>网页预览</button>${r.status==='succeeded'?`<a href="${reportURL(r.id,'pdf')}" download>下载 PDF</a><a href="${reportURL(r.id,'view')}" target="_blank" rel="noopener">单独打开</a>`:''}</div></div>`).join('')||'<p class="empty">暂无报告</p>'
  document.querySelectorAll('[data-report]').forEach(b=>b.onclick=action(()=>{el('report-frame').src=reportURL(b.dataset.report,'view');el('report-detail').hidden=false}))
  showPage('reports-page','访谈报告','查看和下载已有报告')
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
  el('settings-title').textContent=key?'题包访谈设置':'全局提示词'
  el('settings-description').textContent=key?`${key} · 配置修订 ${view.revision} · 不修改已有访谈`:'题包未覆盖时使用这里的提示词；现有模型和输出校验保持不变'
  el('policy-fields').hidden=!key
  el('policy-inherit').checked=!view.settings.policy
  el('policy-scope').value=view.policy?.scope||''
  el('policy-count').value=view.policy?.maxFollowups??''
  el('policy-effective').textContent=({package:'使用题包策略',override:'使用已保存覆盖',built_in:'使用内置默认'}[view.policy_source]||'')+(view.policy?' · '+(view.policy.scope==='interview'?'整场':'每题')+'最多 '+view.policy.maxFollowups+' 次':'')
  if(key&&!view.policy){
    el('policy-inherit').checked=false
    el('settings-description').textContent=key+' · 尚未配置追问策略，请明确选择计数范围和次数（0 表示不追问）'
  }
  for(const kind of ['followup','report']){
    el(kind+'-inherit').checked=!view.settings[kind]
    for(const stage of ['analyze','compose'])el(kind+'-'+stage).value=view.effective[kind][stage]
  }
  document.querySelectorAll('.inherit-label').forEach(e=>e.textContent=key?'继承全局默认提示词':'使用服务配置中的默认提示词')
  el('advanced-prompts').open=!key;el('settings-message').textContent='';updateInheritance();showPage('runtime-settings',key?'题包访谈设置':'系统设置',key||'题包未覆盖时使用这里的提示词')
  history.replaceState(null,'',key?'?configure='+encodeURIComponent(key):'?view=settings')
  el('settings-close').hidden=!key;el('pack-access').hidden=!key
  el('settings-preview').hidden=true
  if(key)await loadAccess(key)
  el('runtime-settings').scrollIntoView({block:'start',behavior:'instant'})
}
let accessView=null
const loadAccess=async key=>{
  const result=await api('packs/'+encodeURIComponent(key)+'/access')
  if(settingsView?.key!==key)return
  accessView={...result,key}
  const v=result.access
  const preview=new URL(result.url);preview.searchParams.set('preview','new')
  el('settings-preview').href=preview.href;el('settings-preview').hidden=!['active','not_required'].includes(v.status)
  el('access-code').type='password';el('access-code').value=v.code||'';el('access-reveal').textContent='显示口令'
  el('access-description').textContent=(v.source==='legacy'?'保留既有题包口令':'Worker 生成并验证')+' · '+({active:'有效',revoked:'已撤销',missing:'尚未生成'}[v.status]||v.status)
  el('access-create').hidden=v.status!=='missing';el('access-rotate').hidden=!v.code;el('access-revoke').hidden=v.status!=='active'
  for(const id of ['access-copy','access-copy-link'])el(id).disabled=v.status!=='active'
  el('access-link').value=accessView.url;el('access-link-fallback').hidden=true;el('access-reveal').disabled=!v.code;el('access-message').textContent=''
}
el('access-reveal').onclick=()=>{const input=el('access-code');input.type=input.type==='password'?'text':'password';el('access-reveal').textContent=input.type==='password'?'显示口令':'隐藏口令'}
for(const [id,kind]of [['access-copy','code'],['access-copy-link','url']])el(id).onclick=action(async()=>{
  try{await navigator.clipboard.writeText(kind==='code'?accessView.access.code:accessView.url);el('access-message').textContent='已复制'}
  catch{el('access-link-fallback').hidden=kind!=='url';const input=el(kind==='url'?'access-link':'access-code');input.type='text';input.focus();input.select();el('access-message').textContent='复制不可用，已选中内容，请手动复制'}
})
for(const [id,verb]of [['access-create','create'],['access-rotate','rotate'],['access-revoke','revoke']])el(id).onclick=action(async()=>{
  const current=accessView;if(!current)return
  if(verb!=='create'&&!confirm(verb==='rotate'?'重新生成后，原分享链接无法用于新进入。继续？':'撤销后，原分享链接无法用于新进入。继续？'))return
  await api('packs/'+encodeURIComponent(current.key)+'/access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:verb,revision:current.access.revision,publication_hash:current.access.publication_hash})})
  await loadAccess(current.key)
  if(transfer?.receipt&&transfer.key===current.key)await publishTransferred()
})
el('settings-close').onclick=action(async()=>{settingsGeneration++;settingsView=null;history.replaceState(null,'','/admin/');await load()})
for(const id of ['followup-inherit','report-inherit','policy-inherit'])el(id).onchange=updateInheritance
el('settings-form').onsubmit=action(async()=>{
  const view=settingsView;if(!view)return
  const settings={}
  for(const kind of ['followup','report'])if(!el(kind+'-inherit').checked)settings[kind]={analyze:el(kind+'-analyze').value,compose:el(kind+'-compose').value}
  if(view.key&&!el('policy-inherit').checked){
    const count=Number(el('policy-count').value)
    if(el('policy-count').value===''||!Number.isSafeInteger(count)||count<0||count>2||!el('policy-scope').value)throw new Error('请选择计数范围，追问次数为 0 到 2。')
    settings.policy={scope:el('policy-scope').value,maxFollowups:count}
  }
  const saved=await api(settingsPath(view.key),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:view.revision,publication_hash:view.publication_hash,settings})})
  if(settingsView===view){
    await openSettings(view.key);el('settings-message').textContent='已保存 · 修订 '+saved.revision+' · 新访谈生效'
    if(transfer?.receipt&&transfer.key===view.key)await publishTransferred()
  }
})
const clearPublisherToken=()=>{el('publisher-key-token').value='';el('publisher-key-token').type='password';el('publisher-key-once').hidden=true;el('publisher-key-reveal').textContent='显示 Key'}
const keyDate=value=>value?new Date(value).toLocaleString():'—'
const loadPublisherKeys=async()=>{
  const data=await api('publisher-keys')
  el('publisher-keys').innerHTML=data.keys.map(k=>{const expired=k.expires_at&&new Date(k.expires_at)<=new Date();return `<tr><td>${esc(k.name)}<small>${esc(k.prefix)}…</small></td><td>${k.status==='revoked'?'已撤销':expired?'已过期':'有效'}</td><td>${esc(keyDate(k.created_at))}<small>${esc(keyDate(k.last_used_at))}</small></td><td>${k.expires_at?esc(keyDate(k.expires_at)):'不限'}</td><td><button data-revoke-publisher="${esc(k.id)}" ${k.status==='revoked'?'disabled':''}>撤销</button></td></tr>`}).join('')||'<tr><td colspan="5">尚未创建发布 API Key</td></tr>'
  document.querySelectorAll('[data-revoke-publisher]').forEach(button=>button.onclick=action(async()=>{if(!confirm('撤销后，使用此 Key 的客户端将无法继续发布。已开始的上传可能完成。'))return;await api('publisher-keys/'+encodeURIComponent(button.dataset.revokePublisher),{method:'DELETE'});clearPublisherToken();await loadPublisherKeys();el('publisher-key-message').textContent='Key 已撤销'}))
  showPage('publisher-keys-page','API Key','为桌面客户端管理发布授权')
}
el('publisher-key-form').onsubmit=action(async()=>{
  clearPublisherToken()
  const expiry=el('publisher-key-expiry').value
  const data=await api('publisher-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:el('publisher-key-name').value,expires_at:expiry?new Date(expiry).toISOString():null})})
  el('publisher-key-token').value=data.token;el('publisher-key-once').hidden=false;el('publisher-key-message').textContent='Key 已创建，请复制到客户端访谈设置。'
  el('publisher-key-name').value='';el('publisher-key-expiry').value=''
  await loadPublisherKeys()
})
el('publisher-key-reveal').onclick=()=>{const input=el('publisher-key-token');input.type=input.type==='password'?'text':'password';el('publisher-key-reveal').textContent=input.type==='password'?'显示 Key':'隐藏 Key'}
el('publisher-key-copy').onclick=action(async()=>{try{await navigator.clipboard.writeText(el('publisher-key-token').value);el('publisher-key-message').textContent='已复制 Key'}catch{const input=el('publisher-key-token');input.type='text';input.focus();input.select();el('publisher-key-message').textContent='已选中 Key，请手动复制'}})
el('publisher-key-dismiss').onclick=clearPublisherToken
window.addEventListener('pagehide',clearPublisherToken)
const loadRequestedSettings=async()=>{
  settingsGeneration++
  const query=new URLSearchParams(location.search),key=query.get('configure')
  if(key){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(key))throw new Error('题包文件键无效');await openSettings(key)}
  else if(query.get('view')==='publisher-keys')await loadPublisherKeys()
  else if(query.get('view')==='reports')await loadReports()
  else if(['settings','defaults'].includes(query.get('view')))await openSettings('')
  else await load()
}
el('login-form').onsubmit=action(async()=>{
  const f=new FormData(el('login-form'))
  try{await api('login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:f.get('username'),password:f.get('password')})})}
  catch(error){if(error.status!==401)publishFailure(error);throw error}
  el('login-form').elements.password.value='';setSession(true);if(!transfer)await loadRequestedSettings()
})
el('logout').onclick=action(async()=>{
  await api('logout',{method:'POST'});clearPublisherToken();el('publisher-keys').replaceChildren();setSession(false);settingsGeneration++;settingsView=null;accessView=null;el('access-code').value=''
  el('packs').replaceChildren();el('reports').replaceChildren();el('runtime-settings').hidden=true;el('report-detail').hidden=true;el('report-frame').removeAttribute('src')
})
el('pack-file').onchange=()=>{const name=el('pack-file').files[0]?.name||'';el('pack-key').value=name.replace(/\.json$/i,'').replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,100)}
el('upload-form').onsubmit=action(async()=>{const file=el('pack-file').files[0];await api('packs/'+encodeURIComponent(el('pack-key').value),{method:'POST',headers:{'Content-Type':'application/json'},body:await file.text()});el('pack-file').value='';await load()})
el('refresh').onclick=action(loadReports)

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
    const managed=await api('packs/'+encodeURIComponent(key)+'/access')
    if(managed.access.status!=='active'&&managed.access.status!=='not_required'){
      transfer.sending=false;publishProgress('configuration-required','请在题包设置中生成或重新生成有效口令，随后自动打开访谈。');await openSettings(key);return
    }
    const url=new URL(managed.url)
    if(transfer.clientProtocol===1&&managed.access.code!==pack.invitation?.code){
      throw Object.assign(new Error('口令已在 Worker 更新，旧版客户端无法显示当前链接；请更新客户端或从管理端复制分享链接'),{status:409})
    }
    window.opener.postMessage({type:'teaching-publish:complete',nonce,key,hash:result.hash,url:url.href,code:managed.access.code,accessStatus:managed.access.status},origin)
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
        if(event.data.protocol!==undefined&&event.data.protocol!==1&&event.data.protocol!==2)throw new Error('发布协议版本不支持，请更新客户端')
        if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(key)||typeof payload!=='string'||new TextEncoder().encode(payload).length>2097152)throw new Error('题包传输格式无效')
        const pack=JSON.parse(payload)
        if(!Array.isArray(pack.questions)||!pack.questions.length||!Number.isSafeInteger(pack.questionPackMeta?.version)||pack.questionPackMeta.version<1||key!==`${pack.publicFieldnoteId}-v${pack.questionPackMeta.version}`)throw new Error('题包内容或版本文件键无效')
        transfer={...transfer,key,payload,pack,clientProtocol:event.data.protocol===2?2:1}
        el('publish-summary').textContent=`${pack.profile?.name||'实践专家'} · ${key} · v${pack.questionPackMeta.version} · ${pack.questions.length} 题`
        void publishTransferred()
      }catch(error){publishFailure(Object.assign(error,{status:400}))}
    })
    window.opener.postMessage({type:'teaching-publish:ready',nonce,autoPublish:true,accessAuthority:'worker'},origin.origin)
  }catch(error){el('error').textContent=error.message}
}
window.addEventListener('popstate',()=>{if(authenticated)void loadRequestedSettings().catch(error=>{el('error').textContent=error.message})})
initializeTransfer()
try{await api('session');setSession(true);if(!transfer)await loadRequestedSettings()}
catch(error){if(error.status===401)setSession(false);else{el('error').textContent=error.message;publishFailure(error)}}
