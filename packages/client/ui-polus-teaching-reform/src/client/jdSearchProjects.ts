import type { JdSearchAbility, JdSearchAnalysis, JdSearchJob, JdSearchProject, JdSearchRequest, JdSearchTask } from './types.ts'
import { JD_SEARCH_REPORT_STYLES } from './jdSearchReportTemplate.ts'

const STORAGE_KEY = 'polus-teaching-reform.jd-search-projects.v1'
export const JD_SEARCH_PROJECT_TITLE_PREFIX = 'JD 搜索 · '
export const JD_SEARCH_PROJECTS_CHANGED = 'jd-search-projects-changed'
let volatileProjects: JdSearchProject[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJob(value: unknown): value is JdSearchJob {
  if (!isRecord(value)) return false
  return ['id', 'title', 'company', 'place', 'platform', 'summary'].every(key => typeof value[key] === 'string')
    && typeof value.score === 'number'
    && (value.body === undefined || typeof value.body === 'string')
    && (value.sourceUrl === undefined || typeof value.sourceUrl === 'string')
}

function isTask(value: unknown): value is JdSearchTask {
  if (!isRecord(value)) return false
  return typeof value.title === 'string'
    && typeof value.freqHint === 'number'
    && typeof value.description === 'string'
    && Array.isArray(value.evidenceIds)
    && value.evidenceIds.every(id => typeof id === 'string')
}

function isAbility(value: unknown): value is JdSearchAbility {
  if (!isRecord(value)) return false
  return typeof value.title === 'string'
    && (value.level === '高频' || value.level === '补充')
    && typeof value.taskCount === 'number'
    && typeof value.sourceCount === 'number'
}

function isAnalysis(value: unknown): value is JdSearchAnalysis {
  return isRecord(value)
    && Array.isArray(value.tasks) && value.tasks.every(isTask)
    && Array.isArray(value.abilities) && value.abilities.every(isAbility)
}

function isRequest(value: unknown): value is JdSearchRequest {
  if (!isRecord(value)) return false
  return typeof value.major === 'string'
    && typeof value.direction === 'string'
    && Array.isArray(value.roles) && value.roles.every(role => typeof role === 'string')
    && Array.isArray(value.platforms) && value.platforms.every(platform => typeof platform === 'string')
    && typeof value.region === 'string'
    && typeof value.publishedWithin === 'string'
    && typeof value.targetCount === 'string'
}

function isProject(value: unknown): value is JdSearchProject {
  if (!isRecord(value)) return false
  return typeof value.sessionId === 'string'
    && typeof value.title === 'string'
    && isRequest(value.request)
    && Array.isArray(value.jobs) && value.jobs.every(isJob)
    && (value.excludedJobIds === undefined || Array.isArray(value.excludedJobIds) && value.excludedJobIds.every(id => typeof id === 'string'))
    && (value.confirmedJobIds === undefined || Array.isArray(value.confirmedJobIds) && value.confirmedJobIds.every(id => typeof id === 'string'))
    && (value.analysis === undefined || isAnalysis(value.analysis))
    && typeof value.jobsPath === 'string'
    && (value.reportPath === undefined || typeof value.reportPath === 'string')
    && (value.htmlReportPath === undefined || typeof value.htmlReportPath === 'string')
    && (value.reportSavedAt === undefined || typeof value.reportSavedAt === 'string')
    && (value.finalizedAt === undefined || typeof value.finalizedAt === 'string')
    && typeof value.updatedAt === 'string'
}

/** Read the valid JD search project index for the current browser origin.
 * @returns Valid project records, or an empty list when storage is unavailable.
 */
export function readJdSearchProjects(): JdSearchProject[] {
  if (typeof window === 'undefined') return []
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return volatileProjects
    const stored = value.filter(isProject)
    const volatileIds = new Set(volatileProjects.map(project => project.sessionId))
    return [...volatileProjects, ...stored.filter(project => !volatileIds.has(project.sessionId))]
  } catch {
    return volatileProjects
  }
}

/** Find a saved JD search project by its DSH session id.
 * @param sessionId - DSH session id used as the project key.
 * @returns The matching project, when it exists.
 */
export function readJdSearchProject(sessionId: string): JdSearchProject | undefined {
  return readJdSearchProjects().find(project => project.sessionId === sessionId)
}

