import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const { build } = createRequire(require.resolve('tsx'))('esbuild')
const output = resolve(process.argv[2] || '.artifacts/answer-modes')
await mkdir(output, { recursive: true })
const source = await readFile(new URL('../../apps/web/public/practice-expert-worker.js', import.meta.url), 'utf8')
const template = (await readFile(new URL('../../apps/web/public/practice-expert-interview-spa.html', import.meta.url), 'utf8'))
  .replace('<script>', '<script>window.__TEACHING_PORTAL__=true;</script><script>')
const origin = 'http://127.0.0.1:43149'
const questions = ['text', 'choice', 'mixed', 'other'].map((answerMode, i) => ({ id: `Q0${i + 1}`, title: `合成${answerMode}题`, type: '单项选择', answerMode,
  question: '固定合成任务，不包含真实受访者信息。', ...(answerMode === 'text' ? {} : { options: ['常规方式', '其他（请说明）'] }),
  followupPolicy: { input: answerMode === 'choice' ? 'none' : answerMode === 'other' ? 'other' : 'text', maxFollowups: answerMode === 'choice' ? 0 : 2,
    ...(answerMode === 'other' ? { otherOptions: ['其他（请说明）'] } : {}) },
  sourceRefs: [{ sourceType: 'model_inference', title: '固定合成数据', rationale: '离线验证', confidence: 'low', requiresConfirmation: true }],
}))
const entry = `import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {InterviewWorkbench} from ${JSON.stringify(resolve(repo,'packages/client/ui-polus-teaching-reform/src/client/InterviewWorkbench.tsx'))};
import {createPublication} from ${JSON.stringify(resolve(repo,'packages/client/ui-polus-teaching-reform/src/client/publication.ts'))};
window.exportSyntheticPublication=()=>{const row=JSON.parse(localStorage.getItem('dsh.practice-expert-interviews.v2'))[0];return createPublication({fieldnoteId:'synthetic-modes',publicFieldnoteId:'synthetic-modes',goal:'离线模式验证',profile:row.profile,questions:row.questions,questionPackMeta:row.questionPackMeta,invitation:undefined,interviewPolicy:undefined},'fixed')};
createRoot(document.getElementById('root')).render(<InterviewWorkbench initialTab="questions" sessionId="synthetic-session" observeInterviewCommands={()=>()=>{}} generateInterview={()=>Promise.reject(Error('Generation is forbidden in this fixture'))}/>);`
const bundle = await build({ stdin: { contents: entry, resolveDir: repo, loader: 'tsx' }, bundle: true, write: false, outfile: 'workbench.js', format: 'iife',
  jsx: 'automatic', loader: { '.css': 'local-css' }, alias: { react: dirname(require.resolve('react')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
const browser = await chromium.launch({ executablePath: process.env.PORTAL_TEST_CHROMIUM || undefined, headless: true })
const errors = []
let escaped = 0, productionRequests = 0
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(({ questions }) => {
    const key = 'dsh.practice-expert-interviews.v2'
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify([{ record: { id: 'synthetic-session', fieldnoteId: 'synthetic-modes', title: '合成验证', expert: '合成专家', industry: '合成', status: '待审阅', updated: 'fixed' },
      profile: { name: '合成专家', industry: '合成', role: '合成', years: '合成', stage: '合成', experience: '无真实资料' }, questions,
      questionPackMeta: { packId: 'synthetic-modes', version: 1, checksum: 'synthetic', generatedAt: 'fixed' } }]))
  }, { questions })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) { escaped++; await route.abort(); return }
    if (url.pathname === '/') await route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><link rel="stylesheet" href="/workbench.css"><div id="root"></div><script src="/workbench.js"></script>' })
    else {
      const file = bundle.outputFiles.find(file => file.path.replaceAll('\\', '/').endsWith(url.pathname))
      if (file) await route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: Buffer.from(file.contents) })
      else { productionRequests++; await route.abort() }
    }
  })
  await page.goto(origin)
  await page.locator('summary').first().waitFor({ timeout: 5000 }).catch(async error => {
    console.error(JSON.stringify({ errors, body: (await page.locator('body').innerText()).slice(0, 1200), escaped, productionRequests }))
    throw error
  })
  await page.getByText('合成mixed题', { exact: false }).first().waitFor()
  const choiceCard = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '合成choice题' }) })
  await choiceCard.getByRole('button', { name: '编辑问题', exact: true }).click()
  await choiceCard.getByLabel('回答模式', { exact: true }).selectOption('mixed')
  await choiceCard.getByRole('button', { name: '保存修改', exact: true }).click()
  await page.reload()
  const publication = await page.evaluate(() => window.exportSyntheticPublication())
  assert.deepEqual(publication.questions.map(q => q.answerMode), ['text', 'mixed', 'mixed', 'other'])
  assert.equal(publication.questionPackMeta.version, 2)
  assert.equal(publication.questions[1].followupPolicy.input, 'text')
  await page.screenshot({ path: resolve(output, 'host-mode-edit.png'), fullPage: true })
  await writeFile(resolve(output, 'synthetic-publication.json'), JSON.stringify(publication, null, 2) + '\n')
  await context.close()

  const participant = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const spa = await participant.newPage()
  spa.on('pageerror', e => errors.push(e.message))
  const value = { interview_id: 'synthetic-mode-interview', frozen: false, snapshot: null, tasks: [], poll_interval_ms: 20,
    pack: { ...publication, questions }, snapshot_template: { questions: questions.map(q => ({ id: q.id, text: q.question, options: q.options, followup_policy: q.followupPolicy })),
      pack: { key: 'synthetic-modes', goal: '离线验证', policy: { scope: 'per_question', maxFollowups: 2 } } } }
  const submissions = [], tasks = new Map()
  await spa.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) { escaped++; await route.abort(); return }
    if (url.pathname === '/') await route.fulfill({ contentType: 'text/html', body: template })
    else if (url.pathname === '/practice-expert-worker.js') await route.fulfill({ contentType: 'text/javascript', body: source })
    else if (url.pathname === '/portal/api/session') await route.fulfill({ json: value })
    else if (url.pathname === '/portal/api/tasks' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); submissions.push(body); value.snapshot = body.snapshot
      const task = { id: `synthetic-task-${submissions.length}`, kind: body.kind, question_id: body.question_id, input_version: body.snapshot.input_version, status: 'succeeded', output: { status: 'complete' } }
      value.tasks.push(task); tasks.set(task.id, task); await route.fulfill({ status: 202, json: { id: task.id } })
    } else if (url.pathname.startsWith('/portal/api/tasks/')) await route.fulfill({ json: tasks.get(url.pathname.split('/').at(-1)) })
    else { productionRequests++; await route.abort() }
  })
  await spa.goto(origin + '/?fieldnoteId=synthetic-modes')
  await spa.locator('#answer').fill('合成开放文字'); assert.equal(await spa.locator('[data-option]').count(), 0)
  await spa.locator('[data-go="1"]').click(); assert.equal(await spa.locator('#answer').count(), 0)
  await spa.locator('[data-option="1"]').check(); assert.equal(await spa.locator('#answer').count(), 0)
  await spa.locator('[data-go="2"]').click(); await spa.locator('#answer').fill('合成混合回答')
  await spa.locator('[data-option="0"]').check(); assert.equal(await spa.locator('#answer').inputValue(), '合成混合回答')
  await spa.locator('#save-draft').click(); await spa.reload(); await spa.locator('#answer').waitFor()
  assert.equal(await spa.locator('#answer').inputValue(), '合成混合回答'); assert.equal(await spa.locator('[data-option="0"]').isChecked(), true)
  await spa.screenshot({ path: resolve(output, 'participant-mixed-desktop.png'), fullPage: true })
  await spa.setViewportSize({ width: 390, height: 844 }); await spa.screenshot({ path: resolve(output, 'participant-mixed-mobile.png'), fullPage: true })
  assert.equal(await spa.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await spa.setViewportSize({ width: 1440, height: 1000 })
  await spa.locator('#confirm').click(); await spa.getByRole('button', { name: '继续下一步', exact: true }).waitFor()
  const mixed = submissions[0].snapshot.answers.find(a => a.question_id === 'Q03')
  assert.equal(mixed.text_input, '合成混合回答'); assert.deepEqual(mixed.selected_options, ['常规方式'])
  await spa.locator('[data-go="3"]').click(); assert.equal(await spa.locator('#answer').count(), 0)
  await spa.locator('[data-option="0"]').check(); assert.equal(await spa.locator('#answer').count(), 0)
  await spa.locator('[data-option="1"]').check(); await spa.locator('#answer').fill('合成其他补充')
  await spa.locator('[data-option="0"]').check(); assert.equal(await spa.locator('#answer').count(), 0)
  await spa.locator('[data-option="1"]').check(); assert.equal(await spa.locator('#answer').inputValue(), '合成其他补充')
  await participant.close()
  assert.equal(escaped, 0); assert.equal(productionRequests, 0); assert.deepEqual(errors, [])
  const proof = { passed: true, host_edit_save_reload_republish: true, four_modes: true, mixed_draft_and_payload: true, conditional_other: true,
    desktop_and_mobile: true, production_requests: 0, paid_model_calls: 0, scope: 'Actual host React and participant JS; all network intercepted, fixed synthetic data; model ceiling tested separately in Worker engine tests' }
  await writeFile(resolve(output, 'browser-verification.json'), JSON.stringify(proof, null, 2) + '\n'); console.log(JSON.stringify(proof))
} finally { await browser.close() }
