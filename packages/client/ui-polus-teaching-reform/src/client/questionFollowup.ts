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
  return /^(?:其他或补充|其他|其它|other)(?:\s|[：:（(，,／/]|$)/i.test(option.trim())
}

/** Answer controls that can supply text to a follow-up, including conditional other inputs. */
export type QuestionFollowupPolicy = {
  input: 'text' | 'other' | 'none'
  maxFollowups: number
  otherOptions?: readonly string[]
}

/** Interpret legacy publication controls before normalizing current expert questions.
 * @param question - Question type and its displayed options.
 * @returns the persisted policy metadata; current drafts use normalizeQuestionControls.
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

function retiredQuestionOption(option: string): boolean {
  const label = option.trim()
  return /^(?:暂不使用|暂不适用|不适用|以上均不适用)(?:$|[\s（(：:，,。；;／/])/.test(label)
    || label === '不适用或需与单位确认'
    || /^(?:不确定|说不准|无法回答|不便回答|不愿回答|暂不回答|请补充|请说明)$/.test(label)
    || /^(?:其他|其它)(?:或补充)?(?:$|[\s（(：:，,。；;／/])/.test(label)
    || /^other(?:$|[:：(（]|\s+(?:[:：(（]|please\b|specify\b))/i.test(label)
}

/** Normalize newly generated, edited and exported expert questions without mutating history.
 * @param question - Current draft or legacy question, including auxiliary choices.
 * @returns a permanent text control and substantive options; generic Other and non-applicable controls are omitted.
 */
export function normalizeQuestionControls<T extends {
  options?: readonly string[] | undefined
  answerMode?: AnswerMode | undefined
}>(question: T) {
  const { options: original, answerMode: _mode, ...kept } = question
  const candidates = original?.map(option => option.trim()).filter(Boolean) ?? []
  const options = candidates.filter(option => !retiredQuestionOption(option))
  return { ...kept, ...(options.length ? { options } : {}),
    answerMode: options.length ? 'mixed' as const : 'text' as const,
    followupPolicy: { input: 'text' as const, maxFollowups: MAX_QUESTION_FOLLOWUPS },
  }
}
