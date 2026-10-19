import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublisher, publisherOrigin, publisherReceipt } from './publisher.mjs'

const token = 'dsh_pub_' + 'a'.repeat(64)
const origin = 'https://worker.test'
const key = 'FN-native-v1'
const input = { id: 'a'.repeat(32), origin, key, payload: '{"synthetic":true}' }
const receipt = { key, hash: 'b'.repeat(64), access: { status: 'active', code: 'synthetic-invitation' }, url: `${origin}/?fieldnoteId=${key}#code=synthetic-invitation` }
const response = (status = 201, value = receipt) => new Response(JSON.stringify(value), { status })
function fixture(fetchImpl = async () => response()) {
  let saved
  const opened = []
  const broker = createPublisher({ vault: { read: async () => saved, write: async value => { saved = value } }, fetchImpl, openParticipant: async value => { opened.push(value) } })
  return { broker, opened }
}

test('first configured publication sends only the upload Key, opens the participant once and needs no cookies', async () => {
  const calls = []
  const { broker, opened } = fixture(async (url, options) => { calls.push({ url, options }); await new Promise(resolve => setTimeout(resolve, 20)); return response() })
  await assert.rejects(broker.publish(input), /访谈设置/)
  assert.equal(opened.length, 0)
  const metadata = await broker.configure({ origin, token })
  assert.equal(JSON.stringify(metadata).includes(token), false)
  assert.equal(JSON.stringify(await broker.status()).includes(token), false)
  const [a, b] = await Promise.all([broker.publish(input), broker.publish({ ...input, id: 'b'.repeat(32) })])
  assert.deepEqual(a, b)
  assert.equal(calls.length, 1)
  assert.equal(opened.length, 1)
  assert.equal(new URL(opened[0]).searchParams.get('preview'), 'new')
  assert.equal(new URL(a.url).searchParams.has('preview'), false)
  assert.equal(calls[0].url, `${origin}/publish/api/packs/${key}`)
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`)
  assert.equal(calls[0].options.credentials, 'omit')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(JSON.stringify(a).includes(token), false)
  assert.equal(a.code, receipt.access.code)
})

test('revoked/expired/invalid credentials and failed network never open a login window; same bytes can retry', async () => {
  let mode = 'revoked'
  const { broker, opened } = fixture(async () => {
    if (mode === 'revoked') return response(401)
    if (mode === 'network') throw new TypeError('fetch failed')
    if (mode === 'old') return response(404)
    return response()
  })
  await broker.configure({ origin, token })
  await assert.rejects(broker.publish(input), /无效、已过期或已撤销/)
  mode = 'network'; await assert.rejects(broker.publish(input), /网络和 HTTPS 证书/)
  mode = 'old'; await assert.rejects(broker.publish(input), /更新服务/)
  assert.equal(opened.length, 0)
  mode = 'success'; await broker.publish(input); assert.equal(opened.length, 1)
  await assert.rejects(broker.publish({ ...input, origin: 'https://other.test' }), /当前 Worker/)
})

test('cancelled upload and hostile receipts cannot navigate away or disclose the native Key', async () => {
  let waiting
  const { broker, opened } = fixture((_url, options) => new Promise((_resolve, reject) => {
    waiting?.(); options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  await broker.configure({ origin, token })
  const started = new Promise(resolve => { waiting = resolve })
  const running = broker.publish(input)
  await started; broker.cancel(input.id)
  await assert.rejects(running, /取消或超时/)
  assert.equal(opened.length, 0)
  for (const value of [
    { ...receipt, key: 'other' }, { ...receipt, hash: 'bad' }, { ...receipt, url: origin + '/admin/' },
    { ...receipt, url: 'https://evil.test/?fieldnoteId=' + key }, { ...receipt, url: receipt.url + '&key=' + token },
    { ...receipt, access: { status: 'revoked', code: 'synthetic-invitation' } },
  ]) assert.throws(() => publisherReceipt(value, origin, key))
  for (const value of ['http://remote.test', 'https://name:secret@worker.test', origin + '/admin/', origin + '/?token=x']) assert.throws(() => publisherOrigin(value))
  assert.equal(publisherOrigin('http://127.0.0.1:1234'), 'http://127.0.0.1:1234')
})
