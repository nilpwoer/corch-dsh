import type { GlobalReferenceDocument } from './interviewTypes.ts'
import type { InterviewProfile } from './interviewTypes.ts'
import { CORE_METHOD_RULES, generationExcerpt } from './globalReferenceCorpus.ts'

export const INTERVIEW_SYSTEM_PROMPT_STORAGE_KEY = 'dsh.practice-expert-system-prompt.v1'

const ANSWER_MODE_INSTRUCTIONS = '回答控件协议：每题必须提供 answerMode，只能为 text（仅文字，无 options）或 mixed（实质回答选项＋始终显示文字输入框）。所有专家题默认显示文字输入框，不依赖是否勾选选项。type 只描述题目主题或单选/多选。options 只能包含实质回答选项，不得提供“不适用”“暂不适用”“暂不使用”等兜底项；“其他”“其他，请补充”“其他或补充”也不是选项，专家直接在始终显示的文字框填写回答或补充说明。正常业务文字中出现“不适用”或“其他部门”等词语不受影响。不得生成 choice 或 other 模式。有文字回答的题每题最多追问 2 次；不要自行输出 followupPolicy。'

/** The single source of truth for both the prompt sent to DSH and the UI preview. */
export function buildInterviewPromptTemplate(): string {
  return [
    '你现在是 DSH 的实践专家访谈问题包 Agent。',
    '请根据以下已由主持人录入并准备交由专家校准的背景，生成一份访谈概览和问题包。',
    '问题设计必须采用“开放回忆 → 选项辅助 → 证据追问 → 专家确认”的混合结构；不要代替专家推断事实。',
    '当前插件只负责准备问题包，不在此处进行专家访谈；请将生成结果作为可供主持人审阅的草稿。',
    `全局方法协议（来自 README.md 与 question-pack-generation-handoff.md）：${CORE_METHOD_RULES}`,
    '专家姓名：{{expert.name}}',
    '行业：{{expert.industry}}',
    '当前岗位：{{expert.role}}',
    '从业年限：{{expert.years}}',
    '职业阶段：{{expert.stage}}',
    '代表经历与经验边界：{{expert.experience}}',
    '全局基础文献池（由系统注入；仅用于访谈方法、问题框架和来源标准）：\n{{global_reference_pool}}',
    '专家补充资料（由主持人确认后注入；没有资料时传入“本次没有上传专家资料。”）：\n{{expert.materials}}',
    '上传资料默认已由主持人确认。你只能对资料做结构化归类，不得补写原文没有出现的事实；问题的sourceRefs应优先引用uploaded_document并保留文件名和章节定位。',
    '可引用来源范围：project_goal=本次访谈任务书；expert_profile=专家信息表（按行业、岗位、年限、职业阶段或经验边界定位）；global_reference=本次输入的全局基础文献池文档；methodology=实践专家访谈法问题包模板；uploaded_document=仅当本次确实提供上传材料时使用；official_standard/job_description=仅当输入中确实提供对应文件或条目时使用；domain_knowledge=LLM 行业知识补充；model_inference=模型根据现有输入做出的待核验推断。不要虚构不存在的文件、页码、条款或专家原话。',
    '只输出一个完整的 ```json 代码块，不要在代码块前后输出解释文字。JSON 顶层包含 overview（简短访谈概览）、packId（可选）和 questions 数组；每个问题包含 title、type、question、options（可选数组）、helper（可选）、followUp（可选）和 sourceRefs（必填数组）。每个 sourceRefs 条目必须包含 sourceType、title、rationale、confidence 四个字段；confidence 只能是 high、medium、low。可选字段包括 locator、excerpt、requiresConfirmation。sourceType 只能使用 project_goal、expert_profile、uploaded_document、methodology、global_reference、official_standard、job_description、domain_knowledge、model_inference 之一。没有可验证来源时，不要省略 sourceRefs，也不要编造文件或引用，应使用 model_inference、confidence=low、requiresConfirmation=true，并明确说明待核验。不要在 JSON 中省略问题，问题编号由插件按数组顺序生成 Q01、Q02……。',
    ANSWER_MODE_INSTRUCTIONS,
    '问题包必须覆盖授权、经历校准、核心职责、真实任务、工具/协作/判断、质量证据、难点例外、职业阶段差异、迁移边界和最终确认。',
  ].join('\n')
}
function readInterviewSystemPromptTemplate(): string {
  if (typeof window === 'undefined') return buildInterviewPromptTemplate()
  try {
    const value = window.localStorage.getItem(INTERVIEW_SYSTEM_PROMPT_STORAGE_KEY)
    return value?.trim() ? value : buildInterviewPromptTemplate()
  } catch {
    return buildInterviewPromptTemplate()
  }
}

export function buildInterviewPrompt(profile: InterviewProfile, references: readonly GlobalReferenceDocument[]): string {
  return buildInterviewPromptFromTemplate(profile, references, readInterviewSystemPromptTemplate())
}

/** Build a prompt from explicit inputs, without reading browser preferences.
 * @param profile - Confirmed profile or explicitly identified synthetic test profile.
 * @param references - Only documents actually supplied to the generation.
 * @param template - Explicit methodology template to render.
 * @returns the rendered, loggable model input.
 */
export function buildInterviewPromptFromTemplate(
  profile: InterviewProfile, references: readonly GlobalReferenceDocument[], template: string,
): string {
  const referenceText = references.length === 0
    ? '当前全局基础文献池为空。不得虚构文献来源。'
    : `全局基础文献池（仅用于访谈方法、问题框架和来源标准，不代表当前专家事实；S级核心文献优先，A/B级按需参考）：\n${references.map(document => `--- ${document.tier ?? '用户'}级 · ${document.id} · ${document.title} · v${document.version} ---\n${generationExcerpt(document)}`).join('\n')}`
  const materialsText = profile.materials?.length
    ? profile.materials.map(material => `--- ${material.name} ---\n${material.markdown}`).join('\n')
    : '本次没有上传专家资料。'
  const rendered = template
    .replaceAll('{{expert.name}}', profile.name)
    .replaceAll('{{expert.industry}}', profile.industry)
    .replaceAll('{{expert.role}}', profile.role)
    .replaceAll('{{expert.years}}', profile.years)
    .replaceAll('{{expert.stage}}', profile.stage)
    .replaceAll('{{expert.experience}}', profile.experience)
    .replaceAll('{{global_reference_pool}}', referenceText)
    .replaceAll('{{expert.materials}}', materialsText)
  return rendered.includes(ANSWER_MODE_INSTRUCTIONS) ? rendered : `${rendered}\n${ANSWER_MODE_INSTRUCTIONS}`
}
