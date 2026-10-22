/** Question-pack parsing and provenance shared by the workbench and CLI. No browser state. */
import { answerModeError, normalizeQuestionControls, questionFollowupPolicy } from './questionFollowup.ts'
import type { AnswerMode, QuestionFollowupPolicy } from './questionFollowup.ts'
import { referenceExcerpts } from './globalReferenceCorpus.ts'
import type { ReferenceExcerpt } from './globalReferenceCorpus.ts'
import type { GlobalReferenceDocument } from './interviewTypes.ts'
/** One normalized generated question, retaining optional source evidence and editing metadata. */
export type InterviewQuestion = {
  id: string
  title: string
  type: string
  answerMode?: AnswerMode
  question: string
  helper?: string
  followUp?: string
  followupPolicy?: QuestionFollowupPolicy
  options?: readonly string[]
  sourceRefs?: readonly QuestionSourceRef[]
  deleted?: boolean
  deletedAt?: string
}

/** A model-declared question-design source, not a participant answer. */
export type QuestionSourceRef = {
  sourceType: string
  title: string
  locator?: string
  excerpt?: string
  rationale?: string
  confidence?: 'high' | 'medium' | 'low'
  requiresConfirmation?: boolean
}

/** Version and actual generation-session provenance, compatible with existing UI publications. */
export type QuestionPackMeta = {
  packId: string
  version: number
  generatedAt: string
  sourceSessionId: string
  checksum: string
  globalReferences?: readonly {
    id: string
    title: string
    version: number
    contentHash: string
    sourceFile?: string
    sourceHash?: string
    excerpts?: readonly ReferenceExcerpt[]
  }[]
}

function scalarText(value: unknown): string {
  if (typeof value === 'object' && value !== null) throw new Error('Question-pack text cannot be an object or array')
  if (typeof value === 'function') throw new Error('Question-pack text cannot be a function')
  return String(value)
}

function normalizeSourceRefs(value: unknown): readonly QuestionSourceRef[] | undefined {
  if (!Array.isArray(value)) return undefined
  const refs = value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const row = item as Record<string, unknown>
    const title = scalarText(row.title ?? '').trim()
    if (title === '') return []
    const sourceType = scalarText(row.sourceType ?? 'model_inference').trim() || 'model_inference'
    const confidence = row.confidence === 'high' || row.confidence === 'medium' || row.confidence === 'low' ? row.confidence : undefined
    return [{
      sourceType,
      title,
      ...(row.locator === undefined ? {} : { locator: scalarText(row.locator) }),
      ...(row.excerpt === undefined ? {} : { excerpt: scalarText(row.excerpt) }),
      ...(row.rationale === undefined ? {} : { rationale: scalarText(row.rationale) }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(row.requiresConfirmation === undefined ? {} : { requiresConfirmation: Boolean(row.requiresConfirmation) }),
    } satisfies QuestionSourceRef]
  })
  return refs.length > 0 ? refs : undefined
}

function splitQuestionOptions(helper: string): string[] {
  const options: string[] = []
  let depth = 0
  let current = ''
  for (const character of helper) {
    if (character === '(' || character === '（') depth += 1
    if (character === ')' || character === '）') depth = Math.max(0, depth - 1)
    if (depth === 0 && /[\/／、；;|，]/.test(character)) {
      if (current.trim()) options.push(current.trim())
      current = ''
    } else current += character
  }
  if (current.trim()) options.push(current.trim())
  return options.filter(option => option !== '无')
}

/** Model text parsed into ordered questions and an optional declared pack identifier. */
export type ParsedQuestionPack = { questions: readonly InterviewQuestion[]; declaredPackId?: string }

/** Compute the existing non-security UI checksum.
 * @param questions - Ordered question content.
 * @returns compatible eight-character FNV checksum.
 */
