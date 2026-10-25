/** Private rendered-JD cache and persistent platform navigation limits. Browser cookies remain in Chromium's session store. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULTS = { min_interval_ms: 10000, cache_ttl_ms: 86400000, max_navigations_per_hour: 12, max_sources_per_batch: 20, render_settle_ms: 1500 }
const RANGES = { min_interval_ms: [100, 300000], cache_ttl_ms: [1000, 604800000], max_navigations_per_hour: [1, 100], max_sources_per_batch: [1, 100], render_settle_ms: [100, 10000] }
const PLATFORM_DOMAINS = ['zhipin.com', 'zhaopin.com', '51job.com', 'quanzhi.com', 'cdpdrc.com']

/** Group known platform subdomains; unknown sites retain their exact hostname instead of guessing a public suffix.
 * @param value - Absolute source URL.
 * @returns Stable platform identifier.
 */
export function jdPlatform(value) {
  const host = new URL(value).hostname.toLowerCase()
  return PLATFORM_DOMAINS.find(domain => host === domain || host.endsWith('.' + domain)) || host
}

/** Reject unsafe schemes and embedded credentials before browser navigation or durable storage.
 * @param value - Candidate source URL.
 * @returns HTTPS URL without a fragment; loopback HTTP is allowed for local acceptance.
 */
export function jdSourceURL(value) {
  const url = new URL(value)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error('采集地址须使用 HTTPS；仅本机测试允许 HTTP')
  url.hash = ''
  return url.href
}

/** Detect navigation to an explicit security challenge before allowing its subrequests.
 * @param value - Absolute destination URL.
 * @returns Whether the destination is a known challenge route.
 */
export function jdChallengeURL(value) {
  const url = new URL(value)
  return /\/(?:security-check|captcha|waf[-_/]?verify|antibot|challenge)(?:[./_-]|$)/iu.test(url.pathname)
}

/** Recognize an explicit login wall that withholds part of an otherwise visible JD.
 * @param body - Rendered original or previously cached original text.
 * @returns Whether the platform explicitly requires login to reveal the complete content.
 */
export function jdLoginWall(body) {
  return /(?:登录|登陆)(?:后)?(?:即可|可|才能|才可)?(?:查看|获取|解锁|阅读|显示)(?:完整(?:内容|职位|信息|岗位|详情|描述|任职要求|岗位职责|JD)|全部(?:内容|信息|详情|描述))|(?:完整)(?:职位|岗位|内容|信息|详情).{0,12}(?:登录|登陆)(?:后)?(?:查看|可见)/iu.test(body)
}

/** Require responsibilities or requirements followed by actual text, rather than an empty heading or loading placeholder.
 * @param body - Rendered JD text.
 * @returns Whether a recognized section contains substantive text.
 */
export function jdHasDuties(body) {
  const match = /(?:岗位职责|工作职责|职位描述|任职要求|职位要求|工作内容|职责描述|job description|responsibilit(?:y|ies)?)[\s:：]*([\s\S]+)/iu.exec(body)
  if (!match) return false
  const content = match[1].replace(/岗位职责|工作职责|职位描述|任职要求|职位要求|工作内容|职责描述|job description|responsibilit(?:y|ies)?/giu, '').replace(/[^\p{L}\p{N}]/gu, '')
  return content.length >= 4 && !/^(?:正在)?加载(?:中)?(?:请稍候|请稍后)?$/u.test(content)
}

/** Identify an expired source page before considering duties shown in recommendations.
 * @param body - Visible page text or a previously cached original.
 * @returns Explicit unavailability reason, or an empty string when no unavailable-page marker is present.
 */
export function jdUnavailableReason(body) {
  return /您查看的内容(?:已)?不存在|(?:您查看的|该|此)(?:职位|岗位|招聘信息|职位信息)(?:已|已经)(?:失效|下线|关闭|删除|过期|停止招聘)|(?:该|此)(?:职位|岗位|招聘信息|职位信息)不存在/u.test(body)
    ? '该岗位已失效或内容不存在，未采集页面上的推荐职位；请选择其他有效岗位来源。'
    : ''
}

