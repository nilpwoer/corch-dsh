import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS } from '@deepseek-ai/dsh-client-runtime/client'
import type { AssistantMessageNode, ConversationSnapshot, SessionFace, UserMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import { parseJdAgentJson, parseJdJobs, promptJdAgent, readCompletedJdSearch } from '../src/client/jdAgentResult.ts'
import { buildJdSearchPrompt } from '../src/client/jdSearchPrompt.ts'
import type { JdSearchJob, JdSearchRequest } from '../src/client/types.ts'

const request: JdSearchRequest = {
  major: '智慧养老服务', direction: '', roles: ['养老护理员'], platforms: ['公开网页'],
  region: '四川及西南地区', publishedWithin: '最近 90 天', targetCount: '5 条（测试）',
}
const job: JdSearchJob = {
  id: 'JD-001', title: '养老护理员', company: '示例机构', place: '成都', platform: '公开网页',
  score: 91, summary: '提供生活照料', body: '负责起居和饮食照护，并记录服务情况。', sourceUrl: 'https://example.com/jd/1',
}
const text = JSON.stringify({ jobs: [job] })
const prompt = buildJdSearchPrompt(request)

function user(seq: number, value = prompt): UserMessageNode {
  return { kind: 'user', seq, time: seq * 1000, content: [{ type: 'text', text: value }], source: { kind: 'user' } }
}

function assistant(seq: number, value = text, turn = 1): AssistantMessageNode {
  return { kind: 'assistant', seq, time: seq * 1000, turn, step: 1, blocks: [{ kind: 'text', text: value }] }
}

function snapshot(patch: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: 'jd-result' as ConversationSnapshot['sessionId'], views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [], pending: [], queue: [],
    running: false, subagent: null, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null, ...patch,
  }
}

function harness(initial: Partial<ConversationSnapshot> = {}) {
  let current = snapshot(initial)
  const listeners = new Set<() => void>()
  const send = vi.fn<SessionFace['prompt']>().mockResolvedValue({ ok: true, value: { accepted: true } })
  let onSubscribe: (() => void) | undefined
  const session = {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      onSubscribe?.()
      return () => { listeners.delete(listener) }
    },
    prompt: send,
  } satisfies Pick<SessionFace, 'getSnapshot' | 'subscribe' | 'prompt'>
  const publish = (patch: Partial<ConversationSnapshot>): void => {
    current = { ...current, ...patch }
    for (const listener of [...listeners]) listener()
  }
  return { session, send, listeners, publish, onSubscribe: (callback: () => void) => { onSubscribe = callback } }
}

function finished(nodes: ConversationSnapshot['nodes'] = [user(2), assistant(4)]): Pick<ConversationSnapshot, 'nodes' | 'turnEnds'> {
  return { nodes, turnEnds: new Map([[1, 5]]) }
}

afterEach(() => { vi.useRealTimers() })

