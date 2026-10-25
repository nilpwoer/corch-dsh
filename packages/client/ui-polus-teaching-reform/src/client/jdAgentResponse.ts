/** Correlates one queued JD prompt with its durable turn completion. */
import { displayFailureMessage, type SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

type JdSession = Pick<SessionFace, 'getSnapshot' | 'subscribe' | 'prompt'>
type ResponseOptions = {
  idleTimeoutMs: number
  signal: AbortSignal
  connection?: { getSnapshot: () => boolean; subscribe: (listener: () => void) => () => void }
}

/**
 * Submit once and return the last finalized assistant text after its turn completes.
 * Active generation has no deadline; only idle or disconnected waiting is bounded.
 * Cancellation, transport failures, and unsuccessful turn endings reject without
 * classifying the response as invalid JSON. All observers belong to this request.
 * @param session - session receiving the queued prompt.
 * @param prompt - exact text used to identify its logged user message.
 * @param options - idle deadline, cancellation, and optional transport observer.
 * @returns completed turn text, including empty or malformed output for validation by the caller.
 */
export function requestJdResponse(session: JdSession, prompt: string, options: ResponseOptions): Promise<string> {
  const baseline = session.getSnapshot()
  const baselineSeq = baseline.chat.nodes.values().reduce((max, node) => Math.max(max, node.anchorSeq),
    baseline.nodes.reduce((max, node) => Math.max(max, node.seq), 0))
  let previousAgentError = baseline.lastAgentError
  return new Promise<string>((resolve, reject) => {
    const lifecycle = { settled: false }
    let ownedTurn: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribeSession: (() => void) | undefined
    let unsubscribeConnection: (() => void) | undefined
    let previousProgress: readonly unknown[] = []
    const hasSettled = (): boolean => lifecycle.settled

    const finish = (outcome: { text: string } | { error: unknown }): void => {
      if (lifecycle.settled) return
      lifecycle.settled = true
      if (timer !== undefined) clearTimeout(timer)
      unsubscribeSession?.()
      unsubscribeConnection?.()
      options.signal.removeEventListener('abort', onAbort)
      if ('text' in outcome) resolve(outcome.text)
      else reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)))
    }
    const onAbort = (): void => {
      finish({ error: new DOMException('JD 请求已取消', 'AbortError') })
    }
    const check = (): void => {
      if (lifecycle.settled) return
      try {
        if (options.signal.aborted) { onAbort(); return }
        const snapshot = session.getSnapshot()
        if (snapshot.removed) throw new Error('当前 JD 会话已移除')
        if (snapshot.openError !== null) throw new Error(snapshot.openError.message)
        if (snapshot.lastAgentError !== null && snapshot.lastAgentError !== previousAgentError)
          throw new Error(snapshot.lastAgentError)
        previousAgentError = snapshot.lastAgentError

        const nodes = snapshot.chat.nodes.values() as readonly ChatNode[]
        if (ownedTurn === undefined) {
          const user = nodes.filter((node): node is ChatNode<'user'> => node.kind === 'user'
            && node.anchorSeq > baselineSeq
            && node.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n') === prompt)
            .toSorted((left, right) => left.anchorSeq - right.anchorSeq)
            .find(node => node.location.kind === 'turn' || node.location.kind === 'step')
          if (user !== undefined && (user.location.kind === 'turn' || user.location.kind === 'step'))
            ownedTurn = user.location.turn.turn
        }
        const turn = ownedTurn === undefined ? undefined : snapshot.chat.timeline.turns.get(ownedTurn)
        if (turn?.end !== undefined) {
          const reason = turn.end.data.reason
          if (reason.kind !== 'completed') {
            switch (reason.kind) {
              case 'error': throw new Error(displayFailureMessage(reason.error))
              case 'aborted': throw new Error('生成已停止')
              case 'blocked': throw new Error('生成正在等待处理，请先完成当前操作')
              case 'interrupted': throw new Error('生成已中断，请重新尝试')
              case 'max-tokens': throw new Error('模型输出达到长度限制，未取得完整图谱')
              // Turn-end reasons are plugin-extensible; an unknown ending is
              // never evidence of successful generation.
              default: throw new Error('本次生成未正常完成')
            }
          }
          const last = nodes.filter((node): node is ChatNode<'assistant-step'> => node.kind === 'assistant-step'
            && node.data.turn === ownedTurn && node.data.status === 'settled' && node.data.finalNode !== undefined)
            .toSorted((left, right) => (right.data.finalNode?.seq ?? 0) - (left.data.finalNode?.seq ?? 0))[0]
          finish({ text: last?.data.finalNode?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n').trim() ?? '' })
          return
        }

        const connected = options.connection?.getSnapshot() ?? true
        const progress = [connected, snapshot.running, snapshot.partial,
          nodes.reduce((max, node) => Math.max(max, node.anchorSeq), baselineSeq), ownedTurn, turn?.status,
          ...nodes.filter(node => node.kind === 'assistant-step' && node.data.turn === ownedTurn).map(node => node.data)]
        const changed = progress.length !== previousProgress.length || progress.some((value, index) => value !== previousProgress[index])
        previousProgress = progress
        if (connected && (snapshot.running || turn?.status === 'open')) {
          if (timer !== undefined) clearTimeout(timer)
          timer = undefined
        } else if (timer === undefined || changed) {
          if (timer !== undefined) clearTimeout(timer)
          timer = setTimeout(() => {
            finish({ error: new Error(connected ? 'JD 请求等待响应超时' : 'JD 连接中断，等待恢复超时') })
          }, options.idleTimeoutMs)
        }
      } catch (error) {
        finish({ error })
      }
    }

    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      unsubscribeSession = session.subscribe(check)
      if (hasSettled()) { unsubscribeSession(); return }
      unsubscribeConnection = options.connection?.subscribe(check)
      if (hasSettled()) { unsubscribeSession(); unsubscribeConnection?.(); return }
      check()
      if (lifecycle.settled) return
      // Receipt can arrive before the prompt RPC resolves, so observers must
      // already be live. Both promise branches stay observed after cancellation.
      void session.prompt([{ type: 'text', text: prompt }], 'queue', options.signal).then((result) => {
        if (!result.ok) finish({ error: new Error(result.error.message) })
        else check()
      }, (error: unknown) => { finish({ error }) })
    } catch (error) {
      finish({ error })
    }
  })
}
