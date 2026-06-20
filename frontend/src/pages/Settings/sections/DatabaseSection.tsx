import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import { Select } from '../../../components/ui/Input'
import { cn } from '../../../lib/utils'
import { SectionProps } from '../types'
import { Panel, Row, UnitInput } from '../widgets'

interface DbStats {
  db: string
  totalDocs: number
  collections: { name: string; count: number; cache: boolean }[]
}

type ImportPreview = { file: unknown; collections: { name: string; count: number }[] }

async function postJson(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  return data as Record<string, unknown>
}

// Small inline result banner (error / success) reused by every action panel.
function Notice({ kind, children }: { kind: 'error' | 'ok'; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg px-3 py-2 text-xs', kind === 'error' ? 'bg-sell/10 text-sell' : 'bg-buy/10 text-buy')}>
      {children}
    </div>
  )
}

export function DatabaseSection({ settings, set }: SectionProps) {
  const [stats, setStats] = useState<DbStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const [exportSel, setExportSel] = useState<string>('all')
  const [includeCaches, setIncludeCaches] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState<string | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const [importOk, setImportOk] = useState<string | null>(null)

  const [confirmCaches, setConfirmCaches] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // which maintenance action is running
  const [maintMsg, setMaintMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)

  async function loadStats() {
    setStatsLoading(true)
    try {
      const res = await fetch('/api/database/stats')
      setStats(await res.json())
    } catch {
      /* best-effort */
    } finally {
      setStatsLoading(false)
    }
  }

  useEffect(() => { loadStats() }, [])

  async function doExport() {
    setExporting(true)
    setExportErr(null)
    try {
      const res = await fetch('/api/database/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collections: exportSel === 'all' ? 'all' : [exportSel],
          includeCaches,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') || ''
      const match = cd.match(/filename="([^"]+)"/)
      const filename = match?.[1] || `cryptobot-backup-${Date.now()}.json`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setExportErr(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    setImportErr(null)
    setImportOk(null)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        const cols = parsed?.collections
        if (!cols || typeof cols !== 'object') throw new Error('Not a valid backup file (missing "collections").')
        const list = Object.keys(cols).map(name => ({
          name,
          count: Array.isArray(cols[name]) ? cols[name].length : 0,
        }))
        setPreview({ file: parsed, collections: list })
      } catch (err) {
        setImportErr(err instanceof Error ? err.message : 'Failed to read file')
      }
    }
    reader.onerror = () => setImportErr('Failed to read file')
    reader.readAsText(file)
  }

  async function confirmImport() {
    if (!preview) return
    setImporting(true)
    setImportErr(null)
    try {
      const data = await postJson('/api/database/import', preview.file)
      const imported = (data.imported ?? {}) as Record<string, number>
      const total = Object.values(imported).reduce((s, n) => s + n, 0)
      setImportOk(`Imported ${total.toLocaleString()} documents across ${Object.keys(imported).length} collections.`)
      setPreview(null)
      void loadStats()
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  async function runMaintenance(action: 'clear-caches' | 'reseed-counters' | 'reindex', label: string) {
    setBusy(action)
    setMaintMsg(null)
    try {
      await postJson(`/api/database/${action}`)
      setMaintMsg({ kind: 'ok', text: `${label} completed.` })
      void loadStats()
    } catch (err) {
      setMaintMsg({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
      setConfirmCaches(false)
    }
  }

  const names = stats?.collections.map(c => c.name) ?? []

  return (
    <div className="space-y-5">
      {/* ── Overview ─────────────────────────────────────────────── */}
      <Panel>
        <Row
          label="Overview"
          hint={stats ? `Database "${stats.db}" · ${stats.totalDocs.toLocaleString()} documents total` : 'Live document counts per collection.'}
        >
          <Button type="button" variant="secondary" size="sm" onClick={loadStats} loading={statsLoading}>
            Refresh
          </Button>
        </Row>
        <div className="py-4">
          {!stats ? (
            <p className="text-xs text-muted">Loading collection stats…</p>
          ) : (
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              {stats.collections.map(c => (
                <div key={c.name} className="flex items-center justify-between gap-3 border-b border-border/40 py-1.5 last:border-0">
                  <span className="flex items-center gap-1.5 truncate font-mono text-xs text-foreground">
                    {c.name}
                    {c.cache && (
                      <span className="rounded-full bg-surface-elevated px-1.5 py-px text-[9px] uppercase tracking-wide text-muted">cache</span>
                    )}
                  </span>
                  <span className={cn('shrink-0 text-xs tabular-nums', c.count > 0 ? 'text-foreground' : 'text-muted')}>
                    {c.count.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Panel>

      {/* ── Export ───────────────────────────────────────────────── */}
      <Panel>
        <Row
          label="Export"
          hint="Download a JSON snapshot. Caches and logs are excluded from “All collections” unless you opt in."
          stacked
        >
          <div className="space-y-3">
            <Select value={exportSel} onChange={e => setExportSel(e.target.value)} className="max-w-md">
              <option value="all">All collections</option>
              {names.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </Select>
            {exportSel === 'all' && (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={includeCaches}
                  onChange={e => setIncludeCaches(e.target.checked)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                Include caches &amp; logs (larger file)
              </label>
            )}
            <div>
              <Button type="button" variant="secondary" onClick={doExport} loading={exporting}>
                Export {exportSel === 'all' ? 'all' : exportSel}
              </Button>
            </div>
            {exportErr && <Notice kind="error">{exportErr}</Notice>}
          </div>
        </Row>
      </Panel>

      {/* ── Import ───────────────────────────────────────────────── */}
      <Panel>
        <Row
          label="Import"
          hint="Restore from a JSON backup. Each collection in the file is replaced — its existing documents are deleted first."
          stacked
        >
          <div className="space-y-3">
            <input ref={fileRef} type="file" accept=".json,application/json" onChange={onFilePicked} className="hidden" />
            <div>
              <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
                Choose backup file…
              </Button>
            </div>
            {importErr && <Notice kind="error">{importErr}</Notice>}
            {importOk && <Notice kind="ok">{importOk}</Notice>}
          </div>
        </Row>
      </Panel>

      {/* ── Retention ────────────────────────────────────────────── */}
      <Panel>
        <Row label="Retain LLM data" hint="Delete raw llm_calls older than this many days, keeping aggregate stats. 0 = keep forever.">
          <UnitInput
            type="number" step="1" min="0" max="3650" unit="days"
            value={settings.llm_retain_days}
            onChange={e => set('llm_retain_days', parseInt(e.target.value) || 0)}
          />
        </Row>
        <Row label="Retain pipeline events" hint="Delete pipeline_events rows older than this many days. 0 = keep forever.">
          <UnitInput
            type="number" step="1" min="0" max="3650" unit="days"
            value={settings.pipeline_events_retain_days}
            onChange={e => set('pipeline_events_retain_days', parseInt(e.target.value) || 0)}
          />
        </Row>
        <Row label="Retain debug logs" hint="Delete debug_logs rows older than this many days. 0 = keep forever.">
          <UnitInput
            type="number" step="1" min="0" max="3650" unit="days"
            value={settings.debug_logs_retain_days}
            onChange={e => set('debug_logs_retain_days', parseInt(e.target.value) || 0)}
          />
        </Row>
      </Panel>

      {/* ── Maintenance ──────────────────────────────────────────── */}
      <Panel>
        <Row label="Clear caches & logs" hint="Empty all regenerable cache and log collections (extraction, OHLCV, LLM calls, debug logs, pipeline events).">
          <Button type="button" variant="danger" size="sm" onClick={() => setConfirmCaches(true)} loading={busy === 'clear-caches'}>
            Clear caches
          </Button>
        </Row>
        <Row label="Reseed id counters" hint="Reset each integer-id counter to its current max id. Repairs counter drift after a manual restore.">
          <Button type="button" variant="secondary" size="sm" onClick={() => runMaintenance('reseed-counters', 'Reseed counters')} loading={busy === 'reseed-counters'}>
            Reseed
          </Button>
        </Row>
        <Row label="Rebuild indexes" hint="Re-ensure all collection indexes. Idempotent and safe to run anytime.">
          <Button type="button" variant="secondary" size="sm" onClick={() => runMaintenance('reindex', 'Rebuild indexes')} loading={busy === 'reindex'}>
            Rebuild
          </Button>
        </Row>
        {maintMsg && (
          <div className="py-4">
            <Notice kind={maintMsg.kind}>{maintMsg.text}</Notice>
          </div>
        )}
      </Panel>

      {/* ── Import confirm modal ─────────────────────────────────── */}
      <Modal
        open={!!preview}
        onClose={() => !importing && setPreview(null)}
        title="Confirm import"
        subtitle="The collections below will be replaced with the file's contents."
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setPreview(null)} disabled={importing}>Cancel</Button>
            <Button type="button" variant="danger" onClick={confirmImport} loading={importing}>Replace data</Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
            This deletes existing documents in these collections before inserting. This cannot be undone.
          </div>
          <div className="max-h-60 space-y-1 overflow-y-auto">
            {preview?.collections.map(c => (
              <div key={c.name} className="flex items-center justify-between gap-3 text-xs">
                <span className="font-mono text-foreground">{c.name}</span>
                <span className="tabular-nums text-muted">{c.count.toLocaleString()} docs</span>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {/* ── Clear-caches confirm modal ───────────────────────────── */}
      <Modal
        open={confirmCaches}
        onClose={() => busy !== 'clear-caches' && setConfirmCaches(false)}
        title="Clear caches & logs?"
        subtitle="Regenerable data only — your trading state is untouched."
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setConfirmCaches(false)} disabled={busy === 'clear-caches'}>Cancel</Button>
            <Button type="button" variant="danger" onClick={() => runMaintenance('clear-caches', 'Clear caches')} loading={busy === 'clear-caches'}>Clear caches</Button>
          </div>
        }
      >
        <p className="text-xs text-muted">
          Empties extraction cache, OHLCV cache, LLM call records &amp; stats, debug logs, pipeline events, and pending LLM jobs.
        </p>
      </Modal>
    </div>
  )
}
