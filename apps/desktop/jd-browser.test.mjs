import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJdBrowser, monitorJdSecurity, readJdPage } from './jd-browser.mjs'

function renderedDOM(html, url, options = {}) {
  const dom = new JSDOM(html, { url, ...options })
  // JSDOM has no layout or innerText; expose rendered fixture text and rectangle visibility.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent } })
  dom.window.HTMLElement.prototype.getClientRects = function () {
    for (let element = this; element; element = element.parentElement) if (dom.window.getComputedStyle(element).display === 'none') return []
    return [{}]
  }
  return dom
}

function read(html, url = 'https://www.zhipin.com/web/geek/jobs?_security_check=private') {
  const dom = renderedDOM(html, url)
  try { return readJdPage(dom.window.document) }
  finally { dom.window.close() }
}

const detail = '<div class="job-detail"><h1>后端开发工程师</h1>\n职位描述\n任职要求：掌握 SQL 与接口开发。</div>'
const link = '<a href="/job_detail/job-1.html?tracking=private#share">后端开发工程师</a>'

test('BOSS list capture identifies the displayed role and its unique detail link', () => {
  const result = read('<title>成都招聘列表</title>' + link + detail)
  assert.equal(result.title, '后端开发工程师')
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/job-1.html')
  assert.equal(result.body, '后端开发工程师\n职位描述\n任职要求：掌握 SQL 与接口开发。')
})

test('hidden and incidental detail class matches cannot hide the actual duties', () => {
  const result = read('<div class="job-detail-empty"></div><div class="job-detail-heading">职位描述</div><div class="job-detail" style="display:none">错误岗位\n岗位职责：隐藏内容</div>' + link + detail)
  assert.equal(result.title, '后端开发工程师')
  assert.ok(result.body.includes('掌握 SQL 与接口开发'))
  assert.ok(!result.body.includes('隐藏内容'))
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/job-1.html')
})

test('a direct detail page reads the duties section after an incidental header', () => {
  const result = read('<title>招聘站点</title><div class="job-detail-header"><h1>.net开发工程师</h1>成都</div><div class="job-detail-label">职位描述</div><div class="job-sec-text">任职要求：开发 .NET 后端接口。</div>', 'https://www.zhipin.com/job_detail/job-2.html?_security_check=private#share')
  assert.equal(result.title, '.net开发工程师')
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/job-2.html')
  assert.equal(result.body, '任职要求：开发 .NET 后端接口。')
})

test('BOSS standalone title and duties exclude sharing controls and recommendations', () => {
  const html = '<title>列表式页面标题</title><h1>.net开发工程师</h1><div class="job-detail">微信扫码分享 举报\n<div class="job-description">职位描述\n<div class="job-sec-text">岗位职责：开发 C# 接口。\n任职要求：熟悉 ASP.NET 和 SQL。</div></div><aside>推荐职位\n其他公司工程师</aside></div>'
  const result = read(html, 'https://www.zhipin.com/job_detail/job-2.html')
  assert.equal(result.title, '.net开发工程师')
  assert.equal(result.body, '职位描述\n岗位职责：开发 C# 接口。\n任职要求：熟悉 ASP.NET 和 SQL。')
  assert.ok(!result.body.includes('微信扫码分享'))
  assert.ok(!result.body.includes('推荐职位'))
})

test('separate visible duties and requirements sections remain together in original order', () => {
  const result = read('<h1>.net开发工程师</h1><div class="job-detail">分享\n<div class="job-sec-text">岗位职责：开发接口。</div><div class="job-sec-text">任职要求：掌握 SQL。</div><aside>推荐职位</aside></div>', 'https://www.zhipin.com/job_detail/job-2.html')
  assert.equal(result.body, '岗位职责：开发接口。\n\n任职要求：掌握 SQL。')
})

test('a visible description outside the selected detail cannot merge another job into its original', () => {
  const unrelated = '<aside class="job-description">岗位职责：其他企业销售产品。任职要求：销售经验。</aside>'
  const result = read(unrelated + '<h1>.net开发工程师</h1><div class="job-detail"><div class="job-sec-text">岗位职责：开发接口。</div><div class="job-sec-text">任职要求：掌握 SQL。</div></div>' + unrelated, 'https://www.zhipin.com/job_detail/job-2.html')
  assert.equal(result.title, '.net开发工程师')
  assert.equal(result.body, '岗位职责：开发接口。\n\n任职要求：掌握 SQL。')
  assert.ok(!result.body.includes('其他企业'))
})

