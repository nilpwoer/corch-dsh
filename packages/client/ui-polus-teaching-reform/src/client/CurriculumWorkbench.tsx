import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CurriculumWorkbench.module.css'

type CurriculumProps = PropsRuntime<'conversation.details.context'>

type Step = {
  id: number
  title: string
  caption: string
  status: 'ready' | 'doing' | 'pending'
}

type CourseProject = {
  id: string
  title: string
  major: string
  status: string
  updated: string
  progress: string
}

const STEPS: readonly [Step, ...Step[]] = [
  { id: 1, title: '资料准备', caption: '上传访谈、课件与备课材料', status: 'doing' },
  { id: 2, title: '典型工作任务', caption: '从访谈中提取任务', status: 'ready' },
  { id: 3, title: '能力交叉认证', caption: 'JD × 标准 × 专家', status: 'ready' },
  { id: 4, title: '专业解析', caption: '形成能力图谱初稿', status: 'pending' },
  { id: 5, title: '课程目标', caption: '上传并核对现有资料', status: 'pending' },
  { id: 6, title: '课程对标', caption: '能力条目映射课程目标', status: 'pending' },
  { id: 7, title: '学时分配', caption: '核对公共课与专业课覆盖', status: 'pending' },
  { id: 8, title: '课程项目', caption: '形成教案建议并人工校验', status: 'pending' },
]

const COURSE_PROJECTS: readonly [CourseProject, ...CourseProject[]] = [
  { id: 'elder-care', title: '养老服务专业 · 课程建设项目', major: '养老服务专业', status: '进行中', updated: '今天更新', progress: '资料准备' },
  { id: 'live-control', title: '直播电商中控课程', major: '电子商务专业', status: '已完成', updated: '2026-09-18', progress: '课程项目' },
  { id: 'community-practice', title: '社区营造项目制课程', major: '社会工作专业', status: '草稿', updated: '2026-09-12', progress: '专业解析' },
]

let currentCurriculumStep = 1
const curriculumStepListeners = new Set<() => void>()
let currentCourseId = COURSE_PROJECTS[0].id
const courseListeners = new Set<() => void>()

function subscribeCurriculumStep(listener: () => void): () => void {
  curriculumStepListeners.add(listener)
  return () => { curriculumStepListeners.delete(listener) }
}

function readCurriculumStep(): number {
  return currentCurriculumStep
}

/** Keep the sidebar and details panel on the same active workflow step. */
function useCurriculumStep(): number {
  return useSyncExternalStore(subscribeCurriculumStep, readCurriculumStep, readCurriculumStep)
}

/** Select a workflow step from either the sidebar or the details panel. */
function selectCurriculumStep(step: number): void {
  const next = Math.min(Math.max(step, 1), STEPS.length)
  if (next === currentCurriculumStep) return
  currentCurriculumStep = next
  for (const listener of curriculumStepListeners) listener()
}

function subscribeCourse(listener: () => void): () => void {
  courseListeners.add(listener)
  return () => { courseListeners.delete(listener) }
}

function readCourse(): string {
  return currentCourseId
}

function useCurrentCourse(): CourseProject {
  const id = useSyncExternalStore(subscribeCourse, readCourse, readCourse)
  return COURSE_PROJECTS.find(course => course.id === id) ?? COURSE_PROJECTS[0]
}

function selectCourse(id: string): void {
  if (id === currentCourseId) return
  currentCourseId = id
  currentCurriculumStep = 1
  for (const listener of courseListeners) listener()
  for (const listener of curriculumStepListeners) listener()
}

const mockFiles = [
  ['访谈记录-养老照护.docx', '专家访谈 · 待解析'],
  ['养老服务专业教学标准.pdf', '官方标准 · book-to-skill'],
  ['养老护理员职业技能标准.md', '官方标准 · 已关联'],
]

export function CurriculumSidebar({ wide }: PropsRuntime<'sidebar.workspaces'>): ReactNode {
  const currentCourse = useCurrentCourse()
  return (
    <div className={css.sidebar}>
      {wide ? <>
        <div className={css.sidebarTitle}>课程建设</div>
        <div className={css.sidebarHint}>历史课程建设 · {COURSE_PROJECTS.length} 个项目</div>
        <div className={css.historyList}>
          {COURSE_PROJECTS.map(course => <button
            type="button"
            key={course.id}
            className={course.id === currentCourse.id ? css.historyCardActive : css.historyCard}
            onClick={() => { selectCourse(course.id) }}>
            <span className={css.historyStatus}>{course.status}</span>
            <strong>{course.title}</strong>
            <small>{course.major} · {course.progress}</small>
            <em>{course.updated}</em>
          </button>)}
        </div>
        <button type="button" className={css.newCourseButton} onClick={() => { selectCourse(COURSE_PROJECTS[0].id) }}>＋ 新建课程建设</button>
      </> : <div className={css.sidebarMini}>课<br />程</div>}
    </div>
  )
}

