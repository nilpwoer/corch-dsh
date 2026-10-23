/** Save standalone JD reports under the desktop data directory and open them with the system browser. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Create the native HTML exporter for the trusted local workbench.
 * @param options - App-owned exports directory and Electron shell operations.
 * @returns A writer accepting a basename and at most 24 MiB of HTML; successful writes remain saved even when opening fails.
 */
export function createJdReport({ exportsDirectory, shell }) {
  return async input => {
    const filename = input?.filename
    if (typeof filename !== 'string' || filename.length > 160 || !/\.html$/iu.test(filename)
      || /[<>:"/\\|?*\x00-\x1f]/u.test(filename) || /^\.|[. ]$/u.test(filename)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(filename)) throw new Error('HTML 报告文件名无效，请使用不含路径的 .html 文件名。')
    if (typeof input.html !== 'string' || !input.html.trim() || Buffer.byteLength(input.html) > 24 * 1024 * 1024) throw new Error('HTML 报告内容为空或超过 24 MiB。')
    const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">'
    const html = /<head\b[^>]*>/iu.test(input.html) ? input.html.replace(/<head\b[^>]*>/iu, '$&' + csp) : csp + input.html
    let path
    try {
      await mkdir(exportsDirectory, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(exportsDirectory, 'jd-report-'))
      path = join(directory, filename)
      await writeFile(path, html, { flag: 'wx', mode: 0o600 })
    } catch { throw new Error('HTML 报告保存失败，请检查客户端 data/exports 目录的写入权限和可用空间。') }
    try {
      await shell.openExternal(pathToFileURL(path).href)
      return { path, opened: 'browser' }
    } catch {
      try { shell.showItemInFolder(path) }
      catch { throw new Error(`HTML 报告已保存，但无法打开浏览器或文件目录：${path}`) }
      return { path, opened: 'folder' }
    }
  }
}
