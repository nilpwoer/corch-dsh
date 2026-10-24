/** Isolated human-login capture windows. Only rendered text leaves the browser session. */
import { randomUUID, createHash } from 'node:crypto'
import { createJdCollection, jdChallengeURL, jdHasDuties, jdLoginWall, jdPlatform, jdSourceURL, jdUnavailableReason } from './jd-collection.mjs'

const CAPTURE_WINDOW_TITLE = 'JD 采集 · 完整岗位正文可读后自动保存；风控验证须确认恢复'

const safeURL = jdSourceURL

/** Read rendered duties and identify the displayed job without reading browser credentials.
 * @param document - Current page DOM, evaluated inside the isolated capture window.
 * @param unavailableReason - Unavailable-source classifier included when the reader is serialized into a renderer.
 * @returns Visible duties sections, login and security-challenge flags, and the job's unambiguous source URL, or null when a list selection cannot be identified.
 */
export function readJdPage(document, unavailableReason = jdUnavailableReason) {
  const visible = element => !!(element.getClientRects().length && document.defaultView.getComputedStyle(element).visibility !== 'hidden')
  const duties = element => /(?:岗位职责|工作职责|职位描述|任职要求|职位要求|工作内容|职责描述|job description|responsibilit)[\s:：]*\S/iu.test(element.innerText || '')
  const pageURL = new URL(document.location.href)
  const zhaopin = pageURL.hostname === 'zhaopin.com' || pageURL.hostname.endsWith('.zhaopin.com')
  const zhaopinCard = [...document.querySelectorAll('.describtion-card')].find(element => visible(element) && duties(element) && element.querySelector('.seo-card__content'))
  const details = [...document.querySelectorAll('[class*="job-detail"], [class*="job_detail"], [class*="jobDetail"]')].filter(visible)
  const detail = details.find(duties)
  const section = [...document.querySelectorAll('[class*="job-description"], [class*="job-sec"], main, article')].find(element => visible(element) && duties(element))
  const root = zhaopinCard || (zhaopin ? undefined : detail || section || document.body)
  const descriptionSelector = '[class*="job-sec-text"], [class*="job-description"]'
  const descriptions = [...(root?.matches(descriptionSelector) ? [root] : []), ...(root?.querySelectorAll(descriptionSelector) || [])].filter(element => visible(element) && duties(element))
  const descriptionRoots = descriptions.filter(element => !descriptions.some(other => other !== element && other.contains(element)))
  const body = zhaopinCard
    ? [zhaopinCard.querySelector('.seo-card__title')?.innerText, zhaopinCard.querySelector('.seo-card__content').innerText].filter(Boolean).join('\n')
    : descriptionRoots.length ? descriptionRoots.map(element => element.innerText).join('\n\n') : root?.innerText || ''
  const heading = [...(root?.querySelectorAll('h1, [class*="job-title"], [class*="job-name"]') || [])].find(visible)
  const pageHeading = [...document.querySelectorAll('h1')].find(visible)
  const firstLine = element => (element?.innerText || '').split('\n').find(line => line.trim())?.trim()
  const detailTitle = detail && firstLine(detail)
  const boss = pageURL.hostname === 'zhipin.com' || pageURL.hostname.endsWith('.zhipin.com')
  const directBoss = boss && /^\/job_detail\/[^/]+\.html$/u.test(pageURL.pathname)
  const title = ((directBoss && pageHeading?.innerText) || heading?.innerText || (detailTitle && !/^(?:岗位职责|工作职责|职位描述|任职要求|职位要求|工作内容|职责描述|job description|responsibilit)/iu.test(detailTitle) && detailTitle) || pageHeading?.innerText || document.title).trim()
  const pageText = (document.body?.innerText || '').replace(/\s+/gu, ' ')
  const blocked = /请完成安全验证|(?:访问|操作|请求)(?:行为)?(?:过于)?频繁|(?:访问行为|访问环境|网络环境|IP)(?:存在)?异常|(?:访问|请求)已被限制|请解除限制后访问|请拖动(?:滑块|下方)|滑动(?:滑块|验证)|verify you are human|access denied|unusual traffic|cookies support required|系统检测到.{0,30}(?:机器人|异常)|人机身份验证|正在验证.{0,12}浏览器/iu.test(pageText)
    || /^(?:安全验证|访问验证|人机验证|security verification|access denied)$/iu.test(document.title.trim())
    || boss && /^\/web\/common\/security-check(?:\.html)?\/?$/u.test(pageURL.pathname)
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
  const hasDuties = /岗位职责|工作职责|职位描述|任职要求|职位要求|工作内容|职责描述|job description|responsibilit/iu.test(body)
  const login = [...document.querySelectorAll('input[type=password],input[autocomplete=one-time-code]')].some(visible)
    || !hasDuties && (/^passport\./iu.test(pageURL.hostname) || /\/(?:login|signin|passport)(?:[./_-]|$)/iu.test(pageURL.pathname) || /扫码登录|短信登录|手机验证码登录/u.test(pageText))
  const unavailable = unavailableReason(pageText)
  return { title, body: unavailable ? '' : body, url: sourceURL, blocked, login: unavailable ? false : login, unavailable_reason: unavailable }
}