/** Store a project and notify sidebar listeners.
 * @param project - Project record to replace or prepend in the index.
 */
export function writeJdSearchProject(project: JdSearchProject): void {
  if (typeof window === 'undefined') return
  const projects = readJdSearchProjects().filter(item => item.sessionId !== project.sessionId)
  volatileProjects = [project, ...projects]
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(volatileProjects))
  } catch {
    // A full or disabled browser store does not block the workspace files or current workflow.
  }
  window.dispatchEvent(new CustomEvent(JD_SEARCH_PROJECTS_CHANGED))
}

/** Build a dated display title for a completed JD search.
 * @param request - Search conditions used for this project.
 * @param jobCount - Number of collected job descriptions.
 * @returns A sidebar-friendly project title.
 */
export function jdSearchProjectTitle(request: JdSearchRequest, jobCount: number): string {
  const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  return `${JD_SEARCH_PROJECT_TITLE_PREFIX}${request.major.trim()} · ${jobCount} 条 JD · ${date}`
}

/** Resolve the workspace-relative artifact paths owned by a DSH session.
 * @param sessionId - DSH session id used to isolate files.
 * @returns Paths for raw jobs, Markdown, and HTML reports.
 */
export function jdSearchProjectPaths(sessionId: string): { folder: string; jobs: string; report: string; htmlReport: string } {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const folder = `outputs/jd-search/${safeId}`
  return { folder, jobs: `${folder}/jobs.json`, report: `${folder}/typical-work-tasks.md`, htmlReport: `${folder}/typical-work-tasks.html` }
}

