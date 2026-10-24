/** Full-width JD workbench entry; native model records remain available on request. */
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { createJdResearchRoute } from './jdResearchRoute.ts'
import css from './JdResearchSurface.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Saved research workbench in the main conversation column. */
    'polus.jd.workbench': { kind: 'single'; scope: 'session' }
  }
}

type ResearchRoute = ReturnType<typeof createJdResearchRoute>
type Props = PropsRuntime<'conversation'> & PropsRenderSlots<'polus.jd.workbench'> & {
  route: ResearchRoute
  createSearch: () => Promise<void>
  closeDetails: () => void
}

/** Render the selected research without exposing raw conversation records by default.
 * @param props - Current session, workbench outlet and project routing actions.
 * @returns Workbench, loading state or an actionable empty search state.
 */
export function JdResearchSurface({ sessionId, renderSlot, route, createSearch, closeDetails }: Props) {
  const state = useSyncExternalStore(route.subscribe, route.getSnapshot, route.getSnapshot)
  const [error, setError] = useState('')
  useLayoutEffect(closeDetails, [closeDetails])
  const hasProject = sessionId !== undefined && state.sessions.has(sessionId)
  return <section className={css.surface} aria-label="JD 研究工作台">
    <div className={css.toolbar}>{hasProject && <button type="button" onClick={() => { route.showLogs() }}>查看运行记录</button>}</div>
    {state.route === 'loading' ? <p className={css.empty} role="status">正在恢复搜索…</p>
      : hasProject ? <div className={css.workbench}>{renderSlot('polus.jd.workbench', {})}</div>
        : <div className={css.empty}><h1>岗位研究</h1><p>选择一条搜索记录，或新建搜索。</p>
          {(error || state.error) && <p role="alert">{error || state.error}</p>}
          <button type="button" onClick={() => { void createSearch().catch((reason: unknown) => {
            setError(reason instanceof Error ? reason.message : '新建搜索失败')
          }) }}>新建搜索</button>
        </div>}
  </section>
}

/** Return from native conversation records to the selected research.
 * @param props - Explicit workbench action.
 * @returns Header action rendered only while native logs are selected.
 */
export function JdResearchReturn({ showWorkbench }: { showWorkbench: () => void }) {
  return <button type="button" className={css.returnButton} onClick={showWorkbench}>返回JD工作台</button>
}
