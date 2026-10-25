import { readFileSync } from 'node:fs'
import { test, expect } from 'vitest'
import { answerModeError, normalizeQuestionControls, questionFollowupPolicy, type AnswerMode } from '../src/client/questionFollowup.ts'
import { parseAgentQuestionPack, validateQuestionPack } from '../src/client/questionPack.ts'
import { createPublication } from '../src/client/publication.ts'
import { buildInterviewPromptFromTemplate } from '../src/client/interviewPrompt.ts'

const modes: readonly AnswerMode[] = ['text', 'choice', 'mixed', 'other']
const rawQuestions = modes.map(answerMode => ({ title: answerMode, type: '开放回忆', answerMode, question: '合成任务，不含用户资料',
  ...(answerMode === 'text' ? {} : { options: ['常规方式', '其他（请说明）'] }),
  sourceRefs: [{ sourceType: 'model_inference', title: '合成测试', rationale: '固定测试数据', confidence: 'low', requiresConfirmation: true }],
}))

test('legacy model modes normalize to permanent narrative controls through saving and republishing', () => {
  const parsed = parseAgentQuestionPack(JSON.stringify({ questions: rawQuestions }))!
  expect(validateQuestionPack(parsed.questions)).toBeNull()
  expect(parsed.questions.map(q => q.followupPolicy?.input)).toEqual(['text', 'text', 'text', 'text'])
  const saved = JSON.parse(JSON.stringify(parsed.questions)) as typeof parsed.questions
  const make = (questions: typeof saved, version: number) => createPublication({ fieldnoteId: 'synthetic-modes', publicFieldnoteId: 'synthetic-modes',
    goal: '合成验证', profile: {}, questions, questionPackMeta: { version }, invitation: undefined, interviewPolicy: undefined }, 'fixed-time')
  const first = make(saved, 1)
  expect(first.questions.map(q => q.answerMode)).toEqual(['text', 'mixed', 'mixed', 'mixed'])
  const edited = saved.map(q => q.id === 'Q02' ? { ...q, title: '编辑后仍保留文字输入' } : q)
  const second = make(edited, 2)
  expect(second.questions[1]?.followupPolicy).toEqual({ input: 'text', maxFollowups: 2 })
  expect(first.questions[1]?.followupPolicy).toEqual({ input: 'text', maxFollowups: 2 })
  expect(second.questions.map(q => q.answerMode)).toEqual(['text', 'mixed', 'mixed', 'mixed'])
  expect(second.questions.map(q => q.followupPolicy.maxFollowups)).toEqual([2, 2, 2, 2])
  const reloaded = JSON.parse(JSON.stringify(second)) as typeof second
  expect(reloaded.questions.map(q => q.answerMode)).toEqual(['text', 'mixed', 'mixed', 'mixed'])
})

test('explicit modes never infer choice from topic labels or auxiliary options', () => {
  expect(questionFollowupPolicy({ type: '单项选择', answerMode: 'mixed', options: ['甲', '乙'] })).toEqual({ input: 'text', maxFollowups: 2 })
  expect(questionFollowupPolicy({ type: '开放回忆', answerMode: 'choice', options: ['甲', '其他'] })).toEqual({ input: 'none', maxFollowups: 0 })
  expect(questionFollowupPolicy({ type: '开放回忆', options: ['甲', '其他'] }).input).toBe('other')
  expect(questionFollowupPolicy({ type: '开放回忆' }).input).toBe('text')
  for (const mode of ['', null, ['mixed'], 'unknown']) expect(answerModeError(mode, ['甲'])).not.toBeNull()
  for (const [mode, options] of [['text', ['甲']], ['choice', []], ['mixed', []], ['other', ['其他部门']]] as const) {
    expect(answerModeError(mode, options)).not.toBeNull()
    expect(parseAgentQuestionPack(JSON.stringify({ questions: [{ ...rawQuestions[0], answerMode: mode, options }] }))).toBeNull()
  }
})

