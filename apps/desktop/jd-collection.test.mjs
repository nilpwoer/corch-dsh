import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJdCollection, jdChallengeURL, jdHasDuties, jdLoginWall, jdPlatform, jdSourceURL } from './jd-collection.mjs'

const settings = { min_interval_ms: 100, cache_ttl_ms: 1000, max_navigations_per_hour: 3, max_sources_per_batch: 20, render_settle_ms: 100 }
function directory(t, override = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jd-collection-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'jd-collection-settings.json'), JSON.stringify({ ...settings, ...override }))
  return root
}
const url = 'https://jobs.51job.com/chengdu/123.html'

test('platform grouping includes known sibling subdomains without guessing unknown public suffixes', () => {
  assert.equal(jdPlatform(url), '51job.com')
  assert.equal(jdPlatform('https://m.cdpdrc.com/job/1.html'), 'cdpdrc.com')
  assert.equal(jdPlatform('https://www.zhaopin.com/jobdetail/1'), 'zhaopin.com')
  assert.equal(jdPlatform('https://other.example.co.uk/1'), 'other.example.co.uk')
  assert.equal(jdPlatform('https://fake51job.com/1'), 'fake51job.com')
  assert.equal(jdSourceURL(url + '#share'), url)
  assert.throws(() => jdSourceURL('https://user:password@jobs.51job.com/1'))
  assert.throws(() => jdSourceURL('file:///private'))
  assert.equal(jdChallengeURL('https://www.zhipin.com/web/common/security-check.html'), true)
})

test('serialized reservations respect the real clock, hourly budget, and durable state', async t => {
  const dataDirectory = directory(t)
  const policy = createJdCollection({ dataDirectory })
  const times = []
  const run = () => policy.run(url, async () => { const permission = await policy.reserve(url); times.push(Date.now()); return permission })
  assert.deepEqual(await Promise.all([run(), run(), run()]), ['allowed', 'allowed', 'allowed'])
  assert.ok(times[1] - times[0] >= 90)
  assert.ok(times[2] - times[1] >= 90)
  assert.equal(await createJdCollection({ dataDirectory }).reserve(url), 'rate_limited')
})

test('queued work cannot navigate after a persistent platform block or process restart', async t => {
  const dataDirectory = directory(t)
  const policy = createJdCollection({ dataDirectory })
  assert.equal(await policy.reserve(url), 'allowed')
  const pending = policy.reserve(url)
  policy.block(url, 'HTTP 429')
  assert.equal(await pending, 'blocked')
  const restarted = createJdCollection({ dataDirectory })
  assert.equal(restarted.blocked('https://www.51job.com/other'), true)
  assert.equal(await restarted.reserve(url), 'blocked')
  assert.equal(restarted.statuses()[0].reason, 'HTTP 429')
})

test('successful originals are hashed, durable, cached without navigation, and expire', t => {
  const dataDirectory = directory(t)
  const policy = createJdCollection({ dataDirectory })
  const body = '岗位职责：开发接口。任职要求：掌握 SQL。'
  const item = { state: 'captured', url, title: '后端岗位', body, captured_at: new Date().toISOString(), content_hash: createHash('sha256').update(body).digest('hex') }
  policy.cache(url, item)
  policy.cache(url, item)
  const restarted = createJdCollection({ dataDirectory })
  assert.deepEqual(restarted.cached(url), { ...item, cached: true })
  assert.equal(restarted.statuses()[0].cache_count, 1)
  assert.equal(restarted.statuses()[0].next_navigation_at, new Date(settings.min_interval_ms).toISOString())
  assert.equal(readFileSync(join(dataDirectory, 'jd-collection/platforms.json'), 'utf8').includes(body), false)
  policy.cache(url, { ...item, captured_at: new Date(Date.now() - 2000).toISOString() })
  assert.equal(restarted.cached(url), undefined)
})

test('invalid deployment settings and compiler-independent durable corruption fail closed', t => {
  const dataDirectory = directory(t, { min_interval_ms: 0 })
  assert.throws(() => createJdCollection({ dataDirectory }), /min_interval_ms/u)
  writeFileSync(join(dataDirectory, 'jd-collection-settings.json'), JSON.stringify(settings))
  createJdCollection({ dataDirectory }).block(url, 'challenge')
  writeFileSync(join(dataDirectory, 'jd-collection/platforms.json'), JSON.stringify({ version: 1, platforms: { '51job.com': { blocked: 'false' } } }))
  assert.throws(() => createJdCollection({ dataDirectory }), /策略记录无效/u)
})

test('clock rollback cannot turn a stored future navigation into an immediate request', async t => {
  const dataDirectory = directory(t)
  createJdCollection({ dataDirectory }).login(url, false)
  const file = join(dataDirectory, 'jd-collection/platforms.json')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  stored.platforms['51job.com'].last_navigation = Date.now() + 3600000
  writeFileSync(file, JSON.stringify(stored))
  assert.equal(await createJdCollection({ dataDirectory }).reserve(url), 'rate_limited')
})

test('disposal cancels a delayed reservation and prevents queued navigation work', async t => {
  const policy = createJdCollection({ dataDirectory: directory(t, { min_interval_ms: 10000 }) })
  assert.equal(await policy.reserve(url), 'allowed')
  const waiting = policy.reserve(url)
  await new Promise(resolve => setImmediate(resolve))
  policy.dispose()
  await assert.rejects(waiting, /已关闭/u)
  await assert.rejects(policy.run(url, () => assert.fail('disposed task executed')), /已关闭/u)
})

