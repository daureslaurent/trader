import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { bootApp } from './harness.js'

// Exercises the portfolio ledger end-to-end against the real DB: the virtual
// USDC cash entry, deposits/withdrawals, coin holdings, partial/full reductions,
// and the portfolio-state valuation.
describe('integration: portfolio ledger', () => {
  let app: Awaited<ReturnType<typeof bootApp>>
  let p: Awaited<ReturnType<typeof bootApp>>['portfolio']

  before(async () => {
    app = await bootApp()
    p = app.portfolio
  })

  // Each test starts from a clean ledger so order doesn't matter.
  beforeEach(() => {
    app.db.runSQL('DELETE FROM portfolio_entries')
  })

  it('seeds the virtual USDC entry once and is idempotent', () => {
    p.seedUsdcIfAbsent(1000)
    p.seedUsdcIfAbsent(9999) // must not overwrite or duplicate
    const usdc = p.getUsdcEntry()
    assert.ok(usdc)
    assert.equal(usdc!.quantity, 1000)
    assert.equal(usdc!.buy_price, 1)
    assert.equal(p.getOpenEntries().length, 1)
  })

  it('deposits add to the cash balance', () => {
    p.seedUsdcIfAbsent(1000)
    assert.equal(p.depositUsdc(500), 1500)
    assert.equal(p.getUsdcEntry()!.quantity, 1500)
  })

  it('rejects an over-balance withdrawal and allows a valid one', () => {
    p.seedUsdcIfAbsent(1000)
    const tooMuch = p.withdrawUsdc(5000)
    assert.equal(tooMuch.ok, false)
    assert.equal(p.getUsdcEntry()!.quantity, 1000) // unchanged

    const ok = p.withdrawUsdc(400)
    assert.equal(ok.ok, true)
    assert.equal(p.getUsdcEntry()!.quantity, 600)
  })

  it('tracks coin holdings separately from the USDC cash leg', () => {
    p.seedUsdcIfAbsent(1000)
    p.addEntry('BTC', 0.5, 100, '2026-06-13', 'trade')

    const coinEntries = p.getCoinEntries()
    assert.equal(coinEntries.length, 1)
    assert.equal(coinEntries[0].coin, 'BTC')
    // getOpenEntries includes USDC; getCoinEntries excludes it.
    assert.equal(p.getOpenEntries().length, 2)
  })

  it('closes an entry when its quantity is fully reduced', () => {
    const id = p.addEntry('ETH', 2, 50, '2026-06-13', 'trade')
    p.reduceEntryQuantity(id, 0.5)
    assert.equal(p.getEntryByCoin('ETH')!.quantity, 1.5) // partial reduction

    p.reduceEntryQuantity(id, 1.5) // remainder → close
    assert.equal(p.getEntryByCoin('ETH'), null)
    assert.equal(p.getOpenEntries().length, 0)
  })

  it('values the portfolio at live prices', () => {
    p.seedUsdcIfAbsent(1000)
    p.addEntry('BTC', 2, 100, '2026-06-13', 'trade')

    const state = p.getPortfolioState(
      [{ symbol: 'BTC', price: 150 }],
      app.db.getSettings(),
    )
    // 1000 USDC + 2 BTC × $150 = 1300
    assert.equal(state.totalValueUsd, 1300)
    // No rows in the bot `positions` table → no slot consumed.
    assert.equal(state.openPositionCount, 0)
  })
})
