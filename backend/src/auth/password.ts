// Password hashing with Node's built-in scrypt — no native deps, no extra
// packages (keeps the Docker image lean). scrypt is memory-hard and the
// recommended KDF for password storage. The stored format is self-describing:
//
//   scrypt:<N>:<r>:<p>:<saltHex>:<hashHex>
//
// The fields are delimited by ':' rather than '$' on purpose: a '$' in a
// docker-compose .env is interpreted as variable interpolation (`$16384` -> ''),
// which silently corrupts the hash. ':' is left untouched, so the same hash
// works in .env, the shell, and a compose env_file. Verification is
// constant-time (crypto.timingSafeEqual). We never store or log the plaintext.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// scrypt cost parameters. N must be a power of two. These are comfortably above
// the OWASP-recommended floor while staying fast enough for an interactive login.
const N = 16384 // CPU/memory cost
const R = 8 // block size
const P = 1 // parallelization
const KEYLEN = 64
const SALT_BYTES = 16

/** Produce a self-describing scrypt hash string for the given plaintext. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt:${N}:${R}:${P}:${salt.toString('hex')}:${hash.toString('hex')}`
}

/**
 * Verify a plaintext against a stored hash string. Returns false (never throws)
 * for malformed input so a corrupt setting can't crash the login path.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  try {
    // Current format is ':'-delimited; also accept the legacy '$'-delimited form
    // (neither delimiter can appear inside the hex/numeric fields).
    const parts = stored.split(stored.startsWith('scrypt:') ? ':' : '$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const [, nStr, rStr, pStr, saltHex, hashHex] = parts
    const n = Number(nStr)
    const r = Number(rStr)
    const p = Number(pStr)
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    const actual = scryptSync(plain, salt, expected.length, { N: n, r, p })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
