/** Isolated human-login capture windows. Only rendered text leaves the browser session. */
import { randomUUID, createHash } from 'node:crypto'

const CAPTURE_WINDOW_TITLE = 'JD 采集 · 请在此登录，完成后回到工作台继续采集'

function safeURL(value) {
  const url = new URL(value)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error('采集地址须使用 HTTPS；仅本机测试允许 HTTP')
  url.hash = ''
  return url.href
}

/** Read rendered duties and identify the displayed job without reading browser credentials.
 * @param document - Current page DOM, evaluated inside the isolated capture window.
 * @returns Visible duties sections in document order, login status and the job's unambiguous source URL, or null when a list selection cannot be identified.
 */
export function readJdPage(document) {
  const visible = element => !!(element.getClientRects().length && document.defaultView.getComputedStyle(element).visibility !== 'hidden')
  const duties = element => /(?:岗位职责|工作职责|职位描述|任职要求|职位要求|工作内容|职责描述|job description|responsibilit)[\s:：]*\S/iu.test(element.innerText || '')
  const details = [...document.querySelectorAll('[class*="job-detail"], [class*="job_detail"], [class*="jobDetail"]')].filter(visible)
  const detail = details.find(duties)
  const section = [...document.querySelectorAll('[class*="job-description"], [class*="job-sec"], main, article')].find(element => visible(element) && duties(element))
  const root = detail || section || document.body
  const descriptionSelector = '[class*="job-sec-text"], [class*="job-description"]'
  const descriptions = [...(root?.matches(descriptionSelector) ? [root] : []), ...(root?.querySelectorAll(descriptionSelector) || [])].filter(element => visible(element) && duties(element))
  const descriptionRoots = descriptions.filter(element => !descriptions.some(other => other !== element && other.contains(element)))
  const body = descriptionRoots.length ? descriptionRoots.map(element => element.innerText).join('\n\n') : root?.innerText || ''
  const heading = [...(root?.querySelectorAll('h1, [class*="job-title"], [class*="job-name"]') || [])].find(visible)
  const pageHeading = [...document.querySelectorAll('h1')].find(visible)
  const firstLine = element => (element?.innerText || '').split('\n').find(line => line.trim())?.trim()
  const detailTitle = detail && firstLine(detail)
  const pageURL = new URL(document.location.href)
  const boss = pageURL.hostname === 'zhipin.com' || pageURL.hostname.endsWith('.zhipin.com')
  const directBoss = boss && /^\/job_detail\/[^/]+\.html$/u.test(pageURL.pathname)
  const title = ((directBoss && pageHeading?.innerText) || heading?.innerText || (detailTitle && !/^(?:岗位职责|工作职责|职位描述|任职要求|职位要求|工作内容|职责描述|job description|responsibilit)/iu.test(detailTitle) && detailTitle) || pageHeading?.innerText || document.title).trim()
  let sourceURL = pageURL.href
  if (boss && /^\/web\/geek\/jobs\/?$/u.test(pageURL.pathname)) {
    const normalize = value => value.replace(/\s+/gu, ' ').trim()
    const matches = new Set()
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (normalize(anchor.innerText || '') !== normalize(title)) continue
      if (!URL.canParse(anchor.getAttribute('href'), pageURL)) continue
      const candidate = new URL(anchor.getAttribute('href'), pageURL)
      if (candidate.origin !== pageURL.origin || candidate.username || candidate.password || !/^\/job_detail\/[^/]+\.html$/u.test(candidate.pathname)) continue
      matches.add(candidate.origin + candidate.pathname)
    }
    sourceURL = matches.size === 1 ? [...matches][0] : null
  } else if (directBoss) sourceURL = pageURL.origin + pageURL.pathname
  return { title, body, url: sourceURL, login: [...document.querySelectorAll('input[type=password],input[autocomplete=one-time-code]')].some(visible) }
}

/**
 * Own all capture windows until explicit close or application shutdown.
 * @param options - Electron constructors and resolved capture limits.
 * @returns Restricted open/read/close operations; no cookie or arbitrary script API.
 */
