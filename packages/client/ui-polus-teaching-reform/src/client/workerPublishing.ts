/** Native desktop publication keeps upload-only API Keys outside browser persistence. */
const WORKER_ORIGIN_KEY = 'dsh.practice-expert-worker-origin.v1'

/** Validated Worker receipt retained with the last successfully published package version. */
export type WorkerPublicationReceipt = { key: string; hash: string; url: string; version: number; code?: string; accessStatus?: 'active' | 'not_required' }

/** Validate a persisted share receipt before rendering its URL.
 * @param value - Browser-persisted publication metadata.
 * @returns a valid receipt, or undefined when it does not match the participant URL format.
 */
export function readWorkerReceipt(value: unknown): WorkerPublicationReceipt | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.key !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.key) || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash) || typeof item.version !== 'number' || !Number.isSafeInteger(item.version) || item.version < 1 || typeof item.url !== 'string') return undefined
  try {
    const url = new URL(item.url)
    normalizeWorkerOrigin(url.origin)
    if (url.searchParams.size !== 1 || new URLSearchParams(url.hash.slice(1)).size > 1) return undefined
    if (url.username || url.password || url.pathname !== '/' || url.searchParams.get('fieldnoteId') !== item.key || [...url.searchParams.keys()].some(key => key !== 'fieldnoteId') || [...new URLSearchParams(url.hash.slice(1)).keys()].some(key => key !== 'code')) return undefined
    if (item.code !== undefined && (typeof item.code !== 'string' || item.code.length > 128
      || new URLSearchParams(url.hash.slice(1)).get('code') !== item.code)) return undefined
    if (item.accessStatus !== undefined && item.accessStatus !== 'active' && item.accessStatus !== 'not_required') return undefined
    return {
      key: item.key, hash: item.hash, version: item.version, url: item.url,
      ...(item.code === undefined ? {} : { code: item.code }),
      ...(item.accessStatus === undefined ? {} : { accessStatus: item.accessStatus }),
    }
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

type NativeResult<T> = { ok: true; value: T } | { ok: false; message: string }
type PublisherStatus = { configured: boolean; origin?: string; prefix?: string }
declare global {
  interface Window {
    corchPublication?: {
      configure(input: { origin: string; token: string }): Promise<NativeResult<PublisherStatus>>
      status(): Promise<NativeResult<PublisherStatus>>
      publish(input: { id: string; origin: string; key: string; payload: string }): Promise<NativeResult<unknown>>
      cancel(id: string): void
    }
  }
}

/** Return the native broker; browser-only clients cannot persist a publishing credential.
 * @returns the restricted native publication interface.
 */
function nativePublisher(): NonNullable<Window['corchPublication']> {
  if (!window.corchPublication) throw new Error('请使用新版 Windows 桌面客户端配置发布 API Key。')
  return window.corchPublication
}

/** Read non-secret native authorization metadata.
 * @returns whether a publisher Key is configured, its target and display prefix.
 */
export async function readPublisherStatus(): Promise<PublisherStatus> {
  const result = await nativePublisher().status()
  if (!result.ok) throw new Error(result.message)
  return result.value
}

/** Encrypt a Key through the native process, without persisting it in browser storage.
 * @param origin - Explicit Worker origin.
 * @param token - Transient input, cleared by the caller after saving.
 * @returns only non-secret credential metadata.
 */
export async function savePublisherKey(origin: string, token: string): Promise<PublisherStatus> {
  const result = await nativePublisher().configure({ origin: normalizeWorkerOrigin(origin), token: token.trim() })
  if (!result.ok) throw new Error(result.message)
  return result.value
}

/** Upload once through the native process and open the returned participant page.
 * @param target - Explicit Worker origin.
 * @param key - Immutable publication key.
 * @param payload - Stable JSON bytes reused for retries.
 * @param signal - Operation lifetime.
 * @param onProgress - Visible upload progress.
 * @returns the validated matching receipt; no admin session or interactive login is used.
 */
export async function publishToWorker(
  target: string, key: string, payload: string, signal?: AbortSignal, onProgress?: (message: string) => void,
): Promise<Omit<WorkerPublicationReceipt, 'version'>> {
  const origin = normalizeWorkerOrigin(target)
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw new Error('题包文件键无效，请生成有效的问题包版本。')
  if (signal?.aborted) throw new Error('发布已取消')
  const broker = nativePublisher()
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('')
  const abort = (): void => { broker.cancel(id) }
  signal?.addEventListener('abort', abort, { once: true })
  onProgress?.('正在上传题包到 Worker…')
  try {
    const result = await broker.publish({ id, origin, key, payload })
    if (signal?.aborted) throw new Error('发布已取消')
    if (!result.ok) throw new Error(result.message)
    const receipt = readWorkerReceipt({ ...(result.value as object), version: 1 })
    if (!receipt || receipt.key !== key || new URL(receipt.url).origin !== origin
      || !receipt.accessStatus || receipt.accessStatus === 'active' && !receipt.code) throw new Error('Worker 返回了无效发布回执。')
    const { version: _version, ...value } = receipt
    return value
  } finally { signal?.removeEventListener('abort', abort) }
}
