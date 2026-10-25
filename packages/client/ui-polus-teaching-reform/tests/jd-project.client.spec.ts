import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  graphHTML,
  analysisSources,
  graphMarkdown,
  graphNodes,
  parseProject,
  sourceUrl,
} from '../src/jd/document.ts'
import { JdProjectStore } from '../src/jd/store.ts'
import { graphFixture, projectFixture } from './jd-fixture.client.ts'
import { buildJdGraphPrompt } from '../src/client/jdSearchPrompt.ts'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function store(): Promise<{
  repository: JdProjectStore
  directory: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-jd-test-'))
  directories.push(directory)
  return { repository: new JdProjectStore(directory, 1000000), directory }
}

test('the saved corpus and immutable graph version survive a fresh repository instance', async () => {
  const { repository, directory } = await store()
  const project = await repository.save(projectFixture())
  const graph = {
    version: 1,
    generated_at: project.updated_at,
    source_hashes: { 'JD-1': project.sources[0]!.content_hash },
    nodes: graphFixture(),
  }
  const saved = await repository.save({ ...project, graphs: [graph] })
  const restored = await new JdProjectStore(directory, 1000000).read(saved.id)
  expect(restored).toEqual(saved)
  expect(await repository.list()).toEqual([
    {
      id: saved.id,
      session_id: saved.session_id,
      revision: 2,
      title: saved.title,
      updated_at: saved.updated_at,
    },
  ])
  const md = graphMarkdown(saved, graph)
  expect(md).toContain('推断，待专家核实')
  expect(md).toContain('1/1（100% 引文覆盖，非总体需求占比）')
  expect(md).toContain(saved.sources[0]!.content_hash)
  expect(md).toContain(saved.sources[0]!.body)
  const html = graphHTML(
    { ...saved, title: '<script>alert(1)</script>' },
    graph,
  )
  expect(html).not.toContain('<script>')
  expect(html).toContain('default-src')
})

test('a real quote from a partial login-walled original cannot establish a new graph or model corpus', () => {
  for (const marker of ['登录查看完整内容', '登录后查看完整职位', '登录查看完整信息', '登录\n查看完整\n内容', '完整职位需登录']) {
    const value = projectFixture()
    value.sources[0]!.body += `\n任职要求：大专或以上学历，计算机\n${marker}`
    expect(() => graphNodes({ nodes: graphFixture() }, value.sources)).toThrow('完整内容登录限制')
    expect(() => buildJdGraphPrompt(value)).toThrow('完整内容登录限制')
    expect(analysisSources(value.sources.map(source => ({ ...source, excluded: true })))).toEqual([])
  }
  const ordinary = projectFixture()
  ordinary.sources[0]!.body += '\n工作职责还包括开发用户登录功能和登录信息管理。'
  expect(analysisSources(ordinary.sources)).toEqual(ordinary.sources)
})

test('historical partial originals and graphs stay readable and immutable while new versions require complete evidence', async () => {
  const { repository, directory } = await store()
  const historical = projectFixture()
  historical.sources[0]!.body += '\n任职要求：大专或以上学历，计算机\n登录查看完整内容'
  historical.sources[0]!.content_hash = createHash('sha256').update(historical.sources[0]!.body).digest('hex')
  historical.graphs = [{ version: 1, generated_at: historical.updated_at,
    source_hashes: { 'JD-1': historical.sources[0]!.content_hash }, nodes: graphFixture() }]
  const originalBytes = JSON.stringify(historical, null, 2) + '\n'
  await writeFile(join(directory, `${historical.id}.json`), originalBytes)
  expect(await repository.read(historical.id)).toEqual(historical)
  expect(await readFile(join(directory, `${historical.id}.json`), 'utf8')).toBe(originalBytes)
  const historicalHtml = graphHTML(historical, historical.graphs[0]!)
  expect(historicalHtml).toContain(historical.sources[0]!.content_hash)
  expect(historicalHtml).toContain(historical.graphs[0]!.nodes[0]!.evidence[0]!.quote)
  const saved = await repository.save({ ...historical, direction: '仅修改搜索草稿' })
  expect(saved.graphs).toEqual(historical.graphs)
  expect(saved.sources).toEqual(historical.sources)
  const invalid = { ...saved.graphs[0]!, version: 2 }
  await expect(repository.save({ ...saved, graphs: [...saved.graphs, invalid] })).rejects.toThrow('完整内容登录限制')
  expect((await repository.read(saved.id))?.graphs).toEqual(historical.graphs)
  const complete = { ...projectFixture().sources[0]!, id: 'JD-2', source_url: 'https://jobs.example.test/detail/2' }
  const replacement = { ...saved, sources: [{ ...saved.sources[0]!, excluded: true }, complete] }
  const nodes = graphFixture().map(node => ({ ...node, evidence: node.evidence.map(entry => ({ ...entry, jd_id: 'JD-2' })) }))
  const next = await repository.save({ ...replacement, graphs: [...saved.graphs, {
    version: 2, generated_at: saved.updated_at, source_hashes: { 'JD-2': complete.content_hash }, nodes,
  }] })
  expect(next.graphs[0]).toEqual(historical.graphs[0])
  expect(next.sources[0]).toEqual({ ...historical.sources[0], excluded: true })
  expect(next.graphs).toHaveLength(2)
})

