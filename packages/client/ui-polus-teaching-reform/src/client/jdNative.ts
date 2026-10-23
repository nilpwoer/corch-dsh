/** Restricted desktop capture and saved-report calls; no credentials enter research documents. */
import type { JdBrowserCapture, JdBrowserCollection, JdBrowserOutcome, JdPlatformState } from './types.ts'

type NativeResult<T> = { ok: true; value: T } | { ok: false; message: string }
type ResumeResult = { item: JdBrowserOutcome; platforms: JdPlatformState[] }

declare global {
  interface Window {
    corchJd?: {
      open(this: void, input: { id: string; url: string }): Promise<NativeResult<{ id: string; state: string; message?: string }>>
      read(this: void, input: { id: string; url?: string }): Promise<NativeResult<JdBrowserOutcome>>
      close(this: void, input: { id: string }): Promise<NativeResult<void>>
      status(this: void, input: { id: string }): Promise<NativeResult<{ state: 'opened' | 'closed' }>>
      html(this: void, input: { filename: string; html: string }): Promise<NativeResult<{ path: string; opened: 'browser' | 'folder' }>>
      collect(this: void, input: { id: string; sources: { url: string; title: string }[] }): Promise<NativeResult<JdBrowserCollection>>
      platforms(this: void): Promise<NativeResult<JdPlatformState[]>>
      verify(this: void, input: { id: string; url: string }): Promise<NativeResult<{ id: string; state: string }>>
      resume(this: void, input: { id: string; url?: string }): Promise<NativeResult<ResumeResult>>
    }
  }
}

/** Detect desktop browser collection without exposing its cookies to the workbench.
 * @returns Whether the trusted native collection API is available.
 */
export function hasJdBrowser(): boolean { return typeof window.corchJd?.collect === 'function' }

/** Read shared platform policy and cache counts without navigating any page.
 * @returns Platform states, or an empty roster outside the desktop client.
 */
export async function jdBrowserPlatforms(): Promise<JdPlatformState[]> {
  if (!window.corchJd) return []
  const result = await window.corchJd.platforms()
  if (!result.ok) throw new Error(result.message)
  return result.value
}

/** Collect candidates through the native rate, cache and platform-stop policy.
 * @param id - Owning research project.
 * @param sources - Previously saved discovery candidates.
 * @returns Independent page outcomes and resulting shared platform states.
 */
export async function collectJdBrowser(id: string, sources: { url: string; title: string }[]): Promise<JdBrowserCollection> {
  if (!window.corchJd) throw new Error('浏览器渲染采集需要 Windows 桌面客户端；候选链接已存档，也可导入 JD 原文。')
  const result = await window.corchJd.collect({ id, sources })
  if (!result.ok) throw new Error(result.message)
  return result.value
}

/** Open a stopped platform only after an explicit request for human verification.
 * @param id - Owning research project.
 * @param url - Selected candidate requiring human verification.
 */
export async function verifyJdBrowser(id: string, url: string): Promise<void> {
  if (!window.corchJd) throw new Error('手动处理验证需要 Windows 桌面客户端')
  const result = await window.corchJd.verify({ id, url })
  if (!result.ok) throw new Error(result.message)
}

/** Recheck the displayed page; the native broker clears a stop only after reading a real JD.
 * @param id - Owning research project.
 * @param url - Candidate associated with the verification window.
 * @returns Current page outcome and resulting shared platform states.
 */
export async function resumeJdBrowser(id: string, url: string): Promise<ResumeResult> {
  if (!window.corchJd) throw new Error('恢复浏览器采集需要 Windows 桌面客户端')
  const result = await window.corchJd.resume({ id, url })
  if (!result.ok) throw new Error(result.message)
  return result.value
}

/** Check whether the project's human-login window is still available.
 * @param id - Owning research project.
 * @returns Whether a native capture window is open; ordinary browsers return false.
 */
export async function jdBrowserStatus(id: string): Promise<boolean> {
  if (!window.corchJd) return false
  const result = await window.corchJd.status({ id })
  if (!result.ok) throw new Error(result.message)
  return result.value.state === 'opened'
}

/** Save a confirmed report and open it in the system browser, falling back to its folder.
 * @param filename - Suggested HTML basename without a directory.
 * @param html - Escaped standalone report supplied by the Host.
 * @returns The saved path and opening result, or the download filename in an ordinary browser.
 */
export async function exportJdHtml(filename: string, html: string): Promise<{ path: string; opened: 'browser' | 'folder' | 'download' }> {
  if (!window.corchJd) {
    downloadJd(filename, html, 'text/html;charset=utf-8')
    return { path: filename, opened: 'download' }
  }
  const result = await window.corchJd.html({ filename, html })
  if (!result.ok) throw new Error(result.message)
  return result.value
}

/** Invoke the local capture broker, which is unavailable to ordinary external web pages.
 * @param id - Owning research project, stable across workbench remounts.
 * @param url - Original source selected by the user.
 * @returns The handle for an isolated login window.
 */
export async function openJdBrowser(id: string, url: string): Promise<string> {
  if (!window.corchJd) throw new Error('登录采集需要新版 Windows 桌面客户端；也可导入已取得的 JD 原文。')
  const result = await window.corchJd.open({ id, url })
  if (!result.ok) throw new Error(result.message)
  if (result.value.state !== 'opened') throw new Error(result.value.message ?? '该平台已暂停访问，请先查看平台采集状态')
  return result.value.id
}

/** Capture the currently rendered job page after the user completes login.
 * @param id - Native window handle.
 * @param url - Candidate selecting the platform window when a search spans several platforms.
 * @returns Original rendered text and capture metadata.
 */
export async function readJdBrowser(id: string, url?: string): Promise<JdBrowserCapture> {
  if (!window.corchJd) throw new Error('桌面采集接口不可用')
  const result = await window.corchJd.read({ id, ...url ? { url } : {} })
  if (!result.ok) throw new Error(result.message)
  if (result.value.state !== 'captured' || !('body' in result.value))
    throw new Error('message' in result.value ? result.value.message : '尚未取得 JD 原文')
  return result.value
}

/** Hash the exact captured text before submitting it to Host validation.
 * @param body - Source text, without model rewriting.
 * @returns SHA-256 in lowercase hexadecimal.
 */
export async function jdHash(body: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Download bytes without interpreting source content as HTML or a script.
 * @param filename - Suggested local filename.
 * @param body - Complete exported bytes.
 * @param mime - File media type.
 */
function downloadJd(filename: string, body: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 1000)
}
