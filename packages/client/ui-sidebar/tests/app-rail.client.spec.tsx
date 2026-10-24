// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppRail } from '../src/client/AppRail.tsx'
import { selectSidebarMode } from '../src/client/mode-store.ts'
import { en } from '../src/client/locales.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

const t = (key: string): string => en[key as keyof typeof en] ?? key

afterEach(() => {
  cleanup()
  selectSidebarMode('sessions')
  vi.useRealTimers()
})

describe('App Rail', () => {
  it('keeps JD research in the main column when entering or selecting it again', () => {
    vi.useFakeTimers()
    const openDetails = vi.fn()
    const closeDetails = vi.fn()
    render(<AppRail collapsed={false} toggleSidebar={vi.fn()} openDetails={openDetails}
      closeDetails={closeDetails} t={t} renderSlot={() => null} />)
    const jd = screen.getByRole('button', { name: 'JD search' })
    fireEvent.click(jd)
    fireEvent.click(jd)
    act(() => { vi.runOnlyPendingTimers() })
    expect(jd.getAttribute('aria-pressed')).toBe('true')
    expect(closeDetails).toHaveBeenCalledTimes(2)
    expect(openDetails).not.toHaveBeenCalled()
  })

  it('retains the detail-panel entry for expert interviews', () => {
    vi.useFakeTimers()
    const openDetails = vi.fn()
    render(<AppRail collapsed={false} toggleSidebar={vi.fn()} openDetails={openDetails}
      closeDetails={vi.fn()} t={t} renderSlot={() => null} />)
    const interviews = screen.getByRole('button', { name: 'Expert interviews' })
    fireEvent.click(interviews)
    fireEvent.click(interviews)
    act(() => { vi.runOnlyPendingTimers() })
    expect(openDetails).toHaveBeenCalledTimes(2)
  })

  it('discards an earlier detail reopening after selecting JD research', () => {
    vi.useFakeTimers()
    const openDetails = vi.fn()
    render(<AppRail collapsed={false} toggleSidebar={vi.fn()} openDetails={openDetails}
      closeDetails={vi.fn()} t={t} renderSlot={() => null} />)
    const interviews = screen.getByRole('button', { name: 'Expert interviews' })
    fireEvent.click(interviews)
    openDetails.mockClear()
    fireEvent.click(interviews)
    fireEvent.click(screen.getByRole('button', { name: 'JD search' }))
    act(() => { vi.runOnlyPendingTimers() })
    expect(openDetails).not.toHaveBeenCalled()
  })

  it('switches the shared workbench mode and exposes teaching reform entries', () => {
    const toggleSidebar = vi.fn()
    const renderSlot: PropsRenderSlots<'sidebar.settings'>['renderSlot'] = () => <button type="button" aria-label="Settings" />
    selectSidebarMode('curriculum')
    render(
      <AppRail collapsed={false} toggleSidebar={toggleSidebar} openDetails={vi.fn()}
        closeDetails={vi.fn()} t={t} renderSlot={renderSlot} />,
    )
    const native = screen.getByRole('button', { name: 'Native sessions' })
    const curriculum = screen.getByRole('button', { name: 'Curriculum builder' })
    expect(native.getAttribute('aria-pressed')).toBe('false')
    expect(curriculum.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(curriculum)
    expect(curriculum.getAttribute('aria-pressed')).toBe('true')
    expect(toggleSidebar).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Expert interviews' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Automation (placeholder)' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
  })
})
