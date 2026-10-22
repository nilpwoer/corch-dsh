/** Workspace publication, product assembly and dependency constraints. */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkWorkspace,
  type WorkspaceManifest,
  type PackageManifest,
} from './check-workspace-constraints.ts'

describe('private product assemblies', () => {
  const product: WorkspaceManifest = {
    dir: 'apps/desktop',
    manifest: { name: '@polus-ai/corch-dsh-desktop', private: true },
  }
  it('keeps the desktop and teaching plugin private without upstream publication metadata', () => {
    expect(checkWorkspace(product)).toEqual([])
    expect(checkWorkspace({
      dir: 'packages/client/ui-polus-teaching-reform',
      manifest: { name: '@polus-ai/dsh-client-ui-teaching-reform', private: true },
    })).toEqual([])
    expect(checkWorkspace({ ...product, manifest: { ...product.manifest, private: false } }))
      .toContainEqual(expect.stringContaining('package.json must set "private": true'))
    expect(checkWorkspace({ ...product, manifest: { ...product.manifest, publishConfig: { access: 'public' } } }))
      .toContainEqual(expect.stringContaining('private product package must omit publishConfig'))
  })
  it('does not exempt a different package or directory from release requirements', () => {
    for (const workspace of [
      { ...product, dir: 'apps/another-product' },
      { ...product, manifest: { name: '@polus-ai/another-product', private: true } },
    ]) {
      expect(checkWorkspace(workspace)).toContainEqual(expect.stringContaining('release member must not set "private": true'))
    }
  })
})

describe('exported client resources', () => {
  it.each(['ui-brand-corch2', 'ui-firethorn-pet'])('requires the declared %s assets without allowing extra files', (name) => {
    const dir = `packages/client/${name}`
    const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as PackageManifest
    expect(checkWorkspace({ dir, manifest })).toEqual([])
    const declared = manifest.files ?? []
    for (const files of [declared.filter(file => !file.startsWith('assets/')), [...declared, 'assets/unlisted.bin']]) {
      expect(checkWorkspace({ dir, manifest: { ...manifest, files } }).some(error => error.includes('files must be'))).toBe(true)
    }
  })
})

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@deepseek-ai/dsh-experimental-prototype', private: true },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: experimental package must set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})
