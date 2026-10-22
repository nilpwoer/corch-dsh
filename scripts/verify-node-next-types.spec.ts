import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const repository = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    unlinkSync(join(root, 'node_modules'))
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-node-next-types-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'))
  copyFileSync(join(repository, 'scripts/verify-node-next-types.ts'), join(root, 'scripts/verify-node-next-types.ts'))
  symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(root, 'package.json'), '{"type":"module","private":true}\n')
  return root
}

function addPackage(root: string, directory: string, name: string, declaration: string): void {
  const path = join(root, 'vendor', directory)
  mkdirSync(join(path, 'lib'), { recursive: true })
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, type: 'module', types: './lib/index.d.ts' }) + '\n')
  writeFileSync(join(path, 'lib/index.d.ts'), declaration)
}

function verify(root: string) {
  return spawnSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx/esm')).href, join(root, 'scripts/verify-node-next-types.ts')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
  })
}

function expectCleaned(root: string): void {
  expect(readdirSync(root).filter(name => name.startsWith('.node-next-types-'))).toEqual([])
  expect(existsSync(join(root, 'vendor/probe/lib/index.d.ts'))).toBe(true)
}

test('a real external NodeNext consumer compiles and cleanup retains linked declarations', () => {
  const root = fixture()
  addPackage(root, 'probe', '@fixture/probe', 'export declare const result: string\n')
  const result = verify(root)
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('1 workspace package declaration API(s) compile under NodeNext')
  expectCleaned(root)
})

test('a broken declaration export preserves compiler diagnostics and removes temporary links', () => {
  const root = fixture()
  addPackage(root, 'probe', '@fixture/probe', 'export declare const result: string\n')
  writeFileSync(join(root, 'vendor/probe/package.json'), JSON.stringify({
    name: '@fixture/probe', type: 'module', types: './lib/index.d.ts',
    exports: { '.': { types: './lib/missing.d.ts' } },
  }) + '\n')
  const result = verify(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('TS2307')
  expect(result.stderr).toContain('@fixture/probe')
  expectCleaned(root)
})

test('a package-link setup failure reports its cause and preserves the existing package files', () => {
  const root = fixture()
  addPackage(root, 'probe', '@fixture/probe', 'export declare const result: string\n')
  addPackage(root, 'duplicate', '@fixture/probe', 'export declare const result: number\n')
  const result = verify(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('EEXIST')
  expectCleaned(root)
  expect(existsSync(join(root, 'vendor/duplicate/lib/index.d.ts'))).toBe(true)
})
