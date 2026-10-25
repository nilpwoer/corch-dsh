import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GlobalReferenceDocument } from './interviewTypes.ts'
import type { JdProject, JdProjectId, JdProjectSummary } from '../jd/types.ts'

export type { InterviewProfile, ExpertMaterial } from './interviewTypes.ts'
import type { InterviewProfile, ExpertMaterial } from './interviewTypes.ts'

/** Session-scoped interview generation, command observation, and document preview inputs. */
export type TeachingReformProps = PropsRuntime<'conversation.details.context'> & {
  sessionId: SessionId
  generateInterview: (id: SessionId, profile: InterviewProfile) => Promise<string>
  observeInterviewCommands: (id: SessionId, listener: (command: 'regenerate') => void) => () => void
  openExpertMaterialPreview?: (sessionId: SessionId, material: ExpertMaterial) => void
  openGlobalReferencePreview?: (document: GlobalReferenceDocument) => void
  runJdSearch: (id: SessionId, request: JdSearchRequest) => Promise<readonly JdSearchJob[]>
  inferJdRoles: (id: SessionId, major: string, direction: string) => Promise<readonly string[]>
  generateJdGraph: (id: SessionId, project: JdProject, progress?: (message: string) => void) => Promise<unknown>
  listJdProjects: () => Promise<JdProjectSummary[]>
  loadJdProject: (id: string) => Promise<JdProject | null>
  saveJdProject: (project: JdProject) => Promise<JdProject>
  exportJdProject: (id: string, version: number) => Promise<{ html: string }>
  confirmJdProject: (id: string, version: number, revision: number) => Promise<JdProject>
  createJdSearchSession: (seed?: JdProject) => Promise<void>
  initializeJdProject: (id: SessionId) => Promise<JdProject>
  openJdProject: (sessionId: string) => void
  pendingJdSources?: (id: SessionId) => JdProject['pending_sources']
}

/** User-selected role and public search filters. */
export type JdSearchRequest = {
  major: string
  direction: string
  roles: readonly string[]
  platforms: readonly string[]
  region: string
  publishedWithin: string
  targetCount: string
}

/** A source-backed public job returned by the search agent. */
export type JdSearchJob = {
  id: string
  title: string
  company: string
  place: string
  platform: string
  score: number
  summary: string
  sourceUrl?: string
  body?: string
  capturedAt?: string
}

/** Desktop policy state shared by searches using the same private browser session. */
export type JdPlatformState = {
  platform: string
  blocked: boolean
  reason?: string
  blocked_at?: string
  cache_count: number
  login_required: boolean
  next_navigation_at?: string
}

/** Browser-captured text keeps its original acquisition time even when read from cache. */
export type JdBrowserCapture = {
  state: 'captured'
  url: string
  title: string
  body: string
  captured_at: string
  content_hash: string
  cached?: boolean
}

/** Failed reads retain their classification without implying that every platform needs login. */
export type JdBrowserOutcome = JdBrowserCapture | {
  state: 'blocked' | 'login_required' | 'not_a_jd' | 'failed' | 'rate_limited'
  url: string
  title?: string
  message?: string
}

/** A collection response reports each URL independently and the resulting platform policy state. */
export type JdBrowserCollection = { items: JdBrowserOutcome[]; platforms: JdPlatformState[] }

/** Durable native capture addressed to the project that opened its browser window. */
export type JdBrowserDelivery = {
  id: Branded<'JdBrowserDeliveryId'>
  project_id: JdProjectId
  requested_url: string
  item: JdBrowserCapture
}
