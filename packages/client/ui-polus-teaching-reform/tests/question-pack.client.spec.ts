import { test, expect } from 'vitest'
import { parseAgentQuestionPack, validateQuestionPack, createQuestionPackMeta, checksumQuestionPack } from '../src/client/questionPack.ts'

const questions = Array.from({ length: 4 }, (_, index) => ({ title: `Fixture ${index + 1}`, question: 'Synthetic parser fixture',
  sourceRefs: [{ sourceType: 'model_inference', title: 'Fixture only', rationale: 'Unit test', confidence: 'low', requiresConfirmation: true }] }))

test('shared parser selects the actual fenced pack and retains hints/sources', () => {
  const parsed = parseAgentQuestionPack('diagnostic {"ok":true}\n```json\n' + JSON.stringify({ questions }) + '\n```')
  expect(parsed?.questions.map(q => q.id)).toEqual(['Q01', 'Q02', 'Q03', 'Q04'])
  expect(validateQuestionPack(parsed!.questions)).toBeNull()
  const meta = createQuestionPackMeta({ questions: parsed!.questions, sessionId: 'actual-test-session', generatedAt: 'test-time',
    packId: 'fixture', version: 1, references: [{ id: 'source', title: 'Supplied source', version: 2, markdown: 'Explicit source text' }] })
  expect(meta.sourceSessionId).toBe('actual-test-session')
  expect(meta.checksum).toBe(checksumQuestionPack(parsed!.questions))
  expect(meta.globalReferences?.[0]?.version).toBe(2)
})

test('incomplete, unreferenced or empty questions cannot pass generation validation', () => {
  expect(parseAgentQuestionPack('no JSON')).toBeNull()
  for (const changed of [questions.slice(0, 2), questions.map(q => ({ ...q, sourceRefs: [] })), questions.map(q => ({ ...q, question: '' }))]) {
    const parsed = parseAgentQuestionPack(JSON.stringify({ questions: changed }))
    expect(validateQuestionPack(parsed!.questions)).not.toBeNull()
  }
})

test('structured text fields reject objects instead of publishing default object strings', () => {
  for (const malformed of [
    { question: { text: 'Nested question' } },
    { title: ['Nested title'] },
    { helper: { text: 'Nested helper' } },
    { helper: [{ trigger: { text: 'Nested trigger' }, next: 'Next' }] },
    { options: [{ label: { text: 'Nested option' } }] },
    { sourceRefs: [{ ...questions[0]?.sourceRefs[0], rationale: { text: 'Nested source rationale' } }] },
  ]) {
    expect(parseAgentQuestionPack(JSON.stringify({
      questions: questions.map(question => ({ ...question, ...malformed })),
    }))).toBeNull()
  }
})
