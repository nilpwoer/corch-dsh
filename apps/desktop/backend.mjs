/** Owned Node child: the ordinary built DSH CLI plus bounded parent-disconnect cleanup. */
import { pathToFileURL } from 'node:url'
import { registerDesktopModules } from './module-resolution.mjs'
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  process.emit('SIGINT')
  setTimeout(() => process.exit(2), 10_000).unref()
}
process.on('message', message => { if (message?.type === 'shutdown') stop() })
process.on('disconnect', stop)
const entry = process.argv[2]
registerDesktopModules(entry, process.env.DSH_HOME)
process.argv = [process.execPath, entry, ...process.argv.slice(3)]
await import(pathToFileURL(entry).href)