test('missing, unrelated, cross-origin and ambiguous detail links cannot become list sources', () => {
  for (const links of ['', '<a href="/job_detail/job-1.html">其他岗位</a>', '<a href="https://other.test/job_detail/job-1.html">后端开发工程师</a>', '<a href="https://user:password@www.zhipin.com/job_detail/job-1.html">后端开发工程师</a>', '<a href="http://[invalid">后端开发工程师</a>', link + '<a href="/job_detail/job-2.html">后端开发工程师</a>']) {
    assert.equal(read(links + detail).url, null)
  }
  assert.equal(read(link + link + detail).url, 'https://www.zhipin.com/job_detail/job-1.html')
})

test('body-first titles in list detail panes match their exact source anchors', () => {
  const result = read(link + '<div class="job-detail">后端开发工程师\n成都\n职位描述\n岗位职责：开发接口。</div>')
  assert.equal(result.title, '后端开发工程师')
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/job-1.html')
})

test('ordinary pages preserve the original source and visible login fields', () => {
  const result = read('<main><h1>合成后端开发岗位</h1><p>岗位职责：开发接口。</p><input type="password"><input autocomplete="one-time-code" style="display:none"></main>', 'http://127.0.0.1:4321/job?detail=1')
  assert.equal(result.url, 'http://127.0.0.1:4321/job?detail=1')
  assert.equal(result.title, '合成后端开发岗位')
  assert.equal(result.login, true)
})

test('phone-only and passport login pages pause collection without misclassifying a visible JD', () => {
  assert.equal(read('<main>短信登录<input type="tel"></main>', 'https://passport.zhaopin.com/login').login, true)
  assert.equal(read('<main>扫码登录<input type="tel"></main>', 'https://www.zhipin.com/web/user/').login, true)
  assert.equal(read('<aside>扫码登录</aside>' + detail, firstSource).login, false)
})

const zhaopinDetail = '<h1>Go开发工程师</h1><div class="describtion-card seo-card"><div class="seo-card__header"><h2 class="seo-card__title">职位描述</h2></div><div class="seo-card__content"><p>岗位职责：开发和维护 Go 后端接口。</p><p>任职要求：熟悉 SQL、Gin 与并发编程。</p></div></div>'

test('Zhaopin reads the observed description card without account navigation or recommended jobs', () => {
  const html = '<nav>已登录账号 张同学 首页 简历管理</nav>' + zhaopinDetail + '<aside class="job-description">推荐岗位\n岗位职责：推广保险。任职要求：销售经验。</aside>'
  const page = read(html, 'https://www.zhaopin.com/jobdetail/example.htm')
  assert.equal(page.title, 'Go开发工程师')
  assert.match(page.body, /岗位职责：开发和维护 Go 后端接口/u)
  assert.match(page.body, /任职要求：熟悉 SQL/u)
  assert.doesNotMatch(page.body, /张同学|简历管理|推荐岗位|推广保险/u)
  assert.equal(page.login, false)
  assert.equal(read('<nav>账号姓名</nav><main><h2>推荐岗位</h2>岗位职责：推广保险。</main>', 'https://www.zhaopin.com/jobdetail/unknown.htm').body, '')
})

const expiredPage = '<title>软件开发工程师</title><div class="error-render zhaopin-detail-error-render error"><img class="error-render-prompt-image" alt=""><p>对不起，您查看的内容已不存在</p></div><a>登录</a><section class="post_card job-description"><h2>类似职位</h2>岗位职责：开发后端接口。任职要求：掌握数据库。</section>'

test('an unavailable source cannot turn recommendations or a login control into the requested JD', () => {
  const page = read(expiredPage + '<input type="password">', 'https://m.58.com/cd/tech/64308757563398x.shtml')
  assert.equal(page.body, '')
  assert.equal(page.login, false)
  assert.match(page.unavailable_reason, /已失效或内容不存在/u)
})

function browserFixture(result, options = {}) {
  const windows = []
  const navigations = []
  const requests = {}
  const browserSession = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    webRequest: { onBeforeRequest(handler) { requests.before = handler }, onHeadersReceived(handler) { requests.headers = handler } },
  })
  class Window extends EventEmitter {
    constructor(windowOptions = {}) {
      super()
      this.options = windowOptions
      this.contents = Object.assign(new EventEmitter(), {
        id: windows.length + 1, session: browserSession,
        setWindowOpenHandler(handler) { this.windowOpenHandler = handler }, isLoadingMainFrame: () => this.loading === true,
        getURL: () => this.url || 'https://www.zhipin.com/job_detail/job-1.html', executeJavaScript: async script => {
          if (options.executeJavaScript) return options.executeJavaScript(script, this)
          const value = await (typeof result === 'function' ? result(this.url) : result)
          return script.includes('monitorJdSecurity') ? value.blocked : value
        },
        stop: () => { this.stopped = true },
      })
      Object.defineProperty(this, 'webContents', { get() {
        if (this.destroyed && options.throwAfterDestroy) throw new Error('Object has been destroyed')
        return this.contents
      } })
      windows.push(this)
    }
    setMenu() {}
    setTitle() {}
    getSize() { return [1376, 899] }
    getContentSize() { return [1360, 860] }
    getMinimumSize() { return this.minimumSize || [0, 0] }
    setMinimumSize(width, height) { this.minimumSize = [width, height] }
    async loadURL(url) {
      const verdict = await new Promise(resolve => requests.before({ webContentsId: this.webContents.id, resourceType: 'mainFrame', url }, resolve))
      if (verdict.cancel) throw new Error('Navigation cancelled')
      this.url = url
      navigations.push({ url, time: Date.now() })
      options.onLoad?.(this, url)
    }
    isDestroyed() { return this.destroyed === true }
    show() {}
    restore() {}
    focus() { this.emit('focus') }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  return { browser: createJdBrowser({ BrowserWindow: Window, maxCaptureChars: 250000, loadTimeoutMs: 10000, ...options }), windows, navigations, requests }
}

