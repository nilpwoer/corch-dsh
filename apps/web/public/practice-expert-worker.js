/**
 * 将既有访谈 SPA 接入同源的本地 Worker 会话；浏览器不持有共享服务令牌。
 * @param {HTMLElement} app - 既有页面的应用容器。
 * @returns {Promise<void>} 页面及已有任务恢复完成后结束。
 */
export async function mountWorkerInterview(app) {
  const portal = window.__TEACHING_PORTAL__ === true
  const base = portal ? '/portal/api' : '/browser'
  const requestedPack = new URLSearchParams(location.search).get('fieldnoteId') || ''
  let recognition = null
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const lifetime = new AbortController()
  window.addEventListener('pagehide', () => { lifetime.abort(); recognition?.stop() }, { once: true })
  const api = async (path, body, key) => {
    const response = await fetch(path.replace(/^\/browser/, base), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: lifetime.signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const value = await response.json()
    if (!response.ok) throw Object.assign(new Error(value.error_code || `HTTP_${response.status}`), { status: response.status, data: value })
    return value
  }
  let context
  try { context = await api(`/browser/session${portal && requestedPack ? `?fieldnoteId=${encodeURIComponent(requestedPack)}` : ''}`) }
  catch (failure) {
    if (!portal || ![401, 409].includes(failure.status)) throw failure
    let packs = []
    if (failure.data?.entry_mode === 'list' && !requestedPack) packs = await api('/browser/packs')
    const needsCode = failure.data?.invitation_mode !== 'none'
    app.innerHTML = `<main class="main"><section class="panel auth-card"><h2>实践专家访谈</h2><p>请选择主持人提供的访谈，不需要注册账号。</p><form id="portal-start"><label for="portal-key">访谈题包</label>${packs.length ? `<select id="portal-key">${packs.map(p => `<option value="${esc(p.key)}">${esc(p.fieldnoteId)} · v${p.version}</option>`).join('')}</select>` : `<input id="portal-key" value="${esc(requestedPack)}" required placeholder="主持人提供的题包标识">`}${needsCode ? '<label for="portal-code">访谈口令</label><input id="portal-code" type="password" autocomplete="off" required>' : ''}<button class="btn primary">开始访谈</button><p id="portal-error" role="alert"></p></form></section></main>`
    document.querySelector('#portal-start').onsubmit = async event => {
      event.preventDefault()
      try {
        const created = await api('/browser/session', { key: document.querySelector('#portal-key').value, code: document.querySelector('#portal-code')?.value || '' })
        const target = new URL(location.href)
        target.searchParams.set('fieldnoteId', created.snapshot_template.pack.key)
        history.replaceState(null, '', target)
        await mountWorkerInterview(app)
      } catch (error) { document.querySelector('#portal-error').textContent = error.message }
    }
    return
  }
  let state
  let results = {}
  let reports = []
  let busy = false
  let message = ''
  let error = ''
  let review = false
  let reportView = false
  let key
  const encodeAnswer = (answer, question) => {
    const selected = answer.selected ? [answer.selected] : (answer.options || []).map(i => question.options?.[i]).filter(Boolean)
    return [selected.length ? `选择：${selected.join('；')}` : '', answer.text || '', ...(answer.supplements || []).map((text, i) => `补充回答 ${i + 1}：${text}`)].filter(Boolean).join('\n')
  }
  const persist = () => {
    try { localStorage.setItem(key, JSON.stringify(state)) }
    catch { message = '本地暂存失败，请保持页面打开并及时提交。' }
  }
  const applyTask = task => {
    if (task.kind === 'report') {
      reports = reports.filter(item => item.id !== task.id).concat(task).sort((a, b) => a.report_version - b.report_version)
      if (task.status === 'succeeded') reportView = true
    } else if (task.question_id && task.status !== 'superseded') results[task.question_id] = task
  }
  const restore = () => {
    key = `teaching-worker-draft:v1:${context.interview_id}`
    let saved
    try { saved = JSON.parse(localStorage.getItem(key) || 'null') } catch { saved = null }
    state = saved?.interview_id === context.interview_id && saved.answers && Number.isSafeInteger(saved.version) ? saved : {
      interview_id: context.interview_id, version: 0, index: 0, answers: {}, pending: null, frozen: false, fingerprint: '',
    }
    results = {}; reports = []
    for (const q of context.pack.questions) {
      const answer = state.answers[q.id]
      if (!answer || typeof answer.text !== 'string' || !Array.isArray(answer.supplements)) {
        state.answers[q.id] = { text: '', selected: '', options: [], supplements: [], confirmed: false, skipped: false }
      }
    }
    // 服务端快照恢复已提交内容；未提交草稿只在本机保留，绝不覆盖更新的服务端版本。
    if (context.snapshot && context.snapshot.input_version > state.version) {
      state.version = context.snapshot.input_version
      for (const answer of context.snapshot.answers) {
        state.answers[answer.question_id] = { text: answer.text, selected: '', options: [], supplements: [], confirmed: answer.confirmed, skipped: answer.skipped }
      }
      state.fingerprint = ''
    }
    state.index = Math.max(0, Math.min(context.pack.questions.length - 1, state.index || 0))
    state.frozen = context.frozen
    for (const task of context.tasks) applyTask(task)
    if (state.frozen && context.snapshot) {
      state.version = context.snapshot.input_version
      state.frozenSnapshot = context.snapshot
    }
    if (!state.pending) {
      const running = [...context.tasks].reverse().find(task => task.status === 'queued' || task.status === 'running')
      if (running) state.pending = { id: running.id, kind: running.kind, question_id: running.question_id }
    }
    persist()
  }
  restore()
  const styles = document.createElement('style')
  styles.textContent = '.worker-note{padding:10px 14px;background:#fff7e6;border:1px solid #f2d69e;border-radius:8px;margin-bottom:16px;font-size:12px}.worker-status{padding:12px;margin-top:12px;background:#f6f7f8;border-radius:8px}.worker-error{color:#b42318;background:#fff1f0}.followup{padding:16px;border:1px solid #edc7c5;border-radius:8px;margin-top:18px;background:#fffafa}.followup h3{margin:0 0 8px;font-size:15px}.report{padding:24px;margin:16px 0}.report h2{font-size:19px}.report h3{font-size:16px;margin-top:24px}.report p,.report li{white-space:pre-wrap;overflow-wrap:anywhere}.report a{color:#b83a36}.report blockquote{border-left:3px solid #ddd;margin:10px 0;padding:8px 14px;background:#fafafa}.kind{font-size:11px;color:#6b7280;margin-right:6px}.review-answer{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:#fafafa;margin:8px 0 18px}.actions{flex-wrap:wrap}.worker-toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:16px}.worker-toolbar .btn{white-space:nowrap}'
  document.head.append(styles)
  const errorText = code => ({
    MODEL_HTTP_401: '模型密钥无效，请检查服务端配置。', MODEL_HTTP_402: '模型账户余额不足。', MODEL_HTTP_429: '模型接口限流，任务会按配置重试。',
    INVALID_MODEL_JSON: '模型返回格式不符合要求，请调整提示词后重试。', INVALID_EVIDENCE: '模型证据未通过原文校验，报告未发布。',
    INPUT_VERSION_CONFLICT: '答案版本发生冲突，请刷新后核对已提交内容。', INTERVIEW_FROZEN: '该访谈已提交报告，修改答案需要新建一次访谈。',
    PREVIEW_SESSION_REQUIRED: '本地会话已过期，请刷新页面开始新会话。',
  }[code] || `请求未完成：${code}`)
  const snapshot = () => {
    if (state.frozen && state.frozenSnapshot) return state.frozenSnapshot
    const value = {
      interview_id: context.interview_id, question_pack_version: context.pack.questionPackMeta.version, profile: context.pack.profile,
      questions: portal ? context.snapshot_template.questions : context.pack.questions.map(q => ({ id: q.id, text: q.question, required_slots: q.required_slots })),
      ...(portal ? { pack: context.snapshot_template.pack } : {}),
      answers: context.pack.questions.map(q => {
        const a = state.answers[q.id]
        return { question_id: q.id, text: encodeAnswer(a, q), skipped: a.skipped, confirmed: a.confirmed }
      }),
    }
    const fingerprint = JSON.stringify(value)
    if (fingerprint !== state.fingerprint) { state.version++; state.fingerprint = fingerprint }
    return { ...value, input_version: state.version }
  }
  const poll = async () => {
    if (!state.pending || busy) return
    busy = true; error = ''; render()
    try {
      const pending = state.pending
      if (!pending.id) {
        const task = await api('/browser/tasks', pending.body, pending.key)
        pending.id = task.id
        if (pending.kind === 'report') { state.frozen = true; state.frozenSnapshot = pending.body.snapshot }
        persist()
      }
      while (!lifetime.signal.aborted) {
        const task = await api(`/browser/tasks/${encodeURIComponent(pending.id)}`)
        applyTask(task)
        if (!['queued', 'running'].includes(task.status)) {
          state.pending = null
          if (task.status === 'failed') error = errorText(task.error_code)
          if (task.status === 'superseded') message = '答案版本已变化，此次追问结果已作废。'
          if (task.kind === 'report') review = false
          persist(); break
        }
        message = `${task.kind === 'report' ? '正在整理报告' : '正在分析回答'}，第 ${task.attempt || 1} 次尝试…`
        render()
        await new Promise(resolve => setTimeout(resolve, Math.max(100, context.poll_interval_ms)))
      }
    } catch (failure) {
      if (!lifetime.signal.aborted) {
        if (failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
          // 明确拒绝的请求不会入队；网络结果不确定时才保留原请求重试。
          state.pending = null; persist()
          error = errorText(failure.message)
        } else error = `${errorText(failure.message)} 可以重新连接，任务 ID 和幂等键已保留。`
      }
    } finally { busy = false; render() }
  }
  const submit = async (kind, questionId) => {
    if (busy || state.pending) return
    const value = snapshot()
    const body = { kind, snapshot: value, ...(questionId ? { question_id: questionId } : {}) }
    state.pending = { key: crypto.randomUUID(), body, kind, question_id: questionId }
    persist()
    await poll()
  }
  const markChanged = answer => {
    answer.confirmed = false; answer.skipped = false
    delete results[context.pack.questions[state.index].id]
    error = ''; message = ''; persist()
  }
  const reportHtml = task => {
    if (task.status !== 'succeeded') return `<div class="worker-status ${task.status === 'failed' ? 'worker-error' : ''}">报告 v${task.report_version} · ${esc(task.status === 'failed' ? errorText(task.error_code) : task.status)}</div>`
    if (portal && !context.can_view_reports) return '<div class="worker-status">报告已保存，由访谈管理端查看。</div>'
    const output = task.output
    const cites = ids => (ids || []).map(id => `<a href="#evidence-${esc(task.id)}-${esc(id)}">[${esc(id)}]</a>`).join(' ')
    const labels = { fact: '专家事实', interpretation: '分析解释', needs_verification: '待核实' }
    return `<article class="panel report"><div class="kind">报告 v${task.report_version} · 答案版本 ${output.input_version} · ${esc(task.release_version)}</div><h2>${esc(output.report.title)}</h2>${output.report.sections.map(section => `<h3>${esc(section.title)}</h3>${section.statements.map(item => `<p><span class="kind">${esc(labels[item.kind] || item.kind)}</span>${esc(item.text)} ${cites(item.evidence_ids)}</p>`).join('')}`).join('')}${output.report.task_cards.map(card => `<h3>典型任务：${esc(card.title)}</h3>${[['触发条件', card.trigger], ['工作场景', card.context], ['步骤', card.steps.join('\n')], ['关键判断', card.judgments.join('\n')], ['工具', card.tools.join('、')], ['协作', card.collaboration], ['质量依据', card.quality_evidence], ['边界', card.boundaries]].filter(([, value]) => value).map(([label, value]) => `<p><strong>${label}：</strong>${esc(value)}</p>`).join('')}<p>${cites(card.evidence_ids)}</p>`).join('')}${output.report.needs_verification.length ? `<h3>尚待核实</h3><ul>${output.report.needs_verification.map(text => `<li>${esc(text)}</li>`).join('')}</ul>` : ''}<h3>原文证据</h3>${output.evidence.map(item => `<blockquote id="evidence-${esc(task.id)}-${esc(item.id)}"><strong>${esc(item.id)} · ${esc(item.question_id)}</strong><p>${esc(item.quote)}</p></blockquote>`).join('')}</article>`
  }
  function render() {
    const q = context.pack.questions[state.index]
    const answer = state.answers[q.id]
    const locked = busy || !!state.pending || state.frozen
    const result = results[q.id]
    const assessment = result?.status === 'succeeded' ? result.output : null
    const progress = context.pack.questions.filter(item => state.answers[item.id].confirmed).length
    const banner = `<header class="topbar"><div class="topbar-inner"><span class="brand">实践专家访谈</span><span class="saved">${esc(context.model_label)}</span></div></header><main class="main"><div class="worker-toolbar"><span class="kind">${portal ? '访谈会话' : '本地联调'} · ${esc(context.interview_id)}</span><button class="btn" id="reset" ${busy ? 'disabled' : ''}>新建一次访谈</button></div><div class="worker-note">答案在本机暂存；确认后交由模型分析。${state.frozen ? '访谈已冻结，可查看或重新生成报告。' : '生成报告会冻结本次答案；不方便回答时可以跳过。'}</div>`
    const status = `${busy ? `<div class="worker-status" role="status">${esc(message || '正在提交任务…')}</div>` : ''}${error ? `<div class="worker-status worker-error" role="alert">${esc(error)}</div>` : ''}${!busy && state.pending ? '<button class="btn" id="reconnect">重新连接任务</button>' : ''}`
    let content
    if (reportView || state.frozen) {
      content = `<div class="intro"><div><h1>访谈报告</h1><p>报告保留原文证据，事实、解释与待核实事项分别呈现。</p></div><button class="btn" id="regenerate" ${locked && !state.frozen || busy || state.pending ? 'disabled' : ''}>重新生成报告</button></div>${status}${[...reports].reverse().map(reportHtml).join('') || '<div class="panel report">任务已提交，报告正在生成。</div>'}`
    } else if (review) {
      content = `<div class="panel report"><h2>确认本次访谈</h2><p>已确认 ${progress} / ${context.pack.questions.length} 题。生成报告后不能修改本次答案。</p>${context.pack.questions.map((item, i) => `<button class="btn" data-go="${i}" ${locked ? 'disabled' : ''}>${esc(item.title)} · ${state.answers[item.id].confirmed ? '已确认' : '待确认'}</button><div class="review-answer">${esc(state.answers[item.id].skipped ? '专家选择跳过' : encodeAnswer(state.answers[item.id], item) || '尚未填写')}</div>`).join('')}<button class="btn primary" id="report" ${locked || progress !== context.pack.questions.length ? 'disabled' : ''}>确认答案并生成报告</button>${status}</div>`
    } else {
      const followup = assessment?.status === 'followup_ready'
      const hint = assessment?.status === 'complete' ? '当前回答已覆盖关键内容。' : assessment?.status === 'skipped' ? '本题已选择跳过。' : assessment?.status === 'needs_review' ? `已保留当前回答，可继续访谈。${assessment.reason === 'FOLLOWUP_LIMIT' ? '本题追问轮次已用完。' : ''}` : ''
      content = `<div class="intro"><div><h1>请从您熟悉的地方，慢慢讲起。</h1><p>这不是考试，也没有标准答案。已确认 ${progress} / ${context.pack.questions.length} 题。</p></div><button class="btn" id="review" ${locked ? 'disabled' : ''}>回看全部答案</button></div><div class="layout"><aside class="panel outline">${context.pack.questions.map((item, i) => `<button class="step ${i === state.index ? 'active' : ''} ${state.answers[item.id].confirmed ? 'done' : ''}" data-go="${i}" ${locked ? 'disabled' : ''}>${esc(item.title)}${state.answers[item.id].confirmed ? ' ✓' : ''}</button>`).join('')}</aside><section class="panel question-card"><div><div class="stage-row">问题 ${state.index + 1} / ${context.pack.questions.length}</div><div class="bar"><i style="width:${progress / context.pack.questions.length * 100}%"></i></div><div class="question-head"><h2>${esc(q.title)}</h2><p>${esc(q.question)}</p></div><div class="question-body">${q.options?.length ? `<div class="option-list">${q.options.map((option, i) => `<label class="option"><input type="${(q.type === '单项选择' || q.type === '授权确认') ? 'radio' : 'checkbox'}" name="answer-option" data-option="${i}" ${answer.selected === option || answer.options.includes(i) ? 'checked' : ''} ${locked ? 'disabled' : ''}>${esc(option)}</label>`).join('')}</div>` : ''}<label class="label" for="answer">您的回答</label><textarea class="answer" id="answer" maxlength="60000" ${locked ? 'disabled' : ''} placeholder="请按实际经验描述…">${esc(answer.text)}</textarea>${q.helper ? `<div class="helper">${esc(q.helper)}</div>` : ''}${answer.supplements.map((text, i) => `<div class="helper">补充回答 ${i + 1}：${esc(text)}</div>`).join('')}${followup ? `<div class="followup"><h3>可以再补充一点</h3><p>${esc(assessment.text)}</p><label class="label" for="supplement">补充回答（可暂不回答）</label><textarea class="answer" id="supplement" maxlength="30000" ${locked ? 'disabled' : ''}>${esc(answer.supplementDraft || '')}</textarea><div class="actions"><button class="btn primary" id="supplement-submit" ${locked ? 'disabled' : ''}>提交补充并再判断</button><button class="btn" id="continue" ${locked ? 'disabled' : ''}>暂不补充，继续</button></div></div>` : hint ? `<div class="worker-status">${esc(hint)}</div>` : ''}${status}</div></div><div class="controls"><div class="voice-row"><button class="voice" id="voice" ${locked ? 'disabled' : ''}>开启语音转写</button><span id="voice-status" aria-live="polite"></span><button class="btn" id="save-draft">暂存回答</button></div><div class="action-row"><button class="btn" id="previous" ${locked || state.index === 0 ? 'disabled' : ''}>上一题</button><div class="actions"><button class="btn" id="skip" ${locked ? 'disabled' : ''}>本题不便回答</button>${!followup ? `<button class="btn primary" id="confirm" ${locked ? 'disabled' : ''}>${assessment && answer.confirmed ? '继续下一步' : '确认回答并分析'}</button>` : ''}</div></div></div></section><aside class="tips"><div class="panel tip"><h3>本次访谈</h3><p>${esc(context.pack.profile.name)} · ${esc(context.pack.profile.role)}</p></div><div class="panel tip"><h3>回答由您决定</h3><p>追问不是必答题。您可以保留已有回答，跳过不便透露的内容。</p></div></aside></div>`
    }
    app.innerHTML = `${banner}${content}</main><footer class="footer"><div class="footer-inner">实践专家访谈 · ${portal ? '访谈服务' : '本地验证'}</div></footer>`
    const bind = (id, handler) => { const element = document.getElementById(id); if (element) element.onclick = handler }
    const next = () => { recognition?.stop(); if (state.index < context.pack.questions.length - 1) state.index++; else review = true; message = ''; error = ''; persist(); render() }
    document.querySelectorAll('[data-go]').forEach(button => { button.onclick = () => { recognition?.stop(); state.index = Number(button.dataset.go); review = false; persist(); render() } })
    const textarea = document.getElementById('answer')
    if (textarea) textarea.oninput = () => {
      const start = textarea.selectionStart; const end = textarea.selectionEnd
      answer.text = textarea.value; markChanged(answer); render()
      const current = document.getElementById('answer')
      current.focus({ preventScroll: true }); current.setSelectionRange(start, end)
    }
    document.querySelectorAll('[data-option]').forEach(input => { input.onchange = () => {
      if ((q.type === '单项选择' || q.type === '授权确认')) answer.selected = q.options[Number(input.dataset.option)]
      else answer.options = [...document.querySelectorAll('[data-option]:checked')].map(item => Number(item.dataset.option))
      markChanged(answer); render()
    } })
    const supplement = document.getElementById('supplement')
    if (supplement) supplement.oninput = () => { answer.supplementDraft = supplement.value; persist() }
    bind('save-draft', () => { persist(); message = '回答已在本机暂存，确认后保存到服务端。'; render() })
    bind('voice', () => {
      const questionId = q.id
      if (recognition) { recognition.stop(); return }
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
      const status = document.getElementById('voice-status')
      if (!Recognition) { status.textContent = '当前浏览器不支持语音识别'; return }
      const target = document.getElementById('supplement') || document.getElementById('answer')
      const previous = target.value
      recognition = new Recognition(); recognition.lang = 'zh-CN'; recognition.interimResults = true
      recognition.onstart = () => { status.textContent = '正在听，请自然表达…' }
      recognition.onresult = event => {
        if (busy || state.pending || state.frozen || review || reportView || context.pack.questions[state.index].id !== questionId) { recognition?.stop(); return }
        let text = ''; for (const result of event.results) text += result[0].transcript
        const current = document.getElementById(target.id)
        if (current) { current.value = previous + text; current.dispatchEvent(new Event('input', { bubbles: true })) }
      }
      recognition.onerror = () => { const current = document.getElementById('voice-status'); if (current) current.textContent = '语音识别暂时不可用' }
      recognition.onend = () => { recognition = null; const current = document.getElementById('voice-status'); if (current) current.textContent = '语音已填入，可继续修改' }
      recognition.start()
    })
    bind('confirm', async () => {
      if (assessment && answer.confirmed) { next(); return }
      if (!encodeAnswer(answer, q).trim()) { error = '请填写回答，或选择“本题不便回答”。'; render(); return }
      answer.confirmed = true; answer.skipped = false
      await submit('followup', q.id)
    })
    bind('skip', async () => { answer.skipped = true; answer.confirmed = true; await submit('followup', q.id) })
    bind('supplement-submit', async () => {
      if (!answer.supplementDraft?.trim()) { error = '请填写补充内容，或选择“暂不补充，继续”。'; render(); return }
      answer.supplements.push(answer.supplementDraft.trim()); answer.supplementDraft = ''; answer.confirmed = true
      await submit('followup', q.id)
    })
    bind('continue', next)
    bind('previous', () => { recognition?.stop(); state.index--; persist(); render() })
    bind('review', () => { recognition?.stop(); review = true; render() })
    bind('report', () => submit('report'))
    bind('regenerate', () => submit('report'))
    bind('reconnect', poll)
    bind('reset', async () => {
      if (!window.confirm('新建一次访谈？本次已生成的报告仍保存在数据库中。')) return
      try { context = await api('/browser/session/reset', {}); review = false; reportView = false; error = ''; message = ''; restore(); render() }
      catch (failure) { error = errorText(failure.message); render() }
    })
  }
  render()
  if (state.pending) await poll()
}
