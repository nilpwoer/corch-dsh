import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import tinyPinyin from 'tiny-pinyin'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './InterviewWorkbench.module.css'
import { answerModeError, questionFollowupPolicy, type AnswerMode } from './questionFollowup.ts'
import { createPublication, type InterviewPolicy } from './publication.ts'
import { publishToWorker, readWorkerOrigin, readWorkerReceipt, type WorkerPublicationReceipt } from './workerPublishing.ts'
import { parseAgentQuestionPack, validateQuestionPack, checksumQuestionPack, createQuestionPackMeta, type InterviewQuestion as MockQuestion, type QuestionSourceRef, type QuestionPackMeta } from './questionPack.ts'
import { InterviewSettings } from './InterviewSettings.tsx'
import { getEnabledGlobalReferenceDocuments } from './InterviewSettings.tsx'
import type { ExpertMaterial, InterviewProfile, TeachingReformProps } from './types.ts'

type InterviewProps = TeachingReformProps
type InterviewTab = 'overview' | 'profile' | 'questions' | 'spa'
type InterviewItem = { id: string; fieldnoteId: string; title: string; expert: string; industry: string; status: string; updated: string }
type GenerationStatus = 'idle' | 'running' | 'done' | 'failed'
type InvitationMeta = { code: string; createdAt: string; status: 'active' | 'revoked' }
type PublicationSettings = { goal?: string; scope?: '' | InterviewPolicy['scope']; count?: string; legacyVersion?: number; legacyInvitationVersion?: number; worker?: WorkerPublicationReceipt }
type PersistedInterview = {
  publication?: PublicationSettings
  record: InterviewItem
  profile?: InterviewProfile
  questions?: readonly MockQuestion[]
  questionPackMeta?: QuestionPackMeta
  invitation?: InvitationMeta
}
function restorePublication(item: PersistedInterview): PublicationSettings | undefined {
  if (item.publication === undefined && item.invitation === undefined) return undefined
  const publication = item.publication ?? {}
  const legacyVersion = publication.legacyVersion ?? item.questionPackMeta?.version
  const legacyInvitationVersion = publication.legacyInvitationVersion
    ?? (item.invitation === undefined ? undefined : item.questionPackMeta?.version)
  return {
    ...publication, ...(legacyVersion === undefined ? {} : { legacyVersion }),
    ...(legacyInvitationVersion === undefined ? {} : { legacyInvitationVersion }),
  }
}
const INTERVIEW_STORAGE_KEY = 'dsh.practice-expert-interviews.v2'
const REMOVED_MOCK_INTERVIEW_IDS = new Set(['elder-care', 'community', 'live-commerce'])
const REMOVED_MOCK_INTERVIEW_TITLES = new Set(['养老照护岗位访谈', '社区营造实践访谈', '直播电商中控访谈'])

/**
 * The canonical fieldnote ID stays unchanged for storage and traceability.
 * Only the public SPA URL gets a URL-safe pinyin suffix, e.g.
 * FN-20260930-刘显钰 -> FN-20260930-liu-xian-yu.
 */
function toPinyinSlug(value: string): string {
  return value
    .replace(/[\u3400-\u9fff]+/g, segment => tinyPinyin.convertToPinyin(segment, '-', true))
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function toPublicFieldnoteId(fieldnoteId: string): string {
  const match = fieldnoteId.match(/^(.*-)([^-]+)$/)
  const suffix = match?.[2] ?? ''
  if (match === null || !/[\u3400-\u9fff]/.test(suffix)) return fieldnoteId
  return `${match[1]}${toPinyinSlug(suffix)}`
}
function readPersistedInterviews(): PersistedInterview[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(window.localStorage.getItem(INTERVIEW_STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(value)) return []
    const rows = value.filter(item => typeof item === 'object' && item !== null && 'record' in item) as PersistedInterview[]
    const realRows = rows.filter(item =>
      !REMOVED_MOCK_INTERVIEW_IDS.has(item.record.id) && !REMOVED_MOCK_INTERVIEW_TITLES.has(item.record.title))
    if (realRows.length !== rows.length) window.localStorage.setItem(INTERVIEW_STORAGE_KEY, JSON.stringify(realRows))
    return realRows
  } catch { return [] }
}

function mergeInterviewRecords(rows: readonly PersistedInterview[]): InterviewItem[] {
  return rows.map(item => item.record)
}

const persistedInterviews = readPersistedInterviews()
let interviewRecords: InterviewItem[] = mergeInterviewRecords(persistedInterviews)

function persistInterviews(): void {
  if (typeof window === 'undefined') return
  const rows: PersistedInterview[] = interviewRecords.map((record) => {
    const profile = generatedProfiles.get(record.id)
    const questions = generatedQuestionPacks.get(record.id)
    const questionPackMeta = generatedQuestionPackMeta.get(record.id)
    const invitation = generatedInvitations.get(record.id)
    const publication = generatedPublicationSettings.get(record.id)
    return {
      record, ...(publication === undefined ? {} : { publication }), ...(profile === undefined ? {} : { profile }),
      ...(questions === undefined ? {} : { questions }), ...(questionPackMeta === undefined ? {} : { questionPackMeta }),
      ...(invitation === undefined ? {} : { invitation }),
    }
  })
  try {
    window.localStorage.setItem(INTERVIEW_STORAGE_KEY, JSON.stringify(rows))
  } catch {
    // Storage may be unavailable in private/embedded contexts; the current
    // session still remains usable and the next action can be retried.
  }
}

function hydratePersistedInterviews(): void {
  const rows = readPersistedInterviews()
  interviewRecords = mergeInterviewRecords(rows)
  for (const item of rows) {
    if (item.profile !== undefined) generatedProfiles.set(item.record.id, item.profile)
    if (item.questions !== undefined) generatedQuestionPacks.set(item.record.id, ensureQuestionSources(item.questions))
    if (item.questionPackMeta !== undefined) generatedQuestionPackMeta.set(item.record.id, item.questionPackMeta)
    if (item.invitation !== undefined) generatedInvitations.set(item.record.id, item.invitation)
    const publication = restorePublication(item)
    if (publication !== undefined) generatedPublicationSettings.set(item.record.id, publication)
  }
}

function addInterviewRecord(profile: InterviewProfile, id: string, status = '问题待确认'): void {
  if (interviewRecords.some(item => item.id === id)) return
  const fieldnoteId = `FN-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${profile.name.slice(0, 3) || 'NEW'}`
  interviewRecords = [{ id, fieldnoteId, title: `${profile.name || '未命名'}实践专家访谈`, expert: profile.name, industry: profile.industry, status, updated: '刚刚更新' }, ...interviewRecords]
  persistInterviews()
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('interview-record-created'))
}

function updateInterviewRecordStatus(id: string, status: string): void {
  interviewRecords = interviewRecords.map(item => item.id === id ? { ...item, status, updated: '刚刚更新' } : item)
  persistInterviews()
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('interview-record-created'))
}

let selectedInterviewId = persistedInterviews[0]?.record.id ?? ''

export function selectInterview(id: string): void { selectedInterviewId = id }

