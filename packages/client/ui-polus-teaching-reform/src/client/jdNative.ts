/** Restricted desktop capture and PDF calls; no credentials enter the research document. */
type NativeResult<T> = { ok: true; value: T } | { ok: false; message: string }
type Capture = { state: 'captured'; url: string; title: string; body: string; captured_at: string; content_hash: string }

declare global {
  interface Window {
    corchJd?: {
      open(input: { id: string; url: string }): Promise<NativeResult<{ id: string; state: string }>>
      read(input: { id: string }): Promise<NativeResult<Capture | { state: string; message: string }>>
      close(input: { id: string }): Promise<NativeResult<void>>
      pdf(input: { html: string }): Promise<NativeResult<{ base64: string }>>
    }
  }
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
  return result.value.id
}

/** Capture the currently rendered job page after the user completes login.
 * @param id - Native window handle.
 * @returns Original rendered text and capture metadata.
 */
export async function readJdBrowser(id: string): Promise<Capture> {
  if (!window.corchJd) throw new Error('桌面采集接口不可用')
  const result = await window.corchJd.read({ id })
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
export function downloadJd(filename: string, body: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 1000)
}

/** Print through the desktop's isolated renderer, or the browser's Save as PDF dialog.
 * @param filename - Suggested exported filename.
 * @param html - Script-free report rendered by the Host from a saved graph.
 */
export async function exportJdPdf(filename: string, html: string): Promise<void> {
  if (window.corchJd) {
    const result = await window.corchJd.pdf({ html })
    if (!result.ok) throw new Error(result.message)
    const bytes = Uint8Array.from(atob(result.value.base64), character => character.charCodeAt(0))
    downloadJd(filename, bytes, 'application/pdf')
    return
  }
  const popup = window.open('', '_blank')
  if (!popup) throw new Error('请允许报告窗口弹出，再选择“另存为 PDF”')
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  popup.document.documentElement.replaceWith(popup.document.importNode(parsed.documentElement, true))
  await popup.document.fonts.ready
  popup.print()
}