const pageReaderSource = () => `(document) => (${readJdPage.toString()})(document, ${jdUnavailableReason.toString()})`

/** Watch DOM changes without polling; navigation and replacement dispose the renderer observer.
 * @param document - Capture page document.
 * @param readPage - Pure page classifier serialized into the same isolated renderer evaluation.
 * @param throttleMs - Minimum delay between scans after DOM changes.
 * @param key - Host-owned observer slot used to replace an earlier watch in this document.
 * @param ready - Optional complete-JD predicate armed for one automatic delivery.
 * @param generation - Monotonic host watch generation; deferred older injections cannot replace a newer observer.
 * @returns True for a security challenge, ready for complete text, or false after pagehide/replacement.
 */
export function monitorJdSecurity(document, readPage, throttleMs, key, ready, generation = 0) {
  const view = document.defaultView
  if ((view[key]?.generation || 0) > generation) return Promise.resolve(false)
  view[key]?.()
  return new Promise(resolve => {
    let timer
    let readyTimer
    let finished = false
    const finish = blocked => {
      if (finished) return
      finished = true
      view.clearTimeout(timer)
      view.clearTimeout(readyTimer)
      observer.disconnect()
      view.removeEventListener('pagehide', pagehide)
      if (view[key] === cancel) view[key] = Object.assign(() => undefined, { generation })
      resolve(blocked)
    }
    const cancel = () => finish(false)
    cancel.generation = generation
    const pagehide = () => finish(false)
    const scan = checkReady => {
      timer = undefined
      const page = readPage(document)
      if (page.blocked) finish(true)
      else if (checkReady && ready?.(page)) finish('ready')
    }
    const observer = new view.MutationObserver(() => {
      if (timer === undefined) timer = view.setTimeout(() => scan(false), throttleMs)
      if (ready) {
        view.clearTimeout(readyTimer)
        readyTimer = view.setTimeout(() => scan(true), throttleMs)
      }
    })
    view[key] = cancel
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
    view.addEventListener('pagehide', pagehide, { once: true })
    scan(false)
    if (ready && !finished) readyTimer = view.setTimeout(() => scan(true), throttleMs)
  })
}

/**
 * Own all capture windows until explicit close or application shutdown.
 * @param options - Electron constructors, private desktop data directory, and capture limits.
 * @returns Rendered collection, reusable login windows, explicit verification/resume, platform status and PDF operations. Security challenges persistently stop automatic network access. No cookie or arbitrary script API is exposed.
 */
