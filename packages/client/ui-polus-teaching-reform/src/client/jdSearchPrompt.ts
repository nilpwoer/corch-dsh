import type { JdSearchJob, JdSearchRequest } from './types.ts'

/** Build a job-title inference request for the selected discipline.
 * @param major - The discipline or major.
 * @param direction - Optional specialization and user constraints.
 * @returns The model request for suggested job titles.
 */
export function buildJdRoleInferencePrompt(major: string, direction: string): string {
  return `根据学科专业“${major}”和专业方向“${direction}”，推理适合在四川及西南地区招聘市场检索的基础岗位名称。优先使用真实招聘中常见的岗位名，避免生成课程名称、管理岗位或过于宽泛的词。只输出一个 JSON 对象，不要使用 Markdown 代码围栏：{"roles":[string,string,string,string]}`
}

/** Require public source-body evidence for every returned job.
 * @param request - User-selected roles, platforms and search filters.
 * @returns The search and fetch instruction with its JSON result fields.
 */
export function buildJdSearchPrompt(request: JdSearchRequest): string {
  const testLimit = request.targetCount.startsWith('5')
  return `执行一次岗位 JD 搜索。搜索条件：${JSON.stringify(request)}。${testLimit ? '这是测试档：最多返回 5 条有效 JD，找到足够的高相关结果后立即停止，不要为了凑数扩大搜索。' : '目标条数是上限范围提示，优先保证相关性和正文完整度；达不到目标时如实返回，不要为凑数收录低质量结果。'}

使用 web_search 查找岗位，再用 web_fetch 阅读每条候选的公开 JD 正文。只收录实际读取到岗位职责的页面，sourceUrl 必须指向该原始页面；不要根据标题、搜索摘要或常见岗位职责推测正文，不要编造岗位、公司、发布日期或来源。抓取失败、登录限制或没有符合筛选条件的正文时，跳过该条；全部失败时返回 {"jobs":[]}。不要安装软件或通过 Shell 绕过抓取限制，不要联系招聘方或提交申请。58 同城、BOSS 直聘等平台如果需要登录，如实说明限制，不要绕过验证码或访问控制。区域和发布时间以用户选择为准，不能确认发布时间的条目不纳入。只保留 JD 正文，剔除导航、广告和重复职位；跨平台相同岗位自动去重，保留一条主记录。

只输出一个 JSON 对象，不要使用 Markdown 代码围栏：{"jobs":[{"id":"JD-001","title":string,"company":string,"place":string,"platform":string,"score":number,"summary":string,"sourceUrl":string}]}。summary 只写岗位职责正文摘要，不要写搜索过程。`
}

/** Derive tasks and abilities only from confirmed job evidence.
 * @param jobs - Public jobs retained by the user.
 * @returns The task and ability analysis request.
 */
export function buildJdAnalysisPrompt(jobs: readonly JdSearchJob[]): string {
  return `根据以下已经由用户确认的岗位 JD，聚类出典型工作任务，并进一步归纳为专业能力标签。只使用 JD 中出现的职责证据，不补写无法支持的要求。岗位数据：${JSON.stringify(jobs)}。

只输出一个 JSON 对象，不要使用 Markdown 代码围栏：{"tasks":[{"title":string,"count":string,"description":string,"evidenceIds":string[]}],"abilities":[{"title":string,"level":"高频"|"补充","taskCount":number,"sourceCount":number}]}。能力标签只映射到专业能力，不生成课程名称或课程安排。`
}