/** Rebind a persisted interview record when the host has recreated its session
 * identifier. The fieldnote/profile/question data stays attached to the same
 * project while the host conversation gets a new durable session id. */
export function rebindInterviewSession(previousId: string, nextId: string): void {
  if (previousId === nextId || interviewRecords.some(item => item.id === nextId)) return
  const profile = generatedProfiles.get(previousId)
  const questions = generatedQuestionPacks.get(previousId)
  const meta = generatedQuestionPackMeta.get(previousId)
  const invitation = generatedInvitations.get(previousId)
  const publication = generatedPublicationSettings.get(previousId)
  if (profile !== undefined) { generatedProfiles.delete(previousId); generatedProfiles.set(nextId, profile) }
  if (questions !== undefined) { generatedQuestionPacks.delete(previousId); generatedQuestionPacks.set(nextId, questions) }
  if (meta !== undefined) { generatedQuestionPackMeta.delete(previousId); generatedQuestionPackMeta.set(nextId, meta) }
  if (publication !== undefined) {
    generatedPublicationSettings.delete(previousId)
    generatedPublicationSettings.set(nextId, publication)
  }
  if (invitation !== undefined) { generatedInvitations.delete(previousId); generatedInvitations.set(nextId, invitation) }
  interviewRecords = interviewRecords.map(item => item.id === previousId ? { ...item, id: nextId } : item)
  selectedInterviewId = nextId
  persistInterviews()
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('interview-selected', { detail: { id: nextId } }))
}

const EMPTY_PROFILE: InterviewProfile = { name: '', industry: '', role: '', years: '', stage: '', experience: '', materials: [] }

const SOURCE_TYPE_LABELS: Record<string, string> = {
  project_goal: '项目目标',
  expert_profile: '专家资料',
  uploaded_document: '上传材料',
  methodology: '访谈方法',
  global_reference: '全局基础文献',
  official_standard: '官方标准',
  job_description: '岗位样本',
  domain_knowledge: '行业知识补充',
  model_inference: '模型推断',
}

function fallbackSourceRefs(): readonly QuestionSourceRef[] {
  return [{
    sourceType: 'model_inference',
    title: 'LLM 生成结果（待主持人核验）',
    locator: '本次 Agent 问题包生成任务',
    rationale: '当前 Agent 未返回逐题来源，问题可作为候选问题使用，正式发布前需要主持人和专家确认。',
    confidence: 'low',
    requiresConfirmation: true,
  }]
}

function ensureQuestionSources(questions: readonly MockQuestion[]): readonly MockQuestion[] {
  return questions.map(question => question.sourceRefs === undefined ? { ...question, sourceRefs: fallbackSourceRefs() } : question)
}

function cleanQuestionDraft(input: MockQuestion): MockQuestion {
  const { helper, followUp, options, deleted: _deleted, deletedAt: _deletedAt, ...base } = input
  const trimmedOptions = options?.map(item => item.trim()).filter(Boolean)
  return {
    ...base,
    followupPolicy: questionFollowupPolicy({ ...base, ...(trimmedOptions?.length ? { options: trimmedOptions } : {}) }),
    ...(helper?.trim() ? { helper: helper.trim() } : {}),
    ...(followUp?.trim() ? { followUp: followUp.trim() } : {}),
    ...(trimmedOptions === undefined || trimmedOptions.length === 0 ? {} : { options: trimmedOptions }),
  }
}

