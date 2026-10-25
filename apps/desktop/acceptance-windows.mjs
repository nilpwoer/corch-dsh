/** Keep isolated desktop acceptance renders away from the user's desktop and keyboard focus. */

/** Suppress OS presentation while preserving native show events and renderer screenshots.
 * @param desktop - Playwright Electron application owning only the isolated acceptance process.
 * @param visible - Whether an explicitly requested debugging run may display its windows.
 * @returns Resolves after current windows are isolated and future-window handling is installed.
 */
export async function isolateAcceptanceWindows(desktop, visible = false) {
  if (visible) return
  await desktop.evaluate(({ app, BrowserWindow }) => {
    const prepare = window => {
      window.setOpacity(0)
      window.setSkipTaskbar(true)
      window.setFocusable(false)
      window.webContents.setBackgroundThrottling(false)
      window.show = window.showInactive.bind(window)
      window.focus = () => undefined
    }
    app.on('browser-window-created', (_event, window) => prepare(window))
    for (const window of BrowserWindow.getAllWindows()) prepare(window)
  })
}
