import { expect, test } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { jdCandidateUrl, pendingJdSources } from '../src/client/jdSearchResult.ts'

const actual = 'https://jobs.example.test/detail?job=4D70'
const candidate = { url: actual, title: '模型给出的岗位标题', reason: '模型声称已采集成功' }
const searchResult = (): ToolResultNode => ({
  kind: 'tool-result', call: { name: 'web_search', argsRaw: '{}' },
  isError: false, time: 1792540800000,
  meta: { sources: [{ url: actual, title: '真实搜索结果标题' }] },
  content: [{ type: 'text', text: '搜索摘要包含岗位职责，不是原文' }],
} as unknown as ToolResultNode)

test('discovered links remain pending browser reads, regardless of model claims and snippet text', () => {
  expect(pendingJdSources({ pending: [candidate] }, [searchResult()])).toEqual([{
    url: actual, title: '真实搜索结果标题', reason: '待浏览器读取；搜索摘要不作为 JD 原文',
  }])
})

test('invented URLs, missing current search evidence and failed searches cannot establish candidates', () => {
  expect(pendingJdSources({ pending: [candidate] }, [])).toEqual([])
  expect(pendingJdSources({ pending: [candidate] }, [{ ...searchResult(), isError: true }])).toEqual([])
  expect(pendingJdSources({ pending: [{ ...candidate, url: 'https://invented.test/job' }] }, [searchResult()])).toEqual([])
  expect(pendingJdSources({ pending: [candidate] }, [{ ...searchResult(), call: { name: 'web_fetch', argsRaw: JSON.stringify({ url: actual }) } }])).toEqual([])
})

test('candidate validation deduplicates links and rejects unsafe or malformed rows', () => {
  const value = { pending: [candidate, candidate, null, { url: 'javascript:alert(1)', title: 'bad' }] }
  expect(pendingJdSources(value, [searchResult()])).toHaveLength(1)
  expect(() => pendingJdSources({ pending: 'invalid' }, [])).toThrow('缺少 pending')
  expect(pendingJdSources({ pending: [] }, [])).toEqual([])
})

test('known recruitment HTTP evidence and selected HTTPS links share the same secure candidate', () => {
  const http = 'http://cd.58.com/tech/123x.shtml?job=1'
  const https = 'https://cd.58.com/tech/123x.shtml?job=1'
  const result = { ...searchResult(), meta: { sources: [{ url: http, title: '真实平台岗位' }] } }
  expect(pendingJdSources({ pending: [{ url: https }, { url: http }] }, [result])).toEqual([{
    url: https, title: '真实平台岗位', reason: '待浏览器读取；搜索摘要不作为 JD 原文',
  }])
  expect(jdCandidateUrl('http://www.zhaopin.com/jobdetail/1.htm#details')).toBe('https://www.zhaopin.com/jobdetail/1.htm')
  expect(jdCandidateUrl('http://jobs.51job.com:80/job?id=1')).toBe('https://jobs.51job.com/job?id=1')
})

test('secure normalization neither invents unrelated evidence nor authorizes unsafe sources', () => {
  for (const url of ['http://unrelated.example/job', 'http://zhaopin.com.evil.test/job', 'http://cd.58.com:8080/job']) expect(jdCandidateUrl(url)).toBe(url)
  for (const url of ['http://user:secret@cd.58.com/job', 'http://cd.58.com/job?token=secret', 'javascript:alert(1)']) expect(() => jdCandidateUrl(url)).toThrow()
  const result = { ...searchResult(), meta: { sources: [{ url: 'http://unknown.example/job', title: '普通站点' }] } }
  expect(pendingJdSources({ pending: [{ url: 'https://unknown.example/job' }] }, [result])).toEqual([])
})