test('BOSS security challenges return a blocked result without saving challenge text or retrying', async () => {
  for (const page of [
    '<title>BOSS直聘</title><main>系统检测到您当前的访问环境存在异常，请完成安全验证</main>',
    '<title>安全验证</title><main>请拖动滑块完成验证</main>',
    '<title>BOSS直聘</title><main>您好，您的IP存在异常访问行为，请解除限制后访问</main>',
    '<main>系统检测到您访问过于频繁，请稍后重试</main>' + detail,
  ]) {
    const { browser, windows } = browserFixture(read(page))
    await browser.open({ id: 'project-1', url: 'https://www.zhipin.com/job_detail/job-1.html' })
    const result = await browser.read({ id: 'project-1' })
    assert.equal(result.state, 'blocked')
    assert.match(result.message, /停止重复采集/u)
    assert.equal(Object.hasOwn(result, 'body'), false)
    assert.equal(windows.length, 1)
    browser.dispose()
  }
  assert.equal(read('<main>请按提示完成操作</main>', 'https://www.zhipin.com/web/common/security-check.html').blocked, true)
  assert.equal(read('<main>岗位职责：建设安全验证系统。任职要求：熟悉 SQL。</main>').blocked, false)
})

test('capture status follows normal close and popup lifetime after the workbench reloads', async () => {
  const { browser, windows } = browserFixture(read(detail, 'https://www.zhipin.com/job_detail/job-1.html'))
  assert.deepEqual(browser.status({ id: 'project-1' }), { state: 'closed' })
  await browser.open({ id: 'project-1', url: 'https://www.zhipin.com/job_detail/job-1.html' })
  assert.deepEqual(browser.status({ id: 'project-1' }), { state: 'opened' })
  const popupOptions = windows[0].webContents.windowOpenHandler({ url: 'https://www.zhipin.com/job_detail/job-2.html' })
  assert.equal(popupOptions.action, 'allow')
  assert.equal(popupOptions.outlivesOpener, true, 'Electron must keep the detail window after its list opener closes')
  assert.equal(windows[0].options.width, 1360)
  assert.equal(windows[0].options.useContentSize, true)
  assert.equal(windows[0].getMinimumSize()[0] - 16, 1280)
  assert.equal(popupOptions.overrideBrowserWindowOptions.width, 1360)
  assert.equal(popupOptions.overrideBrowserWindowOptions.useContentSize, true)
  assert.equal(popupOptions.overrideBrowserWindowOptions.webPreferences.session, windows[0].webContents.session)
  const popup = new windows[0].constructor(popupOptions.overrideBrowserWindowOptions)
  windows[0].webContents.emit('did-create-window', popup)
  assert.equal(popup.getMinimumSize()[0] - 16, 1280)
  windows[0].destroy()
  assert.deepEqual(browser.status({ id: 'project-1' }), { state: 'opened' })
  assert.equal((await browser.read({ id: 'project-1' })).state, 'captured')
  windows[1].destroy()
  assert.deepEqual(browser.status({ id: 'project-1' }), { state: 'closed' })
  await assert.rejects(browser.read({ id: 'project-1' }), /窗口已关闭/u)
  await browser.open({ id: 'project-1', url: 'https://www.zhipin.com/job_detail/job-1.html' })
  assert.equal(windows.length, 3)
  assert.deepEqual(browser.status({ id: 'project-1' }), { state: 'opened' })
  browser.close({ id: 'project-1' })
  assert.deepEqual(browser.status({ id: 'project-1' }), { state: 'closed' })
  browser.dispose()
})

function durableFixture(t, result, options = {}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'jd-browser-test-'))
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }))
  writeFileSync(join(dataDirectory, 'jd-collection-settings.json'), JSON.stringify({ min_interval_ms: 100, cache_ttl_ms: 86400000, max_navigations_per_hour: 6, max_sources_per_batch: 20, render_settle_ms: 100 }))
  const fixture = browserFixture(result, { dataDirectory, ...options })
  t.after(() => fixture.browser.dispose())
  return { ...fixture, dataDirectory }
}
const firstSource = 'https://www.zhipin.com/job_detail/job-1.html'
const secondSource = 'https://www.zhipin.com/job_detail/job-2.html'