function UploadCard({ title, description, done, onUpload }: { title: string; description: string; done: boolean; onUpload: () => void }) {
  return <div className={css.uploadCard}>
    <div className={css.uploadIcon}>↑</div>
    <div className={css.uploadCopy}><strong>{title}</strong><span>{description}</span></div>
    <button type="button" className={done ? css.doneButton : css.outlineButton} onClick={onUpload}>{done ? '已上传' : '上传资料'}</button>
  </div>
}

function StepContent({ step }: { step: number }) {
  const [uploaded, setUploaded] = useState<Record<string, boolean>>({})
  const [searched, setSearched] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const mark = (key: string) => { setUploaded(current => ({ ...current, [key]: true })) }
  if (step === 1) return <>
    <div className={css.sectionIntro}>
      <span className={css.eyebrow}>STEP 01</span>
      <h2>先把已有资料集中起来</h2>
      <p>专家访谈原始素材、官方标准和现有课程资料会作为后续分析的依据。</p>
    </div>
    <div className={css.cardGrid}>
      <UploadCard
        title="专家访谈原始素材"
        description="录音、访谈纪要、照片或文字记录"
        done={uploaded.interview === true}
        onUpload={() => { mark('interview') }} />
      <UploadCard
        title="专业与职业标准"
        description="已预留 book-to-skill 技能包入口"
        done={uploaded.standard === true}
        onUpload={() => { mark('standard') }} />
      <UploadCard title="现有课程资料" description="课件、备课文档、课程标准与教案" done={uploaded.course === true} onUpload={() => { mark('course') }} />
    </div>
    <div className={css.materialList}>
      <div className={css.listTitle}>当前项目资料 <span>3</span>
      </div>
      {mockFiles.map(([name, label]) => <div key={name} className={css.materialRow}>
        <span className={css.fileBadge}>DOC</span>
        <div>
          <strong>
            {name}
          </strong>
          <small>
            {label}
          </small>
        </div>
        <span className={css.ready}>已接入</span>
      </div>)}
    </div>
  </>
  if (step === 2) return <>
    <div className={css.sectionIntro}>
      <span className={css.eyebrow}>STEP 02</span>
      <h2>从专家访谈中提取典型工作任务</h2>
      <p>先由系统整理，再由专业负责人确认任务名称和描述。</p>
    </div>
    <div className={css.taskCard}>
      <span>任务 01</span>
      <strong>老年人日常生活照护</strong>
      <p>完成生活环境整理、饮食照料、起居协助与安全观察。</p>
      <em>来源：访谈记录-养老照护.docx</em>
    </div>
    <div className={css.taskCard}>
      <span>任务 02</span>
      <strong>老年人健康状况观察</strong>
      <p>记录身心变化，识别异常情况并按规范完成沟通与上报。</p>
      <em>来源：访谈记录-养老照护.docx</em>
    </div>
  </>
  if (step === 3) return <>
    <div className={css.sectionIntro}>
      <span className={css.eyebrow}>STEP 03</span>
      <h2>用三方信息交叉认证能力要求</h2>
      <p>岗位 JD 由 agent-reach 实时搜索；官方标准调用已生成的技能包；专家材料作为实践证据。</p>
    </div>
    <div className={css.sourceGrid}>
      <div className={css.sourceCard}>
        <b>岗位 JD</b>
        <span className={searched ? css.statusOk : css.statusWait}>
          {searched ? '已检索 12 条' : '待检索'}
        </span>
        <p>养老护理员 · 养老照护师 · 机构照护</p>
        <button type="button" className={css.outlineButton} onClick={() => { setSearched(true) }}>
          {searched ? '重新筛选' : '开始检索'}
        </button>
      </div>
      <div className={css.sourceCard}>
        <b>官方标准技能包</b>
        <span className={css.statusOk}>已关联 2 个</span>
        <p>养老服务专业教学标准、养老护理员标准</p>
        <button type="button" className={css.outlineButton}>查看技能包</button>
      </div>
      <div className={css.sourceCard}>
        <b>实践专家访谈</b>
        <span className={css.statusOk}>已接入</span>
        <p>2 份访谈记录 · 8 个候选任务</p>
        <button type="button" className={css.outlineButton}>查看原文</button>
      </div>
    </div>
    {searched && <div className={css.notice}>已生成候选能力：生活照护、健康观察、沟通支持、风险防范。</div>}
  </>
  if (step === 4) return <CapabilityGraphPreview />
  if (step === 5) return <>
    <div className={css.sectionIntro}>
      <span className={css.eyebrow}>STEP 05</span>
      <h2>上传现有课件，核对课程目标</h2>
      <p>这里需要用户补充现有课件、备课文档等资料，系统只做展示和对照。</p>
    </div>
    <UploadCard title="课件与备课文档" description="PPT、Word、PDF、课程标准或教案" done={uploaded.lesson === true} onUpload={() => { mark('lesson') }} />
    <div className={css.goalPreview}>
      <div className={css.listTitle}>已识别的课程目标 <span>mock</span>
      </div>
      <p>能够完成老年人日常生活照护，并根据个体差异调整服务方案。</p>
      <p>能够观察老年人健康变化，完成沟通、记录与风险上报。</p>
    </div>
  </>
  if (step === 6) return <MappingTable
    title="能力条目对标课程目标"
    rows={[['日常生活照护能力', '老年人生活照护', '已覆盖'], ['健康观察与风险识别', '老年人健康管理', '部分覆盖'], ['沟通支持与心理慰藉', '养老服务沟通', '待确认']]} />
  if (step === 7) return <MappingTable
    title="课程覆盖与学时分配"
    rows={[['公共基础课', '职业沟通、健康素养', '16 学时'], ['专业基础课', '人体基础与照护规范', '32 学时'], ['专业核心课', '生活照护与养老实训项目', '48 学时']]} />
  return <>
    <div className={css.sectionIntro}>
      <span className={css.eyebrow}>STEP 08</span>
      <h2>课程项目映射与人工校验</h2>
      <p>对比新旧课程，形成课程体系、建议教案和课程能力目标。</p>
    </div>
    <div className={css.projectMap}>
      <div>
        <span>课程项目</span>
        <strong>银龄照护实训室</strong>
        <small>12 周 · 48 学时</small>
      </div>
      <div className={css.arrow}>→</div>
      <div>
        <span>对应能力</span>
        <strong>照护 · 判断 · 沟通</strong>
        <small>3 个能力条目</small>
      </div>
    </div>
    <div className={css.notice}>下一步由专业负责人确认，督导查验实际行课结果后可回填教改证据。</div>
    <button type="button" className={confirmed ? css.doneButton : css.primaryButton} onClick={() => { setConfirmed(true) }}>
      {confirmed ? '已确认课程项目' : '标记为待人工确认'}
    </button>
  </>
}