const MOCK_QUESTIONS: readonly MockQuestion[] = [
  { id: 'Q01', title: '授权', type: '授权确认', question: '今天主要想了解您在真实工作中的职责、任务和判断方法。访谈结果用于岗位任务与实践经验整理。您是否同意记录？哪些内容不方便记录或引用？', options: ['同意完整记录与引用', '同意记录但敏感案例匿名', '不同意记录'] },
  { id: 'Q02', title: '经历校准', type: '开放回忆', question: '根据会前资料，我们初步了解到您有较丰富的旅游服务经验，目前从事导游相关工作。请您用自己的话介绍目前的主要工作、实际从业年限，以及两个重要职业转折点。', helper: '转向复杂或高端团队、开始独立设计或调整行程、负责跨部门或供应商协调、处理重大突发事件、开始带教新导游、开始使用数字化工具、其他、以上均不适用。', followUp: '哪个转折最能代表您从“完成任务”走向“独立判断”？当时发生了什么？您增加了哪些能力？' },
  { id: 'Q03', title: '核心职责发现', type: '开放回忆', question: '如果不参考岗位说明，您认为资深导游最重要的工作职责有哪些？请按重要性大致排序。', helper: '先自由描述，再用候选职责帮助补漏。', followUp: '这是经常承担还是偶尔承担？哪些是普通导游也要做的，哪些体现资深差异？如果没有这项职责，行程会受到什么影响？' },
  { id: 'Q04', title: '候选职责核对', type: '不定项选择', question: '请从候选职责中勾选您实际承担过的内容，并补充没有列出的职责。', options: ['旅游线路或行程设计', '客户需求分析与方案调整', '讲解与现场服务', '资源协调与质量控制', '游客安全与突发事件处理', '主题旅游服务', '数字化工具使用', '新导游带教与经验传承', '其他', '以上均不完全适用'] },
  { id: 'Q05', title: '职责评分', type: '1—5 分评分', question: '请对每项已确认职责分别评价重要性、执行频率和学习难度，并补充适用条件或备注。', helper: '1 为最低，5 为最高；评分必须由专家本人确认，不使用默认分数。' },
  { id: 'Q06', title: '任务选择', type: '单项选择', question: '请从刚才确认的职责中，选择一个最熟悉、最能体现资深导游能力的真实任务，最好是最近一年发生的案例。', options: ['复杂行程设计或临时调整', '高端或个性化客群服务', '突发事件处理', '跨供应商/跨部门协调', '新导游带教', '其他自定义任务'] },
  { id: 'Q07', title: 'A · 任务定义与触发条件', type: '案例开放题', question: '请讲一次您最近完成这项任务的具体经历。从什么情况开始，到什么结果结束？', helper: '客户提出个性化需求、原行程无法执行、天气/交通/景区/政策变化、客户安全/健康/投诉问题、供应商无法按约提供服务、团队成员或新导游需要支持、其他、不适用/不确定。', followUp: '最先出现的信号是什么？谁发现问题？谁有权决定？您的责任边界是什么？' },
  { id: 'Q08', title: 'B · 工作步骤与时间线', type: '步骤拆解', question: '请按实际发生顺序描述关键步骤。每一步做什么、由谁做、用了多长时间？', helper: '收集需求或现场信息、判断风险和方案、比较多个方案、与客户确认、联系供应商、调整时间/人员/交通/费用、现场执行监控、异常反馈、结束后复盘、其他。', followUp: '哪一步最需要经验判断？哪一步最容易出错或返工？如果顺序颠倒会怎样？' },
  { id: 'Q09', title: 'C · 客户、对象与场景', type: '场景对照', question: '这项任务主要面对什么类型的客户、团队或旅游产品？不同客群如何改变您的做法？', options: ['普通团队', '高端定制', '老年游客', '亲子或研学', '康养或长期旅居', '境外或多语种客群', '政务/商务/会奖团队', '其他'], followUp: '不同客群分别看重什么？您如何提前识别？有没有误判后调整方案的案例？' },
  { id: 'Q10', title: 'D · 工具、资料与资源', type: '资源盘点', question: '完成任务时实际使用了哪些工具、资料、平台或资源？哪些必需，哪些只是提高效率？', options: ['行程计划表', '地图、导航和实时交通', '在线导览平台', '客户沟通群/CRM/旅行社系统', '景区、酒店、车辆和餐饮平台', '应急联系人与安全预案', '多语种或文化资料', '纸质清单、电话和人工记录', '其他'], followUp: '哪个工具最影响质量？工具失效如何替代？是否形成了自己的清单、模板或判断表？' },
  { id: 'Q11', title: 'E · 工作方法与关键判断', type: '判断追问', question: '您依据什么判断路线、服务或处理方式？请讲一个需要在多个方案中选择的例子。', options: ['客户需求优先级', '安全风险', '时间和交通可行性', '预算成本', '供应商可靠性', '目的地规则', '团队成员身体状况或能力差异', '个人经验', '其他'], followUp: '标准冲突时如何排序？哪些判断可以写成规则？哪些必须依靠经验？新导游最容易在哪个判断点出错？' },
  { id: 'Q12', title: 'F · 协作与劳动组织', type: '协作关系', question: '这项任务需要哪些人配合？您与他们如何分工、沟通和交接？', options: ['旅行社计调', '景区/酒店/车辆/餐饮供应商', '领队/地接/其他导游', '客户方负责人', '医疗/救援/公共安全部门', '新导游或实习人员', '其他'], followUp: '哪个节点最容易出现信息误差？谁有最终决策权？如何确保对方理解调整后的安排？' },
  { id: 'Q13', title: 'G · 标准、质量与结果证据', type: '证据核验', question: '您如何判断任务完成得好不好？有哪些具体标准、数据、记录或客户反馈？', options: ['行程按时完成', '游客安全无事故', '满意度或投诉', '服务承诺兑现', '成本受控', '讲解准确性和适切性', '供应商履约', '复购/转介绍/评价结果', '其他'], followUp: '哪个是硬性要求，哪个可以灵活处理？谁制定或检查？有没有表面完成但实际效果不好的案例？' },
  { id: 'Q14', title: 'H · 难点、失败与例外', type: '反例追问', question: '最难处理的情况是什么？请讲一次没有按原计划发展的经历。', options: ['天气或交通剧变', '游客健康或安全问题', '客户临时改需求', '供应商服务不到位', '团队意见不一致', '预算/时间/资源不足', '语言/文化/信息理解偏差', '其他'], followUp: '当时先保护什么、后处理什么？哪个决定最关键？事后改变了哪些做法？新手应提前准备什么？' },
  { id: 'Q15', title: 'I · 职业阶段差异与带教', type: '经验传承', question: '资深导游与初入行导游完成这项任务时，最大的差异是什么？', options: ['提前识别风险', '根据客户差异调整服务', '信息不完整时判断', '协调多个组织', '稳定处理突发事件', '复盘并形成可传授方法', '其他'], followUp: '哪些能力只能通过真实案例形成？如何设计新人练习或观察任务？如何判断新人已能独立承担？' },
  { id: 'Q16', title: 'J · 可迁移性与边界', type: '迁移边界', question: '如果把这套做法迁移到另一条线路、另一类客群或另一家旅行社，哪些部分仍适用，哪些必须调整？', helper: '请分别说明：必须保留的原则；可以调整的步骤；依赖当地资源的部分；依赖个人经验的部分；不建议照搬的部分。' },
  { id: 'Q17', title: '阶段性总结确认', type: '专家回读', question: '根据刚才的交流，我理解您在“________”任务中通常会经历：________。其中最关键的判断是________，依据是________。您使用的工具和协作资源包括________，完成质量主要通过________判断。这个做法适用于________，但在________情况下需要调整。以上理解是否准确？', options: ['基本准确', '部分准确，需要修改', '不准确，需要重新描述'] },
  { id: 'Q18', title: '最终回看清单', type: '结构化确认', question: '请逐项回看并确认：核心职责、任务案例及触发条件、步骤/工具/协作/判断、质量标准与结果证据、难点/失败/例外、资深与初级差异、可迁移原则与适用边界、仅代表个人经验的内容、待补充材料或二次访谈问题。', helper: '每一项都可以修改、删除或标记为“待核实”。' },
]
void MOCK_QUESTIONS

const generatedProfiles = new Map<string, InterviewProfile>(
  persistedInterviews.flatMap(
    item => item.profile === undefined ? [] : [[item.record.id, item.profile] as const]),
)
const generatedQuestionPacks = new Map<string, readonly MockQuestion[]>(
  persistedInterviews.flatMap(
    item => item.questions === undefined ? [] : [[item.record.id, ensureQuestionSources(item.questions)] as const]),
)
const generatedQuestionPackMeta = new Map<string, QuestionPackMeta>(
  persistedInterviews.flatMap(
    item => item.questionPackMeta === undefined ? [] : [[item.record.id, item.questionPackMeta] as const]),
)
const generatedPublicationSettings = new Map<string, PublicationSettings>(persistedInterviews.flatMap((item) => {
  const publication = restorePublication(item)
  return publication === undefined ? [] : [[item.record.id, publication] as const]
}))
const generatedInvitations = new Map<string, InvitationMeta>(
  persistedInterviews.flatMap(
    item => item.invitation === undefined ? [] : [[item.record.id, item.invitation] as const]),
)

type InterviewSidebarProps = PropsRuntime<'sidebar.workspaces'> & { createInterviewSession?: () => Promise<void>; openInterviewSession?: (id: string, expert?: string) => void; onOpenSettings?: () => void }

export function InterviewSidebar({
  wide, reopenDetails = () => undefined, createInterviewSession, openInterviewSession, onOpenSettings,
}: InterviewSidebarProps): ReactNode {
  const [selected, setSelected] = useState(selectedInterviewId)
  const [interviews, setInterviews] = useState(interviewRecords)
  useEffect(() => {
    const refresh = (): void => {
      hydratePersistedInterviews()
      setInterviews([...interviewRecords])
    }
    // Hydrate after the browser has mounted as well as at module load. This
    // matters when the host restores the plugin before localStorage is ready.
    refresh()
    window.addEventListener('interview-record-created', refresh)
    window.addEventListener('storage', refresh)
    const selectCreatedInterview = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id !== undefined) setSelected(id)
    }
    window.addEventListener('interview-selected', selectCreatedInterview)
    return () => {
      window.removeEventListener('interview-record-created', refresh)
      window.removeEventListener('storage', refresh)
      window.removeEventListener('interview-selected', selectCreatedInterview)
    }
  }, [])
  return <div className={css.sidebar}>
    {wide ? <>
      <div className={css.sidebarTitle}>专家访谈</div>
      <div className={css.sidebarHint}>访谈条目 · {interviews.length} 个项目</div>
      <div className={css.sidebarActions}>
        <button type="button" className={css.newCourseButton} onClick={() => {
          if (createInterviewSession !== undefined) void createInterviewSession().catch((reason: unknown) => {
            window.alert(reason instanceof Error ? reason.message : String(reason))
          })
          else { const id = `new-${Date.now()}`; setSelected(id); selectInterview(id); reopenDetails() }
        }}>＋ 新建专家访谈</button>
        {onOpenSettings !== undefined && <button type="button" className={css.settingsButton} onClick={onOpenSettings}>访谈设置</button>}
      </div>
      <div className={css.historyList}>
        {interviews.length === 0 && <div className={css.sidebarMini}>暂无访谈项目<br />请先新建一个真实访谈</div>}
        {interviews.map(item => <button type="button" key={item.id} className={item.id === selected ? css.historyCardActive : css.historyCard} onClick={() => { setSelected(item.id); if (openInterviewSession !== undefined) openInterviewSession(item.id, item.expert); else { selectInterview(item.id); reopenDetails() } }}>
          <span className={css.historyStatus}>{item.status}</span><strong>{item.title}</strong>
          <small>{item.expert} · {item.industry}</small><em>{item.updated}</em>
        </button>)}
      </div>
    </> : <div className={css.sidebarMini}>专<br />家</div>}
  </div>
}

