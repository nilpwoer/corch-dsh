import { createHash } from 'node:crypto'
import type { JdGraphNode, JdProject } from '../src/jd/types.ts'
import { projectId } from '../src/jd/document.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

const sourceBody =
  '合成验收岗位。岗位职责：开发后端接口，编写 SQL 查询，完成接口测试。任职要求：掌握关系数据库和软件测试知识。'

export function projectFixture(): JdProject {
  return {
    format_version: 1,
    id: projectId('synthetic-jd-project'),
    session_id: 'synthetic-jd-session' as SessionId,
    revision: 0,
    title: '合成计算机专业岗位研究',
    major: '计算机应用技术',
    direction: '',
    roles: ['后端开发'],
    platforms: ['合成登录站点'],
    region: '四川及西南地区',
    published_within: '最近 90 天',
    target_count: '5 条（测试）',
    updated_at: '2026-10-21T00:00:00.000Z',
    pending_sources: [],
    graphs: [],
    sources: [
      {
        id: 'JD-1',
        title: '合成后端开发',
        company: '合成验收企业',
        place: '合成地域',
        platform: '合成站点',
        source_url: 'https://jobs.example.test/detail/1',
        body: sourceBody,
        content_hash: createHash('sha256').update(sourceBody).digest('hex'),
        captured_at: '2026-10-21T00:00:00.000Z',
        acquisition: 'manual',
        excluded: false,
      },
    ],
  }
}

export function graphFixture(): JdGraphNode[] {
  const levels = ['project', 'task', 'process', 'skill', 'knowledge'] as const
  const titles = ['交付后端服务', '开发后端接口', '实施开发与测试', '编写 SQL 查询', '关系数据库']
  return levels.map((kind, index) => ({
    id: `N${index + 1}`,
    parent_id: index === 0 ? null : `N${index}`,
    kind,
    title: titles[index]!,
    description: titles[index]!,
    basis: index === 0 || index === 2 ? 'inferred' : 'direct',
    evidence: [{ jd_id: 'JD-1', quote: sourceBody }],
    assessment: kind === 'skill' ? '通过实际查询任务检验结果，标准待企业专家确认' : '',
  }))
}
