/** Resolve shipped packages from the portable runtime without links in user data. */
import { createRequire, registerHooks } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function registerDesktopModules(entry, home) {
  const homeDirectory = realpathSync(home)
  const modules = dirname(dirname(dirname(dirname(entry))))
  const anchor = pathToFileURL(join(modules, '__desktop__.mjs')).href
  // Match the CLI fallback's breadth-first, first-resolution-wins closure.
  // Some dependencies live under an owning package with a different version
  // from the root node_modules; their canonical directory must be retained.
  const appManifest = join(dirname(dirname(entry)), 'package.json')
  const app = JSON.parse(readFileSync(appManifest, 'utf8'))
  const packages = new Map([[app.name, dirname(appManifest)]])
  const queue = [{ anchor: appManifest, manifest: app }]
  for (let next = queue.shift(); next; next = queue.shift()) {
    for (const name of [...Object.keys(next.manifest.dependencies ?? {}), ...Object.keys(next.manifest.peerDependencies ?? {})]) {
      if (packages.has(name)) continue
      const directory = (createRequire(next.anchor).resolve.paths(name) ?? [])
        .map(path => join(path, name)).find(path => existsSync(join(path, 'package.json')))
      if (!directory) continue
      packages.set(name, directory)
      queue.push({ anchor: join(directory, 'package.json'), manifest: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) })
    }
  }
  const insideHome = url => {
    if (!url?.startsWith('file:')) return false
    const local = relative(homeDirectory, realpathSync(fileURLToPath(url)))
    return local !== '..' && !local.startsWith('..\\') && !local.startsWith('../') && !isAbsolute(local)
  }
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!insideHome(context.parentURL) || !/^(?:@[^/]+\/)?[^./:#][^:]*$/.test(specifier)) return nextResolve(specifier, context)
      const parts = specifier.split('/')
      const name = parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
      const directory = packages.get(name) ?? join(modules, name)
      const manifest = join(directory, 'package.json')
      if (!existsSync(manifest)) return nextResolve(specifier, context)
      // Client module metadata and the boot fallback probe need package manifests,
      // including those excluded by a dependency's public exports.
      if (specifier === `${name}/package.json`) return { url: pathToFileURL(manifest).href, shortCircuit: true }
      const packageAnchor = packages.has(name) ? pathToFileURL(join(dirname(directory), '__desktop__.mjs')).href : anchor
      return nextResolve(specifier, { ...context, parentURL: packageAnchor })
    },
  })
}
