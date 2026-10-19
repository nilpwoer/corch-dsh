import { MAX_QUESTION_FOLLOWUPS, questionFollowupPolicy } from './questionFollowup.ts'

/** Package defaults inherited by Worker until an administrator saves an override. */
export type InterviewPolicy = { scope: 'per_question' | 'interview'; maxFollowups: number }

/**
 * Create an uploadable publication while retaining optional hints and sources.
 * @param input - Host data and an optional explicit counting policy, capped at two follow-ups.
 * @param publishedAt - Publication timestamp supplied by the host.
 * @returns the versioned upload payload, excluding deleted questions and deletion metadata.
 */
export function createPublication<T extends { deleted?: boolean; deletedAt?: string; type?: string; options?: readonly string[] }>(input: {
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
  const policy = input.interviewPolicy ?? { scope: 'per_question', maxFollowups: MAX_QUESTION_FOLLOWUPS }
  if (!['per_question', 'interview'].includes(policy.scope) || !Number.isSafeInteger(policy.maxFollowups) || policy.maxFollowups < 0 || policy.maxFollowups > MAX_QUESTION_FOLLOWUPS) {
    throw new Error('追问次数必须为 0 到 2，且需要有效的计数范围。')
  }
  if (!input.questionPackMeta || !Number.isSafeInteger(input.questionPackMeta.version) || input.questionPackMeta.version < 1) throw new Error('问题包尚未生成有效版本。')
  const questions = input.questions.filter(question => !question.deleted).map((question) => {
    const { deleted: _deleted, deletedAt: _deletedAt, ...kept } = question
    return { ...kept, followupPolicy: questionFollowupPolicy(question) }
  })
  if (!questions.length) throw new Error('问题包没有有效问题。')
  return {
    schemaVersion: 1, fieldnoteId: input.fieldnoteId, publicFieldnoteId: input.publicFieldnoteId,
    goal: input.goal.trim(), profile: input.profile, questions, questionPackMeta: input.questionPackMeta,
    invitation: input.invitation, interviewPolicy: policy, publishedAt,
  }
}
