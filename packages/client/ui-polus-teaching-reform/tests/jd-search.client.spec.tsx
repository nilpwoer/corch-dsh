// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { JdSearchSidebar, JdSearchWorkbench } from '../src/client/JdSearchWorkbench.tsx'
import type { TeachingReformProps } from '../src/client/types.ts'
import type { JdProject, JdProjectSummary } from '../src/jd/types.ts'
import { projectId } from '../src/jd/document.ts'
import { graphFixture, projectFixture } from './jd-fixture.client.ts'
import { collectJdBrowser, exportJdHtml, hasJdBrowser, jdBrowserPlatforms, jdBrowserStatus,
  openJdBrowser, readJdBrowser, resumeJdBrowser, verifyJdBrowser } from '../src/client/jdNative.ts'

vi.mock('../src/client/jdNative.ts', () => ({
  jdBrowserStatus: vi.fn(), openJdBrowser: vi.fn(), readJdBrowser: vi.fn(), exportJdHtml: vi.fn(),
  collectJdBrowser: vi.fn(), hasJdBrowser: vi.fn(), jdBrowserPlatforms: vi.fn(), resumeJdBrowser: vi.fn(), verifyJdBrowser: vi.fn(),
  jdHash: vi.fn().mockResolvedValue('synthetic-hash'),
}))
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(jdBrowserStatus).mockResolvedValue(false)
  vi.mocked(hasJdBrowser).mockReturnValue(true)
  vi.mocked(jdBrowserPlatforms).mockResolvedValue([])
  vi.mocked(collectJdBrowser).mockResolvedValue({ items: [], platforms: [] })
  vi.mocked(verifyJdBrowser).mockResolvedValue(undefined)
  vi.mocked(openJdBrowser).mockResolvedValue('capture-window')
  vi.mocked(exportJdHtml).mockResolvedValue({ path: 'C:/Reports/graph.html', opened: 'browser' })
})
function draft(session = 'jd-test-session'): JdProject {
  return { ...projectFixture(), id: projectId(`${session}-project`), session_id: session as JdProject['session_id'],
    major: '', direction: '', roles: [], title: '未命名岗位研究', platforms: ['公开网页'], sources: [],
    workspace: { step: 1, graph_version: null, search_status: 'draft', error: '',
      capture: { url: '', title: '', company: '未披露', body: '', file_name: '' } } }
}
function fixture(initial: JdProject[] = [draft()]): {
  input: TeachingReformProps
  records: Map<string, JdProject>
} {
  const records = new Map(initial.map(item => [String(item.id), structuredClone(item)]))
  const save = async (value: JdProject): Promise<JdProject> => {
    const previous = records.get(value.id)
    if (previous && value.revision !== previous.revision) throw new Error('revision conflict')
    const saved = structuredClone({ ...value, revision: value.revision + 1 })
    records.set(value.id, saved)
    return structuredClone(saved)
  }
  const input = {
    sessionId: initial[0]!.session_id,
    generateInterview: vi.fn(), observeInterviewCommands: () => () => undefined,
    inferJdRoles: vi.fn().mockResolvedValue(['Python开发工程师']),
    runJdSearch: vi.fn().mockResolvedValue([]),
    generateJdGraph: vi.fn().mockResolvedValue({ nodes: graphFixture() }),
    pendingJdSources: () => [],
    listJdProjects: vi.fn().mockImplementation(async (): Promise<JdProjectSummary[]> => [...records.values()].map(value => ({
      id: value.id, session_id: value.session_id, title: value.title, revision: value.revision, updated_at: value.updated_at,
    }))),
    loadJdProject: vi.fn().mockImplementation(async (id: string) => structuredClone(records.get(id) ?? null)),
    initializeJdProject: vi.fn().mockImplementation(async (id: JdProject['session_id']) => save(draft(id))),
    saveJdProject: vi.fn().mockImplementation(save),
    createJdSearchSession: vi.fn().mockResolvedValue(undefined), openJdProject: vi.fn(),
    confirmJdProject: vi.fn().mockImplementation(async (id: string, version: number, revision: number) => {
      const value = records.get(id)
      if (!value || value.revision !== revision) throw new Error('revision conflict')
      return save({ ...value, confirmations: [...value.confirmations ?? [], { version, confirmed_at: new Date().toISOString() }] })
    }),
    exportJdProject: vi.fn().mockResolvedValue({ html: '<!doctype html><html>confirmed report</html>' }),
  } as unknown as TeachingReformProps
  return { input, records }
}
async function flush(): Promise<void> {
  await act(async () => {
    const detail: { waits: Promise<void>[] } = { waits: [] }
    window.dispatchEvent(new CustomEvent('jd-project-flush', { detail }))
    await Promise.all(detail.waits)
  })
}
async function enterSearch(): Promise<void> {
  await screen.findByRole('heading', { name: '从学科专业推理实际岗位' })
  fireEvent.change(screen.getByLabelText('学科 / 专业'), { target: { value: '计算机应用技术' } })
  fireEvent.click(screen.getByRole('button', { name: '推理岗位名称' }))
  await screen.findByText('已生成 1 个岗位建议，可继续编辑。')
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '确认岗位并继续' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: '确认岗位并继续' }))
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始检索' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: '开始检索' }))
}
test('role inference and search are archived in the owning JD session', async () => {
  const { input, records } = fixture()
  render(<JdSearchWorkbench {...input} />)
  await enterSearch()
  expect(input.inferJdRoles).toHaveBeenCalledWith(input.sessionId, '计算机应用技术', '')
  await screen.findByRole('heading', { name: 'JD 原文与来源' })
  expect(input.runJdSearch).toHaveBeenCalledWith(input.sessionId, expect.objectContaining({
    major: '计算机应用技术', roles: ['Python开发工程师'], targetCount: '5 条（测试）',
  }))
  await flush()
  expect(records.get(draft().id)?.workspace).toMatchObject({ step: 3, search_status: 'completed' })
  expect(screen.queryByText('直接登录采集或导入原文')).toBeNull()
})
test('failed searches retain their error and a fresh attempt creates another session', async () => {
  const { input, records } = fixture()
  vi.mocked(input.runJdSearch).mockRejectedValue(new Error('公开搜索服务暂时不可用'))
  render(<JdSearchWorkbench {...input} />)
  await enterSearch()
  expect(await screen.findByText('公开搜索服务暂时不可用')).toBeTruthy()
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '以此范围新建搜索' }).disabled).toBe(false) })
  expect(records.get(draft().id)?.workspace?.search_status).toBe('failed')
  fireEvent.click(screen.getByRole('button', { name: '以此范围新建搜索' }))
  await waitFor(() => { expect(input.createJdSearchSession).toHaveBeenCalledWith(expect.objectContaining({
    id: draft().id, major: '计算机应用技术',
  })) })
  expect(input.runJdSearch).toHaveBeenCalledTimes(1)
})
test('empty search results explain import and keep graph generation disabled', async () => {
  const { input } = fixture()
  render(<JdSearchWorkbench {...input} />)
  await enterSearch()
  expect(await screen.findByText('尚无已保存原文，可调整搜索范围、登录采集或导入正文。')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '使用 0 份原文生成五级图谱' }).disabled).toBe(true)
})
test('archived search targets and range are read-only until an independent search is created', async () => {
  const value = { ...draft(), major: '养老护理', roles: ['护理员'] }
  value.workspace = { ...value.workspace!, step: 2, search_status: 'completed' }
  const { input } = fixture([value])
  render(<JdSearchWorkbench {...input} />)
  await screen.findByLabelText('区域范围')
  expect(screen.getByLabelText('区域范围')).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('发布时间')).toHaveProperty('disabled', true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '以此范围新建搜索' }).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '1 搜索目标' }))
  await screen.findByLabelText('学科 / 专业')
  expect(screen.getByLabelText('学科 / 专业')).toHaveProperty('disabled', true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '推理岗位名称' }).disabled).toBe(true)
})
test('switching records flushes pending edits and restores target, filters and capture drafts', async () => {
  const a = draft('search-a')
  const b = draft('search-b')
  const { input, records } = fixture([a, b])
  const view = render(<JdSearchWorkbench {...input} />)
  await screen.findByLabelText('学科 / 专业')
  fireEvent.change(screen.getByLabelText('学科 / 专业'), { target: { value: '养老护理' } })
  fireEvent.change(screen.getByLabelText('专业方向（可选）'), { target: { value: '智慧养老' } })
  fireEvent.change(screen.getByLabelText('岗位名称（可手动修改，使用顿号分隔）'), { target: { value: '护理员、' } })
  fireEvent.click(screen.getByRole('button', { name: '确认岗位并继续' }))
  await waitFor(() => { expect(screen.getByLabelText<HTMLSelectElement>('区域范围').disabled).toBe(false) })
  fireEvent.change(screen.getByLabelText('区域范围'), { target: { value: '全国重点城市' } })
  fireEvent.change(screen.getByLabelText('发布时间'), { target: { value: '最近一年' } })
  fireEvent.change(screen.getByLabelText('目标条数'), { target: { value: '20-50 条' } })
  fireEvent.click(screen.getByRole('button', { name: '3 JD 原文' }))
  await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>('来源 URL').disabled).toBe(false) })
  fireEvent.change(screen.getByLabelText('来源 URL'), { target: { value: 'https://example.test/job/1' } })
  fireEvent.change(screen.getByLabelText('岗位名称'), { target: { value: '智能照护员' } })
  fireEvent.change(screen.getByLabelText('企业（可填未披露）'), { target: { value: '养老服务中心' } })
  fireEvent.change(screen.getByLabelText('导入 JD 原文'), { target: { value: '岗位职责：护理老人。' } })
  await flush()
  view.rerender(<JdSearchWorkbench {...input} sessionId={b.session_id} />)
  expect(await screen.findByLabelText<HTMLInputElement>('学科 / 专业')).toHaveProperty('value', '')
  view.rerender(<JdSearchWorkbench {...input} sessionId={a.session_id} />)
  expect(await screen.findByLabelText<HTMLInputElement>('来源 URL')).toHaveProperty('value', 'https://example.test/job/1')
  expect(screen.getByLabelText('导入 JD 原文')).toHaveProperty('value', '岗位职责：护理老人。')
  expect(screen.getByLabelText('岗位名称')).toHaveProperty('value', '智能照护员')
  expect(screen.getByLabelText('企业（可填未披露）')).toHaveProperty('value', '养老服务中心')
  expect(records.get(a.id)).toMatchObject({ major: '养老护理', direction: '智慧养老', region: '全国重点城市',
    published_within: '最近一年', target_count: '20-50 条', workspace: { role_text: '护理员、', step: 3 } })
})
test('an acknowledgement cannot overwrite a newer draft typed during an autosave', async () => {
  const { input, records } = fixture()
  const original = vi.mocked(input.saveJdProject).getMockImplementation()!
  let acknowledge: (() => void) | undefined
  vi.mocked(input.saveJdProject).mockImplementationOnce(async (value) => {
    await new Promise<void>((resolve) => { acknowledge = resolve })
    return original(value)
  })
  render(<JdSearchWorkbench {...input} />)
  await screen.findByLabelText('学科 / 专业')
  fireEvent.change(screen.getByLabelText('学科 / 专业'), { target: { value: '护理' } })
  await waitFor(() => { expect(acknowledge).toBeDefined() })
  fireEvent.change(screen.getByLabelText('学科 / 专业'), { target: { value: '智慧养老护理' } })
  await act(async () => { acknowledge?.() })
  await flush()
  expect(screen.getByLabelText('学科 / 专业')).toHaveProperty('value', '智慧养老护理')
  expect(records.get(draft().id)?.major).toBe('智慧养老护理')
  expect(vi.mocked(input.saveJdProject).mock.calls.map(([value]) => value.revision)).toEqual([0, 1])
})
test('a search finishing after a session switch saves only its original record', async () => {
  const a = draft('search-a')
  const b = draft('search-b')
  const { input, records } = fixture([a, b])
  let finish: ((value: []) => void) | undefined
  vi.mocked(input.runJdSearch).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const view = render(<JdSearchWorkbench {...input} />)
  await enterSearch()
  await waitFor(() => { expect(finish).toBeDefined() })
  view.rerender(<JdSearchWorkbench {...input} sessionId={b.session_id} />)
  await screen.findByLabelText('学科 / 专业')
  await act(async () => { finish?.([]) })
  await waitFor(() => { expect(records.get(a.id)?.workspace?.search_status).toBe('completed') })
  expect(screen.getByLabelText('学科 / 专业')).toHaveProperty('value', '')
  expect(records.get(b.id)?.workspace?.step).toBe(1)
  expect(screen.queryByRole('heading', { name: 'JD 原文与来源' })).toBeNull()
})
test('returning to an in-flight search shares its operation and displays the saved result', async () => {
  const a = draft('search-a')
  const b = draft('search-b')
  const { input, records } = fixture([a, b])
  let finish: ((value: []) => void) | undefined
  vi.mocked(input.runJdSearch).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const view = render(<JdSearchWorkbench {...input} />)
  await enterSearch()
  await waitFor(() => { expect(finish).toBeDefined() })
  view.rerender(<JdSearchWorkbench {...input} sessionId={b.session_id} />)
  await screen.findByLabelText('学科 / 专业')
  view.rerender(<JdSearchWorkbench {...input} sessionId={a.session_id} />)
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在检索…' }).disabled).toBe(true)
  })
  expect(screen.getByLabelText('区域范围')).toHaveProperty('disabled', true)
  await act(async () => { finish?.([]) })
  await screen.findByRole('heading', { name: 'JD 原文与来源' })
  await flush()
  expect(records.get(a.id)?.workspace?.search_status).toBe('completed')
  expect(records.get(b.id)?.workspace?.step).toBe(1)
})
test('browser collection deduplicates imported bodies and retains revised URLs as excluded evidence', async () => {
  const value = projectFixture()
  value.platforms = ['公开网页']
  value.workspace = { ...draft().workspace!, step: 2 }
  const { input, records } = fixture([value])
  const existing = value.sources[0]!
  input.pendingJdSources = () => [{ title: existing.title, url: existing.source_url, reason: '候选链接' },
    { title: existing.title, url: `${existing.source_url}?revision=2`, reason: '候选链接' }]
  vi.mocked(collectJdBrowser).mockResolvedValue({ items: [
    { state: 'captured', title: existing.title, body: existing.body, url: existing.source_url,
      captured_at: existing.captured_at, content_hash: existing.content_hash, cached: true },
    { state: 'captured', title: existing.title, body: `${existing.body}新增职责：质量管理。`, url: existing.source_url,
      captured_at: existing.captured_at, content_hash: 'new-hash' },
  ], platforms: [] })
  render(<JdSearchWorkbench {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: '开始检索' }))
  await screen.findByRole('heading', { name: 'JD 原文与来源' })
  await waitFor(() => { expect(records.get(value.id)?.sources.length).toBe(2) })
  await flush()
  expect(records.get(value.id)?.sources).toEqual([
    expect.objectContaining({ content_hash: existing.content_hash, excluded: true }),
    expect.objectContaining({ content_hash: 'new-hash', excluded: false, acquisition: 'browser' }),
  ])
})
test('discovery is saved before browser reads and cached evidence keeps its acquisition metadata', async () => {
  const value = draft()
  value.workspace = { ...value.workspace!, step: 2 }
  value.roles = ['护理员']
  const { input, records } = fixture([value])
  const url = 'https://jobs.example.test/job/cached'
  input.pendingJdSources = () => [{ title: '缓存岗位', url, reason: '候选链接' }]
  vi.mocked(collectJdBrowser).mockImplementation(async (id, sources) => {
    expect(id).toBe(value.id)
    expect(sources).toEqual([{ title: '缓存岗位', url, reason: '候选链接' }])
    expect(records.get(value.id)?.pending_sources).toEqual(input.pendingJdSources?.(value.session_id))
    return { items: [{ state: 'captured', title: '缓存岗位', url, body: '岗位职责：照护老人。任职要求：护理专业。',
      captured_at: '2026-01-01T00:00:00.000Z', content_hash: 'original-cache-hash', cached: true }], platforms: [] }
  })
  render(<JdSearchWorkbench {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: '开始检索' }))
  await screen.findByText('已复用浏览器采集缓存，保留原始采集时间与内容指纹。')
  expect(records.get(value.id)).toMatchObject({ pending_sources: [], sources: [expect.objectContaining({
    acquisition: 'browser', content_hash: 'original-cache-hash', captured_at: '2026-01-01T00:00:00.000Z',
  })] })
})
test('platform stops expose explicit verification and resume without an automatic login action', async () => {
  const value = draft()
  const url = 'https://jobs.example.test/job/1'
  value.workspace = { ...value.workspace!, step: 3 }
  value.pending_sources = [{ title: '验证岗位', url, reason: '验证页面' }]
  const { input, records } = fixture([value])
  vi.mocked(jdBrowserPlatforms).mockResolvedValue([{ platform: 'example.test', blocked: true,
    reason: '需要安全验证', cache_count: 0, login_required: false }])
  vi.mocked(resumeJdBrowser).mockResolvedValue({ item: { state: 'blocked', url, message: '验证尚未完成' },
    platforms: [{ platform: 'example.test', blocked: true, cache_count: 0, login_required: false }] })
  render(<JdSearchWorkbench {...input} />)
  const verify = await screen.findByRole('button', { name: '手动处理验证' })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '继续采集待处理岗位' }).disabled).toBe(true)
  fireEvent.click(verify)
  await waitFor(() => { expect(verifyJdBrowser).toHaveBeenCalledWith(value.id, url) })
  expect(openJdBrowser).not.toHaveBeenCalled()
  expect(collectJdBrowser).not.toHaveBeenCalled()
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '已完成验证，恢复采集' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: '已完成验证，恢复采集' }))
  await screen.findByText('尚未读取到完整 JD，平台仍暂停自动访问。')
  expect(records.get(value.id)?.sources).toEqual([])
  expect(records.get(value.id)?.pending_sources[0]?.reason).toContain('平台风控，已停止自动访问')
})
test('a stopped platform does not prevent another candidate from being saved', async () => {
  const value = draft()
  value.roles = ['护理员']
  value.workspace = { ...value.workspace!, step: 2 }
  const { input, records } = fixture([value])
  const stopped = 'https://blocked.example/job/1'
  const readable = 'https://readable.example/job/2'
  input.pendingJdSources = () => [{ title: '受限岗位', url: stopped, reason: '候选' }, { title: '可读岗位', url: readable, reason: '候选' }]
  vi.mocked(collectJdBrowser).mockResolvedValueOnce({ items: [
    { state: 'blocked', url: stopped, message: '风控' },
    { state: 'captured', title: '可读岗位', url: readable, body: '岗位职责：护理老人。任职要求：护理技能。',
      content_hash: 'readable-hash', captured_at: value.updated_at }],
  platforms: [{ platform: 'blocked.example', blocked: true, cache_count: 0, login_required: false }] })
  render(<JdSearchWorkbench {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: '开始检索' }))
  await waitFor(() => { expect(records.get(value.id)?.sources.length).toBe(1) })
  expect(records.get(value.id)?.pending_sources).toHaveLength(1)
  expect(records.get(value.id)?.pending_sources[0]?.url).toBe(stopped)
  expect(records.get(value.id)?.pending_sources[0]?.reason).toContain('平台风控')
  expect(records.get(value.id)?.sources[0]?.source_url).toBe(readable)
})
test('one user collection obeys the native batch limit and retains candidates beyond the request limit', async () => {
  const value = draft()
  value.roles = ['护理员']
  value.workspace = { ...value.workspace!, step: 2 }
  const { input, records } = fixture([value])
  const candidates = Array.from({ length: 101 }, (_, index) => ({
    title: `岗位 ${index}`, url: `https://example.test/candidate/${index}`, reason: '已发现候选链接',
  }))
  input.pendingJdSources = () => candidates
  vi.mocked(collectJdBrowser).mockImplementation(async (id, sources) => {
    expect(id).toBe(value.id)
    expect(sources).toHaveLength(100)
    expect(records.get(value.id)?.pending_sources).toEqual(candidates)
    return { items: sources.map((source, index) => index === 0
      ? { state: 'captured' as const, url: 'https://example.test/job/actual', title: '实际岗位',
        body: '岗位职责：照护老人。任职要求：护理专业。', captured_at: value.updated_at, content_hash: 'actual-job-hash' }
      : { state: 'failed' as const, url: source.url, message: '本批最多采集 1 条；该来源保留待采集，请分批继续。' }), platforms: [] }
  })
  render(<JdSearchWorkbench {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: '开始检索' }))
  await waitFor(() => {
    expect(records.get(value.id)?.pending_sources.find(item => item.url === candidates[99]?.url)?.reason).toContain('本批最多采集 1 条')
  })
  expect(collectJdBrowser).toHaveBeenCalledTimes(1)
  expect(records.get(value.id)?.sources).toEqual([expect.objectContaining({ source_url: 'https://example.test/job/actual',
    content_hash: 'actual-job-hash', acquisition: 'browser' })])
  expect(records.get(value.id)?.pending_sources).toHaveLength(100)
  expect(records.get(value.id)?.pending_sources.some(item => item.url === candidates[0]?.url)).toBe(false)
  expect(records.get(value.id)?.pending_sources.at(-1)).toEqual(candidates[100])
})
test('browser completion after a session switch updates only the owning search', async () => {
  const a = draft('browser-search-a')
  const b = draft('browser-search-b')
  a.roles = ['护理员']
  a.workspace = { ...a.workspace!, step: 2 }
  const { input, records } = fixture([a, b])
  const url = 'https://example.test/job/late'
  input.pendingJdSources = () => [{ title: '异步岗位', url, reason: '候选' }]
  let finish: ((value: Awaited<ReturnType<typeof collectJdBrowser>>) => void) | undefined
  vi.mocked(collectJdBrowser).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const view = render(<JdSearchWorkbench {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: '开始检索' }))
  await waitFor(() => { expect(finish).toBeDefined() })
  view.rerender(<JdSearchWorkbench {...input} sessionId={b.session_id} />)
  await screen.findByLabelText('学科 / 专业')
  await act(async () => { finish?.({ items: [{ state: 'captured', title: '异步岗位', url, body: '岗位职责：护理。任职要求：护理技能。',
    content_hash: 'late-hash', captured_at: a.updated_at }], platforms: [] }) })
  await waitFor(() => { expect(records.get(a.id)?.sources.length).toBe(1) })
  expect(records.get(b.id)?.sources).toEqual([])
  expect(screen.getByLabelText('学科 / 专业')).toHaveProperty('value', '')
})
test('a pending source opens a browser without assuming login and continuation checks live status', async () => {
  const value = draft()
  value.workspace = { ...value.workspace!, step: 3 }
  value.pending_sources = [{ title: '照护员', url: 'https://jobs.example.test/job/1', reason: '平台要求安全验证' }]
  const { input, records } = fixture([value])
  render(<JdSearchWorkbench {...input} />)
  await screen.findByText('平台要求安全验证')
  expect(screen.queryByRole('button', { name: '继续浏览器采集' })).toBeNull()
  expect(screen.queryByRole('button', { name: '选为登录采集来源' })).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: '浏览器读取此岗位' })[0]!)
  await waitFor(() => { expect(openJdBrowser).toHaveBeenCalledWith(value.id, value.pending_sources[0]!.url) })
  expect(await screen.findByRole('button', { name: '继续浏览器采集' })).toBeTruthy()
  expect(records.get(value.id)?.workspace?.capture).toMatchObject({ title: '照护员', url: value.pending_sources[0]!.url })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '继续浏览器采集' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: '继续浏览器采集' }))
  expect(await screen.findByText('采集窗口已关闭，请先重新打开岗位浏览器')).toBeTruthy()
  expect(readJdBrowser).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '继续浏览器采集' })).toBeNull()
})
test('restored capture windows save the actual displayed job title and URL after user navigation', async () => {
  const value = draft()
  value.workspace = { ...value.workspace!, step: 3, capture: { ...value.workspace!.capture,
    url: 'https://jobs.example.test/job/old', title: '旧岗位名称' } }
  const { input, records } = fixture([value])
  vi.mocked(jdBrowserStatus).mockResolvedValue(true)
  vi.mocked(readJdBrowser).mockResolvedValue({ state: 'captured', title: '实际打开的新岗位',
    url: 'https://jobs.example.test/job/new', body: '岗位职责：护理老人。任职要求：护理专业。',
    content_hash: 'captured-new-hash', captured_at: value.updated_at })
  render(<JdSearchWorkbench {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: '继续浏览器采集' }))
  await screen.findByText('JD 原文和来源已保存。')
  expect(records.get(value.id)?.sources).toEqual([expect.objectContaining({
    title: '实际打开的新岗位', source_url: 'https://jobs.example.test/job/new', acquisition: 'browser',
  })])
})
test('a restored partial original blocks new model analysis until it is excluded', async () => {
  const value = projectFixture()
  value.sources[0]!.body += '\n任职要求：大专或以上学历，计算机\n登录查看完整内容'
  value.workspace = { ...draft().workspace!, step: 3 }
  const { input, records } = fixture([value])
  render(<JdSearchWorkbench {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: '使用 1 份原文生成五级图谱' }))
  await screen.findByText(/以下 JD 存在完整内容登录限制/)
  expect(input.generateJdGraph).not.toHaveBeenCalled()
  expect(records.get(value.id)?.sources[0]?.body).toBe(value.sources[0]!.body)
  expect(records.get(value.id)?.graphs).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: '剔除原文' }))
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '使用 0 份原文生成五级图谱' }).disabled).toBe(true) })
})
test('confirmation is durable and HTML export is available only for the selected confirmed version', async () => {
  const value = projectFixture()
  value.graphs = [1, 2].map(version => ({ version, generated_at: value.updated_at,
    nodes: graphFixture(), source_hashes: { 'JD-1': value.sources[0]!.content_hash } }))
  value.workspace = { ...draft().workspace!, step: 4, graph_version: 1 }
  const { input, records } = fixture([value])
  vi.mocked(exportJdHtml).mockResolvedValue({ path: 'C:/Reports/graph.html', opened: 'folder' })
  render(<JdSearchWorkbench {...input} />)
  await screen.findByRole('heading', { name: '五级岗位能力图谱' })
  expect(screen.queryByRole('button', { name: /下载 AI 版 MD|导出阅读版 PDF|导出 HTML/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /导出成果/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '确认能力图谱' }))
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '导出 HTML' }).disabled).toBe(false) })
  expect(records.get(value.id)?.confirmations).toEqual([expect.objectContaining({ version: 1 })])
  fireEvent.click(screen.getByRole('button', { name: '导出 HTML' }))
  await screen.findByText(/浏览器未能打开，已显示文件所在目录/)
  expect(exportJdHtml).toHaveBeenCalledWith('计算机应用技术-岗位能力图谱-v1.html', '<!doctype html><html>confirmed report</html>')
  await waitFor(() => { expect(screen.getByLabelText<HTMLSelectElement>('图谱版本').disabled).toBe(false) })
  fireEvent.change(screen.getByLabelText('图谱版本'), { target: { value: '2' } })
  await screen.findByRole('button', { name: '确认能力图谱' })
  expect(screen.queryByRole('button', { name: '导出 HTML' })).toBeNull()
  await flush()
  expect(records.get(value.id)?.workspace?.graph_version).toBe(2)
})
test('the sidebar filters persisted records and awaits workbench edits before switching', async () => {
  const a = draft('search-a')
  const b = { ...draft('search-b'), title: '智慧养老岗位研究' }
  const { input, records } = fixture([a, b])
  const listeners = new Set<() => void>()
  let selected = String(a.session_id)
  const subscribeJdSession = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  render(<><JdSearchWorkbench {...input} /><JdSearchSidebar {...input} wide={true}
    expandSidebar={() => undefined} sidebarMode="sessions" setSidebarMode={() => undefined}
    subscribeJdSession={subscribeJdSession} getCurrentJdSession={() => selected} /></>)
  await screen.findByLabelText('学科 / 专业')
  await screen.findByRole('button', { name: /智慧养老岗位研究/ })
  fireEvent.change(screen.getByLabelText('学科 / 专业'), { target: { value: '计算机' } })
  fireEvent.change(screen.getByLabelText('搜索记录'), { target: { value: '智慧养老' } })
  expect(screen.queryByRole('button', { name: /未命名岗位研究/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /智慧养老岗位研究/ }))
  await waitFor(() => { expect(input.openJdProject).toHaveBeenCalledWith(b.session_id) })
  expect(records.get(a.id)?.major).toBe('计算机')
  act(() => {
    selected = b.session_id
    for (const listener of listeners) listener()
  })
  expect(screen.getByRole('button', { name: /智慧养老岗位研究/ }).getAttribute('aria-current')).toBe('page')
})
