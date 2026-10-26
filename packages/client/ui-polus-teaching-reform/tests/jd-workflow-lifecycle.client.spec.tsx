// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { JdSearchWorkbench } from '../src/client/JdSearchWorkbench.tsx'
import { readJdSearchProject } from '../src/client/jdSearchProjects.ts'
import type { JdSearchJob, TeachingReformProps } from '../src/client/types.ts'

const A = 'workflow-A' as TeachingReformProps['sessionId']
const B = 'workflow-B' as TeachingReformProps['sessionId']
const OLD_JOB: JdSearchJob = {
  id: 'JD-old', title: '旧岗位', company: '合成机构', place: '成都', platform: '公开网页',
  score: 90, summary: '旧摘要', body: '旧工作流独有的岗位正文。', sourceUrl: 'https://example.invalid/old',
}
const NEW_JOB: JdSearchJob = { ...OLD_JOB, id: 'JD-new', title: '新岗位', body: '新工作流独有的岗位正文。' }

function emptySnapshot(sessionId: TeachingReformProps['sessionId']): ConversationSnapshot {
  return {
    sessionId, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [], pending: [], queue: [],
    running: false, subagent: null, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
  }
}

type WorkflowCallbacks = Pick<TeachingReformProps,
  'runJdSearch' | 'renameJdSearchProject' | 'saveJdSearchArtifacts' | 'cancelJdWorkflow'>

function componentProps(sessionId: TeachingReformProps['sessionId'], callbacks: WorkflowCallbacks): TeachingReformProps {
  const snapshot = emptySnapshot(sessionId)
  const unused = (): never => { throw new Error('Unused framework hook in JD lifecycle fixture') }
  return {
    sessionId, useSession: selector => selector(snapshot),
    useSessions: unused, useWorkspaces: unused, useProjection: unused,
    useInput: unused,
    inputActions: { setDraft: unused, addImages: unused, removeImage: unused, pruneImages: unused, submit: unused },
    generateInterview: async () => '', observeInterviewCommands: () => () => undefined,
    inferJdRoles: async () => ['护理员'], analyzeJdSearch: unused,
    openJdSearchReport: async () => {}, ...callbacks,
  }
}

