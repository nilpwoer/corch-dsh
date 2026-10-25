/** Regenerate rejected model graphs without changing evidence, prompts or validation rules. */
import { graphNodes, record } from '../jd/document.ts'
import type { JdGenerationPolicy, JdGraphNode, JdProject } from '../jd/types.ts'
import { buildJdGraphPrompt } from './jdSearchPrompt.ts'

/** Validate completed model responses before exposing one new graph version.
 * @param project - Owning search and immutable source corpus for this generation.
 * @param request - One settled model response; cancellation and transport failures reject without a graph retry.
 * @param policy - Host-configured attempt and waiting limits.
 * @param progress - Human-readable attempt status, retained by the owning workbench.
 * @param signal - Owning plugin lifetime; abort prevents further requests.
 * @returns The first graph whose full hierarchy, literal evidence and inference labels pass existing validation.
 */
export async function generateValidatedJdGraph(
  project: JdProject,
  request: (prompt: string) => Promise<string>,
  policy: JdGenerationPolicy,
  progress: (message: string) => void,
  signal: AbortSignal,
): Promise<{ nodes: JdGraphNode[] }> {
  const prompt = buildJdGraphPrompt(project)
  let failure = ''
  for (let attempt = 1; attempt <= policy.maxGraphAttempts; attempt++) {
    signal.throwIfAborted()
    progress(attempt === 1 ? `正在生成能力图谱（${attempt}/${policy.maxGraphAttempts}）…`
      : `图谱未通过校验，正在重新生成（${attempt}/${policy.maxGraphAttempts}）…`)
    const text = await request(prompt)
    signal.throwIfAborted()
    let parsed: Record<string, unknown>
    try {
      const start = text.indexOf('{'), end = text.lastIndexOf('}')
      parsed = record(JSON.parse(text.slice(start, end + 1)))
    } catch {
      failure = '模型返回的图谱内容格式不完整。'
      continue
    }
    try { return { nodes: graphNodes(parsed, project.sources) } }
    catch (error) {
      const reason = error instanceof Error ? error.message : ''
      failure = /原文未直接陈述|标注原文依据或推断/u.test(reason) ? '部分归纳内容未正确标为推断。'
        : /父级|分支|层级/u.test(reason) ? '部分分支未完整到知识点，或层级关系不正确。'
          : '来源引文或图谱内容未通过核验。'
    }
  }
  throw new Error(`能力图谱连续 ${policy.maxGraphAttempts} 次未通过校验，未保存新版本。请重试或更换模型。${failure}`)
}
