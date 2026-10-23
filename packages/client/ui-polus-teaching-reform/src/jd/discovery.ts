/** Session-scoped discovery policy enforced before any JD model tool dispatch. */
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { JdProjectSummary } from './types.ts'

type ResearchSessionId = JdProjectSummary['session_id']

/** JD sessions can search for links within an explicit bounded operation; all other tools stay denied. */
export class JdDiscoveryGuard {
  private readonly sessions = new Set<ResearchSessionId>()
  private readonly remaining = new Map<ResearchSessionId, number>()
  /** Restored project ownership must load successfully before the Host exposes JD operations. */
  readonly ready: Promise<void>

  /** Install the execution gate before reading saved project ownership.
   * @param ctx - Host tool event context.
   * @param projects - Authoritative saved project roster, including restored sessions.
   * @param maxCalls - Maximum search calls in one discovery operation.
   */
  constructor(ctx: Context, projects: Promise<JdProjectSummary[]>, private readonly maxCalls: number) {
    this.ready = projects.then((items) => { for (const item of items) this.remember(item.session_id) })
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      await this.ready
      const id = exec.agent?.session.id
      if (id === undefined || !this.sessions.has(id)) return next()
      if (exec.name !== 'web_search') return { kind: 'deny', reason: 'JD 研究仅允许搜索候选链接；正文由浏览器采集，禁止匿名抓取、Shell 和其他工具。' }
      const remaining = this.remaining.get(id)
      if (remaining === undefined || remaining <= 0)
        return { kind: 'deny', reason: 'JD 链接搜索未启动、已结束或已达到本次调用上限，请返回已发现的候选链接。' }
      this.remaining.set(id, remaining - 1)
      return next()
    })
  }

  /** Protect a session immediately after its project is saved.
   * @param id - Saved project's owning conversation.
   */
  remember(id: ResearchSessionId): void { this.sessions.add(id) }

  /** Open one bounded operation for a saved research conversation.
   * @param id - Conversation verified against the project repository.
   * @returns Settlement after restored session ownership is loaded.
   */
  async begin(id: ResearchSessionId): Promise<void> {
    await this.ready
    if (!this.sessions.has(id)) throw new Error('当前会话不是已存档的 JD 搜索')
    if (this.remaining.has(id)) throw new Error('该 JD 搜索尚未结束，请等待当前搜索完成')
    this.remaining.set(id, this.maxCalls)
  }

  /** Close search permission without removing the permanent JD tool restriction.
   * @param id - Owning conversation; late calls remain denied.
   */
  end(id: ResearchSessionId): void { this.remaining.delete(id) }
}
