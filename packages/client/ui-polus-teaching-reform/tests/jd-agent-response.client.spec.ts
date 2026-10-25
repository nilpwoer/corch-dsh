import { afterEach, expect, test, vi } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS, type AssistantMessageNode, type ChatConversationViewNode, type ConversationSnapshot, type SessionFace, type TurnLocation } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { requestJdResponse } from '../src/client/jdAgentResponse.ts'

const sessionId = 'jd-response' as ConversationSnapshot['sessionId']

function harness() {
  const listeners = new Set<() => void>()
  const connectionListeners = new Set<() => void>()
  let nodes: readonly ChatConversationViewNode[] = []
  let connected = true
  let snapshot: ConversationSnapshot = {
    sessionId, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT, nodes: [], turnTimings: new Map(), turnEnds: new Map(),
    partial: null, runningCalls: [], pending: [], queue: [], running: false, subagent: null, composerPhase: 'active', removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
  }
  const prompt = vi.fn<SessionFace['prompt']>(async () => ({ ok: true, value: { accepted: true } }))
  const session: Pick<SessionFace, 'getSnapshot' | 'subscribe' | 'prompt'> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    prompt,
  }
  const connection = {
    getSnapshot: () => connected,
    subscribe: (listener: () => void) => { connectionListeners.add(listener); return () => { connectionListeners.delete(listener) } },
  }
  const publish = (patch: Partial<ConversationSnapshot> = {}): void => {
    snapshot = {
      ...snapshot, ...patch,
      chat: { ...(patch.chat ?? snapshot.chat), nodes: { get: key => nodes.find(node => node.key === key), values: () => nodes } },
    }
    for (const listener of listeners) listener()
  }
  const turn = (number: number, reason?: NonNullable<TurnLocation['end']>['data']['reason']): TurnLocation => ({
    turn: number, start: { type: 'turn/start', seq: number * 10, time: 0, data: { turn: number } },
    end: reason === undefined ? undefined : { type: 'turn/end', seq: number * 10 + 9, time: 0, data: { turn: number, reason } },
    status: reason === undefined ? 'open' : 'closed', steps: [], data: { get: () => undefined },
  })
  const user = (text: string, location: TurnLocation, seq = location.turn * 10 + 1): ChatNode<'user'> => ({
    key: `user-${seq}`, kind: 'user', id: String(seq), target: 'chat', anchorSeq: seq, visibility: 'visible',
    location: { kind: 'turn', turn: location }, data: { kind: 'user', seq, time: 0, source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
  const assistant = (text: string, location: TurnLocation, settled = true, seq = location.turn * 10 + 5): ChatNode<'assistant-step'> => {
    const finalNode: AssistantMessageNode = { kind: 'assistant', seq, time: 0, turn: location.turn, step: seq, blocks: [{ kind: 'text', text }] }
    return {
      key: `assistant-${seq}`, kind: 'assistant-step', id: String(seq), target: 'chat', anchorSeq: seq, visibility: 'visible',
      location: { kind: 'turn', turn: location },
      data: {
        status: settled ? 'settled' : 'running', turn: location.turn, step: seq, time: 0,
        blocks: finalNode.blocks, ...(settled ? { finalNode } : {}),
      },
    }
  }
  const set = (
    nextNodes: readonly ChatConversationViewNode[], turns: readonly TurnLocation[], patch: Partial<ConversationSnapshot> = {},
  ): void => {
    nodes = nextNodes
    publish({ ...patch, chat: {
      ...snapshot.chat,
      timeline: { turnOrder: turns.map(item => item.turn), turns: new Map(turns.map(item => [item.turn, item])) },
    } })
  }
  const disconnect = (value: boolean): void => {
    connected = value
    for (const listener of connectionListeners) listener()
  }
  const controller = new AbortController()
  const request = () => requestJdResponse(session, 'requested prompt', { idleTimeoutMs: 1000, signal: controller.signal, connection })
  return { session, prompt, publish, turn, user, assistant, set, disconnect, request, controller, listeners, connectionListeners }
}

afterEach(() => { vi.useRealTimers() })

test('observes receipt before prompt resolves and returns malformed settled output only after turn end', async () => {
  const h = harness()
  h.prompt.mockImplementation(async () => {
    expect(h.listeners.size).toBe(1)
    const active = h.turn(1)
    h.set([h.user('requested prompt', active), h.assistant('{"premature":true}', active)], [active], { running: true })
    return { ok: true, value: { accepted: true } }
  })
  const result = h.request()
  const observed = vi.fn()
  void result.then(observed)
  await Promise.resolve()
  expect(observed).not.toHaveBeenCalled()
  const completed = h.turn(1, { kind: 'completed' })
  h.set([h.user('requested prompt', completed), h.assistant('malformed final output', completed)], [completed], { running: false })
  await expect(result).resolves.toBe('malformed final output')
  expect(h.listeners.size + h.connectionListeners.size).toBe(0)
})

test('active reasoning and an open owned turn have no five-minute deadline', async () => {
  vi.useFakeTimers()
  const h = harness()
  const result = h.request()
  const active = h.turn(1)
  h.set([h.user('requested prompt', active), h.assistant('', active, false)], [active], { running: true, partial: { turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'working' }] } })
  await vi.advanceTimersByTimeAsync(600_000)
  h.publish({ running: false })
  await vi.advanceTimersByTimeAsync(600_000)
  const completed = h.turn(1, { kind: 'completed' })
  h.set([h.user('requested prompt', completed), h.assistant('', completed)], [completed])
  await expect(result).resolves.toBe('')
  expect(vi.getTimerCount()).toBe(0)
})

