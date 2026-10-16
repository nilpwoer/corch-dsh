/** Native safeStorage vault. No plaintext fallback is permitted when OS encryption is unavailable. */
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { publisherOrigin } from './publisher.mjs'

/** Bind an encrypted credential file to Electron safeStorage on this OS account. */
export function createPublisherVault(path, safeStorage) {
  const unavailable = () => new Error('系统凭据加密不可用，请检查当前 Windows 用户会话后重试。')
  const available = () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
  return {
    async read() {
      let raw
      try { raw = await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('无法读取发布授权，请在访谈设置中重新配置。') }
      if (!available()) throw unavailable()
      try {
        const record = JSON.parse(raw)
        if (record.version !== 1 || typeof record.ciphertext !== 'string' || record.ciphertext.length > 8192) throw new Error('invalid vault')
        const saved = JSON.parse(safeStorage.decryptString(Buffer.from(record.ciphertext, 'base64')))
        if (publisherOrigin(saved.origin) !== saved.origin || !/^dsh_pub_[a-f0-9]{64}$/.test(saved.token)) throw new Error('invalid credential')
        return saved
      } catch { throw new Error('发布授权无法解密，请使用当前 Windows 账户重新保存 API Key。') }
    },
    async write(saved) {
      if (!available()) throw unavailable()
      const ciphertext = safeStorage.encryptString(JSON.stringify(saved)).toString('base64')
      const temp = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify({ version: 1, ciphertext }) + '\n', { flag: 'wx', mode: 0o600 })
        await rename(temp, path)
      } catch { throw new Error('发布授权保存失败，请检查客户端数据目录权限。') }
      finally { await rm(temp, { force: true }).catch(() => undefined) }
    },
  }
}
