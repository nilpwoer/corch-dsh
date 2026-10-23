// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { collectJdBrowser, hasJdBrowser, jdBrowserPlatforms, openJdBrowser,
  resumeJdBrowser, verifyJdBrowser } from '../src/client/jdNative.ts'

afterEach(() => { delete window.corchJd })
function bridge(): NonNullable<Window['corchJd']> {
  const native: NonNullable<Window['corchJd']> = {
    open: vi.fn().mockResolvedValue({ ok: true, value: { id: 'search', state: 'opened' } }),
    read: vi.fn(), close: vi.fn(), status: vi.fn(), html: vi.fn(),
    collect: vi.fn().mockResolvedValue({ ok: true, value: { items: [], platforms: [] } }),
    platforms: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    verify: vi.fn().mockResolvedValue({ ok: true, value: { id: 'search', state: 'opened' } }),
    resume: vi.fn().mockResolvedValue({ ok: true, value: { item: { state: 'blocked', url: 'https://example.test/job' }, platforms: [] } }),
  }
  window.corchJd = native
  return native
}
test('ordinary browsers keep candidates without pretending to have native collection', async () => {
  expect(hasJdBrowser()).toBe(false)
  expect(await jdBrowserPlatforms()).toEqual([])
  await expect(collectJdBrowser('search', [])).rejects.toThrow('浏览器渲染采集需要 Windows 桌面客户端')
})
test('native blocked and rate-limited navigation are not reported as opened windows', async () => {
  const native = bridge()
  vi.mocked(native.open).mockResolvedValueOnce({ ok: true, value: { id: 'search', state: 'blocked', message: '平台风控暂停' } })
    .mockResolvedValueOnce({ ok: true, value: { id: 'search', state: 'rate_limited', message: '访问额度已用完' } })
  await expect(openJdBrowser('search', 'https://example.test/job')).rejects.toThrow('平台风控暂停')
  await expect(openJdBrowser('search', 'https://example.test/job')).rejects.toThrow('访问额度已用完')
})
test('manual verification and resume use separate native operations', async () => {
  const native = bridge()
  await verifyJdBrowser('search', 'https://example.test/job')
  expect(native.verify).toHaveBeenCalledWith({ id: 'search', url: 'https://example.test/job' })
  expect(native.collect).not.toHaveBeenCalled()
  expect(await resumeJdBrowser('search', 'https://example.test/job')).toEqual({
    item: { state: 'blocked', url: 'https://example.test/job' }, platforms: [],
  })
  expect(native.resume).toHaveBeenCalledWith({ id: 'search', url: 'https://example.test/job' })
})
test('collection preserves the native cache timestamp and content hash', async () => {
  const native = bridge()
  const capture = { state: 'captured' as const, title: '护理员', url: 'https://example.test/job',
    body: '岗位职责：照护老人。', captured_at: '2026-01-01T00:00:00.000Z', content_hash: 'original-hash', cached: true }
  vi.mocked(native.collect).mockResolvedValue({ ok: true, value: { items: [capture], platforms: [] } })
  expect(await collectJdBrowser('search', [{ title: '候选岗位', url: capture.url }])).toEqual({ items: [capture], platforms: [] })
  expect(native.collect).toHaveBeenCalledWith({ id: 'search', sources: [{ title: '候选岗位', url: capture.url }] })
})
