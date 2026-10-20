import { expect, test } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { verifiedJdSearchJobs } from '../src/client/jdSearchResult.ts'

const actual = 'https://jobs.example.test/detail?job=4D70'
const row = { id: 'JD-1', title: 'Python后端开发', company: '公开测试公司', place: '杭州',
  platform: '公开网页', score: 80, summary: '开发后端接口。', sourceUrl: actual }
const fetchResult = (statusCode = 200, url = actual): ToolResultNode => ({
  kind: 'tool-result', call: { name: 'web_fetch', argsRaw: JSON.stringify({ url: actual }) },
  isError: false, meta: { statusCode, url },
} as unknown as ToolResultNode)

test('a generated source identifier that differs from the actual fetch is omitted', () => {
  const invented = { ...row, sourceUrl: 'https://jobs.example.test/detail?job=3DCD' }
  expect(verifiedJdSearchJobs({ jobs: [row, invented] }, [fetchResult()])).toEqual([row])
})

test('successful redirects use the canonical fetched URL, while HTTP errors are excluded', () => {
  const canonical = 'https://jobs.example.test/canonical'
  expect(verifiedJdSearchJobs({ jobs: [row] }, [fetchResult(200, canonical)]))
    .toEqual([{ ...row, sourceUrl: canonical }])
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
