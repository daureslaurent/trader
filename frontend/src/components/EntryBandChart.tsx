import { useMemo } from 'react'
import { CandleChart, type ChartLevel, type ChartZone } from './CandleChart'
import type { EntryIntent } from '../types'

/**
 * The live entry-band chart for one deferred BUY: a CandleChart overlaid with the four
 * band levels (chase cap / signal / buy target / invalidate) and the buy-zone shading
 * between invalidate and target. Shared by the Entry Desk and the Entry Agent cockpit so
 * the two render the band identically.
 */
export function EntryBandChart({ intent }: { intent: EntryIntent }) {
  const levels: ChartLevel[] = useMemo(() => [
    { price: intent.chaseCapPrice, label: 'Chase cap', color: 'rgb(var(--warn-rgb))', dash: '5 3' },
    { price: intent.signalPrice, label: 'Signal', color: 'var(--muted-fg)', dash: '2 2' },
    { price: intent.targetPrice, label: 'Buy ≤', color: 'rgb(var(--accent-rgb))' },
    { price: intent.invalidatePrice, label: 'Invalidate', color: 'rgb(var(--sell-rgb))', dash: '5 3' },
  ], [intent.chaseCapPrice, intent.signalPrice, intent.targetPrice, intent.invalidatePrice])

  const zones: ChartZone[] = useMemo(
    () => [{ y1: intent.invalidatePrice, y2: intent.targetPrice, color: 'rgb(var(--buy-rgb))' }],
    [intent.invalidatePrice, intent.targetPrice],
  )

  return <CandleChart symbol={intent.coin} levels={levels} zones={zones} hideSlTp />
}
