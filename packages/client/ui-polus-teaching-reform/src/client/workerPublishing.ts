/** Existing Worker admin sessions authorize publication on the Worker's own origin. */
const WORKER_ORIGIN_KEY = 'dsh.practice-expert-worker-origin.v1'

/** Validated Worker receipt retained with the last successfully published package version. */
export type WorkerPublicationReceipt = { key: string; hash: string; url: string; version: number }

/** Validate a persisted share receipt before rendering its URL.
 * @param value - Browser-persisted publication metadata.
 * @returns a valid receipt, or undefined when it does not match the participant URL format.
 */
export function readWorkerReceipt(value: unknown): WorkerPublicationReceipt | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Partial<WorkerPublicationReceipt>
  if (typeof item.key !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.key) || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash) || typeof item.version !== 'number' || !Number.isSafeInteger(item.version) || item.version < 1 || typeof item.url !== 'string') return undefined
  try {
    const url = new URL(item.url)
    normalizeWorkerOrigin(url.origin)
    if (url.username || url.password || url.pathname !== '/' || url.searchParams.get('fieldnoteId') !== item.key || [...url.searchParams.keys()].some(key => key !== 'fieldnoteId') || [...new URLSearchParams(url.hash.slice(1)).keys()].some(key => key !== 'code')) return undefined
    return { key: item.key, hash: item.hash, version: item.version, url: item.url }
  } catch { return undefined }
}

/** Validate a public Worker origin, allowing HTTP only for local development.
 * @param value - User-configured origin without credentials, a path or query.
 * @returns the canonical origin.
 */
export function normalizeWorkerOrigin(value: string): string {
  const url = new URL(value.trim())
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('请填写 Worker 的 HTTPS 地址；本机测试可使用 HTTP。地址不能包含账号、路径或参数。')
  }
  return url.origin
}

/** Read only the non-secret publication target; no server address is inferred.
 * @returns the saved origin or an empty string when unconfigured.
 */
export function readWorkerOrigin(): string {
  return window.localStorage.getItem(WORKER_ORIGIN_KEY) ?? ''
}

/** Save an explicitly chosen target without credentials.
 * @param value - Worker origin entered in interview settings.
 * @returns the normalized saved origin.
 */
export function saveWorkerOrigin(value: string): string {
  const origin = normalizeWorkerOrigin(value)
  window.localStorage.setItem(WORKER_ORIGIN_KEY, origin)
  return origin
}

/** Build a share URL whose invitation stays out of HTTP request paths and queries.
 * @param origin - Configured Worker origin.
 * @param key - Immutable publication key.
 * @param code - Invitation known to the publisher; link holders can use it.
 * @returns the participant URL with the invitation in its fragment.
 */
export function workerShareURL(origin: string, key: string, code: string): string {
  const url = new URL('/', normalizeWorkerOrigin(origin))
  url.searchParams.set('fieldnoteId', key)
  if (code) url.hash = new URLSearchParams({ code }).toString()
  return url.href
}

/** Transfer one prepared publication to a user-confirmed, authenticated Worker popup.
 * @param target - Explicit Worker origin.
 * @param key - Immutable version-specific key.
 * @param payload - Stable JSON bytes reused for retries.
 * @param signal - Operation lifetime; abort closes its owned popup and removes listeners.
 * @returns the acknowledged publication key/hash; credentials never enter this page.
 */
export function publishToWorker(
  target: string, key: string, payload: string, signal?: AbortSignal,
): Promise<{ key: string; hash: string }> {
  const origin = normalizeWorkerOrigin(target)
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw new Error('题包文件键无效，请生成有效的问题包版本。')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)) throw new Error('请从本机 DSH 发起受控发布。')
  if (signal?.aborted) return Promise.reject(new Error('发布已取消'))
  const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('')
  const url = new URL('/admin/', origin)
  url.hash = new URLSearchParams({ publish: '1', origin: window.location.origin, nonce }).toString()
  const popup = window.open(url.href, '_blank', 'popup,width=1000,height=780')
  if (popup === null) return Promise.reject(new Error('浏览器阻止了发布窗口，请允许弹出窗口后重试。'))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: { key: string; hash: string } | Error): void => {
      if (settled) return
      settled = true
      window.removeEventListener('message', receive)
      signal?.removeEventListener('abort', abort)
      window.clearInterval(timer)
      if (result instanceof Error) { popup.close(); reject(result) } else resolve(result)
    }
    const abort = (): void => { finish(new Error('发布已取消')) }
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.origin !== origin || event.source !== popup || typeof event.data !== 'object' || event.data === null) return
      const data = event.data as { type?: unknown; nonce?: unknown; key?: unknown; hash?: unknown }
      if (data.nonce !== nonce) return
      if (data.type === 'teaching-publish:ready') popup.postMessage({ type: 'teaching-publish:prepare', nonce, key, payload }, origin)
      if (data.type === 'teaching-publish:complete') {
        if (data.key !== key || typeof data.hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.hash)) { finish(new Error('Worker 返回了无效发布回执')); return }
        finish({ key, hash: data.hash })
      }
    }
    const deadline = Date.now() + 300000
    const timer = window.setInterval(() => {
      if (popup.closed) finish(new Error('发布窗口已关闭；可重试，相同题包不会重复覆盖'))
      else if (Date.now() > deadline) finish(new Error('发布等待超时，请重试'))
    }, 250)
    window.addEventListener('message', receive)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
