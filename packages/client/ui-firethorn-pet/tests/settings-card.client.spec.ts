import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { FirethornPetSettingsController } from '../src/client/firethorn-pet-settings-controller.ts'

function scopeFixture(): {
  scope: SettingsScope<{ enabled: boolean }>
  snapshot: () => SettingsScopeSnapshot<{ enabled: boolean }>
} {
  let current: SettingsScopeSnapshot<{ enabled: boolean }> = {
    status: 'ready',
    value: { enabled: true },
    base: { enabled: true },
    user: undefined,
    revision: 0,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set<() => void>()
  const publish = (next: SettingsScopeSnapshot<{ enabled: boolean }>): void => {
    current = next
    for (const listener of listeners) listener()
  }
  const scope: SettingsScope<{ enabled: boolean }> = {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: vi.fn(async (_field: string, enabled: unknown) => {
      publish({ ...current, value: { enabled: enabled as boolean }, user: { enabled } })
    }),
    unset: vi.fn(async () => {
      publish({ ...current, value: { enabled: true }, user: undefined })
    }),
  }
  return { scope, snapshot: () => current }
}

describe('firethorn pet settings card controller', () => {
  it('stages, saves, and resets the visibility override', async () => {
    const fixture = scopeFixture()
    const set = vi.spyOn(fixture.scope, 'set')
    const unset = vi.spyOn(fixture.scope, 'unset')
    const controller = new FirethornPetSettingsController(fixture.scope)
    const face = controller.inject()
    expect(face.hooks.firethornPetCard.getSnapshot()).toMatchObject({ enabled: true, dirty: false })

    face.setEnabled(false)
    expect(face.hooks.firethornPetCard.getSnapshot()).toMatchObject({ enabled: false, dirty: true })
    face.save()
    await vi.waitFor(() => { expect(face.hooks.firethornPetCard.getSnapshot().saving).toBe(false) })
    expect(set).toHaveBeenCalledWith('enabled', false)
    expect(face.hooks.firethornPetCard.getSnapshot()).toMatchObject({ enabled: false, dirty: false, overridden: true })

    face.reset()
    expect(face.hooks.firethornPetCard.getSnapshot()).toMatchObject({ enabled: true, dirty: true, overridden: false })
    face.save()
    await vi.waitFor(() => { expect(face.hooks.firethornPetCard.getSnapshot().saving).toBe(false) })
    expect(unset).toHaveBeenCalledWith('enabled')
    expect(fixture.snapshot().user).toBeUndefined()
    controller.dispose()
  })

  it('keeps the draft and clears saving when the settings write fails', async () => {
    const fixture = scopeFixture()
    fixture.scope.set = vi.fn(async () => { throw new Error('settings unavailable') })
    const controller = new FirethornPetSettingsController(fixture.scope)
    const face = controller.inject()

    face.setEnabled(false)
    face.save()
    await vi.waitFor(() => { expect(face.hooks.firethornPetCard.getSnapshot().saving).toBe(false) })
    expect(face.hooks.firethornPetCard.getSnapshot()).toMatchObject({ dirty: true, failed: true, enabled: false })
    controller.dispose()
  })
})