test('unknown hostname dictionary keys cannot resolve inherited object members', async t => {
  const policy = createJdCollection({ dataDirectory: directory(t) })
  assert.equal(await policy.reserve('https://constructor/job'), 'allowed')
  policy.block('https://constructor/job', 'challenge')
  assert.equal(policy.blocked('https://constructor/job'), true)
  assert.equal(policy.statuses()[0].platform, 'constructor')
})

test('legacy cached partial JD remains on disk but returns login-required without its body', t => {
  const dataDirectory = directory(t)
  const policy = createJdCollection({ dataDirectory })
  // This truncation marker is present in the real BOSS response captured during platform acceptance.
  const body = '岗位职责：\n开发和维护基于微服务架构的.NET后端应用程序，包括但不限于服务接口、API、数据存储等方面；\n任职要求：\n大专或以上学历，计算机\n登录查看完整内容'
  const item = { state: 'captured', url, title: '.net开发工程师', body, captured_at: new Date().toISOString(), content_hash: createHash('sha256').update(body).digest('hex'), cached: false }
  const file = join(dataDirectory, 'jd-collection', createHash('sha256').update(url).digest('hex') + '.json')
  writeFileSync(file, JSON.stringify(item))
  const cached = policy.cached(url)
  assert.equal(cached.state, 'login_required')
  assert.equal(Object.hasOwn(cached, 'body'), false)
  assert.equal(policy.statuses()[0].login_required, true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), item)
  assert.throws(() => policy.cache(url, item), /部分 JD/u)
  for (const text of ['登录查看完整内容', '登录后查看完整职位', '登录后可查看完整信息', '登陆后才能查看完整岗位职责']) assert.equal(jdLoginWall(text), true)
  assert.equal(jdLoginWall('岗位职责：开发和维护用户登录系统。任职要求：熟悉 .NET。'), false)
})

test('manual resume never revives reservations or tasks queued before a security block', async t => {
  const policy = createJdCollection({ dataDirectory: directory(t) })
  await policy.reserve(url)
  const reservation = policy.reserve(url)
  let release
  const running = policy.run(url, () => new Promise(resolve => { release = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  const queued = policy.run(url, () => assert.fail('pre-block queued task revived'))
  policy.block(url, 'challenge')
  policy.resume(url)
  release('done')
  assert.equal(await running, 'done')
  assert.equal((await queued).state, 'blocked')
  assert.equal(await reservation, 'blocked')
  assert.equal(await policy.reserve(url), 'allowed')
})

function captured(body = '岗位职责：开发和维护后端接口。任职要求：掌握 SQL 与 .NET。') {
  return { state: 'captured', url, title: '后端工程师', body, captured_at: new Date().toISOString(), content_hash: createHash('sha256').update(body).digest('hex'), cached: false }
}

test('automatic deliveries survive restart and acknowledge only saved items without repeating acknowledged content', t => {
  const dataDirectory = directory(t)
  const policy = createJdCollection({ dataDirectory })
  const item = captured()
  assert.equal(policy.enqueue({ project_id: 'project-1', requested_url: url, item }), true)
  assert.equal(policy.enqueue({ project_id: 'project-1', requested_url: url, item: { ...item, captured_at: new Date(Date.now() + 1).toISOString() } }), false)
  assert.equal(policy.enqueue({ project_id: 'project-2', requested_url: url, item }), true)
  const snapshot = policy.pending()
  const firstId = snapshot.deliveries[0].id
  snapshot.deliveries[0].item.body = 'mutated read snapshot'
  const restarted = createJdCollection({ dataDirectory })
  assert.deepEqual(restarted.pending().deliveries[0].item, item)
  restarted.ack({ ids: [firstId] })
  restarted.ack({ ids: [firstId] })
  const afterAck = createJdCollection({ dataDirectory })
  assert.equal(afterAck.pending().deliveries.length, 1)
  assert.equal(afterAck.pending().deliveries[0].project_id, 'project-2')
  assert.equal(afterAck.enqueue({ project_id: 'project-1', requested_url: url, item }), false)
  assert.throws(() => afterAck.ack({ ids: ['not-an-id'] }), /确认标识无效/u)
})

test('automatic inbox refuses partial or empty-heading JD and preserves malformed durable evidence', t => {
  const dataDirectory = directory(t)
  const policy = createJdCollection({ dataDirectory })
  assert.equal(jdHasDuties('岗位职责：\n任职要求：'), false)
  assert.equal(jdHasDuties('岗位职责：加载中，请稍候'), false)
  assert.throws(() => policy.enqueue({ project_id: 'project-1', requested_url: url, item: captured('岗位职责：\n任职要求：') }), /完整正文/u)
  assert.throws(() => policy.enqueue({ project_id: 'project-1', requested_url: url, item: captured('岗位职责：开发接口。登录查看完整内容') }), /完整正文/u)
  policy.enqueue({ project_id: 'project-1', requested_url: url, item: captured() })
  const file = join(dataDirectory, 'jd-collection/inbox.json')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  stored.deliveries[0].item.body = 'tampered'
  const evidence = JSON.stringify(stored)
  writeFileSync(file, evidence)
  assert.throws(() => createJdCollection({ dataDirectory }), /投递正文或来源校验失败/u)
  assert.equal(readFileSync(file, 'utf8'), evidence)
})
