import { expect, test, vi } from 'vitest'
import { generateValidatedJdGraph } from '../src/client/jdGraphGeneration.ts'
import { buildJdGraphPrompt } from '../src/client/jdSearchPrompt.ts'
import { graphFixture, projectFixture } from './jd-fixture.client.ts'

const policy = { maxGraphAttempts: 4, modelIdleTimeoutMs: 500 }

test('retries preserve the base instructions and return the actual rejected node to the model', async () => {
  const project = projectFixture(), original = structuredClone(project)
  const wrongBasis = graphFixture()
  wrongBasis[0]!.basis = 'direct'
  const invalidInputs = ['{"nodes":[', JSON.stringify({ nodes: graphFixture().slice(0, -1) }), JSON.stringify({ nodes: wrongBasis })]
  const responses = [...invalidInputs, JSON.stringify({ nodes: graphFixture() })]
  const base = buildJdGraphPrompt(project)
  const received: Record<string, unknown>[] = []
  const request = vi.fn(async (prompt: string) => {
    if (responses.length === 4) expect(prompt).toBe(base)
    else {
      expect(prompt.startsWith(base + '\n\n')).toBe(true)
      const feedback = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as Record<string, unknown>
      expect(feedback.type).toBe('jd_graph_validation_feedback')
      expect(feedback.failed_attempt).toBe(4 - responses.length)
      received.push(feedback)
    }
    return responses.shift()!
  })
  const progress = vi.fn()
  await expect(generateValidatedJdGraph(project, request, policy, progress, new AbortController().signal))
    .resolves.toEqual({ nodes: graphFixture() })
  expect(received[0]).toMatchObject({ category: 'invalid_json', issues: [] })
  expect(received[1]).toMatchObject({ category: 'invalid_graph', issues: [
    { code: 'incomplete_branch', node: { id: 'N4' }, expected_child_kind: 'knowledge' },
  ] })
  expect(received[2]).toMatchObject({ category: 'invalid_graph', issues: [
    { code: 'unsupported_direct', node: wrongBasis[0], fields: ['title', 'description'] },
  ] })
  expect(progress.mock.calls.at(-1)?.[0]).toContain('重新生成（4/4）')
  expect(project).toEqual(original)
  expect(wrongBasis[0]!.basis).toBe('direct')
})

test('valid output is returned on its first attempt without adding a correction message', async () => {
  const project = projectFixture()
  const request = vi.fn(async () => JSON.stringify({ nodes: graphFixture() }))
  await expect(generateValidatedJdGraph(project, request, policy, vi.fn(), new AbortController().signal))
    .resolves.toEqual({ nodes: graphFixture() })
  expect(request.mock.calls).toEqual([[buildJdGraphPrompt(project)]])
})

test('all invalid direct declarations are reported together and only model output changes their labels', async () => {
  const project = projectFixture(), rejected = graphFixture(), repaired = graphFixture()
  rejected[0]!.basis = rejected[2]!.basis = 'direct'
  const original = structuredClone(rejected)
  const request = vi.fn(async (prompt: string) => {
    if (request.mock.calls.length === 1) return JSON.stringify({ nodes: rejected })
    const feedback = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as { issues: { node: { id: string; basis: string } }[] }
    expect(feedback.issues.map(issue => issue.node.id)).toEqual(['N1', 'N3'])
    expect(feedback.issues.every(issue => issue.node.basis === 'direct')).toBe(true)
    return JSON.stringify({ nodes: repaired })
  })
  await expect(generateValidatedJdGraph(project, request, policy, vi.fn(), new AbortController().signal))
    .resolves.toEqual({ nodes: repaired })
  expect(rejected).toEqual(original)
})

test('exhaustion keeps the rejected inference marker and does not expose internal identifiers', async () => {
  const rejected = graphFixture()
  rejected[0]!.basis = 'direct'
  const request = vi.fn(async () => JSON.stringify({ nodes: rejected }))
  await expect(generateValidatedJdGraph(projectFixture(), request, policy, vi.fn(), new AbortController().signal))
    .rejects.toThrow('能力图谱连续 4 次未通过校验，未保存新版本。请重试或更换模型。部分归纳内容未正确标为推断。')
  expect(request).toHaveBeenCalledTimes(4)
  expect(rejected[0]!.basis).toBe('direct')
})

test('unmatched source quotations are rejected on every attempt rather than repaired', async () => {
  const rejected = graphFixture()
  rejected[0]!.evidence[0]!.quote = '不存在于原文的职责'
  const request = vi.fn(async () => JSON.stringify({ nodes: rejected }))
  const limits = { ...policy, maxGraphAttempts: 2 }
  await expect(generateValidatedJdGraph(projectFixture(), request, limits, vi.fn(), new AbortController().signal))
    .rejects.toThrow('来源引文或图谱内容未通过核验')
  expect(request).toHaveBeenCalledTimes(2)
})

test.each(['用户已停止生成', '连接已断开', '模型认证失败'])('request failure %s does not launch a graph retry', async (message) => {
  const request = vi.fn(async () => { throw new Error(message) })
  await expect(generateValidatedJdGraph(projectFixture(), request, policy, vi.fn(), new AbortController().signal)).rejects.toThrow(message)
  expect(request).toHaveBeenCalledTimes(1)
})

test('aborting after a rejected response prevents the next paid request', async () => {
  const lifetime = new AbortController()
  const request = vi.fn(async () => { lifetime.abort(); return '{' })
  await expect(generateValidatedJdGraph(projectFixture(), request, policy, vi.fn(), lifetime.signal)).rejects.toThrow()
  expect(request).toHaveBeenCalledTimes(1)
})

test('a partial login-walled original fails before any model request', async () => {
  const project = projectFixture()
  project.sources[0]!.body += '\n登录查看完整内容'
  const request = vi.fn()
  await expect(generateValidatedJdGraph(project, request, policy, vi.fn(), new AbortController().signal)).rejects.toThrow('完整内容登录限制')
  expect(request).not.toHaveBeenCalled()
})
