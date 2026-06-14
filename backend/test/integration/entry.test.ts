import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { bootApp } from './harness.js'
import { Signal, BotSettings } from '../../src/types.js'

const approx = (actual: unknown, expected: number) =>
  assert.ok(Math.abs(Number(actual) - expected) < 1e-6, `expected ${actual} ≈ ${expected}`)

// Exercises the entry-timing engine's persistence + bookkeeping against the real
// DB: registering an intent computes the watch band, mirrors it to entry_intents,
// logs an activity event, and cancelling clears the row and logs the cancel.
describe('integration: entry-timing engine', () => {
  let app: Awaited<ReturnType<typeof bootApp>>
  let settings: BotSettings

  const signal: Signal = { coin: 'ETH', action: 'BUY', quantity: 0, reason: 'test', confidence: 0.7 }

  before(async () => {
    app = await bootApp()
    // Pin the band percentages so the math is deterministic.
    app.db.updateSetting('entry_pullback_pct', '0.5')
    app.db.updateSetting('entry_invalidate_pct', '3')
    app.db.updateSetting('entry_max_chase_pct', '1.5')
    settings = app.db.getSettings()
  })

  beforeEach(() => {
    for (const i of app.entry.getActiveIntents()) app.entry.cancel(i.coin, 'expired')
    app.db.runSQL('DELETE FROM entry_intents')
    app.db.runSQL('DELETE FROM entry_events')
  })

  it('registers an intent, computes the watch band, and persists it', () => {
    app.entry.register({ signal, signalPrice: 100, notionalUsdc: 50, atr: 2, settings })

    assert.equal(app.entry.hasActiveIntent('ETH'), true)

    const row = app.db.queryOne("SELECT * FROM entry_intents WHERE coin = 'ETH'")
    assert.ok(row, 'intent row should be persisted')
    approx(row!.signal_price, 100)
    approx(row!.target_price, 99.5)      // 100 × (1 − 0.5%)
    approx(row!.invalidate_price, 97)    // 100 × (1 − 3%)
    approx(row!.chase_cap_price, 101.5)  // 100 × (1 + 1.5%)
    approx(row!.notional_usdc, 50)
  })

  it('logs a "registered" activity event', () => {
    app.entry.register({ signal, signalPrice: 100, notionalUsdc: 50, atr: 2, settings })
    const events = app.entry.getRecentEvents().filter(e => e.coin === 'ETH')
    assert.ok(events.some(e => e.type === 'registered'))

    const persisted = app.db.queryOne("SELECT type FROM entry_events WHERE coin = 'ETH' AND type = 'registered'")
    assert.ok(persisted, 'registered event should be persisted to entry_events')
  })

  it('enforces one active intent per coin (no duplicate on re-register)', () => {
    app.entry.register({ signal, signalPrice: 100, notionalUsdc: 50, atr: 2, settings })
    app.entry.register({ signal, signalPrice: 200, notionalUsdc: 99, atr: 5, settings })

    const rows = app.db.queryAll("SELECT signal_price FROM entry_intents WHERE coin = 'ETH'")
    assert.equal(rows.length, 1)
    assert.equal(rows[0].signal_price, 100, 'the first intent is kept, the re-register is ignored')
  })

  it('cancels an intent: clears the live state, the DB row, and logs the cancel', () => {
    app.entry.register({ signal, signalPrice: 100, notionalUsdc: 50, atr: 2, settings })
    app.entry.cancel('ETH', 'ran_away', 105)

    assert.equal(app.entry.hasActiveIntent('ETH'), false)
    assert.equal(app.db.queryOne("SELECT id FROM entry_intents WHERE coin = 'ETH'"), null)

    const cancelled = app.db.queryOne("SELECT reason FROM entry_events WHERE coin = 'ETH' AND type = 'cancelled'")
    assert.ok(cancelled)
    assert.equal(cancelled!.reason, 'ran_away')
  })
})
