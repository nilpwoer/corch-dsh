/** Polus AI 教学改革工作台：实践专家访谈 + 课程开发。 */
import { resolveWorkspacePath, type ClientContext, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createElement, type ReactNode } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { getSidebarMode, subscribeSidebarMode, useSidebarMode } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { CurriculumSidebar, CurriculumWorkbench } from './CurriculumWorkbench.tsx'
import { JdSearchSidebar, JdSearchWorkbench } from './JdSearchWorkbench.tsx'
import { InterviewDetails, InterviewSidebar, rebindInterviewSession, selectInterview } from './InterviewWorkbench.tsx'
import { loadGlobalReferenceDocumentsForGeneration } from './InterviewSettings.tsx'
import type { GlobalReferenceDocument } from './InterviewSettings.tsx'
import type { InterviewProfile, JdSearchAbility, JdSearchAnalysis, JdSearchJob, JdSearchRequest, JdSearchTask, TeachingReformProps } from './types.ts'
import type { ExpertMaterial } from './types.ts'
import { ExpertMaterialSidebarTab } from './ExpertMaterialSidebarTab.tsx'
import { GlobalReferenceSidebarTab } from './GlobalReferenceSidebarTab.tsx'
import { buildInterviewPrompt } from './interviewPrompt.ts'
import { buildJdAnalysisPrompt, buildJdRoleInferencePrompt, buildJdSearchArtifactPrompt, buildJdSearchPrompt } from './jdSearchPrompt.ts'
import { parseJdAgentJson, parseJdJobs, promptJdAgent } from './jdAgentResult.ts'

export const inject = ['sessions', 'workspaces', 'layout', 'connection', 'slots', 'betterSidebar']

type InterviewTextBlock = { kind: string; text?: string }
type BetterSidebarTab = { id: string; meta?: unknown }
type TabComponentProps = { tab: BetterSidebarTab }
type BetterSidebarService = {
  registerTab: (tab: {
    id: string
    title: string
    order: number
    dedupeKey: (tab: BetterSidebarTab) => string
    component: (props: { tab: BetterSidebarTab }) => ReactNode
  }) => () => void
  openTab?: (tab: {
    id: string
    type: string
    title: string
    path: string
    meta?: unknown
  }, options?: { sessionId?: string }) => void
}
type InterviewSnapshotNode = {
  kind: string
  seq: number
  turn?: number
  step?: number
  blocks?: readonly InterviewTextBlock[]
  data?: unknown
}
type InterviewSession = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => {
    nodes: readonly InterviewSnapshotNode[]
    partial?: { turn: number; step: number; blocks: readonly InterviewTextBlock[] } | null
  }
}

type JdAgentFunctions = {
  inferJdRoles: (id: SessionId, major: string, direction: string) => Promise<readonly string[]>
  runJdSearch: (id: SessionId, request: JdSearchRequest) => Promise<readonly JdSearchJob[]>
  analyzeJdSearch: (id: SessionId, jobs: readonly JdSearchJob[]) => Promise<JdSearchAnalysis>
  renameJdSearchProject: (id: SessionId, title: string) => Promise<void>
  saveJdSearchArtifacts: (id: SessionId, artifacts: readonly { path: string; contents: string }[]) => Promise<void>
  openJdSearchReport: (id: SessionId, path: string) => Promise<void>
}

function sessionContainsText(session: InterviewSession, text: string): boolean {
  if (text.trim() === '') return false
  return session.getSnapshot().nodes.some((node) => {
    const blocks = node.blocks ?? []
    if (blocks.some(block => block.text?.includes(text))) return true
    return typeof node.data === 'string' && node.data.includes(text)
  })
}

function hasClosedJsonObject(text: string): boolean {
  const start = text.indexOf('{')
  if (start < 0) return false
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return true
    }
  }
  return false
}

