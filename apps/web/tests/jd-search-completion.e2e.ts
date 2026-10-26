/** Real Loader, session and browser flow with a gated external model fixture. */
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type SessionStore from '@deepseek-ai/dsh-session'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

const PLUGIN = '@polus-ai/dsh-client-ui-teaching-reform'
const STORAGE_KEY = 'polus-teaching-reform.jd-search-projects.v1'
const ARTIFACTS = fileURLToPath(new URL('../../../.artifacts/jd-running-reminder/', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./snapshots/jd-search-completion/step.expected.json', import.meta.url))
const MAJOR = '合成养老服务'
const ROLE = '合成养老护理员'
const SAVED_BODY = '本地已校阅的合成岗位正文，恢复历史时应保留。'
const JOBS = [{
  id: 'JD-001', title: ROLE, company: '合成服务机构', place: '成都', platform: '公开网页', score: 93,
  summary: '核对照护服务记录。', body: '合成照护岗位正文：每日核对生活照料记录并交接服务情况。',
  sourceUrl: 'https://example.invalid/jd/fixture-1',
}]
const REPLY = JSON.stringify({ jobs: JOBS })
const SLOW_NOTICE = 'Agent 仍在运行，已等待超过 5 分钟。将继续等待结果，也可以取消工作流。'

function waitForGate(gate: Promise<unknown>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => { reject(new Error('JD fixture request cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void gate.then(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    })
  })
}

class GatedJdAdapter extends LlmAdapter {
  requests = 0
  readonly requestSignals: AbortSignal[] = []
  readonly textGate = Promise.withResolvers<undefined>()
  readonly finishGate = Promise.withResolvers<undefined>()

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'fixture', name: 'JD Fixture' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: 'JD Fixture', contextWindow: 128_000 })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    const inputs = options.messages.filter(message => message.role === 'user')
      .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    const signal = options.signal
    if (signal === undefined) throw new Error('JD fixture requires the real turn cancellation signal')
    this.requestSignals.push(signal)
    if (this.requests === 1) {
      if (!inputs.some(input => input.includes('执行一次岗位 JD 搜索。搜索条件：'))) throw new Error('Expected a JD search request')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await waitForGate(this.textGate.promise, signal)
      yield { type: 'text-delta', index: 0, text: REPLY }
      await waitForGate(this.finishGate.promise, signal)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (this.requests !== 2 || !inputs.some(input => input.includes('原样写入对应相对路径'))) {
      throw new Error('Unexpected JD fixture model request')
    }
    const refusal = 'fixture 不执行工作区写入。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: refusal }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: refusal } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

type StoredProject = {
  sessionId: string
  request: { major: string }
  jobs: { body: string }[]
  jobsPath: string
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: JD search completes and restores from its durable conversation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let adapter: GatedJdAdapter
  let moduleHooks: { deregister: () => void } | undefined
  const pageErrors: string[] = []
  const dialogs: string[] = []

  const workbench = (): Locator => page.locator('[class*="workbench"]').filter({
    has: page.getByRole('heading', { name: 'JD 搜索', exact: true }),
  })
  const currentStep = async (): Promise<number> => Number(await workbench().locator('[aria-current="step"] span').innerText())
  const readProjects = async (): Promise<StoredProject[]> => await page.evaluate((key) => {
    return JSON.parse(window.localStorage.getItem(key) ?? '[]') as StoredProject[]
  }, STORAGE_KEY)
  const slowNotice = (): Locator => workbench().getByRole('status').filter({ hasText: SLOW_NOTICE })
  const hostSessions = (): SessionStore => scaffold.ctx.get('sessions') as SessionStore
  const captureFailure = (): void => {
    onTestFailed(async () => {
      if (page) await page.screenshot({ path: join(ARTIFACTS, 'failure.png'), fullPage: true })
      await writeFile(join(ARTIFACTS, 'failure.json'), JSON.stringify({ dialogs, pageErrors,
        sessions: hostSessions().list().map(session => ({
          id: session.id, titles: session.events.filter(event => event.type === 'session/title').map(event => event.data),
        })),
      }, null, 2) + '\n')
    })
  }
  const startSearch = async (): Promise<void> => {
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: 'JD 搜索', exact: true }).click()
    await workbench().getByRole('heading', { name: '从学科专业推理实际岗位', exact: true }).waitFor()
    await workbench().locator('input').nth(0).fill(MAJOR)
    await workbench().locator('input').nth(1).fill(ROLE)
    expect(await workbench().locator('input').nth(0).inputValue()).toBe(MAJOR)
    await workbench().getByRole('button', { name: '确认岗位并继续', exact: true }).click()
    await page.clock.install()
    await workbench().getByRole('button', { name: '开始检索', exact: true }).click()
    await expect.poll(() => adapter.requests, { timeout: 15_000 }).toBe(1)
  }

  beforeEach(async () => {
    pageErrors.length = 0
    dialogs.length = 0
    harnessHome = await realpath(await mkdtemp(join(tmpdir(), 'dsh-jd-completion-')))
    const modules = join(harnessHome, 'profiles/scaffold/node_modules')
    const sidebarEntry = createRequire(join(REPO_ROOT, 'apps/desktop/package.json')).resolve('dsh-better-sidebar')
    const sidebar = await realpath(dirname(dirname(sidebarEntry)))
    for (const [name, directory] of [[PLUGIN, join(REPO_ROOT, 'packages/client/ui-polus-teaching-reform')], ['dsh-better-sidebar', sidebar]]) {
      const link = join(modules, name!)
      await mkdir(dirname(link), { recursive: true })
      await symlink(directory!, link, 'junction')
    }
    const overlay = join(harnessHome, 'jd-completion.patch.yml')
    await writeFile(overlay, `- id: agent-default-model\n  config:\n    provider: jd-fixture\n    model: fixture\n- insert:\n    - id: polus-ai-teaching-reform\n      name: '${PLUGIN}'\n    - id: better-sidebar\n      name: dsh-better-sidebar\n`)
    if (process.platform === 'win32') {
      // Use the shipped Windows resolver for imports anchored in the isolated profile.
      const desktop = await import(pathToFileURL(join(REPO_ROOT, 'apps/desktop/module-resolution.mjs')).href) as {
        registerDesktopModules: (entry: string, home: string) => { deregister: () => void }
      }
      moduleHooks = desktop.registerDesktopModules(join(REPO_ROOT, 'apps/cli/lib/bin.js'), harnessHome)
    }
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: overlay })
    adapter = new GatedJdAdapter()
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['jd-fixture'], adapter), 'JD completion external model fixture')
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({ viewport: { width: 1720, height: 1080 }, locale: ZH_BROWSER_LOCALE })
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss() })
    await mkdir(ARTIFACTS, { recursive: true })
    await page.goto(scaffold.baseUrl)
    await page.getByRole('button', { name: 'JD 搜索', exact: true }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterEach(async () => {
    adapter?.textGate.resolve(undefined)
    adapter?.finishGate.resolve(undefined)
    await browser?.close()
    await scaffold?.close()
    moduleHooks?.deregister()
    moduleHooks = undefined
    if (harnessHome !== undefined) {
      const owned = relative(resolve(tmpdir()), resolve(harnessHome))
      expect(owned.startsWith('dsh-jd-completion-') && !owned.includes('..') && !owned.includes(':')).toBe(true)
      await rm(harnessHome, { recursive: true, force: true })
    }
  })

  it('waits through a slow streamed reply, shows results despite a write failure, and restores without a model call', async () => {
    captureFailure()
    await startSearch()
    expect(await slowNotice().count()).toBe(0)
    await page.clock.fastForward(299000)
    const noticeBeforeFiveMinutes = await slowNotice().count() > 0
    expect(noticeBeforeFiveMinutes).toBe(false)
    await page.clock.fastForward(2000)
    await slowNotice().waitFor()
    expect(await slowNotice().innerText()).toBe(SLOW_NOTICE)
    const noticeAfterFiveMinutes = await slowNotice().isVisible()
    expect(await currentStep()).toBe(2)
    expect(await workbench().getByRole('button', { name: '正在检索…', exact: true }).isVisible()).toBe(true)
    expect(await workbench().innerText()).not.toContain('5 分钟内未返回')
    const waitingStep = await currentStep()

    adapter.textGate.resolve(undefined)
    await expect.poll(() => page.locator('body').innerText(), { timeout: 15_000 }).toContain(JOBS[0]!.body)
    expect(await currentStep()).toBe(2)
    const streamedStep = await currentStep()
    adapter.finishGate.resolve(undefined)
    await workbench().getByRole('heading', { name: '筛选和确认岗位 JD', exact: true }).waitFor()
    await workbench().getByText(/岗位 JD 已进入项目列表，但本地文件保存失败/).waitFor()
    await expect.poll(() => adapter.requests, { timeout: 15_000 }).toBe(2)
    const projects = await readProjects()
    expect(projects).toHaveLength(1)
    const project = projects[0]!
    expect(project.request.major).toBe(MAJOR)
    expect(project.jobs).toEqual(JOBS)
    const sidebarVisible = await page.getByText(`${MAJOR} · 1 条 JD`, { exact: true }).isVisible()
    expect(sidebarVisible).toBe(true)
    const fileExists = existsSync(join(scaffold.workspaceCwd, 'workspace', project.jobsPath))
    expect(fileExists).toBe(false)
    const completedStep = await currentStep()
    const noticeAfterCompletion = await slowNotice().count() > 0
    expect(noticeAfterCompletion).toBe(false)
    expect(await workbench().getByRole('button', { name: '取消工作流', exact: true }).count()).toBe(0)
    const jobCards = await workbench().locator('article').count()
    const writeFailureVisible = await workbench().getByText(/本地文件保存失败/).isVisible()
    await page.screenshot({ path: join(ARTIFACTS, 'completed.png'), fullPage: true })

    const callsBeforeRecovery = adapter.requests
    await page.evaluate((key) => { window.localStorage.removeItem(key) }, STORAGE_KEY)
    await page.reload()
    await page.getByRole('button', { name: 'JD 搜索', exact: true }).click()
    await page.getByText(`${MAJOR} · 1 条 JD`, { exact: true }).waitFor()
    await page.getByText(`${MAJOR} · 1 条 JD`, { exact: true }).click()
    await workbench().getByRole('heading', { name: '筛选和确认岗位 JD', exact: true }).waitFor()
    await workbench().getByText('已从会话恢复搜索结果；岗位 JD 文件尚未重新写入工作区。', { exact: true }).waitFor()
    expect((await readProjects())[0]?.jobs).toEqual(JOBS)
    expect(adapter.requests).toBe(callsBeforeRecovery)
    const restoredStep = await currentStep()
    await page.screenshot({ path: join(ARTIFACTS, 'restored.png'), fullPage: true })

    // Distinguish an existing saved record from the earlier model response without replacing the session log.
    await page.evaluate(({ key, body }) => {
      const rows = JSON.parse(window.localStorage.getItem(key) ?? '[]') as StoredProject[]
      const first = rows[0]?.jobs[0]
      if (first === undefined) throw new Error('No saved JD project to edit')
      first.body = body
      window.localStorage.setItem(key, JSON.stringify(rows))
    }, { key: STORAGE_KEY, body: SAVED_BODY })
    await page.reload()
    await page.getByRole('button', { name: 'JD 搜索', exact: true }).click()
    await page.getByText(`${MAJOR} · 1 条 JD`, { exact: true }).click()
    await workbench().getByText(SAVED_BODY, { exact: true }).waitFor()
    expect((await readProjects())[0]?.jobs[0]?.body).toBe(SAVED_BODY)
    expect(adapter.requests).toBe(callsBeforeRecovery)
    expect(pageErrors).toEqual([])

    const observed = {
      provider: 'controlled model fixture', real_model_calls: 0,
      slow_notice_before_five_minutes: noticeBeforeFiveMinutes,
      slow_notice_after_301_seconds: noticeAfterFiveMinutes,
      slow_notice_after_completion: noticeAfterCompletion,
      waiting_after_301_seconds_step: waitingStep, complete_json_before_finish_step: streamedStep,
      completed_step: completedStep, job_cards: jobCards, sidebar_project_visible: sidebarVisible,
      project_persisted: projects.length === 1, workspace_write_failure_visible: writeFailureVisible,
      workspace_file_exists: fileExists, restored_step: restoredStep,
      restoration_extra_model_calls: adapter.requests - callsBeforeRecovery,
      existing_project_preserved: (await readProjects())[0]?.jobs[0]?.body === SAVED_BODY,
    }
    const expected = JSON.parse(await readFile(EXPECTED, 'utf8')) as { completion: unknown }
    expect(observed).toEqual(expected.completion)
  }, 120_000)

  it('cancels the workflow and its host turn without accepting a streamed JSON prefix', async () => {
    captureFailure()
    await startSearch()
    await page.clock.fastForward(301000)
    await slowNotice().waitFor()
    expect(await slowNotice().innerText()).toBe(SLOW_NOTICE)
    adapter.textGate.resolve(undefined)
    await expect.poll(() => page.locator('body').innerText(), { timeout: 15_000 }).toContain(JOBS[0]!.body)
    expect(await currentStep()).toBe(2)
    await workbench().getByRole('button', { name: '取消工作流', exact: true }).click()
    await expect.poll(() => adapter.requestSignals[0]?.aborted, { timeout: 15_000 }).toBe(true)
    const hostTurnAborted = (): boolean => hostSessions().list().some(session =>
      session.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'))
    const hostIdle = (): boolean => hostSessions().list().every(session => scaffold.ctx.agents.get(session.id)?.status === 'idle')
    await expect.poll(hostTurnAborted, { timeout: 15_000 }).toBe(true)
    await expect.poll(hostIdle, { timeout: 15_000 }).toBe(true)
    await page.getByText('已停止', { exact: true }).waitFor()
    await workbench().getByRole('button', { name: '开始检索', exact: true }).waitFor()
    expect(await workbench().getByRole('button', { name: '开始检索', exact: true }).isEnabled()).toBe(true)
    expect(await currentStep()).toBe(2)
    expect(await slowNotice().count()).toBe(0)
    expect(await workbench().getByRole('button', { name: '取消工作流', exact: true }).count()).toBe(0)
    expect(await readProjects()).toEqual([])
    expect(await workbench().getByRole('heading', { name: '筛选和确认岗位 JD', exact: true }).count()).toBe(0)
    adapter.finishGate.resolve(undefined)
    expect(adapter.requests).toBe(1)
    expect(await readProjects()).toEqual([])
    expect(pageErrors).toEqual([])
    await page.screenshot({ path: join(ARTIFACTS, 'cancelled.png'), fullPage: true })
    const observed = {
      provider: 'controlled model fixture', real_model_calls: 0,
      host_turn_aborted: hostTurnAborted(), host_agent_idle: hostIdle(), cancelled_step: await currentStep(),
      assistant_stopped_visible: await page.getByText('已停止', { exact: true }).isVisible(),
      local_wait_finished: await workbench().getByRole('button', { name: '开始检索', exact: true }).isEnabled(),
      slow_notice_after_cancel: await slowNotice().count() > 0,
      cancel_button_after_cancel: await workbench().getByRole('button', { name: '取消工作流', exact: true }).count() > 0,
      project_count: (await readProjects()).length, later_stage_model_calls: adapter.requests - 1,
    }
    const expected = JSON.parse(await readFile(EXPECTED, 'utf8')) as { cancellation: unknown }
    expect(observed).toEqual(expected.cancellation)
  }, 120_000)
})
