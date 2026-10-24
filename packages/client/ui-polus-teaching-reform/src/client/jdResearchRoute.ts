/** Route saved JD sessions to their workbench while retaining opt-in access to native logs. */
import type { JdProjectSummary } from '../jd/types.ts'

type Route = 'native' | 'loading' | 'workbench'
type Options = {
  currentSession: () => JdProjectSummary['session_id'] | undefined
  subscribeSession: (listener: () => void) => () => void
  ready: () => boolean
  subscribeReady: (listener: () => void) => () => void
  mode: () => string
  selectJd: () => void
  subscribeMode: (listener: () => void) => () => void
  list: () => Promise<JdProjectSummary[]>
}

/** Current routing facts; membership comes only from saved Host projects. */
type JdResearchRouteSnapshot = {
  route: Route
  sessions: ReadonlySet<JdProjectSummary['session_id']>
  error: string
}

/** Coordinate initial saved-session recovery and an explicit native-log view.
 * @param options - Authoritative session, workbench-mode and Host project operations.
 * @returns Observable routing, log/workbench actions, refresh and async disposal.
 */
export function createJdResearchRoute(options: Options) {
  let active = false
  let initial = true
  let ready = false
  let requested = false
  let running: Promise<void> | undefined
  let logsSession: JdProjectSummary['session_id'] | undefined
  let lastSession = options.currentSession()
  let sessions: ReadonlySet<JdProjectSummary['session_id']> = new Set()
  let error = ''
  const isActive = (): boolean => active
  const listeners = new Set<() => void>()
  const route = (): Route => initial && options.ready() && !!options.currentSession() && !ready
    ? 'loading' : options.mode() === 'jd-search' && !(logsSession !== undefined && logsSession === options.currentSession()) ? 'workbench' : 'native'
  let snapshot: JdResearchRouteSnapshot = { route: route(), sessions, error }
  const publish = (): void => {
    if (!active) return
    snapshot = { route: route(), sessions, error }
    for (const listener of listeners) {
      try { listener() }
      catch { /* A failed view notification must not block other views or the project-list refresh. */ }
    }
  }
  const recover = (): void => {
    const id = options.currentSession()
    if (!initial || !ready || !id) return
    initial = false
    if (sessions.has(id) && options.mode() === 'sessions') options.selectJd()
  }
  const refresh = (): Promise<void> => {
    if (!active || !options.ready()) return Promise.resolve()
    requested = true
    running ??= (async () => {
      while (isActive() && requested) {
        requested = false
        try {
          const projects = await options.list()
          if (!isActive()) return
          sessions = new Set(projects.map(item => item.session_id))
          error = ''
        } catch (reason) {
          if (!isActive()) return
          error = reason instanceof Error ? reason.message : '搜索记录暂时无法读取'
        }
        ready = true
        recover()
        publish()
      }
    })().finally(() => { running = undefined; if (active && requested) void refresh() })
    return running
  }
  return {
    getSnapshot: (): JdResearchRouteSnapshot => snapshot,
    subscribe(this: void, listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh,
    showLogs(this: void): void { logsSession = options.currentSession(); publish() },
    showWorkbench(this: void): void { logsSession = undefined; publish() },
    start(): () => Promise<void> {
      active = true
      const offSession = options.subscribeSession(() => {
        const id = options.currentSession()
        if (id !== lastSession) { logsSession = undefined; lastSession = id }
        recover()
        publish()
      })
      const offReady = options.subscribeReady(() => { publish(); void refresh() })
      const offMode = options.subscribeMode(() => {
        initial = false
        if (options.mode() !== 'jd-search') logsSession = undefined
        publish()
      })
      void refresh()
      return async () => {
        active = false
        listeners.clear()
        offSession(); offReady(); offMode()
        await running
      }
    },
  }
}
