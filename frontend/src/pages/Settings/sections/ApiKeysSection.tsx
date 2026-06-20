import { useEffect, useState } from 'react'
import { Panel, Row } from '../widgets'
import { Input } from '../../../components/ui/Input'
import { Button } from '../../../components/ui/Button'
import { listApiKeys, createApiKey, revokeApiKey, ApiKeyInfo } from '../../../lib/apiKeys'

type Status = { kind: 'ok' | 'err'; msg: string } | null

function StatusLine({ status }: { status: Status }) {
  if (!status) return null
  const cls = status.kind === 'ok'
    ? 'text-buy bg-buy/10 border-buy/20'
    : 'text-sell bg-sell/10 border-sell/20'
  return <p className={`text-xs border rounded-lg px-3 py-2 break-words ${cls}`}>{status.msg}</p>
}

// The full token, shown exactly once right after creation. It's never recoverable
// afterwards (only its hash is stored), so this banner makes that explicit and
// offers a one-click copy.
function NewTokenBanner({ token, onDismiss }: { token: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked — the user can still select the text */ }
  }
  return (
    <div className="space-y-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-3">
      <p className="text-xs font-medium text-foreground">
        Copy your key now — it won’t be shown again.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 select-all break-all rounded-md bg-surface-elevated px-2.5 py-1.5 font-mono text-xs text-foreground">
          {token}
        </code>
        <Button type="button" variant="secondary" size="sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-xs text-muted">
        Put it in <code className="font-mono">tools/.env</code> as <code className="font-mono">BOT_API_KEY</code>.
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>Done</Button>
    </div>
  )
}

// API Keys — long-lived keys that let the tools/ CLIs read bot data over the
// read-only debug API without DB access. Self-contained (talks to
// /api/account/api-keys); holds no global settings state.
export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [newToken, setNewToken] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  async function refresh() {
    try {
      setKeys(await listApiKeys())
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Failed to load keys' })
    }
  }

  useEffect(() => { void refresh() }, [])

  async function create() {
    setStatus(null)
    setNewToken(null)
    setCreating(true)
    try {
      const res = await createApiKey(name.trim())
      setNewToken(res.token)
      setName('')
      await refresh()
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Failed to create key' })
    } finally {
      setCreating(false)
    }
  }

  async function revoke(id: string) {
    setStatus(null)
    setRevoking(id)
    try {
      await revokeApiKey(id)
      await refresh()
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Failed to revoke key' })
    } finally {
      setRevoking(null)
    }
  }

  return (
    <Panel>
      <Row
        label="Create a key"
        hint="API keys let the tools/ CLIs (and AI-assisted debugging) read bot data over the read-only debug API — no database access needed. Give the key a name you’ll recognize, then copy it into tools/.env."
        stacked
      >
        <div className="space-y-2.5">
          <Input
            placeholder="Key name (e.g. tools-laptop)"
            autoComplete="off"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          {newToken && <NewTokenBanner token={newToken} onDismiss={() => setNewToken(null)} />}
          <StatusLine status={status} />
          <Button variant="primary" size="sm" loading={creating} disabled={!name.trim()} onClick={create}>
            Create key
          </Button>
        </div>
      </Row>

      <Row label="Active keys" hint="Each key is shown by its prefix only. Revoke a key to immediately cut off any tool using it." stacked>
        {keys === null ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-xs text-muted">No keys yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {keys.map(k => (
              <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{k.name}</p>
                  <p className="text-xs text-muted">
                    <code className="font-mono">{k.prefix}…</code>
                    {' · '}created {k.created_at}
                    {' · '}{k.last_used_at ? `last used ${k.last_used_at}` : 'never used'}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  loading={revoking === k.id}
                  onClick={() => revoke(k.id)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Row>
    </Panel>
  )
}
