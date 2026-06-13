import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { bootApp } from './harness.js'
import { Signal, PortfolioState, BotSettings } from '../../src/types.js'

// Exercises the full BUY gauntlet (pipeline/buyEvaluation.prepareBuyOrder) against
// the real DB + portfolio ledger + entry-timing engine. Each gate is driven by
// real state (seeded USDC, an actual held entry, a registered entry intent)
// rather than mocks.
describe('integration: BUY gauntlet (prepareBuyOrder)', () => {
  let app: Awaited<ReturnType<typeof bootApp>>
  let settings: BotSettings

  const signal = (over: Partial<Signal> = {}): Signal => ({
    coin: 'BTC', action: 'BUY', quantity: 0, reason: 'test', confidence: 0.8,
    take_profit_pct: 5, stop_loss_pct: 3, ...over,
  })

  const state = (over: Partial<PortfolioState> = {}): PortfolioState => ({
    totalValueUsd: 1000, positions: [], diversificationScore: 1,
    openPositionCount: 0, maxOpenPositions: 5, targetAllocationPct: 0.5, ...over,
  })

  before(async () => {
    app = await bootApp()
    settings = app.db.getSettings()
  })

  // Fresh ledger + USDC float for every case, and no leftover entry intents.
  beforeEach(() => {
    app.db.runSQL('DELETE FROM portfolio_entries')
    app.db.runSQL('DELETE FROM entry_intents')
    app.portfolio.seedUsdcIfAbsent(1000)
  })
  afterEach(() => {
    for (const i of app.entry.getActiveIntents()) app.entry.cancel(i.coin, 'expired')
  })

  it('approves a clean BUY and returns a sized order with SL/TP', () => {
    const r = app.buy.prepareBuyOrder({
      symbol: 'BTC', price: 100, atr14: 2, signal: signal(),
      portfolioState: state(), settings, checkActiveIntent: true,
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.ok(r.order.qty > 0)
    assert.ok(r.order.sl < 100, 'stop-loss below price')
    assert.ok(r.order.tp > 100, 'take-profit above price')
    assert.ok(Math.abs(r.order.tpPct - 5) < 1e-9, 'tpPct reflects the 5% signal target')
  })

  it('rejects when the max open-position count is reached', () => {
    const r = app.buy.prepareBuyOrder({
      symbol: 'BTC', price: 100, atr14: 2, signal: signal(),
      portfolioState: state({ openPositionCount: 5, maxOpenPositions: 5 }),
      settings, checkActiveIntent: true,
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.reason, /Max open positions/)
  })

  it('rejects a coin already held in the portfolio', () => {
    app.portfolio.addEntry('BTC', 0.5, 90, '2026-06-13', 'trade')
    const r = app.buy.prepareBuyOrder({
      symbol: 'BTC', price: 100, atr14: 2, signal: signal(),
      portfolioState: state(), settings, checkActiveIntent: true,
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.reason, /already held/)
  })

  it('rejects when USDC is below the minimum trade threshold', () => {
    app.db.runSQL('DELETE FROM portfolio_entries')
    app.portfolio.seedUsdcIfAbsent(5) // < min_trade_usdc (12)
    const r = app.buy.prepareBuyOrder({
      symbol: 'BTC', price: 100, atr14: 2, signal: signal(),
      portfolioState: state({ totalValueUsd: 5 }), settings, checkActiveIntent: true,
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.reason, /Insufficient USDC/)
  })

  it('rejects a take-profit below the fee-edge minimum', () => {
    const r = app.buy.prepareBuyOrder({
      symbol: 'BTC', price: 100, atr14: 2,
      signal: signal({ take_profit_pct: 0.2 }), // below 5×round-trip = 1%
      portfolioState: state(), settings, checkActiveIntent: true,
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.reason, /fee-edge minimum/)
  })

  it('rejects when an entry-timing intent is already pending for the coin', () => {
    app.entry.register({
      signal: signal(), signalPrice: 100, notionalUsdc: 50, atr: 2, settings,
    })
    assert.equal(app.entry.hasActiveIntent('BTC'), true)

    const r = app.buy.prepareBuyOrder({
      symbol: 'BTC', price: 100, atr14: 2, signal: signal(),
      portfolioState: state(), settings, checkActiveIntent: true,
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.reason, /intent already pending/)
  })

  it('ignores a pending intent when checkActiveIntent is false', () => {
    app.entry.register({
      signal: signal(), signalPrice: 100, notionalUsdc: 50, atr: 2, settings,
    })
    const r = app.buy.prepareBuyOrder({
      symbol: 'BTC', price: 100, atr14: 2, signal: signal(),
      portfolioState: state(), settings, checkActiveIntent: false,
    })
    assert.equal(r.ok, true)
  })
})