function materialSourceType(file: File): ExpertMaterial['sourceType'] {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return 'pdf'
  if (/\.(doc|docx)$/i.test(file.name) || file.type.includes('word')) return 'word'
  if (/\.(xls|xlsx|csv)$/i.test(file.name) || file.type.includes('sheet') || file.type === 'text/csv') return 'excel'
  if (/\.(md|markdown)$/i.test(file.name)) return 'markdown'
  if (file.type.startsWith('text/') || /\.txt$/i.test(file.name)) return 'text'
  return 'other'
}

async function fileToExpertMaterial(file: File): Promise<ExpertMaterial> {
  const sourceType = materialSourceType(file)
  const raw = await file.text()
  const looksBinary = raw.includes('\u0000') || (raw.match(/[\uFFFD]/g)?.length ?? 0) > 8
  const body = looksBinary
    ? `> 原始文件已上传。该文件将在问题生成时由Agent继续提取和整理。\n\n文件类型：${file.type || sourceType}\n文件大小：${Math.ceil(file.size / 1024)} KB`
    : raw.trim() || '原文件没有可直接提取的文字内容。'
  return {
    id: `${file.name}-${file.lastModified}-${file.size}`,
    name: file.name,
    sourceType,
    markdown: `# 专家资料：${file.name}\n\n## 原始内容\n\n${body}\n\n## 来源信息\n\n- 文件名：${file.name}\n- 文件类型：${file.type || sourceType}\n- 上传时间：${new Date().toISOString()}`,
    status: 'ready',
    uploadedAt: new Date().toISOString(),
  }
}

function ProfileTab({ initialProfile, onGenerate, generating, error, onPreviewMaterial }: {
  initialProfile: InterviewProfile
  onGenerate: (profile: InterviewProfile) => void
  generating: boolean
  error: string | null
  onPreviewMaterial?: (material: ExpertMaterial) => void
}) {
  const [materials, setMaterials] = useState<readonly ExpertMaterial[]>(initialProfile.materials ?? [])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    onGenerate({
      name: String(data.get('name') ?? '').trim(),
      industry: String(data.get('industry') ?? '').trim(),
      role: String(data.get('role') ?? '').trim(),
      years: String(data.get('years') ?? '').trim(),
      stage: String(data.get('stage') ?? '').trim(),
      experience: String(data.get('experience') ?? '').trim(),
      materials,
    })
  }
  const handleFiles = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return
    setUploading(true)
    setUploadError(null)
    try {
      const selectedFiles = Array.from(files).slice(0, 5)
      const oversized = selectedFiles.find(file => file.size > 20 * 1024 * 1024)
      if (oversized !== undefined) throw new Error(`文件“${oversized.name}”超过20MB限制`)
      const additions = await Promise.all(selectedFiles.map(fileToExpertMaterial))
      setMaterials(current => [...current.filter(item => !additions.some(next => next.id === item.id)), ...additions])
    } catch (reason: unknown) {
      setUploadError(reason instanceof Error ? reason.message : '资料读取失败，请重试')
    } finally { setUploading(false) }
  }
  return <><div className={css.intro}><span className={css.eyebrow}>专家信息</span><h2>先校准专家背景，再生成问题包</h2><p>这些资料只用于生成候选问题，正式访谈由专家 SPA 完成。主持人上传前默认已确认资料事实。</p></div><form className={css.form} onSubmit={submit}><div className={css.grid2}><div className={css.field}><label htmlFor="expert-name">专家姓名</label><input id="expert-name" name="name" defaultValue={initialProfile.name} required /></div><div className={css.field}><label htmlFor="expert-industry">所在行业</label><input id="expert-industry" name="industry" defaultValue={initialProfile.industry} required /></div><div className={css.field}><label htmlFor="expert-role">当前岗位</label><input id="expert-role" name="role" defaultValue={initialProfile.role} required /></div><div className={css.field}><label htmlFor="expert-years">实际从业年限</label><input id="expert-years" name="years" defaultValue={initialProfile.years} required /></div></div><div className={css.field}><label htmlFor="expert-stage">职业阶段（由专家校准）</label><select id="expert-stage" name="stage" defaultValue={initialProfile.stage} required><option value="">请选择职业阶段</option><option value="成长期">成长期</option><option value="成熟期">成熟期</option><option value="带教/管理期">带教/管理期</option></select></div><div className={css.field}><label htmlFor="expert-experience">代表经历与经验边界</label><textarea id="expert-experience" name="experience" defaultValue={initialProfile.experience} required /></div><div className={css.materialUpload}><div className={css.uploadRow}><span><strong>专家资料</strong><small>上传前已确认的履历、项目说明或经历报告，整理后自动加入问题生成素材。</small></span><label className={css.button} htmlFor="expert-material-upload">{uploading ? '整理中…' : '上传专家资料'}</label><input id="expert-material-upload" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.md,.markdown,.txt" hidden onChange={(event) => { void handleFiles(event.currentTarget.files); event.currentTarget.value = '' }} /></div>{uploadError !== null && <div className={css.errorLine} role="alert">{uploadError}</div>}{materials.length > 0 && <div className={css.materialList}>{materials.map(material => <div className={css.materialRow} key={material.id}><span><strong>{material.name}</strong><small>已整理 · 已加入问题生成素材</small></span><button type="button" className={css.ghostButton} onClick={() => { onPreviewMaterial?.(material) }}>在better-sidebar预览</button><button type="button" className={css.ghostButton} onClick={() => { setMaterials(current => current.filter(item => item.id !== material.id)) }}>移除</button></div>)}</div>}</div><div className={css.checkline}>{['同意完整记录与引用', '敏感案例匿名', '允许后续回看'].map(label => <label className={css.tag} key={label}><input type="checkbox" defaultChecked />{label}</label>)}</div>{error !== null && <div className={css.errorLine} role="alert">{error} 请检查专家信息后重新执行。</div>}<div className={css.footer}><span className={css.muted}>{generating ? 'DSH Agent 正在生成问题包与访谈概览…' : error !== null ? '上一次生成未完成，原资料已保留' : '提交后会在右侧对话区记录 Agent 任务'}</span><button type="submit" className={css.primaryButton} disabled={generating || uploading}>{generating ? '生成中…' : error !== null ? '重新生成问题包' : '生成问题包'}</button></div></form></>
}

