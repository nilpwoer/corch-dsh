/** Keep native automatic captures durable until their original Host projects acknowledge a saved copy. */
import type { TeachingReformProps } from './types.ts'
import { ackJdBrowserDeliveries, observeJdBrowserDeliveries, pendingJdBrowserDeliveries } from './jdNative.ts'
import { saveJdBrowserDelivery } from './jdProjectState.ts'

/** Receive native captures independently of which workbench or search is currently visible.
 * @param operations - Stable project operations shared with all workbench instances.
 * @returns Async disposal that stops notifications and waits for the current save to settle.
 */
export function syncJdBrowserDeliveries(operations: Pick<TeachingReformProps, 'loadJdProject' | 'saveJdProject'>): () => Promise<void> {
  let active = true
  let requested = false
  let running: Promise<void> | undefined
  const isActive = (): boolean => active
  const report = (reason: unknown): void => {
    if (active) window.dispatchEvent(new CustomEvent('jd-browser-save-error', {
      detail: reason instanceof Error ? reason.message : '浏览器原文自动保存失败，原文仍保留待重试',
    }))
  }
  const drain = async (): Promise<void> => {
    while (active && requested) {
      requested = false
      const deliveries = await pendingJdBrowserDeliveries()
      for (const delivery of deliveries) {
        if (!isActive()) break
        try {
          await saveJdBrowserDelivery(operations, delivery)
          if (isActive()) await ackJdBrowserDeliveries([delivery.id])
        } catch (reason) { report(reason) }
      }
    }
  }
  const wake = (): void => {
    if (!active) return
    requested = true
    running ??= drain().catch(report).finally(() => {
      running = undefined
      if (active && requested) wake()
    })
  }
  const unsubscribe = observeJdBrowserDeliveries(wake)
  window.addEventListener('focus', wake)
  window.addEventListener('jd-browser-delivery-retry', wake)
  wake()
  return async () => {
    active = false
    unsubscribe()
    window.removeEventListener('focus', wake)
    window.removeEventListener('jd-browser-delivery-retry', wake)
    await running
  }
}
