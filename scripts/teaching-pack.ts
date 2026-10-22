/** Generate a publication through the running DSH Host; never handles provider credentials. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomInt } from 'node:crypto'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { buildInterviewPromptFromTemplate, buildInterviewPromptTemplate } from '../packages/client/ui-polus-teaching-reform/src/client/interviewPrompt.ts'
import { createQuestionPackMeta, parseAgentQuestionPack, validateQuestionPack } from '../packages/client/ui-polus-teaching-reform/src/client/questionPack.ts'
import { createPublication } from '../packages/client/ui-polus-teaching-reform/src/client/publication.ts'

const requestSchema = z.object({
  fieldnoteId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  goal: z.string().trim().min(1), questionCount: z.number().int().min(3).max(100),
  profile: z.object({ name: z.string().min(1), industry: z.string().min(1), role: z.string().min(1),
    years: z.string().min(1), stage: z.string().min(1), experience: z.string().min(1) }).strict(),
  sources: z.array(z.object({ id: z.string().min(1), title: z.string().min(1),
    markdown: z.string().min(1), version: z.number().int().positive() }).strict()).min(1),
  interviewPolicy: z.object({ scope: z.enum(['per_question', 'interview']), maxFollowups: z.number().int().nonnegative() }).strict(),
}).strict()

/** HTTP transport adapter for the existing, loopback-only DSH API. */
class LocalHostClient extends AbstractApiClient {
  constructor(private readonly origin: string) { super(15000) }
  protected override resolveBase(): string { return this.origin }
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> { return fetch(input, init) }
}

function unwrap<T>(response: { result: { ok: true; value: T } | { ok: false; error: { code: string } } }): T {
  if (!response.result.ok) throw new Error(`DSH rejected request: ${response.result.error.code}`)
  return response.result.value
}

/** Generate once in a new DSH session and save model/provenance evidence plus the private publication.
 * @param options - Explicit localhost, request file, exclusive output directory and timeout.
 * @returns non-secret publication identity and actual model/session provenance.
 */
