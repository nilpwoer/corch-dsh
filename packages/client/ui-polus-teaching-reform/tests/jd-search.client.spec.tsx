// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { JdSearchWorkbench } from '../src/client/JdSearchWorkbench.tsx'
import type { TeachingReformProps } from '../src/client/types.ts'
import type { JdProject } from '../src/jd/types.ts'

afterEach(cleanup)

function props(): TeachingReformProps {
  return {
    sessionId: 'jd-test-session' as TeachingReformProps['sessionId'],
    generateInterview: vi.fn(),
    observeInterviewCommands: () => () => undefined,
    inferJdRoles: vi.fn().mockResolvedValue(['Python开发工程师']),
    runJdSearch: vi.fn().mockResolvedValue([]),
    listJdProjects: vi.fn().mockResolvedValue([]),
    loadJdProject: vi.fn().mockResolvedValue(null),
    saveJdProject: vi
      .fn()
      .mockImplementation(async (project: JdProject) => ({
        ...project,
        revision: project.revision + 1,
      })),
  } as unknown as TeachingReformProps
}

async function enterSearch(): Promise<void> {
  await screen.findByRole('heading', { name: '从学科专业推理实际岗位' })
  fireEvent.change(screen.getAllByRole('textbox')[0]!, {
    target: { value: '计算机应用技术' },
  })
  fireEvent.click(screen.getByRole('button', { name: '推理岗位名称' }))
  await screen.findByText('已生成 1 个岗位建议，可继续编辑。')
  fireEvent.click(screen.getByRole('button', { name: '确认岗位并继续' }))
  fireEvent.click(await screen.findByRole('button', { name: '开始检索' }))
}

test('role inference and search use the owning JD session', async () => {
  const input = props()
  render(<JdSearchWorkbench {...input} />)
  await enterSearch()
  expect(input.inferJdRoles).toHaveBeenCalledWith(
    input.sessionId,
    '计算机应用技术',
    '',
  )
  await waitFor(() => {
    expect(input.runJdSearch).toHaveBeenCalledWith(
      input.sessionId,
      expect.objectContaining({
        major: '计算机应用技术',
        roles: ['Python开发工程师'],
        targetCount: '5 条（测试）',
      }),
    )
  })
})

test('a failed search keeps its range form available and displays the provider error', async () => {
  const input = props()
  vi.mocked(input.runJdSearch).mockRejectedValue(
    new Error('公开搜索服务暂时不可用'),
  )
  render(<JdSearchWorkbench {...input} />)
  await enterSearch()
  expect(await screen.findByText('公开搜索服务暂时不可用')).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: '开始检索' })
      .disabled,
  ).toBe(false)
  expect(
    await screen.findByRole('heading', { name: '选择平台与搜索范围' }),
  ).toBeTruthy()
})

test('empty results explain the outcome and allow changing the search range', async () => {
  render(<JdSearchWorkbench {...props()} />)
  await enterSearch()
  expect(
    await screen.findByText(
      '尚无已保存原文，可调整搜索范围、登录采集或导入正文。',
    ),
  ).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', {
      name: '使用 0 份原文生成五级图谱',
    }).disabled,
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '调整搜索范围' }))
  expect(
    await screen.findByRole('heading', { name: '选择平台与搜索范围' }),
  ).toBeTruthy()
})
