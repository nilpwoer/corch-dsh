// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createJdResearchRoute } from '../src/client/jdResearchRoute.ts'
import { JdResearchReturn, JdResearchSurface } from '../src/client/JdResearchSurface.tsx'
import { projectFixture } from './jd-fixture.client.ts'
import type { JdProjectSummary } from '../src/jd/types.ts'

afterEach(cleanup)
const id = 'jd-route-session' as SessionId
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(options: { current?: SessionId; mode?: string; ready?: boolean; list?: () => Promise<JdProjectSummary[]> } = {}) {
  let current = options.current
  let mode = options.mode ?? 'sessions'
  let ready = options.ready ?? true
  const sessionListeners = new Set<() => void>()
  const modeListeners = new Set<() => void>()
  const readyListeners = new Set<() => void>()
  const bind = (listeners: Set<() => void>) => (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const select = (value: string): void => { mode = value; for (const listener of modeListeners) listener() }
  const project = { ...projectFixture(), session_id: id }
  const list = vi.fn(options.list ?? (async () => [project]))
  const route = createJdResearchRoute({
    currentSession: () => current, subscribeSession: bind(sessionListeners),
    ready: () => ready, subscribeReady: bind(readyListeners),
    mode: () => mode, selectJd: () => { select('jd-search') }, subscribeMode: bind(modeListeners), list,
  })
  const stop = route.start()
  return {
    route, stop, list, select,
    session(value?: SessionId) { current = value; for (const listener of sessionListeners) listener() },
    connect() { ready = true; for (const listener of readyListeners) listener() },
    listenerCounts: () => [sessionListeners.size, modeListeners.size, readyListeners.size],
    mode: () => mode,
  }
}

test('a restored saved JD session shows loading until its Host membership is known, then selects the workbench', async () => {
  const pending = deferred<JdProjectSummary[]>()
  const f = fixture({ current: id, list: () => pending.promise })
  expect(f.route.getSnapshot().route).toBe('loading')
  pending.resolve([{ ...projectFixture(), session_id: id }])
  await f.route.refresh()
  expect(f.mode()).toBe('jd-search')
  expect(f.route.getSnapshot().route).toBe('workbench')
  await f.stop()
})

test('ordinary sessions and failed project reads release the native renderer', async () => {
  const ordinary = fixture({ current: 'ordinary' as SessionId })
  await ordinary.route.refresh()
  expect(ordinary.mode()).toBe('sessions')
  expect(ordinary.route.getSnapshot().route).toBe('native')
  await ordinary.stop()
  const failed = fixture({ current: id, list: async () => { throw new Error('Host disconnected') } })
  await failed.route.refresh()
  expect(failed.route.getSnapshot()).toMatchObject({ route: 'native', error: 'Host disconnected' })
  await failed.stop()
})

test('a user-selected interview surface cannot be overridden by a late startup read', async () => {
  const pending = deferred<JdProjectSummary[]>()
  const f = fixture({ current: id, list: () => pending.promise })
  f.select('interviews')
  pending.resolve([{ ...projectFixture(), session_id: id }])
  await f.route.refresh()
  expect(f.mode()).toBe('interviews')
  expect(f.route.getSnapshot().route).toBe('native')
  await f.stop()
})

test('native logs are explicitly selected for one session and returning does not request the model or project again', async () => {
  const f = fixture({ current: id })
  await f.route.refresh()
  const calls = f.list.mock.calls.length
  f.route.showLogs()
  expect(f.route.getSnapshot().route).toBe('native')
  f.route.showWorkbench()
  expect(f.route.getSnapshot().route).toBe('workbench')
  expect(f.list).toHaveBeenCalledTimes(calls)
  f.route.showLogs()
  f.session('another-jd' as SessionId)
  expect(f.route.getSnapshot().route).toBe('workbench')
  f.select('sessions')
  expect(f.route.getSnapshot().route).toBe('native')
  await f.stop()
})

test('host readiness and a later current-session selection can restore a saved research', async () => {
  const f = fixture({ ready: false })
  expect(f.list).not.toHaveBeenCalled()
  f.connect()
  await f.route.refresh()
  f.session(id)
  expect(f.route.getSnapshot().route).toBe('workbench')
  await f.stop()
})

test('disposal removes every subscription and awaits an already running project read without publishing its late reply', async () => {
  const pending = deferred<JdProjectSummary[]>()
  const f = fixture({ current: id, list: () => pending.promise })
  const notify = vi.fn()
  f.route.subscribe(notify)
  const stopped = f.stop()
  expect(f.listenerCounts()).toEqual([0, 0, 0])
  pending.resolve([{ ...projectFixture(), session_id: id }])
  await stopped
  expect(notify).not.toHaveBeenCalled()
  expect(f.mode()).toBe('sessions')
})

test('one failing view does not starve other subscribers or prevent a requested refresh', async () => {
  const f = fixture({ current: id })
  await f.route.refresh()
  const notify = vi.fn()
  f.route.subscribe(() => { throw new Error('Broken view') })
  f.route.subscribe(notify)
  await f.route.refresh()
  expect(notify).toHaveBeenCalled()
  expect(f.route.getSnapshot().route).toBe('workbench')
  await f.stop()
})

test('a refresh requested during publication is drained before the route becomes idle', async () => {
  const f = fixture({ current: id })
  await f.route.refresh()
  const previous = f.list.mock.calls.length
  let again = true
  f.route.subscribe(() => { if (again) { again = false; void f.route.refresh() } })
  await f.route.refresh()
  expect(f.list.mock.calls.length).toBe(previous + 2)
  await f.stop()
})

test('an empty JD surface has a working new-search action and closes the duplicate details column', async () => {
  const f = fixture({ mode: 'jd-search', list: async () => [] })
  await f.route.refresh()
  expect(f.route.getSnapshot().route).toBe('workbench')
  const createSearch = vi.fn().mockResolvedValue(undefined)
  const closeDetails = vi.fn()
  const props = { route: f.route, createSearch, closeDetails, sessionId: undefined,
    content: <textarea aria-label="对话输入" />,
    renderSlot: () => null } as Parameters<typeof JdResearchSurface>[0]
  render(<JdResearchSurface {...props} />)
  expect(closeDetails).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '新建搜索' }))
  await waitFor(() => { expect(createSearch).toHaveBeenCalledTimes(1) })
  await f.stop()
})

