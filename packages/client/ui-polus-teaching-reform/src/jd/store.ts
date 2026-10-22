/** Private, atomic research-project persistence; source bytes and graph history are append-only. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { identifier, parseProject } from './document.ts'
import type { JdProject, JdProjectSummary } from './types.ts'

/** File-backed project repository shared by browser and desktop clients. */
export class JdProjectStore {
  /**
   * @param directory - Private directory owned by this plugin.
   * @param maxProjectBytes - Maximum serialized size accepted on both read and write.
   */
  constructor(
    private readonly directory: string,
    private readonly maxProjectBytes: number,
  ) {}

  /** Read one validated project; absence is distinct from corrupt or unsupported data.
   * @param id - Project identifier, never a path.
   * @returns The project or null if not yet saved.
   */
  async read(id: string): Promise<JdProject | null> {
    let bytes: string
    try {
      bytes = await readFile(join(this.directory, `${identifier(id)}.json`), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (Buffer.byteLength(bytes) > this.maxProjectBytes) throw new Error('JD 项目超过存储大小限制')
    const project = parseProject(JSON.parse(bytes))
    if (project.id !== id) throw new Error('JD 项目文件编号不匹配')
    this.verifyHashes(project)
    return project
  }

  /** List saved projects without exposing source bodies in the roster.
   * @returns Most recently updated projects first; corruption rejects instead of hiding records.
   */
  async list(): Promise<JdProjectSummary[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const projects = await Promise.all(
      (await readdir(this.directory))
        .filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name))
        .map(async (name) => {
          const project = await this.read(name.slice(0, -5))
          if (!project) throw new Error('JD 项目在读取期间被移除，请刷新')
          const { id, session_id, title, revision, updated_at } = project
          return { id, session_id, title, revision, updated_at }
        }),
    )
    return projects.sort((left, right) => right.updated_at.localeCompare(left.updated_at))
  }

  /** Atomically append sources or graph versions and update selection and search filters.
   * @param value - Complete next project at the revision previously read.
   * @returns Committed document with incremented revision and Host timestamp.
   */
  async save(value: unknown): Promise<JdProject> {
    const project = parseProject(value)
    const filename = join(this.directory, `${project.id}.json`)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    return withFileLock(filename, async () => {
      const previous = await this.read(project.id)
      if ((previous?.revision ?? 0) !== project.revision) throw new Error('项目已在其他窗口更新，请重新打开后再保存')
      if (previous) {
        if (previous.session_id !== project.session_id) throw new Error('项目所属会话不能更改')
        if (previous.graphs.some((graph, index) => JSON.stringify(graph) !== JSON.stringify(project.graphs[index])))
          throw new Error('已保存的图谱版本不能覆盖或删除')
        for (const source of previous.sources) {
          const next = project.sources.find(item => item.id === source.id)
          if (!next || JSON.stringify({ ...source, excluded: false }) !== JSON.stringify({ ...next, excluded: false }))
            throw new Error('已保存 JD 原文及来源不能覆盖或删除；请新增采集记录')
        }
      }
      const excluded = new Set(project.sources.filter(source => source.excluded).map(source => source.id))
      if (project.graphs.slice(previous?.graphs.length ?? 0)
        .some(graph => Object.keys(graph.source_hashes).some(id => excluded.has(id))))
        throw new Error('新增图谱不能引用已剔除的 JD 原文')
      this.verifyHashes(project)
      const next = { ...project, revision: project.revision + 1, updated_at: new Date().toISOString() }
      const bytes = JSON.stringify(next, null, 2) + '\n'
      if (Buffer.byteLength(bytes) > this.maxProjectBytes) throw new Error('JD 项目超过存储大小限制')
      await writeFileAtomic(filename, bytes, { mode: 0o600, dirMode: 0o700 })
      return next
    })
  }

  private verifyHashes(project: JdProject): void {
    for (const source of project.sources) {
      if (createHash('sha256').update(source.body).digest('hex') !== source.content_hash)
        throw new Error(`JD 原文哈希不匹配：${source.id}`)
    }
  }
}
