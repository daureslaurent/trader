import { useState } from 'react'
import { ApprovalRequest } from '../types'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import { Card } from './ui/Card'
import { fmtUSD, fmt } from '../lib/utils'

interface Props {
  request: ApprovalRequest
  onAction: () => void
}

export function TradeApproval({ request, onAction }: Props) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)

  async function submit(action: 'approve' | 'reject') {
    setBusy(action)
    await fetch(`/api/trade/${action}/${request.tradeId}`, { method: 'POST' }).catch(() => {})
    onAction()
  }

  const isBuy = request.side === 'BUY'
  const total = request.quantity * request.estimatedPrice
  const pctConf = Math.round(request.confidence * 100)

  return (
    <Card className="border-warn/20">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Badge variant={isBuy ? 'buy' : 'sell'}>{request.side}</Badge>
          <span className="text-sm font-semibold text-foreground">{request.coin.replace('/USDC', '')}</span>
        </div>
        <span className="text-xs text-muted tabular-nums">Conf. {pctConf}%</span>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div>
          <p className="text-xs text-muted mb-0.5">Quantity</p>
          <p className="text-sm font-semibold tabular-nums">{fmt(request.quantity, 6)}</p>
        </div>
        <div>
          <p className="text-xs text-muted mb-0.5">Price</p>
          <p className="text-sm font-semibold tabular-nums">{fmtUSD(request.estimatedPrice)}</p>
        </div>
        <div>
          <p className="text-xs text-muted mb-0.5">Total</p>
          <p className="text-sm font-semibold tabular-nums">{fmtUSD(total)}</p>
        </div>
      </div>

      {request.reason && (
        <p className="text-xs text-muted italic mb-4 leading-relaxed border-l-2 border-border pl-3">
          {request.reason}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          variant="success"
          size="sm"
          loading={busy === 'approve'}
          disabled={busy !== null}
          onClick={() => submit('approve')}
          className="flex-1"
        >
          Approve
        </Button>
        <Button
          variant="danger"
          size="sm"
          loading={busy === 'reject'}
          disabled={busy !== null}
          onClick={() => submit('reject')}
          className="flex-1"
        >
          Reject
        </Button>
      </div>
    </Card>
  )
}
