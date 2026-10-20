import { test, expect } from 'vitest'
import { answerModeError, questionFollowupPolicy, type AnswerMode } from '../src/client/questionFollowup.ts'
import { parseAgentQuestionPack, validateQuestionPack } from '../src/client/questionPack.ts'
import { createPublication } from '../src/client/publication.ts'
import { buildInterviewPromptFromTemplate } from '../src/client/interviewPrompt.ts'

const modes: readonly AnswerMode[] = ['text', 'choice', 'mixed', 'other']
const rawQuestions = modes.map(answerMode => ({ title: answerMode, type: '开放回忆', answerMode, question: '合成任务，不含用户资料',
  ...(answerMode === 'text' ? {} : { options: ['常规方式', '其他（请说明）'] }),
  sourceRefs: [{ sourceType: 'model_inference', title: '合成测试', rationale: '固定测试数据', confidence: 'low', requiresConfirmation: true }],
}))

test('model answer modes survive parsing, local persistence, editing and republishing', () => {
  const parsed = parseAgentQuestionPack(JSON.stringify({ questions: rawQuestions }))!
  expect(validateQuestionPack(parsed.questions)).toBeNull()
  expect(parsed.questions.map(q => q.followupPolicy?.input)).toEqual(['text', 'none', 'text', 'other'])
  const saved = JSON.parse(JSON.stringify(parsed.questions)) as typeof parsed.questions
  const make = (questions: typeof saved, version: number) => createPublication({ fieldnoteId: 'synthetic-modes', publicFieldnoteId: 'synthetic-modes',
    goal: '合成验证', profile: {}, questions, questionPackMeta: { version }, invitation: undefined, interviewPolicy: undefined }, 'fixed-time')
  const first = make(saved, 1)
  expect(first.questions.map(q => q.answerMode)).toEqual(modes)
  const edited = saved.map(q => q.answerMode === 'choice' ? { ...q, answerMode: 'mixed' as const } : q)
  const second = make(edited, 2)
  expect(second.questions[1]?.followupPolicy).toEqual({ input: 'text', maxFollowups: 2 })
  expect(first.questions[1]?.followupPolicy).toEqual({ input: 'none', maxFollowups: 0 })
  expect(second.questions.map(q => q.answerMode)).toEqual(['text', 'mixed', 'mixed', 'other'])
  expect(second.questions.map(q => q.followupPolicy.maxFollowups)).toEqual([2, 2, 2, 2])
  const reloaded = JSON.parse(JSON.stringify(second)) as typeof second
  expect(reloaded.questions.map(q => q.answerMode)).toEqual(['text', 'mixed', 'mixed', 'other'])
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
  expect(prompt).toContain('辅助选项不能代替开放叙述')
})
