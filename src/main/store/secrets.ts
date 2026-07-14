// SecretVault（DECISIONS D8）：网关 key 不落明文。
// 实现为 Electron safeStorage：加密密钥由 macOS Keychain 托管，落盘仅密文。
// 注：与账本字面「key 存 Keychain」存在实现差异（密文文件 + Keychain 托管密钥 vs Keychain 条目），
// 已作为偏离项列入 M1 PR 待裁决；红线「无明文 key 落盘」两种实现均满足。
import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

type VaultFile = Record<string, string> // name -> base64 ciphertext

export class SecretVault {
  constructor(private readonly filePath: string) {}

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  set(name: string, value: string): void {
    if (!this.isAvailable()) throw new Error('safeStorage encryption unavailable')
    const vault = this.read()
    vault[name] = safeStorage.encryptString(value).toString('base64')
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(vault), { mode: 0o600 })
  }

  get(name: string): string | null {
    const vault = this.read()
    const ciphertext = vault[name]
    if (!ciphertext) return null
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
  }

  delete(name: string): void {
    const vault = this.read()
    if (name in vault) {
      delete vault[name]
      writeFileSync(this.filePath, JSON.stringify(vault), { mode: 0o600 })
    }
  }

  private read(): VaultFile {
    if (!existsSync(this.filePath)) return {}
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as VaultFile
    } catch {
      return {}
    }
  }
}
