import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { JdSearchJob } from './types.ts'

function publicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined
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
  const sources = new Map<string, string>()
  for (const result of results) {
    if (result.isError || result.call?.name !== 'web_fetch') continue
    const meta = result.meta as { url?: unknown; statusCode?: unknown } | undefined
    const canonical = publicUrl(meta?.url)
    if (canonical === undefined || typeof meta?.statusCode !== 'number' || meta.statusCode < 200 || meta.statusCode >= 300) continue
    sources.set(canonical, canonical)
    try {
      const requested = publicUrl((JSON.parse(result.call.argsRaw) as { url?: unknown }).url)
      if (requested !== undefined) sources.set(requested, canonical)
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
    return [{ ...job, sourceUrl: verified } as JdSearchJob]
  })
}
