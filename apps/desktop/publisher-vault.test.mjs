import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublisherVault } from './publisher-vault.mjs'

test('vault invokes OS encryption, writes no plaintext and refuses any plaintext fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corch-publisher-test-'))
  try {
    let available = true
    let encrypted = 0
    const safeStorage = { isAsyncEncryptionAvailable: async () => available,
      async encryptStringAsync(value) { encrypted++; return Buffer.from([...value].reverse().join('')) },
      async decryptStringAsync(value) { return { result: [...value.toString()].reverse().join(''), shouldReEncrypt: false } },
    }
    const path = join(directory, 'publisher.json')
    const vault = createPublisherVault(path, safeStorage)
    assert.equal(await vault.read(), undefined)
    const saved = { origin: 'https://worker.test', token: 'dsh_pub_' + 'a'.repeat(64) }
    await vault.write(saved)
    assert.equal(encrypted, 1)
    const raw = await readFile(path, 'utf8')
    assert.equal(raw.includes(saved.token), false)
    assert.equal(raw.includes(saved.origin), false)
    assert.deepEqual(await vault.read(), saved)
    available = false
    await assert.rejects(vault.write(saved), /系统凭据加密不可用/)
    await assert.rejects(vault.read(), /系统凭据加密不可用/)
    assert.equal(await readFile(path, 'utf8'), raw)
    available = true
    safeStorage.getSelectedStorageBackend = () => 'basic_text'
    await assert.rejects(vault.write(saved), /系统凭据加密不可用/)
    delete safeStorage.getSelectedStorageBackend
    safeStorage.encryptStringAsync = async () => { throw new Error('safeStorage.encryptStringAsync is temporarily unavailable. Please try again.') }
    await assert.rejects(vault.write(saved), /系统凭据暂时不可用/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