function markdownCell(value: string): string {
  return markdownText(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function markdownText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function markdownSourceLink(url: string | undefined): string {
  if (url === undefined) return '—'
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '—'
    return `[来源](${parsed.href.replaceAll('(', '%28').replaceAll(')', '%29')})`
  } catch {
    return '—'
  }
}

function percent(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`
}

/** Render the Markdown deliverable for a confirmed JD search project.
 * @param project - Project content and analysis to render.
 * @returns A Markdown report containing analysis and confirmed JD evidence.
 */
export function buildJdSearchReport(project: JdSearchProject): string {
  const taskRows = project.analysis?.tasks.map(task => `| ${markdownCell(task.title)} | ${percent(task.freqHint)} | ${markdownCell(task.evidenceIds.join('、'))} | ${markdownCell(task.description)} |`) ?? []
  const abilityRows = project.analysis?.abilities.map(ability => `| ${markdownCell(ability.title)} | ${ability.level} | ${ability.taskCount} | ${ability.sourceCount} |`) ?? []
  const confirmedIds = new Set(project.confirmedJobIds ?? project.jobs.map(job => job.id))
  const confirmedJobs = project.jobs.filter(job => confirmedIds.has(job.id))
  const jobRows = confirmedJobs.map(job => `| ${markdownCell(job.id)} | ${markdownCell(job.title)} | ${markdownCell(job.company)} | ${markdownCell(job.place)} | ${markdownCell(job.platform)} | ${markdownSourceLink(job.sourceUrl)} |`)
  const jobBodies = confirmedJobs.map(job => `### ${markdownCell(job.id)} · ${markdownCell(job.title)}

${(job.body ?? job.summary).split(/\r?\n/).map(line => `> ${markdownText(line)}`).join('\n')}

来源：${markdownText(job.sourceUrl ?? '未提供')}
`).join('\n')
  return `# ${markdownText(project.request.major)} · 典型工作任务报告

生成时间：${project.updatedAt}

## 搜索范围

- 专业方向：${markdownText(project.request.direction.trim() || '未填写')}
- 推理岗位：${markdownText(project.request.roles.join('、'))}
- 地域：${markdownText(project.request.region)}
- 平台：${markdownText(project.request.platforms.join('、'))}
- 样本：${confirmedJobs.length} 条纳入分析的 JD；原始搜索共 ${project.jobs.length} 条（目标 ${project.request.targetCount}）

## 典型工作任务

任务从已确认 JD 的岗位职责中归纳。每条任务以动词开头，描述可独立交付工作成果的活动；“配合、参与、支持”等泛化表述不单独作为任务。频次提示表示本次样本中有证据支持该任务的 JD 占比，不代表整个劳动力市场的统计占比。

| 任务 | 样本频次提示 | 证据 JD | 工作描述 |
| --- | ---: | --- | --- |
${taskRows.join('\n')}

## 专业能力标签

| 能力标签 | 层级 | 关联任务数 | 来源 JD 数 |
| --- | --- | ---: | ---: |
${abilityRows.join('\n')}

## 搜索到的 JD

| 编号 | 岗位 | 单位 | 地点 | 来源平台 | 原始来源 |
| --- | --- | --- | --- | --- | --- |
${jobRows.join('\n')}

## 已确认 JD 正文

${jobBodies}

## 样本说明

本报告只描述本次确认的岗位样本。样本量有限时，频次提示用于比较样本内的任务覆盖情况，不应解释为岗位市场总体比例；用于人才培养决策前应结合更多 JD 与行业专家复核。
`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function sourceLink(url: string | undefined): string {
  if (url === undefined) return '未提供'
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '来源地址不可用'
    return `<a href="${escapeHtml(parsed.href)}" target="_blank" rel="noopener noreferrer">查看招聘原文</a>`
  } catch {
    return '来源地址不可用'
  }
}

/** Render a human-readable HTML report using the supplied capability-map template styles.
 * @param project - Project content and analysis to render.
 * @returns A standalone HTML report with embedded styles.
 */
export function buildJdSearchHtmlReport(project: JdSearchProject): string {
  const confirmedIds = new Set(project.confirmedJobIds ?? project.jobs.map(job => job.id))
  const jobs = project.jobs.filter(job => confirmedIds.has(job.id))
  const tasks = project.analysis?.tasks ?? []
  const abilities = project.analysis?.abilities ?? []
  const generatedAt = new Date(project.updatedAt).toLocaleString('zh-CN')
  const taskRows = tasks.map((task, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHtml(task.title)}</strong></td><td>${percent(task.freqHint)}</td><td>${escapeHtml(task.evidenceIds.join('、'))}</td><td>${escapeHtml(task.description)}</td></tr>`).join('\n')
  const abilityRows = abilities.map((ability, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHtml(ability.title)}</strong></td><td>${escapeHtml(ability.level)}</td><td>${ability.taskCount}</td><td>${ability.sourceCount}</td></tr>`).join('\n')
  const jobCards = jobs.map((job, index) => `<div class="jobcard"><div class="id">JD-${String(index + 1).padStart(3, '0')} · ${escapeHtml(job.platform)}</div><div class="title">${escapeHtml(job.title)}</div><div class="weight">${escapeHtml(job.company)} · ${escapeHtml(job.place)}</div></div>`).join('\n')
  const jobRows = jobs.map(job => `<tr><td>${escapeHtml(job.id)}</td><td>${escapeHtml(job.title)}</td><td>${escapeHtml(job.company)}</td><td>${escapeHtml(job.place)}</td><td>${escapeHtml(job.platform)}</td><td>${sourceLink(job.sourceUrl)}</td></tr>`).join('\n')
  const jobBodies = jobs.map(job => `<details><summary><strong>${escapeHtml(job.id)} · ${escapeHtml(job.title)}</strong> — ${escapeHtml(job.company)}（${escapeHtml(job.place)}）</summary><p class="jd-body">${escapeHtml(job.body ?? job.summary).replaceAll('\n', '<br>')}</p><p>来源：${sourceLink(job.sourceUrl)}</p></details>`).join('\n')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(project.request.major)} · 典型工作任务报告</title>
<style>
${JD_SEARCH_REPORT_STYLES}
  .jd-body { white-space: normal; overflow-wrap: anywhere; }
  details { border: 1px solid var(--c-line); margin: 12px 0; padding: 12px 16px; background: var(--c-paper); }
  details summary { cursor: pointer; color: var(--c-accent); }
  @media (max-width: 640px) { .page { padding: 28px 20px; } .cover h1 { font-size: 30px; } .quickstat { gap: 22px; } table { font-size: 12px; } th, td { padding: 6px 8px; } }
</style>
</head>
<body>
<a href="#top" class="top" title="回到顶部">↑</a>
<div class="page" id="top">
<div class="cover">
  <span class="badge">JD 样本分析 · 能力图谱</span>
  <h1>${escapeHtml(project.request.major)}<br>典型工作任务报告</h1>
  <div class="subtitle">基于已确认岗位 JD 的任务归纳与专业能力映射</div>
  <div class="quickstat">
    <div class="stat"><div class="num">${jobs.length}</div><div class="lbl">纳入 JD</div></div>
    <div class="stat"><div class="num">${tasks.length}</div><div class="lbl">典型工作任务</div></div>
    <div class="stat"><div class="num">${abilities.length}</div><div class="lbl">专业能力标签</div></div>
    <div class="stat"><div class="num">${project.request.platforms.length}</div><div class="lbl">搜索平台</div></div>
  </div>
  <div class="meta"><div class="meta-row"><div>地域：${escapeHtml(project.request.region)}</div><div>生成时间：${escapeHtml(generatedAt)}</div><div>项目：${escapeHtml(project.title)}</div></div></div>
</div>
<blockquote><p><strong>样本说明</strong>：本报告只归纳本次搜索并经用户确认的 JD。任务频次表示本批样本中有证据支持该任务的 JD 占比，不代表整个劳动力市场的统计比例；用于人才培养决策前应结合更多岗位样本与行业专家复核。</p></blockquote>
<nav class="toc"><h3>目录 / CONTENTS</h3><ol><li><a href="#sec0">执行摘要</a></li><li><a href="#sec1">岗位样本分布</a></li><li><a href="#sec2">典型工作任务</a></li><li><a href="#sec3">专业能力标签</a></li><li><a href="#sec4">已确认 JD 与来源</a></li><li><a href="#sec5">方法与局限</a></li></ol></nav>
<h2 id="sec0">0. 执行摘要</h2>
<div class="exec"><table><tr><td>学科 / 专业</td><td>${escapeHtml(project.request.major)}</td></tr><tr><td>专业方向</td><td>${escapeHtml(project.request.direction.trim() || '未填写')}</td></tr><tr><td>岗位名称</td><td>${escapeHtml(project.request.roles.join('、'))}</td></tr><tr><td>区域与时限</td><td>${escapeHtml(project.request.region)} · ${escapeHtml(project.request.publishedWithin)}</td></tr><tr><td>已确认样本</td><td>${jobs.length} 条 JD（原始搜索 ${project.jobs.length} 条）</td></tr><tr><td>分析结果</td><td>${tasks.length} 条典型工作任务，映射 ${abilities.length} 个专业能力标签</td></tr></table></div>
<h2 id="sec1">1. 岗位样本分布</h2><p>以下岗位来自本次搜索结果，卡片数仅展示经用户确认并纳入分析的样本。</p><div class="jobmap">${jobCards}</div>
<h2 id="sec2">2. 典型工作任务</h2><p>任务以动词开头，描述可独立交付工作成果的具体活动，并保留来源 JD 证据。</p><table><thead><tr><th>#</th><th>典型工作任务</th><th>样本频次</th><th>证据 JD</th><th>工作描述</th></tr></thead><tbody>${taskRows}</tbody></table>
<h2 id="sec3">3. 专业能力标签</h2><p>能力标签只映射到专业能力，不据此推演课程或课程安排。</p><table><thead><tr><th>#</th><th>专业能力</th><th>标签层级</th><th>关联任务数</th><th>来源 JD 数</th></tr></thead><tbody>${abilityRows}</tbody></table>
<h2 id="sec4">4. 已确认 JD 与来源</h2><table><thead><tr><th>编号</th><th>岗位</th><th>单位</th><th>地点</th><th>平台</th><th>原始来源</th></tr></thead><tbody>${jobRows}</tbody></table>${jobBodies}
<h2 id="sec5">5. 方法与局限</h2><div class="compare"><h4>任务归纳口径</h4><p>合并语义相同的职责活动；“配合、参与、支持”等泛化表达不单独作为任务。每项任务应能关联至少一条已确认 JD 证据。</p><h4>样本频次口径</h4><p>频次依据本次确认的 JD 样本计算，只用于比较当前样本覆盖情况。搜索条数和来源平台会影响样本构成。</p><h4>使用限制</h4><p>本报告反映有限搜索样本，不替代行业调研、岗位专家审议或培养方案论证。能力标签仅作为后续专业能力分析参考。</p></div>
<footer>JD 搜索工作台 · ${escapeHtml(project.request.major)} · ${escapeHtml(generatedAt)}</footer>
</div>
</body>
</html>`
}
