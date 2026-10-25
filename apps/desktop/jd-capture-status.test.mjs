import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createJdCaptureStatus } from './jd-capture-status.mjs'

function fixture() {
  const views = []
  class WebContentsView {
    constructor(options) {
      this.options = options
      this.visibility = []
      this.webContents = new EventEmitter()
      const contents = this.webContents
      contents.session = new EventEmitter()
      contents.session.setPermissionRequestHandler = handler => { contents.session.permissionRequestHandler = handler }
      contents.session.setPermissionCheckHandler = handler => { contents.session.permissionCheckHandler = handler }
      contents.loads = []
      contents.destroyed = false
      contents.isDestroyed = () => contents.destroyed
      contents.close = () => {
        contents.closeCount = (contents.closeCount || 0) + 1
        contents.destroyed = true
        contents.emit('destroyed')
      }
      contents.setWindowOpenHandler = handler => { contents.openHandler = handler }
      contents.loadURL = url => new Promise((resolve, reject) => contents.loads.push({ url, resolve, reject }))
      views.push(this)
    }
    setVisible(visible) { this.visible = visible; this.visibility.push(visible) }
    setBounds(bounds) { this.bounds = bounds }
  }
  const window = new EventEmitter()
  window.destroyed = false
  window.isDestroyed = () => window.destroyed
  window.bounds = { x: 50, y: 100, width: 960, height: 640 }
  window.getContentBounds = () => window.bounds
  window.webContents = { platformPage: 'https://platform.test/job/1', untouched: true }
  window.contentView = {
    children: [],
    addChildView(view) { this.children.push(view) },
    removeChildView(view) { this.children.splice(this.children.indexOf(view), 1) },
  }
  window.setTitle = title => { window.title = title }
  const status = createJdCaptureStatus(window, { WebContentsView })
  return { status, window, view: views[0] }
}

function documentOf(load) {
  assert.ok(load.url.startsWith('data:text/html;charset=utf-8,'))
  return new JSDOM(decodeURIComponent(load.url.slice(load.url.indexOf(',') + 1)))
}

test('loading is readable before showing the local view and has no active resources or platform privileges', async () => {
  const { status, window, view } = fixture()
  const shown = status.show('loading', '<img src="https://untrusted.test" onerror="alert(1)">')
  assert.equal(status.state(), 'loading')
  assert.equal(status.isLoading(), true)
  assert.equal(view.visible, false)
  const dom = documentOf(view.webContents.loads[0])
  try {
    assert.match(dom.window.document.body.textContent, /正在打开岗位页面/u)
    assert.match(dom.window.document.body.textContent, /关闭此窗口返回工作台/u)
    assert.ok(dom.window.document.body.textContent.includes('<img src="https://untrusted.test" onerror="alert(1)">'))
    assert.equal(dom.window.document.querySelector('script, form, iframe, img, link, button, [src], [href]'), null)
    assert.equal(dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content, "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
  } finally { dom.window.close() }
  assert.deepEqual(view.options.webPreferences, {
    partition: view.options.webPreferences.partition,
    javascript: false, nodeIntegration: false, contextIsolation: true, sandbox: true,
    webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
  })
  assert.match(view.options.webPreferences.partition, /^jd-capture-status:/u)
  assert.ok(!view.options.webPreferences.partition.startsWith('persist:'))
  const other = fixture()
  assert.notEqual(view.options.webPreferences.partition, other.view.options.webPreferences.partition)
  other.status.dispose()
  assert.deepEqual(view.webContents.openHandler(), { action: 'deny' })
  for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
    let prevented = false
    view.webContents.emit(event, { preventDefault() { prevented = true } }, 'https://platform.test')
    assert.equal(prevented, true)
  }
  view.webContents.loads[0].resolve()
  await shown
  assert.equal(view.visible, true)
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 960, height: 640 })
  assert.deepEqual(window.webContents, { platformPage: 'https://platform.test/job/1', untouched: true })
  status.dispose()
})