test('browser-rendered collection reuses one platform window and durable cache across projects and restarts', async t => {
  const fixture = durableFixture(t, url => read(detail, url))
  const first = await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }, { url: secondSource }] })
  assert.deepEqual(first.items.map(item => item.state), ['captured', 'captured'])
  assert.equal(fixture.windows.length, 1)
  assert.ok(fixture.navigations[1].time - fixture.navigations[0].time >= 90)
  const cached = await fixture.browser.collect({ id: 'project-2', sources: [{ url: firstSource }] })
  assert.equal(cached.items[0].cached, true)
  assert.equal(fixture.navigations.length, 2)
  fixture.browser.dispose()
  const restarted = browserFixture(() => { throw new Error('cache must avoid DOM and navigation') }, { dataDirectory: fixture.dataDirectory })
  t.after(() => restarted.browser.dispose())
  const afterRestart = await restarted.browser.collect({ id: 'project-3', sources: [{ url: firstSource }] })
  assert.equal(afterRestart.items[0].cached, true)
  assert.equal(restarted.windows.length, 0)
})

test('security page blocks queued URLs, background requests, redirects and popups until explicit verified JD resume', async t => {
  let challenge = true
  const fixture = durableFixture(t, url => read(challenge ? '<title>安全验证</title><main>请完成安全验证</main>' : detail, url))
  const result = await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }, { url: secondSource }] })
  assert.deepEqual(result.items.map(item => item.state), ['blocked', 'blocked'])
  assert.equal(fixture.navigations.length, 1)
  const contents = fixture.windows[0].webContents
  const request = details => new Promise(resolve => fixture.requests.before({ webContentsId: contents.id, resourceType: 'xhr', url: firstSource, ...details }, resolve))
  assert.equal((await request({})).cancel, true)
  assert.equal((await request({ url: 'https://third-party.example/pixel' })).cancel, true)
  assert.equal((await request({ webContentsId: -1 })).cancel, true)
  assert.equal(contents.windowOpenHandler({ url: secondSource }).action, 'deny')
  let prevented = false
  contents.emit('will-redirect', { preventDefault() { prevented = true } }, secondSource)
  assert.equal(prevented, true)
  await fixture.browser.open({ id: 'project-2', url: secondSource })
  assert.equal(fixture.navigations.length, 1)
  assert.equal((await fixture.browser.resume({ id: 'project-1' })).item.state, 'failed')
  assert.equal((await fixture.browser.verify({ id: 'project-1', url: firstSource })).state, 'opened')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await request({})).cancel, false)
  assert.equal((await fixture.browser.resume({ id: 'project-1', url: firstSource })).item.state, 'blocked')
  assert.equal((await request({})).cancel, true)
  challenge = false
  await fixture.browser.verify({ id: 'project-1', url: firstSource })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await fixture.browser.resume({ id: 'project-1', url: firstSource })).item.state, 'captured')
  assert.equal(fixture.browser.platforms()[0].blocked, false)
  assert.equal((await request({})).cancel, false)
})

test('HTTP 429 stops network immediately and persists the block while HTTP 403 alone is inconclusive', async t => {
  const fixture = durableFixture(t, url => read(detail, url))
  await fixture.browser.open({ id: 'project-1', url: firstSource })
  const headers = code => new Promise(resolve => fixture.requests.headers({ webContentsId: fixture.windows[0].webContents.id, statusCode: code }, resolve))
  assert.equal((await headers(403)).cancel, false)
  assert.equal(fixture.browser.platforms()[0].blocked, false)
  assert.equal((await headers(429)).cancel, true)
  assert.equal(fixture.windows[0].stopped, true)
  const restarted = browserFixture(read(detail, firstSource), { dataDirectory: fixture.dataDirectory })
  t.after(() => restarted.browser.dispose())
  const result = await restarted.browser.collect({ id: 'project-2', sources: [{ url: secondSource }] })
  assert.equal(result.items[0].state, 'blocked')
  assert.equal(restarted.windows.length, 0)
})

