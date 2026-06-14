import { MarketContext, Signal } from '../types.js'

/**
 * Build the Entry Planner prompt. The model is handed the live market context and
 * the analyst's BUY thesis, and decides the four entry-band levels purely from the
 * setup. The static `entry_*` settings are deliberately NOT shown: passing them as
 * a baseline anchored the model onto the operator's one-size-fits-all defaults,
 * defeating the point of a per-coin plan. The qualitative guidance in the system
 * prompt is what keeps the chosen levels grounded.
 */
export function buildEntryPlannerPrompt(
  coin: string,
  price: number,
  market: MarketContext,
  signal: Signal,
): { system: string; user: string } {
  const system = [
    'You are the Entry Planner for a crypto trading bot.',
    'A BUY has already been decided by the analyst. Your ONLY job is to choose the entry-timing band:',
    'how far below the current price to wait for a pullback, when to abandon the trade as a falling knife,',
    'when to give up because price ran away, and how long to keep waiting.',
    '',
    'Reason about the setup:',
    '- High volatility / wide ATR → a deeper pullback target and wider invalidate are reasonable; tight bands will whipsaw.',
    '- Low volatility / calm regime → a shallow pullback and tight chase cap; little dip is likely, so do not wait long.',
    '- Strong uptrend / high momentum → a small pullback (price may not dip much) and a slightly looser chase cap.',
    '- Downtrend / weak momentum → a deeper, more patient pullback but a tighter invalidate (protect against breakdown).',
    '- High analyst confidence → you can be a touch more aggressive chasing; low confidence → demand a better discount.',
    '- The invalidate distance MUST be larger than the pullback target (you cannot cancel above where you intend to buy).',
    '',
    'Return ONLY a JSON object, no prose, with these numeric fields (percent values are plain numbers, e.g. 1.5 means 1.5%):',
    '{',
    '  "pullback_pct": number,    // % below signal price to buy the dip (>= 0)',
    '  "invalidate_pct": number,  // % below signal price to abandon as a falling knife (> pullback_pct)',
    '  "chase_cap_pct": number,   // % above signal price to abandon (don\'t chase) (> 0)',
    '  "ttl_minutes": number,     // how long to wait before the intent expires (> 0)',
    '  "reason": string           // one short sentence justifying these levels',
    '}',
  ].join('\n')

  const user = [
    `Coin: ${coin}`,
    `Current price: ${price}`,
    '',
    'Market context:',
    `- 24h change: ${market.change24h?.toFixed?.(2) ?? market.change24h}%`,
    `- 7d performance: ${market.perf7d?.toFixed?.(2) ?? market.perf7d}%`,
    `- Trend: ${market.trend}`,
    `- Volatility: ${market.volatility}`,
    `- RSI(14): ${market.rsi14?.toFixed?.(1) ?? market.rsi14}`,
    `- ATR(14): ${market.atr14} (${price > 0 ? ((market.atr14 / price) * 100).toFixed(2) : '?'}% of price)`,
    `- SMA 7 / 25 / 99: ${market.sma7} / ${market.sma25} / ${market.sma99}`,
    '',
    'Analyst BUY thesis:',
    `- Confidence: ${(signal.confidence * 100).toFixed(0)}%`,
    signal.horizon ? `- Horizon: ${signal.horizon}` : '- Horizon: (unspecified)',
    signal.stop_loss_pct != null ? `- Planned stop-loss: ${signal.stop_loss_pct}% below entry` : '',
    signal.take_profit_pct != null ? `- Planned take-profit: ${signal.take_profit_pct}% above entry` : '',
    `- Reasoning: ${signal.reason}`,
    '',
    'Respond with the JSON object only.',
  ].filter(Boolean).join('\n')

  return { system, user }
}
