/** Candidate links are discoveries, never JD body evidence. */
import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { sourceUrl } from '../jd/document.ts'

const HTTPS_PLATFORMS = ['58.com', 'zhipin.com', 'zhaopin.com', '51job.com', 'quanzhi.com', 'cdpdrc.com', 'rc114.com', '51shuobo.com']

/** Resolve known recruitment links to HTTPS without changing their destination or relaxing source validation.
 * @param value - Discovered or saved candidate URL.
 * @returns Validated source URL with known recruitment HTTP origins upgraded to HTTPS.
 */
export function jdCandidateUrl(value: string): string {
  const url = new URL(sourceUrl(value))
  if (url.protocol === 'http:' && !url.port && HTTPS_PLATFORMS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) url.protocol = 'https:'
  return url.href
}

function publicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try { return jdCandidateUrl(value) } catch { return undefined }
}

/** Keep selected links only when the current web_search result actually supplied them.
 * @param value - Untrusted model JSON selecting pending candidates.
 * @param results - Current operation's real tool results, excluding previous searches.
 * @returns Deduplicated links awaiting browser rendering, with known recruitment HTTP links using HTTPS at the same destination.
 * Search snippets never become originals.
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
