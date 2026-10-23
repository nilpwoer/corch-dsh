import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { EventEmitter } from 'node:events'
import { createJdBrowser, readJdPage } from './jd-browser.mjs'

function read(html, url = 'https://www.zhipin.com/web/geek/jobs?_security_check=private') {
  const dom = new JSDOM(html, { url })
  // JSDOM has no layout or innerText; expose rendered fixture text and rectangle visibility.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent } })
  dom.window.HTMLElement.prototype.getClientRects = function () {
    for (let element = this; element; element = element.parentElement) if (dom.window.getComputedStyle(element).display === 'none') return []
    return [{}]
  }
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

function browserFixture(result) {
  const windows = []
  class Window extends EventEmitter {
    constructor() {
      super()
      this.webContents = Object.assign(new EventEmitter(), {
        session: Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }),
        setWindowOpenHandler(handler) { this.windowOpenHandler = handler }, isLoadingMainFrame: () => false,
        getURL: () => 'https://www.zhipin.com/job_detail/job-1.html', executeJavaScript: async () => result,
      })
      windows.push(this)
    }
    setMenu() {}
    setTitle() {}
    async loadURL() {}
    isDestroyed() { return this.destroyed === true }
    show() {}
    restore() {}
    focus() { this.emit('focus') }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  return { browser: createJdBrowser({ BrowserWindow: Window, maxCaptureChars: 250000, loadTimeoutMs: 1000 }), windows }
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
  assert.equal(popupOptions.overrideBrowserWindowOptions.webPreferences.session, windows[0].webContents.session)
  const popup = new windows[0].constructor()
  windows[0].webContents.emit('did-create-window', popup)
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
