import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createPublication } from '../src/client/publication.ts'

const input = {
  fieldnoteId: 'FN-中文', publicFieldnoteId: 'FN-public', goal: '获取真实任务证据',
  profile: { name: '测试专家', years: '10' }, questionPackMeta: { packId: 'pack-test', version: 2 },
  invitation: { code: '000000', status: 'active' },
  questions: [{ id: 'Q01', question: '描述任务', followUp: '可选提示', sourceRefs: [{ title: '问题设计来源' }] }, { id: 'Q02', question: '已删除', deleted: true }],
  interviewPolicy: { scope: 'per_question' as const, maxFollowups: 0 },
}
test('export retains policy, public alias, hints and sources without deleted questions', () => {
  const p = createPublication(input, '2026-10-13')
  assert.equal(p.questions.length, 1)
  const question = p.questions[0]
  assert.ok(question)
  assert.equal(question.followUp, '可选提示')
  const source = question.sourceRefs?.[0]
  assert.ok(source)
  assert.equal(source.title, '问题设计来源')
  assert.equal(p.interviewPolicy?.maxFollowups, 0)
  assert.equal(p.publicFieldnoteId, 'FN-public')
  assert.equal(p.questionPackMeta.version, 2)
})
test('new exports include a two-follow-up package default and retain explicit lower limits', () => {
  const managed = createPublication({ ...input, interviewPolicy: undefined }, 'now')
  assert.deepEqual(managed.interviewPolicy, { scope: 'per_question', maxFollowups: 2 })
  assert.deepEqual(managed.questions[0]?.followupPolicy, { input: 'text', maxFollowups: 2 })
  const serverInvitation = createPublication({ ...input, invitation: undefined, interviewPolicy: undefined }, 'now')
  assert.ok(!JSON.stringify(serverInvitation).includes('invitation'))
  assert.throws(() => createPublication({ ...input, goal: '' }, 'now'))
  assert.throws(() => createPublication({ ...input, interviewPolicy: { scope: 'interview', maxFollowups: -1 } }, 'now'))
  const p = createPublication({ ...input, interviewPolicy: { scope: 'interview', maxFollowups: 2 } }, 'now')
  assert.equal(p.interviewPolicy?.scope, 'interview')
})

test('export rejects invalid form values and missing metadata before producing an upload', () => {
  for (const value of [Number.NaN, 1.5, -1, 3]) {
    assert.throws(() => createPublication({ ...input, interviewPolicy: { scope: 'per_question', maxFollowups: value } }, 'now'))
  }
  assert.throws(() => createPublication({ ...input, interviewPolicy: { scope: 'unsupported', maxFollowups: 1 } as never }, 'now'))
  assert.throws(() => createPublication({ ...input, questionPackMeta: undefined }, 'now'))
  for (const version of [0, 1.5]) {
    assert.throws(() => createPublication({ ...input, questionPackMeta: { version } }, 'now'))
  }
  assert.throws(() => createPublication({ ...input, questions: [] }, 'now'))
  const p = createPublication({ ...input, questions: [{ ...input.questions[0], deleted: false, deletedAt: 'old metadata' }] }, 'now')
  const question = p.questions[0]
  assert.ok(question)
  assert.ok(!('deleted' in question))
  assert.ok(!('deletedAt' in question))
})
