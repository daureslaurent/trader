// Debug API-key client — drives the Settings → API Keys card. All requests go
// through the global fetch interceptor (lib/auth.ts), which attaches the admin
// login token. Mirrors the error-unwrapping style of lib/setup.ts.

export interface ApiKeyInfo {
  id: string
  name: string
  prefix: string
  created_at: string
  last_used_at: string | null
}

async function unwrap<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || fallback)
  }
  return res.json() as Promise<T>
}

/** List existing keys (prefix only — the full token is never returned again). */
export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  return unwrap<ApiKeyInfo[]>(await fetch('/api/account/api-keys'), 'Failed to load API keys')
}

/** Create a key. Returns the plaintext token — shown to the user exactly once. */
export async function createApiKey(name: string): Promise<{ id: string; name: string; token: string }> {
  const res = await fetch('/api/account/api-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return unwrap(res, 'Failed to create API key')
}

/** Revoke a key by id. */
export async function revokeApiKey(id: string): Promise<void> {
  await unwrap(await fetch(`/api/account/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Failed to revoke API key')
}