export function createJdBrowser({ BrowserWindow, maxCaptureChars, loadTimeoutMs }) {
  const captures = new Map()
  const protectedSessions = new WeakSet()
  const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  const protect = (window, state) => {
    state.windows.add(window)
    state.activeWindow = window
    window.on('focus', () => { state.activeWindow = window })
    window.setMenu(null)
    window.setTitle(CAPTURE_WINDOW_TITLE)
    window.on('page-title-updated', event => event.preventDefault())
    for (const eventName of ['will-navigate', 'will-redirect']) window.webContents.on(eventName, (event, url) => {
      try { safeURL(url) } catch { event.preventDefault() }
    })
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.setWindowOpenHandler(({ url }) => {
      try { safeURL(url) } catch { return { action: 'deny' } }
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { ...preferences, session: window.webContents.session } } }
    })
    window.webContents.on('did-create-window', popup => protect(popup, state))
    if (!protectedSessions.has(window.webContents.session)) {
      protectedSessions.add(window.webContents.session)
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      window.webContents.session.setPermissionCheckHandler(() => false)
      window.webContents.session.on('will-download', event => event.preventDefault())
    }
    window.once('closed', () => state.windows.delete(window))
  }
  return {
    async open(input) {
      const url = safeURL(input.url)
      const id = input.id
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new Error('采集项目标识无效')
      const existing = captures.get(id)
      const active = existing && [...existing.windows].find(window => !window.isDestroyed())
      if (active) {
        if (existing.sourceURL !== url) {
          existing.sourceURL = url
          void active.loadURL(url).catch(() => { /* A failed navigation remains visible for the user's next read. */ })
        }
        active.show(); active.restore(); active.focus()
        return { id, state: 'opened' }
      }
      const window = new BrowserWindow({ title: CAPTURE_WINDOW_TITLE, width: 1180, height: 860,
        webPreferences: { ...preferences, partition: 'persist:jd-research' } })
      const state = { sourceURL: url, windows: new Set() }
      captures.set(id, state)
      protect(window, state)
      // Navigation may remain at an interactive login page; completion is a later explicit read.
      void window.loadURL(url).catch(() => { /* Read reports the current page or loading failure without inventing a capture. */ })
      return { id, state: 'opened' }
    },
    async read(input) {
      const state = captures.get(input.id)
      const window = state && (!state.activeWindow.isDestroyed() ? state.activeWindow : [...state.windows].find(candidate => !candidate.isDestroyed()))
      if (!window) throw new Error('采集窗口已关闭，请重新打开来源')
      if (window.webContents.isLoadingMainFrame()) throw new Error('页面仍在加载，请稍后继续采集')
      safeURL(window.webContents.getURL())
      const result = await window.webContents.executeJavaScript(`(${readJdPage.toString()})(document)`)
      if (result.login || /请先登录|登录后(?:才能|可查看|查看)|扫码查看|请完成安全验证/u.test(result.body)) return { state: 'login_required', message: '尚未取得 JD 正文，请在采集窗口完成登录或验证，并打开具体岗位详情。' }
      if (!/岗位职责|工作职责|职位描述|任职要求|职位要求|工作内容|职责描述|job description|responsibilit/iu.test(result.body)) return { state: 'not_a_jd', message: '当前页面未识别到岗位职责，请打开具体岗位详情后继续采集。' }
      if (result.url === null) return { state: 'source_unresolved', message: '当前列表页无法唯一确认岗位详情链接；请从岗位标题打开独立详情页，再继续采集。' }
      if (result.body.length > maxCaptureChars) throw new Error('岗位页面超过正文大小限制；请使用“导入原文”提交具体岗位正文')
      const body = result.body.trim()
      return { state: 'captured', url: safeURL(result.url), title: result.title, body, captured_at: new Date().toISOString(), content_hash: createHash('sha256').update(body).digest('hex') }
    },
    close(input) {
      const state = captures.get(input.id)
      if (state) for (const window of state.windows) if (!window.isDestroyed()) window.destroy()
      captures.delete(input.id)
    },
    dispose() {
      for (const state of captures.values()) for (const window of state.windows) if (!window.isDestroyed()) window.destroy()
      captures.clear()
    },
    async pdf(input) {
      if (typeof input.html !== 'string' || Buffer.byteLength(input.html) > 24 * 1024 * 1024) throw new Error('导出报告内容无效或过大')
      const window = new BrowserWindow({ show: false, webPreferences: { ...preferences, javascript: false, partition: 'jd-report-' + randomUUID() } })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:text/html') }))
      let timer
      try {
        const operation = async () => {
          const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
          await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(csp + input.html))
          return window.webContents.printToPDF({ printBackground: true, pageSize: 'A4', displayHeaderFooter: true,
            headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:9px;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' })
        }
        const bytes = await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDF 生成超时')), loadTimeoutMs) })])
        return { base64: bytes.toString('base64') }
      } finally { clearTimeout(timer); if (!window.isDestroyed()) window.destroy() }
    },
  }
}