test('stored older prompt templates still receive the answer-control protocol', () => {
  const prompt = buildInterviewPromptFromTemplate({ name: '合成', industry: '', role: '', years: '', stage: '', experience: '' }, [], '旧自定义模板 {{expert.name}}')
  expect(prompt).toContain('旧自定义模板 合成')
  for (const mode of modes) expect(prompt).toContain(mode)
  expect(prompt).toContain('所有专家题默认显示文字输入框')
  expect(prompt).toContain('options 只能包含实质回答选项')
  expect(prompt).toContain('也不是选项，专家直接在始终显示的文字框填写回答或补充说明')
})

test('generation, markdown conversion and publication retire skip labels without mutating saved questions', () => {
  const questions = rawQuestions.map((q, i) => ({ ...q, ...(i ? { options: ['正常选项', '暂不使用', '其他，请补充', '暂不使用数字工具的原因'] } : {}) }))
  const before = JSON.stringify(questions)
  const generated = parseAgentQuestionPack(JSON.stringify({ questions }))!
  expect(generated.questions[1]?.options).toEqual(['正常选项', '暂不使用数字工具的原因'])
  const publication = createPublication({ fieldnoteId: 'synthetic', publicFieldnoteId: 'synthetic', goal: '合成', profile: {}, questions,
    questionPackMeta: { version: 1 }, invitation: undefined, interviewPolicy: undefined }, 'fixed')
  expect(publication.questions[3]?.answerMode).toBe('mixed')
  expect(publication.questions[1]?.options).toEqual(generated.questions[1]?.options)
  expect(JSON.stringify(questions)).toBe(before)
  const markdown = Array.from({ length: 3 }, (_, i) => `Q${i+1}. 合成问题
回答类型：多项选择
选项辅助：正常选项 / 暂不使用 / 其他`).join('\n')
  const converted = parseAgentQuestionPack(markdown)!
  expect(converted.questions.every(q => q.answerMode === 'mixed' && q.followupPolicy?.input === 'text')).toBe(true)
  expect(converted.questions[0]?.options).toEqual(['正常选项'])
})

const observedLabels = JSON.parse(readFileSync(new URL('./fixtures/control-option-labels.json', import.meta.url), 'utf8')) as { observed: string[]; requested: string[] }

test('actual published control labels are omitted in every position while originals and substantive options remain', () => {
  const labels = [...new Set([...observedLabels.observed, ...observedLabels.requested])]
  for (const label of labels) {
    for (const options of [[label, '其他部门协作', '说明不适用条款的流程'], ['其他部门协作', label, '说明不适用条款的流程']]) {
      const original = { answerMode: 'mixed' as const, options, question: '题干中的不适用条件与其他部门内容仍保留' }
      const before = JSON.stringify(original)
      const result = normalizeQuestionControls(original)
      expect(result.options, label).toEqual(['其他部门协作', '说明不适用条款的流程'])
      expect(result.question).toBe(original.question)
      expect(JSON.stringify(original)).toBe(before)
    }
  }
  const normal = ['不适用条款的处理', '说明不适用的条件', '暂不使用数字工具的原因', '不适用或违约条款说明', '其他部门协作', 'Other departments collaboration']
  expect(normalizeQuestionControls({ options: normal }).options).toEqual(normal)
  expect(normalizeQuestionControls({ options: ['其他，请补充', '暂不适用/无法回答'] })).toEqual({ answerMode: 'text', followupPolicy: { input: 'text', maxFollowups: 2 } })
})

test('markdown keeps substantive parenthesized business text and removes split control fragments', () => {
  const text = Array.from({ length: 3 }, (_, i) => `Q${i + 1}. 说明不适用条件的处理
回答类型：多项选择
选项辅助：正常选项（不适用时保留原文，按流程处理） / 其他，请补充 / 不适用/不确定`).join('\n')
  const result = parseAgentQuestionPack(text)!
  expect(result.questions[0]?.options).toEqual(['正常选项（不适用时保留原文，按流程处理）'])
  expect(result.questions[0]?.question).toContain('不适用条件')
  const oldOther = parseAgentQuestionPack(JSON.stringify({ questions: [{ ...rawQuestions[3], options: ['实质业务选项', '其他或补充（请说明）', '不适用'] }] }))!
  expect(oldOther.questions[0]?.options).toEqual(['实质业务选项'])
  expect(oldOther.questions[0]?.answerMode).toBe('mixed')
})
