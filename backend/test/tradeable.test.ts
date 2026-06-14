import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTradeable } from '../src/core/tradeable.js'

// The watchlist/discoverer must never try to "trade" the quote currency or a
// fiat/stable pair against itself — those are balance legs, not positions.
test('isTradeable: real coins are tradeable', () => {
  for (const coin of ['BTC', 'ETH', 'SOL', 'DOGE', 'LINK']) {
    assert.equal(isTradeable(coin), true, `${coin} should be tradeable`)
  }
})

test('isTradeable: stablecoins and fiat are rejected', () => {
  for (const stable of ['USDC', 'USDT', 'DAI', 'BUSD', 'FDUSD', 'USD', 'EUR', 'GBP']) {
    assert.equal(isTradeable(stable), false, `${stable} should not be tradeable`)
  }
})

test('isTradeable: is case-insensitive', () => {
  assert.equal(isTradeable('usdc'), false)
  assert.equal(isTradeable('btc'), true)
})

test('isTradeable: extracts the base from a slashed pair', () => {
  assert.equal(isTradeable('BTC/USDC'), true)   // base BTC → tradeable
  assert.equal(isTradeable('USDC/USD'), false)  // base USDC → rejected
  assert.equal(isTradeable('ETH/USDT'), true)
})
