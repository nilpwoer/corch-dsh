/** Windows portable desktop. A restricted preload exposes native publication only to the local workbench. */
import { app, BrowserWindow, dialog, Menu, session, ipcMain, safeStorage } from 'electron'
import { spawn, execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backendEnvironment, clipboardWriteAllowed, sameOrigin, workerPopupAllowed } from './policy.mjs'
import { createPublisher } from './publisher.mjs'
import { createPublisherVault } from './publisher-vault.mjs'
import { createJdBrowser } from './jd-browser.mjs'

app.setName('Corch DSH')
const source = dirname(fileURLToPath(import.meta.url))
const resources = app.isPackaged ? process.resourcesPath : resolve(source, '../../dist/windows/Corch-DSH/resources')
const args = process.argv.slice(app.isPackaged ? 1 : 2)
const dataIndex = args.indexOf('--data-dir')
const dataArg = dataIndex < 0 ? undefined : args[dataIndex + 1]
if (dataIndex >= 0 && (!dataArg || !isAbsolute(dataArg))) throw new Error('--data-dir requires an absolute directory')
const data = dataArg ?? join(dirname(process.execPath), 'data')
app.setPath('userData', join(data, 'electron'))
app.setPath('sessionData', join(data, 'electron'))
const prefs = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false }
let child
let mainWindow
let shuttingDown = false
let ready = false
let backendDone
let log
let localOrigin
const jdBrowser = createJdBrowser({ BrowserWindow, maxCaptureChars: 250000, loadTimeoutMs: 60000 })

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.restore(); mainWindow.focus() } })
  app.on('window-all-closed', () => { if (!shuttingDown) app.quit() })
  app.on('before-quit', event => {
    if (shuttingDown) return
    event.preventDefault()
    shuttingDown = true
    jdBrowser.dispose()
    void stopBackend().finally(() => app.quit())
  })
  app.whenReady().then(start).catch(async error => {
    await writeFile(join(data, 'startup-error.txt'), `${new Date().toISOString()} ${error.message}\n`).catch(() => undefined)
    dialog.showErrorBox('Corch DSH 启动失败', `${error.message}\n请检查客户端 data/backend.log；不会使用或关闭其他 DSH 服务。`)
    app.quit()
  })
}

async function stopBackend() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) { log?.end(); return }
  if (child.connected) child.send({ type: 'shutdown' })
  let timer
  const timedOut = await Promise.race([backendDone.then(() => false), new Promise(resolve => { timer=setTimeout(() => resolve(true), 12_000) })])
  clearTimeout(timer)
  if (timedOut && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
    await backendDone
  }
  log?.end()
}

function secureContents(contents, allowedOrigin) {
  contents.on('will-navigate', (event, url) => { if (!sameOrigin(url, allowedOrigin)) event.preventDefault() })
  contents.on('will-redirect', (event, url) => { if (!sameOrigin(url, allowedOrigin)) event.preventDefault() })
  contents.on('will-attach-webview', event => event.preventDefault())
  contents.setWindowOpenHandler(details => {
    if (allowedOrigin === localOrigin && workerPopupAllowed(details.url, localOrigin)) {
      return { action: 'allow', overrideBrowserWindowOptions: { title: 'Worker 发布', width: 1040, height: 840, autoHideMenuBar: true, webPreferences: prefs } }
    }
    return { action: 'deny' }
  })
  contents.on('did-create-window', (window, details) => {
    secureContents(window.webContents, new URL(details.url).origin)
    window.setMenu(null)
    window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      window.close()
    })
  })
}

