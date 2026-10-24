/** Opt-in real-platform automatic-save acceptance through the ordinary desktop, without remote debugging or model prompts. */
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  data: { type: 'string' }, out: { type: 'string' }, targets: { type: 'string' },
} })
assert.ok(values.data && values.out && values.targets, 'Supply --data, --out and --targets; close other applications using this data directory')
const data = resolve(values.data), out = resolve(values.out)
const targets = JSON.parse(readFileSync(resolve(values.targets), 'utf8'))
assert.ok(Array.isArray(targets) && targets.length > 0 && targets.length <= 5)
process.argv = [process.argv[0], resolve('apps/desktop/main.mjs'), '--data-dir', data]
app.setPath('userData', join(data, 'electron'))
app.setPath('sessionData', join(data, 'electron'))
mkdirSync(out, { recursive: true, mode: 0o700 })
let main
const results = []
let failure
app.on('browser-window-created', (_event, window) => {
  if (!main) main = window
  console.log(JSON.stringify({ phase: 'window_created' }))
})
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function until(read, description, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await delay(100)
  }
  throw new Error('Timed out: ' + description)
}
const evaluate = script => main.webContents.executeJavaScript(script)
const click = label => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') || item.textContent.trim()) === ${JSON.stringify(label)}); if (!button || button.disabled) return false; button.click(); return true })()`)
const rpc = (method, payload = {}) => evaluate(`(async () => {
  const response = await fetch('/jd/' + ${JSON.stringify(method)}, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:${JSON.stringify(method)},payload:${JSON.stringify(payload)}}) });
  if (!response.ok) throw new Error('JD RPC HTTP ' + response.status);
  const result = (await response.json()).result;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
})()`)
const native = (method, payload) => evaluate(`(async () => { const result = await window.corchJd[${JSON.stringify(method)}](${JSON.stringify(payload)}); if (!result.ok) throw new Error(result.message); return result.value })()`)
async function save(passed) {
  await writeFile(join(out, 'verification.json'), JSON.stringify({ passed, actual_platforms: true, actual_desktop: true,
    remote_debugging: false, model_prompts: 0, continue_capture_clicks: 0, results, ...(failure ? { failure } : {}) }, null, 2) + '\n', { mode: 0o600 })
}
async function run() {
  await import('./main.mjs')
  console.log(JSON.stringify({ phase: 'desktop_imported' }))
  await app.whenReady()
  try {
    await until(() => main && !main.isDestroyed() && main.webContents.getURL().startsWith('http://127.0.0.1:'), 'desktop workbench')
    console.log(JSON.stringify({ phase: 'desktop_ready' }))
    let lastProbe
    await until(async () => {
      for (const label of ['继续', '稍后配置']) await click(label)
      const probe = await evaluate(`({ native_pending: typeof window.corchJd?.pending === 'function', jd_button: [...document.querySelectorAll('button')].some(item => (item.getAttribute('aria-label') || item.textContent.trim()) === 'JD 搜索'), navigation: [...document.querySelectorAll('nav button, [role=navigation] button')].map(item => item.getAttribute('aria-label') || item.textContent.trim()) })`)
      const key = JSON.stringify(probe)
      if (key !== lastProbe) { lastProbe = key; console.log(JSON.stringify({ phase: 'workbench_loading', ...probe })) }
      return probe.native_pending && probe.jd_button
    }, 'desktop API and teaching workbench')
    await click('JD 搜索')
    for (const target of targets) {
      const before = new Set((await rpc('list')).map(item => item.id))
      await until(() => click('＋ 新建搜索'), 'new independent JD search')
      const project = await until(async () => (await rpc('list')).find(item => !before.has(item.id)), 'archived search ownership')
      const state = (await native('platforms')).find(item => target.url.includes(item.platform))
      if (state?.blocked) {
        results.push({ platform: target.id, project_id: project.id, state: 'blocked', reason: state.reason })
        await save(false)
        continue
      }
      const opened = await native('open', { id: project.id, url: target.url })
      console.log(JSON.stringify({ phase: 'source_opened', platform: target.id, state: opened.state }))
      assert.equal(opened.state, 'opened')
      const saved = await until(async () => {
        const current = await rpc('read', { id: project.id })
        return current.sources.length ? current : undefined
      }, 'automatic Host save for ' + target.id, 300000)
      const source = saved.sources[0]
      assert.equal(source.acquisition, 'browser')
      assert.equal(saved.session_id, project.session_id)
      assert.ok(source.body.length > 0)
      await until(async () => !(await native('pending')).deliveries.some(item => item.project_id === project.id), 'acknowledged durable delivery')
      results.push({ platform: target.id, project_id: project.id, state: 'saved', source_url: source.source_url,
        body_chars: source.body.length, content_hash: source.content_hash, captured_at: source.captured_at, acknowledged: true })
      await save(false)
      await native('close', { id: project.id })
    }
    assert.ok(results.some(item => item.state === 'saved'), 'No actual JD was automatically saved')
    await save(true)
  } catch (error) {
    failure = error.message
    await save(false)
    throw error
  } finally { app.quit() }
}
void run().catch(error => { console.error(error.message); process.exitCode = 1 })