test('invented quotes, excluded sources, skipped levels and unsupported direct statements reject a graph', () => {
  const sources = projectFixture().sources
  const nodes = graphFixture()
  expect(graphNodes({ nodes }, sources)).toEqual(nodes)
  expect(() =>
    graphNodes(
      {
        nodes: nodes.map(node => ({
          ...node,
          evidence: [{ jd_id: 'JD-1', quote: '不存在的要求' }],
        })),
      },
      sources,
    ),
  ).toThrow('引文')
  expect(() =>
    graphNodes(
      { nodes },
      sources.map(source => ({ ...source, excluded: true })),
    ),
  ).toThrow('引文')
  expect(() => graphNodes({ nodes: nodes.slice(0, 4) }, sources)).toThrow(
    '不完整',
  )
  expect(() =>
    graphNodes(
      {
        nodes: nodes.map(node =>
          node.id === 'N3' ? { ...node, parent_id: 'N1' } : node,
        ),
      },
      sources,
    ),
  ).toThrow()
  expect(() =>
    graphNodes(
      {
        nodes: nodes.map(node =>
          node.id === 'N1' ? { ...node, basis: 'direct' } : node,
        ),
      },
      sources,
    ),
  ).toThrow('推断')
  expect(() => graphNodes({ nodes: [...nodes, nodes[0]] }, sources)).toThrow(
    '重复',
  )
})

test('dotted graph hierarchy identifiers remain separate from file-safe project identities', () => {
  const nodes = graphFixture().map(node => ({
    ...node,
    id: node.id.replace('N', 'N.'),
    parent_id: node.parent_id?.replace('N', 'N.') ?? null,
  }))
  expect(graphNodes({ nodes }, projectFixture().sources)).toEqual(nodes)
  expect(() => parseProject({ ...projectFixture(), id: '../project' })).toThrow('编号')
})

test('the reading report preserves complete originals as escaped text behind readable source links', () => {
  const project = projectFixture()
  const first = project.sources[0]!
  first.body += '\n![导航图片](data:image/png;base64,unrelated-page-payload)'
  first.content_hash = createHash('sha256').update(first.body).digest('hex')
  const graph = {
    version: 1, generated_at: project.updated_at,
    source_hashes: { [first.id]: first.content_hash }, nodes: graphFixture(),
  }
  const html = graphHTML(project, graph)
  expect(html).toContain('来源与逐字证据摘录')
  expect(html).toContain(first.content_hash)
  expect(html).toContain(graph.nodes[0]!.evidence[0]!.quote)
  expect(html).toContain('unrelated-page-payload')
  expect(html).not.toContain('<img')
  expect(html).toContain('href="#source-1-original">来源1 · 合成后端开发</a>')
  expect(graphMarkdown(project, graph)).toContain('unrelated-page-payload')
})

test('report source numbering follows the frozen corpus and distinguishes identical job names', () => {
  const project = projectFixture()
  const first = project.sources[0]!
  first.title = '同名 <岗位>'
  const second = { ...first, id: 'JD-second-private-id', title: '同名 <岗位>', body: '岗位职责：交付第二份岗位工作。', excluded: true,
    content_hash: createHash('sha256').update('岗位职责：交付第二份岗位工作。').digest('hex') }
  project.sources.push(second, { ...first, id: 'JD-newer-private-id', title: '未纳入本版的新岗位' })
  const nodes = graphFixture()
  nodes[0]!.evidence.push({ jd_id: second.id, quote: second.body })
  const graph = { version: 1, generated_at: project.updated_at, nodes,
    source_hashes: { [first.id]: first.content_hash, [second.id]: second.content_hash } }
  const before = structuredClone({ project, graph })
  const html = graphHTML(project, graph)
  expect(html).toContain('href="#source-1-original">来源1 · 同名 &lt;岗位&gt;</a>')
  expect(html).toContain('href="#source-2-original">来源2 · 同名 &lt;岗位&gt;</a>')
  expect(html).toContain('id="source-2-original">' + second.body)
  expect(html).not.toContain('未纳入本版的新岗位')
  expect(html).not.toContain('source-3')
  expect(html).not.toContain(second.id)
  expect({ project, graph }).toEqual(before)
})

