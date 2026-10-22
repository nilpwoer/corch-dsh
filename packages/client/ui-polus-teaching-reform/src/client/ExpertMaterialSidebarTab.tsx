import type { ReactNode } from 'react'
import type { ExpertMaterial } from './types.ts'
import css from './InterviewWorkbench.module.css'

export function ExpertMaterialSidebarTab({ material }: { material: ExpertMaterial }): ReactNode {
  return <article className={css.materialPreview}>
    <header className={css.materialPreviewHeader}>
      <div>
        <strong>
          {material.name}
        </strong>
        <small>已整理 · 已加入问题生成素材</small>
      </div>
      <span className={css.pill}>
        {material.sourceType}
      </span>
    </header>
    <div className={css.materialPreviewBody}>
      <p className={css.muted}>以下为LLM整理后的Markdown素材预览，主持人上传前已确认原始资料事实。</p>
      <pre>
        {material.markdown}
      </pre>
    </div>
  </article>
}
