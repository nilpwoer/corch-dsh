import { test,expect } from 'vitest'
import { GLOBAL_REFERENCE_CORPUS,seedCorpusDocuments,resolveCorpusDocument,referenceExcerpts,generationExcerpt } from '../src/client/globalReferenceCorpus.ts'
import { createQuestionPackMeta } from '../src/client/questionPack.ts'

test('all fourteen exact supplied bodies resolve with stable provenance and bounded verbatim passages',()=>{
  const docs=seedCorpusDocuments([]).map(resolveCorpusDocument)
  expect(docs).toHaveLength(14)
  expect(docs.filter(d=>d.tier)).toHaveLength(12)
  let size=0
  for(const d of docs){
    expect(d.markdown.length).toBeGreaterThan(10000)
    expect(d.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(d.sourceFile).toContain('赵志群著作_MD/')
    for(const x of referenceExcerpts(d))expect(d.markdown.split('\n')[x.line-1]?.slice(x.column-1,x.endColumn)).toBe(x.text)
    size+=generationExcerpt(d).length
    const meta=createQuestionPackMeta({ questions:[],sessionId:'fixture',generatedAt:'fixture',packId:'fixture',version:1,references:[d] })
    expect(meta.globalReferences?.[0]?.sourceHash).toBe(d.sourceHash)
    expect(meta.globalReferences?.[0]?.excerpts).toEqual(referenceExcerpts(d))
  }
  expect(size).toBeLessThan(42000)
})

test('existing edits, imported bodies, enabled and archive choices win over built-in seed updates',()=>{
  const saved={ id:'GREF-S1',title:'用户编辑的标题',markdown:'用户自己的正文',version:7,updatedAt:'saved',enabled:false,archivedAt:'saved',origin:'user' as const }
  const seeded=seedCorpusDocuments([saved])
  expect(seeded[0]).toEqual(saved)
  expect(resolveCorpusDocument(saved)).toBe(saved)
  expect(resolveCorpusDocument(saved).sourceHash).toBeUndefined()
  expect(GLOBAL_REFERENCE_CORPUS.map(d=>d.id).slice(0,12)).toEqual(['GREF-S1','GREF-S2','GREF-S3','GREF-S4','GREF-A1','GREF-A2','GREF-A3','GREF-A4','GREF-A5','GREF-A6','GREF-B1','GREF-B2'])
  expect(()=>resolveCorpusDocument({ ...saved,id:'missing',markdown:'',origin:'bundled-corpus' })).toThrow('未使用摘要替代')
})
