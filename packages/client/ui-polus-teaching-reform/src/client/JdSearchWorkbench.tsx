import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeachingReformProps } from './types.ts'
import css from './JdSearchWorkbench.module.css'
import type { JdGraph, JdProject, JdProjectSummary, JdSource, JdWorkspace } from '../jd/types.ts'
import { frequency, graphNodes, sourceUrl } from '../jd/document.ts'
import { exportJdHtml, jdBrowserStatus, jdHash, openJdBrowser, readJdBrowser } from './jdNative.ts'

const STEPS = ['搜索目标', '平台与范围', 'JD 原文', '能力图谱']
const PLATFORMS = ['公开网页', '58 同城', 'BOSS 直聘', '智联招聘', '前程无忧 51job', '鱼泡直聘', '四川高校人才网']
type FlushRequest = { waits: Promise<void>[] }
type Ref<T> = { current: T }
type ResearchController = {
  current: Ref<JdProject | null>
  revision: Ref<number>
  edits: Ref<number>
  persisted: Ref<number>
  serial: Ref<Promise<void>>
  timer: Ref<ReturnType<typeof setTimeout> | undefined>
  running: Ref<boolean>
  saving: Ref<boolean>
  saveError: Ref<boolean>
  browserOpen: Ref<boolean>
  listeners: Set<() => void>
  restoring?: Promise<void>
}
const controllers = new WeakMap<TeachingReformProps['saveJdProject'], Map<string, ResearchController>>()
function controllerFor(props: TeachingReformProps): ResearchController {
  let sessions = controllers.get(props.saveJdProject)
  if (!sessions) {
    sessions = new Map()
    controllers.set(props.saveJdProject, sessions)
  }
  let controller = sessions.get(props.sessionId)
  if (!controller) {
    controller = {
      current: { current: null }, revision: { current: 0 }, edits: { current: 0 }, persisted: { current: 0 },
      serial: { current: Promise.resolve() }, timer: { current: undefined }, running: { current: false },
      saving: { current: false }, saveError: { current: false }, browserOpen: { current: false }, listeners: new Set(),
    }
    sessions.set(props.sessionId, controller)
  }
  return controller
}

async function flushWorkbench(): Promise<void> {
  const detail: FlushRequest = { waits: [] }
  window.dispatchEvent(new CustomEvent('jd-project-flush', { detail }))
  await Promise.all(detail.waits)
}

/** Show durable records and save edits before switching their owning sessions.
 * @param props - Sidebar width, current session, and Host project operations.
 * @returns The searchable research sidebar.
 */
export function JdSearchSidebar({
  wide, createJdSearchSession, listJdProjects, openJdProject, subscribeJdSession, getCurrentJdSession,
}: PropsRuntime<'sidebar.workspaces'> & Pick<TeachingReformProps,
  'createJdSearchSession' | 'listJdProjects' | 'openJdProject'> & {
    subscribeJdSession: (listener: () => void) => () => void
    getCurrentJdSession: () => string
  }): ReactNode {
  const currentSessionId = useSyncExternalStore(subscribeJdSession, getCurrentJdSession)
  const [history, setHistory] = useState<JdProjectSummary[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = (): void => {
      void listJdProjects().then((items) => {
        if (active) setHistory(items)
      }).catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '搜索记录读取失败')
      })
    }
    refresh()
    window.addEventListener('jd-projects-changed', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.removeEventListener('jd-projects-changed', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [listJdProjects, currentSessionId])
  const switchRecord = (action: () => Promise<void> | void): void => {
    setPending(true)
    setError('')
    void flushWorkbench().then(action).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : '搜索记录切换失败')
    }).finally(() => { setPending(false) })
  }
  return <aside className={css.sidebar}>
    {wide ? <>
      <div className={css.sidebarTitle}>JD 搜索</div>
      <button className={css.newButton} type="button" disabled={pending}
        onClick={() => { switchRecord(() => createJdSearchSession()) }}>＋ 新建搜索</button>
      <label className={css.historySearch}>搜索记录
        <input className={css.input} aria-label="搜索记录" value={query}
          onChange={(event) => { setQuery(event.target.value) }} placeholder="按专业或岗位检索" />
      </label>
      {error && <p role="alert" className={css.loginNotice}>{error}</p>}
      <div className={css.historyList}>
        {history.filter(item => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item =>
          <button className={String(item.session_id) === currentSessionId ? css.historyActive : css.history}
            key={item.id} type="button" disabled={pending}
            data-jd-project-id={item.id} data-jd-session-id={item.session_id}
            aria-current={String(item.session_id) === currentSessionId ? 'page' : undefined}
            onClick={() => { switchRecord(() => { openJdProject(item.session_id) }) }}>
            <strong>{item.title}</strong><small>{new Date(item.updated_at).toLocaleString()}</small><small>修订 {item.revision}</small>
          </button>)}
      </div>
      {history.length === 0 && <div className={css.emptyHistory}>新建搜索后自动存档，每次搜索使用独立会话。</div>}
    </> : <div className={css.sidebarMini}>JD<br />搜<br />索</div>}
  </aside>
}

