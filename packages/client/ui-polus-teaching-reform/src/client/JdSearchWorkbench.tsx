import { useEffect, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { JdSearchRequest, TeachingReformProps } from './types.ts'
import css from './JdSearchWorkbench.module.css'
import type { JdGraph, JdProject, JdProjectSummary, JdSource } from '../jd/types.ts'
import { frequency, graphNodes, projectId, sourceUrl } from '../jd/document.ts'
import { downloadJd, exportJdPdf, jdHash, openJdBrowser, readJdBrowser } from './jdNative.ts'

const STEPS = ['搜索目标', '平台与范围', '原文与登录采集', '五级能力图谱', '导出成果']
const PLATFORMS = ['公开网页', '58 同城', 'BOSS 直聘', '智联招聘', '前程无忧 51job', '鱼泡直聘', '四川高校人才网']

/** Render the JD mode entry for creating a separate host-backed search session.
 * @param props - Sidebar width and the session creation action.
 * @returns The JD sidebar.
 */
export function JdSearchSidebar({
  wide,
  createJdSearchSession,
}: PropsRuntime<'sidebar.workspaces'> & { createJdSearchSession: () => Promise<void> }): ReactNode {
  return (
    <aside className={css.sidebar}>
      {wide ? (
        <>
          <div className={css.sidebarTitle}>JD 搜索</div>
          <button
            className={css.newButton}
            type="button"
            onClick={() => {
              void createJdSearchSession()
            }}
          >
            ＋ 新建搜索
          </button>
          <div className={css.sidebarHint}>搜索项目</div>
          <div className={css.emptyHistory}>已保存项目可在工作台顶部打开</div>
        </>
      ) : (
        <div className={css.sidebarMini}>
          JD
          <br />搜<br />索
        </div>
      )}
    </aside>
  )
}
function Header({ step, title, text }: { step: number; title: string; text: string }): ReactNode {
  return (
    <div className={css.sectionIntro}>
      <span className={css.eyebrow}>STEP 0{step}</span>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  )
}
function Pill({ children }: { children: ReactNode }): ReactNode {
  return <span className={css.pill}>{children}</span>
}

function Target({
  infer,
  next,
}: {
  infer: (major: string, direction: string) => Promise<readonly string[]>
  next: (major: string, direction: string, roles: string[]) => void
}): ReactNode {
  const [major, setMajor] = useState('')
  const [direction, setDirection] = useState('')
  const [roleText, setRoleText] = useState('')
  const [inferring, setInferring] = useState(false)
  const [inferenceMessage, setInferenceMessage] = useState('')
  const roles = roleText
    .split('、')
    .map(role => role.trim())
    .filter(Boolean)
  const inferRoles = async (): Promise<void> => {
    if (major.trim() === '') return
    setInferring(true)
    setInferenceMessage('正在根据专业推理岗位名称…')
    try {
      const inferred = await infer(major.trim(), direction.trim())
      setRoleText(inferred.join('、'))
      setInferenceMessage(
        inferred.length > 0 ? `已生成 ${inferred.length} 个岗位建议，可继续编辑。` : '未生成岗位建议，请手动填写。',
      )
    } catch (reason) {
      setInferenceMessage(reason instanceof Error ? `推理失败：${reason.message}` : '推理失败，请手动填写岗位。')
    } finally {
      setInferring(false)
    }
  }
  return (
    <>
      <Header
        step={1}
        title="从学科专业推理实际岗位"
        text="输入学科专业后由 LLM 推理常见岗位名称，也可以手动修改岗位列表。公开网页搜索使用 DSH 原生 web_search 和 web_fetch。"
      />
      <div className={css.card}>
        <label className={css.label}>学科 / 专业</label>
        <input
          className={css.input}
          value={major}
          onChange={(event) => {
            setMajor(event.target.value)
          }}
        />
        <label className={css.label}>专业方向（可选）</label>
        <textarea
          className={css.textarea}
          value={direction}
          onChange={(event) => {
            setDirection(event.target.value)
          }}
        />
        <div className={css.rowBetween}>
          <label className={css.label}>岗位名称（可手动修改，使用顿号分隔）</label>
          <button
            className={css.infoButton}
            type="button"
            aria-label="推理岗位名称"
            title="根据学科专业推理岗位名称"
            disabled={inferring || major.trim() === ''}
            onClick={() => {
              void inferRoles()
            }}
          >
            <span>i</span>
            <span>推理岗位名称</span>
          </button>
        </div>
        <input
          className={css.input}
          value={roleText}
          onChange={(event) => {
            setRoleText(event.target.value)
          }}
        />
        {inferenceMessage === '' ? null : <div className={css.inferenceMessage}>{inferenceMessage}</div>}
      </div>
      <div className={css.footer}>
        <span className={css.muted}>可直接使用 DSH 公开网页搜索</span>
        <button
          className={css.primaryButton}
          type="button"
          disabled={roles.length === 0}
          onClick={() => {
            next(major, direction, roles)
          }}
        >
          确认岗位并继续
        </button>
      </div>
    </>
  )
}
function Platforms({
  busy,
  error,
  next,
  initial,
}: {
  busy: boolean
  error: string | undefined
  initial: JdProject | null
  next: (platforms: string[], range: Omit<JdSearchRequest, 'major' | 'direction' | 'roles' | 'platforms'>) => void
}): ReactNode {
  const [selected, setSelected] = useState(
    initial?.platforms.length ? initial.platforms : PLATFORMS.filter(platform => platform !== '鱼泡直聘'),
  )
  return (
    <>
      <Header
        step={2}
        title="选择平台与搜索范围"
        text="覆盖基础岗位和一线技能岗位；LinkedIn 不纳入首版。需要登录的平台会提示浏览器登录。"
      />
      <div className={css.platformGrid}>
        {PLATFORMS.map(platform => (
          <button
            className={selected.includes(platform) ? css.platformActive : css.platform}
            type="button"
            key={platform}
            aria-pressed={selected.includes(platform)}
            onClick={() => {
              setSelected(current =>
                current.includes(platform) ? current.filter(item => item !== platform) : [...current, platform],
              )
            }}
          >
            <b>{platform}</b>
            <small>
              {platform === '公开网页' || platform === '四川高校人才网' ? 'web search / fetch' : '可能需要浏览器登录'}
            </small>
          </button>
        ))}
      </div>
      <div className={css.card}>
        <label className={css.label}>
          区域范围
          <select id="jd-region" className={css.input} defaultValue={initial?.region}>
            <option>四川及西南地区</option>
            <option>成渝经济圈</option>
            <option>全国重点城市</option>
          </select>
        </label>
        <label className={css.label}>
          发布时间
          <select id="jd-published" className={css.input} defaultValue={initial?.published_within}>
            <option>最近 30 天</option>
            <option>最近 90 天</option>
            <option>最近一年</option>
          </select>
        </label>
        <label className={css.label}>
          目标条数
          <select id="jd-count" className={css.input} defaultValue={initial?.target_count}>
            <option>5 条（测试）</option>
            <option>20-50 条</option>
            <option>50-100 条</option>
          </select>
        </label>
      </div>
      {error === undefined ? (
        <div className={css.notice}>使用公开搜索与网页抓取；无法匿名读取的岗位会保留为待采集来源，可登录后继续采集。</div>
      ) : (
        <div className={css.loginNotice}>{error}</div>
      )}
      <div className={css.footer}>
        <button
          className={css.primaryButton}
          type="button"
          disabled={busy || selected.length === 0}
          onClick={() => {
            const read = (id: string): string => (document.getElementById(id) as HTMLSelectElement).value
            next(selected, {
              region: read('jd-region'),
              publishedWithin: read('jd-published'),
              targetCount: read('jd-count'),
            })
          }}
        >
          {busy ? '正在检索…' : '开始检索'}
        </button>
      </div>
    </>
  )
}

/** Persisted JD evidence and five-level graphs, scoped to the owning Host conversation.
 * @param props - Framework session and injected research operations.
 * @returns The complete research workflow.
 */
export function JdSearchWorkbench(props: TeachingReformProps): ReactNode {
  const [step, setStep] = useState(1)
  const [project, setProject] = useState<JdProject | null>(null)
  const [history, setHistory] = useState<JdProjectSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState('')
  const [url, setUrl] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [company, setCompany] = useState('未披露')
  const [body, setBody] = useState('')
  const [fileName, setFileName] = useState('')
  const [version, setVersion] = useState<number>()
  const graph = project?.graphs.find(item => item.version === version) ?? project?.graphs.at(-1)
  const retained = project?.sources.filter(source => !source.excluded) ?? []

  useEffect(() => {
    let active = true
    void props
      .listJdProjects()
      .then(async (items) => {
        const current = items.find(item => item.session_id === String(props.sessionId))
        const saved = current ? await props.loadJdProject(current.id) : null
        if (!active) return
        setHistory(items)
        setProject(saved)
        setStep(saved ? (saved.graphs.length ? 4 : saved.sources.length ? 3 : 2) : 1)
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '项目恢复失败')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [props.sessionId])

  const run = (operation: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setNotice('')
    void operation()
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '操作失败')
      })
      .finally(() => {
        setBusy(false)
      })
  }
  const save = async (next: JdProject): Promise<JdProject> => {
    const saved = await props.saveJdProject(next)
    setProject(saved)
    setHistory(items => [
      {
        id: saved.id,
        session_id: saved.session_id,
        title: saved.title,
        revision: saved.revision,
        updated_at: saved.updated_at,
      },
      ...items.filter(item => item.id !== saved.id),
    ])
    return saved
  }
  const start = (major: string, direction: string, roles: string[]): void => {
    run(async () => {
      await save({
        format_version: 1,
        id: projectId(crypto.randomUUID()),
        session_id: props.sessionId,
        revision: 0,
        title: `${major}岗位研究`,
        major,
        direction,
        roles,
        platforms: [],
        region: '四川及西南地区',
        published_within: '最近 90 天',
        target_count: '5 条（测试）',
        updated_at: new Date().toISOString(),
        sources: [],
        pending_sources: [],
        graphs: [],
      })
      setStep(2)
    })
  }
  const search = (
    platforms: string[],
    range: Omit<JdSearchRequest, 'major' | 'direction' | 'roles' | 'platforms'>,
  ): void => {
    run(async () => {
      if (!project) throw new Error('请先填写搜索目标')
      const current = await save({
        ...project,
        platforms,
        region: range.region,
        published_within: range.publishedWithin,
        target_count: range.targetCount,
      })
      const jobs = await props.runJdSearch(props.sessionId, {
        major: current.major,
        direction: current.direction,
        roles: current.roles,
        platforms,
        ...range,
      })
      const sources = current.sources.map(source => ({ ...source }))
      for (const job of jobs) {
        if (!job.body || !job.sourceUrl || !job.capturedAt) continue
        const content_hash = await jdHash(job.body)
        if (sources.some(source => source.content_hash === content_hash)) continue
        for (const source of sources) if (source.source_url === sourceUrl(job.sourceUrl)) source.excluded = true
        sources.push({
          id: `JD-${crypto.randomUUID()}`,
          title: job.title,
          company: job.company,
          place: job.place,
          platform: job.platform,
          source_url: sourceUrl(job.sourceUrl),
          body: job.body,
          captured_at: job.capturedAt,
          content_hash,
          acquisition: 'http',
          excluded: false,
        })
      }
      await save({ ...current, sources, pending_sources: props.pendingJdSources?.(props.sessionId) ?? [] })
      setStep(3)
    })
  }
  const appendSource = async (source: Omit<JdSource, 'id' | 'excluded'>): Promise<void> => {
    if (!project) throw new Error('请先填写搜索目标')
    if (project.sources.some(item => item.content_hash === source.content_hash))
      throw new Error('该 JD 原文已保存，未重复计入样本')
    await save({
      ...project,
      sources: [
        ...project.sources.map(item => (item.source_url === source.source_url ? { ...item, excluded: true } : item)),
        { ...source, id: `JD-${crypto.randomUUID()}`, excluded: false },
      ],
      pending_sources: project.pending_sources.filter(item => item.url !== source.source_url),
    })
    setBody('')
    setFileName('')
    setNotice('JD 原文和来源已保存。')
  }
  const beginCapture = (): void => {
    run(async () => {
      sourceUrl(url)
      if (!project) throw new Error('请先填写搜索目标')
      await openJdBrowser(project.id, url)
      setNotice('请在采集窗口登录并打开具体岗位；完成后点击“登录后继续采集”。')
    })
  }
  const continueCapture = (): void => {
    run(async () => {
      if (!project) throw new Error('请先填写搜索目标')
      const result = await readJdBrowser(project.id)
      await appendSource({
        title: jobTitle.trim() || result.title,
        company,
        place: '未独立核验',
        platform: new URL(result.url).hostname,
        source_url: sourceUrl(result.url),
        body: result.body,
        captured_at: result.captured_at,
        content_hash: result.content_hash,
        acquisition: 'browser',
      })
    })
  }
  const importSource = (): void => {
    run(async () => {
      if (!body.trim() || !jobTitle.trim()) throw new Error('请填写岗位名称和完整 JD 原文')
      if (!/岗位职责|工作职责|职位描述|任职要求|职位要求|工作内容|职责描述|job description|responsibilit/iu.test(body))
        throw new Error('原文未包含岗位职责，请检查是否误贴了登录页或搜索摘要')
      await appendSource({
        title: jobTitle,
        company,
        place: '用户提供，未独立核验',
        platform: new URL(sourceUrl(url)).hostname,
        source_url: sourceUrl(url),
        body,
        captured_at: new Date().toISOString(),
        content_hash: await jdHash(body),
        acquisition: 'manual',
      })
    })
  }
  const generate = (): void => {
    run(async () => {
      if (!project || retained.length === 0) throw new Error('请至少保留一份 JD 原文')
      const current = await save(project)
      const nodes = graphNodes(await props.generateJdGraph(props.sessionId, current), current.sources)
      const next: JdGraph = {
        version: current.graphs.length + 1,
        generated_at: new Date().toISOString(),
        source_hashes: Object.fromEntries(
          current.sources.filter(source => !source.excluded).map(source => [source.id, source.content_hash]),
        ),
        nodes,
      }
      await save({ ...current, graphs: [...current.graphs, next] })
      setVersion(next.version)
      setStep(4)
    })
  }
  const exportGraph = (kind: 'md' | 'pdf'): void => {
    run(async () => {
      if (!project || !graph) throw new Error('请先生成并保存图谱')
      const output = await props.exportJdProject(project.id, graph.version)
      const filename = `${project.major.replace(/[<>:"/\\|?*]/g, '_')}-岗位能力图谱-v${graph.version}`
      if (kind === 'md') downloadJd(filename + '.md', output.markdown, 'text/markdown;charset=utf-8')
      else await exportJdPdf(filename + '.pdf', output.html)
      setNotice('已导出所选图谱版本；两种格式使用同一份保存数据。')
    })
  }
  if (loading) return <div className={css.notice}>正在恢复已保存的 JD 项目…</div>
  return (
    <div className={css.workbench}>
      <header className={css.header}>
        <div>
          <span className={css.kicker}>岗位研究工作台</span>
          <h1>JD 搜索与岗位能力图谱</h1>
          <p>保留原文证据，标记推断，生成同源 MD / PDF 成果。</p>
        </div>
      </header>
      <main className={css.content}>
        <label className={css.label}>
          打开已保存项目
          <select
            className={css.input}
            aria-label="打开已保存项目"
            value={project?.id ?? ''}
            disabled={busy}
            onChange={(event) => {
              const selected = history.find(item => item.id === event.target.value)
              if (selected) props.openJdProject(selected.session_id)
            }}
          >
            <option value="">选择搜索项目</option>
            {history.map(item => (
              <option key={item.id} value={item.id}>
                {item.title} · {new Date(item.updated_at).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        {project && (
          <p className={css.muted}>
            已保存 · 修订 {project.revision} · {project.sources.length} 份原文 · {project.graphs.length} 个图谱版本
          </p>
        )}
        {error && (
          <div className={css.loginNotice} role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className={css.notice} role="status">
            {notice}
          </div>
        )}
        <nav className={css.progress} aria-label="研究步骤">
          {STEPS.map((label, index) => (
            <button
              type="button"
              key={label}
              disabled={busy || !project || index === 0 || (index >= 3 && !graph)}
              className={step === index + 1 ? css.progressActive : css.progressButton}
              onClick={() => {
                setStep(index + 1)
              }}
            >
              {index + 1} {label}
            </button>
          ))}
        </nav>
        {step === 1 && (
          <Target infer={(major, direction) => props.inferJdRoles(props.sessionId, major, direction)} next={start} />
        )}
        {step === 2 && (
          <>
            <Platforms busy={busy} error={undefined} next={search} initial={project} />
            <button
              className={css.infoButton}
              type="button"
              disabled={busy}
              onClick={() => {
                setStep(3)
              }}
            >
              直接登录采集或导入原文
            </button>
          </>
        )}
        {step === 3 && project && (
          <>
            <Header
              step={3}
              title="JD 原文与来源"
              text="登录页和搜索摘要不算岗位原文。采集范围是检索条件，发布日期和地域仍需核验；手工导入内容的来源由上传者声明。"
            />
            {project.pending_sources.map(item => (
              <article key={item.url} className={css.card}>
                <strong>{item.title}</strong>
                <p>{item.reason}</p>
                <button
                  type="button"
                  className={css.infoButton}
                  onClick={() => {
                    setUrl(item.url)
                    setJobTitle(item.title)
                  }}
                >
                  选为登录采集来源
                </button>
                <p className={css.muted}>{item.url}</p>
              </article>
            ))}
            <section className={css.card} aria-label="采集或导入 JD">
              <label className={css.label}>
                来源 URL
                <input
                  className={css.input}
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value)
                  }}
                />
              </label>
              <label className={css.label}>
                岗位名称
                <input
                  className={css.input}
                  value={jobTitle}
                  onChange={(event) => {
                    setJobTitle(event.target.value)
                  }}
                />
              </label>
              <label className={css.label}>
                企业（可填未披露）
                <input
                  className={css.input}
                  value={company}
                  onChange={(event) => {
                    setCompany(event.target.value)
                  }}
                />
              </label>
              <div className={css.footer}>
                <button type="button" className={css.infoButton} disabled={busy || !url} onClick={beginCapture}>
                  打开登录采集窗口
                </button>
                <button type="button" className={css.primaryButton} disabled={busy || !project} onClick={continueCapture}>
                  登录后继续采集
                </button>
              </div>
              <label className={css.label}>
                导入 JD 原文
                <textarea
                  className={css.textarea}
                  value={body}
                  onChange={(event) => {
                    setBody(event.target.value)
                  }}
                  placeholder="粘贴完整岗位职责和任职要求；不接受搜索摘要"
                />
              </label>
              <div className={css.fileUpload}>
                <label className={css.filePicker}>
                  <input
                    className={css.fileInput}
                    type="file"
                    aria-label="读取原文文件"
                    aria-describedby="jd-file-feedback"
                    accept=".txt,.md,text/plain,text/markdown"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file)
                        run(async () => {
                          if (file.size > 1000000) throw new Error('原文文件超过 1 MB')
                          setBody(await file.text())
                          setFileName(file.name)
                        })
                      event.target.value = ''
                    }}
                  />
                  <span className={css.filePickerButton}>选择原文文件</span>
                </label>
                <span id="jd-file-feedback" className={css.fileHint} role="status">
                  {fileName ? `已读取：${fileName}` : '支持 .txt / .md，最大 1 MB'}
                </span>
              </div>
              <button type="button" className={css.infoButton} disabled={busy || !body.trim()} onClick={importSource}>
                保存导入原文（用户声明来源）
              </button>
            </section>
            {project.sources.length === 0 && (
              <div className={css.notice}>尚无已保存原文，可调整搜索范围、登录采集或导入正文。</div>
            )}
            {project.sources.map(source => (
              <article className={css.card} key={source.id}>
                <h3>
                  {source.title} {source.excluded ? '（已剔除）' : ''}
                </h3>
                <p>
                  {source.company} · {source.platform} ·{' '}
                  {source.acquisition === 'manual'
                    ? '用户提供，未独立联网核验'
                    : source.acquisition === 'browser'
                      ? '浏览器已读取'
                      : '公开 HTTP 已读取'}
                </p>
                <a href={source.source_url} target="_blank" rel="noopener noreferrer">
                  原始来源
                </a>
                <p className={css.muted}>
                  {source.captured_at} · SHA-256：{source.content_hash}
                </p>
                <details>
                  <summary>查看完整原文和证据编号</summary>
                  <p>{source.id}</p>
                  <pre className={css.sourceBody}>{source.body}</pre>
                </details>
                <button
                  type="button"
                  className={css.infoButton}
                  disabled={busy}
                  onClick={() => {
                    run(async () => {
                      await save({
                        ...project,
                        sources: project.sources.map(item =>
                          item.id === source.id
                            ? { ...item, excluded: !item.excluded }
                            : source.excluded && item.source_url === source.source_url
                              ? { ...item, excluded: true }
                              : item,
                        ),
                      })
                    })
                  }}
                >
                  {source.excluded ? '恢复原文' : '剔除原文'}
                </button>
              </article>
            ))}
            <div className={css.footer}>
              <button
                className={css.infoButton}
                type="button"
                disabled={busy}
                onClick={() => {
                  setStep(2)
                }}
              >
                调整搜索范围
              </button>
              <button
                className={css.primaryButton}
                type="button"
                disabled={busy || retained.length === 0}
                onClick={generate}
              >
                {busy ? '正在处理…' : `使用 ${retained.length} 份原文生成五级图谱`}
              </button>
            </div>
          </>
        )}
        {(step === 4 || step === 5) && project && graph && (
          <>
            <Header
              step={step}
              title={step === 4 ? '五级岗位能力图谱' : '导出岗位能力图谱'}
              text="初稿待专家评审。原文直接陈述与推断分开标记；样本引用频率不代表市场总体需求。"
            />
            <label className={css.label}>
              图谱版本
              <select
                className={css.input}
                value={graph.version}
                onChange={(event) => {
                  setVersion(Number(event.target.value))
                }}
              >
                {project.graphs.map(item => (
                  <option key={item.version} value={item.version}>
                    v{item.version} · {item.generated_at}
                  </option>
                ))}
              </select>
            </label>
            <div className={css.actionBar}>
              <div className={css.actionGroup}>
                <button
                  className={css.infoButton}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setStep(3)
                  }}
                >
                  补充或筛选原文
                </button>
                <button className={css.infoButton} type="button" disabled={busy} onClick={generate}>
                  生成新版本
                </button>
              </div>
              <div className={css.actionGroup}>
                <button
                  className={css.primaryButton}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    exportGraph('md')
                  }}
                >
                  下载 AI 版 MD
                </button>
                <button
                  className={css.primaryButton}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    exportGraph('pdf')
                  }}
                >
                  导出阅读版 PDF
                </button>
              </div>
            </div>
            {graph.nodes.map(node => (
              <article
                className={css.card}
                key={node.id}
                data-basis={node.basis}
                style={{ marginInlineStart: ['project', 'task', 'process', 'skill', 'knowledge'].indexOf(node.kind) * 10 }}
              >
                <p className={css.muted}>
                  {node.id} · 父节点 {node.parent_id ?? '无'} ·{' '}
                  {
                    ({ project: '项目', task: '任务', process: '流程', skill: '技能点', knowledge: '知识点' } as const)[
                      node.kind
                    ]
                  }
                </p>
                <h3>
                  {node.title} <Pill>{node.basis === 'direct' ? '原文直接陈述' : '推断 · 待专家核实'}</Pill>
                </h3>
                <p>{node.description}</p>
                <small>{frequency(node, graph)}</small>
                {node.assessment && <p>评价建议（推断）：{node.assessment}</p>}
                {node.evidence.map((entry, index) => {
                  const source = project.sources.find(item => item.id === entry.jd_id)
                  return (
                    <details key={index}>
                      <summary>原文依据 · {source?.title ?? entry.jd_id}</summary>
                      <blockquote>{entry.quote}</blockquote>
                      <p>{entry.jd_id}</p>
                      <a href={source?.source_url} target="_blank" rel="noopener noreferrer">
                        查看来源
                      </a>
                    </details>
                  )
                })}
              </article>
            ))}
          </>
        )}
      </main>
    </div>
  )
}