export function checksumQuestionPack(questions: readonly InterviewQuestion[]): string {
  const source = JSON.stringify(questions)
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function checksumText(source: string): string {
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const ALLOWED_SOURCE_TYPES = new Set(['project_goal', 'expert_profile', 'uploaded_document', 'methodology', 'global_reference', 'official_standard', 'job_description', 'domain_knowledge', 'model_inference'])

/** Validate generated question count, numbering, body and source metadata.
 * @param questions - Normalized model output.
 * @returns a displayable rejection, or null when valid.
 */
export function validateQuestionPack(questions: readonly InterviewQuestion[]): string | null {
  if (questions.length < 3) return '问题数量不足，至少需要 3 个问题。'
  const ids = questions.map(item => item.id)
  const unique = new Set(ids)
  if (unique.size !== ids.length) return '问题编号存在重复，无法确认对应关系。'
  for (let index = 0; index < ids.length; index += 1) {
    const expected = `Q${String(index + 1).padStart(2, '0')}`
    if (ids[index] !== expected) return `问题编号不连续：第 ${index + 1} 个问题应为 ${expected}，实际为 ${ids[index] ?? '空'}。`
    if (!questions[index]?.question.trim()) return `${expected} 缺少问题正文。`
    const modeError = answerModeError(questions[index]?.answerMode, questions[index]?.options)
    if (modeError !== null) return `${expected} ${modeError}`
    const refs = questions[index]?.sourceRefs
    if (refs === undefined || refs.length === 0) return `${expected} 缺少 sourceRefs，无法确认问题生成依据。请让 Agent 按协议重新生成。`
    for (const [refIndex, ref] of refs.entries()) {
      if (!ALLOWED_SOURCE_TYPES.has(ref.sourceType) || ref.title.trim() === '' || !ref.rationale?.trim() || ref.confidence === undefined) {
        return `${expected} 的 sourceRefs[${refIndex}] 缺少 sourceType、title、rationale 或 confidence。请让 Agent 按协议重新生成。`
      }
    }
  }
  return null
}

function normalizeStructuredQuestions(value: unknown): ParsedQuestionPack | null {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { questions?: unknown }).questions)) return null
  const rawQuestions = (value as { questions: unknown[] }).questions
  const questions = rawQuestions.map((item, index) => {
    const row = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
    const options = Array.isArray(row.options) ? row.options.map((option) => {
      if (typeof option === 'object' && option !== null) {
        const entry = option as Record<string, unknown>
        const label = scalarText(entry.label ?? '').trim()
        const description = scalarText(entry.description ?? '').trim()
        return label === '' ? description : description === '' ? label : `${label}（${description}）`
      }
      return scalarText(option)
    }).filter(Boolean) : undefined
    const normalizePromptField = (field: unknown): string | undefined => {
      if (field === undefined || field === null) return undefined
      if (Array.isArray(field)) {
        const lines = field.map((entry) => {
          if (typeof entry === 'object' && entry !== null) {
            const value = entry as Record<string, unknown>
            const trigger = scalarText(value.trigger ?? '').trim()
            const next = scalarText(value.next ?? '').trim()
            return trigger === '' ? next : next === '' ? trigger : `${trigger} → ${next}`
          }
          return scalarText(entry).trim()
        }).filter(Boolean)
        return lines.length === 0 ? undefined : lines.join('\n')
      }
      const text = scalarText(field).trim()
      return text === '' ? undefined : text
    }
    const sourceRefs = normalizeSourceRefs(row.sourceRefs)
    const type = typeof row.type === 'string' ? row.type : '开放式叙述'
    if (answerModeError(row.answerMode, options) !== null) throw new Error('Invalid answerMode')
    const answerMode = row.answerMode as AnswerMode | undefined
    const helper = normalizePromptField(row.helper)
    const followUp = normalizePromptField(row.followUp)
    return {
      id: `Q${String(index + 1).padStart(2, '0')}`,
      title: scalarText(row.title ?? `问题 ${index + 1}`),
      type,
      ...(answerMode === undefined ? {} : { answerMode }),
      followupPolicy: questionFollowupPolicy({
        type, ...(options ? { options } : {}), ...(answerMode === undefined ? {} : { answerMode }),
      }),
      question: scalarText(row.question ?? ''),
      ...(sourceRefs === undefined ? {} : { sourceRefs }),
      ...(options !== undefined && options.length > 0 ? { options } : {}),
      ...(helper === undefined ? {} : { helper }),
      ...(followUp === undefined ? {} : { followUp }),
    } satisfies InterviewQuestion
  })
  return { questions: questions.map(normalizeQuestionControls), ...(typeof (value as { packId?: unknown }).packId === 'string' ? { declaredPackId: (value as { packId: string }).packId } : {}) }
}

/** Extract every top-level JSON object from a response that may contain prose,
 * model reasoning, markdown fences, or more than one object.  Taking only the
 * first object is unsafe because DSH may put a small diagnostic object before
 * the actual question-pack JSON. */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return objects
}

/** Parse structured or legacy Markdown model output without inventing missing sources.
 * @param text - Original model response text.
 * @returns normalized candidates, or null when no pack is present.
 */