function QuestionSources({ refs }: { refs: readonly QuestionSourceRef[] | undefined }): ReactNode {
  const sourceRefs = refs ?? []
  return <div className={css.sourcePanel}><div className={css.sourcePanelTitle}>问题生成来源</div>{sourceRefs.length === 0 ? <p className={css.sourceEmpty}>暂无逐题来源记录。该问题需要在下次生成时补充来源，不能将模型推断当作事实。</p> : <div className={css.sourceList}>{sourceRefs.map((source, index) => <div className={css.sourceItem} key={`${source.title}-${index}`}><div className={css.sourceItemHead}><strong>{SOURCE_TYPE_LABELS[source.sourceType] ?? source.sourceType}</strong><span>{source.confidence === undefined ? '待核验' : `置信度：${source.confidence}`}</span></div><div className={css.sourceItemTitle}>{source.title}</div>{source.locator && <div><b>定位：</b>{source.locator}</div>}{source.excerpt && <div><b>摘录：</b>{source.excerpt}</div>}{source.rationale && <div><b>作用：</b>{source.rationale}</div>}{source.requiresConfirmation && <div className={css.sourcePending}>需要主持人/专家确认</div>}</div>)}</div>}</div>
}

function QuestionsTab({
  questions, packMeta, pending, published, onConfirmPending, onDiscardPending,
  onUpdateQuestion, onDeleteQuestion, onOpenSpa, onPublishSpa,
  onExport, publishing, publicationError, publicationStatus, onCancelPublish, onNewVersion,
}: {
  questions: readonly MockQuestion[]
  packMeta: QuestionPackMeta | undefined
  pending: { questions: readonly MockQuestion[]; meta: QuestionPackMeta } | undefined
  published: boolean
  onConfirmPending: () => void
  onDiscardPending: () => void
  onUpdateQuestion: (question: MockQuestion) => void
  onDeleteQuestion: (id: string) => void
  onOpenSpa: () => void
  onPublishSpa: () => void
  onExport: () => void
  onNewVersion: () => void
  publishing: boolean
  publicationError: string | null
  publicationStatus: string | null
  onCancelPublish: () => void
}) {
  const feedback = useRef<HTMLDivElement>(null)
  useEffect(() => { if (publicationError !== null) feedback.current?.scrollIntoView({ block: 'nearest' }) }, [publicationError])
  const activeQuestions = questions.filter(item => !item.deleted)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<MockQuestion | null>(null)
  const [sourceOpenId, setSourceOpenId] = useState<string | null>(null)
  const beginEdit = (item: MockQuestion): void => { setEditingId(item.id); setDraft({ ...item }) }
  const cancelEdit = (): void => { setEditingId(null); setDraft(null) }
  const saveEdit = (): void => {
    if (draft === null) return
    const question = draft.question.trim()
    const title = draft.title.trim()
    if (title === '' || question === '') { window.alert('问题标题和问题正文不能为空。'); return }
    const modeError = answerModeError(draft.answerMode, draft.options?.map(option => option.trim()).filter(Boolean))
    if (modeError !== null) { window.alert(modeError); return }
    onUpdateQuestion(cleanQuestionDraft({ ...draft, title, question }))
    cancelEdit()
  }
  const removeQuestion = (item: MockQuestion): void => {
    if (activeQuestions.length <= 3) { window.alert('问题包至少保留 3 个问题。'); return }
    if (!window.confirm(`确定删除 ${item.id}「${item.title}」吗？删除后会从当前问题包和待发布 SPA 中移除，历史版本仍会保留。`)) return
    onDeleteQuestion(item.id)
    if (editingId === item.id) cancelEdit()
  }
  return <><fieldset className={css.publishLock} disabled={publishing}><div className={css.intro}><span className={css.eyebrow}>问题包</span><h2>{published ? '当前版本已发布' : '问题包已准备好'}</h2><p>当前有 {activeQuestions.length} 个有效问题。检查内容后，可直接发布给专家。</p>{packMeta && <div className={css.packMeta}>v{packMeta.version} · {activeQuestions.length} 题<details><summary>版本详情</summary><p>问题包 {packMeta.packId}<br />校验码 {packMeta.checksum}</p></details></div>}</div>{pending && <div className={css.overwriteNotice}><div><strong>检测到新问题包 v{pending.meta.version}</strong><p>当前问题包 v{packMeta?.version ?? pending.meta.version - 1} 将保留为历史版本。新版本共 {pending.questions.length} 题，确认后才会覆盖当前问题包。</p></div><div className={css.questionActions}><button type="button" className={css.button} onClick={onDiscardPending}>取消覆盖</button><button type="button" className={css.primaryButton} onClick={onConfirmPending}>确认覆盖</button></div></div>}<div className={css.questionList}>{activeQuestions.map(item => <details className={css.questionCard} key={item.id} open={item.id === 'Q01' || item.id === 'Q02' || item.id === editingId}><summary className={css.questionSummary}><span><strong>{item.id} · {item.title}</strong><small>{item.type} · {item.answerMode === 'text' ? '仅文字' : item.answerMode === 'choice' ? '仅选择' : item.answerMode === 'mixed' ? '选项＋文字' : item.answerMode === 'other' ? '选其他后输入' : '旧题模式'}</small></span><span className={css.tag}>{item.id >= 'Q07' && item.id <= 'Q16' ? '任务深挖' : '核心'}</span></summary>{editingId === item.id && draft !== null ? <div className={css.editForm}><label className={css.editField}><span>问题标题</span><input value={draft.title} onChange={(event) => { setDraft({ ...draft, title: event.currentTarget.value }) }} /></label><label className={css.editField}><span>回答模式</span><select aria-label="回答模式" value={draft.answerMode ?? ''} onChange={(event) => { const { answerMode: _old, ...rest } = draft; const mode = event.currentTarget.value as AnswerMode | ''; setDraft(mode === '' ? rest : { ...rest, answerMode: mode }) }}><option value="">旧题模式（保持原行为）</option><option value="text">仅文字输入</option><option value="choice">仅选择</option><option value="mixed">选项＋文字输入</option><option value="other">选其他后输入</option></select></label><label className={css.editField}><span>问题正文</span><textarea value={draft.question} onChange={(event) => { setDraft({ ...draft, question: event.currentTarget.value }) }} /></label><label className={css.editField}><span>辅助选项 / 说明</span><textarea value={draft.helper ?? ''} onChange={(event) => { setDraft({ ...draft, helper: event.currentTarget.value }) }} /></label><label className={css.editField}><span>追问</span><textarea value={draft.followUp ?? ''} onChange={(event) => { setDraft({ ...draft, followUp: event.currentTarget.value }) }} /></label>{(draft.options || draft.answerMode && draft.answerMode !== 'text') && <label className={css.editField}><span>选项（每行一个）</span><textarea value={(draft.options ?? []).join('\n')} onChange={(event) => { setDraft({ ...draft, options: event.currentTarget.value.split('\n') }) }} /></label>}<div className={`${css.questionActions} ${css.questionActionsSpread}`}><div className={css.questionActions}><button type="button" className={css.primaryButton} onClick={saveEdit}>保存修改</button><button type="button" className={css.ghostButton} onClick={cancelEdit}>取消编辑</button></div><button type="button" className={css.dangerButton} onClick={() => { removeQuestion(item) }}>删除问题</button></div></div> : <><p>{item.question}</p>{item.options && <div className={css.questionOptions}>{item.options.map(option => <span className={css.tag} key={option}>{option}</span>)}</div>}{item.helper && <div className={css.questionMeta}><b>辅助选项 / 说明</b>{item.helper}</div>}{item.followUp && <div className={css.questionMeta}><b>追问</b>{item.followUp}</div>}{sourceOpenId === item.id && <QuestionSources refs={item.sourceRefs} />}<div className={`${css.questionActions} ${css.questionActionsSpread}`}><div className={css.questionActions}><button type="button" className={css.button} onClick={() => { beginEdit(item) }}>编辑问题</button><button type="button" className={sourceOpenId === item.id ? css.sourceButtonActive : css.ghostButton} aria-expanded={sourceOpenId === item.id} onClick={() => { setSourceOpenId(sourceOpenId === item.id ? null : item.id) }}>{sourceOpenId === item.id ? '收起来源' : '查看来源'}</button></div><button type="button" className={css.dangerButton} onClick={() => { removeQuestion(item) }}>删除问题</button></div></>}</details>)}</div><div className={css.notice}>选项只帮助专家回忆，不代表标准答案；“其他”和“不适用/不确定”会始终保留。文字题与混合题保留输入框；仅选择题不显示输入框；“选其他后输入”题在选中其他时显示。有文字回答的题每题最多追问 2 次。旧题保持原行为，可编辑回答模式后发布新版本。Worker 可覆盖次数，专家可以暂不回答。修改会生成新版本，发布后才会影响新进入的访谈。</div><div className={css.questionActions} aria-label="问题包操作"><button type="button" className={css.ghostButton} onClick={onExport}>下载 JSON 题包</button><button type="button" className={css.ghostButton} onClick={onNewVersion}>创建新发布版本</button></div><div ref={feedback} aria-label="发布反馈">{publicationError && <><p className={css.error} role="alert">发布失败：{publicationError}</p><button type="button" className={css.ghostButton} onClick={() => { window.dispatchEvent(new CustomEvent('interview-settings-open', { detail: { tab: 'worker' } })) }}>配置发布授权</button></>}{publishing && <p role="status">{publicationStatus ?? '正在连接 Worker…'}</p>}</div><div className={css.footer}><span className={css.muted}>{published ? '当前版本已发布' : '当前版本待发布'}</span><div className={css.questionActions}><button type="button" className={css.primaryButton} disabled={publishing || pending !== undefined} onClick={onPublishSpa}>{publishing ? '正在发布…' : '发布并打开 SPA'}</button><button type="button" className={css.ghostButton} onClick={onOpenSpa}>查看工作台预览</button></div></div></fieldset>{publishing && <button type="button" className={css.ghostButton} onClick={onCancelPublish}>取消发布</button>}</>
}


