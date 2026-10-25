/** Shared research drafts serialize autosaves and native browser deliveries across workbench mounts. */
import type { JdBrowserDelivery, TeachingReformProps } from './types.ts'
import type { JdProject, JdWorkspace } from '../jd/types.ts'
import { sourceUrl } from '../jd/document.ts'

type Ref<T> = { current: T }
type ProjectOperations = Pick<TeachingReformProps, 'loadJdProject' | 'saveJdProject'>
type ResearchController = {
  current: Ref<JdProject | null>
  saved: Ref<JdProject | null>
  revision: Ref<number>
  edits: Ref<number>
  persisted: Ref<number>
  serial: Ref<Promise<void>>
  timer: Ref<ReturnType<typeof setTimeout> | undefined>
  running: Ref<boolean>
  generationStatus: Ref<string>
  saving: Ref<boolean>
  saveError: Ref<boolean>
  browserOpen: Ref<boolean>
  platforms: Ref<import('./types.ts').JdPlatformState[]>
  listeners: Set<() => void>
  restoring?: Promise<void>
}
const controllers = new WeakMap<ProjectOperations['saveJdProject'], Map<string, ResearchController>>()

/** Get the shared draft and write queue for one owning search session.
 * @param save - Stable Host save operation used by this client plugin instance.
 * @param sessionId - Owning search session.
 * @returns The controller retained across workbench mounts.
 */
export function jdResearchController(save: ProjectOperations['saveJdProject'], sessionId: JdProject['session_id']): ResearchController {
  let sessions = controllers.get(save)
  if (!sessions) { sessions = new Map(); controllers.set(save, sessions) }
  let controller = sessions.get(sessionId)
  if (!controller) {
    controller = {
      current: { current: null }, saved: { current: null }, revision: { current: 0 }, edits: { current: 0 }, persisted: { current: 0 },
      serial: { current: Promise.resolve() }, timer: { current: undefined }, running: { current: false }, generationStatus: { current: '' },
      saving: { current: false }, saveError: { current: false }, browserOpen: { current: false },
      platforms: { current: [] }, listeners: new Set(),
    }
    sessions.set(sessionId, controller)
  }
  return controller
}

/** Notify mounted views after the shared draft or its persistence state changes.
 * @param controller - Owning session controller.
 */
export function notifyJdResearch(controller: ResearchController): void {
  for (const listener of controller.listeners) listener()
}

/** Save all outstanding draft generations through the session's single write queue.
 * @param controller - Owning session controller.
 * @param save - Host save operation, including optimistic revision validation.
 * @returns Completion after all edits observed by the queued task are saved; rejects on save failure.
 */
export function flushJdResearch(controller: ResearchController, save: ProjectOperations['saveJdProject']): Promise<void> {
  clearTimeout(controller.timer.current)
  const task = controller.serial.current.then(async () => {
    while (controller.current.current && controller.persisted.current < controller.edits.current) {
      const generation = controller.edits.current
      const snapshot = { ...controller.current.current, revision: controller.revision.current }
      controller.saving.current = true
      notifyJdResearch(controller)
      try {
        const saved = await save(snapshot)
        controller.saved.current = saved
        controller.revision.current = saved.revision
        controller.persisted.current = generation
        controller.saveError.current = false
        controller.current.current = controller.edits.current === generation
          ? saved : { ...controller.current.current, revision: saved.revision }
        notifyJdResearch(controller)
        window.dispatchEvent(new Event('jd-projects-changed'))
      } catch (reason) {
        controller.saveError.current = true
        notifyJdResearch(controller)
        throw reason
      } finally {
        controller.saving.current = false
        notifyJdResearch(controller)
      }
    }
  })
  controller.serial.current = task.catch(() => undefined)
  return task
}

/** Persist a queued browser capture in its original project while preserving concurrent local drafts.
 * @param operations - Shared Host read/save operations for the client instance.
 * @param delivery - Durable native capture addressed to its original project.
 * @returns Completion only after the evidence and pending-link changes are saved; failures remain retryable.
 */
export async function saveJdBrowserDelivery(operations: ProjectOperations, delivery: JdBrowserDelivery): Promise<void> {
  const saved = await operations.loadJdProject(delivery.project_id)
  if (!saved) throw new Error('自动采集对应的搜索档案不存在，原文仍保留待保存')
  const controller = jdResearchController(operations.saveJdProject, saved.session_id)
  await controller.restoring
  if (!controller.current.current) {
    controller.current.current = saved
    controller.saved.current = saved
    controller.revision.current = saved.revision
  }
  await controller.serial.current
  const alreadySaved = saved.sources.some(source => source.content_hash === delivery.item.content_hash)
    && !saved.pending_sources.some(source => source.url === delivery.requested_url || source.url === delivery.item.url)
  if (alreadySaved && saved.revision > controller.revision.current) {
    // A committed save can lose its response; advance only from evidence already present in the Host copy.
    controller.revision.current = saved.revision
    controller.saved.current = saved
    controller.current.current = { ...controller.current.current, revision: saved.revision }
  }
  const current = controller.current.current
  if (current.id !== delivery.project_id) throw new Error('自动采集的项目与搜索会话不匹配，原文仍保留待保存')
  const item = delivery.item
  const url = sourceUrl(item.url)
  const duplicate = current.sources.some(source => source.content_hash === item.content_hash)
  const state: JdWorkspace = current.workspace ?? {
    step: 3, graph_version: current.graphs.at(-1)?.version ?? null, search_status: 'completed', error: '',
    capture: { url: '', title: '', company: '未披露', body: '', file_name: '' },
  }
  controller.current.current = { ...current,
    sources: duplicate ? current.sources : [
      ...current.sources.map(source => source.source_url === url ? { ...source, excluded: true } : source),
      { id: `JD-${crypto.randomUUID()}`, title: item.title, company: '未披露', place: '未独立核验',
        platform: new URL(url).hostname, source_url: url, body: item.body, captured_at: item.captured_at,
        content_hash: item.content_hash, acquisition: 'browser', excluded: false },
    ],
    pending_sources: current.pending_sources.filter(source => source.url !== delivery.requested_url && source.url !== url),
    workspace: { ...state, error: '' },
  }
  controller.edits.current += 1
  notifyJdResearch(controller)
  try { await flushJdResearch(controller, operations.saveJdProject) } catch (reason) {
    const value = controller.current.current
    if (value.workspace) {
      value.workspace = { ...value.workspace, error: reason instanceof Error ? reason.message : '浏览器原文自动保存失败，请重试保存' }
      notifyJdResearch(controller)
    }
    throw reason
  }
}