export function createJdBrowser({ BrowserWindow, maxCaptureChars, loadTimeoutMs, dataDirectory, onPending }) {
  const captures = new Map()
  const platformWindows = new Map()
  const protectedSessions = new WeakSet()
  const contentsStates = new Map()
  let collection
  let disposed = false
  let automaticError
  const policy = () => collection ||= createJdCollection({ dataDirectory })
  const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  const blockedItem = url => ({ state: 'blocked', url, message: '平台触发了安全验证或访问限制，已停止重复采集及后台访问。请点击“处理平台验证”，亲自验证后恢复；也可导入已获授权的原文。' })
  const validateId = id => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new Error('采集项目标识无效')
    if (disposed) throw new Error('JD 采集服务已关闭')
  }
  const activeWindow = state => state && (state.activeWindow && !state.activeWindow.isDestroyed() ? state.activeWindow : [...state.windows].find(window => !window.isDestroyed()))
  const notifyPending = () => {
    try { onPending?.() }
    catch { /* A closing workbench can reject a wake-up; the durable inbox is replayed by its next pending read. */ }
  }
  const persistDelivery = (projectId, requestedURL, item) => {
    const added = policy().enqueue({ project_id: projectId, requested_url: requestedURL, item })
    automaticError = undefined
    return added
  }
  const deliver = (state, item) => {
    if (!state.autoCapture || state.verification || policy().blocked(state.sourceURL)) return
    const added = persistDelivery(state.ownerId, state.requestedURL, item)
    state.autoCapture = false
    automaticError = undefined
    for (const capture of state.windows) startMonitor(capture, state)
    if (added) notifyPending()
  }
  const stopPlatform = (url, reason) => {
    try { policy().block(url, reason) }
    finally {
      for (const state of platformWindows.values()) if (state.platform === jdPlatform(url)) {
        state.verification = false
        state.autoCapture = false
        for (const window of state.windows) if (!window.isDestroyed()) window.webContents.stop?.()
      }
    }
  }
  const startMonitor = (window, state, allowReady = true) => {
    if (disposed || window.isDestroyed() || state.verification || state.suspended || policy().blocked(state.sourceURL)) return
    const epoch = window.jdMonitorEpoch = (window.jdMonitorEpoch || 0) + 1
    const binding = state.bindingGeneration
    const ownerId = state.ownerId
    const current = () => !disposed && !window.isDestroyed() && state.bindingGeneration === binding && state.ownerId === ownerId && window.jdMonitorEpoch === epoch && !state.verification && !state.suspended && !policy().blocked(state.sourceURL)
    window.jdMonitorKey ||= '__corchJdSecurity_' + randomUUID()
    const ready = state.autoCapture && allowReady ? `(page) => !page.unavailable_reason && page.url !== null && !page.login && !(${jdLoginWall.toString()})(page.body) && !/请先登录|登录后(?:才能|可查看|查看)|扫码查看/u.test(page.body) && (${jdHasDuties.toString()})(page.body)` : 'undefined'
    const script = `(${monitorJdSecurity.toString()})(document, ${pageReaderSource()}, ${policy().settings.render_settle_ms}, ${JSON.stringify(window.jdMonitorKey)}, ${ready}, ${epoch})`
    void window.webContents.executeJavaScript(script).then(async result => {
      if (!current()) return
      if (result === true) { stopPlatform(state.sourceURL, '页面动态显示安全验证或访问限制，自动访问已停止'); return }
      if (result !== 'ready' || !state.autoCapture) return
      if (window.webContents.isLoadingMainFrame()) { startMonitor(window, state, false); return }
      try {
        const item = await inspect(state, { captureWindow: window, isActive: current })
        if (current() && item.state === 'captured') deliver(state, item)
      } catch (error) {
        if (current()) { automaticError = error; state.autoCapture = false; notifyPending() }
      } finally { if (current()) startMonitor(window, state) }
    }, () => { /* Navigation or window destruction discards the renderer watch; dom-ready installs the next one. */ })
  }
  const protect = (window, state) => {
    const contentsId = window.webContents.id
    state.windows.add(window)
    state.activeWindow = window
    contentsStates.set(contentsId, state)
    window.on('focus', () => { state.activeWindow = window })
    window.setMenu(null)
    window.setTitle(CAPTURE_WINDOW_TITLE)
    const horizontalFrame = Math.max(0, window.getSize()[0] - window.getContentSize()[0])
    window.setMinimumSize(1280 + horizontalFrame, window.getMinimumSize()[1])
    window.on('page-title-updated', event => event.preventDefault())
    for (const eventName of ['will-navigate', 'will-redirect']) window.webContents.on(eventName, (event, destination) => {
      try {
        safeURL(destination)
        if (!state.verification && (policy().blocked(state.sourceURL) || policy().blocked(destination))) event.preventDefault()
        else if (!state.verification && jdChallengeURL(destination)) {
          event.preventDefault()
          stopPlatform(state.sourceURL, '平台跳转到安全验证页面，自动访问已停止')
        }
      } catch { event.preventDefault() }
    })
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) window.jdMonitorEpoch = (window.jdMonitorEpoch || 0) + 1
    })
    window.webContents.on('dom-ready', () => startMonitor(window, state))
    window.webContents.on('did-stop-loading', () => startMonitor(window, state))
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        safeURL(url)
        if (!state.verification && (policy().blocked(state.sourceURL) || policy().blocked(url))) return { action: 'deny' }
        if (!state.verification && jdChallengeURL(url)) { stopPlatform(state.sourceURL, '平台打开安全验证页面，自动访问已停止'); return { action: 'deny' } }
      } catch { return { action: 'deny' } }
      return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { width: 1360, height: 860, useContentSize: true, webPreferences: { ...preferences, session: window.webContents.session } } }
    })
    window.webContents.on('did-create-window', popup => protect(popup, state))
    const browserSession = window.webContents.session
    if (!protectedSessions.has(browserSession)) {
      protectedSessions.add(browserSession)
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      browserSession.setPermissionCheckHandler(() => false)
      browserSession.on('will-download', event => event.preventDefault())
      browserSession.webRequest.onBeforeRequest((details, callback) => {
        const owner = contentsStates.get(details.webContentsId)
        if (!owner) return callback({ cancel: policy().statuses().some(item => item.blocked) })
        try {
          const blocked = policy().blocked(owner.sourceURL) || policy().blocked(details.url)
          if (!owner.verification && details.resourceType === 'mainFrame' && jdChallengeURL(details.url)) {
            stopPlatform(owner.sourceURL, '平台要求安全验证，自动访问已停止')
            return callback({ cancel: true })
          }
          if ((blocked || owner.suspended) && !owner.verification) return callback({ cancel: true })
          if (details.resourceType === 'mainFrame' && !owner.verification) {
            if (owner.authorizedNavigation === details.url) {
              owner.authorizedNavigation = undefined
              return callback({ cancel: false })
            }
            void policy().reserve(details.url).then(permission => callback({ cancel: disposed || owner.suspended || permission !== 'allowed' || policy().blocked(owner.sourceURL) || policy().blocked(details.url) }), () => callback({ cancel: true }))
            return
          }
          callback({ cancel: false })
        } catch { callback({ cancel: true }) }
      })
      browserSession.webRequest.onHeadersReceived((details, callback) => {
        const owner = contentsStates.get(details.webContentsId)
        if (owner && !owner.verification && details.statusCode === 429) {
          stopPlatform(owner.sourceURL, `平台返回 HTTP ${details.statusCode}，自动访问已停止`)
          return callback({ cancel: true })
        }
        callback({ cancel: false })
      })
    }
    window.once('closed', () => {
      window.jdMonitorEpoch = (window.jdMonitorEpoch || 0) + 1
      contentsStates.delete(contentsId)
      state.windows.delete(window)
      if (state.activeWindow === window) state.activeWindow = [...state.windows].find(candidate => !candidate.isDestroyed())
    })
  }
  const getState = (id, url) => {
    const key = jdPlatform(url)
    let state = platformWindows.get(key)
    if (!state) {
      state = { sourceURL: url, platform: key, windows: new Set(), verification: false }
      platformWindows.set(key, state)
    }
    captures.set(id, state)
    state.bindingGeneration = (state.bindingGeneration || 0) + 1
    state.ownerId = id
    state.requestedURL = url
    return state
  }
  const windowFor = state => {
    let window = activeWindow(state)
    if (!window) {
      window = new BrowserWindow({ title: CAPTURE_WINDOW_TITLE, width: 1360, height: 860, useContentSize: true,
        webPreferences: { ...preferences, partition: 'persist:jd-research' } })
      protect(window, state)
    }
    return window
  }
  const inspect = async (state, { allowResume = false, isActive = () => true, captureWindow } = {}) => {
    const window = captureWindow || activeWindow(state)
    const binding = state?.bindingGeneration
    if (!window) throw new Error('采集窗口已关闭，请重新打开来源')
    if (policy().blocked(state.sourceURL) && !allowResume) return blockedItem(state.sourceURL)
    if (window.webContents.isLoadingMainFrame()) throw new Error('页面仍在加载，请稍后继续采集')
    const actualURL = safeURL(window.webContents.getURL())
    const result = await window.webContents.executeJavaScript(`(${pageReaderSource()})(document)`)
    if (!isActive() || state.bindingGeneration !== binding) throw new Error('岗位页面采集已停止或已切换搜索')
    if (policy().blocked(state.sourceURL) && !allowResume) return blockedItem(state.sourceURL)
    if (result.blocked || jdChallengeURL(actualURL)) {
      stopPlatform(state.sourceURL, '页面显示安全验证或访问限制，自动访问已停止')
      return blockedItem(state.sourceURL)
    }
    state.unavailableReason = result.unavailable_reason
    if (result.unavailable_reason) {
      state.autoCapture = false
      policy().cacheUnavailable(state.sourceURL, result.unavailable_reason)
      return { state: 'not_a_jd', url: state.sourceURL, message: result.unavailable_reason }
    }
    if (result.login || jdLoginWall(result.body) || /请先登录|登录后(?:才能|可查看|查看)|扫码查看/u.test(result.body)) {
      policy().login(state.sourceURL, true)
      return { state: 'login_required', url: state.sourceURL, message: '尚未取得 JD 正文，请在采集窗口完成登录，并打开具体岗位详情。同一平台会保留当前登录，不必逐条登录。' }
    }
    if (!jdHasDuties(result.body)) return { state: 'not_a_jd', url: state.sourceURL, message: '当前页面没有可用的岗位职责或任职要求正文，请打开具体岗位详情。' }
    if (result.url === null) return { state: 'source_unresolved', url: state.sourceURL, message: '当前列表页无法唯一确认岗位详情链接；请从岗位标题打开独立详情页，再继续采集。' }
    if (result.body.length > maxCaptureChars) throw new Error('岗位页面超过正文大小限制；请使用“导入原文”提交具体岗位正文')
    const body = result.body.trim()
    const sourceURL = safeURL(result.url)
    if (jdPlatform(sourceURL) !== state.platform) return { state: 'not_a_jd', url: state.sourceURL, message: '当前页面属于其他平台，请从对应来源重新打开采集。' }
    const item = { state: 'captured', url: sourceURL, title: result.title, body, captured_at: new Date().toISOString(), content_hash: createHash('sha256').update(body).digest('hex'), cached: false }
    if (allowResume) policy().resume(state.sourceURL)
    const wasVerification = state.verification
    state.verification = false
    if (wasVerification) for (const capture of state.windows) startMonitor(capture, state)
    policy().login(state.sourceURL, false)
    if (state.sourceURL !== sourceURL) policy().cache(state.sourceURL, item)
    policy().cache(sourceURL, item)
    return item
  }
  const navigate = async (state, url) => {
    const permission = await policy().reserve(url)
    if (disposed) throw new Error('JD 采集服务已关闭')
    if (permission === 'blocked') return blockedItem(url)
    if (permission === 'rate_limited') return { state: 'rate_limited', url, message: '该平台已达到每小时访问上限，已停止本次访问；请稍后再试或导入已获授权的原文。' }
    const window = windowFor(state)
    state.sourceURL = url
    state.verification = false
    state.suspended = false
    state.authorizedNavigation = url
    window.show(); window.restore(); window.focus()
    let timer
    let active = true
    try {
      const operation = async () => {
        try { await window.loadURL(url) }
        catch (error) {
          if (policy().blocked(url)) return blockedItem(url)
          // A page's own redirect or reload can replace the initial load promise.
          if (error.code !== 'ERR_ABORTED' && error.errno !== -3 && !window.webContents.isLoadingMainFrame()) throw error
        }
        while (active && !disposed && !window.isDestroyed()) {
          if (policy().blocked(url)) return blockedItem(url)
          await new Promise(resolve => setTimeout(resolve, policy().settings.render_settle_ms))
          if (!active || disposed || window.isDestroyed()) break
          if (policy().blocked(url)) return blockedItem(url)
          if (window.webContents.isLoadingMainFrame()) continue
          try {
            const item = await inspect(state, { isActive: () => active && !disposed && !window.isDestroyed() })
            if (item.state !== 'not_a_jd' || state.unavailableReason) return item
          } catch (error) {
            if (!window.webContents.isLoadingMainFrame()) throw error
          }
        }
        throw new Error('岗位页面采集已停止')
      }
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => {
          active = false
          state.suspended = true
          window.webContents.stop?.()
          reject(new Error('岗位页面加载或正文渲染超时，已停止后台访问，未自动重试'))
        }, loadTimeoutMs)
      })])
    } catch (error) {
      if (policy().blocked(url)) return blockedItem(url)
      return { state: 'failed', url, message: error.message }
    } finally { active = false; clearTimeout(timer) }
  }
  return {
    async open(input) {
      validateId(input.id)
      const url = safeURL(input.url)
      if (policy().blocked(url)) return blockedItem(url)
      const state = getState(input.id, url)
      state.autoCapture = true
      const binding = state.bindingGeneration
      const existing = activeWindow(state)
      if (existing && state.sourceURL === url && !state.suspended) {
        existing.show(); existing.restore(); existing.focus()
        startMonitor(existing, state)
        return { id: input.id, state: 'opened' }
      }
      return policy().run(url, async () => {
        if (state.bindingGeneration !== binding) return { state: 'failed', url, message: '采集来源已切换，此次打开已停止。' }
        const item = await navigate(state, url)
        if (item.state === 'captured' && state.bindingGeneration === binding) deliver(state, item)
        return ['blocked', 'rate_limited'].includes(item.state) ? item : { id: input.id, state: 'opened' }
      })
    },
    async collect(input) {
      validateId(input.id)
      if (!Array.isArray(input.sources) || input.sources.length > 100) throw new Error('候选来源数量无效或超过 100 条请求上限')
      const sources = input.sources.map(source => ({ url: safeURL(source.url), title: typeof source.title === 'string' ? source.title : '' }))
      const items = []
      for (const source of sources.slice(0, policy().settings.max_sources_per_batch)) items.push(await policy().run(source.url, async () => {
        const cached = policy().cached(source.url)
        if (cached) {
          if (cached.state === 'captured' && persistDelivery(input.id, source.url, cached)) notifyPending()
          return cached
        }
        if (policy().blocked(source.url)) return blockedItem(source.url)
        const existing = platformWindows.get(jdPlatform(source.url))
        if (existing?.verification || policy().statuses().find(item => item.platform === jdPlatform(source.url))?.login_required) return { state: 'login_required', url: source.url, message: '该平台正在等待你完成登录或验证，已暂停自动打开其他岗位。' }
        const state = getState(input.id, source.url)
        const binding = state.bindingGeneration
        state.autoCapture = false
        const item = await navigate(state, source.url)
        if (item.state === 'captured' && state.bindingGeneration === binding && persistDelivery(input.id, source.url, item)) notifyPending()
        if (item.state === 'login_required') {
          state.autoCapture = true
          for (const capture of state.windows) startMonitor(capture, state)
        }
        return item
      }))
      for (const source of sources.slice(policy().settings.max_sources_per_batch)) items.push({ state: 'failed', ...source, message: `本批最多采集 ${policy().settings.max_sources_per_batch} 条；该来源保留待采集，请分批继续。` })
      return { items, platforms: policy().statuses() }
    },
    platforms() { return policy().statuses() },
    pending() {
      if (automaticError) throw new Error('自动采集未保存：' + automaticError.message)
      return policy().pending()
    },
    ack(input) { return policy().ack(input) },
    async verify(input) {
      validateId(input.id)
      const url = safeURL(input.url)
      const state = getState(input.id, url)
      state.autoCapture = false
      if (!policy().blocked(url)) return { state: 'failed', url, message: '该平台没有待处理的安全验证，请使用普通采集入口。' }
      state.sourceURL = url
      state.verification = true
      state.suspended = false
      const window = windowFor(state)
      window.show(); window.restore(); window.focus()
      void window.loadURL(url).catch(() => { /* Human verification keeps a failed page visible without scheduling a retry. */ })
      return { id: input.id, state: 'opened' }
    },
    async resume(input) {
      validateId(input.id)
      const state = input.url ? platformWindows.get(jdPlatform(safeURL(input.url))) : captures.get(input.id)
      if (state?.ownerId !== input.id) return { item: { state: 'failed', url: input.url || '', message: '采集窗口已切换到其他搜索，请重新打开当前来源。' }, platforms: policy().statuses() }
      if (!state?.verification) return { item: { state: 'failed', url: input.url || '', message: '请先打开“处理平台验证”，完成平台提示后再恢复采集。' }, platforms: policy().statuses() }
      const item = await inspect(state, { allowResume: true })
      if (item.state === 'captured') state.autoCapture = false
      return { item, platforms: policy().statuses() }
    },
    status(input) {
      const state = captures.get(input.id)
      return { state: state?.ownerId === input.id && activeWindow(state) ? 'opened' : 'closed' }
    },
    async read(input) {
      validateId(input.id)
      const state = input.url ? platformWindows.get(jdPlatform(safeURL(input.url))) : captures.get(input.id)
      if (state && state.ownerId !== input.id) return { state: 'failed', url: input.url || '', message: '采集窗口已切换到其他搜索，请重新打开当前来源。' }
      const item = await inspect(state)
      if (item.state === 'captured') {
        state.autoCapture = false
        for (const capture of state.windows) startMonitor(capture, state)
      }
      return item
    },
    close(input) {
      const state = captures.get(input.id)
      if (state?.ownerId === input.id) for (const window of state.windows) if (!window.isDestroyed()) window.destroy()
      captures.delete(input.id)
    },
    dispose() {
      disposed = true
      collection?.dispose()
      for (const state of platformWindows.values()) for (const window of state.windows) if (!window.isDestroyed()) window.destroy()
      captures.clear()
      platformWindows.clear()
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
