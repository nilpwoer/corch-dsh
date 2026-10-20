import { IconNewChatOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppRailOwnerProps } from '@deepseek-ai/dsh-client-ui-layout/client'
import { TbChalkboardTeacher, TbFileCv, TbUserBolt } from 'react-icons/tb'
import { selectSidebarMode, useSidebarMode } from './mode-store.ts'
import css from './AppRail.module.css'

/** Render the layout-level workbench navigation column. */
type AppRailProps = AppRailOwnerProps & PropsLocale<'sidebar'> & PropsRenderSlots<'sidebar.settings'> & {
  openDetails: () => void
  closeDetails: () => void
}

export function AppRail({ collapsed, toggleSidebar, openDetails, closeDetails, t, renderSlot }: AppRailProps) {
  const mode = useSidebarMode()
  const select = (nextMode: 'sessions' | 'curriculum' | 'interviews' | 'jd-search'): void => {
    if (nextMode === mode && nextMode !== 'sessions') {
      closeDetails()
      window.setTimeout(() => { openDetails() }, 0)
      if (collapsed) toggleSidebar()
      return
    }
    selectSidebarMode(nextMode)
    if (nextMode === 'sessions') closeDetails()
    else openDetails()
    if (collapsed) toggleSidebar()
  }

  return (
    <nav className={css.root} aria-label={t('appRail.label')}>
      <div className={css.group}>
        <Tooltip label={t('appRail.sessions')} side="right" delayMs={350}>
          <button type="button" className={mode === 'sessions' ? css.buttonActive : css.button} aria-label={t('appRail.sessions')} aria-pressed={mode === 'sessions'} onClick={() => { select('sessions') }}>
            <IconNewChatOutline16 size={20} />
          </button>
        </Tooltip>
        <Tooltip label={t('appRail.curriculum')} side="right" delayMs={350}>
          <button type="button" className={mode === 'curriculum' ? css.buttonActive : css.button} aria-label={t('appRail.curriculum')} aria-pressed={mode === 'curriculum'} onClick={() => { select('curriculum') }}><TbChalkboardTeacher size={22} strokeWidth={1.8} /></button>
        </Tooltip>
        <Tooltip label={t('appRail.interviews')} side="right" delayMs={350}>
          <button type="button" className={mode === 'interviews' ? css.buttonActive : css.button} aria-label={t('appRail.interviews')} aria-pressed={mode === 'interviews'} onClick={() => { select('interviews') }}><TbUserBolt size={22} strokeWidth={1.8} /></button>
        </Tooltip>
        <Tooltip label={t('appRail.jdSearch')} side="right">
          <button type="button" className={mode === 'jd-search' ? css.buttonActive : css.button} aria-label={t('appRail.jdSearch')} aria-pressed={mode === 'jd-search'} onClick={() => { select('jd-search') }}><TbFileCv size={22} strokeWidth={1.8} /></button>
        </Tooltip>
      </div>
      <Tooltip label={t('appRail.settings')} side="right" delayMs={350}>
        <div className={css.settings}>
          {renderSlot('sidebar.settings', { wide: false })}
        </div>
      </Tooltip>
    </nav>
  )
}