test('queued prompts ignore the earlier running turn and select the last assistant of their own turn', async () => {
  const h = harness()
  const previous = h.turn(1)
  h.set([h.user('earlier prompt', previous)], [previous], { running: true })
  const result = h.request()
  const observed = vi.fn()
  void result.then(observed)
  const previousEnd = h.turn(1, { kind: 'completed' })
  h.set([h.user('earlier prompt', previousEnd), h.assistant('{"previous":true}', previousEnd)], [previousEnd], { running: false })
  await Promise.resolve()
  expect(observed).not.toHaveBeenCalled()
  const own = h.turn(2, { kind: 'completed' })
  h.set([h.user('earlier prompt', previousEnd), h.assistant('{"previous":true}', previousEnd), h.user('requested prompt', own), h.assistant('first', own, true, 24), h.assistant('last', own, true, 25)], [previousEnd, own])
  await expect(result).resolves.toBe('last')
})

test('reconnection resumes observation without submitting a duplicate and starts a fresh idle interval', async () => {
  vi.useFakeTimers()
  const h = harness()
  const result = h.request()
  h.disconnect(false)
  await vi.advanceTimersByTimeAsync(900)
  h.disconnect(true)
  await vi.advanceTimersByTimeAsync(900)
  const own = h.turn(1, { kind: 'completed' })
  h.set([h.user('requested prompt', own), h.assistant('done', own)], [own])
  await expect(result).resolves.toBe('done')
  expect(h.prompt).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('disconnected waiting is bounded even when the last snapshot was running', async () => {
  vi.useFakeTimers()
  const h = harness()
  h.publish({ running: true })
  const result = h.request()
  const rejected = expect(result).rejects.toThrow('连接中断')
  h.disconnect(false)
  await vi.advanceTimersByTimeAsync(1000)
  await rejected
  expect(h.listeners.size + h.connectionListeners.size).toBe(0)
})

test.each([
  ['blocked', '生成正在等待处理'],
  ['interrupted', '生成已中断'],
  ['max-tokens', '模型输出达到长度限制'],
] as const)('rejects %s endings without returning partial JSON', async (kind, message) => {
  const h = harness()
  const result = h.request()
  const rejected = expect(result).rejects.toThrow(message)
  const own = h.turn(1, { kind })
  h.set([h.user('requested prompt', own), h.assistant('{"partial":true}', own)], [own])
  await rejected
  expect(h.listeners.size + h.connectionListeners.size).toBe(0)
})

test('abort disposes observers while an unresolved prompt rejection remains handled', async () => {
  vi.useFakeTimers()
  const h = harness()
  let rejectPrompt: ((error: Error) => void) | undefined
  h.prompt.mockImplementation(() => new Promise((_resolve, reject) => { rejectPrompt = reject }))
  const result = h.request()
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  h.controller.abort()
  rejectPrompt?.(new Error('late transport rejection'))
  await rejected
  await Promise.resolve()
  expect(h.listeners.size + h.connectionListeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

test('idle publications without new evidence do not postpone timeout', async () => {
  vi.useFakeTimers()
  const h = harness()
  const result = h.request()
  const rejected = expect(result).rejects.toThrow('等待响应超时')
  await vi.advanceTimersByTimeAsync(900)
  h.publish()
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  expect(h.listeners.size + h.connectionListeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

test('already cancelled requests do not submit a prompt', async () => {
  const h = harness()
  h.controller.abort()
  await expect(h.request()).rejects.toMatchObject({ name: 'AbortError' })
  expect(h.prompt).not.toHaveBeenCalled()
  expect(h.listeners.size + h.connectionListeners.size).toBe(0)
})

test('prompt rejection removes subscriptions and the pending idle timer', async () => {
  vi.useFakeTimers()
  const h = harness()
  h.prompt.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'request unavailable', details: {} } })
  await expect(h.request()).rejects.toThrow('request unavailable')
  expect(h.listeners.size + h.connectionListeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

test.each([
  [{ kind: 'aborted', reason: { kind: 'user' } }, '生成已停止'],
  [{ kind: 'error', error: { code: 'AUTH', message: 'provider secret diagnostic' } }, 'API key is invalid'],
] as const)('rejects unsuccessful durable turn %j with display-safe copy', async (reason, message) => {
  const h = harness()
  const result = h.request()
  const rejected = expect(result).rejects.toThrow(message)
  const own = h.turn(1, reason)
  h.set([h.user('requested prompt', own), h.assistant('{"partial":true}', own)], [own])
  await rejected
  expect(h.listeners.size + h.connectionListeners.size).toBe(0)
})

test.each(['removed', 'openError', 'lastAgentError'] as const)('rejects %s and removes every observer', async (failure) => {
  vi.useFakeTimers()
  const h = harness()
  const result = h.request()
  const rejected = expect(result).rejects.toThrow()
  if (failure === 'removed') h.publish({ removed: true })
  else if (failure === 'openError') h.publish({ openError: { code: 'internal', message: 'cannot open', details: {} } })
  else h.publish({ lastAgentError: 'model failed' })
  await rejected
  expect(h.listeners.size + h.connectionListeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
