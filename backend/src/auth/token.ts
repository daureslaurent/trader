// Stateless bearer tokens — a minimal, dependency-free JWT (HS256). We sign a
// compact `header.payload.signature` triple with HMAC-SHA256 over the secret.
// Stateless means no server-side session store: a token is valid until it
// expires. Keep the TTL modest and the secret strong.
//
// Signature comparison is constant-time. Only the HS256 alg is accepted on
// verify (guards against the classic "alg: none" / algorithm-confusion attack).
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface TokenClaims {
  sub: string // subject — the username
  iat: number // issued-at (unix seconds)
  exp: number // expiry (unix seconds)
}

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url')
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

/** Issue a signed token for `subject`, valid for `ttlSeconds` from now. */
export function signToken(subject: string, secret: string, ttlSeconds: number): { token: string; expiresAt: number } {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + ttlSeconds
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64urlEncode(JSON.stringify({ sub: subject, iat: now, exp } satisfies TokenClaims))
  const signingInput = `${header}.${payload}`
  const signature = sign(signingInput, secret)
  return { token: `${signingInput}.${signature}`, expiresAt: exp * 1000 }
}

/**
 * Verify a token's signature and expiry. Returns the claims on success, or null
 * for anything malformed, tampered, or expired (never throws).
 */
export function verifyToken(token: string, secret: string): TokenClaims | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, payload, signature] = parts

    // Recompute the signature and compare in constant time.
    const expected = sign(`${header}.${payload}`, secret)
    const a = Buffer.from(signature)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null

    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string }
    if (decodedHeader.alg !== 'HS256') return null

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenClaims
    if (typeof claims.exp !== 'number' || Math.floor(Date.now() / 1000) >= claims.exp) return null
    if (typeof claims.sub !== 'string' || !claims.sub) return null
    return claims
  } catch {
    return null
  }
}
