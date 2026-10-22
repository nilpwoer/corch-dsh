/** Actual desktop/Loader/model/tool flow with synthetic external systems and saved-output snapshots. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, readdir, symlink, realpath, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { backendEnvironment } from './policy.mjs'
import { fixtureBody, startJdFixture } from './jd-research-fixture.mjs'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { _electron: electron } = require('playwright')
const { values } = parseArgs({ options: { exe: { type: 'string' }, data: { type: 'string' }, out: { type: 'string' }, source: { type: 'boolean' }, update: { type: 'boolean' } } })
assert.ok(values.exe && values.data && values.out, 'Supply --exe, --data and --out')
const data = resolve(values.data), out = resolve(values.out)
await mkdir(out, { recursive: true })
const profile = join(data, 'dsh/profiles/web')
await mkdir(profile, { recursive: true })
if (values.source) {
  await mkdir(join(profile, 'node_modules/@polus-ai'), { recursive: true })
  await symlink(resolve('packages/client/ui-polus-teaching-reform'), join(profile, 'node_modules/@polus-ai/dsh-client-ui-teaching-reform'), 'junction')
  await symlink(await realpath('apps/desktop/node_modules/dsh-better-sidebar'), join(profile, 'node_modules/dsh-better-sidebar'), 'junction')
}
const fixture = await startJdFixture()
await writeFile(join(profile, 'cordis.patch.yml'), `- id: web-search-deepseek\n  config:\n    apiKey: synthetic-search-only\n    baseURL: ${fixture.origin}/anthropic\n- id: session-title-llm\n  disabled: true\n`)
let desktop, page, passed = false
const checks = [], errors = []
const presentation = {}
async function launch() {
  desktop = await electron.launch({ executablePath: resolve(values.exe), args: [...(values.source ? [resolve('apps/desktop/main.mjs')] : []), '--data-dir', data, '--lang=zh-CN'],
    env: backendEnvironment(process.env, join(data, 'unused')), timeout: 45000 })
  page = await desktop.firstWindow({ timeout: 60000 })
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('button', { name: 'JD 搜索', exact: true }).waitFor()
  for (const [name, action] of [['欢迎使用 Corch DSH', '继续'], ['添加一个 API Key 开始使用', '稍后配置']]) {
    try { await page.getByRole('dialog', { name, exact: true }).waitFor({ timeout: 5000 }) }
    catch (error) { if (error.name === 'TimeoutError') continue; throw error }
    await page.getByRole('dialog', { name, exact: true }).getByRole('button', { name: action, exact: true }).click()
  }
}
async function rpc(channel, method, payload = {}) {
  return page.evaluate(async ({ channel, method, payload }) => {
    const response = await fetch(channel + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }) })
    if (!response.ok) throw new Error('RPC HTTP ' + response.status)
    const result = (await response.json()).result
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }, { channel, method, payload })
}
async function openResearch() {
  await page.getByRole('button', { name: 'JD 搜索', exact: true }).click()
  const open = page.getByRole('button', { name: '打开侧边栏', exact: true })
  if (await open.count()) await open.click()
}
async function buttonMetrics(controls) {
  return Promise.all(controls.map(async ([name, control]) => control.evaluate((element, label) => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect()
    return { name: label, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      font: [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight],
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      radius: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius] }
  }, name)))
}
async function narrowControls(controls, filename) {
  const nativeMain = await desktop.browserWindow(page)
  const originalBounds = await nativeMain.evaluate(window => window.getBounds())
  const collapseSidebar = page.getByRole('button', { name: '收起侧边栏', exact: true })
  const sidebarWasOpen = await collapseSidebar.isVisible()
  try {
    if (sidebarWasOpen) await collapseSidebar.click()
    await nativeMain.evaluate(window => { window.setSize(1300, 900); window.focus() })
    await page.waitForFunction(() => innerWidth <= 1300)
    await controls[0][1].scrollIntoViewIfNeeded()
    const dimensions = await page.getByRole('main').filter({ has: page.getByLabel('打开已保存项目', { exact: true }) }).evaluate(async main => {
      let container = main.parentElement
      while (container.parentElement && !/auto|scroll/u.test(getComputedStyle(container).overflowY)) container = container.parentElement
      let previous, stableFrames = 0, frames = 0
      const started = performance.now()
      while (performance.now() - started < 5000) {
        await new Promise(resolve => requestAnimationFrame(resolve))
        const bounds = container.getBoundingClientRect()
        const sample = [innerWidth, bounds.left, bounds.right, bounds.width, main.clientWidth, main.scrollWidth].map(value => Math.round(value * 100) / 100).join(',')
        stableFrames = sample === previous ? stableFrames + 1 : 0
        previous = sample
        frames++
        if (stableFrames >= 6 && bounds.width > 0 && bounds.left >= -1 && bounds.right <= innerWidth + 1) break
      }
      const rect = container.getBoundingClientRect()
      const describe = element => {
        const bounds = element.getBoundingClientRect(), style = getComputedStyle(element)
        return { tag: element.tagName, classes: String(element.className), text: (element.textContent || '').trim().slice(0, 100),
          rect: { left: bounds.left, right: bounds.right, width: bounds.width, top: bounds.top, height: bounds.height },
          client_width: element.clientWidth, scroll_width: element.scrollWidth,
          style: { display: style.display, width: style.width, min_width: style.minWidth, max_width: style.maxWidth, box_sizing: style.boxSizing,
            overflow_x: style.overflowX, overflow_y: style.overflowY, white_space: style.whiteSpace, flex: style.flex, gap: style.gap, grid_template_columns: style.gridTemplateColumns } }
      }
      const left = rect.left + container.clientLeft, right = rect.left + container.clientLeft + container.clientWidth
      const overflowElements = [...main.querySelectorAll('*')].filter(element => {
        const bounds = element.getBoundingClientRect()
        return element.getClientRects().length && (bounds.left < Math.max(0, left) - 1 || bounds.right > Math.min(innerWidth, right) + 1
          || element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible')
      }).slice(0, 50).map(describe)
      const ancestors = []
      for (let element = main; element && ancestors.length < 10; element = element.parentElement) ancestors.push(describe(element))
      return { viewport: innerWidth, content_width: main.clientWidth, content_scroll_width: main.scrollWidth,
        left, right, container_width: rect.width, container_right: rect.right, settled_frames: stableFrames, sampled_frames: frames, settle_ms: Math.round(performance.now() - started),
        container_within_viewport: rect.left >= -1 && rect.right <= innerWidth + 1, overflow_elements: overflowElements, ancestors }
    })
    const metrics = await buttonMetrics(controls)
    const evidence = { ...dimensions, controls: metrics }
    ;(presentation.narrow_checks ??= []).push({ screenshot: filename, ...evidence })
    await writeFile(join(out, filename.replace(/\.png$/u, '.json')), JSON.stringify(evidence, null, 2) + '\n')
    await page.screenshot({ path: join(out, filename), fullPage: false })
    assert.ok(dimensions.container_width > 0, 'Compact JD workbench must remain open')
    assert.ok(dimensions.settled_frames >= 6, 'Narrow JD layout did not settle across animation frames')
    assert.equal(dimensions.container_within_viewport, true, 'Narrow JD workbench extends beyond the actual viewport')
    assert.ok(dimensions.content_scroll_width <= dimensions.content_width + 1, 'Narrow JD workbench overflows horizontally')
    for (const control of metrics) {
      assert.ok(control.width > 0 && control.x >= dimensions.left - 1 && control.x + control.width <= dimensions.right + 1,
        `Narrow control is clipped: ${control.name}`)
    }
    return evidence
  } finally {
    await nativeMain.evaluate((window, bounds) => window.setBounds(bounds), originalBounds)
    await page.waitForFunction(width => innerWidth > width, 1300)
    if (sidebarWasOpen) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click()
  }
}
try {
  await launch()
  await page.getByRole('button', { name: '设置', exact: true }).first().click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '模型', exact: true }).click()
  await settings.getByRole('button', { name: '添加自定义提供方', exact: true }).click()
  await settings.getByLabel('Provider ID', { exact: true }).fill('jd-fixture')
  await settings.getByLabel('显示名称', { exact: true }).fill('JD synthetic fixture')
  await settings.getByLabel('API 地址', { exact: true }).last().fill(fixture.origin + '/v1')
  await settings.getByLabel('API 协议', { exact: true }).selectOption('openai-completions')
  await settings.getByLabel('API 密钥', { exact: true }).last().fill('synthetic-jd-only')
  await settings.getByRole('button', { name: '获取可用模型', exact: true }).last().click()
  const picker = page.getByRole('dialog', { name: '选择要添加的模型', exact: true })
  await picker.getByRole('checkbox').check()
  await picker.getByRole('button', { name: '添加所选', exact: true }).click()
  await settings.getByRole('button', { name: '创建提供方', exact: true }).click()
  await settings.getByRole('button', { name: '编辑 JD synthetic fixture (jd-fixture)', exact: true }).waitFor()
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await openResearch()
  await page.getByRole('button', { name: '＋ 新建搜索', exact: true }).click()
  await page.getByRole('heading', { name: '从学科专业推理实际岗位' }).waitFor()
  const sessions = await rpc('/api', 'session.list')
  const sessionId = sessions.items.at(-1).sessionId
  await rpc('/api', 'session.selectModel', { sessionId, provider: 'jd-fixture', model: 'jd-fixture-model' })
  await page.getByRole('textbox').nth(0).fill('计算机应用技术')
  await page.getByRole('button', { name: '推理岗位名称', exact: true }).click()
  await page.getByText('已生成 1 个岗位建议，可继续编辑。').waitFor()
  await page.getByRole('button', { name: '确认岗位并继续', exact: true }).click()
  await page.getByRole('button', { name: '开始检索', exact: true }).click()
  await page.getByRole('button', { name: '选为登录采集来源', exact: true }).waitFor()
  assert.deepEqual(fixture.toolCalls, ['web_search', 'web_fetch'])
  checks.push('real model adapter, native-search provider and HTTP fetch expose the login restriction')
  await page.getByRole('button', { name: '选为登录采集来源', exact: true }).click()
  const [capture] = await Promise.all([desktop.waitForEvent('window'), page.getByRole('button', { name: '打开登录采集窗口', exact: true }).click()])
  await capture.getByRole('button', { name: '登录合成站点', exact: true }).waitFor()
  assert.equal(await capture.evaluate(() => typeof window.corchJd), 'undefined')
  await page.getByRole('button', { name: '登录后继续采集', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '尚未取得 JD 正文' }).waitFor()
  assert.equal((await rpc('/jd', 'list')).length, 1)
  assert.equal((await rpc('/jd', 'read', { id: (await rpc('/jd', 'list'))[0].id })).sources.length, 0)
  const pendingProject = (await rpc('/jd', 'list'))[0]
  await page.reload()
  await page.getByRole('button', { name: 'JD 搜索', exact: true }).waitFor()
  await openResearch()
  await page.getByLabel('打开已保存项目', { exact: true }).selectOption(pendingProject.id)
  await page.getByRole('button', { name: '直接登录采集或导入原文', exact: true }).click()
  assert.equal(capture.isClosed(), false)
  const fileInput = page.getByLabel('读取原文文件', { exact: true })
  const fileControl = page.getByText('选择原文文件', { exact: true })
  const importedBody = page.getByRole('region', { name: '采集或导入 JD', exact: true }).getByRole('textbox', { name: /^导入\s*JD\s*原文$/u })
  await page.getByText(/支持\s*\.txt\s*\/\s*\.md.*1\s*MB/u).waitFor()
  const txt = { name: '合成岗位.txt', mimeType: 'text/plain', buffer: Buffer.from('岗位职责：开发合成文本接口。\n任职要求：掌握 SQL。') }
  const mdFile = { name: '合成岗位.md', mimeType: 'text/markdown', buffer: Buffer.from('# 合成岗位\n\n岗位职责：开发合成 Markdown 接口。\n任职要求：掌握软件测试。') }
  for (const file of [txt, mdFile]) {
    await fileInput.setInputFiles(file)
    await page.getByRole('status').filter({ hasText: '已读取：' + file.name }).waitFor()
    assert.equal(await importedBody.inputValue(), file.buffer.toString())
    assert.equal(await fileInput.inputValue(), '', 'The native picker must permit choosing the same file again')
  }
  await importedBody.fill('暂时编辑的内容')
  await fileInput.focus()
  assert.equal(await fileInput.evaluate(element => element === document.activeElement), true)
  const [keyboardChooser] = await Promise.all([page.waitForEvent('filechooser'), fileInput.press('Enter')])
  await keyboardChooser.setFiles(mdFile)
  await page.waitForFunction(([element, expected]) => element.value === expected, [await importedBody.elementHandle(), mdFile.buffer.toString()])
  await page.getByRole('status').filter({ hasText: '已读取：' + mdFile.name }).waitFor()
  assert.equal(await importedBody.inputValue(), mdFile.buffer.toString())
  assert.equal((await rpc('/jd', 'read', { id: pendingProject.id })).sources.length, 0)
  const disabledOpen = page.getByRole('button', { name: '打开登录采集窗口', exact: true })
  assert.equal(await disabledOpen.isDisabled(), true)
  const disabledStyle = await disabledOpen.evaluate(element => ({ opacity: Number(getComputedStyle(element).opacity), cursor: getComputedStyle(element).cursor }))
  assert.ok(disabledStyle.opacity < 1 && disabledStyle.cursor === 'not-allowed', 'Disabled JD action must be visibly unavailable')
  const fileMetrics = await buttonMetrics([['选择原文文件', fileControl], ['打开登录采集窗口', disabledOpen], ['登录后继续采集', page.getByRole('button', { name: '登录后继续采集', exact: true })]])
  for (const control of fileMetrics) {
    assert.ok(Math.abs(control.height - 38) <= 1, `Unexpected file/capture action height: ${control.name}`)
    for (const property of ['font', 'padding', 'radius']) assert.deepEqual(control[property], fileMetrics[0][property], `File/capture action ${property} differs: ${control.name}`)
  }
  await fileControl.scrollIntoViewIfNeeded()
  presentation.file_import = { txt_loaded: true, md_loaded: true, same_file_reselected_with_keyboard: true, filename_visible: true, manual_original_not_saved: true,
    wide: fileMetrics, disabled_action: disabledStyle, narrow: await narrowControls([['选择原文文件', fileControl], ['打开登录采集窗口', disabledOpen], ['登录后继续采集', page.getByRole('button', { name: '登录后继续采集', exact: true })]], 'file-import-narrow.png') }
  await fileControl.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(out, 'file-import.png'), fullPage: true })
  await importedBody.fill('')
  checks.push('styled native file picker loads txt/md, displays filename, supports keyboard same-file reselection and keeps imports unsaved')
  await capture.getByLabel('合成账号', { exact: true }).fill('synthetic-user')
  await capture.getByLabel('合成密码', { exact: true }).fill('synthetic-password')
  await capture.getByRole('button', { name: '登录合成站点', exact: true }).click()
  await capture.getByRole('heading', { name: '合成后端开发岗位', exact: true }).waitFor()
  const nativeCapture = await desktop.browserWindow(capture)
  assert.equal(await nativeCapture.evaluate(window => window.getTitle()), 'JD 采集 · 请在此登录，完成后回到工作台继续采集')
  const [detail] = await Promise.all([desktop.waitForEvent('window'), capture.getByRole('link', { name: '新窗口打开岗位', exact: true }).click()])
  await detail.getByRole('heading', { name: '合成后端开发岗位', exact: true }).waitFor()
  await page.getByRole('button', { name: '登录后继续采集', exact: true }).click()
  await page.getByText('JD 原文和来源已保存。', { exact: true }).waitFor()
  await page.getByText(/支持\s*\.txt\s*\/\s*\.md.*1\s*MB/u).waitFor()
  assert.equal(await page.getByRole('status').filter({ hasText: '已读取：' + mdFile.name }).count(), 0)
  presentation.file_import.filename_reset_after_save = true
  const summary = (await rpc('/jd', 'list'))[0]
  const saved = await rpc('/jd', 'read', { id: summary.id })
  assert.equal(saved.sources.length, 1)
  assert.ok(saved.sources[0].body.includes(fixtureBody))
  assert.ok(!saved.sources[0].body.includes('无正文页眉'))
  assert.ok(!saved.sources[0].body.includes('微信扫码分享') && !saved.sources[0].body.includes('推荐职位'))
  assert.equal(saved.sources[0].title, '合成后端开发岗位')
  assert.equal(saved.sources[0].acquisition, 'browser')
  assert.ok(saved.sources[0].source_url.endsWith('/job?detail=1'))
  assert.ok(!JSON.stringify(saved).includes('synthetic_jd_session'))
  checks.push('login page rejected; capture survives workbench reload; human login resumes collection; cookies never enter research data')
  await page.getByRole('button', { name: '使用 1 份原文生成五级图谱', exact: true }).click()
  await page.getByRole('heading', { name: '五级岗位能力图谱', exact: true }).waitFor({ timeout: 60000 })
  const graphProject = await rpc('/jd', 'read', { id: summary.id })
  assert.equal(graphProject.graphs.length, 1)
  const actionNames = ['补充或筛选原文', '生成新版本', '下载 AI 版 MD', '导出阅读版 PDF']
  const actions = actionNames.map(name => [name, page.getByRole('button', { name, exact: true })])
  await actions[0][1].scrollIntoViewIfNeeded()
  const actionMetrics = await buttonMetrics(actions)
  for (const control of actionMetrics) {
    assert.ok(Math.abs(control.height - 38) <= 1, `Unexpected JD action height: ${control.name}`)
    assert.ok(Math.abs(control.y - actionMetrics[0].y) <= 1, 'Wide JD actions must share a row and text alignment')
    for (const property of ['font', 'padding', 'radius']) assert.deepEqual(control[property], actionMetrics[0][property], `JD action ${property} differs: ${control.name}`)
  }
  const ordinaryGap = actionMetrics[1].x - actionMetrics[0].x - actionMetrics[0].width
  const exportGap = actionMetrics[3].x - actionMetrics[2].x - actionMetrics[2].width
  assert.ok(ordinaryGap > 0 && Math.abs(ordinaryGap - exportGap) <= 1, 'Adjacent MD/PDF actions must use the shared action gap')
  assert.ok(actionMetrics[2].x >= actionMetrics[1].x + actionMetrics[1].width + ordinaryGap - 1, 'Export actions must follow the navigation/generation group')
  presentation.graph_actions = { wide: actionMetrics, ordinary_gap: ordinaryGap, export_gap: exportGap, narrow: await narrowControls(actions, 'graph-narrow.png') }
  await actions[0][1].scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(out, 'graph-actions.png'), fullPage: true })
  const actual = { levels: graphProject.graphs[0].nodes.map(node => ({ kind: node.kind, title: node.title, basis: node.basis, quotes: node.evidence.map(entry => entry.quote) })), tools: fixture.toolCalls,
    original_saved: graphProject.sources[0].body.includes(fixtureBody), acquisition: graphProject.sources[0].acquisition, graph_version: graphProject.graphs[0].version,
    file_import: { txt_loaded: true, md_loaded: true, keyboard_same_file_reselection: true, filename_feedback: true, filename_reset_after_save: true, not_saved: true },
    graph_actions: { shared_dimensions_and_typography: true, aligned_row: true, shared_export_gap: true, narrow_controls_fit: true } }
  const expectedPath = new URL('./snapshots/jd-research.expected.json', import.meta.url)
  if (values.update) await writeFile(expectedPath, JSON.stringify(actual, null, 2) + '\n')
  else assert.deepEqual(actual, JSON.parse(await readFile(expectedPath, 'utf8')))
  await desktop.evaluate(({ session }, directory) => {
    globalThis.jdAcceptanceDownloads = []
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSavePath(directory + '/' + item.getFilename())
      item.once('done', (_event, state) => globalThis.jdAcceptanceDownloads.push({ filename: item.getFilename(), state }))
    })
  }, out)
  for (const [button, file] of [['下载 AI 版 MD', 'jd-graph.md'], ['导出阅读版 PDF', 'jd-graph.pdf']]) {
    await page.getByRole('button', { name: button, exact: true }).click()
    let downloaded
    for (let attempt = 0; attempt < 100; attempt++) {
      downloaded = await desktop.evaluate((_electron, extension) => globalThis.jdAcceptanceDownloads.find(item => item.filename.endsWith(extension)), file.endsWith('.md') ? '.md' : '.pdf')
      if (downloaded) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(downloaded?.state, 'completed', `Native download failed: ${button}`)
    await copyFile(join(out, downloaded.filename), join(out, file))
  }
  const md = await readFile(join(out, 'jd-graph.md'), 'utf8')
  assert.ok(md.includes('推断，待专家核实') && md.includes(graphProject.sources[0].content_hash) && md.includes(fixtureBody))
  assert.ok((await readFile(join(out, 'jd-graph.pdf'))).subarray(0, 4).equals(Buffer.from('%PDF')))
  await page.screenshot({ path: join(out, 'graph.png'), fullPage: true })
  checks.push('five-level graph, exact original quotes, inference labels, immutable source hashes and same-version MD/PDF exports')
  const callCount = fixture.requests.length
  await desktop.close(); desktop = undefined
  await launch(); await openResearch()
  await page.getByLabel('打开已保存项目', { exact: true }).selectOption(summary.id)
  await page.getByRole('heading', { name: '五级岗位能力图谱', exact: true }).waitFor()
  assert.deepEqual((await rpc('/jd', 'read', { id: summary.id })).graphs, graphProject.graphs)
  assert.equal(fixture.requests.length, callCount)
  await page.getByRole('button', { name: '补充或筛选原文', exact: true }).click()
  await page.getByLabel('来源 URL', { exact: true }).fill(fixture.origin + '/job')
  const [restoredCapture] = await Promise.all([desktop.waitForEvent('window'), page.getByRole('button', { name: '打开登录采集窗口', exact: true }).click()])
  await restoredCapture.getByRole('heading', { name: '合成后端开发岗位', exact: true }).waitFor()
  checks.push('actual application restart restores project, original corpus, graph versions and the isolated login session without regeneration')
  assert.deepEqual(errors, [])
  const persistedFiles = await readdir(join(data, 'dsh/jd-projects'))
  assert.ok(persistedFiles.includes(summary.id + '.json'))
  passed = true
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {})
    await writeFile(join(out, 'failure.aria.txt'), await page.locator('body').ariaSnapshot()).catch(() => {})
  }
  throw error
} finally {
  await writeFile(join(out, 'verification.json'), JSON.stringify({ passed, checks, errors, presentation, actual_desktop: true, actual_loader: true, synthetic_external_systems: true, paid_model_calls: 0 }, null, 2) + '\n')
  await desktop?.close()
  await fixture.close()
}