describe('JD agent turn completion', () => {
  it('waits beyond five minutes and does not accept partial JSON before turn/end', async () => {
    vi.useFakeTimers()
    const h = harness({ nodes: [assistant(2, '{"roles":["旧岗位"]}')], turnEnds: new Map([[1, 3]]) })
    const result = promptJdAgent(h.session, prompt)
    const settled = vi.fn()
    void result.then(settled, settled)
    await Promise.resolve()
    h.publish({ running: true, nodes: [assistant(2, '{"roles":["旧岗位"]}'), user(5)], partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text }] } })
    await vi.advanceTimersByTimeAsync(300001)
    expect(settled).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(1)
    h.publish({ partial: null, nodes: [user(5), assistant(7, text, 2)] })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    h.publish({ running: false, turnEnds: new Map([[1, 3], [2, 8]]) })
    await expect(result).resolves.toBe(text)
    expect(h.listeners.size).toBe(0)
  })

  it('returns the last assistant text in the admitted turn, excluding old roles and intermediate JSON', async () => {
    const h = harness({ nodes: [assistant(1, '{"roles":["旧岗位"]}')], turnEnds: new Map([[1, 2]]) })
    const result = promptJdAgent(h.session, prompt)
    await Promise.resolve()
    h.publish({ nodes: [assistant(1, '{"roles":["旧岗位"]}'), user(4), assistant(5, '{"status":"searching"}', 2), assistant(7, text, 2)], turnEnds: new Map([[1, 2], [2, 8]]) })
    await expect(result).resolves.toBe(text)
    expect(h.send).toHaveBeenCalledWith([{ type: 'text', text: prompt }], 'queue', undefined)
    expect(h.listeners.size).toBe(0)
  })

  it('retains its ended result until the session reaches idle and ignores later-turn errors', async () => {
    const h = harness()
    const result = promptJdAgent(h.session, prompt)
    const settled = vi.fn()
    void result.then(settled, settled)
    await Promise.resolve()
    h.publish({ ...finished(), running: true })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    const id = 'next' as ConversationSnapshot['queue'][number]['id']
    h.publish({ queue: [{ id, messageId: id, placement: 'queued', content: [], preview: '', text: null }] })
    h.publish({ running: false, lastAgentError: '后续任务失败', nodes: [user(2), assistant(4), user(8, '后续任务'), assistant(9, '后续内容', 2)] })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    h.publish({ queue: [], turnEnds: new Map([[1, 5], [2, 10]]) })
    await expect(result).resolves.toBe(text)
    expect(h.listeners.size).toBe(0)
  })

  it('observes a fast completed turn that arrives before the RPC acceptance', async () => {
    const h = harness()
    let accept!: (value: Awaited<ReturnType<SessionFace['prompt']>>) => void
    h.send.mockImplementation(() => new Promise((resolve) => { accept = resolve }))
    const result = promptJdAgent(h.session, prompt)
    h.publish(finished())
    const settled = vi.fn()
    void result.then(settled, settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    accept({ ok: true, value: { accepted: true } })
    await expect(result).resolves.toBe(text)
    expect(h.listeners.size).toBe(0)
  })

  it('subscribes before sending, including synchronous subscription notifications', async () => {
    const h = harness()
    h.onSubscribe(() => { h.publish({}) })
    h.send.mockImplementation(async () => {
      expect(h.listeners.size).toBe(1)
      h.publish(finished())
      return { ok: true, value: { accepted: true } }
    })
    await expect(promptJdAgent(h.session, prompt)).resolves.toBe(text)
    expect(h.listeners.size).toBe(0)
  })

  it('rejects an already running session without sending or subscribing', async () => {
    const h = harness({ running: true })
    await expect(promptJdAgent(h.session, prompt)).rejects.toThrow('正在运行或排队')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)
  })

  it('rejects queued work even before the running flag changes', async () => {
    const id = 'queued' as ConversationSnapshot['queue'][number]['id']
    const h = harness({ queue: [{ id, messageId: id, placement: 'queued', content: [], preview: '等待任务', text: '等待任务' }] })
    await expect(promptJdAgent(h.session, prompt)).rejects.toThrow('正在运行或排队')
    expect(h.send).not.toHaveBeenCalled()
  })

  it('rechecks idle after subscribing when another task starts synchronously', async () => {
    const h = harness()
    h.onSubscribe(() => { h.publish({ running: true }) })
    await expect(promptJdAgent(h.session, prompt)).rejects.toThrow('正在运行或排队')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)
  })

  it.each([
    ['removed', { removed: true }, '已移除'],
    ['open error', { openError: { code: 'internal', message: '连接已断开', details: {} } }, '无法读取'],
    ['agent error', { lastAgentError: '模型请求失败' }, '模型请求失败'],
  ] satisfies [string, Partial<ConversationSnapshot>, string][])('cleans up on %s', async (_name, patch, message) => {
    const h = harness()
    const result = promptJdAgent(h.session, prompt)
    const failure = expect(result).rejects.toThrow(message)
    await Promise.resolve()
    h.publish(patch)
    await failure
    expect(h.listeners.size).toBe(0)
  })

  it('rejects a durable turn error even when an assistant JSON result exists', async () => {
    const h = harness()
    const result = promptJdAgent(h.session, prompt)
    const failure = expect(result).rejects.toThrow('搜索工具失败')
    await Promise.resolve()
    h.publish(finished([user(2), assistant(4), { kind: 'turn-error', seq: 5, time: 5000, turn: 1, step: 1, message: '搜索工具失败' }]))
    await failure
    expect(h.listeners.size).toBe(0)
  })

  it('rejects an interrupted assistant without accepting its complete-looking prefix', async () => {
    const h = harness()
    const result = promptJdAgent(h.session, prompt)
    const failure = expect(result).rejects.toThrow('已中止')
    await Promise.resolve()
    h.publish({ nodes: [user(2), { ...assistant(4), interrupted: true }] })
    await failure
    expect(h.listeners.size).toBe(0)
  })

  it('rejects the fractional interruption node published after the closing event sequence', async () => {
    const h = harness()
    const result = promptJdAgent(h.session, prompt)
    const failure = expect(result).rejects.toThrow('已中止')
    await Promise.resolve()
    h.publish(finished([user(2), { ...assistant(5.25), interrupted: true }]))
    await failure
    expect(h.listeners.size).toBe(0)
  })

  it.each([
    ['no assistant', [user(2)], '没有返回结果'],
    ['no text', [user(2), { ...assistant(4), blocks: [] }], '没有返回文字'],
    ['token limit', [user(2), assistant(4), { kind: 'turn-max-tokens', seq: 5, time: 5000, turn: 1, step: 1 }], '长度上限'],
  ] satisfies [string, ConversationSnapshot['nodes'], string][])('rejects an ended turn with %s', async (_name, nodes, message) => {
    const h = harness()
    const result = promptJdAgent(h.session, prompt)
    const failure = expect(result).rejects.toThrow(message)
    await Promise.resolve()
    h.publish(finished(nodes))
    await failure
    expect(h.listeners.size).toBe(0)
  })

  it('does not use another user message to attribute a completed turn', async () => {
    const h = harness()
    const result = promptJdAgent(h.session, prompt)
    const failure = expect(result).rejects.toThrow('没有记录本次请求')
    await Promise.resolve()
    h.publish(finished([user(2, '其他聊天'), assistant(4)]))
    await failure
  })

  it('handles rejected admission and transport rejections without retaining listeners', async () => {
    const rejected = harness()
    rejected.send.mockResolvedValue({ ok: false, error: { code: 'internal', message: '任务被拒绝', details: {} } })
    await expect(promptJdAgent(rejected.session, prompt)).rejects.toThrow('任务被拒绝')
    expect(rejected.listeners.size).toBe(0)
    const broken = harness()
    broken.send.mockRejectedValue(new Error('连接失败'))
    await expect(promptJdAgent(broken.session, prompt)).rejects.toThrow('连接失败')
    expect(broken.listeners.size).toBe(0)
  })

  it('cancels while the RPC is pending and consumes a later RPC rejection', async () => {
    const h = harness()
    const controller = new AbortController()
    let rejectRpc!: (error: Error) => void
    h.send.mockImplementation(() => new Promise((_resolve, reject) => { rejectRpc = reject }))
    const result = promptJdAgent(h.session, prompt, controller.signal)
    const failure = expect(result).rejects.toThrow('已取消')
    controller.abort()
    await failure
    expect(h.listeners.size).toBe(0)
    rejectRpc(new Error('请求已取消'))
    await Promise.resolve()
  })

  it('does not send an already cancelled request or an unavailable session', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    await expect(promptJdAgent(h.session, prompt, controller.signal)).rejects.toThrow('已取消')
    expect(h.send).not.toHaveBeenCalled()
    await expect(promptJdAgent(harness({ removed: true }).session, prompt)).rejects.toThrow('已移除')
    await expect(promptJdAgent(harness({ openError: { code: 'internal', message: '断线', details: {} } }).session, prompt)).rejects.toThrow('无法读取')
  })

  it('cleans up an accepted wait when the caller cancels', async () => {
    const h = harness()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = promptJdAgent(h.session, prompt, controller.signal)
    const failure = expect(result).rejects.toThrow('已取消')
    await Promise.resolve()
    h.publish({ running: true, nodes: [user(2)] })
    controller.abort()
    await failure
    expect(h.listeners.size).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('cleans up if a synchronous subscription notification removes the session', async () => {
    const h = harness()
    h.onSubscribe(() => { h.publish({ removed: true }) })
    await expect(promptJdAgent(h.session, prompt)).rejects.toThrow('已移除')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)
  })
})

