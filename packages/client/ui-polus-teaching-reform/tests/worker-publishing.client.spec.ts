// @vitest-environment jsdom
import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import {
  normalizeWorkerOrigin, publishToWorker, readWorkerOrigin, readWorkerReceipt, saveWorkerOrigin, workerShareURL,
} from '../src/client/workerPublishing.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); window.localStorage.clear() })

test('target configuration excludes credentials and share invitations stay in fragments', () => {
  assert.equal(normalizeWorkerOrigin('https://worker.example.com/'), 'https://worker.example.com')
  assert.equal(normalizeWorkerOrigin('http://127.0.0.1:18083'), 'http://127.0.0.1:18083')
  for (const value of ['http://worker.example.com', 'https://user:password@worker.example.com', 'https://worker.example.com/admin/', 'https://worker.example.com/?token=secret', 'https://worker.example.com/#code=000000']) {
    assert.throws(() => normalizeWorkerOrigin(value))
  }
  assert.equal(readWorkerOrigin(), '')
  saveWorkerOrigin('https://worker.example.com/')
  assert.equal(readWorkerOrigin(), 'https://worker.example.com')
  const url = new URL(workerShareURL(readWorkerOrigin(), 'FN-synthetic-v1', '000000'))
  assert.equal(url.searchParams.get('fieldnoteId'), 'FN-synthetic-v1')
  assert.equal(url.searchParams.has('code'), false)
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('code'), '000000')
  const receipt = { key: 'FN-synthetic-v1', hash: 'a'.repeat(64), version: 1, url: url.href }
  assert.deepEqual(readWorkerReceipt(receipt), receipt)
  for (const changed of [undefined, {}, { ...receipt, url: 'javascript:alert(1)' }, { ...receipt, key: 'different' }, { ...receipt, url: url.origin + '/?fieldnoteId=FN-synthetic-v1&code=000000' }]) {
    assert.equal(readWorkerReceipt(changed), undefined)
  }
})

function popupFixture() {
  vi.stubGlobal('location', new URL('http://127.0.0.1:3082'))
  const popup = { closed: false, postMessage: vi.fn(), close: vi.fn() }
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  const begin = () => {
    const promise = publishToWorker('https://worker.example.com', 'FN-synthetic-v1', '{"synthetic":true}')
    const target = String(open.mock.calls.at(-1)?.[0])
    const nonce = new URLSearchParams(new URL(target).hash.slice(1)).get('nonce')
    assert.ok(nonce)
    return { promise, nonce }
  }
  const message = (data: unknown, origin = 'https://worker.example.com', source: object = popup) => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }))
  }
  return { popup, open, begin, message }
}

test('publication validates Worker origin, popup identity, nonce and exact package receipt', async () => {
  const { popup, begin, message } = popupFixture()
  const { promise, nonce } = begin()
  message({ type: 'teaching-publish:ready', nonce }, 'https://attacker.example.com')
  message({ type: 'teaching-publish:ready', nonce }, undefined, {})
  message({ type: 'teaching-publish:ready', nonce: 'f'.repeat(64) })
  assert.equal(popup.postMessage.mock.calls.length, 0)
  message({ type: 'teaching-publish:ready', nonce })
  assert.deepEqual(popup.postMessage.mock.calls[0], [{ type: 'teaching-publish:prepare', nonce, key: 'FN-synthetic-v1', payload: '{"synthetic":true}' }, 'https://worker.example.com'])
  message({ type: 'teaching-publish:complete', nonce, key: 'FN-synthetic-v1', hash: 'a'.repeat(64) })
  assert.deepEqual(await promise, { key: 'FN-synthetic-v1', hash: 'a'.repeat(64) })
  assert.equal(popup.close.mock.calls.length, 0)
})

test('another package acknowledgement rejects the operation and closes only its popup', async () => {
  const { popup, begin, message } = popupFixture()
  const { promise, nonce } = begin()
  const rejected = assert.rejects(promise)
  message({ type: 'teaching-publish:complete', nonce, key: 'other-package', hash: 'a'.repeat(64) })
  await rejected
  assert.equal(popup.close.mock.calls.length, 1)
})

test('popup closure, cancellation and blocked windows settle without retained message listeners', async () => {
  vi.useFakeTimers()
  const { popup, begin, message, open } = popupFixture()
  const first = begin()
  const rejected = assert.rejects(first.promise)
  popup.closed = true
  await vi.advanceTimersByTimeAsync(250)
  await rejected
  message({ type: 'teaching-publish:ready', nonce: first.nonce })
  assert.equal(popup.postMessage.mock.calls.length, 0)
  popup.closed = false
  const controller = new AbortController()
  const second = publishToWorker('https://worker.example.com', 'FN-synthetic-v1', '{}', controller.signal)
  const canceled = assert.rejects(second)
  controller.abort()
  await canceled
  open.mockReturnValue(null)
  await assert.rejects(publishToWorker('https://worker.example.com', 'FN-synthetic-v1', '{}'))
  vi.unstubAllGlobals()
})