test('login-required platform pauses other candidates and reuses the same persistent browser after manual login', async t => {
  let loggedIn = false
  const fixture = durableFixture(t, url => read(loggedIn ? detail : '<main>请先登录<input type="password"></main>', url))
  const batch = await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }, { url: secondSource }] })
  assert.deepEqual(batch.items.map(item => item.state), ['login_required', 'login_required'])
  assert.equal(fixture.navigations.length, 1)
  loggedIn = true
  assert.equal((await fixture.browser.read({ id: 'project-1', url: firstSource })).state, 'captured')
  assert.equal(fixture.browser.platforms()[0].login_required, false)
  assert.equal((await fixture.browser.collect({ id: 'project-2', sources: [{ url: secondSource }] })).items[0].state, 'captured')
  assert.equal(fixture.windows.length, 1)
  assert.equal((await fixture.browser.read({ id: 'project-1' })).state, 'failed')
  assert.equal(fixture.browser.status({ id: 'project-1' }).state, 'closed')
  fixture.browser.close({ id: 'project-1' })
  assert.equal(fixture.browser.status({ id: 'project-2' }).state, 'opened')
})

test('batch limits retain an explicit pending outcome for every excess source', async t => {
  const fixture = durableFixture(t, url => read(detail, url))
  const sources = Array.from({ length: 21 }, () => ({ url: firstSource, title: '后端岗位' }))
  const batch = await fixture.browser.collect({ id: 'project-1', sources })
  assert.equal(batch.items.length, sources.length)
  assert.equal(batch.items[20].state, 'failed')
  assert.match(batch.items[20].message, /保留待采集/u)
  assert.equal(fixture.navigations.length, 1)
})

test('a challenge appearing after initial capture stops background traffic without another read action', async t => {
  let challenge = false
  const fixture = durableFixture(t, url => read(challenge ? '<main>Cookies support required</main>' : detail, url))
  await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }] })
  challenge = true
  fixture.windows[0].webContents.emit('dom-ready')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.browser.platforms()[0].blocked, true)
  assert.equal(fixture.windows[0].stopped, true)
})

test('redirect and popup main-frame requests consume the same platform interval and budget', async t => {
  const fixture = durableFixture(t, url => read(detail, url))
  await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }] })
  const started = Date.now()
  const request = () => new Promise(resolve => fixture.requests.before({ webContentsId: fixture.windows[0].webContents.id, resourceType: 'mainFrame', url: secondSource }, resolve))
  const first = await request()
  const afterFirst = Date.now()
  assert.equal(first.cancel, false)
  const second = await request()
  assert.equal(second.cancel, false)
  assert.ok(Date.now() - afterFirst >= 90)
  assert.ok(Date.now() >= started)
})

test('collection waits for a page-owned reload and late-rendered duties without navigating again', async t => {
  let rendered = false
  const fixture = durableFixture(t, url => read(rendered ? detail : '<main>正在加载岗位</main>', url), {
    onLoad(window) {
      window.loading = true
      setTimeout(() => { window.loading = false }, 220)
      setTimeout(() => { rendered = true }, 380)
    },
  })
  const start = Date.now()
  const batch = await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }] })
  assert.equal(batch.items[0].state, 'captured')
  assert.ok(Date.now() - start >= 350)
  assert.equal(fixture.navigations.length, 1)
})

test('render timeout is bounded and cancels late background navigation instead of retrying', async t => {
  const fixture = durableFixture(t, url => read('<main>正在加载岗位</main>', url), { loadTimeoutMs: 180 })
  const pending = fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }] })
  await new Promise(resolve => setTimeout(resolve, 140))
  const mainFrame = () => new Promise(resolve => fixture.requests.before({ webContentsId: fixture.windows[0].webContents.id, resourceType: 'mainFrame', url: secondSource }, resolve))
  assert.equal((await mainFrame()).cancel, false)
  const callback = mainFrame()
  const batch = await pending
  assert.equal(batch.items[0].state, 'failed')
  assert.match(batch.items[0].message, /渲染超时/u)
  assert.equal(fixture.navigations.length, 1)
  const background = await new Promise(resolve => fixture.requests.before({ webContentsId: fixture.windows[0].webContents.id, resourceType: 'xhr', url: firstSource }, resolve))
  assert.equal(background.cancel, true)
  assert.equal((await callback).cancel, true)
})

test('a security response stops a still-loading page before the render deadline', async t => {
  let fixture
  fixture = durableFixture(t, url => read(detail, url), {
    loadTimeoutMs: 3000,
    onLoad(window) {
      window.loading = true
      setTimeout(() => fixture.requests.headers({ webContentsId: window.webContents.id, statusCode: 429 }, () => {}), 120)
    },
  })
  const start = Date.now()
  const batch = await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }, { url: secondSource }] })
  assert.deepEqual(batch.items.map(item => item.state), ['blocked', 'blocked'])
  assert.ok(Date.now() - start < 1500)
  assert.equal(fixture.navigations.length, 1)
})

