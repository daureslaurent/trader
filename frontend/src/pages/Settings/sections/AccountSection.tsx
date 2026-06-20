import { useState } from 'react'
import { Panel, Row } from '../widgets'
import { Input } from '../../../components/ui/Input'
import { Button } from '../../../components/ui/Button'
import { rotateBinanceKeys, changePassword } from '../../../lib/setup'

const MIN_PASSWORD_LEN = 8

type Status = { kind: 'ok' | 'err'; msg: string } | null

function StatusLine({ status }: { status: Status }) {
  if (!status) return null
  const cls = status.kind === 'ok'
    ? 'text-buy bg-buy/10 border-buy/20'
    : 'text-sell bg-sell/10 border-sell/20'
  return <p className={`text-xs border rounded-lg px-3 py-2 break-words ${cls}`}>{status.msg}</p>
}

// Account & exchange management — rotate the Binance keys and change the admin
// password after first-run setup. Self-contained (talks to /api/account/*);
// holds no global settings state.
export function AccountSection() {
  const [apiKey, setApiKey] = useState('')
  const [secret, setSecret] = useState('')
  const [keysBusy, setKeysBusy] = useState(false)
  const [keysStatus, setKeysStatus] = useState<Status>(null)

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwStatus, setPwStatus] = useState<Status>(null)

  async function saveKeys() {
    setKeysStatus(null)
    setKeysBusy(true)
    try {
      await rotateBinanceKeys(apiKey.trim(), secret.trim())
      setApiKey(''); setSecret('')
      setKeysStatus({ kind: 'ok', msg: 'Binance keys updated and validated.' })
    } catch (err) {
      setKeysStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Failed to update keys' })
    } finally {
      setKeysBusy(false)
    }
  }

  async function savePassword() {
    setPwStatus(null)
    if (next !== confirm) { setPwStatus({ kind: 'err', msg: 'New passwords don’t match.' }); return }
    setPwBusy(true)
    try {
      await changePassword(current, next)
      setCurrent(''); setNext(''); setConfirm('')
      setPwStatus({ kind: 'ok', msg: 'Password changed. Existing sessions stay signed in.' })
    } catch (err) {
      setPwStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Failed to change password' })
    } finally {
      setPwBusy(false)
    }
  }

  const keysValid = !!apiKey.trim() && !!secret.trim()
  const pwValid = !!current && next.length >= MIN_PASSWORD_LEN && next === confirm

  return (
    <Panel>
      <Row
        label="Binance API keys"
        hint="Rotate the exchange credentials. The new key/secret are validated against Binance and stored encrypted at rest before they replace the old ones. The current secret is never shown."
        stacked
      >
        <div className="space-y-2.5">
          <Input placeholder="API key" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} />
          <Input type="password" placeholder="API secret" autoComplete="off" value={secret} onChange={e => setSecret(e.target.value)} />
          <StatusLine status={keysStatus} />
          <Button variant="primary" size="sm" loading={keysBusy} disabled={!keysValid} onClick={saveKeys}>
            Update keys
          </Button>
        </div>
      </Row>

      <Row
        label="Admin password"
        hint={`Change the login password. Minimum ${MIN_PASSWORD_LEN} characters.`}
        stacked
      >
        <div className="space-y-2.5">
          <Input type="password" placeholder="Current password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />
          <Input type="password" placeholder="New password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
          <Input type="password" placeholder="Confirm new password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
          <StatusLine status={pwStatus} />
          <Button variant="primary" size="sm" loading={pwBusy} disabled={!pwValid} onClick={savePassword}>
            Change password
          </Button>
        </div>
      </Row>
    </Panel>
  )
}
