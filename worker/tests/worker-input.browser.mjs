import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const source = await readFile(process.argv[2] || new URL('../../apps/web/public/practice-expert-worker.js', import.meta.url), 'utf8')
const template = (await readFile(new URL('../../apps/web/public/practice-expert-interview-spa.html', import.meta.url), 'utf8'))
  .replace('<script>', '<script>window.__TEACHING_PORTAL__=true;</script><script>')
const origin = 'http://127.0.0.1:43129'
const fixture = {
  interview_id: 'synthetic-ime-test', frozen: false, snapshot: null, tasks: [], poll_interval_ms: 100,
  model_label: '受控输入回归测试', can_view_reports: false,
  pack: { fieldnoteId: 'synthetic-ime-pack', profile: { name: '合成角色', role: '输入测试' }, questionPackMeta: { version: 1 }, questions: [
    { id: 'Q01', title: '合成开放题', type: '开放式叙述', question: '请输入合成测试内容。' },
    { id: 'Q02', title: '合成单选题', type: '单项选择', question: '合成单选。', options: ['选项甲', '选项乙'] },
    { id: 'Q03', title: '合成多选题', type: '多项选择', question: '合成多选。', options: ['选项甲', '选项乙'] },
  ] },
  snapshot_template: { questions: [], pack: { key: 'synthetic-ime-pack', goal: '合成输入回归', policy: { scope: 'per_question', maxFollowups: 1 } } },
}
const browser = await chromium.launch({ executablePath: process.env.PORTAL_TEST_CHROMIUM || undefined, headless: true })
const cases = []
const errors = []
let modelRequests = 0
async function openFixture(value = fixture) {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    assert.equal(url.origin, origin, 'The test may not access other hosts')
    if (url.pathname === '/' || url.pathname === '/practice-expert-interview-spa.html') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: template })
    } else if (url.pathname === '/practice-expert-worker.js') {
      await route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: source })
    } else if (url.pathname === '/portal/api/session' && route.request().method() === 'GET') {
      await route.fulfill({ json: value })
    } else {
      if (url.pathname.startsWith('/portal/api/tasks')) modelRequests++
      await route.fulfill({ status: 404, json: { error_code: 'SYNTHETIC_UNEXPECTED_REQUEST' } })
    }
  })
  await page.goto(origin + '/?fieldnoteId=synthetic-ime-pack')
  await page.locator('#answer').waitFor()
  return { context, page }
}
async function draft(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('teaching-worker-draft:v1:synthetic-ime-test')))
}
try {
  const { context, page } = await openFixture()
  await page.locator('#answer').fill('甲乙')
  await page.evaluate(() => {
    const element = document.querySelector('#answer')
    element.focus()
    element.setSelectionRange(1, 1)
    window.originalInput = element
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    element.value = '甲zhong乙'
    element.setSelectionRange(6, 6)
    element.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'zhong' }))
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'zhong', inputType: 'insertCompositionText', isComposing: true }))
  })
  assert.equal(await page.evaluate(() => window.originalInput.isConnected && document.querySelector('#answer') === window.originalInput
    && document.activeElement === window.originalInput), true, 'Composition input replaced or blurred its textarea')
  assert.equal((await draft(page)).answers.Q01.text, '甲乙', 'Uncommitted IME preedit was persisted')
  // A save/status render during composition must wait until the committed input event.
  await page.evaluate(() => document.querySelector('#save-draft').click())
  assert.equal(await page.evaluate(() => document.querySelector('#answer') === window.originalInput), true)
  await page.evaluate(() => {
    const element = document.querySelector('#answer')
    element.value = '甲中乙'
    element.setSelectionRange(2, 2)
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中', inputType: 'insertText', isComposing: false }))
  })
  await page.waitForTimeout(30)
  assert.equal(await page.locator('#answer').inputValue(), '甲中乙')
  assert.deepEqual(await page.locator('#answer').evaluate(element => [document.activeElement === element, element.selectionStart, element.selectionEnd]), [true, 2, 2])
  assert.equal((await draft(page)).answers.Q01.text, '甲中乙')
  cases.push('compositionstart/update/input/end preserves node, focus, committed text and caret; deferred render')

  await page.evaluate(() => { window.originalInput = document.querySelector('#answer') })
  await page.keyboard.type('AB')
  assert.equal(await page.locator('#answer').inputValue(), '甲中AB乙')
  assert.equal(await page.evaluate(() => document.querySelector('#answer') === window.originalInput), true)
  assert.equal(await page.locator('#answer').evaluate(element => element.selectionStart), 4)
  cases.push('ordinary typing retains node, insertion position and automatic draft persistence')

  await page.evaluate(() => {
    const element = document.querySelector('#answer')
    element.setRangeText('粘贴中文', element.selectionStart, element.selectionEnd, 'end')
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '粘贴中文', inputType: 'insertFromPaste' }))
  })
  const expected = '甲中AB粘贴中文乙'
  assert.equal((await draft(page)).answers.Q01.text, expected)
  assert.equal(await page.evaluate(() => document.querySelector('#answer') === window.originalInput), true)
  await page.reload()
  await page.locator('#answer').waitFor()
  assert.equal(await page.locator('#answer').inputValue(), expected)
  await page.locator('#save-draft').click()
  await page.reload()
  await page.locator('#answer').waitFor()
  assert.equal(await page.locator('#answer').inputValue(), expected)
  cases.push('paste input, automatic/manual save and reload restore committed Chinese text')

  await page.locator('[data-go="1"]').click()
  await page.locator('[data-option="0"]').check()
  await page.locator('[data-option="1"]').check()
  assert.equal(await page.locator('[data-option]:checked').count(), 1)
  assert.equal((await draft(page)).answers.Q02.selected, '选项乙')
  await page.locator('[data-go="2"]').click()
  await page.locator('[data-option="0"]').check()
  await page.locator('[data-option="1"]').check()
  assert.equal(await page.locator('[data-option]:checked').count(), 2)
  await page.reload()
  await page.locator('#answer').waitFor()
  assert.equal(await page.locator('[data-option]:checked').count(), 2)
  await page.locator('[data-go="0"]').click()
  assert.equal(await page.locator('#answer').inputValue(), expected)
  cases.push('radio/checkbox changes, navigation and refresh preserve answers and selections')
  await context.close()

  const followupFixture = structuredClone(fixture)
  followupFixture.interview_id = 'synthetic-ime-followup'
  followupFixture.tasks = [{ id: 'synthetic-followup', kind: 'followup', question_id: 'Q01', status: 'succeeded',
    output: { status: 'followup_ready', text: '合成追问，请补充。' } }]
  const followup = await openFixture(followupFixture)
  await followup.page.locator('#supplement').waitFor()
  await followup.page.locator('#supplement').evaluate((element) => {
    element.focus()
    window.originalSupplement = element
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    element.value = 'buc'
    element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
  })
  const supplementBefore = await followup.page.evaluate(() => JSON.parse(localStorage.getItem('teaching-worker-draft:v1:synthetic-ime-followup')))
  assert.equal(supplementBefore.answers.Q01.supplementDraft || '', '')
  await followup.page.locator('#supplement').evaluate((element) => {
    element.value = '合成补充中文'
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '合成补充中文' }))
    element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false }))
  })
  assert.equal(await followup.page.evaluate(() => window.originalSupplement === document.querySelector('#supplement')), true)
  await followup.page.reload()
  await followup.page.locator('#supplement').waitFor()
  assert.equal(await followup.page.locator('#supplement').inputValue(), '合成补充中文')
  await followup.page.locator('#answer').fill('修改后的合成主回答')
  assert.equal(await followup.page.locator('#supplement').count(), 0)
  assert.equal(await followup.page.locator('#confirm').isVisible(), true)
  assert.equal(await followup.page.locator('#confirm').textContent(), '确认回答并分析')
  cases.push('supplement composition/reload and main-answer edits invalidate stale follow-up UI')
  await followup.context.close()
  assert.deepEqual(errors, [])
  assert.equal(modelRequests, 0)
  console.log(JSON.stringify({ passed: true, browser: await browser.version(), cases, modelRequests,
    scope: 'isolated headless browser with synthetic DOM composition events; no Windows native IME or live model acceptance' }, null, 2))
} finally { await browser.close() }