export async function generateTeachingPack(options: { host: string; request: string; output: string; timeoutMs: number }) {
  const host = new URL(options.host)
  if (host.protocol !== 'http:' || host.hostname !== '127.0.0.1' || host.username || host.password || host.pathname !== '/' || host.search || host.hash) {
    throw new Error('Host must be an explicit http://127.0.0.1:port/ origin')
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('Invalid generation timeout')
  const input = requestSchema.parse(JSON.parse(await readFile(options.request, 'utf8')))
  const references = input.sources.map(source => ({ ...source, enabled: true, updatedAt: new Date().toISOString() }))
  const prompt = buildInterviewPromptFromTemplate(input.profile, references, buildInterviewPromptTemplate()) + '\n\n' + [
    `本次任务书目标：${input.goal}`,
    `本次题量明确为恰好 ${input.questionCount} 个主问题，将上述方法框架合并到这些问题中，不要扩展题数。`,
    '这是合成测试任务，不代表真实个人；不得补写实际受访者的经历或回答。仅使用本次提供的资料，不能声称阅读未提供的文献全文。',
    'model_inference 必须 confidence=low 且 requiresConfirmation=true。不要调用工具、修改文件或开展访谈，直接生成 JSON 草稿。',
    `本次实际参考资料完整清单（global_reference 的 title 只能逐字使用这些标题）：${input.sources.map(source => source.title).join('；')}。`,
    '本次没有提供任何 S/A/B 级书籍全文或书目条目。模板中对文献池分级的通用说明不代表已经注入这些书籍，禁止引用所谓文献池中的 S 级文献。方法框架只能标为 methodology（本提示词的方法协议），不能编造 global_reference、外部文献或章节。',
  ].join('\n')
  await mkdir(options.output, { mode: 0o700 }) // Refuse to overwrite any earlier run.
  const save = async (name: string, value: string): Promise<void> => {
    await writeFile(resolve(options.output, name), value, { flag: 'wx', mode: 0o600 })
  }
  await save('request.json', JSON.stringify(input, null, 2) + '\n')
  await save('prompt.txt', prompt + '\n')
  const api = new LocalHostClient(host.origin)
  const { sessionId } = unwrap(await api.sessions.create({}))
  await save('session.json', JSON.stringify({ sessionId, host: host.origin }, null, 2) + '\n')
  const models = unwrap(await api.sessions.models({ sessionId }))
  await save('model.json', JSON.stringify(models.current, null, 2) + '\n')
  if (!models.routable || !/deepseek/i.test(models.current.provider + '/' + models.current.model)) {
    throw new Error('New DSH session is not configured for a routable DeepSeek model; no model preference changed')
  }
  unwrap(await api.sessions.rename({ sessionId, title: `测试题包 ${input.fieldnoteId}` }))
  const baseline = unwrap(await api.sessions.history({ sessionId, maxMessages: 100 }))
  const baselineSeq = baseline.events.reduce((max, row) => Math.max(max, row.event.seq), -1)
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }))
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    const history = unwrap(await api.sessions.history({ sessionId, maxMessages: 100 }))
    const events = history.events.map(row => row.event).filter(event => event.seq > baselineSeq)
    const end = events.findLast(event => event.type === 'turn/end')
    if (end !== undefined && events.some(event => event.type === 'user/message')) {
      if (end.data.reason.kind !== 'completed') throw new Error('DSH turn did not complete successfully')
      const assistant = events.findLast(event => event.type === 'assistant/message')
      if (assistant?.type !== 'assistant/message') throw new Error('DSH turn ended without an assistant result')
      const raw = assistant.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      await save('model-output.txt', raw + '\n')
      const parsed = parseAgentQuestionPack(raw)
      if (!parsed) throw new Error('DSH returned no question pack; raw result retained')
      const error = validateQuestionPack(parsed.questions)
      if (error) throw new Error(error)
      if (parsed.questions.length !== input.questionCount) throw new Error('Generated question count differs from the request')
      for (const question of parsed.questions) {
        for (const ref of question.sourceRefs ?? []) {
          if (ref.sourceType === 'model_inference' && (ref.confidence !== 'low' || ref.requiresConfirmation !== true)) throw new Error('Unconfirmed model inference was presented as evidence')
          if (['uploaded_document', 'official_standard', 'job_description'].includes(ref.sourceType)) throw new Error('Response cited a document category absent from this request')
          if (ref.sourceType === 'global_reference' && !input.sources.some(source => source.title === ref.title)) throw new Error('Response cited an unsupplied reference')
        }
      }
      const generatedAt = new Date().toISOString()
      const meta = createQuestionPackMeta({ questions: parsed.questions, sessionId, generatedAt,
        packId: `QP-${input.fieldnoteId}`, version: 1, references })
      const publication = createPublication({ fieldnoteId: input.fieldnoteId, publicFieldnoteId: input.fieldnoteId,
        goal: input.goal, profile: input.profile, questions: parsed.questions, questionPackMeta: meta,
        invitation: { code: String(randomInt(1000000)).padStart(6, '0'), createdAt: generatedAt, status: 'active' },
        interviewPolicy: input.interviewPolicy }, generatedAt)
      await save('publication.json', JSON.stringify(publication, null, 2) + '\n')
      const evidence = { fieldnoteId: input.fieldnoteId, questions: parsed.questions.length, interviewPolicy: input.interviewPolicy,
        sessionId, model: models.current, generatedAt, questionChecksum: meta.checksum,
        modelOutputSha256: createHash('sha256').update(raw).digest('hex'),
        eventTypes: events.map(event => ({ seq: event.seq, type: event.type })),
        workflow: 'DSH Host session API + shared parser/export; no browser UI acceptance' }
      await save('evidence.json', JSON.stringify(evidence, null, 2) + '\n')
      return evidence
    }
    await delay(1500)
  }
  unwrap(await api.sessions.cancel({ sessionId }))
  throw new Error('Generation timed out; canceled only this CLI-owned session')
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { host: { type: 'string' }, request: { type: 'string' },
    output: { type: 'string' }, 'timeout-ms': { type: 'string', default: '300000' } }, strict: true })
  if (!values.host || !values.request || !values.output) throw new Error('Required: --host --request --output [--timeout-ms]')
  const { eventTypes: _eventTypes, ...summary } = await generateTeachingPack({ host: values.host, request: values.request,
    output: values.output, timeoutMs: Number(values['timeout-ms']) })
  console.log(JSON.stringify(summary, null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Generation failed'); process.exitCode = 1 })
}
