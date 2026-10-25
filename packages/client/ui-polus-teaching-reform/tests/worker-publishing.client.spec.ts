// @vitest-environment jsdom
import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import {
  normalizeWorkerOrigin, publishToWorker, readWorkerOrigin, readWorkerReceipt,
  saveWorkerOrigin, workerShareURL, savePublisherKey, readPublisherStatus,
} from '../src/client/workerPublishing.ts'

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
  window.localStorage.clear(); delete window.corchPublication
})

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


test('native Key configuration never writes the token to browser persistence', async () => {
  const token='dsh_pub_'+'a'.repeat(64)
  const configure=vi.fn(async () => ({ ok:true as const,value:{ configured:true,origin:'https://worker.example.com',prefix:token.slice(0,16) } }))
  window.corchPublication={
    configure,status:vi.fn(async()=>({ ok:true as const,value:{ configured:false } })),publish:vi.fn(),cancel:vi.fn(),
  }
  await savePublisherKey('https://worker.example.com',token)
  assert.deepEqual(configure.mock.calls[0],[{ origin:'https://worker.example.com',token }])
  assert.equal(JSON.stringify(localStorage).includes(token),false)
  assert.deepEqual(await readPublisherStatus(),{ configured:false })
})

test('configured native publishing validates its receipt and never opens a login popup', async () => {
  const open=vi.spyOn(window,'open')
  const receipt={ key:'FN-synthetic-v1',hash:'a'.repeat(64),code:'synthetic-invitation',accessStatus:'active' as const,url:'https://worker.example.com/?fieldnoteId=FN-synthetic-v1#code=synthetic-invitation' }
  const publish=vi.fn(async()=>({ ok:true as const,value:receipt }))
  window.corchPublication={ configure:vi.fn(),status:vi.fn(),publish,cancel:vi.fn() }
  assert.deepEqual(await publishToWorker('https://worker.example.com',receipt.key,'{}'),receipt)
  assert.equal(open.mock.calls.length,0)
  for(const changed of [{ key:'other' },{ url:'https://evil.test/?fieldnoteId=FN-synthetic-v1#code=synthetic-invitation' },{ code:'mismatch' },{ accessStatus:'revoked' }]) {
    publish.mockResolvedValueOnce({ ok:true,value:{ ...receipt,...changed } as typeof receipt })
    await assert.rejects(publishToWorker('https://worker.example.com',receipt.key,'{}'),/无效发布回执/)
  }
})

test('missing/invalid native authorization and cancellation give inline errors without popup fallback', async () => {
  const open=vi.spyOn(window,'open')
  await assert.rejects(publishToWorker('https://worker.example.com','FN-test-v1','{}'),/Windows 桌面客户端/)
  const cancel=vi.fn()
  const publish=vi.fn(async()=>({ ok:false as const,message:'发布 API Key 无效、已过期或已撤销' }))
  window.corchPublication={ configure:vi.fn(),status:vi.fn(),publish,cancel }
  await assert.rejects(publishToWorker('https://worker.example.com','FN-test-v1','{}'),/已撤销/)
  const controller=new AbortController()
  let complete:(value: { ok:false;message:string })=>void=()=>undefined
  publish.mockImplementationOnce(()=>new Promise((resolve)=>{complete=resolve}))
  const waiting=publishToWorker('https://worker.example.com','FN-test-v1','{}',controller.signal)
  controller.abort();complete({ ok:false,message:'取消' })
  await assert.rejects(waiting,/发布已取消/)
  assert.equal(cancel.mock.calls.length,1)
  assert.equal(open.mock.calls.length,0)
})
