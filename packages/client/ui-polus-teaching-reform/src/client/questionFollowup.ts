/** The publication limit applies to new interviews; Worker overrides may lower it. */
export const MAX_QUESTION_FOLLOWUPS = 2

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
export function questionFollowupPolicy(question: { type?: string; options?: readonly string[] }): QuestionFollowupPolicy {
  const type = question.type?.trim().toLowerCase() ?? ''
  if (/授权|确认授权|consent/.test(type)) return { input: 'none', maxFollowups: 0 }
  const options = question.options ?? []
  if (options.length || /选择|单选|多选|choice|radio|checkbox/.test(type)) {
    const otherOptions = options.filter(option => /^(?:其他|其它|other)(?:\s|[：:（(]|$)/i.test(option.trim()))
    return otherOptions.length
      ? { input: 'other', maxFollowups: MAX_QUESTION_FOLLOWUPS, otherOptions }
      : { input: 'none', maxFollowups: 0 }
  }
  return { input: 'text', maxFollowups: MAX_QUESTION_FOLLOWUPS }
}
