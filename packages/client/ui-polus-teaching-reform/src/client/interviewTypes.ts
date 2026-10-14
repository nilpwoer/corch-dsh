/** Browser-independent generation inputs shared by the CLI and workbench. */
/** Methodology corpus priority, without implying that a document was supplied. */
export type ReferenceTier = 'S' | 'A' | 'B'

/** Explicit reusable reference text and its generation provenance. */
export type GlobalReferenceDocument = {
  id: string
  title: string
  markdown: string
  version: number
  updatedAt: string
  enabled: boolean
  archivedAt?: string
  tier?: ReferenceTier
  sourceFile?: string
  origin?: 'bundled-corpus' | 'user'
  summary?: string
}

/** Host-confirmed expert background or an explicitly identified synthetic profile. */
export type InterviewProfile = {
  name: string
  industry: string
  role: string
  years: string
  stage: string
  experience: string
  materials?: readonly ExpertMaterial[]
}

/** Host-authorized material and its extraction state. */
export type ExpertMaterial = {
  id: string
  name: string
  sourceType: 'pdf' | 'word' | 'excel' | 'markdown' | 'text' | 'other'
  markdown: string
  status: 'ready' | 'processing' | 'failed'
  uploadedAt: string
  error?: string
}
