import { useSyncExternalStore } from 'react'

/** The workbench surfaces that share the sidebar browser region. */
export type SidebarMode = 'sessions' | 'curriculum' | 'interviews'

let currentMode: SidebarMode = 'sessions'
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getMode(): SidebarMode {
  return currentMode
}

/**
 * Subscribe to workbench selection changes for non-React plugin routing.
 * @param listener - Called synchronously after the selected mode changes.
 * @returns The subscription disposer.
 */
export function subscribeSidebarMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Read the current workbench selection outside a React render.
 * @returns The selected workbench mode.
 */
export function getSidebarMode(): SidebarMode {
  return getMode()
}

/**
 * Read the shared workbench selection from both the App Rail and sidebar.
 * @returns The selected mode, with React subscribed to changes.
 */
export function useSidebarMode(): SidebarMode {
  return useSyncExternalStore(subscribe, getMode, getMode)
}

/**
 * Select the workbench surface shown in the sidebar browser region.
 * @param mode - The workbench to select; selecting the current mode is a no-op.
 */
export function selectSidebarMode(mode: SidebarMode): void {
  if (currentMode === mode) return
  currentMode = mode
  for (const listener of listeners) listener()
}
