import type { GlobalReferenceDocument, ReferenceTier } from './interviewTypes.ts'

export type { ReferenceTier } from './interviewTypes.ts'

type CorpusEntry = {
  id: string
  tier: ReferenceTier
  title: string
  file: string
  summary: string
}

type CorpusTuple = readonly [id: string, tier: ReferenceTier, title: string, file: string, summary: string]

// Metadata is kept in the bundle; long Markdown bodies remain static assets so
// the plugin bundle does not grow by several megabytes.
const CORPUS_ROWS: readonly CorpusTuple[] = [
  ['GREF-S1', 'S', '职业教育的课程建设与教学改革', 'GREF-S1-2019.md', '赵志群方法论五层结构：理论根基、能力模型、典型工作任务、学习领域、教学项目。'],
  ['GREF-S2', 'S', '职业教育工学结合一体化课程开发指南', 'GREF-S2-2009.md', 'EXWOWO实践专家研讨会法、职业资格研究、典型工作任务、完整工作过程和学习领域六维描述。'],
  ['GREF-S3', 'S', '职业教育学习新概念（第 2 版）', 'GREF-S3-2021.md', '补充工业4.0、职业教育集团、质量保障、BAG、COMET与授权评价等理论。'],
  ['GREF-S4', 'S', '职业能力测评方法手册', 'GREF-S4-2018.md', 'COMET职业能力测评、三层能力模型和五维评价，用于能力层次与质量证据问题。'],
  ['GREF-A1', 'A', '职业能力与职业能力测评：KOMET 理论基础与方案', 'GREF-A1-2010.md', 'KOMET能力模型与测评方案，支持设计、过程、功能层次探查。'],
  ['GREF-A2', 'A', '职业教育行动导向的教学', 'GREF-A2-2016.md', '行动导向基本概念、职业能力、教学方法与传统方法比较。'],
  ['GREF-A3', 'A', '职业教育教师教学手册', 'GREF-A3-2013.md', '职业学习、课程开发、教学设计、媒体与质量监控主题。'],
  ['GREF-A4', 'A', '职业院校学生职业能力测评的实证研究', 'GREF-A4-2012.md', '职业能力测评的实证研究与质量评价案例。'],
  ['GREF-A5', 'A', '国际职业教育科学研究手册（上册）', 'GREF-A5-2014.md', '国际TVET体系、政策法规与跨文化比较研究。'],
  ['GREF-A6', 'A', '国际职业教育科学研究手册（下册）', 'GREF-A6-2017.md', 'BAG、EXWOWO、职业资格研究与工作过程知识方法。'],
  ['GREF-B1', 'B', '以实践为导向的职业教育—中德农村职业教育合作课程方案',
    'GREF-B1-2004.md', '农业机械化、农学、林果、园艺和畜牧养殖等真实课程方案案例。'],
  ['GREF-B2', 'B', '职业教育与培训学习新概念（第 1 版）', 'GREF-B2-2003.md', '行动导向与工作过程系统化课程的早期理论与历史背景。'],
]

export const GLOBAL_REFERENCE_CORPUS: readonly CorpusEntry[] = CORPUS_ROWS.map(
  ([id, tier, title, file, summary]) => ({ id, tier, title, file, summary }),
)

/** Runtime-safe compact extraction of the two requested handoff documents. */
export const CORE_METHOD_RULES = `
全局基础文献池 v1.0 的职责：提供问题结构、题型依据和来源可信度，不代表当前专家事实。S级是核心方法论底座，A级按题型补充，B级只作案例/历史补盲。
典型工作任务是工作过程结构完整的综合性任务，反映职业典型工作内容与方式，完成过程促进职业能力发展，方法和结果具有一定开放性；不得把高频、单一、封闭的常规操作直接当作典型工作任务。
问题包生成后必须经过：项目范围与专家材料收集 → 候选问题生成 → 每题为什么问/为什么问该专家/答案如何核实/来源是否诚实四问检查 → JSON、题数、编号、来源和题型覆盖校验 → 主持人审阅。
每题采用开放回忆、选项辅助、证据追问、专家确认的混合结构；选项只帮助回忆，不是标准答案，并保留其他/补充/不适用。
每题 sourceRefs 必须说明真实来源、作用、置信度和可核验定位；global_reference 只能引用实际输入的文献，不能杜撰页码、章节或原话。LLM 行业知识和模型推断必须标为待确认，不能写成专家事实。
`

export function seedCorpusDocuments(existing: readonly GlobalReferenceDocument[]): GlobalReferenceDocument[] {
  const byId = new Map(existing.map(document => [document.id, document]))
  const now = new Date().toISOString()
  for (const entry of GLOBAL_REFERENCE_CORPUS) {
    if (byId.has(entry.id)) continue
    byId.set(entry.id, {
      id: entry.id,
      title: entry.title,
      markdown: '',
      version: 1,
      updatedAt: now,
      enabled: true,
      tier: entry.tier,
      sourceFile: entry.file,
      origin: 'bundled-corpus',
      summary: entry.summary,
    } as GlobalReferenceDocument)
  }
  const seeded = GLOBAL_REFERENCE_CORPUS.map((entry) => {
    const document = byId.get(entry.id)
    if (document === undefined) throw new Error(`Missing seeded corpus document: ${entry.id}`)
    return { ...document, tier: entry.tier, sourceFile: entry.file, origin: 'bundled-corpus' as const, summary: entry.summary }
  })
  return [...seeded, ...existing.filter(document => !GLOBAL_REFERENCE_CORPUS.some(entry => entry.id === document.id))]
}

export async function hydrateCorpusDocument(document: GlobalReferenceDocument): Promise<GlobalReferenceDocument> {
  if (document.markdown.trim() !== '') return document
  try {
    return { ...document, markdown: `# ${document.title}\n\n${document.summary ?? '内置 v1.0 文献池文献。'}` }
  } catch {
    return { ...document, markdown: `# ${document.title}\n\n${document.summary ?? '内置 v1.0 文献池文献。'}` }
  }
}

export async function hydrateCorpusDocuments(documents: readonly GlobalReferenceDocument[]): Promise<GlobalReferenceDocument[]> {
  return await Promise.all(documents.map(document => hydrateCorpusDocument(document)))
}

/** Keep generation context relevant and bounded while retaining full-text preview. */
export function generationExcerpt(document: GlobalReferenceDocument): string {
  if (document.markdown.length <= 12000) return document.markdown
  const cap = document.tier === 'S' ? 9000 : document.tier === 'A' ? 2500 : 1200
  const lines = document.markdown.split('\n')
  const matches: string[] = []
  const keywords = /典型工作任务|实践专家研讨会|EXWOWO|工作过程|职业资格研究|能力模型|学习领域|质量监控|职业行动领域/i
  for (let index = 0; index < lines.length; index += 1) {
    if (!keywords.test(lines[index] ?? '')) continue
    const excerpt = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 8)).join('\n').trim()
    if (excerpt !== '' && !matches.includes(excerpt)) matches.push(excerpt)
    if (matches.join('\n\n').length >= cap) break
  }
  const selected = matches.join('\n\n').slice(0, cap)
  return `（以下为按方法主题从文献全文提取的上下文片段；完整原文可在 better-sidebar 预览。）\n\n${selected || document.markdown.slice(0, cap)}`
}
