/** Desktop navigation policy; browser messages retain the Web publication protocol. */
export function workerPopupAllowed(value, localOrigin) {
  try {
    const url = new URL(value)
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    const fragment = new URLSearchParams(url.hash.slice(1))
    return !url.username && !url.password && !url.search && url.pathname === '/admin/'
      && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
      && fragment.get('publish') === '1' && fragment.get('origin') === localOrigin
      && /^[a-f0-9]{64}$/.test(fragment.get('nonce') ?? '')
      && [...fragment.keys()].every(key => ['publish', 'origin', 'nonce'].includes(key))
  } catch { return false }
}

/** Keep the existing provider/credential services, with no ambient model keys. */
export function backendEnvironment(source, home) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)
    && !/^(DSH_|DEEPSEEK_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)))
  return { ...env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
}

/** Preserve ordinary same-origin navigation without permitting file or external URLs. */
export function sameOrigin(value, origin) {
  try { return new URL(value).origin === origin } catch { return false }
}
