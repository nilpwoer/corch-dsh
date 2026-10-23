/** Candidate links are discoveries, never JD body evidence. */
import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { sourceUrl } from '../jd/document.ts'

function publicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try { return sourceUrl(value) } catch { return undefined }
}

/** Keep selected links only when the current web_search result actually supplied them.
 * @param value - Untrusted model JSON selecting pending candidates.
 * @param results - Current operation's real tool results, excluding previous searches.
 * @returns Deduplicated links awaiting browser rendering; no search snippet becomes an original.
 */
export function pendingJdSources(value: unknown, results: readonly ToolResultNode[]): { url: string; title: string; reason: string }[] {
  const discovered = new Map<string, string>()
  for (const result of results) {
    if (result.call?.name !== 'web_search' || result.isError) continue
    const sources = (result.meta as { sources?: { url?: unknown; title?: unknown }[] } | undefined)?.sources
    for (const source of sources ?? []) {
      const url = publicUrl(source.url)
      if (url) discovered.set(url, typeof source.title === 'string' ? source.title.trim() : '')
    }
  }
  const candidates = (value as { pending?: unknown[] } | null)?.pending
  if (!Array.isArray(candidates)) throw new Error('Agent 返回结果缺少 pending 候选链接')
  const accepted = new Set<string>()
  return candidates.flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return []
    const item = raw as Record<string, unknown>
    const url = publicUrl(item.url)
    if (!url || !discovered.has(url) || accepted.has(url)) return []
    const title = discovered.get(url) || (typeof item.title === 'string' ? item.title.trim() : '')
    if (!title) return []
    accepted.add(url)
    return [{ url, title, reason: '待浏览器读取；搜索摘要不作为 JD 原文' }]
  })
}