const waitForInterviewResult = async (session: InterviewSession, baselineSeq: number): Promise<string> => {
  const read = (): string | null => {
    const candidates = session.getSnapshot().nodes
      .filter(node => (node.kind === 'assistant' || node.kind === 'assistant-step') && node.seq > baselineSeq)
      .toReversed()
    // DSH can leave a later assistant-step/running projection beside an
    // already-complete assistant message.  Inspect all candidates in reverse
    // order instead of treating the latest running step as the whole result.
    for (const assistant of candidates) {
      const data = typeof assistant.data === 'object' && assistant.data !== null ? assistant.data as {
        status?: string
        blocks?: readonly InterviewTextBlock[]
        finalNode?: { blocks?: readonly InterviewTextBlock[] }
      } : undefined
      // Some DSH projections omit the explicit `settled` status but expose a
      // finalNode once generation is complete.  finalNode is the stronger
      // completion signal; accepting it avoids waiting until the timeout.
      const blocks = data?.finalNode?.blocks ?? data?.blocks ?? assistant.blocks
      if (blocks === undefined) continue
      const text = blocks.filter(block => block.kind === 'text' && block.text !== undefined).map(block => block.text).join('\n').trim()
      if (text === '') continue
      const hasQuestionPackFields = /[\"']questions[\"']\s*:/.test(text) && text.includes('sourceRefs')
      const completeJsonSignal = hasQuestionPackFields && (hasClosedJsonObject(text) || data?.status === 'settled' || data?.finalNode !== undefined)
      // Accept a complete, closed question-pack JSON even when the projection
      // omits its settled flag.  Partial streaming text still fails the shape
      // signal and is ignored until the next snapshot notification.
      if (completeJsonSignal) return text
    }
    return null
  }
  const immediate = read()
  if (immediate !== null) return immediate
  return await new Promise<string>((resolve, reject) => {
    let unsubscribe = (): void => undefined
    // Long structured packs can legitimately take a few minutes on the selected
    // model.  A two-minute client timeout was shorter than observed DSH runs and
    // incorrectly surfaced a retry error while the assistant was still working.
    const timeout = window.setTimeout(() => { unsubscribe(); reject(new Error('Agent 已接受任务，但在 5 分钟内未返回可解析的问题包')) }, 300000)
    const check = (): void => {
      const text = read()
      if (text === null) return
      window.clearTimeout(timeout)
      unsubscribe()
      resolve(text)
    }
    unsubscribe = session.subscribe(check)
    check()
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAgentAbility(value: unknown): value is JdSearchAbility {
  if (!isRecord(value)) return false
  return typeof value.title === 'string'
    && (value.level === '高频' || value.level === '补充')
    && typeof value.taskCount === 'number' && Number.isFinite(value.taskCount) && value.taskCount >= 0
    && typeof value.sourceCount === 'number' && Number.isFinite(value.sourceCount) && value.sourceCount >= 0
}

type AgentTask = { title: string; description: string; evidenceIds: string[] }

function isAgentTask(value: unknown, jobIds: ReadonlySet<string>): value is AgentTask {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.description !== 'string' || !Array.isArray(value.evidenceIds)) return false
  return value.evidenceIds.length > 0
    && value.evidenceIds.every((id): id is string => typeof id === 'string' && jobIds.has(id))
    && new Set(value.evidenceIds).size === value.evidenceIds.length
}

function createInterviewAgentFunctions(ctx: ClientContext) {
  const generateInterview = async (id: SessionId, profile: InterviewProfile): Promise<string> => {
    const session = ctx.sessions.binding(id)?.session
    if (session === undefined) throw new Error('当前访谈会话不可用')
    const baselineSeq = session.getSnapshot().nodes.reduce((max, node) => Math.max(max, node.seq), 0)
    const references = await loadGlobalReferenceDocumentsForGeneration()
    const prompt = buildInterviewPrompt(profile, references)
    const result = await session.prompt([{ type: 'text', text: prompt }], 'queue')
    if (!result.ok) throw new Error(result.error.message)
    return await waitForInterviewResult(session, baselineSeq)
  }
  const observeInterviewCommands = (id: SessionId, listener: (command: 'regenerate') => void): (() => void) => {
    const session = ctx.sessions.binding(id)?.session
    if (session === undefined) return () => undefined
    const readUserText = (node: { kind: string; blocks?: readonly { kind: string; text?: string }[] }): string => node.blocks?.filter(block => block.kind === 'text' && block.text !== undefined).map(block => block.text).join('\n').trim() ?? ''
    let lastHandledUserSeq = session.getSnapshot().nodes.filter(node => node.kind === 'user').reduce((max, node) => Math.max(max, node.seq), 0)
    return session.subscribe(() => {
      const latest = session.getSnapshot().nodes.filter(node => node.kind === 'user').at(-1)
      if (latest === undefined || latest.seq <= lastHandledUserSeq) return
      lastHandledUserSeq = latest.seq
      if (/重新生成问题包|重新生成问题|重做问题包/.test(readUserText(latest))) listener('regenerate')
    })
  }
  const promptAgent = async (id: SessionId, prompt: string): Promise<string> => {
    const session = ctx.sessions.binding(id)?.session
    if (session === undefined) throw new Error('当前 JD 搜索会话不可用')
    return await promptJdAgent(session, prompt)
  }
  const renameJdSearchProject = async (id: SessionId, title: string): Promise<void> => {
    const session = ctx.sessions.binding(id)?.session
    if (session === undefined) throw new Error('当前 JD 搜索会话不可用')
    const result = await session.rename(title)
    if (!result.ok) throw new Error(result.error.message)
  }
  const saveJdSearchArtifacts = async (id: SessionId, artifacts: readonly { path: string; contents: string }[]): Promise<void> => {
    const session = ctx.sessions.binding(id)?.session
    if (session === undefined) throw new Error('当前 JD 搜索会话不可用')
    const text = await promptJdAgent(session, buildJdSearchArtifactPrompt(artifacts))
    const missing = artifacts.filter(artifact => !text.includes(`已保存：${artifact.path}`))
    if (missing.length > 0) throw new Error(`Agent 未确认文件已写入：${missing.map(artifact => artifact.path).join('、')}`)
  }
  const openJdSearchReport = async (id: SessionId, path: string): Promise<void> => {
    const cwd = ctx.sessions.list.getSnapshot().byId[id]?.cwd
    if (cwd === undefined || cwd === '') throw new Error('当前 JD 搜索会话没有可用的工作区路径')
    await ctx.workspaces.openPath(resolveWorkspacePath(cwd, path))
  }
  const jdFunctions: JdAgentFunctions = {
    inferJdRoles: async (id, major, direction) => {
      const result = parseJdAgentJson(await promptAgent(id, buildJdRoleInferencePrompt(major, direction)))
      if (!isRecord(result) || !Array.isArray(result.roles) || result.roles.some(role => typeof role !== 'string')) throw new Error('Agent 返回结果缺少有效岗位名称')
      return result.roles.filter(role => role.trim() !== '').slice(0, 8)
    },
    runJdSearch: async (id, request) => parseJdJobs(await promptAgent(id, buildJdSearchPrompt(request))),
    analyzeJdSearch: async (id, jobs) => {
      const result = parseJdAgentJson(await promptAgent(id, buildJdAnalysisPrompt(jobs)))
      if (!isRecord(result) || !Array.isArray(result.tasks) || !Array.isArray(result.abilities)) throw new Error('Agent 返回结果缺少任务或能力标签')
      if (!result.abilities.every(isAgentAbility)) throw new Error('Agent 返回的专业能力标签字段无效')
      if (result.tasks.length < 5 || result.tasks.length > 15) throw new Error('典型工作任务数量应为 5–15 条')
      const jobIds = new Set(jobs.map(job => job.id))
      if (!result.tasks.every(task => isAgentTask(task, jobIds))) throw new Error('Agent 返回的典型工作任务字段或 JD 证据无效')
      const tasks: JdSearchTask[] = result.tasks.map(task => ({
        title: task.title,
        freqHint: task.evidenceIds.length / jobs.length,
        description: task.description,
        evidenceIds: task.evidenceIds,
      }))
      return { tasks, abilities: result.abilities }
    },
    renameJdSearchProject,
    saveJdSearchArtifacts,
    openJdSearchReport,
  }
  return { generateInterview, observeInterviewCommands, ...jdFunctions }
}

export function apply(ctx: ClientContext): void {
  const {
    generateInterview, observeInterviewCommands, inferJdRoles, runJdSearch, analyzeJdSearch,
    renameJdSearchProject, saveJdSearchArtifacts, openJdSearchReport,
  } = createInterviewAgentFunctions(ctx)
  const betterSidebar = ctx.get('betterSidebar') as BetterSidebarService | undefined
  ctx.effect(() => {
    if (betterSidebar === undefined) return () => undefined
    const disposeMaterial = betterSidebar.registerTab({
      id: 'polus-teaching-reform:expert-material',
      title: '专家资料',
      order: 24,
      dedupeKey: tab => tab.id,
      component: ({ tab }: TabComponentProps) => {
        const material = (tab.meta as { material?: ExpertMaterial } | undefined)?.material
        return material === undefined ? null : createElement(ExpertMaterialSidebarTab, { material })
      },
    })
    const disposeReference = betterSidebar.registerTab({
      id: 'polus-teaching-reform:global-reference',
      title: '基础文献',
      order: 25,
      dedupeKey: tab => tab.id,
      component: ({ tab }: TabComponentProps) => {
        const document = (tab.meta as { document?: GlobalReferenceDocument } | undefined)?.document
        return document === undefined ? null : createElement(GlobalReferenceSidebarTab, { document })
      },
    })
    return () => { disposeMaterial(); disposeReference() }
  }, 'polus-teaching-reform: expert material sidebar')
  const createInterviewSession = async (): Promise<void> => {
    const workspaceState = ctx.workspaces.list.getSnapshot()
    const sessionState = ctx.sessions.list.getSnapshot()
    const current = sessionState.current
    const currentWorkspace = current === undefined
      ? undefined
      : workspaceState.items.find(item => item.sessionIds.includes(current))
    let workspaceId = currentWorkspace?.workspaceId ?? workspaceState.recentWorkspaceId ?? workspaceState.items[0]?.workspaceId
    if (workspaceId === undefined) {
      const connection = ctx.get('connection') as ConnectionHandle
      const cwd = connection.hostDescription.getSnapshot()?.cwd
      if (cwd === undefined) throw new Error('cannot create an interview: Host working directory is not ready')
      const workspace = await ctx.workspaces.create({ path: cwd })
      workspaceId = workspace.workspaceId
    }
    const id = await ctx.workspaces.connectWorkspace(workspaceId, { reuseBlank: false })
    const session = ctx.sessions.binding(id)?.session
    if (session === undefined) throw new Error(`created interview session "${id}" is not available`)
    const rename = await session.rename('新建实践专家访谈')
    if (!rename.ok) throw new Error(rename.error.message)
    // Select the new draft before opening Details; otherwise the workbench
    // keeps rendering the previously selected interview.
    openInterviewSession(id)
  }

  const createJdSearchSession = async (): Promise<void> => {
    const workspaceState = ctx.workspaces.list.getSnapshot()
    const sessionState = ctx.sessions.list.getSnapshot()
    const current = sessionState.current
    const currentWorkspace = current === undefined ? undefined : workspaceState.items.find(item => item.sessionIds.includes(current))
    let workspaceId = currentWorkspace?.workspaceId ?? workspaceState.recentWorkspaceId ?? workspaceState.items[0]?.workspaceId
    if (workspaceId === undefined) {
      const connection = ctx.get('connection') as ConnectionHandle
      const cwd = connection.hostDescription.getSnapshot()?.cwd
      if (cwd === undefined) throw new Error('cannot create a JD search: Host working directory is not ready')
      workspaceId = (await ctx.workspaces.create({ path: cwd })).workspaceId
    }
    const id = await ctx.workspaces.connectWorkspace(workspaceId, { reuseBlank: false })
    const session = ctx.sessions.binding(id)?.session
    if (session === undefined) throw new Error(`created JD search session "${id}" is not available`)
    const rename = await session.rename('新建 JD 搜索')
    if (!rename.ok) throw new Error(rename.error.message)
    ctx.sessions.open(id)
    queueMicrotask(() => { ctx.layout.openDetails() })
  }

  const openJdSearchSession = (id: string): void => {
    const targetId = ctx.sessions.list.getSnapshot().ids.find(sessionId => String(sessionId) === id)
    if (targetId === undefined) { window.alert('关联的 DSH 会话不存在，无法打开此项目。'); return }
    ctx.sessions.open(targetId)
    queueMicrotask(() => { ctx.layout.openDetails() })
  }

  // Switching a project must switch the host conversation as well as the
  // workbench selection.  The sidebar record id is the DSH session id for
  // every real interview project.
  const openInterviewSession = (id: string, expert?: string): void => {
    let targetId = id
    const listed = ctx.sessions.list.getSnapshot().ids
    if (!listed.some(sessionId => String(sessionId) === id) && expert !== undefined) {
      const recovered = listed.find((sessionId) => {
        const session = ctx.sessions.binding(sessionId)?.session as InterviewSession | undefined
        return session !== undefined && sessionContainsText(session, expert)
      })
      if (recovered !== undefined) {
        targetId = String(recovered)
        rebindInterviewSession(id, targetId)
      }
    }
    selectInterview(targetId)
    try {
      ctx.sessions.open(targetId as SessionId)
    } catch (reason) {
      console.warn('[polus-interview] unable to open interview session', { id, targetId, reason })
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('interview-selected', { detail: { id: targetId } }))
    queueMicrotask(() => { ctx.layout.openDetails() })
  }

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    priority: -9,
    select: owner => (owner.sidebarMode as string) === 'curriculum' ? {} : null,
  }, CurriculumSidebar))
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    priority: -8,
    select: owner => (owner.sidebarMode as string) === 'interviews' ? {} : null,
    inject: () => ({ createInterviewSession, openInterviewSession, onOpenSettings: () => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('interview-settings-open')) } }),
  }, InterviewSidebar))

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    priority: -7,
    select: owner => (owner.sidebarMode as string) === 'jd-search' ? {} : null,
    inject: () => ({ createJdSearchSession, openJdSearchSession }),
  }, JdSearchSidebar))

  // The details slot already supplies the live sessionId and runtime props;
  // this wrapper only selects one of the two teaching-reform workbenches.
  ctx.slots.inject('conversation.details.context', () => {
    let disposeRegistration: (() => void) | undefined
    const reconcile = (): void => {
      disposeRegistration?.()
      disposeRegistration = getSidebarMode() === 'curriculum' || getSidebarMode() === 'interviews' || getSidebarMode() === 'jd-search'
        ? ctx.slots.register({ name: 'conversation.details.context', inject: () => ({
          generateInterview,
          observeInterviewCommands,
          runJdSearch,
          inferJdRoles,
          analyzeJdSearch,
          renameJdSearchProject,
          saveJdSearchArtifacts,
          openJdSearchReport,
          openExpertMaterialPreview: (sessionId: SessionId, material: ExpertMaterial) => {
            betterSidebar?.openTab?.({
              id: `polus-teaching-reform:expert-material:${material.id}`,
              type: 'polus-teaching-reform:expert-material',
              title: material.name,
              path: `expert-materials/${material.name}`,
              meta: { material },
            }, { sessionId: String(sessionId) })
          },
          openGlobalReferencePreview: (document: GlobalReferenceDocument) => {
            betterSidebar?.openTab?.({ id: `polus-teaching-reform:global-reference:${document.id}`, type: 'polus-teaching-reform:global-reference', title: `${document.id} · ${document.title}`, path: `global-references/${document.id}`, meta: { document } }, { sessionId: String(ctx.sessions.list.getSnapshot().current ?? '') })
          },
        }) }, TeachingReformDetailsRouter)
        : undefined
    }
    reconcile()
    const unsubscribe = subscribeSidebarMode(reconcile)
    return () => { unsubscribe(); disposeRegistration?.() }
  })
}

function TeachingReformDetailsRouter(props: TeachingReformProps): ReactNode {
  const mode = useSidebarMode() as string
  if (mode === 'curriculum') return createElement(CurriculumWorkbench, props)
  if (mode === 'jd-search') return createElement(JdSearchWorkbench, props)
  return createElement(InterviewDetails, props)
}

export type { TeachingReformProps }
