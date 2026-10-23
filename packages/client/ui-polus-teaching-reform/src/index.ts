/** Host research repository and browser-side teaching reform plugin. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection/src/rpc.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { graphHTML, identifier, record } from './jd/document.ts'
import { JdProjectStore } from './jd/store.ts'

/** Host persistence settings; source and graph limits also apply to decoded RPC documents. */
export interface Config {
  /** Optional private project directory; defaults to `jd-projects` in DSH_HOME. */
  projectDirectory?: string
  /** Maximum UTF-8 bytes in one project. */
  maxProjectBytes: number
}

export const Config: z<Config> = z.object({
  projectDirectory: z.string(),
  maxProjectBytes: z.natural().min(1).default(20 * 1024 * 1024),
})

export const inject = ['connection']

/** Register loopback-only research operations with Connection's existing trust checks.
 * @param ctx - Host context with the Connection registry.
 * @param config - Validated private storage settings.
 */
export function apply(ctx: Context, config: Config): void {
  const store = new JdProjectStore(config.projectDirectory ?? join(resolveDshHome(), 'jd-projects'), config.maxProjectBytes)
  const connection = ctx.get('connection') as unknown as HostConnectionHandle
  ctx.effect(() => connection.rpc.handle('/jd', async (endpoint, payload) => {
    try {
      if (endpoint === 'list') return { ok: true, value: await store.list() }
      if (endpoint === 'confirmed') return { ok: true, value: await store.confirmed() }
      const input = record(payload)
      if (endpoint === 'save') return { ok: true, value: await store.save(input.project) }
      if (endpoint === 'confirm') return { ok: true, value: await store.confirm(identifier(input.id), input.version, input.revision) }
      const project = await store.read(identifier(input.id))
      if (endpoint === 'read') return { ok: true, value: project }
      if (endpoint !== 'export') throw new Error('未知 JD 操作')
      const graph = project?.graphs.find(item => item.version === input.version)
      if (!project || !graph || !project.confirmations?.some(item => item.version === graph.version))
        throw new Error('请先确认能力图谱，再导出指定版本')
      return { ok: true, value: { html: graphHTML(project, graph) } }
    } catch (error) {
      return { ok: false, error: { code: 'internal', details: {}, message: error instanceof Error ? error.message : 'JD 项目操作失败' } }
    }
  }, { authority: 'loopback' }))
}