/** Persist policy and successful originals outside research projects; malformed settings or durable state fail closed.
 * @param options - Desktop data directory; omitted only by in-memory browser fixtures.
 * @returns Cache, circuit-breaker, sequential scheduling, and request-budget operations.
 */
export function createJdCollection({ dataDirectory } = {}) {
  const directory = dataDirectory && join(dataDirectory, 'jd-collection')
  const settingsPath = dataDirectory && join(dataDirectory, 'jd-collection-settings.json')
  if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const atomic = (path, value) => {
    const temporary = path + '.' + randomUUID() + '.tmp'
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  }
  if (settingsPath && !existsSync(settingsPath)) atomic(settingsPath, DEFAULTS)
  const settings = settingsPath ? JSON.parse(readFileSync(settingsPath, 'utf8')) : { ...DEFAULTS }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !Object.hasOwn(RANGES, key))) throw new Error('jd-collection-settings.json 字段无效')
  for (const [key, [minimum, maximum]] of Object.entries(RANGES)) if (!Number.isInteger(settings[key]) || settings[key] < minimum || settings[key] > maximum) throw new Error(`jd-collection-settings.json 的 ${key} 须为 ${minimum}–${maximum} 的整数`)
  const statePath = directory && join(directory, 'platforms.json')
  const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { version: 1, platforms: {} }
  if (state?.version !== 1 || !state.platforms || typeof state.platforms !== 'object' || Array.isArray(state.platforms)) throw new Error('JD 平台策略记录无效，已停止采集')
  for (const value of Object.values(state.platforms)) if (!value || typeof value.blocked !== 'boolean' || !Array.isArray(value.navigations) || value.navigations.some(time => !Number.isFinite(time) || time < 0) || !Number.isFinite(value.last_navigation) || value.last_navigation < 0 || value.reason !== undefined && typeof value.reason !== 'string' || value.blocked_at !== undefined && !Number.isFinite(Date.parse(value.blocked_at)) || value.login_required !== undefined && typeof value.login_required !== 'boolean' || value.cache_count !== undefined && (!Number.isInteger(value.cache_count) || value.cache_count < 0)) throw new Error('JD 平台策略记录无效，已停止采集')
  for (const value of Object.values(state.platforms)) if (value.block_generation !== undefined && (!Number.isSafeInteger(value.block_generation) || value.block_generation < 0)) throw new Error('JD 平台风控代次无效，已停止采集')
  state.platforms = Object.assign(Object.create(null), state.platforms)
  const queues = new Map()
  const navigationQueues = new Map()
  const waits = new Set()
  let disposed = false
  const memoryCache = new Map()
  const inboxPath = directory && join(directory, 'inbox.json')
  let inbox = inboxPath && existsSync(inboxPath) ? JSON.parse(readFileSync(inboxPath, 'utf8')) : { version: 1, deliveries: [], acknowledged: [] }
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value)
  const validCaptured = item => item?.state === 'captured' && typeof item.body === 'string' && typeof item.title === 'string' && typeof item.cached === 'boolean' && Number.isFinite(Date.parse(item.captured_at)) && createHash('sha256').update(item.body).digest('hex') === item.content_hash && jdSourceURL(item.url) === item.url && !jdLoginWall(item.body) && !jdUnavailableReason(item.body) && jdHasDuties(item.body)
  const deliveryId = (projectId, item) => createHash('sha256').update(projectId + '\0' + item.url + '\0' + item.content_hash).digest('hex')
  if (inbox?.version !== 1 || !Array.isArray(inbox.deliveries) || !Array.isArray(inbox.acknowledged) || inbox.acknowledged.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id))) throw new Error('JD 自动采集投递记录无效，已停止自动保存')
  for (const delivery of inbox.deliveries) if (!validId(delivery.project_id) || jdSourceURL(delivery.requested_url) !== delivery.requested_url || !validCaptured(delivery.item) || delivery.id !== deliveryId(delivery.project_id, delivery.item) || jdPlatform(delivery.requested_url) !== jdPlatform(delivery.item.url)) throw new Error('JD 自动采集投递正文或来源校验失败，已停止自动保存')
  if (new Set([...inbox.deliveries.map(item => item.id), ...inbox.acknowledged]).size !== inbox.deliveries.length + inbox.acknowledged.length) throw new Error('JD 自动采集投递标识重复，已停止自动保存')
  const saveInbox = next => { if (inboxPath) atomic(inboxPath, next); inbox = next }
  const platform = key => state.platforms[key] ||= { blocked: false, navigations: [], last_navigation: 0, login_required: false }
  const save = () => { if (statePath) atomic(statePath, state) }
  const cacheKey = url => createHash('sha256').update(jdSourceURL(url)).digest('hex')
  const storedCache = key => {
    const file = directory && join(directory, key + '.json')
    return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : memoryCache.get(key)
  }
  const cacheRead = url => {
    const key = cacheKey(url)
    const item = storedCache(key)
    if (!item) return undefined
    if (item.state === 'not_a_jd' && item.unavailable === true) {
      if (jdSourceURL(item.url) !== jdSourceURL(url) || typeof item.message !== 'string' || !Number.isFinite(Date.parse(item.classified_at))) throw new Error('JD 失效来源缓存校验失败')
      const age = Date.now() - Date.parse(item.classified_at)
      return age >= 0 && age <= settings.cache_ttl_ms ? { state: 'not_a_jd', url: item.url, message: item.message } : undefined
    }
    if (item.state !== 'captured' || typeof item.body !== 'string' || typeof item.title !== 'string' || !Number.isFinite(Date.parse(item.captured_at)) || createHash('sha256').update(item.body).digest('hex') !== item.content_hash || jdSourceURL(item.url) !== item.url || jdPlatform(item.url) !== jdPlatform(url)) throw new Error('JD 原文缓存校验失败，已停止使用该缓存')
    const unavailable = jdUnavailableReason(item.body)
    if (unavailable) return { state: 'not_a_jd', url: item.url, message: unavailable }
    if (jdLoginWall(item.body)) {
      platform(jdPlatform(url)).login_required = true
      save()
      return { state: 'login_required', url: item.url, message: '已有记录包含“登录查看完整内容”等提示，属于部分公开正文，未作为完整 JD 使用。请登录后重新采集完整岗位。' }
    }
    if (!jdHasDuties(item.body)) return undefined
    const hostname = new URL(url).hostname
    const scoped = jdPlatform(url) === 'zhaopin.com' || hostname === '58.com' || hostname.endsWith('.58.com')
    if (scoped && item.extraction_version !== 2) return undefined
    const age = Date.now() - Date.parse(item.captured_at)
    if (age < 0 || age > settings.cache_ttl_ms) return undefined
    const { extraction_version: _version, ...captured } = item
    return { ...captured, cached: true }
  }
  return {
    settings,
    pending() { return { deliveries: structuredClone(inbox.deliveries) } },
    enqueue({ project_id: projectId, requested_url: requestedURL, item }) {
      if (!validId(projectId) || jdSourceURL(requestedURL) !== requestedURL || !validCaptured(item) || jdPlatform(requestedURL) !== jdPlatform(item.url)) throw new Error('自动采集的项目、完整正文或来源无效，未保存')
      const id = deliveryId(projectId, item)
      if (inbox.acknowledged.includes(id) || inbox.deliveries.some(delivery => delivery.id === id)) return false
      saveInbox({ ...inbox, deliveries: [...inbox.deliveries, { id, project_id: projectId, requested_url: requestedURL, item: structuredClone(item) }] })
      return true
    },
    ack(input) {
      if (!Array.isArray(input?.ids) || input.ids.length > 1000 || input.ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id))) throw new Error('自动采集确认标识无效')
      const confirmed = inbox.deliveries.filter(item => input.ids.includes(item.id)).map(item => item.id)
      if (confirmed.length) saveInbox({ ...inbox, deliveries: inbox.deliveries.filter(item => !confirmed.includes(item.id)), acknowledged: [...inbox.acknowledged, ...confirmed] })
    },
    blocked(url) { return state.platforms[jdPlatform(url)]?.blocked || false },
    block(url, reason) {
      const value = platform(jdPlatform(url))
      Object.assign(value, { blocked: true, reason, blocked_at: new Date().toISOString(), block_generation: (value.block_generation || 0) + 1 })
      save()
    },
    resume(url) {
      Object.assign(platform(jdPlatform(url)), { blocked: false, reason: undefined, blocked_at: undefined, login_required: false })
      save()
    },
    login(url, required) { platform(jdPlatform(url)).login_required = required; save() },
    cached: cacheRead,
    cache(url, item) {
      if (jdLoginWall(item.body)) throw new Error('包含登录墙的部分 JD 不能保存为完整原文缓存')
      if (!jdHasDuties(item.body)) throw new Error('未取得实质岗位职责或任职要求，不能保存为完整原文缓存')
      if (jdUnavailableReason(item.body)) throw new Error('已失效来源不能保存推荐职位为原文缓存')
      const value = { state: 'captured', url: item.url, title: item.title, body: item.body, captured_at: item.captured_at, content_hash: item.content_hash, cached: false, extraction_version: 2 }
      const key = cacheKey(url)
      const wasCaptured = storedCache(key)?.state === 'captured'
      if (directory) atomic(join(directory, key + '.json'), value)
      else memoryCache.set(key, value)
      platform(jdPlatform(url)).cache_count = (platform(jdPlatform(url)).cache_count || 0) + (wasCaptured ? 0 : 1)
      save()
    },
    cacheUnavailable(url, message) {
      const key = cacheKey(url)
      const wasCaptured = storedCache(key)?.state === 'captured'
      const value = { state: 'not_a_jd', unavailable: true, url: jdSourceURL(url), message, classified_at: new Date().toISOString() }
      if (directory) atomic(join(directory, key + '.json'), value)
      else memoryCache.set(key, value)
      if (wasCaptured) {
        platform(jdPlatform(url)).cache_count = Math.max(0, (platform(jdPlatform(url)).cache_count || 0) - 1)
        save()
      }
    },
    statuses() {
      return Object.entries(state.platforms).map(([key, value]) => ({ platform: key, blocked: value.blocked, reason: value.reason, blocked_at: value.blocked_at, cache_count: value.cache_count || 0, login_required: value.login_required || false, next_navigation_at: new Date(value.last_navigation + settings.min_interval_ms).toISOString() }))
    },
    async run(url, task) {
      const key = jdPlatform(url)
      const generation = platform(key).block_generation || 0
      const previous = queues.get(key) || Promise.resolve()
      const current = previous.catch(() => undefined).then(() => {
        if (disposed) throw new Error('JD 采集策略已关闭')
        if ((platform(key).block_generation || 0) !== generation) return { state: 'blocked', url, message: '此任务在平台风控前排队，已停止；完成验证后请重新发起采集。' }
        return task()
      })
      queues.set(key, current)
      try { return await current }
      finally { if (queues.get(key) === current) queues.delete(key) }
    },
    reserve(url) {
      const key = jdPlatform(url)
      const generation = platform(key).block_generation || 0
      const initiallyBlocked = platform(key).blocked
      const previous = navigationQueues.get(key) || Promise.resolve()
      const current = previous.catch(() => undefined).then(async () => {
        const value = platform(jdPlatform(url))
        if (initiallyBlocked || value.blocked || (value.block_generation || 0) !== generation) return 'blocked'
        if (value.last_navigation > Date.now()) return 'rate_limited'
        const delay = value.last_navigation + settings.min_interval_ms - Date.now()
        if (delay > 0) await new Promise(resolve => {
          const done = () => { clearTimeout(timer); waits.delete(done); resolve() }
          const timer = setTimeout(done, delay)
          waits.add(done)
        })
        if (disposed) throw new Error('JD 采集策略已关闭')
        if (value.blocked || (value.block_generation || 0) !== generation) return 'blocked'
        value.navigations = value.navigations.filter(time => time > Date.now() - 3600000)
        if (value.navigations.length >= settings.max_navigations_per_hour) return 'rate_limited'
        value.last_navigation = Date.now()
        value.navigations.push(value.last_navigation)
        save()
        return 'allowed'
      })
      navigationQueues.set(key, current)
      return current.finally(() => { if (navigationQueues.get(key) === current) navigationQueues.delete(key) })
    },
    dispose() { disposed = true; for (const done of waits) done() },
  }
}