function CapabilityCard({ title, level, source, text }: { title: string; level: string; source: string; text: string }) {
  return <div className={css.capabilityCard}>
    <div className={css.capabilityCardHeader}>
      <strong>
        {title}
      </strong>
      <span>
        {level}
      </span>
      <em>
        {source}
      </em>
    </div>
    <p>
      {text}
    </p>
    <small>来源证据：访谈记录 / 岗位 JD / 标准条目</small>
  </div>
}

function CapabilityGraphPreview() {
  return <div className={css.capabilityPreview}>
    <div className={css.sectionIntro}>
      <span className={css.eyebrow}>STEP 04</span>
      <h2>专业解析：养老服务岗位能力图谱</h2>
      <p>将专家访谈、岗位 JD 与官方标准合并校验，先查看能力图谱初版。</p>
    </div>
    <div className={css.analysisGrid}>
      <section className={css.analysisColumn}>
        <header>
          <strong>专家访谈结果</strong>
          <span>3 位专家</span>
        </header>
        <p className={css.analysisHint}>仅专家提及、JD未覆盖的能力</p>
        <CapabilityCard title="压疮护理能力" level="L3" source="仅专家" text="能够为卧床老人开展压疮预防护理，对不同分期压疮进行规范的护理与跟踪。" />
        <CapabilityCard title="问题解决能力" level="L3" source="仅专家" text="能够独立分析照护过程中的常见问题，制定合理解决方案并落地执行。" />
        <CapabilityCard title="带教指导能力" level="L3" source="仅专家" text="能够为初级护理员提供操作指导、技能培训，帮助其提升服务水平。" />
        <div className={css.evidenceBox}>
          <strong>访谈过程</strong>
          <small>访谈记录 · 配合度记录</small>
          <small>□ 访谈原话与录音（待补充）</small>
          <small>□ 专家履历表（待补充）</small>
        </div>
      </section>
      <section className={css.analysisColumn}>
        <header>
          <strong>三方平台抓取结果</strong>
          <span className={css.badgeGreen}>5 条 JD-L1-L4</span>
        </header>
        <p className={css.analysisHint}>仅企业/官方标准提及的能力</p>
        <CapabilityCard title="环境清洁与感染防控能力" level="L2" source="仅 JD" text="能够按照规范完成照护区域清洁消毒，落实基础感染防控措施。" />
        <CapabilityCard title="团队协作能力" level="L2" source="仅 JD" text="能够与护理组、接待人员、后勤部门协同配合，共同完成照护工作任务。" />
        <CapabilityCard title="服务意识" level="L2" source="仅 JD" text="能够站在老人及家属角度考虑需求，主动提供人性化的照护服务。" />
        <CapabilityCard title="法律法规遵从意识" level="L2" source="仅 JD" text="熟悉养老服务相关法律法规与行业规范，严格依法依规开展照护工作。" />
        <div className={css.evidenceBox}>
          <strong>官方标准（知识库）</strong>
          <small>尚未接入当前岗位官方标准</small>
          <small>原文来源：职业技能标准条目（待补充）</small>
        </div>
      </section>
      <section className={css.analysisColumn}>
        <header>
          <strong>综合参考报告</strong>
          <span className={css.badgeGreen}>AI 融合</span>
        </header>
        <p className={css.analysisHint}>双源一致与互补能力，可靠对接课程</p>
        <div className={css.conclusionBox}>
          <strong>✣ 一致结论</strong>
          <p>岗位所需的生活照护、健康观察与服务沟通能力在专家访谈和岗位 JD 中均有体现，建议纳入课程核心能力。</p>
        </div>
        <div className={css.subsectionTitle}>双方一致·可直接进课程（核心）</div>
        {['日常生活照护能力', '健康监测能力', '康复训练协助能力', '心理慰藉能力', '沟通能力', '责任心', '耐心'].map(title => <CapabilityCard
          key={title}
          title={title}
          level="L2"
          source="双方一致"
          text={`能够围绕${title}完成规范服务，并根据老人个体差异进行记录与改进。`} />)}
        <div className={css.coverageBox}>
          <div>
            <strong>能力课程覆盖率</strong>
            <b>89%</b>
          </div>
          <div className={css.coverageTrack}>
            <span />
          </div>
          <small>已覆盖 8 / 9 项核心能力</small>
          <small>缺口 1 项：风险防控意识</small>
        </div>
      </section>
    </div>
  </div>
}

