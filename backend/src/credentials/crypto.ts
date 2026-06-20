// Symmetric encryption for secrets at rest (the Binance API secret/key). Uses
// AES-256-GCM — authenticated encryption, so a tampered ciphertext fails to
// decrypt rather than silently returning garbage. The 256-bit key is derived
// from the master key with scrypt + a per-blob random salt, so two encryptions
// of the same plaintext differ and the master key is never used directly.
//
// Self-describing blob format (all fields hex, ':'-delimited like the password
// hash so it survives docker-compose .env interpolation):
//
//   v1:<saltHex>:<ivHex>:<tagHex>:<cipherHex>
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'

const VERSION = 'v1'
const KEYLEN = 32 // AES-256
const SALT_BYTES = 16
const IV_BYTES = 12 // GCM standard nonce size

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, KEYLEN)
}

/** Encrypt a plaintext secret with the master key. Returns a self-describing blob. */
export function encryptSecret(plain: string, masterKey: string): string {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(masterKey, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, salt.toString('hex'), iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':')
}

/**
 * Decrypt a blob produced by encryptSecret. Throws if the master key is wrong or
 * the blob is corrupt/tampered (GCM auth failure) — callers treat that as
 * "credentials unreadable" rather than guessing.
 */
export function decryptSecret(blob: string, masterKey: string): string {
  const parts = blob.split(':')
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error('Unrecognized secret blob format')
  }
  const [, saltHex, ivHex, tagHex, cipherHex] = parts
  const salt = Buffer.from(saltHex, 'hex')
  const iv = Buffer.from(ivHex, 'hex')
  const key = deriveKey(masterKey, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]).toString('utf8')
}
