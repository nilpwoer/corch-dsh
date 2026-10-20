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
}

/** A typical work task tied to confirmed job identifiers. */
export type JdSearchTask = {
  title: string
  count: string
  description: string
  evidenceIds: readonly string[]
}

/** A professional ability derived from confirmed tasks. */
export type JdSearchAbility = {
  title: string
  level: '高频' | '补充'
  taskCount: number
  sourceCount: number
}

/** Task clusters and abilities inferred from retained public jobs. */
export type JdSearchAnalysis = {
  tasks: readonly JdSearchTask[]
  abilities: readonly JdSearchAbility[]
}
