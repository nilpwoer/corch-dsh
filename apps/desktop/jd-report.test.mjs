import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJdReport } from './jd-report.mjs'

const input = { filename: '智慧养老-能力图谱.html', html: '<!doctype html><html><head><title>岗位能力图谱</title></head><body>已确认版本</body></html>' }

test('native HTML export preserves separate saved revisions and opens only the written local file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corch-jd-report-'))
  try {
    const opened = []
    const exporter = createJdReport({ exportsDirectory: directory, shell: { openExternal: async url => { opened.push(url) }, showItemInFolder() { assert.fail('unexpected folder fallback') } } })
    const first = await exporter(input)
    const second = await exporter(input)
    assert.equal(first.opened, 'browser')
    assert.notEqual(first.path, second.path)
    assert.deepEqual(opened, [pathToFileURL(first.path).href, pathToFileURL(second.path).href])
    const saved = await readFile(first.path, 'utf8')
    assert.ok(saved.includes('<body>已确认版本</body>'))
    assert.match(saved, /<head><meta http-equiv="Content-Security-Policy"/u)
    assert.match(saved, /default-src 'none'/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a rejected browser launch reveals the saved report in its folder without losing the export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corch-jd-report-'))
  try {
    const shown = []
    const exporter = createJdReport({ exportsDirectory: directory, shell: { openExternal: async () => { throw new Error('no association') }, showItemInFolder: path => shown.push(path) } })
    const result = await exporter({ ...input, html: '<h1>独立报告</h1>' })
    assert.equal(result.opened, 'folder')
    assert.deepEqual(shown, [result.path])
    assert.match(await readFile(result.path, 'utf8'), /独立报告/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('native HTML export rejects arbitrary paths, Windows device names, empty content and oversized reports before writing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corch-jd-report-'))
  try {
    const exporter = createJdReport({ exportsDirectory: directory, shell: { openExternal() { assert.fail('invalid export launched') } } })
    for (const filename of ['../report.html', 'C:\\report.html', 'a/b.html', '.html', 'report.txt', 'CON.html', 'lpt1.html', 'a\u0000.html']) {
      await assert.rejects(exporter({ ...input, filename }), /文件名无效/u)
    }
    for (const html of ['', ' ', 'a'.repeat(24 * 1024 * 1024 + 1)]) await assert.rejects(exporter({ ...input, html }), /内容为空或超过/u)
    assert.deepEqual(await readdir(directory), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('storage failures do not launch the browser and opening failures retain the written path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corch-jd-report-'))
  try {
    const file = join(directory, 'not-a-directory')
    await writeFile(file, 'existing')
    const exporter = createJdReport({ exportsDirectory: file, shell: { openExternal() { assert.fail('failed write launched') } } })
    await assert.rejects(exporter(input), /保存失败/u)
    const opener = createJdReport({ exportsDirectory: directory, shell: { openExternal: async () => { throw new Error('browser failed') }, showItemInFolder() { throw new Error('folder failed') } } })
    await assert.rejects(opener(input), error => {
      assert.match(error.message, /已保存/u)
      assert.ok(error.message.includes(directory))
      return true
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
