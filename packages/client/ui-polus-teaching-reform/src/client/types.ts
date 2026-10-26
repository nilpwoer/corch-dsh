import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GlobalReferenceDocument } from './interviewTypes.ts'

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
  analyzeJdSearch: (id: SessionId, jobs: readonly JdSearchJob[]) => Promise<JdSearchAnalysis>
  renameJdSearchProject: (id: SessionId, title: string) => Promise<void>
  saveJdSearchArtifacts: (id: SessionId, artifacts: readonly { path: string; contents: string }[]) => Promise<void>
  openJdSearchReport: (id: SessionId, path: string) => Promise<void>
}

export type JdSearchRequest = {
  major: string
  direction: string
  roles: readonly string[]
  platforms: readonly string[]
  region: string
  publishedWithin: string
  targetCount: string
}

export type JdSearchJob = {
  id: string
  title: string
  company: string
  place: string
  platform: string
  score: number
  summary: string
  /** Cleaned job-description body returned from the source page. */
  body?: string
  sourceUrl?: string
}

export type JdSearchTask = {
  title: string
  freqHint: number
  description: string
  evidenceIds: readonly string[]
}

export type JdSearchAbility = {
  title: string
  level: '高频' | '补充'
  taskCount: number
  sourceCount: number
}

export type JdSearchAnalysis = {
  tasks: readonly JdSearchTask[]
  abilities: readonly JdSearchAbility[]
}

export type JdSearchProject = {
  sessionId: string
  title: string
  request: JdSearchRequest
  jobs: readonly JdSearchJob[]
  excludedJobIds?: readonly string[]
  confirmedJobIds?: readonly string[]
  analysis?: JdSearchAnalysis
  jobsPath: string
  reportPath?: string
  htmlReportPath?: string
  reportSavedAt?: string
  finalizedAt?: string
  updatedAt: string
}