function workspace(project: JdProject): JdWorkspace {
  return project.workspace ?? {
    step: project.graphs.length ? 4 : project.sources.length || project.pending_sources.length ? 3 : 2,
    graph_version: project.graphs.at(-1)?.version ?? null,
    capture: { url: '', title: '', company: '未披露', body: '', file_name: '' },
    search_status: project.sources.length || project.pending_sources.length || project.graphs.length ? 'completed' : 'draft',
    error: '',
  }
}
function Header({ step, title, text }: { step: number; title: string; text: string }): ReactNode {
  return <div className={css.sectionIntro}><span className={css.eyebrow}>STEP 0{step}</span><h2>{title}</h2><p>{text}</p></div>
}

/** Restore a separate workbench instance for each owning Host search session.
 * @param props - Session identity and durable research operations.
 * @returns The JD research workflow.
 */
export function JdSearchWorkbench(props: TeachingReformProps): ReactNode {
  return <ResearchSession key={props.sessionId} {...props} />
}
function ResearchSession(props: TeachingReformProps): ReactNode {
  const [controller] = useState(() => controllerFor(props))
  const { current, revision, edits, persisted, serial, timer, running } = controller
  const [project, setProject] = useState<JdProject | null>(current.current)
  const [loading, setLoading] = useState(!current.current)
  const [busy, setBusy] = useState(running.current)
  const [saving, setSaving] = useState(controller.saving.current)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saveError, setSaveError] = useState(controller.saveError.current)
  const [browserOpen, setBrowserOpen] = useState(controller.browserOpen.current)
  const mounted = useRef(true)
  const notify = (): void => { for (const listener of controller.listeners) listener() }
  const publish = (value: JdProject): void => {
    current.current = value
    notify()
  }
  // The controller survives view switches, so a returning view shares pending searches and their save revisions.
  const flush = (): Promise<void> => {
    clearTimeout(timer.current)
    const task = serial.current.then(async () => {
      while (current.current && persisted.current < edits.current) {
        const generation = edits.current
        const snapshot = { ...current.current, revision: revision.current }
        controller.saving.current = true
        notify()
        try {
          const saved = await props.saveJdProject(snapshot)
          revision.current = saved.revision
          persisted.current = generation
          controller.saveError.current = false
          publish(edits.current === generation ? saved : { ...current.current, revision: saved.revision })
          window.dispatchEvent(new Event('jd-projects-changed'))
        } catch (reason) {
          controller.saveError.current = true
          notify()
          throw reason
        } finally {
          controller.saving.current = false
          notify()
        }
      }
    })
    serial.current = task.catch(() => undefined)
    return task
  }
  const report = (reason: unknown): void => {
    if (mounted.current) setError(reason instanceof Error ? reason.message : '操作失败')
  }
  const change = (update: (value: JdProject) => JdProject): void => {
    if (!current.current) return
    publish(update(current.current))
    edits.current += 1
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush().catch(report) }, 300)
  }
  const changeWorkspace = (patch: Partial<JdWorkspace>): void => {
    change(value => ({ ...value, workspace: { ...workspace(value), ...patch } }))
  }
  const captureChange = (patch: Partial<JdWorkspace['capture']>): void => {
    change(value => ({ ...value, workspace: { ...workspace(value), capture: { ...workspace(value).capture, ...patch } } }))
  }
  const requireProject = (): JdProject => {
    if (!current.current) throw new Error('搜索档案尚未建立，请稍后重试')
    return current.current
  }
  const run = (operation: () => Promise<void>): void => {
    if (running.current) return
    running.current = true
    notify()
    setError('')
    setNotice('')
    void operation().catch(async (reason: unknown) => {
      report(reason)
      changeWorkspace({ error: reason instanceof Error ? reason.message : '操作失败' })
      await flush().catch(report)
    }).finally(() => {
      running.current = false
      notify()
    })
  }
  useEffect(() => {
    mounted.current = true
    const sync = (): void => {
      setProject(current.current)
      setBusy(running.current)
      setSaving(controller.saving.current)
      setSaveError(controller.saveError.current)
      setBrowserOpen(controller.browserOpen.current)
      if (current.current) setError(workspace(current.current).error)
    }
    controller.listeners.add(sync)
    sync()
    const restore = async (): Promise<void> => {
      if (current.current) return
      const items = await props.listJdProjects()
      const record = items.find(item => item.session_id === props.sessionId)
      const saved = record ? await props.loadJdProject(record.id) : await props.initializeJdProject(props.sessionId)
      if (!saved || saved.session_id !== props.sessionId) return
      revision.current = saved.revision
      publish(saved)
    }
    const requestFlush = (event: Event): void => {
      (event as CustomEvent<FlushRequest>).detail.waits.push(flush())
    }
    const refreshBrowser = (): void => {
      const value = current.current
      if (value) void jdBrowserStatus(value.id).then((opened) => {
        controller.browserOpen.current = opened
        notify()
      }).catch(report)
    }
    controller.restoring ??= restore()
    void controller.restoring.then(refreshBrowser).catch((reason: unknown) => {
      delete controller.restoring
      report(reason)
    }).finally(() => { if (mounted.current) setLoading(false) })
    window.addEventListener('jd-project-flush', requestFlush)
    window.addEventListener('focus', refreshBrowser)
    return () => {
      mounted.current = false
      controller.listeners.delete(sync)
      clearTimeout(timer.current)
      window.removeEventListener('jd-project-flush', requestFlush)
      window.removeEventListener('focus', refreshBrowser)
      void flush().catch(() => {
        // A detached view cannot display errors; Host revision checks preserve the previous saved record.
      })
    }
  }, [props.sessionId])
  const go = (step: JdWorkspace['step']): void => {
    run(async () => { changeWorkspace({ step, error: '' }); await flush() })
  }
  const infer = (): void => {
    run(async () => {
      await flush()
      const value = requireProject()
      const roles = [...await props.inferJdRoles(value.session_id, value.major.trim(), value.direction.trim())]
      change(item => ({ ...item, roles, workspace: { ...workspace(item), role_text: roles.join('、'), error: '' } }))
      await flush()
      if (mounted.current) setNotice(roles.length ? `已生成 ${roles.length} 个岗位建议，可继续编辑。` : '未生成岗位建议，请手动填写。')
    })
  }
  const search = (): void => {
    run(async () => {
      await flush()
      let value = requireProject()
      if (workspace(value).search_status !== 'draft') { await props.createJdSearchSession(value); return }
      changeWorkspace({ search_status: 'running', error: '' })
      await flush()
      value = requireProject()
      try {
        const jobs = await props.runJdSearch(value.session_id, {
          major: value.major, direction: value.direction, roles: value.roles, platforms: value.platforms,
          region: value.region, publishedWithin: value.published_within, targetCount: value.target_count,
        })
        const sources = requireProject().sources.map(source => ({ ...source }))
        for (const job of jobs) {
          if (!job.body || !job.sourceUrl || !job.capturedAt) continue
          const content_hash = await jdHash(job.body)
          if (sources.some(source => source.content_hash === content_hash)) continue
          for (const source of sources) if (source.source_url === sourceUrl(job.sourceUrl)) source.excluded = true
          sources.push({ id: `JD-${crypto.randomUUID()}`, title: job.title, company: job.company, place: job.place,
            platform: job.platform, source_url: sourceUrl(job.sourceUrl), body: job.body, captured_at: job.capturedAt,
            content_hash, acquisition: 'http', excluded: false })
        }
        change(item => ({ ...item, sources,
          pending_sources: props.pendingJdSources?.(value.session_id) ?? [],
          workspace: { ...workspace(item), step: 3, search_status: 'completed', error: '' } }))
        await flush()
      } catch (reason) { changeWorkspace({ search_status: 'failed' }); throw reason }
    })
  }
  const appendSource = async (source: Omit<JdSource, 'id' | 'excluded'>): Promise<void> => {
    if (requireProject().sources.some(item => item.content_hash === source.content_hash)) throw new Error('该 JD 原文已保存，未重复计入样本')
    change(value => ({ ...value,
      sources: [...value.sources.map(item => item.source_url === source.source_url ? { ...item, excluded: true } : item),
        { ...source, id: `JD-${crypto.randomUUID()}`, excluded: false }],
      pending_sources: value.pending_sources.filter(item => item.url !== source.source_url),
      workspace: { ...workspace(value), error: '', capture: { ...workspace(value).capture, body: '', file_name: '' } },
    }))
    await flush()
    if (mounted.current) setNotice('JD 原文和来源已保存。')
  }
  const beginCapture = (pending?: { url: string; title: string }): void => {
    run(async () => {
      if (pending) captureChange({ url: pending.url, title: pending.title })
      await flush()
      const value = requireProject()
      await openJdBrowser(value.id, sourceUrl(workspace(value).capture.url))
      controller.browserOpen.current = true
      notify()
      if (mounted.current) {
        setNotice('请在采集窗口完成登录并打开岗位详情，再返回点击“登录后继续采集”。若平台持续限制读取，可导入合法取得的原文。')
      }
    })
  }
  const continueCapture = (): void => {
    run(async () => {
      await flush()
      const value = requireProject()
      if (!await jdBrowserStatus(value.id)) {
        controller.browserOpen.current = false
        notify()
        throw new Error('采集窗口已关闭，请先重新打开岗位并登录')
      }
      const result = await readJdBrowser(value.id)
      const capture = workspace(requireProject()).capture
      await appendSource({ title: result.title, company: capture.company, place: '未独立核验',
        platform: new URL(result.url).hostname, source_url: sourceUrl(result.url), body: result.body,
        captured_at: result.captured_at, content_hash: result.content_hash, acquisition: 'browser' })
    })
  }
  const importSource = (): void => {
    run(async () => {
      const capture = workspace(requireProject()).capture
      if (!capture.body.trim() || !capture.title.trim()) throw new Error('请填写岗位名称和完整 JD 原文')
      if (!/岗位职责|工作职责|职位描述|任职要求|职位要求|工作内容|职责描述|job description|responsibilit/iu.test(capture.body))
        throw new Error('原文未包含岗位职责，请检查是否误贴了登录页或搜索摘要')
      await appendSource({ title: capture.title, company: capture.company, place: '用户提供，未独立核验',
        platform: new URL(sourceUrl(capture.url)).hostname, source_url: sourceUrl(capture.url), body: capture.body,
        captured_at: new Date().toISOString(), content_hash: await jdHash(capture.body), acquisition: 'manual' })
    })
  }
  const generate = (): void => {
    run(async () => {
      await flush()
      const value = requireProject()
      if (!value.sources.some(source => !source.excluded)) throw new Error('请至少保留一份 JD 原文')
      const nodes = graphNodes(await props.generateJdGraph(value.session_id, value), value.sources)
      const next: JdGraph = { version: value.graphs.length + 1, generated_at: new Date().toISOString(), nodes,
        source_hashes: Object.fromEntries(value.sources.filter(source => !source.excluded)
          .map(source => [source.id, source.content_hash])) }
      change(item => ({ ...item, graphs: [...item.graphs, next], workspace: { ...workspace(item), step: 4, graph_version: next.version, error: '' } }))
      await flush()
    })
  }
  const confirm = (): void => {
    run(async () => {
      await flush()
      const value = requireProject()
      const selected = value.graphs.find(item => item.version === workspace(value).graph_version) ?? value.graphs.at(-1)
      if (!selected) throw new Error('请先生成并保存图谱')
      const saved = await props.confirmJdProject(value.id, selected.version, value.revision)
      revision.current = saved.revision
      publish(saved)
      window.dispatchEvent(new Event('jd-projects-changed'))
      if (mounted.current) setNotice(`已确认 v${selected.version} 能力图谱，已保存供后续课程建设使用。`)
    })
  }
  const exportGraph = (): void => {
    run(async () => {
      await flush()
      const value = requireProject()
      const selected = value.graphs.find(item => item.version === workspace(value).graph_version) ?? value.graphs.at(-1)
      if (!selected || !value.confirmations?.some(item => item.version === selected.version)) throw new Error('请先确认所选能力图谱版本')
      const output = await props.exportJdProject(value.id, selected.version)
      const filename = `${value.major.replace(/[<>:"/\\|?*]/g, '_')}-岗位能力图谱-v${selected.version}.html`
      const exported = await exportJdHtml(filename, output.html)
      if (mounted.current) setNotice(exported.opened === 'download'
        ? 'HTML 已下载，请从下载目录打开。'
        : `HTML 已保存：${exported.path}；${exported.opened === 'browser' ? '已用系统浏览器打开。' : '浏览器未能打开，已显示文件所在目录。'}`)
    })
  }
  if (loading) return <div className={css.notice}>正在恢复已保存的 JD 项目…</div>
  if (!project) return <div className={css.notice} role="status">{error || '正在建立独立搜索档案…'}</div>
  const state = workspace(project)
  const capture = state.capture
  const graph = project.graphs.find(item => item.version === state.graph_version) ?? project.graphs.at(-1)
  const retained = project.sources.filter(source => !source.excluded)
  const confirmed = graph && project.confirmations?.find(item => item.version === graph.version)
  const targetLocked = busy || state.search_status !== 'draft'
  return <div className={css.workbench}>
    <header className={css.header}><div><span className={css.kicker}>岗位研究工作台</span><h1>JD 搜索与岗位能力图谱</h1>
      <p>每次搜索独立存档；确认图谱后可用于课程建设并导出 HTML 报告。</p></div></header>
    <main className={css.content}>
      <p className={css.muted} role="status">{saving ? '正在保存…' : '已存档'} · 修订 {project.revision} · {project.sources.length} 份原文 · {project.graphs.length} 个图谱版本</p>
      {error && <div className={css.loginNotice} role="alert">{error}{saveError && <button className={css.infoButton} type="button" disabled={busy} onClick={() => { run(async () => { await flush() }) }}>重试保存</button>}</div>}
      {notice && <div className={css.notice} role="status">{notice}</div>}
      {state.search_status === 'running' && !busy && <div className={css.loginNotice}>该搜索尚未完成。可稍后重新打开查看；重新检索会建立新档案并保留本次记录。</div>}
      <nav className={css.progress} aria-label="研究步骤">{STEPS.map((label, index) =>
        <button type="button" key={label} disabled={busy || (index === 3 && !graph)} className={state.step === index + 1 ? css.progressActive : css.progressButton}
          onClick={() => { go((index + 1) as JdWorkspace['step']) }}>{index + 1} {label}</button>)}</nav>
      {state.step === 1 && <>
        <Header step={1} title="从学科专业推理实际岗位" text="填写专业和岗位名称后自动保存，也可以由模型推理岗位建议。搜索目标与后续原文保存在本次独立会话。" />
        <div className={css.card}>
          <label className={css.label}>学科 / 专业<input className={css.input} value={project.major} disabled={targetLocked}
            onChange={(event) => {
              const major = event.target.value; change(value => ({ ...value, major, title: major.trim() ? `${major}岗位研究` : '未命名岗位研究' }))
            }} /></label>
          <label className={css.label}>专业方向（可选）<textarea className={css.textarea} value={project.direction} disabled={targetLocked}
            onChange={(event) => { const direction = event.target.value; change(value => ({ ...value, direction })) }} /></label>
          <div className={css.rowBetween}><label className={css.label} htmlFor="jd-roles">岗位名称（可手动修改，使用顿号分隔）</label>
            <button className={css.infoButton} type="button" disabled={targetLocked || !project.major.trim()} onClick={infer}>推理岗位名称</button></div>
          <input id="jd-roles" className={css.input} value={state.role_text ?? project.roles.join('、')} disabled={targetLocked} onChange={(event) => {
            const role_text = event.target.value
            change(value => ({ ...value, roles: role_text.split('、').map(role => role.trim()).filter(Boolean), workspace: { ...workspace(value), role_text } }))
          }} />
        </div><div className={css.footer}><span className={css.muted}>公开网页使用 DSH 原生搜索与抓取</span>
          <button className={css.primaryButton} type="button" disabled={busy || !project.roles.length} onClick={() => { go(2) }}>确认岗位并继续</button></div>
      </>}
      {state.step === 2 && <>
        <Header step={2} title="选择平台与搜索范围" text="平台登录和安全验证由你在采集窗口完成。BOSS 等平台可能限制自动读取；限制持续时可导入你合法取得的完整原文。" />
        <div className={css.platformGrid}>{PLATFORMS.map(platform => <button className={project.platforms.includes(platform) ? css.platformActive : css.platform} type="button" key={platform}
          aria-pressed={project.platforms.includes(platform)} disabled={targetLocked} onClick={() => { change(value => ({ ...value,
            platforms: value.platforms.includes(platform)
              ? value.platforms.filter(item => item !== platform)
              : [...value.platforms, platform] }))
          }}><b>{platform}</b><small>{platform === '公开网页' || platform === '四川高校人才网' ? '公开网页搜索与抓取' : '可能需要手动登录或导入'}</small></button>)}</div>
        <div className={css.card}>
          <label className={css.label}>区域范围<select className={css.input} value={project.region} disabled={targetLocked}
            onChange={(event) => {
              const region = event.target.value
              change(value => ({ ...value, region }))
            }}>
            <option>四川及西南地区</option><option>成渝经济圈</option><option>全国重点城市</option></select></label>
          <label className={css.label}>发布时间<select className={css.input} value={project.published_within} disabled={targetLocked}
            onChange={(event) => {
              const published_within = event.target.value
              change(value => ({ ...value, published_within }))
            }}>
            <option>最近 30 天</option><option>最近 90 天</option><option>最近一年</option></select></label>
          <label className={css.label}>目标条数<select className={css.input} value={project.target_count} disabled={targetLocked}
            onChange={(event) => {
              const target_count = event.target.value
              change(value => ({ ...value, target_count }))
            }}>
            <option>5 条（测试）</option><option>20-50 条</option><option>50-100 条</option></select></label>
        </div>
        <p className={css.notice}>{state.search_status === 'draft' ? '无法读取的岗位会保留链接和原因，供后续手动登录采集或导入原文。' : '本次搜索的目标与范围已归档。新建搜索后可修改条件，原记录完整保留。'}</p>
        <div className={css.footer}><button className={css.primaryButton} type="button" disabled={busy || !project.roles.length || !project.platforms.length} onClick={search}>
          {busy ? '正在检索…' : state.search_status === 'draft' ? '开始检索' : '以此范围新建搜索'}</button></div>
      </>}
      {state.step === 3 && <>
        <Header step={3} title="JD 原文与来源" text="登录页、反爬提示和搜索摘要不算岗位原文。保留原始 URL、时间和内容指纹；手动导入的来源由你声明。" />
        <div className={css.notice}>遇到 BOSS 等平台安全验证时，请手动验证并打开单条岗位详情。若持续受限，请停止重复尝试，使用已合法取得的原文导入；应用不会绕过平台限制。</div>
        {project.pending_sources.map(item => <article key={item.url} className={css.card}><strong>{item.title}</strong><p>{item.reason}</p>
          <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { beginCapture(item) }}>打开此岗位并登录</button><p className={css.muted}>{item.url}</p></article>)}
        <section className={css.card} aria-label="采集或导入 JD">
          <label className={css.label}>来源 URL<input className={css.input} value={capture.url} disabled={busy}
            onChange={(event) => { captureChange({ url: event.target.value }) }} /></label>
          <label className={css.label}>岗位名称<input className={css.input} value={capture.title} disabled={busy}
            onChange={(event) => { captureChange({ title: event.target.value }) }} /></label>
          <label className={css.label}>企业（可填未披露）<input className={css.input} value={capture.company} disabled={busy}
            onChange={(event) => { captureChange({ company: event.target.value }) }} /></label>
          <div className={css.captureActions}>
            <button type="button" className={css.primaryButton} disabled={busy || !capture.url.trim()} onClick={() => { beginCapture() }}>{browserOpen ? '重新打开岗位采集窗口' : '打开岗位并登录'}</button>
            {browserOpen && <button type="button" className={css.infoButton} disabled={busy} onClick={continueCapture}>登录后继续采集</button>}
          </div>
          <h3 className={css.importHeading}>手动导入完整原文</h3><p>平台限制读取时，可粘贴或选择已取得的 JD 文件。请填写上方岗位名称和真实来源 URL；原文会保存为用户提供的证据。</p>
          <label className={css.label}>导入 JD 原文<textarea className={css.textarea} value={capture.body} disabled={busy}
            onChange={(event) => { captureChange({ body: event.target.value }) }} placeholder="粘贴完整岗位职责和任职要求；不接受搜索摘要" /></label>
          <div className={css.fileUpload}><label className={css.filePicker}>
            <input className={css.fileInput} type="file" aria-label="读取原文文件" aria-describedby="jd-file-feedback" accept=".txt,.md,text/plain,text/markdown" disabled={busy}
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) run(async () => {
                if (file.size > 1000000) throw new Error('原文文件超过 1 MB')
                captureChange({ body: await file.text(), file_name: file.name }); await flush()
              }) }} /><span className={css.filePickerButton}>选择原文文件</span></label>
          <span id="jd-file-feedback" className={css.fileHint} role="status">{capture.file_name ? `已读取：${capture.file_name}` : '支持 .txt / .md，最大 1 MB'}</span></div>
          <button type="button" className={css.infoButton} disabled={busy || !capture.body.trim()} onClick={importSource}>保存导入原文（用户声明来源）</button>
        </section>
        {project.sources.length === 0 && <div className={css.notice}>尚无已保存原文，可调整搜索范围、登录采集或导入正文。</div>}
        {project.sources.map(source => <article className={css.card} key={source.id}><h3>{source.title} {source.excluded ? '（已剔除）' : ''}</h3>
          <p>{source.company} · {source.platform} · {source.acquisition === 'manual' ? '用户提供，未独立联网核验' : source.acquisition === 'browser' ? '浏览器已读取' : '公开 HTTP 已读取'}</p>
          <a href={source.source_url} target="_blank" rel="noopener noreferrer">原始来源</a><p className={css.muted}>{source.captured_at} · SHA-256：{source.content_hash}</p>
          <details><summary>查看完整原文和证据编号</summary><p>{source.id}</p><pre className={css.sourceBody}>{source.body}</pre></details>
          <button type="button" className={css.infoButton} disabled={busy} onClick={() => { run(async () => {
            change(value => ({ ...value, sources: value.sources.map(item => item.id === source.id
              ? { ...item, excluded: !item.excluded }
              : source.excluded && item.source_url === source.source_url ? { ...item, excluded: true } : item) }))
            await flush()
          }) }}>{source.excluded ? '恢复原文' : '剔除原文'}</button></article>)}
        <div className={css.footer}><button className={css.infoButton} type="button" disabled={busy} onClick={() => { go(2) }}>调整搜索范围</button>
          <button className={css.primaryButton} type="button" disabled={busy || !retained.length} onClick={generate}>{busy ? '正在处理…' : `使用 ${retained.length} 份原文生成五级图谱`}</button></div>
      </>}
      {state.step === 4 && graph && <>
        <Header step={4} title="五级岗位能力图谱" text="原文直接陈述与推断分开标记；样本引用频率不代表市场总体需求。确认后保存所选版本供课程建设使用，新版本需重新确认。" />
        <label className={css.label}>图谱版本<select className={css.input} value={graph.version} disabled={busy}
          onChange={(event) => {
            const graph_version = Number(event.target.value)
            run(async () => { changeWorkspace({ graph_version }); await flush() })
          }}>
          {project.graphs.map(item => <option key={item.version} value={item.version}>
            v{item.version} · {item.generated_at}</option>)}</select></label>
        <div className={css.actionBar}><div className={css.actionGroup}>
          <button className={css.infoButton} type="button" disabled={busy} onClick={() => { go(3) }}>补充或筛选原文</button>
          <button className={css.infoButton} type="button" disabled={busy || !retained.length} onClick={generate}>生成新版本</button></div>
        <div className={css.actionGroup}>{confirmed ? <><span className={css.confirmed}>已确认 v{graph.version} · 已保存供课程建设使用</span>
          <button className={css.primaryButton} type="button" disabled={busy} onClick={exportGraph}>导出 HTML</button></> :
          <button className={css.primaryButton} type="button" disabled={busy} onClick={confirm}>确认能力图谱</button>}</div></div>
        {graph.nodes.map(node => <article className={css.card} key={node.id} data-basis={node.basis} style={{ marginInlineStart: ['project', 'task', 'process', 'skill', 'knowledge'].indexOf(node.kind) * 10 }}>
          <p className={css.muted}>{node.id} · 父节点 {node.parent_id ?? '无'} · {({ project: '项目', task: '任务', process: '流程', skill: '技能点', knowledge: '知识点' } as const)[node.kind]}</p>
          <h3>{node.title} <span className={css.pill}>{node.basis === 'direct' ? '原文直接陈述' : '推断 · 待专家核实'}</span></h3>
          <p>{node.description}</p><small>{frequency(node, graph)}</small>{node.assessment && <p>评价建议（推断）：{node.assessment}</p>}
          {node.evidence.map((entry, index) => {
            const source = project.sources.find(item => item.id === entry.jd_id)
            return <details key={index}>
              <summary>原文依据 · {source?.title ?? entry.jd_id}</summary><blockquote>{entry.quote}</blockquote><p>{entry.jd_id}</p><a href={source?.source_url} target="_blank" rel="noopener noreferrer">查看来源</a></details> })}
        </article>)}
      </>}
    </main>
  </div>
}
