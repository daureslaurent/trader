import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { bootApp, tablesIn } from './harness.js'

// Exercises the real DB stack: connection bootstrap, the versioned migration
// runner, the four named databases, and the settings key-value round-trip.
describe('integration: database + migrations', () => {
  let app: Awaited<ReturnType<typeof bootApp>>

  before(async () => { app = await bootApp() })

  it('creates the core trading tables', () => {
    const trading = tablesIn(app.db, 'trading')
    for (const t of ['trades', 'positions', 'portfolio_entries', 'portfolio_snapshots', 'entry_intents', 'entry_events']) {
      assert.ok(trading.includes(t), `trading db should contain "${t}" (got: ${trading.join(', ')})`)
    }
  })

  it('routes each schema namespace to its own database file', () => {
    assert.ok(tablesIn(app.db, 'settings').includes('settings'))
    assert.ok(tablesIn(app.db, 'pipeline').includes('pipeline_events'))
    assert.ok(tablesIn(app.db, 'cache').includes('llm_calls'))
  })

  it('returns sane defaults for an unseeded settings table', () => {
    const s = app.db.getSettings()
    assert.equal(s.min_trade_usdc, 12)
    assert.equal(s.fee_rate, 0.001)
    assert.equal(s.max_open_positions, 5)
    assert.deepEqual(s.watchlist, [])
  })

  it('persists and reads back a scalar setting', () => {
    app.db.updateSetting('max_open_positions', '7')
    assert.equal(app.db.getSettings().max_open_positions, 7)
  })

  it('round-trips a JSON-encoded setting (the watchlist)', () => {
    app.db.updateSetting('watchlist', JSON.stringify(['BTC', 'ETH', 'SOL']))
    assert.deepEqual(app.db.getSettings().watchlist, ['BTC', 'ETH', 'SOL'])
  })

  it('upserts an existing key rather than duplicating it', () => {
    app.db.updateSetting('fee_rate', '0.002')
    app.db.updateSetting('fee_rate', '0.0015')
    assert.equal(app.db.getSettings().fee_rate, 0.0015)
    const rows = app.db.queryAll("SELECT value FROM settings WHERE key = 'fee_rate'")
    assert.equal(rows.length, 1)
  })
})