test('the local session denies permission requests, checks and downloads without prompting', () => {
  const { status, view } = fixture()
  const session = view.webContents.session
  for (const permission of ['media', 'notifications', 'geolocation', 'openExternal', 'unknown']) {
    let decision
    session.permissionRequestHandler(view.webContents, permission, allowed => { decision = allowed })
    assert.equal(decision, false)
    assert.equal(session.permissionCheckHandler(view.webContents, permission, 'https://platform.test', {}), false)
  }
  let prevented = false
  session.emit('will-download', { preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  status.dispose()
  assert.equal(session.listenerCount('will-download'), 0)
})

for (const [kind, text] of [
  ['failure', '页面暂时打不开'], ['timeout', '页面加载超时'],
  ['blocked', '处理平台验证'], ['rate_limited', '平台暂时限制访问'],
]) test(`${kind} explains the platform state and returning to the workbench`, async () => {
  const { status, view } = fixture()
  const shown = status.show(kind, '招聘平台')
  const dom = documentOf(view.webContents.loads[0])
  try {
    assert.ok(dom.window.document.body.textContent.includes(text))
    assert.equal(dom.window.document.body.textContent.match(/关闭此窗口返回工作台/gu)?.length, 1)
    assert.equal(dom.window.document.querySelector('button, a, form'), null)
  } finally { dom.window.close() }
  view.webContents.loads[0].resolve()
  await shown
  assert.equal(view.visible, true)
  assert.equal(status.state(), kind)
  assert.equal(status.isLoading(), false)
  status.dispose()
})

test('hiding resolves pending show immediately and late completion cannot cover the platform page', async () => {
  const { status, view } = fixture()
  const shown = status.show('loading', 'BOSS直聘')
  status.hide()
  await shown
  assert.equal(status.state(), 'hidden')
  assert.equal(status.isLoading(), false)
  view.webContents.loads[0].resolve()
  await Promise.resolve()
  assert.equal(view.visible, false)
  status.dispose()
})

test('a superseded local load cannot reveal or report failure over its replacement', async () => {
  const { status, window, view } = fixture()
  const first = status.show('loading', '招聘平台')
  const second = status.show('timeout', '招聘平台')
  await first
  view.webContents.loads[0].reject(new Error('ERR_ABORTED'))
  await Promise.resolve()
  assert.equal(view.visible, false)
  assert.equal(window.title, undefined)
  assert.equal(status.state(), 'timeout')
  view.webContents.loads[1].resolve()
  await second
  assert.equal(view.visible, true)
  status.dispose()
})

test('late earlier success cannot replace the visible status of a newer show', async () => {
  const { status, view } = fixture()
  const first = status.show('loading', '招聘平台')
  const second = status.show('failure', '招聘平台')
  view.webContents.loads[1].resolve()
  await second
  const visibleCount = view.visibility.filter(Boolean).length
  view.webContents.loads[0].resolve()
  await first
  assert.equal(status.state(), 'failure')
  assert.equal(view.visibility.filter(Boolean).length, visibleCount)
  status.dispose()
})

test('current local load rejection settles show and reports a readable native window title', async () => {
  const { status, window, view } = fixture()
  const shown = status.show('timeout', '招聘平台')
  const error = new Error('local document failed')
  view.webContents.loads[0].reject(error)
  await assert.rejects(shown, failure => failure === error)
  assert.equal(window.title, '页面加载超时 · 关闭此窗口返回工作台')
  assert.equal(view.visible, false)
  status.dispose()
})

test('synchronous local load failure rejects with the same native title fallback', async () => {
  const { status, window, view } = fixture()
  view.webContents.loadURL = () => { throw new Error('renderer unavailable') }
  await assert.rejects(status.show('failure', '招聘平台'), /renderer unavailable/u)
  assert.equal(window.title, '页面暂时打不开 · 关闭此窗口返回工作台')
  status.dispose()
})

test('resize follows content bounds and disposal detaches and closes only the local contents once', async () => {
  const { status, window, view } = fixture()
  const shown = status.show('loading', '招聘平台')
  window.bounds = { x: 20, y: 30, width: 640, height: 480 }
  window.emit('resize')
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 640, height: 480 })
  status.dispose()
  await shown
  view.webContents.loads[0].reject(new Error('closed'))
  await Promise.resolve()
  status.dispose()
  status.hide()
  await status.show('loading', '招聘平台')
  assert.equal(status.state(), 'disposed')
  assert.equal(status.isLoading(), false)
  assert.equal(view.visible, false)
  assert.equal(view.webContents.closeCount, 1)
  assert.equal(window.contentView.children.length, 0)
  assert.equal(window.listenerCount('resize'), 0)
  assert.equal(window.listenerCount('closed'), 0)
  assert.equal(view.webContents.listenerCount('destroyed'), 0)
  assert.equal(view.webContents.listenerCount('will-navigate'), 0)
  assert.equal(view.webContents.listenerCount('will-redirect'), 0)
  assert.equal(view.webContents.listenerCount('will-attach-webview'), 0)
  assert.equal(view.webContents.session.listenerCount('will-download'), 0)
})

test('a closed parent or destroyed local renderer settles pending show without revealing a late load', async () => {
  for (const destroy of [({ window }) => { window.destroyed = true; window.emit('closed') }, ({ view }) => view.webContents.close()]) {
    const entry = fixture()
    const shown = entry.status.show('loading', '招聘平台')
    destroy(entry)
    await shown
    entry.view.webContents.loads[0].resolve()
    await Promise.resolve()
    assert.equal(entry.status.state(), 'disposed')
    assert.equal(entry.view.visible, false)
    assert.equal(entry.view.webContents.closeCount, 1)
  }
})

test('unknown statuses fail before navigating or displaying the local view', async () => {
  const { status, view } = fixture()
  await assert.rejects(status.show('unknown', '招聘平台'), /Unknown JD capture status/u)
  assert.equal(view.webContents.loads.length, 0)
  assert.equal(view.visible, false)
  status.dispose()
})