test('BOSS partially public duties require login and cannot enter the complete-original cache', async t => {
  let full = false
  const partial = '岗位职责：\n开发和维护基于微服务架构的.NET后端应用程序，包括但不限于服务接口、API、数据存储等方面；\n任职要求：\n大专或以上学历，计算机\n登录查看完整内容'
  const fixture = durableFixture(t, url => read('<h1>.net开发工程师</h1><main>' + (full ? partial.replace('登录查看完整内容', '熟悉 SQL 和 ASP.NET。') : partial) + '</main>', url))
  const batch = await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }, { url: secondSource }] })
  assert.deepEqual(batch.items.map(item => item.state), ['login_required', 'login_required'])
  assert.equal(Object.hasOwn(batch.items[0], 'body'), false)
  assert.equal(fixture.browser.platforms()[0].cache_count, 0)
  assert.equal(fixture.navigations.length, 1)
  full = true
  assert.equal((await fixture.browser.read({ id: 'project-1', url: firstSource })).state, 'captured')
  assert.equal(fixture.browser.platforms()[0].cache_count, 1)
})

test('a DOM read resolving after timeout cannot save a late original', async t => {
  const fixture = durableFixture(t, async url => {
    await new Promise(resolve => setTimeout(resolve, 250))
    return read(detail, url)
  }, { loadTimeoutMs: 180 })
  const batch = await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }] })
  assert.equal(batch.items[0].state, 'failed')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(fixture.browser.platforms()[0].cache_count, 0)
})

test('a captured page dynamically displaying a captcha stops network without navigation or another read', async t => {
  const dom = renderedDOM(detail, firstSource, { runScripts: 'outside-only' })
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close() })
  const fixture = durableFixture(t, undefined, {
    executeJavaScript: script => dom.window.eval(script),
    onLoad(window) { window.webContents.emit('dom-ready') },
  })
  const batch = await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }] })
  assert.equal(batch.items[0].state, 'captured')
  fixture.windows[0].webContents.emit('did-start-navigation', {}, firstSource + '#details', true, true)
  const captcha = dom.window.document.createElement('div')
  captcha.textContent = '请完成安全验证，滑动滑块验证'
  dom.window.document.body.append(captcha)
  await new Promise(resolve => setTimeout(resolve, 160))
  assert.equal(fixture.browser.platforms()[0].blocked, true)
  assert.equal(fixture.windows[0].stopped, true)
  const response = await new Promise(resolve => fixture.requests.before({ webContentsId: fixture.windows[0].webContents.id, resourceType: 'xhr', url: firstSource }, resolve))
  assert.equal(response.cancel, true)
  assert.equal(fixture.navigations.length, 1)
})

test('DOM security observer coalesces mutations and disposes on replacement and pagehide', async t => {
  const dom = renderedDOM(detail, firstSource)
  t.after(() => dom.window.close())
  let scans = 0
  const classifier = document => { scans++; return readJdPage(document) }
  const first = monitorJdSecurity(dom.window.document, classifier, 100, 'testSecurityObserver')
  assert.equal(scans, 1)
  for (let index = 0; index < 30; index++) dom.window.document.body.append(dom.window.document.createElement('span'))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(scans, 1)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(scans, 2)
  const replacement = monitorJdSecurity(dom.window.document, classifier, 100, 'testSecurityObserver')
  assert.equal(await first, false)
  dom.window.dispatchEvent(new dom.window.Event('pagehide'))
  assert.equal(await replacement, false)
  const afterDispose = scans
  dom.window.document.body.append(dom.window.document.createElement('div'))
  await new Promise(resolve => setTimeout(resolve, 130))
  assert.equal(scans, afterDispose)
})

test('parent capture teardown does not access destroyed native getters or interrupt the surviving popup', async t => {
  const fixture = durableFixture(t, read(detail, firstSource), { throwAfterDestroy: true })
  await fixture.browser.open({ id: 'project-1', url: firstSource })
  const parent = fixture.windows[0]
  const popupOptions = parent.webContents.windowOpenHandler({ url: secondSource })
  const popup = new parent.constructor(popupOptions.overrideBrowserWindowOptions)
  parent.webContents.emit('did-create-window', popup)
  assert.doesNotThrow(() => parent.destroy())
  assert.throws(() => parent.webContents, /Object has been destroyed/u)
  assert.equal(fixture.browser.status({ id: 'project-1' }).state, 'opened')
  assert.equal((await fixture.browser.read({ id: 'project-1' })).state, 'captured')
  assert.doesNotThrow(() => popup.destroy())
  assert.equal(fixture.browser.status({ id: 'project-1' }).state, 'closed')
  assert.doesNotThrow(() => fixture.browser.dispose())
})

