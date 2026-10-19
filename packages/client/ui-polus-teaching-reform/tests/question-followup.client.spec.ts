import { test } from 'vitest'
import assert from 'node:assert/strict'
import { questionFollowupPolicy } from '../src/client/questionFollowup.ts'
import { createPublication } from '../src/client/publication.ts'

test('text eligibility matches open, choice, consent and conditional other controls', () => {
  for (const [question, expected] of [
    [{ type: '开放回忆' }, { input: 'text', maxFollowups: 2 }],
    [{ type: '单项选择', options: ['甲', '不适用'] }, { input: 'none', maxFollowups: 0 }],
    [{ type: '多项选择' }, { input: 'none', maxFollowups: 0 }],
    [{ type: '授权确认', options: ['同意', '其他'] }, { input: 'none', maxFollowups: 0 }],
    [{ type: '多项选择', options: ['甲', '其他（请说明）'] }, { input: 'other', maxFollowups: 2, otherOptions: ['其他（请说明）'] }],
    [{ type: 'radio', options: ['A', 'Other: specify'] }, { input: 'other', maxFollowups: 2, otherOptions: ['Other: specify'] }],
    [{ type: '单项选择', options: ['其他部门'] }, { input: 'none', maxFollowups: 0 }],
  ] as const) assert.deepEqual(questionFollowupPolicy(question), expected)
})

test('published questions carry input conditions with the package default', () => {
  const result = createPublication({
    fieldnoteId: 'synthetic', publicFieldnoteId: 'synthetic', goal: '合成策略测试', profile: {},
    questions: [{ type: '授权确认', options: ['同意'] }, { type: '开放式叙述' }, { type: '单项选择', options: ['甲', '其他'] }],
    questionPackMeta: { version: 1 }, invitation: undefined, interviewPolicy: undefined,
  }, 'synthetic')
  assert.deepEqual(result.interviewPolicy, { scope: 'per_question', maxFollowups: 2 })
  assert.deepEqual(result.questions.map(q => q.followupPolicy.input), ['none', 'text', 'other'])
  assert.deepEqual(result.questions.map(q => q.followupPolicy.maxFollowups), [0, 2, 2])
})