test('concurrent writers cannot overwrite projects or change captured originals', async () => {
  const { repository } = await store()
  const initial = await repository.save(projectFixture())
  await expect(repository.save(projectFixture())).rejects.toThrow('其他窗口')
  await expect(repository.save({ ...initial, sources: [] })).rejects.toThrow(
    '不能覆盖',
  )
  await expect(
    repository.save({
      ...initial,
      sources: initial.sources.map(source => ({
        ...source,
        body: '改写原文',
      })),
    }),
  ).rejects.toThrow('不能覆盖')
  const outcomes = await Promise.allSettled([
    repository.save({ ...initial, title: '窗口一' }),
    repository.save({ ...initial, title: '窗口二' }),
  ])
  expect(
    outcomes.filter(outcome => outcome.status === 'fulfilled'),
  ).toHaveLength(1)
  expect(
    outcomes.filter(outcome => outcome.status === 'rejected'),
  ).toHaveLength(1)
})

test('disk corruption, unknown formats, oversized records and path traversal fail explicitly', async () => {
  const { repository, directory } = await store()
  const saved = await repository.save(projectFixture())
  const path = join(directory, saved.id + '.json')
  const corrupt = JSON.parse(await readFile(path, 'utf8')) as {
    sources: { body: string }[]
  }
  const first = corrupt.sources[0]
  if (!first) throw new Error('Missing saved test source')
  first.body += '篡改'
  await writeFile(path, JSON.stringify(corrupt))
  await expect(repository.read(saved.id)).rejects.toThrow('哈希')
  await expect(repository.read('../escape')).rejects.toThrow('编号')
  expect(() =>
    parseProject({ ...projectFixture(), format_version: 0 }),
  ).toThrow('格式')
  await expect(
    new JdProjectStore(directory, 50).save(projectFixture()),
  ).rejects.toThrow()
})

test('excluding a JD changes the next corpus without invalidating or overwriting saved graph evidence', async () => {
  const { repository } = await store()
  const project = projectFixture()
  const graph = {
    version: 1,
    generated_at: project.updated_at,
    source_hashes: { 'JD-1': project.sources[0]!.content_hash },
    nodes: graphFixture(),
  }
  await expect(repository.save({
    ...project,
    sources: project.sources.map(source => ({ ...source, excluded: true })),
    graphs: [graph],
  })).rejects.toThrow('已剔除')
  const saved = await repository.save({ ...project, graphs: [graph] })
  const excluded = await repository.save({
    ...saved,
    sources: saved.sources.map(source => ({ ...source, excluded: true })),
  })
  expect(graphMarkdown(excluded, graph)).toContain(project.sources[0]!.body)
  await expect(repository.save({
    ...excluded,
    graphs: [graph, { ...graph, version: 2 }],
  })).rejects.toThrow('已剔除')
  expect((await repository.read(project.id))?.graphs).toEqual([graph])
  await expect(repository.save({ ...excluded, graphs: [] })).rejects.toThrow(
    '不能覆盖',
  )
  const restored = await repository.save({
    ...excluded,
    sources: excluded.sources.map(source => ({ ...source, excluded: false })),
    graphs: [graph, { ...graph, version: 2 }],
  })
  expect(restored.graphs).toHaveLength(2)
})

test('repeated content and two active revisions of the same URL cannot inflate sample coverage', async () => {
  const { repository } = await store()
  const saved = await repository.save(projectFixture())
  const source = saved.sources[0]!
  expect(() =>
    parseProject({
      ...saved,
      sources: [source, { ...source, id: 'JD-duplicate' }],
    }),
  ).toThrow('重复计入')
  const body = source.body + '\n新增岗位职责：维护接口文档。'
  const newer = {
    ...source,
    id: 'JD-new',
    body,
    content_hash: createHash('sha256').update(body).digest('hex'),
  }
  expect(() => parseProject({ ...saved, sources: [source, newer] })).toThrow(
    '一个原文版本',
  )
  const next = await repository.save({
    ...saved,
    sources: [{ ...source, excluded: true }, newer],
  })
  expect(next.sources.filter(item => !item.excluded)).toHaveLength(1)
  expect(sourceUrl('https://jobs.example.test/detail/1#requirements')).toBe(
    source.source_url,
  )
  expect(() =>
    sourceUrl('https://jobs.example.test/detail?access_token=private'),
  ).toThrow('登录凭据')
})

