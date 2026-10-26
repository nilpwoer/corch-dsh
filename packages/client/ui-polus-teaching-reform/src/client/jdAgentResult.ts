/** JD workflow results read from admitted user messages and completed session turns. */
import type {
  AssistantMessageNode, ConversationSnapshot, SessionFace, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { buildJdSearchPrompt } from './jdSearchPrompt.ts'
import type { JdSearchJob, JdSearchRequest } from './types.ts'

type ResultSnapshot = Pick<ConversationSnapshot, 'nodes' | 'turnEnds'>
type PromptSession = Pick<SessionFace, 'getSnapshot' | 'subscribe' | 'prompt'>
type EndedTurn = { turn: number; endSeq: number }

const SEARCH_PREFIX = '执行一次岗位 JD 搜索。搜索条件：'

function userText(node: UserMessageNode): string | undefined {
  const block = node.content[0]
  return node.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

function endedTurn(snapshot: ResultSnapshot, userSeq: number): EndedTurn | undefined {
  const next = [...snapshot.turnEnds].filter(([, seq]) => seq > userSeq)
    .sort((left, right) => left[1] - right[1])[0]
  return next === undefined ? undefined : { turn: next[0], endSeq: next[1] }
}

function finalAssistant(snapshot: ResultSnapshot, userSeq: number, ended: EndedTurn): AssistantMessageNode {
  const nodes = snapshot.nodes.filter(node => node.seq > userSeq)
  const failure = nodes.find(node => node.kind === 'turn-error' && node.turn === ended.turn)
  if (failure?.kind === 'turn-error') throw new Error(`Agent 执行失败：${failure.message}`)
  if (nodes.some(node => node.kind === 'turn-max-tokens' && node.turn === ended.turn)) {
    throw new Error('Agent 输出达到长度上限，请调整搜索范围后重试')
  }
  const assistants = nodes.filter((node): node is AssistantMessageNode => node.kind === 'assistant' && node.turn === ended.turn)
  const last = assistants.at(-1)
  if (last === undefined) throw new Error('Agent 已结束本次任务，但没有返回结果')
  if (assistants.some(node => node.interrupted === true)) throw new Error('Agent 任务已中止，请重试')
  return last
}

function assistantText(node: AssistantMessageNode): string {
  const text = node.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n').trim()
  if (text === '') throw new Error('Agent 已结束本次任务，但没有返回文字结果')
  return text
}

/**
 * Send from an idle session and wait for the next ended turn containing its durable user message.
 * @param session - Session snapshot, subscription and prompt operations.
 * @param prompt - Exact text to admit as one user message.
 * @param signal - Cancels this wait and any pending prompt RPC; an accepted host task is not stopped.
 * @returns Final assistant text after its turn/end and session idle; rejects on admission, lifecycle or cancellation errors.
 */
export async function promptJdAgent(session: PromptSession, prompt: string, signal?: AbortSignal): Promise<string> {
  const cancellation = (): Error => signal?.reason instanceof Error && signal.reason.name !== 'AbortError'
    ? signal.reason : new Error('已取消等待 Agent 结果')
  if (signal?.aborted) throw cancellation()
  const initial = session.getSnapshot()
  if (initial.removed) throw new Error('当前 JD 搜索会话已移除')
  if (initial.openError !== null) throw new Error(`无法读取 JD 搜索会话：${initial.openError.message}`)
  if (initial.running || initial.queue.length > 0) throw new Error('当前会话仍有任务正在运行或排队，请完成后重试')
  const baseline = Math.max(0, ...initial.nodes.map(node => node.seq), ...initial.turnEnds.values())

  return await new Promise<string>((resolve, reject) => {
    let settled = false
    let accepted = false
    let completedText: string | undefined
    let unsubscribe: (() => void) | undefined
    const finish = (result: { error: Error } | { text: string }): void => {
      if (settled) return
      settled = true
      unsubscribe?.()
      signal?.removeEventListener('abort', abort)
      if ('error' in result) reject(result.error)
      else resolve(result.text)
    }
    const abort = (): void => { finish({ error: cancellation() }) }
    const check = (): void => {
      if (settled) return
      try {
        const snapshot = session.getSnapshot()
        if (snapshot.removed) throw new Error('当前 JD 搜索会话已移除')
        // A failed history resync does not end accepted work; durable task events still apply.
        if (!accepted) return
        if (completedText !== undefined) {
          if (!snapshot.running && snapshot.queue.length === 0) finish({ text: completedText })
          return
        }
        const user = snapshot.nodes.find((node): node is UserMessageNode => node.kind === 'user' && node.seq > baseline && userText(node) === prompt)
        if (user !== undefined) {
          const ended = endedTurn(snapshot, user.seq)
          if (ended !== undefined) {
            completedText = assistantText(finalAssistant(snapshot, user.seq, ended))
            if (!snapshot.running && snapshot.queue.length === 0) finish({ text: completedText })
            return
          }
          const interrupted = snapshot.nodes.some(node => node.kind === 'assistant' && node.seq > user.seq && node.interrupted === true)
          if (interrupted) throw new Error('Agent 任务已中止，请重试')
          const failure = snapshot.nodes.find(node => node.kind === 'turn-error' && node.seq > user.seq)
          if (failure?.kind === 'turn-error') throw new Error(`Agent 执行失败：${failure.message}`)
        } else if ([...snapshot.turnEnds.values()].some(seq => seq > baseline)) {
          throw new Error('Agent 已结束任务，但没有记录本次请求的结果')
        }
        if (snapshot.lastAgentError !== null) throw new Error(`Agent 执行失败：${snapshot.lastAgentError}`)
      } catch (error) {
        finish({ error: error instanceof Error ? error : new Error('无法读取 Agent 结果') })
      }
    }

    signal?.addEventListener('abort', abort, { once: true })
    try {
      unsubscribe = session.subscribe(check)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- subscribe can synchronously settle before returning its disposer.
      if (settled) {
        unsubscribe()
        return
      }
      if (signal?.aborted) {
        abort()
        return
      }
      const beforeSend = session.getSnapshot()
      if (beforeSend.running || beforeSend.queue.length > 0) {
        finish({ error: new Error('当前会话仍有任务正在运行或排队，请完成后重试') })
        return
      }
      void session.prompt([{ type: 'text', text: prompt }], 'queue', signal).then((result) => {
        if (settled) return
        if (!result.ok) {
          finish({ error: new Error(`Agent 未接受任务：${result.error.message}`) })
          return
        }
        accepted = true
        check()
      }, (error: unknown) => {
        finish({ error: new Error(`无法发送 Agent 任务：${error instanceof Error ? error.message : '连接失败'}`) })
      })
    } catch (error) {
      finish({ error: error instanceof Error ? error : new Error('无法发送 Agent 任务') })
    }
  })
}

/**
 * Parse the JSON object in an assistant reply, allowing surrounding prose or a code fence.
 * @param text - Final assistant text.
 * @returns Parsed JSON; rejects absent or malformed JSON with a user-facing error.
 */
export function parseJdAgentJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Agent 返回内容不是 JSON')
  try { return JSON.parse(text.slice(start, end + 1)) as unknown } catch { throw new Error('Agent 返回的 JSON 无法解析') }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJob(value: unknown): value is JdSearchJob {
  return isRecord(value)
    && ['id', 'title', 'company', 'place', 'platform', 'summary'].every(key => typeof value[key] === 'string')
    && typeof value.score === 'number' && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100
    && typeof value.body === 'string' && value.body.trim() !== ''
    && (value.sourceUrl === undefined || typeof value.sourceUrl === 'string')
}

/**
 * Validate model-returned JD records, including complete description bodies and unique ids.
 * @param text - Final assistant JSON reply.
 * @returns Validated job records; rejects missing bodies, invalid fields or duplicate ids.
 */
export function parseJdJobs(text: string): readonly JdSearchJob[] {
  const result = parseJdAgentJson(text)
  if (!isRecord(result) || !Array.isArray(result.jobs)) throw new Error('Agent 返回结果缺少 jobs')
  if (!result.jobs.every(isJob)) throw new Error('Agent 返回的岗位缺少完整 JD 正文或包含无效字段')
  if (new Set(result.jobs.map(job => job.id)).size !== result.jobs.length) throw new Error('Agent 返回的岗位编号重复')
  return result.jobs
}

function requestFromPrompt(text: string): JdSearchRequest | undefined {
  const input = text.slice(SEARCH_PREFIX.length)
  for (let end = input.indexOf('}'); end >= 0; end = input.indexOf('}', end + 1)) {
    let request: unknown
    try { request = JSON.parse(input.slice(0, end + 1)) as unknown } catch { continue }
    if (!isRecord(request)
      || !['major', 'direction', 'region', 'publishedWithin', 'targetCount'].every(key => typeof request[key] === 'string')
      || !Array.isArray(request.roles) || !request.roles.every(role => typeof role === 'string')
      || !Array.isArray(request.platforms) || !request.platforms.every(platform => typeof platform === 'string')) return undefined
    const parsed = request as JdSearchRequest
    return buildJdSearchPrompt(parsed) === text ? parsed : undefined
  }
  return undefined
}

/**
 * Recover only the latest search prompt produced by the current prompt builder.
 * @param snapshot - Durable legacy nodes and turn/end sequence numbers.
 * @returns Its validated jobs and final assistant timestamp, or undefined when it is unfinished or invalid.
 */
export function readCompletedJdSearch(
  snapshot: ResultSnapshot,
): { request: JdSearchRequest; jobs: readonly JdSearchJob[]; completedAt: number } | undefined {
  const user = snapshot.nodes.filter((node): node is UserMessageNode => node.kind === 'user' && userText(node)?.startsWith(SEARCH_PREFIX) === true).at(-1)
  if (user === undefined) return undefined
  const text = userText(user)
  if (text === undefined) return undefined
  const request = requestFromPrompt(text)
  if (request === undefined) return undefined
  const ended = endedTurn(snapshot, user.seq)
  if (ended === undefined) return undefined
  try {
    const assistant = finalAssistant(snapshot, user.seq, ended)
    return { request, jobs: parseJdJobs(assistantText(assistant)), completedAt: assistant.time }
  } catch {
    // Invalid or failed model output is not an accepted project to restore.
    return undefined
  }
}