describe('JD JSON validation and history recovery', () => {
  it('parses plain or fenced JSON without accepting malformed or absent objects', () => {
    expect(parseJdAgentJson('```json\n{"roles":["护理员"]}\n```')).toEqual({ roles: ['护理员'] })
    expect(() => parseJdAgentJson('没有结果')).toThrow('不是 JSON')
    expect(() => parseJdAgentJson('{"jobs":')).toThrow('不是 JSON')
    expect(() => parseJdAgentJson('{broken}')).toThrow('无法解析')
  })

  it('keeps the complete-body, score, source field and unique-id checks', () => {
    expect(parseJdJobs(text)).toEqual([job])
    expect(() => parseJdJobs('{"roles":[]}')).toThrow('缺少 jobs')
    expect(() => parseJdJobs(JSON.stringify({ jobs: [{ ...job, body: ' ' }] }))).toThrow('完整 JD 正文')
    expect(() => parseJdJobs(JSON.stringify({ jobs: [{ ...job, body: undefined }] }))).toThrow('完整 JD 正文')
    expect(() => parseJdJobs(JSON.stringify({ jobs: [{ ...job, score: 101 }] }))).toThrow('无效字段')
    expect(() => parseJdJobs(JSON.stringify({ jobs: [{ ...job, sourceUrl: 17 }] }))).toThrow('无效字段')
    expect(() => parseJdJobs(JSON.stringify({ jobs: [job, job] }))).toThrow('编号重复')
  })

  it('restores a completed search without making another model request', () => {
    expect(readCompletedJdSearch(finished())).toEqual({ request, jobs: [job], completedAt: 4000 })
  })

  it('selects the latest search and ignores later unrelated role inference', () => {
    const newer = { ...request, major: '社区健康服务' }
    const history = { nodes: [user(2), assistant(4), user(7, buildJdSearchPrompt(newer)), assistant(9, text, 2), user(12, '推理岗位'), assistant(14, '{"roles":["护理员"]}', 3)], turnEnds: new Map([[1, 5], [2, 10], [3, 15]]) }
    expect(readCompletedJdSearch(history)?.request).toEqual(newer)
    expect(readCompletedJdSearch(history)?.completedAt).toBe(9000)
  })

  it('does not restore an older search when the newest search is unfinished or failed', () => {
    const nodes = [user(2), assistant(4), user(7)]
    expect(readCompletedJdSearch({ nodes, turnEnds: new Map([[1, 5]]) })).toBeUndefined()
    expect(readCompletedJdSearch({ nodes: [...nodes, assistant(9, '任务失败', 2)], turnEnds: new Map([[1, 5], [2, 10]]) })).toBeUndefined()
    expect(readCompletedJdSearch({ nodes: [...nodes, assistant(9, text, 2), { kind: 'turn-error', seq: 10, time: 10000, turn: 2, step: 1, message: '失败' }], turnEnds: new Map([[1, 5], [2, 10]]) })).toBeUndefined()
  })

  it('rejects edited prompt text, invalid requests, interrupted output and duplicate jobs', () => {
    expect(readCompletedJdSearch(finished([user(2, prompt + '\n任意聊天补充'), assistant(4)]))).toBeUndefined()
    expect(readCompletedJdSearch(finished([user(2, '执行一次岗位 JD 搜索。搜索条件：{"major":17}。'), assistant(4)]))).toBeUndefined()
    expect(readCompletedJdSearch(finished([user(2), { ...assistant(4), interrupted: true }]))).toBeUndefined()
    expect(readCompletedJdSearch(finished([user(2), assistant(4, JSON.stringify({ jobs: [job, job] }))]))).toBeUndefined()
    expect(readCompletedJdSearch({ nodes: [], turnEnds: new Map() })).toBeUndefined()
  })

  it('recognizes exact generated requests containing braces and quote escapes', () => {
    const special = { ...request, direction: '研究 } 与 "照护"' }
    expect(readCompletedJdSearch(finished([user(2, buildJdSearchPrompt(special)), assistant(4)]))?.request).toEqual(special)
  })
})
