/** Legacy package policy; new publications leave policy selection to Worker management. */
export type InterviewPolicy = { scope: 'per_question' | 'interview'; maxFollowups: number }

/**
 * Create an uploadable publication while retaining optional hints and sources.
 * @param input - Host data, with an optional legacy follow-up policy for stable retries.
 * @param publishedAt - Publication timestamp supplied by the host.
 * @returns the versioned upload payload, excluding deleted questions and deletion metadata.
 */
export function createPublication<T extends { deleted?: boolean; deletedAt?: string }>(input: {
  fieldnoteId: string
  publicFieldnoteId: string
  goal: string
  profile: unknown
  questions: readonly T[]
  questionPackMeta: { version: number; [key: string]: unknown } | undefined
  invitation: unknown | undefined
  interviewPolicy: InterviewPolicy | undefined
}, publishedAt: string) {
  if (!input.goal.trim()) throw new Error('请填写本次访谈目标。')
  const policy = input.interviewPolicy
  if (policy && (!['per_question', 'interview'].includes(policy.scope) || !Number.isSafeInteger(policy.maxFollowups) || policy.maxFollowups < 0)) {
    throw new Error('保存的旧版追问策略无效，请检查原题包。')
  }
  if (!input.questionPackMeta || !Number.isSafeInteger(input.questionPackMeta.version) || input.questionPackMeta.version < 1) throw new Error('问题包尚未生成有效版本。')
  const questions = input.questions.filter(question => !question.deleted).map((question) => {
    const { deleted: _deleted, deletedAt: _deletedAt, ...kept } = question
    return kept
  })
  if (!questions.length) throw new Error('问题包没有有效问题。')
  return {
    schemaVersion: 1, fieldnoteId: input.fieldnoteId, publicFieldnoteId: input.publicFieldnoteId,
    goal: input.goal.trim(), profile: input.profile, questions, questionPackMeta: input.questionPackMeta,
    invitation: input.invitation, interviewPolicy: policy, publishedAt,
  }
}
