/** Actual Loader and interview plugin publication; no component stubs or model responses. */
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const PLUGIN = '@polus-ai/dsh-client-ui-teaching-reform'
const RECORD_KEY = 'dsh.practice-expert-interviews.v2'
const ARTIFACTS = fileURLToPath(new URL('../../../.artifacts/worker-publication/', import.meta.url))
const SIDEBAR_PACKAGE = process.env.DSH_WORKER_SIDEBAR_PACKAGE

describe.skipIf(SIDEBAR_PACKAGE === undefined)('web e2e: Worker publication through the real interview Loader', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let modelRequests = 0
  const pageErrors: string[] = []
  const pluginResponses: number[] = []
  const hostSessions = (): SessionStore => scaffold.ctx.get('sessions') as SessionStore

  beforeAll(async () => {
    harnessHome = await mkdtemp(join(tmpdir(), 'dsh-worker-publication-loader-'))
    const link = join(harnessHome, 'profiles/scaffold/node_modules', PLUGIN)
    await mkdir(dirname(link), { recursive: true })
    await symlink(join(REPO_ROOT, 'packages/client/ui-polus-teaching-reform'), link, 'junction')
    const sidebar = await realpath(SIDEBAR_PACKAGE!)
    const manifest = JSON.parse(await readFile(join(sidebar, 'package.json'), 'utf8')) as { name: string; version: string }
    expect(manifest.name).toBe('dsh-better-sidebar')
    expect(manifest.version).toBe('0.17.1')
    await symlink(sidebar, join(harnessHome, 'profiles/scaffold/node_modules/dsh-better-sidebar'), 'junction')
    const overlay = join(harnessHome, 'publication.patch.yml')
    await writeFile(overlay, `- insert:\n    - id: polus-ai-teaching-reform\n      name: '${PLUGIN}'\n    - id: better-sidebar\n      name: dsh-better-sidebar\n`)
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: overlay })
    scaffold.ctx.on('session/event', (_session, event) => {
      if (event.type === 'request/header') modelRequests++
    })
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1720, height: 1080 } })
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === `/plugins/${PLUGIN}/client.js`) pluginResponses.push(response.status())
    })
    await mkdir(ARTIFACTS, { recursive: true })
    await page.goto(scaffold.baseUrl)
    await page.getByRole('button', { name: '专家访谈', exact: true }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    if (page) await page.screenshot({ path: join(ARTIFACTS, 'loader-last-state.png'), fullPage: true }).catch(() => undefined)
    await browser?.close()
    await scaffold?.close()
    if (harnessHome) {
      const owned = relative(resolve(tmpdir()), resolve(harnessHome))
      expect(owned.startsWith('dsh-worker-publication-loader-') && !owned.includes('..') && !owned.includes(':')).toBe(true)
      await rm(harnessHome, { recursive: true, force: true })
    }
  })

  it('loads the built plugin and opens its real host-backed interview workbench', async () => {
    try {
      expect(new URL(scaffold.baseUrl).port).not.toBe('3082')
      await page.getByRole('button', { name: '专家访谈', exact: true }).click()
      await page.getByRole('button', { name: '＋ 新建专家访谈', exact: true }).click()
      await page.getByRole('heading', { name: '新建实践专家访谈', exact: true }).waitFor({ timeout: 30_000 })
      await expect.poll(() => hostSessions().list().length).toBe(1)
      const sessionId = hostSessions().list()[0]!.id
      const record = {
        record: { id: sessionId, fieldnoteId: 'FN-loader-publish', title: '合成 Loader 发布访谈', expert: '合成专家', industry: '合成课程', status: '已确认问题包', updated: '合成' },
        profile: { name: '合成专家', role: '合成教师', industry: '合成课程', years: '10', stage: '合成', experience: '合成课堂核对' },
        questions: [
          { id: 'q_task', title: '课堂核对', type: '开放回答', question: '请描述课堂核对过程。', sourceRefs: [] },
          { id: 'Q02', title: '判断依据', type: '开放回答', question: '如何判断核对结果？', sourceRefs: [] },
          { id: 'Q03', title: '任务边界', type: '开放回答', question: '如何界定任务边界？', sourceRefs: [] },
        ],
        questionPackMeta: { packId: 'synthetic-loader-pack', version: 1, generatedAt: '2026-10-14T00:00:00Z', sourceSessionId: sessionId, checksum: 'synthetic', globalReferences: [] },
        invitation: { code: '000000', createdAt: '2026-10-14T00:00:00Z', status: 'active' },
        publication: { goal: '核实合成课堂中的任务证据', scope: 'per_question', count: '2' },
      }
      await page.evaluate(({ key, row }) => {
        localStorage.setItem(key, JSON.stringify([row]))
        window.dispatchEvent(new Event('storage'))
      }, { key: RECORD_KEY, row: record })
      await page.getByRole('button', { name: '原生会话', exact: true }).click()
      await page.getByRole('button', { name: '专家访谈', exact: true }).click()
      await page.getByRole('button').filter({ hasText: '合成 Loader 发布访谈' }).click()
      await page.getByRole('button', { name: '问题包', exact: true }).click()
      await page.getByRole('button', { name: '发布并打开 SPA', exact: true }).waitFor()
      await page.screenshot({ path: join(ARTIFACTS, 'loader-question-pack.png'), fullPage: true })
      expect(pluginResponses).toContain(200)
      expect(modelRequests).toBe(0)
      expect(pageErrors).toEqual([])
      await writeFile(join(ARTIFACTS, 'loader-verification.json'), JSON.stringify({ actual_loader: true, actual_host_session: true, built_plugin_http_200: true, actual_publish_button: true, model_requests: modelRequests, page_errors: pageErrors, isolated_port: new URL(scaffold.baseUrl).port !== '3082' }, null, 2) + '\n')
    } catch (error) {
      await saveFailureShot(page, 'worker-publication-loader')
      await writeFile(join(ARTIFACTS, 'failure-body.txt'), await page.locator('body').innerText())
      throw error
    }
  }, 90_000)

  it('browser-only clients give a settings shortcut without asking for Worker login', async () => {
    await page.getByRole('button',{ name:'访谈设置',exact:true }).click()
    await page.getByRole('button',{ name:'Worker 发布',exact:true }).click()
    await page.getByPlaceholder('https://worker.example.com').fill('https://worker.example.com')
    await page.getByRole('button',{ name:'保存地址',exact:true }).click()
    await page.getByRole('button',{ name:'返回访谈',exact:true }).click()
    await page.getByRole('button',{ name:'问题包',exact:true }).click()
    const popups:Page[]=[];page.on('popup',p=>popups.push(p))
    await page.getByRole('button',{ name:'发布并打开 SPA',exact:true }).click()
    await page.getByRole('alert').filter({ hasText:'Windows 桌面客户端' }).waitFor()
    expect(await page.getByRole('button',{ name:'配置发布授权',exact:true }).count()).toBe(1)
    expect(popups).toEqual([])
    expect(modelRequests).toBe(0)
  })
})
