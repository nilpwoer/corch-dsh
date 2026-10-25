/** Opt-in live-platform acceptance through the production Electron collector, without a remote-debugging connection. */
import { app, BrowserWindow, WebContentsView } from 'electron'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { createJdBrowser } from './jd-browser.mjs'

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  data: { type: 'string' }, out: { type: 'string' }, targets: { type: 'string' }, interactive: { type: 'boolean' },
} })
assert.ok(values.data && values.out && values.targets, 'Supply --data, --out and --targets; the data profile must not be open in another application')
const data = resolve(values.data), out = resolve(values.out)
app.setName('Corch DSH JD platform acceptance')
app.setPath('userData', join(data, 'electron'))
app.setPath('sessionData', join(data, 'electron'))
const targets = JSON.parse(readFileSync(resolve(values.targets), 'utf8'))
assert.ok(Array.isArray(targets) && targets.length > 0 && targets.length <= 20)
const windows = new Set(), navigations = [], requests = [], results = [], commands = [], presentations = []
const observedSessions = new Set()
const redact = value => { try { const url = new URL(value); return url.origin + url.pathname } catch { return 'invalid-url' } }
class ObservedWindow extends BrowserWindow {
  constructor(options) {
    super(options)
    windows.add(this)
    this.on('show', () => presentations.push({ at: new Date().toISOString(), url: redact(this.webContents.getURL()) }))
    this.once('closed', () => windows.delete(this))
    if (!observedSessions.has(this.webContents.session)) {
      observedSessions.add(this.webContents.session)
      this.webContents.session.webRequest.onSendHeaders(details => {
        if (details.resourceType === 'mainFrame') requests.push({ at: new Date().toISOString(), url: redact(details.url) })
      })
    }
    this.webContents.on('did-start-navigation', (event, url, _inPlace, main) => {
      if (event.isMainFrame ?? main) navigations.push({ at: new Date().toISOString(), url: redact(event.url ?? url) })
    })
  }
}
const broker = createJdBrowser({ BrowserWindow: ObservedWindow, WebContentsView, maxCaptureChars: 250000, loadTimeoutMs: 60000, dataDirectory: data })
const compact = item => {
  const { body, ...metadata } = item
  return { ...metadata, ...(body ? { body_chars: body.length } : {}) }
}
async function save() {
  const snapshot = { recorded_at: new Date().toISOString(), actual_platforms: true, remote_debugging: false,
    results, navigations, requests, commands, presentations, platforms: await broker.platforms(),
    windows: [...windows].filter(window => !window.isDestroyed()).map(window => ({
      url: redact(window.webContents.getURL()), visible: window.isVisible(), content_size: window.getContentSize(), size: window.getSize(), minimum_size: window.getMinimumSize(),
    })) }
  await writeFile(join(out, 'live-results.json'), JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 })
}
async function captureWindows(prefix) {
  let index = 0
  for (const window of windows) {
    if (window.isDestroyed()) continue
    let timer
    try {
      const pixels = await Promise.race([window.webContents.capturePage(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('No compositor frame available for this optional screenshot')), 3000)
      })])
      await writeFile(join(out, `${prefix}-${++index}.png`), pixels.toPNG(), { mode: 0o600 })
    }
    catch { /* A page may close while its owned screenshot is being captured. The result and navigation evidence remain saved. */ }
    finally { clearTimeout(timer) }
  }
}
mkdirSync(out, { recursive: true, mode: 0o700 })
async function run() {
 await app.whenReady()
 try {
  for (const target of targets) {
    assert.ok(typeof target.id === 'string' && typeof target.url === 'string' && typeof target.title === 'string')
    const started = new Date().toISOString()
    const response = await broker.collect({ id: target.id, sources: [{ url: target.url, title: target.title }] })
    const item = response.items[0]
    const entry = { id: target.id, requested_url: target.url, started, finished: new Date().toISOString(), item: compact(item) }
    results.push(entry)
    if (item.state === 'captured') {
      const before = navigations.length
      const repeated = await broker.collect({ id: target.id + '-cached', sources: [{ url: target.url, title: target.title }] })
      assert.equal(repeated.items[0].state, 'captured')
      assert.equal(repeated.items[0].cached, true)
      assert.equal(repeated.items[0].content_hash, item.content_hash)
      assert.equal(navigations.length, before, 'A cache hit must not navigate')
      entry.cache_verified = true
    } else if (item.state === 'blocked') {
      const before = navigations.length
      const repeated = await broker.collect({ id: target.id + '-blocked', sources: [{ url: target.url, title: target.title }] })
      assert.equal(repeated.items[0].state, 'blocked')
      assert.equal(navigations.length, before, 'A blocked platform must not navigate on another project')
      entry.block_verified = true
    }
    await save()
    await captureWindows(target.id)
    console.log(JSON.stringify({ id: target.id, state: item.state, cached: item.cached ?? false, body_chars: item.body?.length ?? 0 }))
  }
  console.log(JSON.stringify({ phase: values.interactive ? 'awaiting_user_or_close_command' : 'complete', result_file: join(out, 'live-results.json') }))
  if (values.interactive) {
    let sequence = 0, closed = false
    while (!closed) {
      let command
      try { command = JSON.parse(await readFile(join(out, 'command.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (command && Number.isInteger(command.sequence) && command.sequence > sequence) {
        sequence = command.sequence
        const target = targets.find(item => item.id === command.id)
        if (command.action === 'close') closed = true
        else if (target && ['open', 'verify', 'resume', 'read'].includes(command.action)) {
          try {
            const value = await broker[command.action]({ id: target.id, url: target.url })
            commands.push({ sequence, action: command.action, id: target.id, value: value.items ? { ...value, items: value.items.map(compact) } : value.item ? { ...value, item: compact(value.item) } : compact(value) })
          } catch (error) { commands.push({ sequence, action: command.action, id: target.id, error: error.message }) }
          await save()
          await captureWindows('command-' + sequence)
        } else throw new Error('Unsupported live acceptance command')
      }
      if (!closed) await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
 } finally {
  await save()
  for (const session of observedSessions) {
    session.flushStorageData()
    await session.cookies.flushStore()
  }
  await broker.dispose()
  app.quit()
 }
}
void run().catch(error => { console.error(error); app.exit(1) })
