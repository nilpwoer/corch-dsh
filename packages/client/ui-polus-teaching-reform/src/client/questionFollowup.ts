/** The publication limit applies to new interviews; Worker overrides may lower it. */
export const MAX_QUESTION_FOLLOWUPS = 2

/** Explicit participant controls; omitted only on legacy question packs. */
export type AnswerMode = 'text' | 'choice' | 'mixed' | 'other'

/** Validate a model, saved draft or publication's explicit answer mode.
 * @param mode - Untrusted mode; undefined retains the legacy policy.
 * @param options - Displayed selection labels.
 * @returns a user-facing error, or null for supported controls.
 */
export function answerModeError(mode: unknown, options: readonly string[] = []): string | null {
  if (mode === undefined) return null
  if (typeof mode !== 'string' || !['text', 'choice', 'mixed', 'other'].includes(mode)) return '回答模式必须为 text、choice、mixed 或 other。'
  if (mode === 'text' && options.length) return '仅文字题不能包含选项；保留辅助选项时请使用混合题。'
  if (mode !== 'text' && options.length === 0) return '选择、混合或其他条件输入题必须提供选项。'
  if (mode === 'other' && !options.some(isOtherOption)) return '其他条件输入题必须包含“其他”选项。'
  return null
}

function isOtherOption(option: string): boolean {
  return /^(?:其他|其它|other)(?:\s|[：:（(]|$)/i.test(option.trim())
}

/** Answer controls that can supply text to a follow-up, including conditional other inputs. */
export type QuestionFollowupPolicy = {
  input: 'text' | 'other' | 'none'
  maxFollowups: number
  otherOptions?: readonly string[]
}

/** Derive follow-up eligibility from the controls the participant actually receives.
 * @param question - Question type and its displayed options.
 * @returns a policy for text, selected other text, or a question without a text input.
 */
export function questionFollowupPolicy(question: {
  type?: string
  options?: readonly string[]
  answerMode?: AnswerMode
}): QuestionFollowupPolicy {
  const options = question.options ?? []
  const error = answerModeError(question.answerMode, options)
  if (error !== null) throw new Error(error)
  switch (question.answerMode) {
    case 'text': case 'mixed': return { input: 'text', maxFollowups: MAX_QUESTION_FOLLOWUPS }
    case 'choice': return { input: 'none', maxFollowups: 0 }
    case 'other': return { input: 'other', maxFollowups: MAX_QUESTION_FOLLOWUPS, otherOptions: options.filter(isOtherOption) }
    case undefined: break
  }
  const type = question.type?.trim().toLowerCase() ?? ''
  if (/授权|确认授权|consent/.test(type)) return { input: 'none', maxFollowups: 0 }
  if (options.length || /选择|单选|多选|choice|radio|checkbox/.test(type)) {
    const otherOptions = options.filter(isOtherOption)
    return otherOptions.length
      ? { input: 'other', maxFollowups: MAX_QUESTION_FOLLOWUPS, otherOptions }
      : { input: 'none', maxFollowups: 0 }
  }
  return { input: 'text', maxFollowups: MAX_QUESTION_FOLLOWUPS }
}
