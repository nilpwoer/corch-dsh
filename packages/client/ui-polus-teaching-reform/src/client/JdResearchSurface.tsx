/** Keep the JD workbench and native conversation together, with compact-width pane selection. */
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
type Props = PropsRuntime<'conversation.presentation'> & PropsRenderSlots<'polus.jd.workbench'> & {
  route: ResearchRoute
  createSearch: () => Promise<void>
  closeDetails: () => void
}

/** Render the selected workbench beside its native conversation, retaining panes during compact navigation.
 * @param props - Current session, workbench outlet and project routing actions.
 * @returns Shared-session workbench and conversation, with loading or empty research states.
 */
export function JdResearchSurface({ sessionId, content, renderSlot, route, createSearch, closeDetails }: Props) {
  const state = useSyncExternalStore(route.subscribe, route.getSnapshot, route.getSnapshot)
  const [error, setError] = useState('')
  const [pane, setPane] = useState<'workbench' | 'conversation'>('workbench')
  useLayoutEffect(closeDetails, [closeDetails])
  const hasProject = sessionId !== undefined && state.sessions.has(sessionId)
  return <section className={css.surface} aria-label="JD 研究工作台">
    <div className={css.toolbar}><div className={css.paneTabs} role="tablist" aria-label="岗位研究视图">
      <button type="button" role="tab" aria-selected={pane === 'workbench'} onClick={() => { setPane('workbench') }}>工作台</button>
      <button type="button" role="tab" aria-selected={pane === 'conversation'} onClick={() => { setPane('conversation') }}>对话</button>
    </div>{hasProject && <button type="button" onClick={() => { route.showLogs() }}>仅显示对话</button>}</div>
    <div className={css.panes} data-active-pane={pane}>
      <div className={css.workbenchPane} aria-label="岗位研究工作台区域">
        {state.route === 'loading' ? <p className={css.empty} role="status">正在恢复搜索…</p>
          : hasProject ? <div className={css.workbench}>{renderSlot('polus.jd.workbench', {})}</div>
            : <div className={css.empty}><h1>岗位研究</h1><p>选择一条搜索记录，或新建搜索。</p>
              {(error || state.error) && <p role="alert">{error || state.error}</p>}
              <button type="button" onClick={() => { void createSearch().catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : '新建搜索失败')
              }) }}>新建搜索</button>
            </div>}
      </div>
      <section className={css.conversationPane} aria-label="岗位研究对话">{content}</section>
    </div>
  </section>
}

/** Return from native conversation records to the selected research.
 * @param props - Explicit workbench action.
 * @returns Header action rendered only while native logs are selected.
 */
export function JdResearchReturn({ showWorkbench }: { showWorkbench: () => void }) {
  return <button type="button" className={css.returnButton} onClick={showWorkbench}>返回JD工作台</button>
}