test('a completed login passively captures a full JD into the durable inbox without another read', async t => {
  const dom = renderedDOM('<main>岗位职责：开发后端接口。登录查看完整内容<input type="password"></main>', firstSource, { runScripts: 'outside-only' })
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close() })
  const notices = []
  const fixture = durableFixture(t, undefined, {
    executeJavaScript: script => dom.window.eval(script),
    onLoad(window) { window.webContents.emit('dom-ready') },
    onPending: (...args) => notices.push(args),
  })
  const batch = await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }] })
  assert.equal(batch.items[0].state, 'login_required')
  assert.equal(fixture.browser.pending().deliveries.length, 0)
  dom.window.document.body.innerHTML = detail
  await new Promise(resolve => setTimeout(resolve, 180))
  const delivery = fixture.browser.pending().deliveries[0]
  assert.equal(delivery.project_id, 'project-1')
  assert.equal(delivery.requested_url, firstSource)
  assert.equal(delivery.item.url, firstSource)
  assert.equal(delivery.item.state, 'captured')
  assert.deepEqual(notices, [[]])
  assert.equal(fixture.navigations.length, 1)
  fixture.browser.ack({ ids: [delivery.id] })
  dom.window.document.body.innerHTML = detail.replace('SQL', 'PostgreSQL')
  await new Promise(resolve => setTimeout(resolve, 180))
  assert.equal(fixture.browser.pending().deliveries.length, 0)
  assert.equal(notices.length, 1)
})

test('ordinary open with an existing login saves immediately and pending delivery survives a host restart', async t => {
  const fixture = durableFixture(t, read(detail, firstSource))
  await fixture.browser.open({ id: 'project-1', url: firstSource })
  const delivery = fixture.browser.pending().deliveries[0]
  assert.equal(delivery.item.state, 'captured')
  fixture.browser.dispose()
  const restarted = browserFixture(read(detail, firstSource), { dataDirectory: fixture.dataDirectory })
  t.after(() => restarted.browser.dispose())
  assert.deepEqual(restarted.browser.pending().deliveries, [delivery])
  restarted.browser.ack({ ids: [delivery.id] })
  await restarted.browser.open({ id: 'project-1', url: firstSource })
  assert.equal(restarted.browser.pending().deliveries.length, 0)
})

test('a security block and its explicit verification window never auto-deliver a ready page', async t => {
  const dom = renderedDOM('<main>岗位职责：开发后端接口。登录查看完整内容<input type="password"></main>', firstSource, { runScripts: 'outside-only' })
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close() })
  const fixture = durableFixture(t, undefined, { executeJavaScript: script => dom.window.eval(script), onLoad(window) { window.webContents.emit('dom-ready') } })
  await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }] })
  fixture.requests.headers({ webContentsId: fixture.windows[0].webContents.id, statusCode: 429 }, () => {})
  dom.window.document.body.innerHTML = detail
  await new Promise(resolve => setTimeout(resolve, 180))
  assert.equal(fixture.browser.pending().deliveries.length, 0)
  await fixture.browser.verify({ id: 'project-1', url: firstSource })
  await new Promise(resolve => setTimeout(resolve, 180))
  assert.equal(fixture.browser.pending().deliveries.length, 0)
  assert.equal(fixture.browser.platforms()[0].blocked, true)
  assert.equal((await fixture.browser.resume({ id: 'project-1', url: firstSource })).item.state, 'captured')
  assert.equal(fixture.browser.pending().deliveries.length, 0)
})

test('late automatic DOM results cannot deliver into a newly selected search project', async t => {
  const dom = renderedDOM('<main>岗位职责：开发后端接口。登录查看完整内容<input type="password"></main>', firstSource, { runScripts: 'outside-only' })
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close() })
  let holdNextRead = false
  let release
  const fixture = durableFixture(t, undefined, {
    executeJavaScript(script) {
      if (holdNextRead && !script.includes('monitorJdSecurity')) {
        holdNextRead = false
        return new Promise(resolve => { release = () => resolve(dom.window.eval(script)) })
      }
      return dom.window.eval(script)
    },
    onLoad(window) { window.webContents.emit('dom-ready') },
  })
  await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }] })
  holdNextRead = true
  dom.window.document.body.innerHTML = detail
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(typeof release, 'function')
  await fixture.browser.open({ id: 'project-2', url: firstSource })
  release()
  await new Promise(resolve => setTimeout(resolve, 180))
  assert.deepEqual(fixture.browser.pending().deliveries.map(item => item.project_id), ['project-2'])
})

test('initial duties followed by a hydration login wall are not auto-saved before the settle window', async t => {
  const dom = renderedDOM('<main><h1>后端岗位</h1>岗位职责：开发和维护后端接口。</main>', firstSource, { runScripts: 'outside-only' })
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close() })
  const fixture = durableFixture(t, undefined, {
    executeJavaScript: script => dom.window.eval(script),
    onLoad(window) {
      window.webContents.emit('dom-ready')
      setTimeout(() => { dom.window.document.querySelector('main').insertAdjacentHTML('beforeend', '<p>登录查看完整内容</p><input type="password">') }, 30)
    },
  })
  await fixture.browser.open({ id: 'project-1', url: firstSource })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(fixture.browser.pending().deliveries.length, 0)
  assert.equal(fixture.browser.platforms()[0].cache_count, 0)
  assert.equal(fixture.browser.platforms()[0].login_required, true)
})

