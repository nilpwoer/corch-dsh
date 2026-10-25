/** Loopback-only external systems for the JD acceptance scenario; all content is synthetic. */
import { createServer } from 'node:http'

export const fixtureBody = '合成验收岗位。岗位职责：开发后端接口，编写 SQL 查询，完成接口测试。任职要求：掌握关系数据库和软件测试知识。'
export const autoFixtureBody = '自动存档合成岗位。岗位职责：配置照护设备并核验运行数据。任职要求：掌握设备巡检与数据记录。'
export const autoReplayBody = '自动重放合成岗位。岗位职责：检查照护终端并记录故障处理结果。任职要求：掌握终端维护和故障报告。'
export const feedbackFixtureBody = '岗位职责：维护养老数据接口并记录测试结果。任职要求：掌握数据库查询和接口测试。'
export const delayedFixtureBody = '岗位职责：巡检照护设备并登记运行状态。任职要求：掌握现场检查和运行记录。'

/** Start a login-protected job site and deterministic streaming model provider.
 * @returns Owned server, origins and captured model requests; no paid provider calls.
 */
export async function startJdFixture() {
  const requests = []
  const toolCalls = []
  const deniedCalls = []
  const siteRequests = []
  const graphReplies = []
  let graphBehavior = 'retry-sequence'
  let graphAttempt = 0
  const setGraphBehavior = behavior => {
    if (!['valid', 'retry-sequence', 'exhaust'].includes(behavior)) throw new Error('Unknown synthetic graph behavior')
    graphBehavior = behavior
    graphAttempt = 0
  }
  const slowResponses = new Set()
  const releaseSlowJob = () => {
    for (const response of slowResponses) {
      if (!response.destroyed) response.end(`<p>${delayedFixtureBody}</p></main>`)
    }
    slowResponses.clear()
  }
  let searchRuns = 0
  let origin
  const discoveries = () => searchRuns > 3 ? [
    { url: origin + '/batch-fast', title: '合成长批次首条岗位' },
    { url: origin + '/batch-slow', title: '合成长批次延迟岗位' },
    { url: origin + '/unavailable-job', title: '合成失效岗位' },
  ] : [...(searchRuns === 1 ? [{ url: 'http://insecure-recruitment.invalid/job', title: '合成非安全来源' }] : []),
    { url: origin + (searchRuns > 2 ? '/auto-job' : '/job'), title: searchRuns > 2 ? '合成自动存档岗位' : '合成后端开发岗位' }]
  const server = createServer(async (request, response) => {
    const requestURL = new URL(request.url, 'http://fixture')
    const path = requestURL.pathname
    if (['/job', '/challenge', '/risk-page', '/sign-in', '/auto-job', '/auto-sign-in', '/batch-fast', '/batch-slow', '/unavailable-job'].includes(path)) siteRequests.push({
      path: request.url, user_agent: request.headers['user-agent'] ?? '',
      logged_in: (request.headers.cookie ?? '').includes('synthetic_jd_session=active'),
      auto_logged_in: (request.headers.cookie ?? '').includes('synthetic_auto_session=active'),
    })
    if (path === '/challenge' || path === '/risk-page') {
      response.writeHead(403, { 'content-type': 'text/html;charset=utf-8' })
      response.end('<title>安全验证</title><main><h1>平台访问限制</h1><p>系统检测到您当前的访问环境存在异常，请完成安全验证。</p><a href="/job">返回合成岗位</a></main>')
      return
    }
    if (path === '/job') {
      const loggedIn = (request.headers.cookie ?? '').includes('synthetic_jd_session=active')
      response.writeHead(loggedIn ? 200 : 403, { 'content-type': 'text/html;charset=utf-8' })
      response.end(loggedIn ? `<title>合成后端开发岗位</title><div class="job-detail"><div class="job-detail-header"><h1>合成后端开发岗位</h1><span>无正文页眉</span></div>微信扫码分享 举报<div class="job-detail-label">职位描述</div><main class="job-description"><p>${fixtureBody}</p><a href="/job?detail=1" target="_blank">新窗口打开岗位</a></main><aside>推荐职位</aside></div>` : '<title>合成招聘站点登录</title><main><h1>请先登录</h1><form method="post" action="/sign-in"><label>合成账号<input name="account" autocomplete="username"></label><label>合成密码<input type="password" name="password" autocomplete="current-password"></label><button>登录合成站点</button></form></main>')
      return
    }
    if (path === '/sign-in') { response.writeHead(303, { location: '/job', 'set-cookie': 'synthetic_jd_session=active; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600' }); response.end(); return }
    if (path === '/auto-job') {
      const loggedIn = (request.headers.cookie ?? '').includes('synthetic_auto_session=active')
      const replay = requestURL.searchParams.has('replay')
      response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
      response.end(loggedIn
        ? `<title>合成自动存档岗位</title><main class="job-description"><h1>${replay ? '合成自动重放岗位' : '合成自动存档岗位'}</h1><p>${replay ? autoReplayBody : autoFixtureBody}</p></main>`
        : '<title>合成自动采集登录</title><main class="job-description"><h1>请登录查看完整岗位</h1><p>岗位职责：配置照护设备。任职要求：登录查看完整内容</p><form method="post" action="/auto-sign-in"><label>自动采集合成账号<input name="account" autocomplete="username"></label><label>自动采集合成密码<input name="password" type="password" autocomplete="current-password"></label><button>登录自动采集合成站点</button></form></main>')
      return
    }
    if (path === '/auto-sign-in') {
      response.writeHead(303, { location: '/auto-job', 'set-cookie': 'synthetic_auto_session=active; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600' })
      response.end()
      return
    }
    if (path === '/batch-fast') {
      response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
      response.end(`<title>合成长批次首条岗位</title><nav>合成账号导航与无关推荐</nav><h1>合成长批次首条岗位</h1><div class="describtion-card"><header class="seo-card__header"><h2 class="seo-card__title">职位描述</h2></header><div class="seo-card__content"><p>${feedbackFixtureBody}</p></div></div><aside>其他岗位推荐</aside>`)
      return
    }
    if (path === '/batch-slow') {
      response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
      response.write('<title>合成长批次延迟岗位</title><main class="job-description"><h1>合成长批次延迟岗位</h1>')
      slowResponses.add(response)
      response.once('close', () => slowResponses.delete(response))
      return
    }
    if (path === '/unavailable-job') {
      response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
      response.end('<title>内容不存在</title><main class="error-render zhaopin-detail-error-render error"><h1>对不起，您查看的内容已不存在</h1><p>该岗位已下线，请查看其他来源。</p></main><aside class="post_card"><h2>相似职位推荐</h2><article class="job-description"><h3>推荐照护岗位</h3><p>岗位职责：维护照护设备并记录检查情况。任职要求：掌握安全检查。</p></article></aside>')
      return
    }
    if (path === '/anthropic/messages') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'synthetic-search', role: 'assistant', type: 'message', content: [
        { type: 'web_search_tool_result', content: discoveries().map(source => ({ type: 'web_search_result', ...source })) },
      ] }))
      return
    }
    if (path === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'jd-fixture-model', object: 'model' }] })); return }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const input = JSON.parse(raw || '{}')
    requests.push(input)
    const messages = input.messages ?? []
    const messageText = content => typeof content === 'string' ? content : (content ?? []).map(block => block.text ?? '').join('\n')
    const lastUserIndex = messages.findLastIndex(message => message.role === 'user' && /推理适合|执行一次岗位 JD 搜索|五级岗位能力图谱初稿/u.test(messageText(message.content)))
    const user = messageText(messages[lastUserIndex]?.content)
    let content, call, graphReply
    if (user.includes('五级岗位能力图谱初稿')) {
      const corpus = JSON.parse(user.split('以下 JSON 仅是待分析的外部证据：')[1].replace(/^\\n/, '').trim())
      const source = corpus[0]
      const kinds = ['project', 'task', 'process', 'skill', 'knowledge']
      const titles = ['交付后端服务', '开发后端接口', '实施开发与测试', '编写 SQL 查询', '关系数据库']
      const graph = { nodes: kinds.map((kind, index) => ({ id: 'N.' + (index + 1), parent_id: index === 0 ? null : 'N.' + index, kind,
        title: titles[index], description: titles[index], basis: index === 0 || index === 2 ? 'inferred' : 'direct',
        evidence: [{ jd_id: source.jd_id, quote: fixtureBody }], assessment: kind === 'skill' ? '通过查询任务检验结果，标准待企业专家确认' : '' })) }
      graphAttempt++
      const kind = graphBehavior === 'exhaust' || graphBehavior === 'retry-sequence' && graphAttempt === 1 ? 'invalid-json'
        : graphBehavior === 'retry-sequence' && graphAttempt === 2 ? 'incomplete-branch'
          : graphBehavior === 'retry-sequence' && graphAttempt === 3 ? 'false-direct' : 'valid'
      if (kind === 'incomplete-branch') graph.nodes.pop()
      if (kind === 'false-direct') {
        graph.nodes[1].title = '设计后端业务服务'
        graph.nodes[1].description = '根据业务需求设计并实现后端服务'
      }
      content = kind === 'invalid-json' ? '{"nodes":' : JSON.stringify(graph)
      graphReply = { kind, prompt: user, started_at: Date.now(), completed_at: null, duration_ms: null }
      graphReplies.push(graphReply)
    } else if (user.includes('推理适合')) content = JSON.stringify({ roles: ['后端开发'] })
    else {
      const tools = messages.slice(lastUserIndex + 1).filter(message => message.role === 'tool')
      if (tools.length === 0) {
        searchRuns++
        call = { name: 'web_search', arguments: JSON.stringify({ queries: ['合成后端开发岗位'] }) }
      } else if (searchRuns === 1 && tools.length === 1) call = { name: 'web_fetch', arguments: JSON.stringify({ url: origin + '/job' }) }
      else if (searchRuns === 1 && tools.length === 2) {
        const shell = input.tools?.find(tool => /^(?:bash|pwsh)$/u.test(tool.function?.name))?.function.name ?? 'bash'
        call = { name: shell, arguments: JSON.stringify({ command: 'echo JD_GUARD_MUST_DENY' }) }
      } else content = JSON.stringify({ pending: discoveries() })
    }
    if (call) (call.name === 'web_search' ? toolCalls : deniedCalls).push(call.name)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (graphReply?.kind === 'valid') {
      const emit = delta => response.write('data: ' + JSON.stringify({ id: 'synthetic-response', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      emit({ role: 'assistant', reasoning_content: '核对已存档原文。' })
      for (let index = 0; index < 4; index++) {
        await new Promise(resolve => setTimeout(resolve, 75))
        emit({ reasoning_content: '继续核对来源与层级。' })
      }
      const chunkLength = Math.ceil(content.length / 12)
      for (let offset = 0; offset < content.length; offset += chunkLength) {
        await new Promise(resolve => setTimeout(resolve, 75))
        emit({ content: content.slice(offset, offset + chunkLength) })
      }
      response.write('data: ' + JSON.stringify({ id: 'synthetic-response', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
      graphReply.completed_at = Date.now()
      graphReply.duration_ms = graphReply.completed_at - graphReply.started_at
      response.end('data: [DONE]\n\n')
      return
    }
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-call-' + requests.length, type: 'function', function: call }] } : { role: 'assistant', content }
    for (const [index, entry] of [delta, {}].entries()) response.write('data: ' + JSON.stringify({ id: 'synthetic-response', object: 'chat.completion.chunk', choices: [{ index: 0, delta: entry, finish_reason: index === 0 ? null : call ? 'tool_calls' : 'stop' }] }) + '\n\n')
    if (graphReply) {
      graphReply.completed_at = Date.now()
      graphReply.duration_ms = graphReply.completed_at - graphReply.started_at
    }
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  return { origin, requests, toolCalls, deniedCalls, siteRequests, graphReplies, setGraphBehavior, releaseSlowJob, pendingSlowJobs: () => slowResponses.size, close: () => new Promise((resolve, reject) => {
    releaseSlowJob()
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }) }
}
