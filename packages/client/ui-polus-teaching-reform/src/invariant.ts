/** Invariant companion for the teaching-reform UI and private JD repository. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'polus-teaching-reform-invariant'
export const inject = ['invariants']

/** No runtime invariant: JD commits validate their sole stored document.
 * No independently mutable event projection duplicates its sources or graph versions.
 */
const install: InvariantInstaller = () => {}

/** Reserve package ownership in the runtime invariant registry.
 * @param ctx - Context with the invariant registry.
 * @returns A disposer that releases this package's registration.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@polus-ai/dsh-client-ui-teaching-reform', install))
