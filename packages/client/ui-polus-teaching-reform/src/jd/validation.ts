/** Structured graph failures identify model corrections without modifying rejected nodes. */
import type { JdGraphNode } from './types.ts'

/** A validated node whose parent, descendants or direct-evidence declaration must be corrected. */
export type JdGraphValidationIssue = { node: JdGraphNode; message: string } & (
  | { code: 'invalid_parent'; expected_parent_kind: JdGraphNode['kind'] | null }
  | { code: 'incomplete_branch'; expected_child_kind: JdGraphNode['kind'] }
  | { code: 'unsupported_direct'; fields: ('title' | 'description')[] }
)

/** Rejected graph diagnostics; the first message remains suitable for existing error consumers. */
export class JdGraphValidationError extends Error {
  /** All rejected node declarations from the same graph, including their verified source quotations. */
  readonly issues: readonly JdGraphValidationIssue[]

  /**
   * @param first - First failed graph requirement and its unchanged parsed node.
   * @param remaining - Additional failures in the same model response.
   */
  constructor(first: JdGraphValidationIssue, ...remaining: JdGraphValidationIssue[]) {
    super(first.message)
    this.name = 'JdGraphValidationError'
    this.issues = [first, ...remaining]
  }
}
