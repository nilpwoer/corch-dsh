import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { JdSearchJob } from './types.ts'
import { sourceUrl } from '../jd/document.ts'

function publicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return sourceUrl(value)
  } catch { return undefined }
}

/**
 * Keep model job rows only when their exact source was successfully fetched in this request.
 * @param value - Parsed, untrusted model JSON.
 * @param results - Actual tool results from the owning search operation.
 * @returns Valid jobs whose source URL is backed by a successful web_fetch result.
 */
export function verifiedJdSearchJobs(value: unknown, results: readonly ToolResultNode[]): readonly JdSearchJob[] {
  if (typeof value !== 'object' || value === null || !('jobs' in value) || !Array.isArray(value.jobs)) {
    throw new Error('Agent 返回结果缺少 jobs')
  }
  const sources = new Map<string, { url: string; body: string; capturedAt: string }>()
  for (const result of results) {
    if (result.isError || result.call?.name !== 'web_fetch') continue
    const meta = result.meta as { url?: unknown; statusCode?: unknown; truncated?: boolean } | undefined
    const canonical = publicUrl(meta?.url)
    if (canonical === undefined || typeof meta?.statusCode !== 'number' || meta.statusCode < 200 || meta.statusCode >= 300) continue
    const content = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const body = content.replace(/^Fetched [^\n]+\n\n/, '').trim()
    if (meta.truncated || /请先登录|登录后(?:才能|可查看|查看)|扫码查看|请完成安全验证/u.test(body)
      || !/岗位职责|工作职责|职位描述|任职要求|职位要求|工作内容|职责描述|job description|responsibilit/iu.test(body)) continue
    const captured = { url: canonical, body, capturedAt: new Date(result.time).toISOString() }
    sources.set(canonical, captured)
    try {
      const requested = publicUrl((JSON.parse(result.call.argsRaw) as { url?: unknown }).url)
      if (requested !== undefined) sources.set(requested, captured)
    } catch { /* A malformed call cannot establish an additional source alias. */ }
  }
  return value.jobs.flatMap((row: unknown) => {
    if (typeof row !== 'object' || row === null) return []
    const job = row as Record<string, unknown>
    const textFields = ['id', 'title', 'company', 'place', 'platform', 'summary'] as const
    if (textFields.some(field => typeof job[field] !== 'string' || job[field].trim() === '')) return []
    if (typeof job.score !== 'number' || !Number.isFinite(job.score) || job.score < 0 || job.score > 100) return []
    const source = publicUrl(job.sourceUrl)
    const verified = source === undefined ? undefined : sources.get(source)
    if (verified === undefined) return []
    return [{ ...job, sourceUrl: verified.url, body: verified.body, capturedAt: verified.capturedAt } as JdSearchJob]
  })
}

/** Keep login/fetch failures only for URLs actually discovered or attempted by this search.
 * @param value - Model JSON containing pending candidates.
 * @param results - Current operation's actual search and fetch results.
 * @returns Traceable candidates that still need a browser or manual capture.
 */
export function pendingJdSources(value: unknown, results: readonly ToolResultNode[]): { url: string; title: string; reason: string }[] {
  const seen = new Set<string>()
  for (const result of results) {
    if (result.call?.name === 'web_search' && !result.isError) {
      const sources = (result.meta as { sources?: { url?: unknown }[] } | undefined)?.sources
      for (const source of sources ?? []) { const url = publicUrl(source.url); if (url) seen.add(url) }
    }
    if (result.call?.name === 'web_fetch') {
      try { const url = publicUrl((JSON.parse(result.call.argsRaw) as { url?: unknown }).url); if (url) seen.add(url) }
      catch { /* Invalid tool JSON establishes no source. */ }
    }
  }
  const candidates = (value as { pending?: unknown[] } | null)?.pending
  if (!Array.isArray(candidates)) return []
  return candidates.flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return []
    const item = raw as Record<string, unknown>
    const url = publicUrl(item.url)
    return url && seen.has(url) && typeof item.title === 'string' && item.title.trim() && typeof item.reason === 'string' && item.reason.trim()
      ? [{ url, title: item.title, reason: item.reason }] : []
  })
}
