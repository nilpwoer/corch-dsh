import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const output = resolve(process.argv[2] || '.artifacts/worker-layout')
await mkdir(output, { recursive: true })
const source = await readFile(new URL('../../apps/web/public/practice-expert-worker.js', import.meta.url), 'utf8')
const template = (await readFile(new URL('../../apps/web/public/practice-expert-interview-spa.html', import.meta.url), 'utf8'))
  .replace('<script>', '<script>window.__TEACHING_PORTAL__=true;</script><script>')
const excludedHelper = '只记录专家本人确认的边界，不要替专家推断其所在机构的规定；若专家提到具体制度或文件，请其确认名称与可引用性。'
const origin = 'http://127.0.0.1:43139'
const questions = [
  { id: 'Q01', title: '合成开放题与实际经验', type: '开放式叙述', question: '请描述一次合成测试中的工作经过，说明您采用的方法与判断依据。', helper: excludedHelper, followupPolicy: { input: 'text', maxFollowups: 2 } },
  { id: 'Q02', title: '合成选择题', type: '单项选择', question: '请选择符合合成测试的选项。', options: ['选项甲', '其他'], followupPolicy: { input: 'other', otherOptions: ['其他'], maxFollowups: 2 } },
  { id: 'Q03', title: '合成确认题', type: '授权确认', question: '请确认合成测试选项。', options: ['同意', '不同意'], helper: '保留其它题目的辅助提示', followupPolicy: { input: 'none', maxFollowups: 0 } },
  ...Array.from({ length: 11 }, (_, i) => ({ id: `Q${String(i + 4).padStart(2, '0')}`, title: `合成导航题目 ${i + 4}`, type: '开放式叙述', question: '合成测试内容。', followupPolicy: { input: 'text', maxFollowups: 2 } })),
]
const errors = []
let networkEscapes = 0
const browser = await chromium.launch({ executablePath: process.env.PORTAL_TEST_CHROMIUM || undefined, headless: true })
async function open(width, height, count = 14) {
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  const value = {
    interview_id: `11111111-2222-4333-8444-${String(width).padStart(12, '0')}`, frozen: false, snapshot: null, tasks: [], poll_interval_ms: 100,
    model_label: '此模型标签不应显示', can_view_reports: false,
    pack: { fieldnoteId: 'synthetic-layout-pack', profile: { name: '合成专家', role: '页面核验' }, questionPackMeta: { version: 1 }, questions: structuredClone(questions.slice(0, count)) },
    snapshot_template: { questions: questions.slice(0, count).map(q => ({ id: q.id, text: q.question })), pack: { key: 'synthetic-layout-pack', goal: '合成界面验证', policy: { scope: 'per_question', maxFollowups: 2 } } },
  }
  const submissions = []
  const tasks = new Map()
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) { networkEscapes++; await route.abort(); return }
    if (url.pathname === '/') await route.fulfill({ contentType: 'text/html; charset=utf-8', body: template })
    else if (url.pathname === '/practice-expert-worker.js') await route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: source })
    else if (url.pathname === '/portal/api/session' && route.request().method() === 'GET') await route.fulfill({ json: value })
    else if (url.pathname === '/portal/api/tasks' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      submissions.push(body)
      const task = { id: `synthetic-task-${submissions.length}`, kind: body.kind, question_id: body.question_id, status: 'succeeded', input_version: body.snapshot.input_version,
        ...(body.kind === 'report' ? { report_version: 1 } : { output: { status: 'complete' } }) }
      tasks.set(task.id, task); value.tasks.push(task); value.snapshot = body.snapshot
      if (body.kind === 'report') value.frozen = true
      await route.fulfill({ status: 202, json: { id: task.id, report_version: task.report_version } })
    } else if (url.pathname.startsWith('/portal/api/tasks/')) {
      const task = tasks.get(url.pathname.split('/').at(-1))
      await route.fulfill({ status: task ? 200 : 404, json: task || { error_code: 'SYNTHETIC_UNKNOWN_TASK' } })
    } else await route.fulfill({ status: 404, json: { error_code: 'SYNTHETIC_UNEXPECTED_REQUEST' } })
  })
  await page.goto(origin + '/?fieldnoteId=synthetic-layout-pack')
  await page.locator('#answer').waitFor()
  return { context, page, value, submissions }
}
async function checkDisplay(page) {
  assert.equal(await page.locator('.topbar .saved,.worker-note,.tips,#effective-policy').count(), 0)
  assert.equal(await page.getByRole('heading', { name: '本次访谈', exact: true }).count(), 0)
  assert.equal(await page.getByRole('heading', { name: '回答由您决定', exact: true }).count(), 0)
  assert.equal((await page.locator('body').innerText()).includes(excludedHelper), false)
  assert.equal((await page.locator('body').innerText()).includes('此模型标签不应显示'), false)
  assert.equal(await page.getByRole('heading', { name: '请从您熟悉的地方，慢慢讲起。', exact: true }).count(), 1)
  assert.equal(await page.locator('#review').count(), 0)
  const geometry = await page.evaluate(() => {
    const outline = document.querySelector('.outline'), card = document.querySelector('.question-card'), layout = document.querySelector('.layout'), answer = document.querySelector('#answer')
    const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width } }
    return { viewport: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, layout: box(layout), card: box(card), outline: box(outline), columns: getComputedStyle(layout).gridTemplateColumns,
      layoutDisplay: getComputedStyle(layout).display, outlineDisplay: getComputedStyle(outline).display, outlineMax: getComputedStyle(outline).maxHeight,
      outlineOverflow: getComputedStyle(outline).overflowY, cardMin: getComputedStyle(card).minHeight, cardMax: getComputedStyle(card).maxHeight,
      answerMin: getComputedStyle(answer).minHeight, answerResize: getComputedStyle(answer).resize }
  })
  assert.ok(geometry.overflow <= 1, 'Page has horizontal overflow')
  assert.equal(geometry.outlineMax, '720px'); assert.equal(geometry.outlineOverflow, 'auto')
  assert.equal(geometry.cardMax, 'none'); assert.equal(geometry.answerMin, '145px'); assert.equal(geometry.answerResize, 'vertical')
  assert.equal(geometry.cardMin, geometry.viewport <= 680 ? '600px' : '590px')
  assert.ok(Math.abs(geometry.card.right - geometry.layout.right) < 1, 'Answer card leaves unused right-column space')
  if (geometry.viewport > 680) {
    assert.notEqual(geometry.outlineDisplay, 'none')
    assert.equal(geometry.columns.split(' ').length, 2)
    assert.equal(Math.round(geometry.outline.width), geometry.viewport <= 980 ? 190 : 240)
    if (geometry.viewport >= 1280) assert.equal(Math.round(geometry.card.width), 980)
  } else { assert.equal(geometry.layoutDisplay, 'block'); assert.equal(geometry.outlineDisplay, 'none') }
  for (const id of ['reset', 'voice', 'save-draft', 'previous', 'skip', 'confirm']) {
    const r = await page.locator('#' + id).boundingBox()
    assert.ok(r && r.x >= 0 && r.x + r.width <= geometry.viewport + 1, `${id} overflows viewport`)
  }
  return geometry
}
const measurements = []
try {
  for (const [width, height] of [[1440, 1000], [1024, 900], [960, 900], [680, 900], [390, 844], [320, 750]]) {
    const { context, page, value } = await open(width, height)
    measurements.push(await checkDisplay(page))
    assert.equal(await page.locator('[data-go]').count(), 14)
    await page.locator('#answer').fill('合成验证：扩宽后输入与本机暂存仍正常。')
    await page.locator('#save-draft').click(); await page.reload(); await page.locator('#answer').waitFor()
    assert.equal(await page.locator('#answer').inputValue(), '合成验证：扩宽后输入与本机暂存仍正常。')
    assert.equal(value.pack.questions[0].helper, excludedHelper)
    await checkDisplay(page)
    if (width === 1440 || width === 390) await page.screenshot({ path: resolve(output, `worker-ui-${width}.png`), fullPage: true })
    await context.close()
  }
  const { context, page, value, submissions } = await open(1440, 1000, 3)
  await page.locator('#answer').fill('合成提交内容。'); await page.locator('#confirm').click()
  await page.getByRole('button', { name: '继续下一步', exact: true }).waitFor(); await page.locator('#confirm').click()
  await page.locator('[data-option="0"]').check(); assert.equal(await page.locator('#answer').count(), 0)
  await page.locator('[data-option="1"]').check(); assert.equal(await page.locator('[data-option]:checked').count(), 1)
  await page.locator('#answer').fill('合成其他说明。'); await page.locator('#confirm').click()
  await page.getByRole('button', { name: '继续下一步', exact: true }).waitFor(); await page.locator('#confirm').click()
  await page.getByText('保留其它题目的辅助提示', { exact: true }).waitFor()
  assert.equal(await page.locator('#answer').count(), 0); await page.locator('[data-option="0"]').check(); await page.locator('#confirm').click()
  await page.getByRole('button', { name: '继续下一步', exact: true }).waitFor(); await page.locator('#confirm').click()
  await page.getByRole('heading', { name: '确认本次访谈', exact: true }).waitFor()
  await page.getByText(/生成报告后不能修改本次答案/).waitFor(); await page.locator('#report').click()
  await page.getByRole('heading', { name: '访谈报告', exact: true }).waitFor(); await page.reload()
  await page.getByRole('heading', { name: '访谈报告', exact: true }).waitFor()
  assert.equal(await page.locator('#answer').count(), 0); assert.equal(value.frozen, true)
  assert.equal(submissions.filter(t => t.kind === 'followup').length, 3); assert.equal(submissions.filter(t => t.kind === 'report').length, 1)
  assert.equal(submissions[0].snapshot.answers[0].text_input, '合成提交内容。')
  assert.deepEqual(submissions[1].snapshot.answers[1].selected_options, ['其他'])
  assert.equal(value.pack.questions[0].helper, excludedHelper)
  await page.screenshot({ path: resolve(output, 'worker-ui-frozen-report.png'), fullPage: true }); await context.close()
  assert.deepEqual(errors, []); assert.equal(networkEscapes, 0)
  const result = { passed: true, browser: await browser.version(), viewports: measurements, height_and_scroll_rules_preserved: true,
    specified_displays_removed: true, answer_uses_released_width: true, other_helpers_preserved: true, package_hint_data_unchanged: true,
    draft_reload_choices_submit_and_frozen_report_verified: true, real_model_calls: 0, production_access: false, scope: 'Actual HTML and Worker JS in isolated Edge; synthetic HTTP responses, no live model or database acceptance' }
  await writeFile(resolve(output, 'layout-verification.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, viewports: measurements.length, desktop_answer_width: measurements[0].card.width, real_model_calls: 0, output }))
} finally { await browser.close() }
