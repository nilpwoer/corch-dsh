import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { JdSearchAbility, JdSearchAnalysis, JdSearchJob, JdSearchRequest, JdSearchTask, TeachingReformProps } from './types.ts'
import css from './JdSearchWorkbench.module.css'
import { buildJdSearchHtmlReport, buildJdSearchReport, jdSearchProjectPaths, jdSearchProjectTitle, readJdSearchProject, readJdSearchProjects, writeJdSearchProject, JD_SEARCH_PROJECTS_CHANGED } from './jdSearchProjects.ts'
import { readCompletedJdSearch } from './jdAgentResult.ts'

const STEPS = ['搜索目标', '平台与范围', 'JD 结果筛选', '典型工作任务', '能力标签']
const DIRECT_PLATFORMS = ['公开网页', '四川高校人才网']
const LOGIN_PLATFORMS = ['58 同城', 'BOSS 直聘', '智联招聘', '前程无忧 51job', '鱼泡直聘']

export function JdSearchSidebar({ wide, createJdSearchSession, openJdSearchSession }: PropsRuntime<'sidebar.workspaces'> & { createJdSearchSession: () => Promise<void>; openJdSearchSession: (id: string) => void }): ReactNode {
  const [projects, setProjects] = useState(readJdSearchProjects)
  useEffect(() => {
    const refresh = (): void => setProjects(readJdSearchProjects())
    window.addEventListener(JD_SEARCH_PROJECTS_CHANGED, refresh)
    window.addEventListener('storage', refresh)
    refresh()
    return () => {
      window.removeEventListener(JD_SEARCH_PROJECTS_CHANGED, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])
  return <aside className={css.sidebar}>{wide ? <><div className={css.sidebarTitle}>JD 搜索</div><button className={css.newButton} type="button" onClick={() => { void createJdSearchSession().catch((reason) => { window.alert(reason instanceof Error ? reason.message : String(reason)) }) }}>＋ 新建搜索</button><div className={css.sidebarHint}>搜索项目 · {projects.length} 个</div><div className={css.historyList}>{projects.length === 0 ? <div className={css.emptyHistory}>完成一次岗位搜索后，项目会显示在这里。</div> : projects.map(project => <button className={css.historyCard} type="button" key={project.sessionId} onClick={() => openJdSearchSession(project.sessionId)}><strong>{project.request.major} · {project.jobs.length} 条 JD</strong><small>{project.request.roles.join('、')}</small><em>{new Date(project.updatedAt).toLocaleString('zh-CN')}</em></button>)}</div></> : <div className={css.sidebarMini}>JD<br />搜<br />索</div>}</aside>
}
function Header({ step, title, text }: { step: number; title: string; text: string }): ReactNode {
  return <div className={css.sectionIntro}><span className={css.eyebrow}>STEP 0{step}</span><h2>{title}</h2><p>{text}</p></div>
}
function Pill({ children }: { children: ReactNode }): ReactNode { return <span className={css.pill}>{children}</span> }

function Target({ initialTarget, infer, next }: {
  initialTarget: { major: string; direction: string; roles: readonly string[] }
  infer: (major: string, direction: string) => Promise<readonly string[]>
  next: (major: string, direction: string, roles: string[]) => void
}): ReactNode {
  const [major, setMajor] = useState(initialTarget.major)
  const [direction, setDirection] = useState(initialTarget.direction)
  const [roleText, setRoleText] = useState(initialTarget.roles.join('、'))
  const [inferring, setInferring] = useState(false)
  const [inferenceMessage, setInferenceMessage] = useState('')
  const roles = roleText.split('、').map(role => role.trim()).filter(Boolean)
  const inferRoles = async (): Promise<void> => { if (major.trim() === '') return; setInferring(true); setInferenceMessage('正在根据专业推理岗位名称…'); try { const inferred = await infer(major.trim(), direction.trim()); setRoleText(inferred.join('、')); setInferenceMessage(inferred.length > 0 ? `已生成 ${inferred.length} 个岗位建议，可继续编辑。` : '未生成岗位建议，请手动填写。') } catch (reason) { setInferenceMessage(reason instanceof Error ? `推理失败：${reason.message}` : '推理失败，请手动填写岗位。') } finally { setInferring(false) } }
  return <><Header step={1} title="从学科专业推理实际岗位" text="输入学科专业后由 LLM 推理常见岗位名称，也可以手动修改岗位列表。公开网页搜索使用 DSH 原生 web_search 和 web_fetch。" /><div className={css.card}><label className={css.label}>学科 / 专业</label><input className={css.input} value={major} onChange={event => setMajor(event.target.value)} /><label className={css.label}>专业方向（可选）</label><textarea className={css.textarea} value={direction} onChange={event => setDirection(event.target.value)} /><div className={css.rowBetween}><label className={css.label}>岗位名称（可手动修改，使用顿号分隔）</label><button className={css.infoButton} type="button" aria-label="推理岗位名称" title="根据学科专业推理岗位名称" disabled={inferring || major.trim() === ''} onClick={() => { void inferRoles() }}><span>i</span><span>推理岗位名称</span></button></div><input className={css.input} value={roleText} onChange={event => setRoleText(event.target.value)} />{inferenceMessage === '' ? null : <div className={css.inferenceMessage}>{inferenceMessage}</div>}</div><div className={css.footer}><span className={css.muted}>可直接使用 DSH 公开网页搜索</span><button className={css.primaryButton} type="button" disabled={roles.length === 0} onClick={() => next(major, direction, roles)}>确认岗位并继续</button></div></>
}
function Platforms({ busy, error, initialRequest, next }: {
  busy: boolean
  error: string | undefined
  initialRequest: JdSearchRequest | undefined
  next: (platforms: string[], range: Omit<JdSearchRequest, 'major' | 'direction' | 'roles' | 'platforms'>) => void
}): ReactNode {
  const [directSelected, setDirectSelected] = useState(() =>
    initialRequest?.platforms.filter(platform => DIRECT_PLATFORMS.includes(platform)) ?? DIRECT_PLATFORMS)
  const [loginSelected, setLoginSelected] = useState(() => initialRequest?.platforms.find(platform => LOGIN_PLATFORMS.includes(platform)) ?? '')
  const selected = [...directSelected, ...(loginSelected === '' ? [] : [loginSelected])]
  const [region, setRegion] = useState(initialRequest?.region ?? '四川及西南地区')
  const [publishedWithin, setPublishedWithin] = useState(initialRequest?.publishedWithin ?? '最近 90 天')
  const [targetCount, setTargetCount] = useState(initialRequest?.targetCount ?? '5 条（测试）')
  return <><Header step={2} title="选择平台与搜索范围" text="先选可直接爬取的平台，也可以额外选择一个需要你协助登录的平台。LinkedIn 不纳入首版。" /><div className={css.platformGroups}>
    <section className={css.platformGroup} aria-labelledby="jd-direct-platforms-title"><div className={css.platformGroupHeader}><h3 id="jd-direct-platforms-title">1. 可直接爬取的平台</h3><span>可多选</span></div><p>使用公开网页搜索和抓取，无需登录招聘账号。</p><div className={css.platformGrid} role="group" aria-labelledby="jd-direct-platforms-title">{DIRECT_PLATFORMS.map(platform => <button aria-checked={directSelected.includes(platform)} className={directSelected.includes(platform) ? css.platformActive : css.platform} type="button" role="checkbox" key={platform} onClick={() => setDirectSelected(current => current.includes(platform) ? current.filter(item => item !== platform) : [...current, platform])}><b>{platform}</b><small>{platform === '公开网页' ? 'DSH web_search / web_fetch' : '高校公开招聘网页'}</small></button>)}</div></section>
    <section className={css.platformGroup} aria-labelledby="jd-login-platforms-title"><div className={css.platformGroupHeader}><h3 id="jd-login-platforms-title">2. 需要用户协助登录的平台</h3><span>单选</span></div><p>最多选择一个。检索前会提示你在浏览器登录；未选择时只搜索上面的公开平台。</p><div className={css.platformGrid} role="radiogroup" aria-labelledby="jd-login-platforms-title">{LOGIN_PLATFORMS.map(platform => <button aria-checked={loginSelected === platform} className={loginSelected === platform ? css.platformActive : css.platform} type="button" role="radio" key={platform} onClick={() => setLoginSelected(current => current === platform ? '' : platform)}><b>{platform}</b><small>需要你在浏览器中完成登录</small></button>)}</div></section>
  </div><div className={css.card}><label className={css.label}>区域范围<select id="jd-region" className={css.input} value={region} onChange={event => setRegion(event.target.value)}><option>四川及西南地区</option><option>成渝经济圈</option><option>全国重点城市</option></select></label><label className={css.label}>发布时间<select id="jd-published" className={css.input} value={publishedWithin} onChange={event => setPublishedWithin(event.target.value)}><option>最近 30 天</option><option>最近 90 天</option><option>最近一年</option></select></label><label className={css.label}>目标条数<select id="jd-count" className={css.input} value={targetCount} onChange={event => setTargetCount(event.target.value)}><option>5 条（测试）</option><option>20-50 条</option><option>50-100 条</option></select></label></div>{loginSelected === '' ? <div className={css.notice}>Agent Reach 将先搜索已选公开平台。</div> : <div className={css.loginNotice}>本次还会检索「{loginSelected}」。开始后请按提示在浏览器中登录；其他登录平台未纳入本次搜索。</div>}{error === undefined ? null : <div className={css.loginNotice}>{error}</div>}<div className={css.footer}><span className={css.muted}>已选 {selected.length} 个平台</span><button className={css.primaryButton} type="button" disabled={busy || selected.length === 0} onClick={() => next(selected, { region, publishedWithin, targetCount })}>{busy ? '正在检索…' : '开始检索'}</button></div></>
}
function Results({ jobs, next, busy, confirmedJobIds, excludedJobIds, fileStatus, onExcludedChange }: {
  jobs: readonly JdSearchJob[]
  next: (jobs: readonly JdSearchJob[]) => void
  busy: boolean
  confirmedJobIds?: readonly string[] | undefined
  excludedJobIds?: readonly string[] | undefined
  fileStatus: string
  onExcludedChange: (jobIds: string[]) => void
}): ReactNode {
  const [excluded, setExcluded] = useState<string[]>(() => [...(excludedJobIds ?? (
    confirmedJobIds === undefined ? [] : jobs.filter(job => !confirmedJobIds.includes(job.id)).map(job => job.id)
  ))])
  const visible = jobs.filter(job => !excluded.includes(job.id))
  const toggleExcluded = (jobId: string): void => {
    const nextExcluded = excluded.includes(jobId) ? excluded.filter(item => item !== jobId) : [...excluded, jobId]
    setExcluded(nextExcluded)
    onExcludedChange(nextExcluded)
  }
  return <><Header step={3} title="筛选和确认岗位 JD" text="正文已清洗、跨平台去重。剔除只影响本次分析，之后仍可取消剔除。" />{fileStatus === '' ? null : <div className={css.notice}>{fileStatus}</div>}<div className={css.resultList}>{jobs.map((job) => { const isExcluded = excluded.includes(job.id); return <article className={isExcluded ? css.resultCardExcluded : css.resultCard} key={job.id}><div className={css.resultHead}><div><span className={css.resultId}>{job.id}</span><h3>{job.title}</h3><p>{job.company} · {job.place}</p></div><Pill>{job.score}% 相关</Pill></div><p className={css.resultSummary}>{job.body || job.summary}</p><div className={css.resultMeta}><span>{job.platform}</span>{job.sourceUrl ? <a href={job.sourceUrl} target="_blank" rel="noreferrer">查看来源</a> : null}<button type="button" className={isExcluded ? css.restoreButton : css.excludeButton} onClick={() => toggleExcluded(job.id)}>{isExcluded ? '取消剔除' : '剔除'}</button></div></article> })}</div><div className={css.footer}><span className={css.muted}>已剔除 {excluded.length} 条 · 可随时取消</span><button className={css.primaryButton} type="button" disabled={busy || visible.length === 0} onClick={() => next(visible)}>{busy ? '正在生成…' : `确认 ${visible.length} 条并生成任务`}</button></div></>
}
function Tasks({ tasks, next, reportPath, htmlReportPath, reportSaved, openReport, saveStatus }: {
  tasks: readonly JdSearchTask[]
  next: () => void
  reportPath: string | undefined
  htmlReportPath: string | undefined
  reportSaved: boolean
  openReport: () => Promise<void>
  saveStatus: string
}): ReactNode {
  const [openError, setOpenError] = useState('')
  const open = async (): Promise<void> => { setOpenError(''); try { await openReport() } catch (reason) { setOpenError(reason instanceof Error ? reason.message : String(reason)) } }
  return <><Header step={4} title="典型工作任务" text="任务以动词开头，可独立交付工作成果，并保留来源 JD 证据。" /><div className={css.taskList}>{tasks.map((task, index) => <article className={css.taskCard} key={task.title}><div className={css.taskNumber}>0{index + 1}</div><div><h3>{task.title}</h3><p>{task.description}</p><small>样本频次提示：{Math.round(task.freqHint * 100)}% · 证据：{task.evidenceIds.join('、')}</small></div></article>)}</div>{saveStatus === '' ? null : <div className={css.notice}>{saveStatus}{reportPath === undefined ? '' : ` · ${reportPath}`}</div>}{openError === '' ? null : <div className={css.loginNotice}>无法打开阅读报告：{openError}</div>}<div className={css.footer}>{reportSaved && htmlReportPath !== undefined ? <button className={css.button} type="button" onClick={() => { void open() }}>阅读报告</button> : null}<button className={css.primaryButton} type="button" onClick={next}>确认任务并查看能力标签</button></div></>
}
function Abilities({ abilities, save, saving, finalizedAt, status }: { abilities: readonly JdSearchAbility[]; save: () => void; saving: boolean; finalizedAt: string | undefined; status: string }): ReactNode { return <><Header step={5} title="专业能力标签" text="只映射到专业能力，不生成课程安排。" /><div className={css.abilityGrid}>{abilities.map(ability => <article className={css.abilityCard} key={ability.title}><Pill>{ability.level}</Pill><h3>{ability.title}</h3><p>关联 {ability.taskCount} 个典型工作任务 · 来源 {ability.sourceCount} 条 JD</p></article>)}</div><div className={css.summaryBox}><div><h3>{finalizedAt === undefined ? '本次搜索结果已确认' : '搜索项目已冻结'}</h3><p>{status || (finalizedAt === undefined ? '点击后将保存并冻结本项目的 Markdown 与 HTML 报告，供后续工作台引用。' : `Markdown 与 HTML 报告已冻结 · ${new Date(finalizedAt).toLocaleString('zh-CN')}`)}</p></div><button className={css.primaryButton} type="button" disabled={saving || finalizedAt !== undefined} onClick={save}>{saving ? '正在保存并冻结…' : finalizedAt === undefined ? '保存搜索项目' : '已冻结'}</button></div></> }

export function JdSearchWorkbench(props: TeachingReformProps): ReactNode {
  const settledSnapshot = props.useSession(snapshot =>
    snapshot.openState === 'open' && !snapshot.running && snapshot.queue.length === 0 ? snapshot : null)
  const activeSessionId = useRef(String(props.sessionId))
  activeSessionId.current = String(props.sessionId)
  const initialProject = readJdSearchProject(String(props.sessionId))
  const [projectRecord, setProjectRecord] = useState(initialProject)
  const [step, setStep] = useState(initialProject?.analysis === undefined ? initialProject === undefined ? 1 : 3 : 4)
  const [projectKey, setProjectKey] = useState(0)
  const [target, setTarget] = useState({ major: initialProject?.request.major ?? '', direction: initialProject?.request.direction ?? '', roles: [...(initialProject?.request.roles ?? [])] })
  const [jobs, setJobs] = useState<readonly JdSearchJob[]>(initialProject?.jobs ?? [])
  const [analysis, setAnalysis] = useState<JdSearchAnalysis>(initialProject?.analysis ?? { tasks: [], abilities: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [fileStatus, setFileStatus] = useState('')
  const [finalizing, setFinalizing] = useState(false)
  const [finalizeStatus, setFinalizeStatus] = useState('')
  useEffect(() => {
    const stored = readJdSearchProject(String(props.sessionId))
    if (stored === undefined) {
      setProjectRecord(undefined)
      setProjectKey(current => current + 1)
      setTarget({ major: '', direction: '', roles: [] })
      setJobs([])
      setAnalysis({ tasks: [], abilities: [] })
      setStep(1)
      setBusy(false)
      setError(undefined)
      setFileStatus('')
      setFinalizing(false)
      setFinalizeStatus('')
      return
    }
    setProjectRecord(stored)
    setTarget({ major: stored.request.major, direction: stored.request.direction, roles: [...stored.request.roles] })
    setJobs(stored.jobs)
    setAnalysis(stored.analysis ?? { tasks: [], abilities: [] })
    setStep(stored.analysis === undefined ? 3 : 4)
    setError(undefined)
    setFinalizing(false)
    setFinalizeStatus('')
  }, [props.sessionId])
  useEffect(() => {
    const sessionId = String(props.sessionId)
    if (busy || settledSnapshot === null || readJdSearchProject(sessionId) !== undefined) return
    const recovered = readCompletedJdSearch(settledSnapshot)
    if (recovered === undefined) return
    const paths = jdSearchProjectPaths(sessionId)
    const project = {
      sessionId, title: jdSearchProjectTitle(recovered.request, recovered.jobs.length),
      request: recovered.request, jobs: recovered.jobs, jobsPath: paths.jobs,
      updatedAt: new Date(recovered.completedAt).toISOString(),
    }
    writeJdSearchProject(project)
    setProjectRecord(project)
    setTarget({ major: project.request.major, direction: project.request.direction, roles: [...project.request.roles] })
    setJobs(project.jobs)
    setStep(3)
    setError(undefined)
    setFileStatus('已从会话恢复搜索结果；岗位 JD 文件尚未重新写入工作区。')
  }, [props.sessionId, settledSnapshot, busy])
  const search = async (platforms: string[], range: Omit<JdSearchRequest, 'major' | 'direction' | 'roles' | 'platforms'>): Promise<void> => {
    const sessionId = String(props.sessionId)
    const session = props.sessionId
    setBusy(true); setError(undefined); setFileStatus('')
    const request: JdSearchRequest = { ...target, platforms, ...range }
    let results: readonly JdSearchJob[]
    try { results = await props.runJdSearch(session, request) } catch (reason) { if (activeSessionId.current === sessionId) { setError(reason instanceof Error ? reason.message : '搜索失败'); setBusy(false) } return }
    const paths = jdSearchProjectPaths(sessionId)
    const project = {
      sessionId, title: jdSearchProjectTitle(request, results.length), request, jobs: results,
      jobsPath: paths.jobs, updatedAt: new Date().toISOString(),
    }
    if (activeSessionId.current === sessionId) setProjectRecord(project)
    writeJdSearchProject(project)
    if (activeSessionId.current === sessionId) {
      setJobs(results)
      setStep(3)
      setFileStatus('正在保存岗位 JD 到本地工作区…')
    }
    let renameWarning = ''
    try {
      await props.renameJdSearchProject(session, project.title)
    } catch (reason) {
      renameWarning = reason instanceof Error ? reason.message : String(reason)
    }
    try {
      await props.saveJdSearchArtifacts(session, [{ path: paths.jobs, contents: JSON.stringify({ request, jobs: results }, null, 2) }])
      const savedProject = { ...project, updatedAt: new Date().toISOString() }
      if (activeSessionId.current === sessionId) setProjectRecord(savedProject)
      writeJdSearchProject(savedProject)
      if (activeSessionId.current === sessionId) setFileStatus(renameWarning === '' ? `岗位 JD 已保存到 ${paths.jobs}` : `岗位 JD 已保存到 ${paths.jobs}；会话标题未更新：${renameWarning}`)
    } catch (reason) {
      if (activeSessionId.current === sessionId) setFileStatus(`岗位 JD 已进入项目列表，但本地文件保存失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally { if (activeSessionId.current === sessionId) setBusy(false) }
  }
  const analyze = async (confirmed: readonly JdSearchJob[]): Promise<void> => {
    const sessionId = String(props.sessionId)
    const session = props.sessionId
    setBusy(true); setError(undefined); setFileStatus('')
    const stored = readJdSearchProject(sessionId) ?? (projectRecord?.sessionId === sessionId ? projectRecord : undefined)
    if (stored !== undefined) {
      const confirmedProject = { ...stored, confirmedJobIds: confirmed.map(job => job.id), updatedAt: new Date().toISOString() }
      delete confirmedProject.finalizedAt
      delete confirmedProject.reportSavedAt
      if (activeSessionId.current === sessionId) setProjectRecord(confirmedProject)
      writeJdSearchProject(confirmedProject)
    }
    try {
      const result = await props.analyzeJdSearch(session, confirmed)
      const current = readJdSearchProject(sessionId) ?? (projectRecord?.sessionId === sessionId ? projectRecord : undefined)
      const paths = jdSearchProjectPaths(sessionId)
      const project = current === undefined ? undefined : {
        ...current, analysis: result, reportPath: paths.report, htmlReportPath: paths.htmlReport,
        updatedAt: new Date().toISOString(),
      }
      if (project === undefined) throw new Error('当前搜索项目记录不可用，无法生成报告')
      if (activeSessionId.current === sessionId) setProjectRecord(project)
      writeJdSearchProject(project)
      if (activeSessionId.current === sessionId) {
        setAnalysis(result)
        setFileStatus('正在保存典型工作任务报告…')
      }
      await props.saveJdSearchArtifacts(session, [
        { path: paths.report, contents: buildJdSearchReport(project) },
        { path: paths.htmlReport, contents: buildJdSearchHtmlReport(project) },
      ])
      const savedProject = { ...project, reportSavedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      if (activeSessionId.current === sessionId) setProjectRecord(savedProject)
      writeJdSearchProject(savedProject)
      if (activeSessionId.current === sessionId) setFileStatus(`典型工作任务报告已保存：${paths.report} · ${paths.htmlReport}`)
      if (activeSessionId.current === sessionId) setStep(4)
    } catch (reason) {
      if (activeSessionId.current === sessionId) {
        setError(reason instanceof Error ? reason.message : '任务分析失败')
        if (readJdSearchProject(sessionId)?.analysis !== undefined) setStep(4)
      }
    } finally { if (activeSessionId.current === sessionId) setBusy(false) }
  }
  const finalize = async (): Promise<void> => {
    const sessionId = String(props.sessionId)
    const session = props.sessionId
    const current = readJdSearchProject(sessionId) ?? (projectRecord?.sessionId === sessionId ? projectRecord : undefined)
    if (current?.analysis === undefined) {
      setFinalizeStatus('缺少已生成的任务分析，无法冻结项目。')
      return
    }
    setFinalizing(true)
    setFinalizeStatus('')
    const paths = jdSearchProjectPaths(sessionId)
    const reportProject = { ...current, reportPath: paths.report, htmlReportPath: paths.htmlReport, updatedAt: new Date().toISOString() }
    try {
      await props.saveJdSearchArtifacts(session, [
        { path: paths.report, contents: buildJdSearchReport(reportProject) },
        { path: paths.htmlReport, contents: buildJdSearchHtmlReport(reportProject) },
      ])
      const finalizedAt = new Date().toISOString()
      const frozenProject = { ...reportProject, reportSavedAt: finalizedAt, finalizedAt, updatedAt: finalizedAt }
      if (activeSessionId.current === sessionId) setProjectRecord(frozenProject)
      writeJdSearchProject(frozenProject)
      if (activeSessionId.current === sessionId) setFinalizeStatus('Markdown 与 HTML 报告已写入工作区，项目已冻结。')
    } catch (reason) {
      if (activeSessionId.current === sessionId) setFinalizeStatus(`冻结失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      if (activeSessionId.current === sessionId) setFinalizing(false)
    }
  }
  useEffect(() => { const reset = (): void => { setProjectKey(current => current + 1); setStep(1); setTarget({ major: '', direction: '', roles: [] }); setJobs([]); setAnalysis({ tasks: [], abilities: [] }); setError(undefined); setFileStatus(''); setFinalizeStatus(''); setFinalizing(false) }; window.addEventListener('jd-search-new', reset); return () => window.removeEventListener('jd-search-new', reset) }, [])
  const savedProject = projectRecord?.sessionId === String(props.sessionId) ? projectRecord : readJdSearchProject(String(props.sessionId))
  const canOpenStep = (candidate: number): boolean => {
    if (busy || finalizing) return false
    if (candidate === 1) return true
    if (candidate === 2) return target.major.trim() !== '' && target.roles.length > 0
    if (candidate === 3) return jobs.length > 0
    if (candidate === 4) return analysis.tasks.length > 0
    return analysis.abilities.length > 0
  }
  return <div className={css.workbench}><header className={css.header}><div><span className={css.kicker}>岗位研究工作台</span><h1>JD 搜索</h1><p>从真实岗位描述中提取典型工作任务，形成专业能力参考。</p></div><Pill>AGENT WORKFLOW</Pill></header><div className={css.progress}>{STEPS.map((item, index) => { const candidate = index + 1; const enabled = canOpenStep(candidate); return <button type="button" key={item} aria-current={candidate === step ? 'step' : undefined} disabled={!enabled || candidate === step} className={candidate === step ? css.progressActive : css.progressButton} onClick={() => setStep(candidate)}><span>{candidate}</span>{item}</button> })}</div><main className={css.content}>{step === 1 && <Target key={projectKey} initialTarget={target} infer={(major, direction) => props.inferJdRoles(props.sessionId, major, direction)} next={(major, direction, roles) => { setTarget({ major, direction, roles }); setStep(2) }} />}{step === 2 && <Platforms key={String(props.sessionId)} busy={busy} error={error} initialRequest={savedProject?.request} next={(platforms, range) => { void search(platforms, range) }} />}{step === 3 && <Results key={String(props.sessionId)} jobs={jobs} busy={busy} confirmedJobIds={savedProject?.confirmedJobIds} excludedJobIds={savedProject?.excludedJobIds} fileStatus={fileStatus} onExcludedChange={(excludedJobIds) => {
    const current = projectRecord?.sessionId === String(props.sessionId) ? projectRecord : readJdSearchProject(String(props.sessionId))
    if (current === undefined) return
    const nextProject = { ...current, excludedJobIds, updatedAt: new Date().toISOString() }
    delete nextProject.confirmedJobIds
    delete nextProject.analysis
    delete nextProject.reportPath
    delete nextProject.htmlReportPath
    delete nextProject.reportSavedAt
    delete nextProject.finalizedAt
    setProjectRecord(nextProject)
    writeJdSearchProject(nextProject)
    setAnalysis({ tasks: [], abilities: [] })
    setStep(3)
  }} next={(confirmed) => { void analyze(confirmed) }} />}{step === 4 && <Tasks key={String(props.sessionId)} tasks={analysis.tasks} next={() => setStep(5)} reportPath={savedProject?.reportPath} htmlReportPath={savedProject?.htmlReportPath} reportSaved={savedProject?.reportSavedAt !== undefined} openReport={() => props.openJdSearchReport(props.sessionId, savedProject?.htmlReportPath ?? '')} saveStatus={fileStatus} />}{step === 5 && <Abilities abilities={analysis.abilities} save={() => { void finalize() }} saving={finalizing} finalizedAt={savedProject?.finalizedAt} status={finalizeStatus} />}{fileStatus !== '' && step !== 3 && step !== 4 && <div className={css.notice}>{fileStatus}</div>}{error !== undefined && step !== 2 && <div className={css.loginNotice}>{error}</div>}</main></div>
}
