/** Production deploy verification, including mandatory peer packages and linked workspace overrides. */
import { createRequire } from 'node:module'
import { existsSync, globSync } from 'node:fs'
import { readFile, mkdir, cp, realpath, lstat, readdir } from 'node:fs/promises'
import { join, isAbsolute, dirname, relative, sep } from 'node:path'
import yaml from 'js-yaml'

/**
 * Resolve a package directory without requiring an exported package.json.
 * @param name - Bare package name.
 * @param anchor - Consumer's absolute package.json path.
 * @returns Installed package directory, or undefined.
 */
function packageDirectory(name, anchor) {
  for (const modules of createRequire(anchor).resolve.paths(name) ?? []) {
    const directory = join(modules, name)
    if (existsSync(join(directory, 'package.json'))) return directory
  }
}

/**
 * Materialize the declared workspace graph alongside locked external dependencies.
 * @param root - Repository containing publication files and desktop manifest.
 * @param runtime - New runtime containing the frozen install's external node_modules.
 * @param installedRoot - Frozen workspace mirror, including package-local version overrides.
 * @returns Workspace package names materialized as ordinary directories.
 */
export async function materializeDesktopWorkspaces(root, runtime, installedRoot = root) {
  const manifest = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
  const workspaces = new Map()
  for (const file of globSync(['vendor/*/package.json', 'packages/*/*/package.json', 'apps/*/package.json', 'native/landlock-run/package.json', 'native/landlock-run/packages/*/package.json'], { cwd: root })) {
    const path = join(root, file)
    const value = JSON.parse(await readFile(path, 'utf8'))
    workspaces.set(value.name, { directory: dirname(path), relativeDirectory: dirname(file), manifest: value })
  }
  const queue = Object.keys(manifest.dependencies)
  const visited = new Set()
  const restored = []
  while(queue.length){
    const name=queue.shift()
    const item=workspaces.get(name)
    if(!item||visited.has(name))continue
    visited.add(name)
    for(const dep of Object.keys({...item.manifest.dependencies,...item.manifest.peerDependencies})){
      if(!item.manifest.peerDependenciesMeta?.[dep]?.optional)queue.push(dep)
    }
    const target=join(runtime,'node_modules',name)
    const present=existsSync(join(target,'package.json'))
    if(!present){
    if(!item.manifest.files?.length)throw new Error(`Missing publication file list for ${name}`)
    await mkdir(target,{recursive:true})
    for(const file of globSync([...item.manifest.files,'package.json','README*','LICENSE*'],{cwd:item.directory})){
      const source=join(item.directory,file)
      const owned=relative(item.directory,await realpath(source))
      if(owned.startsWith('..')||isAbsolute(owned))throw new Error(`Publication file escaped ${name}`)
      await mkdir(dirname(join(target,file)),{recursive:true})
      await cp(source,join(target,file),{recursive:true,dereference:false,filter:path=>!path.split(sep).includes('node_modules')})
    }
    }
    const localModules=join(installedRoot,item.relativeDirectory,'node_modules')
    if(existsSync(localModules)){
      const copyInstalled=async(source,destination)=>{
        const stat=await lstat(source)
        if(stat.isSymbolicLink()){
          const actual=await realpath(source)
          const m=JSON.parse(await readFile(join(actual,'package.json'),'utf8'))
          if(workspaces.has(m.name))return
          throw new Error(`Unexpected external install link: ${m.name}`)
        }
        if(stat.isDirectory()){
          await mkdir(destination,{recursive:true})
          for(const child of await readdir(source)){
            if(child==='.bin')continue
            await copyInstalled(join(source,child),join(destination,child))
          }
        }else await cp(source,destination)
      }
      await copyInstalled(localModules,join(target,'node_modules'))
    }
    if(!present)restored.push(name)
  }
  return restored
}


/**
 * Verify dependency and mandatory peer closure using only directories inside the payload.
 * @param runtime - Deployed desktop root.
 * @param root - Optional source repository; checks installed versions against its lockfile.
 * @returns Visited package count; throws on a missing, escaping or unlocked dependency.
 */
export async function verifyDesktopClosure(runtime, root) {
  const workspaceVersions=new Map()
  let lockedPackages
  if(root){
    lockedPackages=yaml.load(await readFile(join(root,'pnpm-lock.yaml'),'utf8')).packages
    for(const file of globSync(['vendor/*/package.json','packages/*/*/package.json','apps/*/package.json','native/landlock-run/package.json','native/landlock-run/packages/*/package.json'],{cwd:root})){
      const m=JSON.parse(await readFile(join(root,file),'utf8'));workspaceVersions.set(m.name,m.version)
    }
  }
  const ownedRoot = await realpath(runtime)
  const queue = [ownedRoot]
  const visited = new Set()
  while (queue.length) {
    const directory = await realpath(queue.shift())
    if (visited.has(directory)) continue
    visited.add(directory)
    const anchor = join(directory, 'package.json')
    const manifest = JSON.parse(await readFile(anchor, 'utf8'))
    if(lockedPackages){
      if(workspaceVersions.has(manifest.name)){
        if(workspaceVersions.get(manifest.name)!==manifest.version)throw new Error(`Wrong workspace version: ${manifest.name}@${manifest.version}`)
      }else if(!lockedPackages[`${manifest.name}@${manifest.version}`])throw new Error(`Package version absent from lockfile: ${manifest.name}@${manifest.version}`)
    }
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional) continue
      const target = packageDirectory(name, anchor)
      if (!target) throw new Error(`Incomplete desktop closure: ${manifest.name} requires ${name}`)
      const actual = await realpath(target)
      const owned = relative(ownedRoot, actual)
      if (owned.startsWith('..') || isAbsolute(owned)) throw new Error(`Dependency outside desktop payload: ${name}`)
      queue.push(actual)
    }
  }
  return visited.size
}
