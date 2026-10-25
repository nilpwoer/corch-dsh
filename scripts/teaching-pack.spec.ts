import { test, expect } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const request = { fieldnoteId: 'synthetic-cli-fixture', goal: 'Synthetic fixture, never a real model generation', questionCount: 4,
  profile: { name: 'Synthetic test', industry: 'Education', role: 'Synthetic teacher', years: 'Synthetic', stage: 'Synthetic', experience: 'No real person' },
  sources: [{ id: 'test', title: 'Explicit fixture source', markdown: 'Synthetic fixture task', version: 1 }],
  interviewPolicy: { scope: 'per_question', maxFollowups: 1 } }

test('real CLI entry uses the Host session carrier and exports shared validated business output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-teaching-cli-'))
  await writeFile(join(root, 'request.json'), JSON.stringify(request))
  const methods: string[] = []
  const modelText = JSON.stringify({ questions: Array.from({ length: 4 }, (_, index) => ({ title: `Fixture ${index + 1}`, question: 'Synthetic fixture question', answerMode: ['text', 'choice', 'mixed', 'other'][index], ...(index === 0 ? {} : { options: ['Standard', 'Other: specify'] }),
    sourceRefs: [{ sourceType: 'model_inference', title: 'Fixture source', rationale: 'Test fixture only', confidence: 'low', requiresConfirmation: true }] })) })
  let prompted = false
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []
    for await (const part of req) parts.push(Buffer.from(part))
    const body = JSON.parse(Buffer.concat(parts).toString()) as { rpcId: string; method: string }
    methods.push(body.method)
    let value: unknown
    switch (body.method) {
      case 'session.create': value = { sessionId: 'fixture-session' }; break
      case 'session.models': value = { current: { provider: 'deepseek-official', model: 'fixture-model' }, routable: true, groups: [], failures: [] }; break
      case 'session.rename': value = { title: 'Fixture session', seq: 0 }; break
      case 'session.prompt': prompted = true; value = { accepted: true }; break
      case 'session.history': value = { hasMore: false, events: prompted ? [
        { event: { type: 'user/message', seq: 1, time: 0, data: {} } },
        { event: { type: 'assistant/message', seq: 2, time: 0, data: { message: { content: [{ type: 'text', text: modelText }] } } } },
        { event: { type: 'turn/end', seq: 3, time: 0, data: { turn: 0, reason: { kind: 'completed' } } } },
      ] : [] }; break
      default: res.writeHead(500); res.end(); return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture listener')
    const result = await run(process.execPath, ['--import', 'tsx/esm', 'scripts/teaching-pack.ts', '--host', `http://127.0.0.1:${address.port}/`,
      '--request', join(root, 'request.json'), '--output', join(root, 'output')], { cwd: process.cwd(), timeout: 30000 })
    const pack = JSON.parse(await readFile(join(root, 'output/publication.json'), 'utf8')) as {
      questions: { id: string; answerMode: string; followupPolicy: { input: string; maxFollowups: number } }[]
      questionPackMeta: { sourceSessionId: string }
      interviewPolicy: typeof request.interviewPolicy
      invitation: { code: string }
    }
    expect(pack.questions).toHaveLength(4)
    expect(pack.questions.map((q: { answerMode: string; followupPolicy: { input: string; maxFollowups: number } }) => [q.answerMode, q.followupPolicy.input, q.followupPolicy.maxFollowups])).toMatchInlineSnapshot(`
      [
        [
          "text",
          "text",
          2,
        ],
        [
          "mixed",
          "text",
          2,
        ],
        [
          "mixed",
          "text",
          2,
        ],
        [
          "mixed",
          "text",
          2,
        ],
      ]
    `)
    expect(pack.questionPackMeta.sourceSessionId).toBe('fixture-session')
    expect(pack.interviewPolicy).toEqual(request.interviewPolicy)
    expect(result.stdout).not.toContain(pack.invitation.code)
    expect(await readFile(join(root, 'output/model-output.txt'), 'utf8')).toBe(modelText + '\n')
    expect(methods).not.toContain('session.selectModel')
    expect(methods.filter(method => method.startsWith('credentials.'))).toEqual([])
    expect({ methods, questions: pack.questions.map((q: { id: string }) => q.id), policy: pack.interviewPolicy }).toMatchInlineSnapshot(`
      {
        "methods": [
          "session.create",
          "session.models",
          "session.rename",
          "session.history",
          "session.prompt",
          "session.history",
        ],
        "policy": {
          "maxFollowups": 1,
          "scope": "per_question",
        },
        "questions": [
          "Q01",
          "Q02",
          "Q03",
          "Q04",
        ],
      }
    `)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}, 40000)