test('draft filters and the complete per-search workspace survive reopening without changing legacy documents', async () => {
  const { repository, directory } = await store()
  const old = projectFixture()
  expect(parseProject(old)).toEqual(old)
  const workspace = {
    step: 2, graph_version: null, search_status: 'failed', error: '站点限制访问',
    role_text: '后端开发、',
    capture: { url: 'https://jobs.example.test/detail/2', title: '待补充岗位', company: '', body: '未完成原文', file_name: '原文.txt' },
  }
  const saved = await repository.save({ ...old, major: '', roles: [], workspace })
  expect(await new JdProjectStore(directory, 1000000).read(saved.id)).toEqual(saved)
  expect(saved.workspace).toEqual(workspace)
  for (const invalid of [
    { ...workspace, step: '2' }, { ...workspace, step: 5 },
    { ...workspace, graph_version: 7 }, { ...workspace, search_status: 'finished' },
    { ...workspace, capture: { ...workspace.capture, body: 123 } },
    { ...workspace, role_text: [] },
  ]) expect(() => parseProject({ ...old, workspace: invalid })).toThrow()
})

test('concurrent searches cannot share a session or overwrite each other’s archive', async () => {
  const { repository } = await store()
  const initial = projectFixture()
  const outcomes = await Promise.allSettled([
    repository.save(initial),
    repository.save({ ...initial, id: 'second-search' }),
  ])
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
  const rejection = outcomes.find(outcome => outcome.status === 'rejected')
  expect(rejection?.status === 'rejected' ? String(rejection.reason) : '').toContain('独立会话')
  const separate = await repository.save({ ...initial, id: 'third-search', session_id: 'different-session' })
  expect(separate.session_id).toBe('different-session')
  expect(await repository.list()).toHaveLength(2)
})

test('only host confirmation appends approval and confirmed evidence remains immutable across later edits', async () => {
  const { repository, directory } = await store()
  const initial = projectFixture()
  const source = initial.sources[0]!
  const graph = {
    version: 1, generated_at: initial.updated_at,
    source_hashes: { [source.id]: source.content_hash }, nodes: graphFixture(),
  }
  await expect(repository.save({ ...initial, graphs: [graph], confirmations: [{ version: 1, confirmed_at: initial.updated_at }] })).rejects.toThrow('确认记录只能')
  const saved = await repository.save({ ...initial, graphs: [graph] })
  await expect(repository.confirm(saved.id, 1, 0)).rejects.toThrow('其他窗口')
  await expect(repository.confirm(saved.id, 2, saved.revision)).rejects.toThrow('先保存')
  const before = Date.now()
  const confirmed = await repository.confirm(saved.id, 1, saved.revision)
  expect(confirmed.revision).toBe(saved.revision + 1)
  const approval = confirmed.confirmations?.[0]
  expect(approval?.version).toBe(1)
  expect(Date.parse(approval?.confirmed_at ?? '')).toBeGreaterThanOrEqual(before)
  expect(await repository.confirm(saved.id, 1, saved.revision)).toEqual(confirmed)
  expect(await new JdProjectStore(directory, 1000000).confirmed()).toEqual([{
    project_id: saved.id, session_id: saved.session_id, title: saved.title,
    version: 1, confirmed_at: approval?.confirmed_at, updated_at: confirmed.updated_at,
  }])
  await expect(repository.save({ ...confirmed, confirmations: [] })).rejects.toThrow('确认记录只能')
  await expect(repository.save({ ...confirmed, graphs: [{ ...graph, nodes: graph.nodes.map(node => ({ ...node, assessment: '篡改确认结果' })) }] })).rejects.toThrow('不能覆盖')
  const excluded = await repository.save({ ...confirmed, sources: confirmed.sources.map(source => ({ ...source, excluded: true })) })
  expect(excluded.confirmations).toEqual(confirmed.confirmations)
  expect(excluded.graphs).toEqual([graph])
  const html = graphHTML(confirmed, graph)
  for (const expected of ['已确认', '报告目录', '五级能力图谱树', '能力节点与证据主表', '来源与逐字证据摘录', source.content_hash, '推断，待专家核实', '评价建议 · 推断', '不作课程缺口'])
    expect(html).toContain(expected)
  for (const [index, node] of graph.nodes.entries()) {
    expect(html).toContain(`id="node-${index + 1}"`)
    expect(html).not.toContain(node.id)
    for (const evidence of node.evidence) expect(html).toContain(evidence.quote)
  }
  expect(html).toContain('id="source-1"')
  for (const internal of [source.id, confirmed.id, confirmed.session_id, '父级：', '完整原文 SHA-256']) expect(html).not.toContain(internal)
  expect(() => graphHTML({ ...confirmed, sources: [] }, graph)).toThrow('不在本版样本中')
  const injected = graphHTML({ ...confirmed, title: '</title><script>alert(1)</script>', roles: ['<iframe src="https://evil.test">'] }, graph)
  expect(injected).not.toContain('<script>')
  expect(injected).not.toContain('<iframe')
  expect(injected).toContain('&lt;script&gt;')
})