export function parseAgentQuestionPack(text: string): ParsedQuestionPack | null {
  const normalized = text.replaceAll('\r', '').replace(/```(?:markdown)?/gi, '')
  const jsonBlock = text.match(/```json\s*([\s\S]*?)```/i)?.[1]
  const embeddedJsons = extractJsonObjects(normalized)
  // Prefer objects that look like the required contract, while retaining the
  // full text and fenced block for backwards-compatible markdown responses.
  const preferredJsons = embeddedJsons.filter(candidate => /["']questions["']\s*:/.test(candidate) && candidate.includes('sourceRefs'))
  const candidates = [...new Set([
    ...preferredJsons,
    jsonBlock,
    normalized.trim(),
    ...embeddedJsons,
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.trim() !== ''))]
  for (const candidate of candidates) {
    try {
      const structured = normalizeStructuredQuestions(JSON.parse(candidate))
      if (structured !== null && structured.questions.length > 0) return structured
    } catch { /* fall through to Markdown compatibility parsing */ }
  }
  const heading = /^\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:\*\*)?Q\s*(\d{1,2})\s*[.．、:：]\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?\s*$/gm
  const matches = [...normalized.matchAll(heading)]
  if (matches.length < 3) return null
  return { questions: matches.map((match, index) => {
    const number = match[1]
    const headingText = match[2]
    if (number === undefined || headingText === undefined) throw new Error('Invalid matched question heading')
    const start = match.index + match[0].length
    const end = matches[index + 1]?.index ?? normalized.length
    const body = normalized.slice(start, end)
    const lines = body.split('\n').map(line => line.trim()).filter(Boolean)
    const field = (label: string): string | undefined => {
      const line = lines.find(value => value.includes(label))
      if (line === undefined) return undefined
      return line.replace(/^[-*•\s]+/, '').replace(new RegExp(`^${label}[：:]?\s*`), '').trim()
    }
    const question = headingText.replace(/^[-*]+\s*/, '').replace(/\*+$/, '').trim()
    const type = field('回答类型') ?? '开放式叙述'
    const helper = field('选项辅助')
    const followUp = field('追问触发')
    const confirmation = field('专家确认点')
    const source = field('来源') ?? field('信息来源')
    const title = (question.split(/[—、，,：:？?]/)[0] ?? '').slice(0, 18) || `问题 ${number}`
    const options = helper === undefined || helper === '无'
      ? undefined
      : splitQuestionOptions(helper)
    const sourceRefs: readonly QuestionSourceRef[] | undefined = source === undefined
      ? undefined
      : [{ sourceType: 'model_inference', title: source, locator: 'Agent 返回的问题包文本', rationale: '来源由 Agent 在兼容 Markdown 输出中声明，发布前仍需主持人核验。', confidence: 'medium', requiresConfirmation: true }]
    const parsed: InterviewQuestion = { id: `Q${number.padStart(2, '0')}`, title, type, question, followupPolicy: questionFollowupPolicy({ type, ...(options ? { options } : {}) }), ...(sourceRefs === undefined ? {} : { sourceRefs }), ...(options !== undefined && options.length > 0 ? { options } : {}) }
    if (helper !== undefined && helper !== '无') parsed.helper = helper
    if (followUp !== undefined) parsed.followUp = followUp
    if (confirmation !== undefined) parsed.helper = parsed.helper === undefined ? `专家确认点：${confirmation}` : `${parsed.helper}；专家确认点：${confirmation}`
    return normalizeQuestionControls(parsed)
  }) }
}


/** Build the same version/provenance metadata for UI and command-line generation.
 * @param input - Validated generated questions and their actual session/material identifiers.
 * @returns metadata bound to this generated question array.
 */
export function createQuestionPackMeta(input: {
  questions: readonly InterviewQuestion[]
  sessionId: string
  generatedAt: string
  packId: string
  version: number
  references: readonly (Pick<GlobalReferenceDocument, 'id' | 'title' | 'version' | 'markdown'> & Partial<GlobalReferenceDocument>)[]
}): QuestionPackMeta {
  return { packId: input.packId, version: input.version, generatedAt: input.generatedAt,
    sourceSessionId: input.sessionId, checksum: checksumQuestionPack(input.questions),
    globalReferences: input.references.map(document => ({ id: document.id, title: document.title,
      version: document.version, contentHash: checksumText(document.markdown),
      ...(document.sourceFile ? { sourceFile: document.sourceFile } : {}),
      ...(document.sourceHash ? { sourceHash: document.sourceHash } : {}),
      excerpts: referenceExcerpts({ enabled: true, updatedAt: '', ...document }),
    })) }
}