type SpaTabProps = { publicationSettings: PublicationSettings; publicationStatus: string | null }

function SpaTab({ publicationSettings, publicationStatus }: SpaTabProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const receipt = readWorkerReceipt(publicationSettings.worker)
  const code = receipt?.code ?? (receipt ? new URLSearchParams(new URL(receipt.url).hash.slice(1)).get('code') : null)
  const copy = async (kind: 'code' | 'link'): Promise<void> => {
    const value = kind === 'code' ? code : receipt?.url
    if (!value) return
    try { await navigator.clipboard.writeText(value); setCopied(kind) } catch { setCopied('failed') }
  }
  return <div className={css.shareLayout}>
    <section className={css.card}><h3>专家访谈口令</h3><strong className={css.shareCode}>{code || (receipt?.accessStatus === 'not_required' ? '未启用口令验证' : '发布后由 Worker 生成')}</strong><div><button type="button" className={css.ghostButton} disabled={!code} onClick={() => { void copy('code') }}>复制口令</button></div><p className={css.muted}>口令随分享链接交给专家。持有链接的人可以使用此口令。</p></section>
    <section className={css.card}><h3>分享链接</h3>{publicationStatus && <p role="status">{publicationStatus}</p>}{receipt ? <>
      <p className={css.muted}>已发布题包 {receipt.key} · v{receipt.version}</p>
      <div className={css.editField}><span>Worker 访谈地址</span><div className={css.shareLinkControl}>
        <input readOnly aria-label="Worker 访谈地址" value={receipt.url} />
        <button type="button" className={css.copyLinkButton} aria-label="复制链接" title="复制链接" onClick={() => { void copy('link') }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="8" y="8" width="12" height="13" rx="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
          </svg>
        </button>
      </div></div>
      <p className={css.muted}>链接包含题包标识和口令，专家打开后自动进入访谈。</p>
    </> : <p className={css.muted}>尚未发布到 Worker。请先到问题包页确认并发布。</p>}{copied && <p role="status">{copied === 'failed' ? '复制失败，请手动复制' : copied === 'code' ? '口令已复制' : '链接已复制'}</p>}</section>
  </div>
}

export function InterviewWorkbench(props: InterviewProps & { initialTab?: InterviewTab }): ReactNode {
  const isNewInterview = !interviewRecords.some(item => item.id === selectedInterviewId)
  const selectedRecord = interviewRecords.find(item => item.id === selectedInterviewId)
  const recordProfile: InterviewProfile | undefined = selectedRecord === undefined ? undefined : { name: selectedRecord.expert, industry: selectedRecord.industry, role: '', years: '', stage: '', experience: '' }
  const initialProfile = isNewInterview ? EMPTY_PROFILE : generatedProfiles.get(selectedInterviewId) ?? recordProfile ?? EMPTY_PROFILE
  const [tab, setTab] = useState<InterviewTab>(props.initialTab ?? 'profile')
  const [publishing, setPublishing] = useState(false)
  const [publicationError, setPublicationError] = useState<string | null>(null)
  const [publicationStatus, setPublicationStatus] = useState<string | null>(null)
  const publicationOperation = useRef<AbortController | null>(null)
  useEffect(() => () => { publicationOperation.current?.abort() }, [])
  const [generationStatus, setGenerationStatus] = useState<GenerationStatus>('idle')
  const [generationError, setGenerationError] = useState<string | null>(null)
  const [profile, setProfile] = useState<InterviewProfile>(initialProfile)
  const [questionPack, setQuestionPack] = useState<readonly MockQuestion[]>(generatedQuestionPacks.get(selectedInterviewId) ?? [])
  const [questionPackMeta, setQuestionPackMeta] = useState<QuestionPackMeta | undefined>(generatedQuestionPackMeta.get(selectedInterviewId))
  const [publicationSettings, setPublicationSettings] = useState<PublicationSettings>(
    generatedPublicationSettings.get(selectedInterviewId) ?? {},
  )
  useEffect(() => {
    setPublicationSettings(generatedPublicationSettings.get(selectedInterviewId) ?? {})
  }, [props.sessionId])
  const [pendingQuestionPack, setPendingQuestionPack] = useState<{
    questions: readonly MockQuestion[]
    meta: QuestionPackMeta
  } | undefined>()
  const fieldnoteId = interviewRecords.find(item => item.id === selectedInterviewId)?.fieldnoteId ?? `FN-${selectedInterviewId.replace(/^new-/, '')}`
  const tabs = [['profile', '专家信息'], ['overview', '概览'], ['questions', '问题包'], ['spa', 'SPA 预览']] as const
  const generate = (nextProfile: InterviewProfile): void => {
    setProfile(nextProfile)
    setGenerationError(null)
    setGenerationStatus('running')
    generatedProfiles.set(selectedInterviewId, nextProfile)
    if (isNewInterview) addInterviewRecord(nextProfile, selectedInterviewId, '问题包生成中')
    else updateInterviewRecordStatus(selectedInterviewId, '问题包生成中')
    const generationReferences = getEnabledGlobalReferenceDocuments()
    void props.generateInterview(props.sessionId, nextProfile).then((agentText) => {
      const parsed = parseAgentQuestionPack(agentText)
      if (parsed === null) throw new Error('Agent 已返回结果，但未找到完整的问题包 JSON 或至少 3 个可识别问题。请查看右侧对话原文后重新执行生成。')
      const nextQuestionPack = parsed.questions
      const validationError = validateQuestionPack(nextQuestionPack)
      if (validationError !== null) throw new Error(`${validationError} 请让 Agent 重新生成。`)
      const currentMeta = generatedQuestionPackMeta.get(selectedInterviewId)
      const nextMeta = createQuestionPackMeta({
        questions: nextQuestionPack, sessionId: String(props.sessionId), generatedAt: new Date().toISOString(),
        packId: parsed.declaredPackId ?? currentMeta?.packId ?? `QP-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${selectedInterviewId}`,
        version: (currentMeta?.version ?? 0) + 1, references: generationReferences,
      })
      if (questionPack.length > 0) {
        setPendingQuestionPack({ questions: nextQuestionPack, meta: nextMeta })
        setGenerationStatus('done')
        setTab('questions')
        return
      }
      setQuestionPack(nextQuestionPack)
      setQuestionPackMeta(nextMeta)
      generatedProfiles.set(selectedInterviewId, nextProfile)
      generatedQuestionPacks.set(selectedInterviewId, nextQuestionPack)
      generatedQuestionPackMeta.set(selectedInterviewId, nextMeta)
      persistInterviews()
      updateInterviewRecordStatus(selectedInterviewId, '问题待确认')
      setGenerationStatus('done')
      setTab('overview')
    }).catch((reason: unknown) => {
      setGenerationStatus('failed')
      setGenerationError(reason instanceof Error ? reason.message : String(reason))
      updateInterviewRecordStatus(selectedInterviewId, '生成失败，可重试')
    })
  }
  useEffect(() => props.observeInterviewCommands(props.sessionId, (command) => {
    if (command === 'regenerate' && generationStatus !== 'running') generate(profile)
  }), [props.sessionId, props.observeInterviewCommands, generationStatus, profile])
  const confirmPendingQuestionPack = (): void => {
    if (pendingQuestionPack === undefined) return
    setQuestionPack(pendingQuestionPack.questions)
    setQuestionPackMeta(pendingQuestionPack.meta)
    generatedQuestionPacks.set(selectedInterviewId, pendingQuestionPack.questions)
    generatedQuestionPackMeta.set(selectedInterviewId, pendingQuestionPack.meta)
    setPendingQuestionPack(undefined)
    persistInterviews()
    updateInterviewRecordStatus(selectedInterviewId, '问题待确认')
    setTab('overview')
  }
  const discardPendingQuestionPack = (): void => {
    setPendingQuestionPack(undefined)
    setGenerationStatus('done')
    updateInterviewRecordStatus(selectedInterviewId, '问题待确认')
  }
  const updateQuestion = (nextQuestion: MockQuestion): void => {
    const cleaned = cleanQuestionDraft(nextQuestion)
    const current = questionPack.find(item => item.id === nextQuestion.id)
    if (JSON.stringify(current) === JSON.stringify(cleaned)) return
    const nextQuestionPack = questionPack.map(item => item.id === nextQuestion.id ? cleaned : item)
    const nextMeta = questionPackMeta === undefined ? undefined : {
      ...questionPackMeta, version: questionPackMeta.version + 1,
      generatedAt: new Date().toISOString(), checksum: checksumQuestionPack(nextQuestionPack),
    }
    setQuestionPack(nextQuestionPack)
    if (nextMeta !== undefined) setQuestionPackMeta(nextMeta)
    generatedQuestionPacks.set(selectedInterviewId, nextQuestionPack)
    if (nextMeta !== undefined) generatedQuestionPackMeta.set(selectedInterviewId, nextMeta)
    persistInterviews()
    updateInterviewRecordStatus(selectedInterviewId, '问题包有未发布修改')
  }
  const deleteQuestion = (id: string): void => {
    const activeCount = questionPack.filter(item => !item.deleted).length
    if (activeCount <= 3) return
    const nextQuestionPack = questionPack.map(item =>
      item.id === id ? { ...item, deleted: true, deletedAt: new Date().toISOString() } : item)
    const nextMeta = questionPackMeta === undefined ? undefined : {
      ...questionPackMeta, version: questionPackMeta.version + 1,
      generatedAt: new Date().toISOString(), checksum: checksumQuestionPack(nextQuestionPack),
    }
    setQuestionPack(nextQuestionPack)
    if (nextMeta !== undefined) setQuestionPackMeta(nextMeta)
    generatedQuestionPacks.set(selectedInterviewId, nextQuestionPack)
    if (nextMeta !== undefined) generatedQuestionPackMeta.set(selectedInterviewId, nextMeta)
    persistInterviews()
    updateInterviewRecordStatus(selectedInterviewId, '问题包有未发布修改')
  }
  const createPublicationVersion = (): void => {
    if (!questionPackMeta) return
    const next = { ...questionPackMeta, version: questionPackMeta.version + 1, generatedAt: new Date().toISOString() }
    setQuestionPackMeta(next)
    generatedQuestionPackMeta.set(selectedInterviewId, next)
    persistInterviews()
    updateInterviewRecordStatus(selectedInterviewId, '问题包有未发布修改')
  }
  const preparePublication = () => {
    if (!questionPackMeta?.generatedAt) throw new Error('请先生成有效版本的问题包')
    const policy = publicationSettings.legacyVersion === questionPackMeta.version
      && publicationSettings.scope && publicationSettings.count?.trim()
      ? { scope: publicationSettings.scope, maxFollowups: Number(publicationSettings.count) } : undefined
    const invitation = publicationSettings.legacyInvitationVersion === questionPackMeta.version
      ? generatedInvitations.get(selectedInterviewId) : undefined
    const publication = createPublication({
      fieldnoteId, publicFieldnoteId: toPublicFieldnoteId(fieldnoteId), goal: publicationSettings.goal?.trim() || selectedRecord?.title || `${profile.industry} · ${profile.role}访谈`, profile,
      questions: questionPack.filter(item => !item.deleted), questionPackMeta, invitation, interviewPolicy: policy,
    }, questionPackMeta.generatedAt)
    return { ...publication, invitation }
  }
  const publishSpa = async (): Promise<void> => {
    if (publicationOperation.current) return
    const controller = new AbortController()
    publicationOperation.current = controller
    const interviewId = selectedInterviewId
    setPublishing(true); setPublicationError(null); setPublicationStatus('正在连接 Worker…')
    try {
      const target = readWorkerOrigin()
      if (!target) throw new Error('请先在访谈设置的“Worker 发布”中填写目标地址')
      const publication = preparePublication()
      const key = `${publication.publicFieldnoteId}-v${publication.questionPackMeta.version}`
      const result = await publishToWorker(target, key, JSON.stringify(publication), controller.signal, setPublicationStatus)
      const receipt: WorkerPublicationReceipt = {
        ...result, version: publication.questionPackMeta.version,
        url: result.url,
      }
      const next = { ...(generatedPublicationSettings.get(interviewId) ?? publicationSettings), worker: receipt }
      generatedPublicationSettings.set(interviewId, next)
      setPublicationSettings(next)
      updateInterviewRecordStatus(interviewId, '已生成 SPA')
      setPublicationStatus('发布成功，已打开 SPA')
      setTab('spa')
    } catch (error) {
      if (!controller.signal.aborted) { setPublicationError(error instanceof Error ? error.message : '发布失败，请重试'); setPublicationStatus(null) }
    } finally {
      if (publicationOperation.current === controller) {
        publicationOperation.current = null
        if (!controller.signal.aborted) setPublishing(false)
      }
    }
  }
  const exportQuestionPack = (): void => {
    try {
      const publication = preparePublication()
      const blob = new Blob([JSON.stringify(publication, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${publication.publicFieldnoteId}-v${publication.questionPackMeta.version}.json`
      anchor.click()
      window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '题包导出失败。')
    }
  }
  const published = publicationSettings.worker?.version === questionPackMeta?.version && publicationSettings.worker !== undefined
  const statusText = publishing ? '正在发布' : generationStatus === 'running' ? '正在生成问题包' : published ? '当前版本已发布' : questionPack.length > 0 ? '问题包待发布' : generationStatus === 'failed' ? '生成失败' : '准备录入'
  const activeQuestionCount = questionPack.filter(item => !item.deleted).length
  return <div className={css.workbench}><header className={css.header}><div><span className={css.eyebrow}>实践专家访谈工作台</span><h1>{isNewInterview ? '新建实践专家访谈' : `${profile.industry} · ${profile.role}访谈`}</h1><p>准备问题包并发布访谈，专家通过分享链接作答。</p></div><span className={css.pill}>{statusText}</span></header><nav className={css.tabs} aria-label="专家访谈工作台标签页">{tabs.map(([id, label]) => <button type="button" key={id} className={tab === id ? css.tabActive : css.tab} disabled={publishing || id !== 'profile' && generationStatus !== 'done' && questionPack.length === 0} onClick={() => { setTab(id) }}>{label}</button>)}</nav><main className={css.content}><div className={css.contentTop}><div><span className={css.eyebrow}>{isNewInterview ? '新访谈 · 待录入' : `${fieldnoteId} · ${profile.name}`}</span></div></div>{tab === 'profile' && <ProfileTab initialProfile={initialProfile} onGenerate={generate} generating={generationStatus === 'running'} error={generationError} onPreviewMaterial={(material) => { props.openExpertMaterialPreview?.(props.sessionId, material) }} />}{tab === 'overview' && <><div className={css.intro}><span className={css.eyebrow}>访谈概览</span><h2>把一次访谈，整理成可回看的实践证据</h2><p>当前条目围绕{profile.industry}行业{profile.role}，覆盖经历校准、核心职责、真实案例与专家回看。</p></div><div className={css.grid3}><div className={css.card}><h3>专家信息</h3><p>{profile.name} · {profile.role}<br />{profile.industry} · {profile.stage}<br />{profile.years}从业经验</p></div><div className={css.card}><h3>问题包</h3><p>{activeQuestionCount || 0} 个有效问题<br />开放回忆 + 选项辅助<br />{published ? '当前版本已发布' : questionPack.length > 0 ? '可校阅并发布' : '尚未生成'}<br />{questionPackMeta ? `v${questionPackMeta.version} · ${questionPackMeta.checksum}` : ''}</p></div><div className={css.card}><h3>SPA 单页</h3><p>Fieldnote ID：{fieldnoteId}<br />单题模式 · 进度提示<br />发布后生成分享链接</p></div></div><div className={css.summary}><h3>下一步</h3><p>先确认专家背景并生成问题包。Agent 任务会同步出现在右侧对话区；校阅问题包后可直接发布。</p><div className={css.footer}><span className={css.muted}>{generationStatus === 'running' ? '正在等待 Agent 返回…' : '准备就绪'}</span><button type="button" className={css.primaryButton} disabled={generationStatus !== 'done' && questionPack.length === 0} onClick={() => { setTab('questions') }}>查看问题包</button></div></div></>}{tab === 'questions' && <QuestionsTab questions={questionPack} packMeta={questionPackMeta} pending={pendingQuestionPack} published={published} onConfirmPending={confirmPendingQuestionPack} onDiscardPending={discardPendingQuestionPack} onUpdateQuestion={updateQuestion} onDeleteQuestion={deleteQuestion} onOpenSpa={() => { setTab('spa') }} onPublishSpa={() => { void publishSpa() }} onExport={exportQuestionPack} publishing={publishing} onNewVersion={createPublicationVersion} publicationError={publicationError} publicationStatus={publicationStatus} onCancelPublish={() => { publicationOperation.current?.abort(); setPublishing(false); setPublicationStatus(null); setPublicationError('已取消发布等待；如 Worker 已接收，重试会确认相同题包') }} />}{tab === 'spa' && <SpaTab publicationSettings={publicationSettings} publicationStatus={publicationStatus} />}</main></div>
}

export function InterviewDetails(props: InterviewProps): ReactNode {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [workerSettings, setWorkerSettings] = useState(false)
  useEffect(() => {
    const open = (event: Event): void => {
      setWorkerSettings((event as CustomEvent<{ tab?: unknown }>).detail?.tab === 'worker')
      setSettingsOpen(true)
    }
    const close = (): void => { setSettingsOpen(false); setWorkerSettings(false) }
    window.addEventListener('interview-settings-open', open)
    window.addEventListener('interview-selected', close)
    return () => {
      window.removeEventListener('interview-settings-open', open)
      window.removeEventListener('interview-selected', close)
    }
  }, [])
  if (settingsOpen) return <InterviewSettings {...(workerSettings ? { initialTab: 'worker' as const } : {})} onClose={() => { setSettingsOpen(false) }}
    {...(props.openGlobalReferencePreview === undefined ? {} : { onPreviewDocument: props.openGlobalReferencePreview })} />
  return <InterviewWorkbench key={selectedInterviewId} {...props} {...(workerSettings ? { initialTab: 'questions' as const } : {})} />
}
