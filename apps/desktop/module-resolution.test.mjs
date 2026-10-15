import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerDesktopModules } from './module-resolution.mjs'

test('profile ESM and require metadata resolve shipped modules without links, preserving local plugins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop modules '))
  const modules = join(root, 'runtime/node_modules')
  const home = join(root, 'data/dsh')
  const profile = join(home, 'profiles/web')
  const packageAt = (directory, name, value) => {
    const target = join(directory, name)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }))
    writeFileSync(join(target, 'index.js'), `export default ${JSON.stringify(value)}\n`)
  }
  packageAt(modules, '@fixture/shipped', 'runtime')
  packageAt(join(profile, 'node_modules'), '@fixture/shipped', 'stale-local-copy')
  packageAt(join(profile, 'node_modules'), 'custom-plugin', 'custom')
  mkdirSync(join(modules, '@deepseek-ai/dsh/lib'), { recursive: true })
  const entry = join(modules, '@deepseek-ai/dsh/lib/bin.js')
  const program = join(profile, 'test.mjs')
  writeFileSync(program, "export { default as shipped } from '@fixture/shipped'; export { default as custom } from 'custom-plugin'\n")
  const hooks = registerDesktopModules(entry, home)
  try {
    const loaded = await import(pathToFileURL(program).href)
    assert.equal(loaded.shipped, 'runtime')
    assert.equal(loaded.custom, 'custom')
    assert.equal(createRequire(program).resolve('@fixture/shipped/package.json'), join(modules, '@fixture/shipped/package.json'))
    assert.equal(createRequire(join(root, 'unrelated.cjs')).resolve.paths('custom-plugin').includes(join(profile, 'node_modules')), false)
  } finally {
    hooks.deregister()
    rmSync(root, { recursive: true, force: true })
  }
})