test('a deferred dom-ready injection cannot replace the newer load-complete ready observer', async t => {
  const dom = renderedDOM('<main>岗位职责：开发后端接口。登录查看完整内容<input type="password"></main>', firstSource, { runScripts: 'outside-only' })
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close() })
  let deferred
  const fixture = durableFixture(t, undefined, {
    executeJavaScript(script, window) {
      if (window.loading && script.includes('monitorJdSecurity')) return new Promise(resolve => { deferred = () => resolve(dom.window.eval(script)) })
      return dom.window.eval(script)
    },
    onLoad(window) { window.webContents.emit('dom-ready') },
  })
  await fixture.browser.collect({ id: 'project-1', sources: [{ url: firstSource }] })
  const window = fixture.windows[0]
  dom.window.dispatchEvent(new dom.window.Event('pagehide'))
  window.loading = true
  window.webContents.emit('did-start-navigation', {}, firstSource, false, true)
  dom.window.document.body.innerHTML = detail
  window.webContents.emit('dom-ready')
  assert.equal(typeof deferred, 'function')
  window.loading = false
  window.webContents.emit('did-finish-load')
  window.webContents.emit('did-stop-loading')
  deferred()
  await new Promise(resolve => setTimeout(resolve, 180))
  assert.deepEqual(fixture.browser.pending().deliveries.map(item => item.project_id), ['project-1'])
})

test('preload pending notifications expose no IPC event or body and unsubscribe cleanly', async () => {
  const bridge = {}
  const ipc = Object.assign(new EventEmitter(), { invoke: async (...args) => args, send() {} })
  runInNewContext(readFileSync(new URL('./publisher-preload.cjs', import.meta.url), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron')
      return { contextBridge: { exposeInMainWorld(key, value) { bridge[key] = value } }, ipcRenderer: ipc }
    },
  })
  const received = []
  const unsubscribe = bridge.corchJd.onPending((...args) => received.push(args))
  ipc.emit('corch:jd:pending', { sender: 'private native event' }, 'unexpected private body')
  assert.deepEqual(received, [[]])
  unsubscribe()
  assert.equal(ipc.listenerCount('corch:jd:pending'), 0)
  assert.deepEqual(await bridge.corchJd.pending(), ['corch:jd:pending'])
  const ids = ['a'.repeat(64)]
  assert.deepEqual(await bridge.corchJd.ack({ ids }), ['corch:jd:ack', { ids }])
})

test('each captured item is delivered before a later loading source finishes the batch', async t => {
  let settled = false
  const fixture = durableFixture(t, url => read(zhaopinDetail, url), {
    loadTimeoutMs: 700,
    onLoad(window, url) { if (url === secondSource) window.loading = true },
  })
  const batch = fixture.browser.collect({ id: 'project-batch', sources: [{ url: firstSource }, { url: secondSource }] }).finally(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 300))
  const first = fixture.browser.pending().deliveries[0]
  assert.equal(settled, false)
  assert.equal(first.project_id, 'project-batch')
  assert.equal(first.requested_url, firstSource)
  assert.equal(first.item.url, firstSource)
  assert.doesNotMatch(first.item.body, /推荐岗位/u)
  const result = await batch
  assert.deepEqual(result.items.map(item => item.state), ['captured', 'failed'])
  assert.equal(fixture.browser.pending().deliveries.length, 1)
})

test('expired sources return promptly and reuse a body-free TTL result without retrying or blocking the platform', async t => {
  const fixture = durableFixture(t, url => read(expiredPage, url))
  const url = 'https://m.58.com/cd/tech/expired.shtml'
  const first = await fixture.browser.collect({ id: 'project-1', sources: [{ url }] })
  assert.equal(first.items[0].state, 'not_a_jd')
  assert.match(first.items[0].message, /已失效/u)
  assert.equal(fixture.browser.pending().deliveries.length, 0)
  assert.equal(fixture.browser.platforms()[0].cache_count, 0)
  assert.equal(fixture.browser.platforms()[0].blocked, false)
  assert.equal(fixture.browser.platforms()[0].login_required, false)
  const repeated = await fixture.browser.collect({ id: 'project-2', sources: [{ url }] })
  assert.equal(repeated.items[0].state, 'not_a_jd')
  assert.equal(fixture.navigations.length, 1)
  fixture.browser.close({ id: 'project-1' })
  await fixture.browser.open({ id: 'project-2', url })
  assert.equal(fixture.navigations.length, 2, 'An explicit view action can open the expired page under normal rate limits')
  assert.equal(fixture.browser.pending().deliveries.length, 0)
})
