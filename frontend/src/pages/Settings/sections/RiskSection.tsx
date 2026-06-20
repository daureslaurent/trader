import { Input } from '../../../components/ui/Input'
import { SectionProps } from '../types'
import { Panel, Row, UnitInput } from '../widgets'

export function RiskSection({ settings, set }: SectionProps) {
  return (
    <Panel>
      <Row label="Min confidence" hint="Skip signals below this threshold (0–1)">
        <Input type="number" step="0.05" min="0" max="1" value={settings.min_confidence} onChange={e => set('min_confidence', parseFloat(e.target.value) || 0)} />
      </Row>
      <Row label="Max position size" hint="Maximum dollar amount per trade">
        <UnitInput type="number" min="0" unit="$" value={settings.max_position_size_usd} onChange={e => set('max_position_size_usd', parseInt(e.target.value) || 0)} />
      </Row>
      <Row label="Risk per trade" hint="Fraction of portfolio at risk (0–1)">
        <Input type="number" step="0.01" min="0" max="1" value={settings.max_risk_per_trade} onChange={e => set('max_risk_per_trade', parseFloat(e.target.value) || 0)} />
      </Row>
      <Row label="Max open positions">
        <Input type="number" step="1" min="1" value={settings.max_open_positions} onChange={e => set('max_open_positions', parseInt(e.target.value) || 0)} />
      </Row>
      <Row label="Min order size" hint="Skip BUY if the calculated order is below this USDC amount (also skips when available balance is below this threshold)">
        <UnitInput type="number" step="1" min="0" unit="$" value={settings.min_trade_usdc} onChange={e => set('min_trade_usdc', parseFloat(e.target.value) || 0)} />
      </Row>
      <Row label="Exchange fee rate" hint="Taker fee per side as a fraction (0.001 = 0.1%). Used for fee-aware PnL, break-even checks and the minimum-edge gate on new BUYs.">
        <Input type="number" step="0.0001" min="0" max="0.01" value={settings.fee_rate} onChange={e => set('fee_rate', parseFloat(e.target.value) || 0)} />
      </Row>
      <Row label="Stop loss" hint="Stop loss distance in ATR multiples">
        <UnitInput type="number" step="0.1" min="0" unit="× ATR" value={settings.stop_loss_atr} onChange={e => set('stop_loss_atr', parseFloat(e.target.value) || 0)} />
      </Row>
      <Row label="Take profit" hint="Take profit distance in ATR multiples">
        <UnitInput type="number" step="0.1" min="0" unit="× ATR" value={settings.take_profit_atr} onChange={e => set('take_profit_atr', parseFloat(e.target.value) || 0)} />
      </Row>
    </Panel>
  )
}