function startSearch(): void {
  const inputs = screen.getAllByRole('textbox')
  fireEvent.change(inputs[0]!, { target: { value: '合成专业' } })
  fireEvent.change(inputs[2]!, { target: { value: '护理员' } })
  fireEvent.click(screen.getByRole('button', { name: '确认岗位并继续' }))
  fireEvent.click(screen.getByRole('button', { name: '开始检索' }))
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

it('keeps the current A workflow busy when an earlier A rename completes after A → B → A', async () => {
  const renameGate = Promise.withResolvers<undefined>()
  const searchGate = Promise.withResolvers<readonly JdSearchJob[]>()
  const runSearch = vi.fn<TeachingReformProps['runJdSearch']>()
    .mockResolvedValueOnce([OLD_JOB]).mockImplementationOnce(() => searchGate.promise)
  const rename = vi.fn<TeachingReformProps['renameJdSearchProject']>()
    .mockImplementationOnce(() => renameGate.promise).mockResolvedValue(undefined)
  const save = vi.fn<TeachingReformProps['saveJdSearchArtifacts']>()
    .mockRejectedValueOnce(new Error('旧工作流保存失败')).mockResolvedValue(undefined)
  const cancel = vi.fn<TeachingReformProps['cancelJdWorkflow']>().mockResolvedValue(undefined)
  const props = (sessionId: TeachingReformProps['sessionId']): TeachingReformProps => componentProps(sessionId, {
    runJdSearch: runSearch,
    renameJdSearchProject: rename, saveJdSearchArtifacts: save, cancelJdWorkflow: cancel,
  })
  const view = render(<JdSearchWorkbench {...props(A)} />)
  startSearch()
  await waitFor(() => { expect(rename).toHaveBeenCalledTimes(1) })
  expect(screen.getByText(OLD_JOB.body!, { exact: true })).toBeTruthy()
  const oldSignal = runSearch.mock.calls[0]?.[2]
  expect(oldSignal?.aborted).toBe(false)

  view.rerender(<JdSearchWorkbench {...props(B)} />)
  expect(screen.getByRole('heading', { name: '从学科专业推理实际岗位' })).toBeTruthy()
  view.rerender(<JdSearchWorkbench {...props(A)} />)
  expect(screen.getByRole('heading', { name: '筛选和确认岗位 JD' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /平台与范围/ }))
  fireEvent.click(screen.getByRole('button', { name: '开始检索' }))
  expect(runSearch).toHaveBeenCalledTimes(2)
  const newSignal = runSearch.mock.calls[1]?.[2]
  expect(newSignal).not.toBe(oldSignal)
  expect(newSignal?.aborted).toBe(false)

  await act(async () => { renameGate.resolve(undefined); await renameGate.promise })
  await waitFor(() => { expect(save).toHaveBeenCalledTimes(1) })
  expect(save.mock.calls[0]?.[0]).toBe(A)
  expect(save.mock.calls[0]?.[1][0]?.contents).toContain(OLD_JOB.body)
  expect(save.mock.calls[0]?.[2]).toBe(oldSignal)
  expect(oldSignal?.aborted).toBe(false)
  expect(readJdSearchProject(B)).toBeUndefined()
  expect(screen.queryByText(/旧工作流保存失败/)).toBeNull()
  expect(screen.getByRole('button', { name: '正在检索…' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '取消工作流' })).toBeTruthy()
  expect(newSignal?.aborted).toBe(false)
  expect(cancel).not.toHaveBeenCalled()

  await act(async () => { searchGate.resolve([NEW_JOB]); await searchGate.promise })
  await waitFor(() => { expect(save).toHaveBeenCalledTimes(2) })
  expect(screen.getByText(NEW_JOB.body!, { exact: true })).toBeTruthy()
  expect(readJdSearchProject(A)?.jobs).toEqual([NEW_JOB])
  expect(readJdSearchProject(B)).toBeUndefined()
  expect(screen.queryByText(/旧工作流保存失败/)).toBeNull()
})

it('finishes local cancellation while rename is pending and never starts the subsequent save', async () => {
  const id = 'workflow-cancel-rename' as TeachingReformProps['sessionId']
  const renameGate = Promise.withResolvers<undefined>()
  const runSearch = vi.fn<TeachingReformProps['runJdSearch']>().mockResolvedValue([OLD_JOB])
  const rename = vi.fn<TeachingReformProps['renameJdSearchProject']>().mockImplementation(() => renameGate.promise)
  const save = vi.fn<TeachingReformProps['saveJdSearchArtifacts']>().mockResolvedValue(undefined)
  const cancel = vi.fn<TeachingReformProps['cancelJdWorkflow']>().mockResolvedValue(undefined)
  render(<JdSearchWorkbench {...componentProps(id, {
    runJdSearch: runSearch, renameJdSearchProject: rename, saveJdSearchArtifacts: save, cancelJdWorkflow: cancel,
  })} />)
  startSearch()
  await waitFor(() => { expect(rename).toHaveBeenCalledTimes(1) })
  expect(screen.getByRole('button', { name: '正在生成…' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: '取消工作流' }))
  await waitFor(() => { expect(cancel).toHaveBeenCalledWith(id) })
  await waitFor(() => { expect(screen.queryByRole('button', { name: '取消工作流' })).toBeNull() })
  expect(screen.getByRole('button', { name: '确认 1 条并生成任务' })).toHaveProperty('disabled', false)
  expect(screen.getByText('已取消 JD 工作流', { exact: true })).toBeTruthy()
  expect(runSearch.mock.calls[0]?.[2]?.aborted).toBe(true)
  expect(save).not.toHaveBeenCalled()

  await act(async () => { renameGate.resolve(undefined); await renameGate.promise })
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByText('已取消 JD 工作流', { exact: true })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '取消工作流' })).toBeNull()
})
