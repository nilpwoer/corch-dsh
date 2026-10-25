/** Host research repository and browser-side teaching reform plugin. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection/src/rpc.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { graphHTML, identifier, record } from './jd/document.ts'
import { JdProjectStore } from './jd/store.ts'
import { JdDiscoveryGuard } from './jd/discovery.ts'

/** Host persistence settings; source and graph limits also apply to decoded RPC documents. */
export interface Config {
  /** Optional private project directory; defaults to `jd-projects` in DSH_HOME. */
  projectDirectory?: string
  /** Maximum UTF-8 bytes in one project. */
  maxProjectBytes: number
  /** Maximum web_search dispatches in a single JD link-discovery operation. */
  maxDiscoveryCalls: number
  /** Maximum complete model responses attempted before a rejected graph stops generation. */
  maxGraphAttempts: number
  /** Maximum wait without an active model turn, including an unavailable connection. */
  modelIdleTimeoutMs: number
}

export const Config: z<Config> = z.object({
  projectDirectory: z.string(),
  maxProjectBytes: z.natural().min(1).default(20 * 1024 * 1024),
  maxDiscoveryCalls: z.natural().min(1).default(5),
  maxGraphAttempts: z.natural().min(1).max(5).default(3),
  modelIdleTimeoutMs: z.natural().min(1).default(300000),
})

export const inject = ['connection', 'tools']

/** Register loopback-only research operations with Connection's existing trust checks.
 * @param ctx - Host context with the Connection registry.
 * @param config - Validated private storage settings.
 * @returns Settlement after saved research ownership and RPC handlers are ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const store = new JdProjectStore(config.projectDirectory ?? join(resolveDshHome(), 'jd-projects'), config.maxProjectBytes)
  const discovery = new JdDiscoveryGuard(ctx, store.list(), config.maxDiscoveryCalls)
  await discovery.ready
  const connection = ctx.get('connection') as unknown as HostConnectionHandle
  ctx.effect(() => connection.rpc.handle('/jd', async (endpoint, payload) => {
    try {
      if (endpoint === 'list') return { ok: true, value: await store.list() }
      if (endpoint === 'confirmed') return { ok: true, value: await store.confirmed() }
      if (endpoint === 'generation-policy') return { ok: true, value: {
        maxGraphAttempts: config.maxGraphAttempts, modelIdleTimeoutMs: config.modelIdleTimeoutMs,
      } }
      const input = record(payload)
      if (endpoint === 'save') {
        const project = await store.save(input.project)
        discovery.remember(project.session_id)
        return { ok: true, value: project }
      }
      if (endpoint === 'discovery-begin' || endpoint === 'discovery-end') {
        const project = (await store.list()).find(item => item.session_id === input.session_id)
        if (!project) throw new Error('当前会话不是已存档的 JD 搜索')
        discovery.remember(project.session_id)
        if (endpoint === 'discovery-begin') await discovery.begin(project.session_id)
        else discovery.end(project.session_id)
        return { ok: true, value: null }
      }
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
