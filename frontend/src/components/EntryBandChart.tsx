import { useMemo } from 'react'
import { CandleChart, type ChartLevel, type ChartZone } from './CandleChart'
import type { EntryIntent } from '../types'

/**
 * The live entry-band chart for one deferred BUY: a CandleChart overlaid with the four
 * band levels (chase cap / signal / buy target / invalidate) and the buy-zone shading
 * between invalidate and target. Shared by the Entry Desk and the Entry Agent cockpit so
 * the two render the band identically.
 *
 * When rebound confirmation is on and the intent is armed (price in the buy zone), it also
 * draws the tracked low (trough) and the bounce trigger — `troughPrice × (1 + reboundPct/100)` —
 * so the chart shows exactly what the engine is waiting for: a bounce off the low, not a touch.
 */
export function EntryBandChart({ intent, reboundPct }: { intent: EntryIntent; reboundPct?: number }) {
  const armed = intent.armed && intent.troughPrice != null
  const bouncePrice = armed && reboundPct != null ? intent.troughPrice! * (1 + reboundPct / 100) : null

  const levels: ChartLevel[] = useMemo(() => {
    const base: ChartLevel[] = [
      { price: intent.chaseCapPrice, label: 'Chase cap', color: 'rgb(var(--warn-rgb))', dash: '5 3' },
      { price: intent.signalPrice, label: 'Signal', color: 'var(--muted-fg)', dash: '2 2' },
      { price: intent.targetPrice, label: armed ? 'Buy zone' : 'Buy ≤', color: 'rgb(var(--accent-rgb))', dash: armed ? '4 4' : undefined },
      { price: intent.invalidatePrice, label: 'Invalidate', color: 'rgb(var(--sell-rgb))', dash: '5 3' },
    ]
    if (armed && intent.troughPrice != null) {
      base.push({ price: intent.troughPrice, label: 'Low', color: 'var(--muted-fg)', dash: '2 2' })
    }
    if (bouncePrice != null) {
      base.push({ price: bouncePrice, label: 'Buy on bounce ≥', color: 'rgb(var(--accent-rgb))' })
    }
    return base
  }, [intent.chaseCapPrice, intent.signalPrice, intent.targetPrice, intent.invalidatePrice, intent.troughPrice, armed, bouncePrice])

  const zones: ChartZone[] = useMemo(() => {
    // While armed, highlight the rebound window (low → bounce trigger); otherwise the static buy zone.
    if (armed && intent.troughPrice != null && bouncePrice != null) {
      return [{ y1: intent.troughPrice, y2: bouncePrice, color: 'rgb(var(--buy-rgb))' }]
    }
    return [{ y1: intent.invalidatePrice, y2: intent.targetPrice, color: 'rgb(var(--buy-rgb))' }]
  }, [intent.invalidatePrice, intent.targetPrice, intent.troughPrice, armed, bouncePrice])

  return <CandleChart symbol={intent.coin} levels={levels} zones={zones} hideSlTp />
}