function MappingTable({ title, rows }: { title: string; rows: readonly (readonly string[])[] }) {
  return <>
    <div className={css.sectionIntro}>
      <span className={css.eyebrow}>当前步骤</span>
      <h2>
        {title}
      </h2>
      <p>以下为用于验证流程的 mock 数据。</p>
    </div>
    <div className={css.table}>
      {rows.map(row => <div key={row[0]} className={css.tableRow}>
        {row.map((cell, index) => <span key={cell} className={index === 2 ? css.tableStatus : ''}>
          {cell}
        </span>)}
      </div>)}
    </div>
  </>
}

export function CurriculumWorkbench(_props: CurriculumProps): ReactNode {
  const step = useCurriculumStep()
  const course = useCurrentCourse()
  const current = STEPS[step - 1] ?? STEPS[0]
  return <div className={css.workbench}>
    <header className={css.header}>
      <div>
        <span className={css.kicker}>高职课程建设工作台</span>
        <h1>
          {course.title}
        </h1>
        <p>基于实践专家、岗位 JD 与官方标准的三方交叉认证</p>
      </div>
      <span className={css.projectStatus}>
        {course.status}
      </span>
    </header>
    <div className={css.progress}>
      {STEPS.map(item => <button
        type="button"
        key={item.id}
        className={item.id === step ? css.progressActive : css.progressButton}
        onClick={() => { selectCurriculumStep(item.id) }}>
        <span>
          {item.id}
        </span>
        {item.title}
      </button>)}
    </div>
    <main className={css.content}>
      <div className={css.contentTop}>
        <div>
          <span className={css.stepLabel}>STEP {String(current.id).padStart(2, '0')}
          </span>
          <span className={css.stepCaption}>
            {current.caption}
          </span>
        </div>
        <span className={css.mockLabel}>MOCK DATA</span>
      </div>
      <StepContent step={step} />
      <div className={css.footerNav}>
        <button type="button" disabled={step === 1} onClick={() => { selectCurriculumStep(step - 1) }}>上一步</button>
        <button
          type="button"
          className={css.primaryButton}
          disabled={step === STEPS.length}
          onClick={() => { selectCurriculumStep(step + 1) }}>下一步</button>
      </div>
    </main>
  </div>
}
