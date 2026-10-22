// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppRail } from '../src/client/AppRail.tsx'
import { selectSidebarMode } from '../src/client/mode-store.ts'
import { en } from '../src/client/locales.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

const t = (key: string): string => en[key as keyof typeof en] ?? key

afterEach(() => {
  cleanup()
  selectSidebarMode('sessions')
})

describe('App Rail', () => {
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
