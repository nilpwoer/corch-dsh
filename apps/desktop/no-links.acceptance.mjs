/** Exercise the real portable backend with every link-creation API denied. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { backendEnvironment } from './policy.mjs'

const portable = resolve(process.argv[2])
const scratch = await mkdtemp(join(tmpdir(), 'Corch no links '))
const home = join(scratch, 'data/dsh')
const profile = join(home, 'profiles/web')
await mkdir(join(profile, 'node_modules/custom-preserved'), { recursive: true })
const manifest = JSON.stringify({ name: 'preserved-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@polus-ai/dsh-client-ui-teaching-reform', 'dsh-better-sidebar'] } } }) + '\n'
const sentinel = join(profile, 'node_modules/custom-preserved/user.txt')
await writeFile(sentinel, 'user-owned plugin data\n')
await writeFile(join(profile, 'package.json'), manifest)
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
const deny = join(scratch, 'deny-links.mjs')
await writeFile(deny, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Object.assign(new Error('TEST: link creation unavailable'),{code:'UNKNOWN',syscall:'symlink'})};
fs.symlinkSync=denied;fs.symlink=denied;fs.promises.symlink=async()=>denied();syncBuiltinESMExports();\n`)
const resources = join(portable, 'resources')
for (let round = 0; round < 2; round++) {
  const child = spawn(join(resources, 'node/node.exe'), ['--import', pathToFileURL(deny).href, join(resources, 'app/backend.mjs'), join(resources, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: scratch, env: backendEnvironment(process.env, home), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  const exited = new Promise(resolve => child.once('close', resolve))
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Backend timeout: ' + output.slice(-4000))) }, 60000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend exit ${code}: ${output.slice(-4000)}`)) })
    const collect = chunk => {
      output += chunk.toString()
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
  })
  assert.equal((await fetch(endpoint)).status, 200)
  assert.equal((await fetch(endpoint + '/plugins/@polus-ai/dsh-client-ui-teaching-reform/client.js')).status, 200)
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), manifest)
  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n')
  assert.equal(await readFile(sentinel, 'utf8'), 'user-owned plugin data\n')
  child.send({ type: 'shutdown' })
  const timeout = setTimeout(() => child.kill(), 15000)
  await exited
  clearTimeout(timeout)
}
async function verifyNoLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    assert.equal((await lstat(path)).isSymbolicLink(), false, path)
    if (entry.isDirectory()) await verifyNoLinks(path)
  }
}
await verifyNoLinks(home)
console.log(JSON.stringify({ passed: true, denied_link_apis: ['symlinkSync', 'symlink', 'promises.symlink'], backend_launches: 2, plugin_http: 200, existing_profile_preserved: true, existing_real_module_directory_preserved: true, links_created: 0, real_model_calls: 0, scratch }))
