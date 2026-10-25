/** Actual desktop/Loader/model/tool flow with synthetic external systems and saved-output snapshots. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, readdir, symlink, realpath, copyFile, appendFile } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { backendEnvironment } from './policy.mjs'
import { autoFixtureBody, autoReplayBody, delayedFixtureBody, feedbackFixtureBody, fixtureBody, startJdFixture } from './jd-research-fixture.mjs'

const require = createRequire(import.meta.url)
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
let desktop, page, passed = false, failure
const checks = [], errors = []
const presentation = {}
async function saveVerification() {
  await writeFile(join(out, 'verification.json'), JSON.stringify({ passed, checks, errors, failure, presentation,
    actual_desktop: true, actual_loader: true, synthetic_external_systems: true, paid_model_calls: 0 }, null, 2) + '\n')
}
async function launch() {
  desktop = await electron.launch({ executablePath: resolve(values.exe), args: [...(values.source ? [resolve('apps/desktop/main.mjs')] : []), '--data-dir', data, '--lang=zh-CN'],
    env: backendEnvironment(process.env, join(data, 'unused')), timeout: 45000 })
  desktop.process().stderr?.on('data', (chunk) => {
    void appendFile(join(out, 'electron-stderr.log'), chunk).catch(error => console.error('Could not save Electron diagnostics:', error.message))
  })
  page = await desktop.firstWindow({ timeout: 60000 })
  await desktop.evaluate(({ shell }) => {
    globalThis.jdAcceptanceOpened = []
    shell.openExternal = async url => { globalThis.jdAcceptanceOpened.push(url) }
  })
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
async function native(method, payload) {
  return page.evaluate(async ({ method, payload }) => {
    const result = await window.corchJd[method](payload)
    if (!result.ok) throw new Error(result.message)
    return result.value
  }, { method, payload })
}
async function stoppedPlatform(platform) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const states = await native('platforms')
    const stopped = states.find(state => state.platform === platform && state.blocked)
    if (stopped) return stopped
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('Rendered security challenge did not persist a platform stop: ' + platform)
}
async function pendingDeliveries(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await native('pending')
    if (predicate(result.deliveries)) return result.deliveries
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('Native delivery inbox did not reach: ' + description)
}
async function openResearch() {
  await page.getByRole('button', { name: 'JD 搜索', exact: true }).click()
  const open = page.getByRole('button', { name: '打开侧边栏', exact: true })
  if (await open.count()) await open.click()
}
async function disclosure(label, opened = true) {
  const summary = page.locator('summary').filter({ hasText: label })
  await summary.waitFor()
  const current = await summary.evaluate(element => element.parentElement.open)
  if (current !== opened) await summary.click()
}
async function singleJdView() {
  await page.getByRole('region', { name: 'JD 研究工作台', exact: true }).waitFor()
  await page.evaluate(async () => {
    const start = performance.now()
    while (performance.now() - start < 650) await new Promise(resolve => requestAnimationFrame(resolve))
  })
  assert.equal(await page.locator('section[aria-label="JD 研究工作台"]').count(), 1)
  assert.equal(await page.locator('nav[aria-label="研究步骤"]').count(), 1)
  assert.equal(await page.getByRole('button', { name: '关闭详情', exact: true }).count(), 0, 'JD navigation must not leave an empty Details column')
  assert.equal(await page.locator('p:visible').filter({ hasText: /^\{"pending":/u }).count(), 0)
}
async function compactDefaults() {
  for (const text of await page.locator('[data-jd-project-id]').allTextContents()) assert.ok(!/修订\s*\d/u.test(text), 'History must keep technical revisions out of its default labels')
  for (const label of [/^搜索记录详情$/u, /^手动导入原文$/u, /^采集帮助$/u, /^平台状态（/u, /^待处理来源（/u]) {
    const summary = page.locator('summary').filter({ hasText: label })
    if (await summary.count()) assert.equal(await summary.evaluate(element => element.parentElement.open), false, `Default disclosure must be closed: ${label}`)
  }
  assert.equal(await page.getByLabel('读取原文文件', { exact: true }).isVisible(), false)
  assert.equal(await page.getByRole('button', { name: '查看失效页面', exact: true }).isVisible(), false)
  assert.equal(await page.getByRole('region', { name: '平台采集状态', exact: true }).isVisible(), false)
}
async function compactFirstScreen(sourceTitle, count) {
  const window = await desktop.browserWindow(page)
  const originalBounds = await window.evaluate(window => window.getBounds())
  const measurements = []
  try {
    for (const width of [1360, 1024]) {
      await window.evaluate((window, width) => { window.setContentSize(width, 900); window.focus() }, width)
      await page.waitForFunction(width => innerWidth === width, width)
      const result = await page.getByRole('main').filter({ has: page.getByRole('navigation', { name: '研究步骤', exact: true }) }).evaluate(async (main, { sourceTitle, count }) => {
        for (let element = main; element; element = element.parentElement) element.scrollTop = 0
        for (let frame = 0; frame < 12; frame++) await new Promise(resolve => requestAnimationFrame(resolve))
        const describe = element => {
          const rect = element.getBoundingClientRect()
          let visible = rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const bounds = parent.getBoundingClientRect(), style = getComputedStyle(parent)
            if (/(?:auto|scroll|hidden|clip)/u.test(style.overflowX + style.overflowY)) visible &&= rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1
          }
          return { visible, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        }
        const generate = [...main.querySelectorAll('button')].find(element => element.textContent.trim() === `使用 ${count} 份原文生成五级图谱`)
        const source = [...main.querySelectorAll('h3')].find(element => element.textContent.includes(sourceTitle))
        return { width: innerWidth, height: innerHeight, client_width: main.clientWidth, scroll_width: main.scrollWidth,
          generate: generate && describe(generate), source: source && describe(source) }
      }, { sourceTitle, count })
      assert.ok(result.scroll_width <= result.client_width + 1, 'Compact workbench must not overflow horizontally')
      assert.equal(result.generate?.visible, true, 'Next-step action must be visible on the first screen')
      assert.equal(result.source?.visible, true, 'A saved original must be visible on the first screen')
      await page.screenshot({ path: join(out, `compact-first-screen-${width}.png`), fullPage: false })
      measurements.push(result)
    }
  } finally { await window.evaluate((window, bounds) => window.setBounds(bounds), originalBounds) }
  presentation.compact_first_screen = measurements
}
async function savedProject(id, predicate, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const project = await rpc('/jd', 'read', { id })
    if (predicate(project)) return project
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('Persisted project did not reach: ' + description)
}
async function selectProject(id) {
  await page.locator(`[data-jd-project-id="${id}"]`).click()
  await selectedProject(id)
}
async function selectedProject(id) {
  await page.waitForFunction(projectId => document.querySelector(`[data-jd-project-id="${projectId}"]`)?.getAttribute('aria-current') === 'page'
    && document.querySelector('main nav[aria-label="研究步骤"]'), id)
}
async function archivedProjects(count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const projects = await rpc('/jd', 'list')
    if (projects.length >= count) return projects
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`New search did not create ${count} archived projects`)
}
async function exportHtml(version, project) {
  const previous = await desktop.evaluate(() => globalThis.jdAcceptanceOpened.length)
  await page.getByRole('button', { name: '导出 HTML', exact: true }).click()
  let url
  for (let attempt = 0; attempt < 100; attempt++) {
    url = await desktop.evaluate((_electron, count) => globalThis.jdAcceptanceOpened[count], previous)
    if (url) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(url, 'HTML export must request the system browser')
  const path = fileURLToPath(url)
  assert.ok(path.startsWith(join(data, 'exports') + sep), 'Report must be saved under this client data directory')
  assert.ok(path.endsWith('.html'))
  const html = await readFile(path, 'utf8')
  const source = project.sources[0]
  assert.ok(html.includes(source.content_hash) && html.includes(source.source_url), 'HTML must include original hash and URL')
  assert.ok(html.includes('来源1 · ' + source.title) && html.includes(fixtureBody), 'HTML must retain readable source names and exact originals')
  assert.ok(!html.includes(source.id) && !html.includes(project.id) && !html.includes(project.session_id), 'Reports must omit internal source, project and session identifiers')
  assert.ok(html.includes('推断') && html.includes('待专家核实'), 'HTML must identify inference')
  assert.match(html, /Content-Security-Policy/u)
  await copyFile(path, join(out, `jd-graph-v${version}.html`))
  return { path, url, html, sha256: createHash('sha256').update(html).digest('hex') }
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
    const dimensions = await page.getByRole('main').filter({ has: page.getByRole('navigation', { name: '研究步骤', exact: true }) }).evaluate(async main => {
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
  const firstRoster = await archivedProjects(1)
  assert.equal(firstRoster.length, 1, 'A new search must be archived before any inference or search')
  const first = firstRoster[0]
  await selectedProject(first.id)
  await page.getByRole('heading', { name: '从学科专业推理实际岗位' }).waitFor()
  await rpc('/api', 'session.selectModel', { sessionId: first.session_id, provider: 'jd-fixture', model: 'jd-fixture-model' })
  await page.getByRole('textbox', { name: '学科 / 专业', exact: true }).fill('计算机应用技术')
  await page.getByRole('textbox', { name: '专业方向（可选）', exact: true }).fill('后端服务与数据库')
  await page.getByRole('textbox', { name: '岗位名称（可手动修改，使用顿号分隔）', exact: true }).fill('后端开发、数据库开发')
  await savedProject(first.id, project => project.major === '计算机应用技术' && project.direction === '后端服务与数据库', 'first target draft')
  await page.getByRole('button', { name: '＋ 新建搜索', exact: true }).click()
  const second = (await archivedProjects(2)).find(project => project.id !== first.id)
  assert.ok(second)
  await selectedProject(second.id)
  await page.getByRole('heading', { name: '从学科专业推理实际岗位' }).waitFor()
  assert.notEqual(second.session_id, first.session_id)
  const sessions = await rpc('/api', 'session.list')
  assert.ok(sessions.items.some(item => item.sessionId === first.session_id))
  assert.ok(sessions.items.some(item => item.sessionId === second.session_id))
  await page.getByRole('textbox', { name: '学科 / 专业', exact: true }).fill('智慧养老护理')
  await page.getByRole('textbox', { name: '专业方向（可选）', exact: true }).fill('社区照护')
  await page.getByRole('textbox', { name: '岗位名称（可手动修改，使用顿号分隔）', exact: true }).fill('养老护理员')
  await selectProject(first.id)
  await page.getByRole('heading', { name: '从学科专业推理实际岗位' }).waitFor()
  await page.getByRole('textbox', { name: '专业方向（可选）', exact: true }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: '学科 / 专业', exact: true }).inputValue(), '计算机应用技术')
  assert.equal(await page.getByRole('textbox', { name: '专业方向（可选）', exact: true }).inputValue(), '后端服务与数据库')
  assert.equal(await page.getByRole('textbox', { name: '岗位名称（可手动修改，使用顿号分隔）', exact: true }).inputValue(), '后端开发、数据库开发')
  await page.getByRole('button', { name: '推理岗位名称', exact: true }).click()
  await page.getByText('已生成 1 个岗位建议，可继续编辑。').waitFor()
  await page.getByRole('button', { name: '确认岗位并继续', exact: true }).click()
  await page.getByRole('combobox', { name: '区域范围', exact: true }).selectOption('成渝经济圈')
  await page.getByRole('combobox', { name: '发布时间', exact: true }).selectOption('最近 90 天')
  await page.getByRole('combobox', { name: '目标条数', exact: true }).selectOption('5 条（测试）')
  await page.getByRole('button', { name: /鱼泡直聘/u }).click()
  await selectProject(second.id)
  assert.equal(await page.getByRole('textbox', { name: '学科 / 专业', exact: true }).inputValue(), '智慧养老护理')
  await selectProject(first.id)
  await page.getByRole('heading', { name: '选择平台与搜索范围' }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: '区域范围', exact: true }).inputValue(), '成渝经济圈')
  assert.equal(await page.getByRole('button', { name: /鱼泡直聘/u }).getAttribute('aria-pressed'), 'true')
  const captureOpened = desktop.waitForEvent('window')
  await page.getByRole('button', { name: '开始检索', exact: true }).click()
  const capture = await captureOpened
  await capture.getByRole('button', { name: '登录合成站点', exact: true }).waitFor()
  const rawModelJson = page.locator('p:visible').filter({ hasText: /^\{"pending":/u })
  assert.equal(await rawModelJson.count(), 0, 'Raw model JSON must be hidden in the default JD workbench')
  await page.getByRole('button', { name: 'JD 搜索', exact: true }).click()
  await page.getByRole('button', { name: 'JD 搜索', exact: true }).click()
  await singleJdView()
  await page.getByRole('button', { name: '查看运行记录', exact: true }).click()
  await page.getByRole('button', { name: '返回JD工作台', exact: true }).waitFor()
  await rawModelJson.first().waitFor()
  await page.getByRole('button', { name: '返回JD工作台', exact: true }).click()
  await page.getByRole('navigation', { name: '研究步骤', exact: true }).waitFor()
  assert.equal(await rawModelJson.count(), 0)
  await singleJdView()
  await disclosure(/^待处理来源（/u)
  const pendingOpen = page.getByRole('button', { name: '打开登录', exact: true })
  await pendingOpen.waitFor()
  assert.deepEqual(fixture.toolCalls, ['web_search'])
  assert.equal(fixture.deniedCalls[0], 'web_fetch')
  assert.ok(['bash', 'pwsh'].includes(fixture.deniedCalls[1]))
  const offeredTools = fixture.requests.flatMap(request => request.tools ?? []).map(tool => tool.function?.name)
  assert.ok(offeredTools.includes(fixture.deniedCalls[1]), 'Shell denial must exercise an actually registered shell, not an unknown name')
  const deniedResults = fixture.requests.at(-1).messages.filter(message => message.role === 'tool').slice(-2)
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
  assert.equal(deniedResults.length, 2)
  assert.ok(deniedResults.every(content => content.includes('JD 研究仅允许搜索候选链接')), 'Fetch and shell must both reach the Host executor denial')
  assert.ok(fixture.siteRequests.length > 0 && fixture.siteRequests.every(request => /Chrome\//u.test(request.user_agent)), 'Job pages must only be requested by the rendered browser, never anonymous web_fetch')
  assert.equal((await rpc('/jd', 'list')).length, 2)
  checks.push('new searches immediately archive distinct Host sessions; target drafts, selected platforms and range survive A/B switching')
  const continueCapture = page.getByRole('button', { name: '继续浏览器采集', exact: true })
  await continueCapture.waitFor()
  assert.equal(await page.getByRole('button', { name: '选为登录采集来源', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '直接登录采集或导入原文', exact: true }).count(), 0)
  await pendingOpen.click()
  await capture.getByRole('button', { name: '登录合成站点', exact: true }).waitFor()
  assert.equal(await capture.evaluate(() => typeof window.corchJd), 'undefined')
  await continueCapture.click()
  await page.getByRole('alert').filter({ hasText: '尚未取得 JD 正文' }).waitFor()
  assert.equal((await rpc('/jd', 'read', { id: first.id })).sources.length, 0)
  await disclosure(/^手动导入原文$/u)
  const fileInput = page.getByLabel('读取原文文件', { exact: true })
  const fileControl = page.getByText('选择原文文件', { exact: true })
  const importedBody = page.getByRole('region', { name: '采集或导入 JD', exact: true }).getByRole('textbox', { name: /^导入\s*JD\s*原文$/u })
  const txt = { name: '合成岗位.txt', mimeType: 'text/plain', buffer: Buffer.from('岗位职责：开发合成文本接口。\n任职要求：掌握 SQL。') }
  const mdFile = { name: '合成岗位.md', mimeType: 'text/markdown', buffer: Buffer.from('# 合成岗位\n\n岗位职责：开发合成 Markdown 接口。\n任职要求：掌握软件测试。') }
  for (const file of [txt, mdFile]) {
    await fileInput.setInputFiles(file)
    await page.getByRole('status').filter({ hasText: '已读取：' + file.name }).waitFor()
    assert.equal(await importedBody.inputValue(), file.buffer.toString())
    assert.equal(await fileInput.inputValue(), '', 'Native picker must allow the same file again')
  }
  await importedBody.fill('暂时编辑的内容')
  const [keyboardChooser] = await Promise.all([page.waitForEvent('filechooser'), fileInput.press('Enter')])
  await keyboardChooser.setFiles(mdFile)
  await page.waitForFunction(([element, expected]) => element.value === expected, [await importedBody.elementHandle(), mdFile.buffer.toString()])
  await page.getByRole('textbox', { name: '企业（可填未披露）', exact: true }).fill('合成企业草稿')
  await selectProject(second.id)
  await selectProject(first.id)
  await page.getByRole('heading', { name: 'JD 原文与来源' }).waitFor()
  await disclosure(/^手动导入原文$/u)
  assert.equal(await importedBody.inputValue(), mdFile.buffer.toString())
  assert.equal(await page.getByRole('textbox', { name: '企业（可填未披露）', exact: true }).inputValue(), '合成企业草稿')
  assert.equal(await page.getByRole('textbox', { name: '来源 URL', exact: true }).inputValue(), fixture.origin + '/job')
  const draft = await savedProject(first.id, project => project.workspace?.capture.body === mdFile.buffer.toString(), 'capture draft')
  assert.equal(draft.workspace.step, 3)
  assert.equal(draft.workspace.capture.file_name, mdFile.name)
  assert.equal(draft.sources.length, 0)
  await page.reload()
  await page.getByRole('button', { name: 'JD 搜索', exact: true }).waitFor()
  await openResearch()
  await selectProject(first.id)
  await page.getByRole('heading', { name: 'JD 原文与来源' }).waitFor()
  await disclosure(/^手动导入原文$/u)
  assert.equal(await importedBody.inputValue(), mdFile.buffer.toString())
  await continueCapture.waitFor()
  assert.equal(capture.isClosed(), false)
  const reopen = page.getByRole('button', { name: '打开岗位浏览器', exact: true })
  const fileMetrics = await buttonMetrics([['选择原文文件', fileControl], ['打开岗位浏览器', reopen], ['继续浏览器采集', continueCapture]])
  for (const control of fileMetrics) {
    assert.ok(Math.abs(control.height - 38) <= 1, `Unexpected file/capture action height: ${control.name}`)
    for (const property of ['font', 'padding', 'radius']) assert.deepEqual(control[property], fileMetrics[0][property])
  }
  presentation.file_import = { txt_loaded: true, md_loaded: true, same_file_reselected_with_keyboard: true, filename_visible: true,
    draft_restored_on_switch_and_reload: true, manual_original_not_saved: true, wide: fileMetrics,
    narrow: await narrowControls([['选择原文文件', fileControl], ['打开岗位浏览器', reopen], ['继续浏览器采集', continueCapture]], 'file-import-narrow.png') }
  await page.screenshot({ path: join(out, 'file-import.png'), fullPage: true })
  try { await capture.goto(fixture.origin + '/risk-page') }
  catch (error) {
    if (!/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/u.test(error.message)) throw error
  }
  await stoppedPlatform('127.0.0.1')
  const challenge = await native('read', { id: first.id })
  assert.equal(challenge.state, 'blocked')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await disclosure(/^平台状态（/u)
  await page.getByText('127.0.0.1 · 风控暂停', { exact: true }).waitFor()
  await disclosure(/^待处理来源（/u)
  const stoppedCount = fixture.siteRequests.length
  const stopped = await native('collect', { id: second.id, sources: [{ url: fixture.origin + '/job', title: '合成岗位' }] })
  assert.equal(stopped.items[0].state, 'blocked')
  assert.equal(fixture.siteRequests.length, stoppedCount, 'A stopped platform cannot navigate from another project')
  const prematureResume = await native('resume', { id: first.id, url: fixture.origin + '/job' })
  assert.equal(prematureResume.item.state, 'failed')
  assert.ok((await native('platforms')).some(platform => platform.blocked))
  assert.equal((await rpc('/jd', 'read', { id: first.id })).sources.length, 0)
  await page.getByRole('button', { name: '手动处理验证', exact: true }).click()
  await capture.getByRole('button', { name: '登录合成站点', exact: true }).waitFor()
  await capture.getByLabel('合成账号', { exact: true }).fill('synthetic-user')
  await capture.getByLabel('合成密码', { exact: true }).fill('synthetic-password')
  await capture.getByRole('button', { name: '登录合成站点', exact: true }).click()
  await capture.getByRole('heading', { name: '合成后端开发岗位', exact: true }).waitFor()
  const [detail] = await Promise.all([desktop.waitForEvent('window'), capture.getByRole('link', { name: '新窗口打开岗位', exact: true }).click()])
  await detail.getByRole('heading', { name: '合成后端开发岗位', exact: true }).waitFor()
  await capture.close()
  const renderSettleMs = JSON.parse(await readFile(join(data, 'jd-collection-settings.json'), 'utf8')).render_settle_ms
  await new Promise(resolve => setTimeout(resolve, renderSettleMs * 2))
  assert.equal((await rpc('/jd', 'read', { id: first.id })).sources.length, 0, 'A readable JD in verification mode must still require explicit resume')
  assert.ok((await native('platforms')).some(platform => platform.blocked), 'A readable verification page must not silently clear the platform stop')
  assert.ok((await native('pending')).deliveries.every(delivery => delivery.project_id !== first.id), 'Verification pages cannot enqueue automatic source delivery')
  await page.getByRole('button', { name: '已完成验证，恢复采集', exact: true }).click()
  await page.locator('[data-jd-save-complete]').getByText('正文已保存 · 本次搜索已保存 1 份浏览器 JD', { exact: true }).waitFor()
  const saved = await rpc('/jd', 'read', { id: first.id })
  assert.equal(saved.sources.length, 1)
  assert.ok(saved.sources[0].body.includes(fixtureBody))
  assert.ok(!saved.sources[0].body.includes('无正文页眉'))
  assert.ok(!saved.sources[0].body.includes('微信扫码分享') && !saved.sources[0].body.includes('推荐职位'))
  assert.equal(saved.sources[0].title, '合成后端开发岗位')
  assert.equal(saved.sources[0].acquisition, 'browser')
  assert.ok(saved.sources[0].source_url.endsWith('/job?detail=1'))
  assert.equal(saved.sources[0].content_hash, createHash('sha256').update(saved.sources[0].body).digest('hex'))
  assert.ok(!JSON.stringify(saved).includes('synthetic_jd_session'))
  assert.ok((await native('platforms')).every(platform => !platform.blocked), 'Only a verified rendered JD clears the circuit')
  const cacheCount = fixture.siteRequests.length
  const cached = await native('collect', { id: second.id, sources: [{ url: saved.sources[0].source_url, title: saved.sources[0].title }] })
  assert.equal(cached.items[0].cached, true)
  assert.equal(cached.items[0].captured_at, saved.sources[0].captured_at)
  assert.equal(cached.items[0].content_hash, saved.sources[0].content_hash)
  assert.equal(fixture.siteRequests.length, cacheCount, 'Another project must reuse a cached original without navigation')
  if (!detail.isClosed()) await detail.waitForEvent('close')
  assert.equal((await native('status', { id: first.id })).state, 'closed', 'Acknowledged verification recovery closes its capture window')
  await page.reload()
  await page.getByRole('button', { name: 'JD 搜索', exact: true }).waitFor()
  await openResearch(); await selectProject(first.id)
  await page.getByRole('heading', { name: 'JD 原文与来源' }).waitFor()
  assert.equal(await continueCapture.isVisible(), false, 'Closed capture cannot remain actionable after reload')
  checks.push('search-only executor rejects fetch and shell; browser-first login and challenge pages remain unverified; a platform circuit blocks other projects until explicit verification reads a real JD; cache hits do not navigate')
  await page.getByRole('button', { name: '使用 1 份原文生成五级图谱', exact: true }).click()
  await page.getByRole('heading', { name: '五级岗位能力图谱', exact: true }).waitFor({ timeout: 60000 })
  const graphProject = await rpc('/jd', 'read', { id: first.id })
  assert.equal(graphProject.graphs.length, 1)
  const graphText = await page.locator('section[aria-label="JD 研究工作台"] main').innerText()
  assert.ok(!/父节点|SHA-256|JD-[A-Za-z0-9-]+|STEP 0/u.test(graphText), 'Graph UI must describe capabilities without internal identifiers')
  assert.ok(graphText.includes('所属项目：'))
  assert.equal(await page.locator('article[data-basis]').evaluateAll(cards => cards.some((card) => {
    const heading = card.querySelector('h3')?.firstChild?.textContent.trim()
    return [...card.querySelectorAll(':scope > p')].some(paragraph => paragraph.textContent.trim() === heading)
  })), false, 'Identical capability titles and descriptions appear once')
  assert.ok(!graphText.includes(graphProject.graphs[0].generated_at), 'Graph versions use a readable local date')
  assert.equal(await page.getByRole('navigation', { name: '研究步骤', exact: true }).getByRole('button').count(), 4)
  for (const name of ['下载 AI 版 MD', '导出阅读版 PDF', '导出 HTML']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0)
  await assert.rejects(rpc('/jd', 'export', { id: first.id, version: 1 }), /确认/u)
  const confirm = page.getByRole('button', { name: '确认能力图谱', exact: true })
  await confirm.click()
  await page.getByRole('button', { name: '导出 HTML', exact: true }).waitFor()
  const confirmed = await savedProject(first.id, project => project.confirmations?.some(item => item.version === 1), 'graph confirmation')
  const roster = await rpc('/jd', 'confirmed')
  assert.ok(roster.some(item => item.project_id === first.id && item.version === 1), 'Confirmed graph must be available to curriculum construction')
  const actions = ['补充或筛选原文', '生成新版本', '导出 HTML'].map(name => [name, page.getByRole('button', { name, exact: true })])
  const actionMetrics = await buttonMetrics(actions)
  for (const control of actionMetrics) {
    assert.ok(Math.abs(control.height - 38) <= 1)
    for (const property of ['font', 'padding', 'radius']) assert.deepEqual(control[property], actionMetrics[0][property])
  }
  presentation.graph_actions = { wide: actionMetrics, narrow: await narrowControls(actions, 'graph-narrow.png') }
  const firstHtml = await exportHtml(1, confirmed)
  const [reportPage] = await Promise.all([desktop.waitForEvent('window'), desktop.evaluate(async ({ BrowserWindow }, url) => {
    globalThis.jdAcceptanceReport = new BrowserWindow({ show: true, width: 1440, height: 1000, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, javascript: false } })
    await globalThis.jdAcceptanceReport.loadURL(url)
  }, firstHtml.url)])
  await reportPage.getByText('交付后端服务', { exact: false }).first().waitFor()
  await reportPage.locator('#nodes a[href="#source-1-original"]').first().click()
  const original = reportPage.locator('#source-1-original')
  await original.waitFor({ state: 'visible' })
  assert.equal(await original.textContent(), confirmed.sources[0].body, 'A numbered citation reveals the exact offline original without scripts')
  assert.equal(await reportPage.locator('#source-1').getAttribute('data-original-sha256'), confirmed.sources[0].content_hash)
  assert.equal(await reportPage.locator('#source-1 a').getAttribute('href'), confirmed.sources[0].source_url)
  assert.equal(await reportPage.locator('a[href^="#"]').evaluateAll(links => links.every(link => document.getElementById(link.getAttribute('href').slice(1)))), true, 'Every report navigation link must resolve')
  await reportPage.screenshot({ path: join(out, 'html-report.png'), fullPage: true })
  await desktop.evaluate(() => globalThis.jdAcceptanceReport.destroy())
  await page.getByRole('button', { name: '生成新版本', exact: true }).click()
  await page.getByRole('combobox', { name: '图谱版本', exact: true }).selectOption('2')
  const secondGraph = await savedProject(first.id, project => project.graphs.length === 2, 'second graph version')
  assert.deepEqual(secondGraph.graphs[0], graphProject.graphs[0], 'New graph versions cannot rewrite previous evidence')
  assert.equal(await page.getByRole('button', { name: '导出 HTML', exact: true }).count(), 0)
  await assert.rejects(rpc('/jd', 'export', { id: first.id, version: 2 }), /确认/u)
  await confirm.click()
  await page.getByRole('button', { name: '导出 HTML', exact: true }).waitFor()
  const allConfirmed = await savedProject(first.id, project => project.confirmations?.length === 2, 'second graph confirmation')
  const secondHtml = await exportHtml(2, allConfirmed)
  assert.notEqual(firstHtml.path, secondHtml.path)
  await page.getByRole('combobox', { name: '图谱版本', exact: true }).selectOption('1')
  await page.getByRole('button', { name: '2 平台与范围', exact: true }).click()
  await selectProject(second.id)
  await selectProject(first.id)
  await page.getByRole('heading', { name: '选择平台与搜索范围' }).waitFor()
  const beforeRestart = await savedProject(first.id, project => project.workspace.step === 2 && project.workspace.graph_version === 1, 'step and selected graph version')
  checks.push('confirmation is host-persisted and discoverable for curriculum use; HTML export requires per-version confirmation and retains sources, exact quotes and inference labels')
  const callCount = fixture.requests.length
  await desktop.close(); desktop = undefined
  await launch(); await openResearch(); await selectProject(first.id)
  await page.getByRole('heading', { name: '选择平台与搜索范围' }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: '区域范围', exact: true }).inputValue(), '成渝经济圈')
  assert.equal(fixture.requests.length, callCount)
  await page.getByRole('button', { name: '以此范围新建搜索', exact: true }).click()
  const repeated = (await archivedProjects(3)).find(project => ![first.id, second.id].includes(project.id))
  assert.ok(repeated, 'Repeating a search must create another archive')
  await selectedProject(repeated.id)
  assert.ok(![first.session_id, second.session_id].includes(repeated.session_id))
  await page.getByRole('heading', { name: '选择平台与搜索范围' }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: '区域范围', exact: true }).inputValue(), '成渝经济圈')
  await rpc('/api', 'session.selectModel', { sessionId: repeated.session_id, provider: 'jd-fixture', model: 'jd-fixture-model' })
  const restartSiteCount = fixture.siteRequests.length
  await page.getByRole('button', { name: '开始检索', exact: true }).click()
  const repeatedProject = await savedProject(repeated.id, project => project.sources.length === 1 && project.pending_sources.length === 0, 'browser cache reused after restart')
  assert.equal(repeatedProject.sources[0].content_hash, saved.sources[0].content_hash)
  assert.equal(repeatedProject.sources[0].captured_at, saved.sources[0].captured_at)
  assert.equal(fixture.siteRequests.length, restartSiteCount, 'Restarted client must use persisted cache without logging in or navigating')
  assert.deepEqual(fixture.toolCalls, ['web_search', 'web_search'])
  assert.deepEqual((await rpc('/jd', 'read', { id: first.id })).graphs, beforeRestart.graphs)
  await selectProject(first.id)
  await page.getByRole('button', { name: '4 能力图谱', exact: true }).click()
  await page.getByRole('heading', { name: '五级岗位能力图谱', exact: true }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: '图谱版本', exact: true }).inputValue(), '1')
  assert.deepEqual((await rpc('/jd', 'read', { id: first.id })).graphs, beforeRestart.graphs)
  await page.getByRole('button', { name: '导出 HTML', exact: true }).waitFor()
  await selectProject(second.id)
  await page.getByRole('heading', { name: '从学科专业推理实际岗位' }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: '学科 / 专业', exact: true }).inputValue(), '智慧养老护理')
  checks.push('actual restart restores independent project drafts, selected step/version, immutable graph versions and confirmations without model regeneration')

  const secondBeforeAutomatic = await rpc('/jd', 'read', { id: second.id })
  await page.getByRole('button', { name: '＋ 新建搜索', exact: true }).click()
  const automatic = (await archivedProjects(4)).find(project => ![first.id, second.id, repeated.id].includes(project.id))
  assert.ok(automatic)
  await selectedProject(automatic.id)
  await page.getByRole('textbox', { name: '学科 / 专业', exact: true }).fill('自动登录验收')
  await page.getByRole('textbox', { name: '岗位名称（可手动修改，使用顿号分隔）', exact: true }).fill('照护设备维护员')
  await rpc('/api', 'session.selectModel', { sessionId: automatic.session_id, provider: 'jd-fixture', model: 'jd-fixture-model' })
  await page.getByRole('button', { name: '确认岗位并继续', exact: true }).click()
  const automaticWindow = desktop.waitForEvent('window')
  await page.getByRole('button', { name: '开始检索', exact: true }).click()
  const autoCapture = await automaticWindow
  await autoCapture.getByRole('button', { name: '登录自动采集合成站点', exact: true }).waitFor()
  await disclosure(/^待处理来源（/u)
  await page.getByRole('button', { name: '打开登录', exact: true }).waitFor()
  await disclosure(/^手动导入原文$/u)
  const autoDraftText = '岗位职责：这是用户尚未导入的独立草稿，不应被自动采集清除。'
  await page.getByRole('region', { name: '采集或导入 JD', exact: true }).getByRole('textbox', { name: /^导入\s*JD\s*原文$/u }).fill(autoDraftText)
  await page.getByRole('textbox', { name: '企业（可填未披露）', exact: true }).fill('自动采集前的用户草稿企业')
  const autoDraft = await savedProject(automatic.id, project => project.workspace.capture.body === autoDraftText, 'independent automatic-capture draft')
  assert.equal(autoDraft.sources.length, 0, 'A partial login-walled job cannot be automatically stored')
  await selectProject(second.id)
  await page.getByRole('button', { name: '原生会话', exact: true }).click()
  assert.equal(await page.locator('nav[aria-label="研究步骤"]').count(), 0, 'The originating workbench must be unmounted before automatic login capture completes')
  await autoCapture.getByLabel('自动采集合成账号', { exact: true }).fill('synthetic-auto-user')
  await autoCapture.getByLabel('自动采集合成密码', { exact: true }).fill('synthetic-auto-password')
  const automaticClosed = autoCapture.waitForEvent('close')
  await autoCapture.getByRole('button', { name: '登录自动采集合成站点', exact: true }).click()
  const autoSaved = await savedProject(automatic.id, project => project.sources.some(source => source.body.includes(autoFixtureBody)), 'automatic save after login while another project is selected and Details is closed')
  assert.equal(autoSaved.sources.length, 1)
  assert.equal(autoSaved.sources[0].acquisition, 'browser')
  assert.equal(autoSaved.sources[0].content_hash, createHash('sha256').update(autoSaved.sources[0].body).digest('hex'))
  assert.equal(autoSaved.workspace.capture.body, autoDraftText)
  assert.equal(autoSaved.workspace.capture.company, '自动采集前的用户草稿企业')
  assert.deepEqual((await rpc('/jd', 'read', { id: second.id })).sources, secondBeforeAutomatic.sources)
  assert.deepEqual((await rpc('/jd', 'read', { id: second.id })).workspace, secondBeforeAutomatic.workspace)
  await pendingDeliveries(deliveries => deliveries.every(delivery => delivery.project_id !== automatic.id), 'saved delivery acknowledged')
  await automaticClosed
  assert.equal((await native('status', { id: automatic.id })).state, 'closed')

  const replayUrl = fixture.origin + '/auto-job?replay=1'
  let committedBeforeReload
  const interruptSaveResponse = async (route) => {
    const requestedProject = route.request().postDataJSON()?.payload?.project
    if (requestedProject?.id !== automatic.id || !requestedProject.sources.some(source => source.body.includes(autoReplayBody))) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    committedBeforeReload = await response.json()
    // The real Host commit succeeds; renderer reload aborts its unanswered fetch before acknowledgement.
  }
  await page.route('**/jd/save', interruptSaveResponse)
  await native('open', { id: automatic.id, url: replayUrl })
  for (let attempt = 0; attempt < 100 && !committedBeforeReload; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(committedBeforeReload?.result?.ok, 'Automatic delivery must reach a real Host commit before the simulated interrupted response')
  const committedProject = await rpc('/jd', 'read', { id: automatic.id })
  assert.equal(committedProject.sources.filter(source => source.body.includes(autoReplayBody)).length, 1)
  const unacknowledged = await pendingDeliveries(deliveries => deliveries.some(delivery => delivery.project_id === automatic.id && delivery.item.body.includes(autoReplayBody)), 'committed delivery remains unacknowledged before renderer reload')
  assert.equal((await native('status', { id: automatic.id })).state, 'opened', 'An unanswered save must not close the capture window')
  const replayDeliveryIds = unacknowledged.filter(delivery => delivery.project_id === automatic.id).map(delivery => delivery.id)
  await page.unroute('**/jd/save', interruptSaveResponse)
  await page.reload()
  await page.getByRole('button', { name: 'JD 搜索', exact: true }).waitFor()
  await pendingDeliveries(deliveries => deliveries.every(delivery => !replayDeliveryIds.includes(delivery.id)), 'reloaded global receiver replays and acknowledges the saved delivery')
  const replayed = await rpc('/jd', 'read', { id: automatic.id })
  assert.equal(replayed.sources.length, 2)
  assert.equal(replayed.sources.filter(source => source.body.includes(autoReplayBody)).length, 1)
  assert.equal(replayed.workspace.capture.body, autoDraftText)
  assert.equal(replayed.workspace.capture.company, '自动采集前的用户草稿企业')
  assert.deepEqual((await rpc('/jd', 'read', { id: second.id })).workspace, secondBeforeAutomatic.workspace)
  assert.equal((await native('status', { id: automatic.id })).state, 'closed', 'Replay acknowledgement closes the recovered capture window')
  checks.push('login alone automatically archives complete originals in the originating project outside its view; partial walls and security verification do not auto-save; drafts survive and an interrupted commit response replays exactly once after reload')

  await openResearch()
  const openDetails = page.getByRole('button', { name: '打开详情', exact: true })
  if (await openDetails.count()) await openDetails.click()
  await page.getByRole('button', { name: '＋ 新建搜索', exact: true }).click()
  const feedback = (await archivedProjects(5)).find(project => ![first.id, second.id, repeated.id, automatic.id].includes(project.id))
  assert.ok(feedback)
  await selectedProject(feedback.id)
  await page.getByRole('textbox', { name: '学科 / 专业', exact: true }).fill('岗位采集反馈验收')
  await page.getByRole('textbox', { name: '岗位名称（可手动修改，使用顿号分隔）', exact: true }).fill('数据接口维护员')
  await rpc('/api', 'session.selectModel', { sessionId: feedback.session_id, provider: 'jd-fixture', model: 'jd-fixture-model' })
  await page.getByRole('button', { name: '确认岗位并继续', exact: true }).click()
  await page.getByRole('button', { name: '开始检索', exact: true }).click()
  for (let attempt = 0; attempt < 300 && fixture.pendingSlowJobs() === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(fixture.pendingSlowJobs(), 1, 'The batch must still be waiting on its unfinished second HTTP page')
  const earlySaved = await savedProject(feedback.id, project => project.sources.some(source => source.body.includes(feedbackFixtureBody)), 'the first complete source is durable before its batch completes')
  assert.equal(earlySaved.sources.length, 1)
  assert.ok(!earlySaved.sources[0].body.includes('合成账号导航') && !earlySaved.sources[0].body.includes('其他岗位推荐'))
  const savedFeedback = page.locator('[data-jd-save-complete]')
  await savedFeedback.getByText('正文已保存 · 本次搜索已保存 1 份浏览器 JD', { exact: true }).waitFor()
  await savedFeedback.getByText('其他来源仍在采集；已保存的岗位无需等待本批完成。', { exact: true }).waitFor()
  await disclosure(/^平台状态（/u)
  await page.getByRole('region', { name: '平台采集状态', exact: true }).getByText('127.0.0.1 · 正文已读取 · 已保存 1 份', { exact: true }).waitFor()
  assert.equal(fixture.pendingSlowJobs(), 1, 'Success feedback must appear before the slow page has been released')
  await page.screenshot({ path: join(out, 'saved-during-long-batch.png'), fullPage: true })
  fixture.releaseSlowJob()
  await disclosure(/^待处理来源（/u)
  const unavailableCard = page.locator('article').filter({ has: page.getByRole('button', { name: '查看失效页面', exact: true }) })
  await unavailableCard.getByRole('button', { name: '查看失效页面', exact: true }).waitFor()
  await unavailableCard.getByText(/岗位页面已失效，登录不能恢复该岗位/u).waitFor()
  assert.equal(await unavailableCard.getByRole('button', { name: '打开登录', exact: true }).count(), 0)
  const feedbackSaved = await savedProject(feedback.id, project => project.sources.length === 2 && project.pending_sources.some(source => source.url.endsWith('/unavailable-job')), 'valid batch pages saved and expired page retained without recommendation capture')
  assert.ok(feedbackSaved.sources.some(source => source.body.includes(delayedFixtureBody)))
  assert.ok(feedbackSaved.sources.every(source => !source.source_url.endsWith('/unavailable-job') && !source.body.includes('推荐照护岗位')))
  assert.equal(feedbackSaved.pending_sources.length, 1)
  assert.match(feedbackSaved.pending_sources[0].reason, /失效|不存在/u)
  await page.waitForFunction(() => document.querySelector('[data-jd-save-complete]')?.textContent.includes('已保存 2 份浏览器 JD'))
  const unavailableVisits = fixture.siteRequests.filter(request => request.path === '/unavailable-job').length
  assert.equal(unavailableVisits, 1)
  const collectRemaining = page.getByRole('button', { name: '继续采集待处理岗位', exact: true })
  assert.equal(await collectRemaining.isDisabled(), true, 'Expired-only candidates must not offer automatic retry')
  await page.reload()
  await page.getByRole('button', { name: 'JD 搜索', exact: true }).waitFor()
  await openResearch()
  await selectProject(feedback.id)
  await compactDefaults()
  assert.equal(await page.locator('p:visible').filter({ hasText: /^\{"pending":/u }).count(), 0)
  await page.getByRole('button', { name: '查看运行记录', exact: true }).waitFor()
  await compactFirstScreen('合成长批次首条岗位', 2)
  const firstSavedCard = page.getByRole('region', { name: '已保存原文', exact: true }).locator('article').first()
  const evidenceSummary = firstSavedCard.locator('summary').filter({ hasText: /^查看完整原文$/u })
  assert.equal(await evidenceSummary.evaluate(element => element.parentElement.open), false)
  assert.ok(!/SHA-256：|JD-[A-Za-z0-9-]+/u.test(await firstSavedCard.textContent()))
  await evidenceSummary.click()
  assert.ok(!/SHA-256：|JD-[A-Za-z0-9-]+/u.test(await firstSavedCard.textContent()))
  assert.ok((await firstSavedCard.locator('pre').textContent()).includes(feedbackFixtureBody))
  await evidenceSummary.click()
  await disclosure(/^平台状态（/u)
  const platformDetails = page.getByRole('region', { name: '平台采集状态', exact: true }).locator('summary').filter({ hasText: /^平台详情$/u }).first()
  assert.equal(await platformDetails.evaluate(element => element.parentElement.open), false)
  await platformDetails.click()
  await page.getByRole('region', { name: '平台采集状态', exact: true }).getByText(/条缓存/u).waitFor()
  await disclosure(/^平台状态（/u, false)
  await disclosure(/^采集帮助$/u)
  await page.getByText('登录页、搜索摘要和失效页面不计入样本。平台风控会暂停自动访问，需在待处理来源中手动验证并明确确认恢复。', { exact: true }).waitFor()
  await disclosure(/^采集帮助$/u, false)
  await disclosure(/^待处理来源（/u)
  await unavailableCard.getByRole('button', { name: '查看失效页面', exact: true }).waitFor()
  assert.equal(await collectRemaining.isDisabled(), true)
  assert.equal(fixture.siteRequests.filter(request => request.path === '/unavailable-job').length, unavailableVisits)
  assert.equal((await rpc('/jd', 'read', { id: feedback.id })).sources.length, 2)
  checks.push('a complete source commits and shows clear saved feedback while the remaining batch HTTP response is unfinished; expired pages with recommended duties stay excluded and do not invite login or automatic retries after reload')
  checks.push('the JD workbench hides model JSON by default and restores after restart; optional records and disclosures remain usable; saved originals and generation stay visible without horizontal overflow at 1360 and 1024 content pixels')
  const actual = {
    levels: graphProject.graphs[0].nodes.map(node => ({ kind: node.kind, title: node.title, basis: node.basis, quotes: node.evidence.map(entry => entry.quote) })),
    tools: fixture.toolCalls, original_saved: saved.sources[0].body.includes(fixtureBody), acquisition: saved.sources[0].acquisition,
    search_sessions: { archived_before_search: true, independent_sessions: true, repeat_search_creates_archive: true, target_restored: true, filters_restored: true, capture_draft_restored: true, step_and_version_restored_after_restart: true },
    capture: { browser_first: true, continue_requires_window: true, login_rejected: true, security_challenge_rejected: true, popup_survives_parent_close: true },
    collection_policy: { fetch_and_shell_denied_by_executor: true, browser_requests_only: true, cross_project_platform_stop: true,
      explicit_verified_resume: true, cache_without_navigation: true, persisted_cache_after_restart: true, original_capture_time_preserved: true },
    automatic_capture: { login_without_continue_or_read: true, partial_login_original_rejected: true, verification_requires_explicit_resume: true,
      windows_close_after_host_ack: true, interrupted_save_keeps_window: true,
      origin_project_saved_while_other_selected: true, workbench_hidden: true, other_project_unchanged: true, user_draft_preserved: true,
      committed_delivery_unacknowledged_before_reload: true, reload_replay_idempotent: true, acknowledgement_after_save: true },
    batch_feedback: { source_saved_before_batch_end: true, visible_saved_count_before_batch_end: true, busy_state_explains_remaining_sources: true,
      scoped_zhaopin_duties_only: true, expired_recommendations_rejected: true, expired_link_not_a_login_request: true,
      no_automatic_expired_retry_after_reload: true },
    compact_workbench: { saved_source_and_generation_first_screen: true, content_widths_checked: [1360, 1024], no_horizontal_overflow: true,
      human_readable_hierarchy_and_dates: true, internal_ids_and_hashes_not_rendered: true,
      optional_disclosures_closed_by_default: true, disclosures_preserve_capture_and_import: true, raw_json_hidden_by_default: true,
      model_records_available_on_demand: true, return_to_workbench: true, repeated_jd_navigation_single_instance: true,
      no_empty_details_column: true, workbench_restored_after_restart: true },
    confirmation: { host_persisted: true, discoverable_for_curriculum: true, export_denied_before_confirmation: true, each_version_requires_confirmation: true, confirmed_versions: allConfirmed.confirmations.map(item => item.version) },
    html_export: { saved_in_client_data: true, system_browser_requested: true, exact_source_quotes: true, hashes_and_urls: true, inference_marked: true, source_text_immutable: true,
      readable_numbered_sources: true, offline_original_navigation_without_scripts: true, internal_ids_not_rendered: true },
    file_import: { txt_loaded: true, md_loaded: true, keyboard_same_file_reselection: true, filename_feedback: true, unsaved_draft_restored: true },
    graph_actions: { shared_dimensions_and_typography: true, four_distinct_steps: true, no_md_pdf_buttons: true, narrow_controls_fit: true },
  }
  const expectedPath = new URL('./snapshots/jd-research.expected.json', import.meta.url)
  if (values.update) await writeFile(expectedPath, JSON.stringify(actual, null, 2) + '\n')
  else assert.deepEqual(actual, JSON.parse(await readFile(expectedPath, 'utf8')))
  await writeFile(join(out, 'html-exports.json'), JSON.stringify([{ version: 1, path: firstHtml.path, sha256: firstHtml.sha256 }, { version: 2, path: secondHtml.path, sha256: secondHtml.sha256 }], null, 2) + '\n')
  assert.deepEqual(errors, [])
  const persistedFiles = await readdir(join(data, 'dsh/jd-projects'))
  assert.ok([first.id, second.id, repeated.id, automatic.id, feedback.id].every(id => persistedFiles.includes(id + '.json')))
  passed = true
} catch (error) {
  failure = { message: error.message, stack: error.stack }
  console.error(error.stack ?? error.message)
  await writeFile(join(out, 'failure.json'), JSON.stringify({ failure, site_requests: fixture.siteRequests,
    tools: fixture.toolCalls, denied_tools: fixture.deniedCalls }, null, 2) + '\n')
  await saveVerification()
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(out, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {})
    await page.locator('body').ariaSnapshot({ timeout: 5000 }).then(snapshot => writeFile(join(out, 'failure.aria.txt'), snapshot)).catch(() => {})
    await page.content().then(html => writeFile(join(out, 'failure.html'), html)).catch(() => {})
  }
  throw error
} finally {
  await saveVerification()
  await desktop?.close()
  await fixture.close()
}
