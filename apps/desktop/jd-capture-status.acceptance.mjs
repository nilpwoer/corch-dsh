/** Real Electron capture-window status scenarios with local external pages and no model credentials. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { backendEnvironment } from './policy.mjs'
import { isolateAcceptanceWindows } from './acceptance-windows.mjs'

const entry = fileURLToPath(import.meta.url)

if (process.versions.electron) {
  const { app, BrowserWindow, WebContentsView } = await import('electron')
  const { createJdBrowser } = await import('./jd-browser.mjs')
  const { values } = parseArgs({ strict: false, options: { 'probe-data': { type: 'string' } } })
  app.setPath('userData', resolve(values['probe-data']))
  app.on('window-all-closed', () => {})
  let capture
  globalThis.jdStatusProbe = {
    reset: async (name, timeout) => {
      capture?.dispose()
      const directory = join(resolve(values['probe-data']), name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'jd-collection-settings.json'), JSON.stringify({ min_interval_ms: 100, cache_ttl_ms: 1000,
        max_navigations_per_hour: 100, max_sources_per_batch: 20, render_settle_ms: 100 }))
      capture = createJdBrowser({ BrowserWindow, WebContentsView, dataDirectory: directory, maxCaptureChars: 250000, loadTimeoutMs: timeout })
      globalThis.jdStatusProbe.result = undefined
    },
    start: input => {
      globalThis.jdStatusProbe.result = undefined
      void capture.open(input).then(result => { globalThis.jdStatusProbe.result = result }, error => { globalThis.jdStatusProbe.result = { error: error.message } })
    },
    read: input => capture.read(input),
    pending: () => capture.pending(),
    platforms: () => capture.platforms(),
    snapshot: () => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) return undefined
      const status = window.contentView.children.find(view => view.webContents?.getURL().startsWith('data:text/html'))
      return { visible: window.isVisible(), url: window.webContents.getURL(), loading_main_frame: window.webContents.isLoadingMainFrame(), status_visible: status?.getVisible() === true,
        status_html: status ? decodeURIComponent(status.webContents.getURL().split(',').slice(1).join(',')) : '',
        result: globalThis.jdStatusProbe.result }
    },
    image: async () => {
      const window = BrowserWindow.getAllWindows()[0]
      const status = window.contentView.children.find(view => view.webContents?.getURL().startsWith('data:text/html') && view.getVisible())
      return (await (status?.webContents || window.webContents).capturePage()).toPNG().toString('base64')
    },
    lateFetch: async url => {
      const window = BrowserWindow.getAllWindows()[0]
      return window.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}).then(() => 'allowed', () => 'denied')`)
    },
    lateNavigation: async url => {
      const window = BrowserWindow.getAllWindows()[0]
      try { await window.loadURL(url); return 'allowed' } catch { return 'denied' }
    },
    crash: () => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
    stop: () => capture?.dispose(),
  }
} else {
  const require = createRequire(import.meta.url)
  const { _electron: electron } = require('playwright')
  const { values } = parseArgs({ options: { exe: { type: 'string' }, data: { type: 'string' }, out: { type: 'string' }, 'show-windows': { type: 'boolean' } } })
  assert.ok(values.exe && values.data && values.out, 'Supply --exe, --data and --out')
  const data = resolve(values.data), out = resolve(values.out)
  await mkdir(data, { recursive: true })
  await mkdir(out, { recursive: true })
  let mode = 'delayed', requests = 0, desktop
  const checks = [], snapshots = {}
  let passed = false, failure
  const duties = '<main><h1>后端开发工程师</h1><article>岗位职责：开发和维护后端接口。任职要求：掌握数据库与单元测试。</article></main>'
  const server = createServer((request, response) => {
    requests += 1
    if (mode === 'failure') { request.socket.destroy(); return }
    response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
    if (mode === 'delayed') response.end('<!doctype html><title>岗位加载验收</title><body><script>setTimeout(() => { document.body.innerHTML = ' + JSON.stringify(duties) + ' }, 1800)</script>')
    else if (mode === 'blank') response.end('<!doctype html><title>空白正文验收</title><body>')
    else response.end('<!doctype html><title>后端开发工程师</title>' + duties)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const input = { id: 'status-acceptance', url: origin + '/job/one' }
  async function waitFor(predicate, label, timeout = 15000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await desktop.evaluate(() => globalThis.jdStatusProbe.snapshot())
      if (predicate(value)) return value
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.fail('Capture state did not reach: ' + label)
  }
  async function image(name) {
    const base64 = await desktop.evaluate(() => globalThis.jdStatusProbe.image())
    await writeFile(join(out, name + '.png'), Buffer.from(base64, 'base64'))
  }
  async function start(name, timeout = 5000, target = input) {
    await desktop.evaluate(async (_electron, { name, timeout, input }) => {
      await globalThis.jdStatusProbe.reset(name, timeout)
      globalThis.jdStatusProbe.start(input)
    }, { name, timeout, input: target })
  }
  async function stableTraffic() {
    const before = requests
    await new Promise(resolve => setTimeout(resolve, 450))
    assert.equal(requests, before, 'Stopped capture must not automatically retry or perform background requests')
  }
  try {
    desktop = await electron.launch({ executablePath: resolve(values.exe), args: [entry, '--probe-data', data],
      env: backendEnvironment(process.env, join(data, 'unused')), timeout: 45000 })
    await isolateAcceptanceWindows(desktop, Boolean(values['show-windows']))
    await start('delayed')
    snapshots.loading = await waitFor(value => value?.visible && value.status_visible && value.status_html.includes('正在打开岗位页面'), 'readable loading view')
    snapshots.empty_loaded_document = await waitFor(value => value?.url === input.url && !value.loading_main_frame && value.status_visible && !value.result, 'empty document after load remains covered until late-rendered text')
    await image('01-loading')
    snapshots.readable = await waitFor(value => value?.result?.state === 'opened' && !value.status_visible, 'rendered job revealed')
    const pending = await desktop.evaluate(() => globalThis.jdStatusProbe.pending())
    assert.equal(pending.deliveries.length, 1)
    assert.match(pending.deliveries[0].item.body, /开发和维护后端接口/u)
    await image('02-readable-job')
    checks.push('Loading view appears before an empty platform document; readable JD reveals automatically and persists in the delivery inbox')

    mode = 'blank'
    await start('blank', 900)
    snapshots.timeout = await waitFor(value => value?.result?.state === 'failed' && value.status_visible && value.status_html.includes('页面加载超时'), 'readable timeout')
    await image('03-timeout')
    assert.equal((await desktop.evaluate((_electron, input) => globalThis.jdStatusProbe.read(input), input)).state, 'failed')
    assert.equal(await desktop.evaluate((_electron, url) => globalThis.jdStatusProbe.lateFetch(url), origin + '/background'), 'denied')
    await stableTraffic()
    checks.push('Empty document times out with a readable message; background access is cancelled and no automatic retry occurs')

    mode = 'failure'
    await start('network-failure')
    snapshots.failure = await waitFor(value => value?.result?.state === 'failed' && value.status_visible && value.status_html.includes('页面暂时打不开'), 'readable main-frame failure')
    await image('04-network-failure')
    await stableTraffic()
    checks.push('Main-frame network failure returns failed and keeps a readable local page without automatically retrying')
    mode = 'good'
    await desktop.evaluate((_electron, input) => globalThis.jdStatusProbe.start(input), input)
    snapshots.recovered = await waitFor(value => value?.result?.state === 'opened' && !value.status_visible, 'explicit reopen succeeds')
    assert.equal((await desktop.evaluate(() => globalThis.jdStatusProbe.pending())).deliveries.length, 1)
    await image('05-explicit-reopen')
    checks.push('Explicitly reopening the failed source starts one fresh navigation, reveals its JD and persists the original')

    await desktop.evaluate(() => globalThis.jdStatusProbe.crash())
    snapshots.renderer_failure = await waitFor(value => value?.status_visible && value.status_html.includes('页面暂时打不开'), 'readable renderer failure')
    await image('06-renderer-failure')
    assert.equal((await desktop.evaluate((_electron, input) => globalThis.jdStatusProbe.read(input), input)).state, 'failed')
    await stableTraffic()
    checks.push('A terminated platform renderer is covered by the independent local failure view and cannot continue collection')

    const challenged = { ...input, url: origin + '/captcha' }
    await start('challenge', 5000, challenged)
    snapshots.blocked = await waitFor(value => value?.result?.state === 'blocked' && value.status_visible && value.status_html.includes('需要处理平台验证'), 'readable security stop before document commit')
    await image('07-platform-stop')
    assert.equal((await desktop.evaluate(() => globalThis.jdStatusProbe.platforms()))[0].blocked, true)
    const before = requests
    await desktop.evaluate((_electron, input) => globalThis.jdStatusProbe.start(input), input)
    await waitFor(value => value?.result?.state === 'blocked', 'ordinary reopen remains blocked')
    assert.equal(requests, before)
    assert.equal(await desktop.evaluate((_electron, url) => globalThis.jdStatusProbe.lateNavigation(url), origin + '/background'), 'denied')
    await stableTraffic()
    assert.equal((await desktop.evaluate(() => globalThis.jdStatusProbe.pending())).deliveries.length, 0)
    checks.push('A security route blocked before document commit shows a readable platform-stop page; ordinary reopen and background access remain denied without explicit verification')
    passed = true
  } catch (error) {
    failure = error.stack || error.message
    throw error
  } finally {
    await writeFile(join(out, 'verification.json'), JSON.stringify({ passed, checks, failure, snapshots,
      actual_electron: true, local_external_pages: true, test_windows_visible: Boolean(values['show-windows']), model_requests: 0 }, null, 2) + '\n')
    if (desktop) {
      await desktop.evaluate(() => globalThis.jdStatusProbe.stop()).catch(() => {})
      await desktop.close()
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  console.log(JSON.stringify({ passed, checks: checks.length, out }))
}
