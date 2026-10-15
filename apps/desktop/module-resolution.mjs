/** Resolve shipped packages from the portable runtime without links in user data. */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function registerDesktopModules(entry, home) {
  const modules = dirname(dirname(dirname(dirname(entry))))
  const anchor = pathToFileURL(join(modules, '__desktop__.mjs')).href
  const insideHome = url => {
    if (!url?.startsWith('file:')) return false
    const local = relative(home, fileURLToPath(url))
    return local !== '..' && !local.startsWith('..\\') && !local.startsWith('../') && !isAbsolute(local)
  }
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!insideHome(context.parentURL) || !/^(?:@[^/]+\/)?[^./:#][^:]*$/.test(specifier)) return nextResolve(specifier, context)
      const parts = specifier.split('/')
      const name = parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
      const manifest = join(modules, name, 'package.json')
      if (!existsSync(manifest)) return nextResolve(specifier, context)
      // Client module metadata and the boot fallback probe need package manifests,
      // including those excluded by a dependency's public exports.
      if (specifier === `${name}/package.json`) return { url: pathToFileURL(manifest).href, shortCircuit: true }
      return nextResolve(specifier, { ...context, parentURL: anchor })
    },
  })
}
