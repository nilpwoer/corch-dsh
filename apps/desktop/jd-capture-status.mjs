/** Local status views cover capture navigation without changing the platform document or session. */
import { randomUUID } from 'node:crypto'

const messages = {
  loading: ['正在打开岗位页面', '页面加载完成后，将显示招聘平台的原始页面。'],
  failure: ['页面暂时打不开', '招聘平台未能打开该页面。请在工作台查看采集状态。'],
  timeout: ['页面加载超时', '招聘平台未能及时完成加载。请在工作台查看采集状态。'],
  blocked: ['需要处理平台验证', '自动采集已暂停。请通过工作台的平台登录窗口完成验证，再确认恢复采集。'],
  rate_limited: ['平台暂时限制访问', '自动采集已暂停，请等待平台恢复访问。如平台要求验证，请先完成验证。'],
}

const escapeHTML = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

function statusDocument(kind, platform) {
  const [title, explanation] = messages[kind]
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
  * { box-sizing: border-box; } body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f7fa; color: #243247; font: 16px/1.8 system-ui, "Microsoft YaHei", sans-serif; }
  main { width: min(560px, 100%); padding: 48px 32px; } .platform { margin: 0 0 12px; color: #52657b; font-size: 14px; overflow-wrap: anywhere; }
  h1 { margin: 0 0 18px; font-size: 28px; line-height: 1.4; } p { margin: 0 0 18px; } .hint { color: #52657b; font-size: 14px; }
  </style></head><body><main role="status"><p class="platform">JD 采集 · ${escapeHTML(platform || '招聘平台')}</p><h1>${title}</h1><p>${explanation}</p><p class="hint">关闭此窗口返回工作台。</p></main></body></html>`
}

/** Own a script-free, temporary local view above the capture window's platform page.
 * @param window - Capture BrowserWindow; its webContents and persistent platform session remain untouched.
 * @param options - Electron WebContentsView constructor.
 * @returns A status controller. show resolves after the local document loads, or when superseded, hidden or disposed; current load failures reject and set a readable native title. dispose closes the owned webContents.
 */
export function createJdCaptureStatus(window, { WebContentsView }) {
  const view = new WebContentsView({ webPreferences: {
    partition: `jd-capture-status:${randomUUID()}`,
    javascript: false,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  } })
  const contents = view.webContents
  let generation = 0
  let current = 'hidden'
  let pending
  let disposed = false
  let attached = false

  const resize = () => {
    if (disposed || window.isDestroyed()) return
    const { width, height } = window.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  const preventEvent = event => event.preventDefault()
  const localSession = contents.session
  // Electron retains in-memory sessions after view disposal; their permission denials remain installed.
  localSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  localSession.setPermissionCheckHandler(() => false)
  localSession.on('will-download', preventEvent)
  contents.on('will-navigate', preventEvent)
  contents.on('will-redirect', preventEvent)
  contents.on('will-attach-webview', preventEvent)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.setVisible(false)
  window.contentView.addChildView(view)
  attached = true
  resize()
  window.on('resize', resize)

  const invalidate = () => {
    generation += 1
    pending?.cancel()
    pending = undefined
  }

  const hide = () => {
    if (disposed) return
    invalidate()
    current = 'hidden'
    view.setVisible(false)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    invalidate()
    current = 'disposed'
    window.removeListener('resize', resize)
    window.removeListener('closed', dispose)
    contents.removeListener('destroyed', dispose)
    contents.removeListener('will-navigate', preventEvent)
    contents.removeListener('will-redirect', preventEvent)
    contents.removeListener('will-attach-webview', preventEvent)
    localSession.removeListener('will-download', preventEvent)
    view.setVisible(false)
    if (attached && !window.isDestroyed()) window.contentView.removeChildView(view)
    attached = false
    if (!contents.isDestroyed()) contents.close()
  }
  window.once('closed', dispose)
  contents.once('destroyed', dispose)

  const show = async (kind, platform) => {
    if (!Object.hasOwn(messages, kind)) throw new TypeError(`Unknown JD capture status: ${kind}`)
    if (disposed || window.isDestroyed()) return
    invalidate()
    const token = generation
    current = kind
    view.setVisible(false)
    let cancel
    const cancelled = new Promise(resolve => { cancel = () => resolve(false) })
    const request = { cancel }
    pending = request
    try {
      const loaded = Promise.resolve(contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(statusDocument(kind, platform))}`)).then(() => true)
      if (!await Promise.race([loaded, cancelled]) || disposed || token !== generation) return
      resize()
      view.setVisible(true)
    } catch (error) {
      // A hidden, replaced or closed generation owns no visible document or failure notification.
      if (disposed || token !== generation || window.isDestroyed()) return
      window.setTitle(`${messages[kind][0]} · 关闭此窗口返回工作台`)
      throw error
    } finally {
      if (pending === request) pending = undefined
    }
  }

  return { show, hide, dispose, isLoading: () => current === 'loading', state: () => current }
}
