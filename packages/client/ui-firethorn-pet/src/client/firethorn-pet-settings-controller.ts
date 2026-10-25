/** Staged settings model for the firethorn pet visibility card. */

import { createSnapshotStore, type SettingsScope, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Client mirror of the Host-owned firethorn settings section. */
export interface FirethornPetSettings {
  /** Whether the floating pet is shown. */
  enabled: boolean
}

/** Snapshot rendered by the firethorn settings card. */
export interface FirethornPetSettingsCardState {
  /** False until the Host exposes this namespace to the client. */
  available: boolean
  /** Whether the Host accepts settings writes. */
  writable: boolean
  /** Effective visibility, including a staged edit. */
  enabled: boolean
  /** Whether saving would leave a user-layer override. */
  overridden: boolean
  /** Whether a save would write the staged value. */
  dirty: boolean
  /** Whether a settings write is in flight. */
  saving: boolean
  /** Whether the last save did not land. */
  failed: boolean
}

/** Slot-injected actions and store for the firethorn settings card. */
export interface FirethornPetSettingsCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as `useFirethornPetCard`. */
    firethornPetCard: SnapshotStore<FirethornPetSettingsCardState>
  }
  /** Stage a visibility choice. */
  setEnabled: (enabled: boolean) => void
  /** Stage clearing the user override. */
  reset: () => void
  /** Persist the staged choice. */
  save: () => void
  /** Drop the staged choice. */
  discard: () => void
}

/** Bridges the firethorn settings scope onto a staged checkbox card. */
export class FirethornPetSettingsController {
  private readonly store: SnapshotStore<FirethornPetSettingsCardState>
  private staged: boolean | undefined
  private clearRequested = false
  private saving = false
  private failed = false
  private disposed = false
  private readonly unsubscribe: () => void

  /** @param scope - the bound `firethorn-pet` settings namespace. */
  constructor(private readonly scope: SettingsScope<FirethornPetSettings>) {
    this.store = createSnapshotStore(this.project())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  /** Stop reflecting settings after the owning client plugin is disposed. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
  }

  /**
   * Expose the staged settings snapshot and actions to the card renderer.
   * @returns The slot face consumed by the card renderer.
   */
  inject(): FirethornPetSettingsCardFace {
    return {
      hooks: { firethornPetCard: this.store },
      setEnabled: (enabled) => { this.setEnabled(enabled) },
      reset: () => { this.reset() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  /**
   * Stage the checkbox value without crossing the settings transport.
   * @param enabled - The visibility choice to stage.
   */
  setEnabled(enabled: boolean): void {
    this.staged = enabled
    this.clearRequested = false
    this.failed = false
    this.publish()
  }

  /** Stage removal of the user override so the schema/composition default applies. */
  reset(): void {
    this.staged = undefined
    this.clearRequested = this.isOverridden()
    this.failed = false
    this.publish()
  }

  /** Discard staged changes. */
  discard(): void {
    if (this.staged === undefined && !this.clearRequested && !this.failed) return
    this.staged = undefined
    this.clearRequested = false
    this.failed = false
    this.publish()
  }

  /** Persist the staged visibility value and keep drafts when the write fails. */
  async save(): Promise<void> {
    if (this.disposed || !this.dirty() || this.saving || !this.scope.getSnapshot().writable) return
    const staged = this.staged
    const clear = this.clearRequested
    this.saving = true
    this.failed = false
    this.publish()
    let landed = false
    try {
      if (clear) await this.scope.unset('enabled')
      else if (staged !== undefined) await this.scope.set('enabled', staged)
      const snapshot = this.scope.getSnapshot()
      const user = snapshot.user
      const stored = typeof user === 'object' && user !== null && !Array.isArray(user)
        ? Object.hasOwn(user, 'enabled')
        : false
      landed = clear
        ? !stored
        : staged !== undefined && snapshot.value?.enabled === staged && stored
    } catch {
      // Keep the draft visible; the card reports the failed write and can retry.
      landed = false
    }
    if (landed) {
      this.staged = undefined
      this.clearRequested = false
    }
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private project(): FirethornPetSettingsCardState {
    const snapshot = this.scope.getSnapshot()
    const current = snapshot.value?.enabled !== false
    const base = typeof snapshot.base === 'object' && snapshot.base !== null && !Array.isArray(snapshot.base)
      && typeof (snapshot.base as { enabled?: unknown }).enabled === 'boolean'
      ? (snapshot.base as { enabled: boolean }).enabled
      : true
    const enabled = this.staged ?? (this.clearRequested ? base : current)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      enabled,
      overridden: this.staged !== undefined ? true : this.clearRequested ? false : this.isOverridden(),
      dirty: this.dirty(),
      saving: this.saving,
      failed: this.failed,
    }
  }

  private dirty(): boolean {
    if (this.clearRequested) return true
    return this.staged !== undefined && this.staged !== (this.scope.getSnapshot().value?.enabled !== false)
  }

  private isOverridden(): boolean {
    const user = this.scope.getSnapshot().user
    return typeof user === 'object' && user !== null && !Array.isArray(user) && Object.hasOwn(user, 'enabled')
  }

  private publish(): void {
    if (this.disposed) return
    this.store.set(this.project())
  }
}
