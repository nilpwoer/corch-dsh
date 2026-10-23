import { expect, test } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { pendingJdSources, verifiedJdSearchJobs } from '../src/client/jdSearchResult.ts'

const actual = 'https://jobs.example.test/detail?job=4D70'
const row = { id: 'JD-1', title: 'Python后端开发', company: '公开测试公司', place: '杭州',
  platform: '公开网页', score: 80, summary: '开发后端接口。', sourceUrl: actual }
const fetchResult = (statusCode = 200, url = actual): ToolResultNode => ({
  kind: 'tool-result', call: { name: 'web_fetch', argsRaw: JSON.stringify({ url: actual }) },
  isError: false, time: 1792540800000, meta: { statusCode, url }, content: [{ type: 'text', text: `Fetched ${url} (HTTP ${statusCode})\n\n岗位职责：开发后端接口。` }],
} as unknown as ToolResultNode)

test('a generated source identifier that differs from the actual fetch is omitted', () => {
  const invented = { ...row, sourceUrl: 'https://jobs.example.test/detail?job=3DCD' }
  expect(verifiedJdSearchJobs({ jobs: [row, invented] }, [fetchResult()])).toEqual([expect.objectContaining({ ...row, body: '岗位职责：开发后端接口。' })])
})

test('successful redirects use the canonical fetched URL, while HTTP errors are excluded', () => {
  const canonical = 'https://jobs.example.test/canonical'
  expect(verifiedJdSearchJobs({ jobs: [row] }, [fetchResult(200, canonical)]))
    .toEqual([expect.objectContaining({ ...row, sourceUrl: canonical, body: '岗位职责：开发后端接口。' })])
  expect(verifiedJdSearchJobs({ jobs: [row] }, [fetchResult(403)])).toEqual([])
  expect(verifiedJdSearchJobs({ jobs: [row] }, [{ ...fetchResult(), isError: true }])).toEqual([])
})

test('search snippets, stale results and unsafe or malformed model rows cannot establish evidence', () => {
  expect(verifiedJdSearchJobs({ jobs: [row] }, [])).toEqual([])
  expect(verifiedJdSearchJobs({ jobs: [row] }, [{ ...fetchResult(), call: { name: 'web_search', argsRaw: '{}' } }])).toEqual([])
  const invalid = [null, { ...row, sourceUrl: 'javascript:alert(1)' }, { ...row, summary: null }, { ...row, score: 101 }]
  expect(verifiedJdSearchJobs({ jobs: invalid }, [fetchResult()])).toEqual([])
  expect(() => verifiedJdSearchJobs({ jobs: 'invalid' }, [])).toThrow('缺少 jobs')
})

test('HTTP 200 login pages and truncated fetches cannot establish a saved JD original', () => {
  const login = { ...fetchResult(), content: [{ type: 'text', text: '登录后查看职位描述' }] } as ToolResultNode
  expect(verifiedJdSearchJobs({ jobs: [row] }, [login])).toEqual([])
  const truncated = { ...fetchResult(), meta: { statusCode: 200, url: actual, truncated: true } }
  expect(verifiedJdSearchJobs({ jobs: [row] }, [truncated])).toEqual([])
})

test('HTTP 200 security challenges with incidental duty text remain unverified', () => {
  for (const message of ['当前访问存在异常', '访问过于频繁', '请拖动滑块完成验证']) {
    const challenge = { ...fetchResult(), content: [{ type: 'text', text: `${message}\n职位描述：验证完成后可查看` }] } as ToolResultNode
    expect(verifiedJdSearchJobs({ jobs: [row] }, [challenge])).toEqual([])
  }
})

test('a pending login candidate must come from an actual discovery or fetch attempt', () => {
  const pending = { url: actual, title: row.title, reason: '需要登录' }
  expect(pendingJdSources({ pending: [pending] }, [fetchResult(403)])).toEqual([pending])
  expect(pendingJdSources({ pending: [pending] }, [])).toEqual([])
  expect(pendingJdSources({ pending: [{ ...pending, url: 'https://invented.test/job' }] }, [fetchResult(403)])).toEqual([])
})
