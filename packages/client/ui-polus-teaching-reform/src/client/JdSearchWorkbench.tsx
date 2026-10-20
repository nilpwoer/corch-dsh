import { useEffect, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { JdSearchAbility, JdSearchAnalysis, JdSearchJob, JdSearchRequest, JdSearchTask, TeachingReformProps } from './types.ts'
import css from './JdSearchWorkbench.module.css'

const STEPS = ['搜索目标', '平台与范围', 'JD 结果筛选', '典型工作任务', '能力标签']
const PLATFORMS = ['公开网页', '58 同城', 'BOSS 直聘', '智联招聘', '前程无忧 51job', '鱼泡直聘', '四川高校人才网']

/** Render the JD mode entry for creating a separate host-backed search session.
 * @param props - Sidebar width and the session creation action.
 * @returns The JD sidebar.
 */
export function JdSearchSidebar({ wide, createJdSearchSession }: PropsRuntime<'sidebar.workspaces'> & { createJdSearchSession: () => Promise<void> }): ReactNode {
  return <aside className={css.sidebar}>{wide ? <><div className={css.sidebarTitle}>JD 搜索</div><button className={css.newButton} type="button" onClick={() => { void createJdSearchSession() }}>＋ 新建搜索</button><div className={css.sidebarHint}>搜索项目</div><div className={css.emptyHistory}>暂无已保存的搜索项目</div></> : <div className={css.sidebarMini}>JD<br />搜<br />索</div>}</aside>
}
function Header({ step, title, text }: { step: number; title: string; text: string }): ReactNode {
  return <div className={css.sectionIntro}><span className={css.eyebrow}>STEP 0{step}</span><h2>{title}</h2><p>{text}</p></div>
}
function Pill({ children }: { children: ReactNode }): ReactNode { return <span className={css.pill}>{children}</span> }

function Target({ infer, next }: {
  infer: (major: string, direction: string) => Promise<readonly string[]>
  next: (major: string, direction: string, roles: string[]) => void
}): ReactNode {
  const [major, setMajor] = useState('')
  const [direction, setDirection] = useState('')
  const [roleText, setRoleText] = useState('')
  const [inferring, setInferring] = useState(false)
  const [inferenceMessage, setInferenceMessage] = useState('')
  const roles = roleText.split('、').map(role => role.trim()).filter(Boolean)
  const inferRoles = async (): Promise<void> => { if (major.trim() === '') return; setInferring(true); setInferenceMessage('正在根据专业推理岗位名称…'); try { const inferred = await infer(major.trim(), direction.trim()); setRoleText(inferred.join('、')); setInferenceMessage(inferred.length > 0 ? `已生成 ${inferred.length} 个岗位建议，可继续编辑。` : '未生成岗位建议，请手动填写。') } catch (reason) { setInferenceMessage(reason instanceof Error ? `推理失败：${reason.message}` : '推理失败，请手动填写岗位。') } finally { setInferring(false) } }
  return <><Header step={1} title="从学科专业推理实际岗位" text="输入学科专业后由 LLM 推理常见岗位名称，也可以手动修改岗位列表。公开网页搜索使用 DSH 原生 web_search 和 web_fetch。" /><div className={css.card}><label className={css.label}>学科 / 专业</label><input className={css.input} value={major} onChange={event => setMajor(event.target.value)} /><label className={css.label}>专业方向（可选）</label><textarea className={css.textarea} value={direction} onChange={event => setDirection(event.target.value)} /><div className={css.rowBetween}><label className={css.label}>岗位名称（可手动修改，使用顿号分隔）</label><button className={css.infoButton} type="button" aria-label="推理岗位名称" title="根据学科专业推理岗位名称" disabled={inferring || major.trim() === ''} onClick={() => { void inferRoles() }}><span>i</span><span>推理岗位名称</span></button></div><input className={css.input} value={roleText} onChange={event => setRoleText(event.target.value)} />{inferenceMessage === '' ? null : <div className={css.inferenceMessage}>{inferenceMessage}</div>}</div><div className={css.footer}><span className={css.muted}>可直接使用 DSH 公开网页搜索</span><button className={css.primaryButton} type="button" disabled={roles.length === 0} onClick={() => next(major, direction, roles)}>确认岗位并继续</button></div></>
}
function Platforms({ busy, error, next }: { busy: boolean; error: string | undefined; next: (platforms: string[], range: Omit<JdSearchRequest, 'major' | 'direction' | 'roles' | 'platforms'>) => void }): ReactNode {
  const [selected, setSelected] = useState(PLATFORMS.filter(platform => platform !== '鱼泡直聘'))
  return <><Header step={2} title="选择平台与搜索范围" text="覆盖基础岗位和一线技能岗位；LinkedIn 不纳入首版。需要登录的平台会提示浏览器登录。" /><div className={css.platformGrid}>{PLATFORMS.map(platform => <button className={selected.includes(platform) ? css.platformActive : css.platform} type="button" key={platform} aria-pressed={selected.includes(platform)} onClick={() => setSelected(current => current.includes(platform) ? current.filter(item => item !== platform) : [...current, platform])}><b>{platform}</b><small>{platform === '公开网页' || platform === '四川高校人才网' ? 'web search / fetch' : '可能需要浏览器登录'}</small></button>)}</div><div className={css.card}><label className={css.label}>区域范围<select id="jd-region" className={css.input} defaultValue="四川及西南地区"><option>四川及西南地区</option><option>成渝经济圈</option><option>全国重点城市</option></select></label><label className={css.label}>发布时间<select id="jd-published" className={css.input} defaultValue="最近 90 天"><option>最近 30 天</option><option>最近 90 天</option><option>最近一年</option></select></label><label className={css.label}>目标条数<select id="jd-count" className={css.input} defaultValue="5 条（测试）"><option>5 条（测试）</option><option>20-50 条</option><option>50-100 条</option></select></label></div>{error === undefined ? <div className={css.notice}>使用公开搜索与网页抓取；需要登录或无法读取正文的岗位会跳过。</div> : <div className={css.loginNotice}>{error}</div>}<div className={css.footer}><button className={css.primaryButton} type="button" disabled={busy || selected.length === 0} onClick={() => { const read = (id: string): string => (document.getElementById(id) as HTMLSelectElement).value; next(selected, { region: read('jd-region'), publishedWithin: read('jd-published'), targetCount: read('jd-count') }) }}>{busy ? '正在检索…' : '开始检索'}</button></div></>
}
function Results({ jobs, next, retry }: {
  jobs: readonly JdSearchJob[]
  next: (jobs: readonly JdSearchJob[]) => void
  retry: () => void
}): ReactNode {
  const [excluded, setExcluded] = useState<string[]>([])
  const visible = jobs.filter(job => !excluded.includes(job.id))
  return <><Header step={3} title="筛选和确认岗位 JD" text="正文已清洗、跨平台去重。剔除只影响本次分析，之后仍可取消剔除。" />{jobs.length === 0 && <div role='status' className={css.notice}><p>未找到符合条件的公开岗位，请调整岗位名称、区域或发布时间后重试。</p><button type='button' className={css.infoButton} onClick={retry}>调整搜索范围</button></div>}<div className={css.resultList}>{jobs.map((job) => { const isExcluded = excluded.includes(job.id); return <article className={isExcluded ? css.resultCardExcluded : css.resultCard} key={job.id}><div className={css.resultHead}><div><span className={css.resultId}>{job.id}</span><h3>{job.title}</h3><p>{job.company} · {job.place}</p></div><Pill>{job.score}% 相关</Pill></div><p className={css.resultSummary}>{job.summary}</p><div className={css.resultMeta}><span>{job.platform}</span>{job.sourceUrl !== undefined && /^https?:\/\//i.test(job.sourceUrl) && <a href={job.sourceUrl} target='_blank' rel='noopener noreferrer'>查看原始 JD</a>}<button type="button" className={isExcluded ? css.restoreButton : css.excludeButton} onClick={() => setExcluded(current => isExcluded ? current.filter(item => item !== job.id) : [...current, job.id])}>{isExcluded ? '取消剔除' : '剔除'}</button></div></article> })}</div><div className={css.footer}><span className={css.muted}>已剔除 {excluded.length} 条 · 可随时取消</span><button className={css.primaryButton} type="button" disabled={visible.length === 0} onClick={() => next(visible)}>确认 {visible.length} 条并生成任务</button></div></>
}
function Tasks({ tasks, next }: { tasks: readonly JdSearchTask[]; next: () => void }): ReactNode { return <><Header step={4} title="典型工作任务" text="根据已确认 JD 聚类生成任务草案。" /><div className={css.taskList}>{tasks.map((task, index) => <article className={css.taskCard} key={task.title}><div className={css.taskNumber}>0{index + 1}</div><div><h3>{task.title}</h3><p>{task.description}</p><small>证据：{task.evidenceIds.join('、')}</small></div></article>)}</div><div className={css.footer}><button className={css.primaryButton} type="button" onClick={next}>确认任务并生成能力标签</button></div></> }
function Abilities({ abilities, save }: { abilities: readonly JdSearchAbility[]; save: () => void }): ReactNode { return <><Header step={5} title="专业能力标签" text="只映射到专业能力，不生成课程安排。" /><div className={css.abilityGrid}>{abilities.map(ability => <article className={css.abilityCard} key={ability.title}><Pill>{ability.level}</Pill><h3>{ability.title}</h3><p>关联 {ability.taskCount} 个典型工作任务 · 来源 {ability.sourceCount} 条 JD</p></article>)}</div><div className={css.summaryBox}><div><h3>本次搜索结果已确认</h3><p>保存搜索项目的持久化动作暂未启用。</p></div><button className={css.primaryButton} type="button" onClick={save}>保存搜索项目</button></div></> }

/** Render the session-scoped public JD search, confirmation and analysis flow.
 * @param props - The owning session and its model actions.
 * @returns The JD workbench.
 */
export function JdSearchWorkbench(props: TeachingReformProps): ReactNode {
  const [step, setStep] = useState(1)
  const [projectKey, setProjectKey] = useState(0)
  const [target, setTarget] = useState({ major: '', direction: '', roles: [] as string[] })
  const [jobs, setJobs] = useState<readonly JdSearchJob[]>([])
  const [analysis, setAnalysis] = useState<JdSearchAnalysis>({ tasks: [], abilities: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const search = async (platforms: string[], range: Omit<JdSearchRequest, 'major' | 'direction' | 'roles' | 'platforms'>): Promise<void> => { setBusy(true); setError(undefined); try { setJobs(await props.runJdSearch(props.sessionId, { ...target, platforms, ...range })); setStep(3) } catch (reason) { setError(reason instanceof Error ? reason.message : '搜索失败') } finally { setBusy(false) } }
  const analyze = async (confirmed: readonly JdSearchJob[]): Promise<void> => { setBusy(true); try { setAnalysis(await props.analyzeJdSearch(props.sessionId, confirmed)); setStep(4) } catch (reason) { setError(reason instanceof Error ? reason.message : '任务分析失败') } finally { setBusy(false) } }
  useEffect(() => { const reset = (): void => { setProjectKey(current => current + 1); setStep(1); setTarget({ major: '', direction: '', roles: [] }); setJobs([]); setAnalysis({ tasks: [], abilities: [] }); setError(undefined) }; window.addEventListener('jd-search-new', reset); return () => window.removeEventListener('jd-search-new', reset) }, [])
  return <div className={css.workbench}><header className={css.header}><div><span className={css.kicker}>岗位研究工作台</span><h1>JD 搜索</h1><p>从真实岗位描述中提取典型工作任务，形成专业能力参考。</p></div><Pill>AGENT WORKFLOW</Pill></header><div className={css.progress}>{STEPS.map((item, index) => <button type="button" key={item} className={index + 1 === step ? css.progressActive : css.progressButton} onClick={() => { if (index + 1 <= step) setStep(index + 1) }}><span>{index + 1}</span>{item}</button>)}</div><main className={css.content}>{step === 1 && <Target key={projectKey} infer={(major, direction) => props.inferJdRoles(props.sessionId, major, direction)} next={(major, direction, roles) => { setTarget({ major, direction, roles }); setStep(2) }} />}{step === 2 && <Platforms busy={busy} error={error} next={(platforms, range) => { void search(platforms, range) }} />}{step === 3 && <Results jobs={jobs} retry={() => setStep(2)} next={(confirmed) => { void analyze(confirmed) }} />}{step === 4 && <Tasks tasks={analysis.tasks} next={() => setStep(5)} />}{step === 5 && <Abilities abilities={analysis.abilities} save={() => setError('内容已确认；保存搜索项目的持久化动作暂未启用。')} />}{error !== undefined && step !== 2 && <div className={css.loginNotice}>{error}</div>}</main></div>
}