test('a saved workbench preserves the native input across pane changes and offers a full conversation view', async () => {
  const f = fixture({ current: id })
  await f.route.refresh()
  const props = { route: f.route, createSearch: vi.fn(), closeDetails: vi.fn(), sessionId: id,
    content: <textarea aria-label="对话输入" />,
    renderSlot: () => <p>Structured saved research</p> } as Parameters<typeof JdResearchSurface>[0]
  render(<JdResearchSurface {...props} />)
  expect(screen.getByText('Structured saved research')).toBeTruthy()
  const input = screen.getByLabelText('对话输入')
  fireEvent.change(input, { target: { value: '我想补充岗位要求' } })
  fireEvent.click(screen.getByRole('tab', { name: '对话' }))
  expect(screen.getByRole('region', { name: 'JD 研究工作台' }).querySelector('[data-active-pane]')?.getAttribute('data-active-pane')).toBe('conversation')
  fireEvent.click(screen.getByRole('tab', { name: '工作台' }))
  expect(screen.getByLabelText<HTMLTextAreaElement>('对话输入').value).toBe('我想补充岗位要求')
  act(() => { fireEvent.click(screen.getByRole('button', { name: '仅显示对话' })) })
  expect(f.route.getSnapshot().route).toBe('native')
  cleanup()
  render(<JdResearchReturn showWorkbench={f.route.showWorkbench} />)
  fireEvent.click(screen.getByRole('button', { name: '返回JD工作台' }))
  expect(f.route.getSnapshot().route).toBe('workbench')
  await f.stop()
})
