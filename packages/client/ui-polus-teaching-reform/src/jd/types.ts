/** Durable JD research documents. Source text is evidence; graph descriptions may be inference. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** Opaque Host repository identity, distinct from source and graph identifiers. */
export type JdProjectId = Branded<'JdProjectId'>

/** Original captured job text and independently recorded acquisition metadata. */
export type JdSource = {
  id: string
  title: string
  company: string
  place: string
  platform: string
  source_url: string
  body: string
  captured_at: string
  content_hash: string
  acquisition: 'http' | 'browser' | 'manual'
  excluded: boolean
}

/** A captured quote is matched literally against the identified retained JD. */
export type JdEvidence = { jd_id: string; quote: string }

/** Five ordered levels; inferred descriptions remain explicitly labelled in every output. */
export type JdGraphNode = {
  id: string
  parent_id: string | null
  kind: 'project' | 'task' | 'process' | 'skill' | 'knowledge'
  title: string
  description: string
  basis: 'direct' | 'inferred'
  evidence: JdEvidence[]
  assessment: string
}

/** One immutable generated graph version over an exact set of source hashes. */
export type JdGraph = {
  version: number
  generated_at: string
  source_hashes: Record<string, string>
  nodes: JdGraphNode[]
}

/** Editable workbench state restored independently for each search session. */
export type JdWorkspace = {
  step: 1 | 2 | 3 | 4
  graph_version: number | null
  capture: { url: string; title: string; company: string; body: string; file_name: string }
  search_status: 'draft' | 'running' | 'completed' | 'failed'
  error: string
  role_text?: string
}

/** Host-recorded approval of one immutable graph version for curriculum use. */
type JdConfirmation = { version: number; confirmed_at: string }

/** Optimistic revisions prevent one open window from overwriting another window's work. */
export type JdProject = {
  format_version: 1
  id: JdProjectId
  session_id: SessionId
  revision: number
  title: string
  major: string
  direction: string
  roles: string[]
  platforms: string[]
  region: string
  published_within: string
  target_count: string
  updated_at: string
  sources: JdSource[]
  pending_sources: { url: string; title: string; reason: string }[]
  graphs: JdGraph[]
  workspace?: JdWorkspace
  confirmations?: JdConfirmation[]
}

/** Project roster omits the potentially large and private source bodies. */
export type JdProjectSummary = Pick<JdProject, 'id' | 'session_id' | 'title' | 'updated_at' | 'revision'>

/** Confirmed graph roster for subsequent curriculum construction. */
export type JdConfirmedSummary = {
  project_id: JdProjectId
  session_id: SessionId
  title: string
  version: number
  confirmed_at: string
  updated_at: string
}