async function start() {
  await mkdir(data, { recursive: true })
  const home = join(data, 'dsh')
  const work = join(data, 'workspace')
  const profile = join(home, 'profiles/web')
  await mkdir(profile, { recursive: true })
  await mkdir(work, { recursive: true })
  const modules = join(resources, 'runtime/node_modules')
  const manifest = join(profile, 'package.json')
  if (!existsSync(manifest)) await writeFile(manifest, JSON.stringify({
    name: 'corch-dsh-desktop-profile', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@polus-ai/dsh-client-ui-teaching-reform', 'dsh-better-sidebar'] } },
  }, null, 2) + '\n')
  const patch = join(profile, 'cordis.patch.yml')
  if (!existsSync(patch)) await writeFile(patch, '[]\n')
  const statePath = join(data, 'desktop-state.json')
  let port = 0
  if (existsSync(statePath)) {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) throw new Error('桌面端口记录无效')
    port = state.port
  }
  log = createWriteStream(join(data, 'backend.log'), { flags: 'a' })
  child = spawn(join(resources, 'node/node.exe'), [join(source, 'backend.mjs'), join(modules, '@deepseek-ai/dsh/lib/bin.js'), 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: work, env: backendEnvironment(process.env, home), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  backendDone = new Promise(resolve => child.once('close', resolve))
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('本机 DSH 服务启动超过60秒')), 60_000)
    let output = ''
    child.stdout.on('data', chunk => {
      log.write(chunk)
      output = (output + chunk.toString()).slice(-8192)
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
    child.stderr.on('data', chunk => log.write(chunk))
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`本机 DSH 服务在启动时退出 (${code})`)) })
  })
  localOrigin = endpoint
  await writeFile(statePath, JSON.stringify({ port: Number(new URL(endpoint).port) }, null, 2) + '\n')
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) =>
    permission === 'media' && sameOrigin(origin, localOrigin)
    || clipboardWriteAllowed(permission, origin, contents?.getURL() ?? '', localOrigin))
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (clipboardWriteAllowed(permission, details.requestingUrl, contents?.getURL() ?? '', localOrigin)) return callback(true)
    if (permission !== 'media' || !sameOrigin(contents.getURL(), localOrigin) || details.mediaTypes?.some(type => type !== 'audio')) return callback(false)
    const answer = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['拒绝', '允许麦克风'], defaultId: 0, cancelId: 0, message: '允许 Corch DSH 使用麦克风？' })
    callback(answer.response === 1)
  })
  session.defaultSession.on('will-download', (_event, item) => item.setSaveDialogOptions({ title: '保存文件' }))
  mainWindow = new BrowserWindow({ title: 'Corch DSH', width: 1440, height: 1000, minWidth: 1000, minHeight: 700, show: false, autoHideMenuBar: true, webPreferences: { ...prefs, preload: join(source, 'publisher-preload.cjs') } })
  mainWindow.once('closed', () => { if (!shuttingDown) app.quit() })
  const publisher = createPublisher({
    vault: createPublisherVault(join(data, 'worker-publisher.json'), safeStorage),
    openParticipant: async url => {
      const window = new BrowserWindow({ title: '专家访谈', width: 1040, height: 840, autoHideMenuBar: true, webPreferences: prefs })
      secureContents(window.webContents, new URL(url).origin)
      window.setMenu(null)
      try { await window.loadURL(url) } catch { window.close(); throw new Error('访谈页面无法打开，请检查网络后重试。') }
    },
  })
  const trustedPublisher = event => event.sender === mainWindow?.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame && sameOrigin(event.senderFrame.url, localOrigin)
  for (const method of ['open', 'read', 'close', 'pdf']) ipcMain.handle('corch:jd:' + method, async (event, input) => {
    if (!trustedPublisher(event)) return { ok: false, message: '当前页面无 JD 采集授权。' }
    try { return { ok: true, value: await jdBrowser[method](input) } }
    catch (error) { return { ok: false, message: error.message } }
  })
  for (const method of ['configure', 'status', 'publish']) ipcMain.handle('corch:publisher:' + method, async (event, input) => {
    if (!trustedPublisher(event)) return { ok: false, message: '当前页面无发布授权。' }
    try { return { ok: true, value: await publisher[method](input) } }
    catch (error) {
      const known = /^(PUBLISH_|PUBLICATION_|INVALID_|WORKER_UPDATE_REQUIRED)/.test(error.code ?? '')
      const vault = /^(系统凭据加密不可用|发布授权|无法读取发布授权)/.test(error.message ?? '')
      return { ok: false, code: known ? error.code : 'PUBLISH_NATIVE_FAILED', message: known || vault ? error.message : '发布未完成，请检查客户端设置和网络后重试。' }
    }
  })
  ipcMain.on('corch:publisher:cancel', (event, id) => { if (trustedPublisher(event)) publisher.cancel(id) })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Corch DSH', submenu: [{ label: '重新加载', role: 'reload' }, { type: 'separator' }, { label: '退出', role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]))
  secureContents(mainWindow.webContents, localOrigin)
  await mainWindow.loadURL(endpoint)
  mainWindow.show()
  ready = true
  await writeFile(join(data, 'runtime.json'), JSON.stringify({ ready, desktop_version: app.getVersion(), electron: process.versions.electron, local_origin: localOrigin, backend_pid: child.pid, home, renderer: prefs }, null, 2) + '\n')
  child.once('exit', code => {
    if (!shuttingDown && ready) { dialog.showErrorBox('Corch DSH 服务已停止', `本机服务退出 (${code})；请重新启动客户端。`); app.quit() }
  })
}
