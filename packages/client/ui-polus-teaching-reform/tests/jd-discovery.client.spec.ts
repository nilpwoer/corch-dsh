import { Context } from '@deepseek-ai/cordis'
import { expect, test, vi } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { JdDiscoveryGuard } from '../src/jd/discovery.ts'
import { projectFixture } from './jd-fixture.client.ts'

async function harness(maxCalls = 2) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const executed = vi.fn(() => [])
  for (const name of ['web_search', 'web_fetch', 'shell', 'execute_script', 'spawn_agent'])
    ctx.tools.register(defineContentToolFixture({ name, description: name, parameters: {}, async execute() { return executed() } }))
  const project = projectFixture()
  const state: { guard?: JdDiscoveryGuard } = {}
  const fiber = await ctx.plugin({ apply(inner: Context) {
    state.guard = new JdDiscoveryGuard(inner, Promise.resolve([project]), maxCalls)
  } })
  if (!state.guard) throw new Error('Discovery policy was not installed')
  const guard = state.guard
  const agent = { session: { id: project.session_id } } as NonNullable<ToolExecution['agent']>
  const call = (name: string, caller = agent) => ctx.tools.execute({
    callId: CallId(crypto.randomUUID()), name, arguments: {}, agent: caller, signal: new AbortController().signal,
  })
  return { ctx, guard, executed, project, agent, call, fiber }
}

test('restored JD conversations deny anonymous fetch and fallback tools through the actual executor', async () => {
  const { ctx, guard, executed, project, call } = await harness()
  expect((await call('web_search')).isError).toBe(true)
  await guard.begin(project.session_id)
  for (const name of ['web_fetch', 'shell', 'execute_script', 'spawn_agent']) expect((await call(name)).isError).toBe(true)
  expect(executed).not.toHaveBeenCalled()
  expect((await call('web_search')).isError).toBe(false)
  expect(executed).toHaveBeenCalledTimes(1)
  await ctx.fiber.dispose()
})

test('search budget counts concurrent dispatches and a closed operation denies late calls', async () => {
  const { ctx, guard, executed, project, call } = await harness()
  await guard.begin(project.session_id)
  await expect(guard.begin(project.session_id)).rejects.toThrow('尚未结束')
  const results = await Promise.all(Array.from({ length: 4 }, () => call('web_search')))
  expect(results.filter(result => !result.isError)).toHaveLength(2)
  guard.end(project.session_id)
  expect((await call('web_search')).isError).toBe(true)
  expect((await call('web_fetch')).isError).toBe(true)
  expect(executed).toHaveBeenCalledTimes(2)
  await guard.begin(project.session_id)
  expect((await call('web_search')).isError).toBe(false)
  await ctx.fiber.dispose()
})

test('unrelated conversations keep their tools and newly saved research sessions become restricted', async () => {
  const { ctx, guard, executed, call } = await harness()
  const other = { session: { id: 'unrelated' } } as NonNullable<ToolExecution['agent']>
  expect((await call('shell', other)).isError).toBe(false)
  await expect(guard.begin(other.session.id)).rejects.toThrow('不是已存档')
  guard.remember(other.session.id)
  expect((await call('shell', other)).isError).toBe(true)
  expect(executed).toHaveBeenCalledTimes(1)
  await ctx.fiber.dispose()
})

test('disposing the owning plugin removes the execution restriction', async () => {
  const { ctx, call, fiber } = await harness()
  expect((await call('web_fetch')).isError).toBe(true)
  await fiber.dispose()
  expect((await call('web_fetch')).isError).toBe(false)
  await ctx.fiber.dispose()
})
