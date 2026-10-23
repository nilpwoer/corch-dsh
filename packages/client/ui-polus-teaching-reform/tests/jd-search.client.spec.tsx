// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { JdSearchSidebar, JdSearchWorkbench } from '../src/client/JdSearchWorkbench.tsx'
import type { TeachingReformProps } from '../src/client/types.ts'
import type { JdProject, JdProjectSummary } from '../src/jd/types.ts'
import { projectId } from '../src/jd/document.ts'
import { graphFixture, projectFixture } from './jd-fixture.client.ts'
import { exportJdHtml, jdBrowserStatus, openJdBrowser, readJdBrowser } from '../src/client/jdNative.ts'

vi.mock('../src/client/jdNative.ts', () => ({
  jdBrowserStatus: vi.fn(), openJdBrowser: vi.fn(), readJdBrowser: vi.fn(), exportJdHtml: vi.fn(),
  jdHash: vi.fn().mockResolvedValue('synthetic-hash'),
}))
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(jdBrowserStatus).mockResolvedValue(false)
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
test('search collection deduplicates imported bodies and retains revised URLs as excluded evidence', async () => {
  const value = projectFixture()
  value.platforms = ['公开网页']
  value.workspace = { ...draft().workspace!, step: 2 }
  const { input, records } = fixture([value])
  const existing = value.sources[0]!
  const { jdHash } = await import('../src/client/jdNative.ts')
  vi.mocked(jdHash).mockResolvedValueOnce(existing.content_hash).mockResolvedValueOnce('new-hash')
  vi.mocked(input.runJdSearch).mockResolvedValue([
    { id: 'same', title: existing.title, company: existing.company, place: existing.place, platform: existing.platform,
      score: 100, summary: '合成重复原文',
      body: existing.body, sourceUrl: existing.source_url, capturedAt: existing.captured_at },
    { id: 'revised', title: existing.title, company: existing.company, place: existing.place, platform: existing.platform,
      score: 100, summary: '合成修订原文',
      body: `${existing.body}新增职责：质量管理。`, sourceUrl: existing.source_url, capturedAt: existing.captured_at },
  ])
  render(<JdSearchWorkbench {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: '开始检索' }))
  await screen.findByRole('heading', { name: 'JD 原文与来源' })
  await flush()
  expect(records.get(value.id)?.sources).toEqual([
    expect.objectContaining({ content_hash: existing.content_hash, excluded: true }),
    expect.objectContaining({ content_hash: 'new-hash', excluded: false }),
  ])
})
test('a pending source opens its login window immediately and continuation checks live status', async () => {
  const value = draft()
  value.workspace = { ...value.workspace!, step: 3 }
  value.pending_sources = [{ title: '照护员', url: 'https://jobs.example.test/job/1', reason: '平台要求安全验证' }]
  const { input, records } = fixture([value])
  render(<JdSearchWorkbench {...input} />)
  await screen.findByText('平台要求安全验证')
  expect(screen.queryByRole('button', { name: '登录后继续采集' })).toBeNull()
  expect(screen.queryByRole('button', { name: '选为登录采集来源' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '打开此岗位并登录' }))
  await waitFor(() => { expect(openJdBrowser).toHaveBeenCalledWith(value.id, value.pending_sources[0]!.url) })
  expect(await screen.findByRole('button', { name: '登录后继续采集' })).toBeTruthy()
  expect(records.get(value.id)?.workspace?.capture).toMatchObject({ title: '照护员', url: value.pending_sources[0]!.url })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '登录后继续采集' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: '登录后继续采集' }))
  expect(await screen.findByText('采集窗口已关闭，请先重新打开岗位并登录')).toBeTruthy()
  expect(readJdBrowser).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '登录后继续采集' })).toBeNull()
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
  fireEvent.click(await screen.findByRole('button', { name: '登录后继续采集' }))
  await screen.findByText('JD 原文和来源已保存。')
  expect(records.get(value.id)?.sources).toEqual([expect.objectContaining({
    title: '实际打开的新岗位', source_url: 'https://jobs.example.test/job/new', acquisition: 'browser',
  })])
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
