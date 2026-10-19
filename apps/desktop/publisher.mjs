/** Upload-only publication broker. Tokens never leave the native process after configuration. */
import { createHash } from 'node:crypto'

const brokerFailure = Symbol('publisher failure')
const fail = (code, message) => Object.assign(new Error(message), { code, [brokerFailure]: true })
const authError = () => fail('PUBLISH_AUTH_INVALID', '发布 API Key 无效、已过期或已撤销，请在访谈设置中重新配置。')

/** Accept a canonical HTTPS origin, or loopback HTTP for local testing. */
export function publisherOrigin(value) {
  if (typeof value !== 'string') throw fail('INVALID_ORIGIN', '请填写 Worker 服务地址。')
  let url
  try { url = new URL(value.trim()) } catch { throw fail('INVALID_ORIGIN', '请填写有效的 Worker HTTPS 地址。') }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw fail('INVALID_ORIGIN', '请填写 Worker 的 HTTPS 地址；本机测试可使用 HTTP。地址不能包含账号、路径或参数。')
  }
  return url.origin
}

/** Validate the receipt before opening the participant window; no server-selected management URL is accepted. */
export function publisherReceipt(value, origin, key) {
  if (!value || value.key !== key || !/^[a-f0-9]{64}$/.test(value.hash ?? '') || typeof value.url !== 'string') throw fail('INVALID_RECEIPT', 'Worker 返回了无效发布回执。')
  let url
  try { url = new URL(value.url) } catch { throw fail('INVALID_RECEIPT', 'Worker 返回了无效分享地址。') }
  const fragment = new URLSearchParams(url.hash.slice(1))
  const access = value.access
  if (url.origin !== origin || url.username || url.password || url.pathname !== '/' || url.searchParams.size !== 1
    || url.searchParams.get('fieldnoteId') !== key || fragment.size > 1 || [...fragment.keys()].some(name => name !== 'code')
    || !access || !['active', 'not_required'].includes(access.status)
    || access.status === 'active' && (typeof access.code !== 'string' || access.code.length < 1 || access.code.length > 128 || fragment.get('code') !== access.code)
    || access.status === 'not_required' && (access.code || url.hash)) {
    throw fail('INVALID_RECEIPT', 'Worker 返回的访问口令或分享地址无效，请联系管理员。')
  }
  return { key, hash: value.hash, url: url.href, accessStatus: access.status,
    ...(access.status === 'active' ? { code: access.code } : {}) }
}

/** Create a broker with an encrypted native vault and a participant-window opener. */
export function createPublisher({ vault, fetchImpl = fetch, openParticipant, timeoutMs = 60_000 }) {
  const jobs = new Map()
  const requests = new Map()
  return {
    async configure(input) {
      const origin = publisherOrigin(input?.origin)
      if (typeof input.token !== 'string' || !/^dsh_pub_[a-f0-9]{64}$/.test(input.token)) throw authError()
      await vault.write({ origin, token: input.token })
      return { configured: true, origin, prefix: input.token.slice(0, 16) }
    },
    async status() {
      const saved = await vault.read()
      return saved ? { configured: true, origin: saved.origin, prefix: saved.token.slice(0, 16) } : { configured: false }
    },
    cancel(id) { requests.get(id)?.abort() },
    async publish(input) {
      const origin = publisherOrigin(input?.origin)
      if (typeof input.id !== 'string' || !/^[a-f0-9]{32}$/.test(input.id)
        || typeof input.key !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.key)
        || typeof input.payload !== 'string' || Buffer.byteLength(input.payload) > 8 * 1024 * 1024) throw fail('INVALID_PUBLICATION', '题包无效或超过上传大小限制。')
      const digest = createHash('sha256').update(input.payload).digest('hex')
      const jobKey = `${origin}/${input.key}/${digest}`
      const existing = jobs.get(jobKey)
      if (existing) {
        requests.set(input.id, existing.controller)
        try { return await existing.promise } finally { requests.delete(input.id) }
      }
      const controller = new AbortController()
      requests.set(input.id, controller)
      const promise = (async () => {
        const saved = await vault.read()
        if (!saved || saved.origin !== origin) throw fail('PUBLISH_AUTH_REQUIRED', '请在访谈设置中保存当前 Worker 的发布 API Key，然后重试。')
        let response
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          response = await fetchImpl(`${origin}/publish/api/packs/${encodeURIComponent(input.key)}`, {
            method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${saved.token}` }, body: input.payload,
          })
          if (response.status === 401 || response.status === 403) throw authError()
          if (response.status === 404 || response.status === 405) throw fail('WORKER_UPDATE_REQUIRED', 'Worker 尚未支持发布 API Key，请联系管理员更新服务。')
          if (response.status === 413) throw fail('PUBLICATION_TOO_LARGE', '题包超过 Worker 上传大小限制，请精简材料后重试。')
          if (!response.ok) throw fail('PUBLICATION_REJECTED', 'Worker 未接受题包，请检查版本文件键和内容后重试。')
          const raw = await response.text()
          if (Buffer.byteLength(raw) > 32768) throw fail('INVALID_RECEIPT', 'Worker 返回了过大的发布回执。')
          let value
          try { value = JSON.parse(raw) } catch { throw fail('INVALID_RECEIPT', 'Worker 返回了无效发布回执。') }
          const receipt = publisherReceipt(value, origin, input.key)
          if (controller.signal.aborted) throw fail('PUBLISH_CANCELLED', '发布已取消；已上传的同版本题包可安全重试。')
          const preview = new URL(receipt.url)
          preview.searchParams.set('preview', 'new')
          await openParticipant(preview.href)
          return receipt
        } catch (error) {
          if (error[brokerFailure]) throw error
          throw fail('PUBLISH_NETWORK_FAILED', controller.signal.aborted ? '发布已取消或超时；网络恢复后可重试同一版本。' : '连接 Worker 失败，请检查地址、网络和 HTTPS 证书后重试。')
        } finally { clearTimeout(timer) }
      })()
      jobs.set(jobKey, { controller, promise })
      try { return await promise } finally { jobs.delete(jobKey); requests.delete(input.id) }
    },
  }
}
