import { useEffect, useMemo, useState, type ReactNode } from 'react'
import css from './InterviewSettings.module.css'
import { hydrateCorpusDocuments, seedCorpusDocuments } from './globalReferenceCorpus.ts'
import { buildInterviewPromptTemplate, INTERVIEW_SYSTEM_PROMPT_STORAGE_KEY } from './interviewPrompt.ts'

/** The reusable methodology/reference layer shared by all interviews. */
export const GLOBAL_REFERENCE_STORAGE_KEY = 'dsh.practice-expert-global-reference-pool.v1'

export type { GlobalReferenceDocument } from './interviewTypes.ts'
import type { GlobalReferenceDocument } from './interviewTypes.ts'

export type InterviewSettingsProps = { onClose?: () => void; onPreviewDocument?: (document: GlobalReferenceDocument) => void }
type SettingsTab = 'references' | 'prompt' | 'followUp'

const UPDATED_EVENT = 'interview-global-reference-pool-updated'

function createId(): string {
  return `global-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function isDocument(value: unknown): value is GlobalReferenceDocument {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<GlobalReferenceDocument>
  return typeof item.id === 'string' && typeof item.title === 'string' && typeof item.markdown === 'string' && typeof item.version === 'number' && typeof item.updatedAt === 'string' && typeof item.enabled === 'boolean'
}

/** Read the shared document pool. Safe to call from the Agent integration. */
export function readGlobalReferenceDocuments(): GlobalReferenceDocument[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GLOBAL_REFERENCE_STORAGE_KEY) ?? '[]') as unknown
    const existing = Array.isArray(parsed) ? parsed.filter(isDocument) : []
    const seeded = seedCorpusDocuments(existing)
    if (seeded.length !== existing.length) window.localStorage.setItem(GLOBAL_REFERENCE_STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  } catch {
    return []
  }
}

/** Return active, non-archived documents in a stable order for generation. */
export function getEnabledGlobalReferenceDocuments(): GlobalReferenceDocument[] {
  return readGlobalReferenceDocuments().filter(item => item.enabled && item.archivedAt === undefined)
}

function writeGlobalReferenceDocuments(documents: readonly GlobalReferenceDocument[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(GLOBAL_REFERENCE_STORAGE_KEY, JSON.stringify(documents))
    window.dispatchEvent(new CustomEvent(UPDATED_EVENT))
  } catch {
    // Embedded/private browser contexts may reject storage; current state stays usable.
  }
}

export async function loadGlobalReferenceDocumentsForGeneration(): Promise<GlobalReferenceDocument[]> {
  return await hydrateCorpusDocuments(getEnabledGlobalReferenceDocuments())
}

export function InterviewSettings({ onClose, onPreviewDocument }: InterviewSettingsProps): ReactNode {
  const [documents, setDocuments] = useState<GlobalReferenceDocument[]>(() => readGlobalReferenceDocuments())
  const [activeTab, setActiveTab] = useState<SettingsTab>('references')
  const [showArchived, setShowArchived] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Pick<GlobalReferenceDocument, 'title' | 'markdown'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [promptPreview, setPromptPreview] = useState('')
  const [promptLoading, setPromptLoading] = useState(false)
  const [promptSaved, setPromptSaved] = useState(false)

  useEffect(() => {
    const refresh = (): void => setDocuments(readGlobalReferenceDocuments())
    window.addEventListener(UPDATED_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(UPDATED_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  useEffect(() => {
    setPromptLoading(false)
    try {
      setPromptPreview(window.localStorage.getItem(INTERVIEW_SYSTEM_PROMPT_STORAGE_KEY) ?? buildInterviewPromptTemplate())
    } catch {
      setPromptPreview(buildInterviewPromptTemplate())
    }
  }, [])

  const savePrompt = (): void => {
    const value = promptPreview.trim()
    if (!value) return
    try {
      window.localStorage.setItem(INTERVIEW_SYSTEM_PROMPT_STORAGE_KEY, value)
      setPromptSaved(true)
      window.setTimeout(() => setPromptSaved(false), 1800)
    } catch {
      setError('系统提示词保存失败，请检查浏览器存储权限。')
    }
  }

  const resetPrompt = (): void => {
    setPromptPreview(buildInterviewPromptTemplate())
    setPromptSaved(false)
  }

  const visibleDocuments = useMemo(() => documents.filter(item => showArchived || item.archivedAt === undefined), [documents, showArchived])
  const activeCount = documents.filter(item => item.enabled && item.archivedAt === undefined).length
  const groupedDocuments = useMemo(() => (['S', 'A', 'B'] as const).map(tier => ({ tier, documents: visibleDocuments.filter(item => item.tier === tier) })), [visibleDocuments])
  const editingDocument = editingId === null ? undefined : documents.find(item => item.id === editingId)

  const startEdit = (document: GlobalReferenceDocument): void => {
    setEditingId(document.id)
    setDraft({ title: document.title, markdown: document.markdown })
    setError(null)
  }

  const cancelEdit = (): void => {
    setEditingId(null)
    setDraft(null)
    setError(null)
  }

  const importMarkdownFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    try {
      const markdown = await file.text()
      const title = file.name.replace(/\.(markdown|md|txt)$/i, '').trim()
      setEditingId(null)
      setDraft({ title: title || '未命名基础文献', markdown })
      setError(null)
    } catch {
      setError('无法读取该文件，请改用 Markdown 或纯文本文件。')
    }
  }

  const saveDraft = (): void => {
    if (draft === null) return
    const title = draft.title.trim()
    const markdown = draft.markdown.trim()
    if (title === '' || markdown === '') {
      setError('文献名称和 Markdown 内容不能为空。')
      return
    }
    const now = new Date().toISOString()
    const next = editingDocument === undefined
      ? [{ id: createId(), title, markdown, version: 1, updatedAt: now, enabled: true }, ...documents]
      : documents.map(item => item.id === editingDocument.id
        ? { ...item, title, markdown, version: item.version + 1, updatedAt: now } : item)
    setDocuments(next)
    writeGlobalReferenceDocuments(next)
    cancelEdit()
  }

  const toggleDocument = (document: GlobalReferenceDocument): void => {
    const next = documents.map(item => item.id === document.id
      ? { ...item, enabled: !item.enabled, updatedAt: new Date().toISOString() } : item)
    setDocuments(next)
    writeGlobalReferenceDocuments(next)
  }

  const archiveDocument = (document: GlobalReferenceDocument): void => {
    if (!window.confirm(`确定归档「${document.title}」吗？归档后新问题包不会再使用它，历史问题包仍可追溯。`)) return
    const now = new Date().toISOString()
    const next = documents.map(item => item.id === document.id ? { ...item, enabled: false, archivedAt: now, updatedAt: now } : item)
    setDocuments(next)
    writeGlobalReferenceDocuments(next)
    if (editingId === document.id) cancelEdit()
  }

  const restoreDocument = (document: GlobalReferenceDocument): void => {
    const next = documents.map((item) => {
      if (item.id !== document.id) return item
      const { archivedAt: _archivedAt, ...rest } = item
      return { ...rest, enabled: false, updatedAt: new Date().toISOString() }
    })
    setDocuments(next)
    writeGlobalReferenceDocuments(next)
  }

  const deleteDocument = (document: GlobalReferenceDocument): void => {
    if (!window.confirm(`确定永久删除「${document.title}」吗？删除后无法恢复，已经生成的问题包不会受影响。`)) return
    const next = documents.filter(item => item.id !== document.id)
    setDocuments(next)
    writeGlobalReferenceDocuments(next)
  }

  return <div className={css.settingsPage}>
    <header className={css.header}>
      <div><span className={css.eyebrow}>INTERVIEW SETTINGS</span><h1>访谈设置</h1><p>管理所有实践专家访谈共用的全局基础文献池。专家项目内上传的补充材料不会自动加入这里。</p></div>
      {onClose !== undefined && <button type="button" className={css.ghostButton} onClick={onClose}>返回访谈</button>}
    </header>
    <main className={css.content}>
      <nav className={css.settingsTabs} aria-label="访谈设置分类">{([['references', '全局基础文献池'], ['prompt', '系统提示词'], ['followUp', '追问逻辑']] as const).map(([id, label]) => <button type="button" key={id} className={activeTab === id ? css.settingsTabActive : css.settingsTab} onClick={() => { setActiveTab(id) }}>{label}</button>)}</nav>
      {activeTab === 'references' && <section className={css.section}>
        <div className={css.sectionHeader}><div><h2>全局基础文献池</h2><p>当前有 {activeCount} 份启用文献。生成问题包时将读取启用且未归档的文献，并记录版本快照。</p></div><div className={css.actions}><button type="button" className={css.ghostButton} onClick={() => { setShowArchived(value => !value) }}>{showArchived ? '隐藏已归档' : '显示已归档'}</button></div></div>
        <div className={css.notice}><strong>作用范围</strong><span>这里的文献规定访谈方法、问题框架和来源标准；每个项目的专家信息与上传资料仍单独生效。</span></div>
        {visibleDocuments.length === 0 && <div className={css.empty}><strong>{showArchived ? '暂无文献' : '基础文献池为空'}</strong><span>当前版本只接入内置 v1.0 文献池，暂不支持在这里上传或编辑文献。</span></div>}
        <div className={css.documentGroups}>{groupedDocuments.map(group => <section className={css.documentGroup} key={group.tier}><div className={css.groupHeader}><strong>{group.tier} 级文献</strong><span>{group.tier === 'S' ? '核心方法论 · 必引底座' : group.tier === 'A' ? '专题方法 · 按需引用' : '实证案例 · 补充参考'}</span></div><div className={css.documentList}>{group.documents.map(document => <article className={`${css.documentCard} ${document.archivedAt !== undefined ? css.archived : ''}`} key={document.id}>
          <div className={css.documentMain}><div className={css.documentTitle}><span className={css.documentId}>{document.id}</span><strong>{document.title}</strong>{document.archivedAt !== undefined && <span className={css.archiveBadge}>已归档</span>}{document.enabled && document.archivedAt === undefined && <span className={css.enabledBadge}>启用中</span>}</div><div className={css.documentMeta}>v{document.version} · {document.sourceFile ?? '用户文献'} · {document.markdown.length.toLocaleString()} 字</div></div>
          <div className={css.documentActions}>{onPreviewDocument !== undefined && <button type="button" className={css.ghostButton} onClick={() => { onPreviewDocument(document) }}>预览</button>}{document.archivedAt === undefined && document.origin !== 'bundled-corpus' && <><button type="button" className={css.ghostButton} onClick={() => { startEdit(document) }}>编辑</button><button type="button" className={document.enabled ? css.toggleOn : css.toggleOff} onClick={() => { toggleDocument(document) }}>{document.enabled ? '停用' : '启用'}</button><button type="button" className={css.dangerButton} onClick={() => { archiveDocument(document) }}>归档</button></>}{document.archivedAt === undefined && document.origin === 'bundled-corpus' && <button type="button" className={document.enabled ? css.toggleOn : css.toggleOff} onClick={() => { toggleDocument(document) }}>{document.enabled ? '停用' : '启用'}</button>}{document.archivedAt !== undefined && <><button type="button" className={css.ghostButton} onClick={() => { restoreDocument(document) }}>恢复</button><button type="button" className={css.dangerButton} onClick={() => { deleteDocument(document) }}>永久删除</button></>}</div>
        </article>)}</div></section>)}</div>
      </section>}
      {activeTab === 'references' && draft !== null && <section className={css.editor} aria-label={editingDocument === undefined ? '添加文献' : '编辑文献'}><div className={css.sectionHeader}><div><h2>{editingDocument === undefined ? '添加基础文献' : '编辑基础文献'}</h2><p>{editingDocument === undefined ? '保存后将以 v1 加入全局文献池。' : `保存后生成 v${(editingDocument.version ?? 0) + 1}，旧版本不会影响已生成的问题包。`}</p></div><div className={css.actions}><label className={css.ghostButton}>导入 Markdown 文件<input className={css.hiddenInput} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(event) => { void importMarkdownFile(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} /></label><button type="button" className={css.ghostButton} onClick={cancelEdit}>取消</button></div></div>{error !== null && <div className={css.error} role="alert">{error}</div>}<label className={css.field}><span>文献名称</span><input value={draft.title} placeholder="例如：实践专家访谈法与任务分析框架" onChange={(event) => { setDraft({ ...draft, title: event.currentTarget.value }); setError(null) }} /></label><label className={css.field}><span>Markdown 内容</span><textarea value={draft.markdown} placeholder="# 文献标题\n\n请输入或粘贴已确认的基础文献内容……" onChange={(event) => { setDraft({ ...draft, markdown: event.currentTarget.value }); setError(null) }} /></label><div className={css.editorFooter}><span>仅 Markdown 内容会进入问题包生成上下文。</span><button type="button" className={css.primaryButton} onClick={saveDraft}>保存文献</button></div></section>}
      {activeTab === 'prompt' && <section className={css.configPanel}><div className={css.sectionHeader}><div><h2>系统提示词</h2><p>这是全局问题包生成模板。修改并保存后，下一次生成问题包时会自动应用；专家信息、专家补充资料和全局基础文献池仍由系统运行时注入。</p></div></div><div className={css.promptContext}>变量说明：<code>{'{{expert.*}}'}</code> 为当前专家字段，<code>{'{{expert.materials}}'}</code> 为专家补充资料，<code>{'{{global_reference_pool}}'}</code> 为全局基础文献池。请保留这些变量，否则对应内容无法注入。</div><label className={css.field}><span>{promptLoading ? '正在加载模板…' : `全局模板 · ${promptPreview.length.toLocaleString()} 字符`}</span><textarea className={css.promptEditor} value={promptPreview} onChange={(event) => { setPromptPreview(event.currentTarget.value); setPromptSaved(false) }} aria-label="全局问题包生成系统提示词模板" /></label><div className={css.editorFooter}><span>保存后仅影响后续新生成的问题包，不会改写已经生成的问题包。</span><div className={css.actions}><button type="button" className={css.ghostButton} onClick={resetPrompt}>恢复默认</button><button type="button" className={css.primaryButton} disabled={promptLoading || promptPreview.trim() === ''} onClick={savePrompt}>{promptSaved ? '已保存' : '保存并应用'}</button></div></div></section>}
      {activeTab === 'followUp' && <section className={css.configPanel}><div className={css.sectionHeader}><div><h2>追问逻辑</h2><p>配置回答不完整时的补充提问策略。本轮仅展示 UI，尚未改变现有追问行为。</p></div><span className={css.readonlyBadge}>预览模式</span></div><div className={css.configGrid}><label className={css.field}><span>最多连续追问次数</span><select defaultValue="2"><option value="1">1 次</option><option value="2">2 次（默认）</option><option value="3">3 次</option></select></label><label className={css.field}><span>回答过短阈值</span><select defaultValue="short"><option value="short">少于 20 字</option><option value="medium">少于 50 字</option><option value="off">不按字数判断</option></select></label></div><div className={css.ruleList}>{['没有具体案例 → 请求一个真实案例', '只有结论没有过程 → 追问关键步骤与判断', '没有结果或质量标准 → 追问如何确认完成', '任务边界不清 → 追问触发条件与责任边界'].map(rule => <label className={css.ruleRow} key={rule}><input type="checkbox" defaultChecked disabled /><span>{rule}</span></label>)}</div><div className={css.editorFooter}><span>追问策略保存与 Agent 通信将在后续版本接入。</span><button type="button" className={css.primaryButton} disabled>保存设置</button></div></section>}
    </main>
  </div>
}
