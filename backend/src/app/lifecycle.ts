import { initDB, shutdownDB, loadSettings, trades, pipelineEvents, getSettings, updateSetting } from '../db/index.js'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { startAPI } from '../api/index.js'
import { startTelegramBot, startNotifier } from '../telegram/index.js'
import { getTopPairs } from '../trader/index.js'
import * as priceCache from '../market/index.js'
import * as entry from '../entry/index.js'
import { getOpenEntries, checkOpenPositions } from '../portfolio/index.js'
import { isTradeable } from '../core/tradeable.js'
import { closeBrowser } from '../scraper/browser.js'
import { logPipelineEvent } from '../pipeline/index.js'
import { startSchedulers, stopSchedulers } from './scheduler.js'
import { initRouting, fireRoutingStartup } from '../routing/index.js'
import { resumeDurableJobs } from '../core/llmScheduler.js'
import { bus } from '../core/events.js'
import { loadCredentials, isConfigured } from '../credentials/index.js'

let server: ReturnType<typeof startAPI> | undefined
let enginesStarted = false

export async function start(): Promise<void> {
  logger.info('Starting CryptoBot...')
  await initDB()
  await loadSettings()
  await loadCredentials()

  // Orphaned PENDING trades can't be executed after a restart (signal state is lost)
  const orphaned = await trades.updateMany({ status: 'PENDING' }, { status: 'FAILED' })
  if (orphaned > 0) {
    logger.warn('Marked orphaned PENDING trades as FAILED on startup', { count: orphaned })
  }

  // Cancel any pipeline cycles that never reached a terminal stage (process was killed mid-run)
  const TERMINAL_STAGES = ['signal_generated', 'trade_executed', 'trade_skipped', 'pipeline_error', 'pipeline_timeout', 'pipeline_failed', 'pipeline_cancelled']
  const terminalCycleIds = await pipelineEvents.col().distinct('cycle_id', { stage: { $in: TERMINAL_STAGES } })
  const openCycles = await pipelineEvents.aggregate<{ cycle_id: string; coin: string }>([
    { $match: { cycle_id: { $nin: terminalCycleIds } } },
    { $group: { _id: '$cycle_id', coin: { $first: '$coin' } } },
    { $project: { _id: 0, cycle_id: '$_id', coin: 1 } },
  ])

  if (openCycles.length > 0) {
    for (const { cycle_id, coin } of openCycles) {
      await logPipelineEvent('pipeline_cancelled', coin, cycle_id, { error: 'Server restarted' })
    }
    logger.warn('Cancelled orphaned pipeline cycles on startup', { count: openCycles.length })
  }

  // Env var seeds the DB setting on every startup so .env stays authoritative
  if (config.pipelineCron) {
    await updateSetting('pipeline_cron', config.pipelineCron)
  }

  server = startAPI()

  // Wire deferred engine startup before any early return, so completing the
  // first-run wizard launches the engines without a restart.
  bus.on('setup_completed', () => {
    startEngines().catch(err =>
      logger.error('Failed to start engines after setup', { error: err instanceof Error ? err.message : String(err) }))
  })

  if (!isConfigured()) {
    logger.warn(
      'Not configured yet — running in SETUP MODE. The API serves only the setup wizard; ' +
      'trading engines stay paused until Binance keys and an admin login are configured.',
    )
    return
  }

  await startEngines()
}

// The trading engines proper — everything that needs the exchange / live market.
// Split out of start() so the first-run wizard can launch them once Binance keys
// exist, without a process restart. Idempotent (guarded by enginesStarted).
export async function startEngines(): Promise<void> {
  if (enginesStarted) return
  enginesStarted = true
  logger.info('Starting trading engines...')

  startTelegramBot()
  startNotifier()

  // Start price cache and subscribe to known coins
  priceCache.start()
  let settings = getSettings()

  // Seed watchlist with top 3 pairs if never configured by the user
  if (settings.watchlist.length === 0) {
    try {
      const top3 = (await getTopPairs(3)).filter(isTradeable)
      if (top3.length > 0) {
        await updateSetting('watchlist', JSON.stringify(top3))
        settings = getSettings()
        logger.info('Watchlist seeded from top Binance pairs', { pairs: top3 })
      }
    } catch (err) {
      logger.warn('Could not seed watchlist on startup', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  const initialCoins = [
    ...settings.watchlist,
    ...((await getOpenEntries()) as unknown as { coin: string }[]).filter(e => e.coin !== 'USDC').map(e => e.coin),
  ]
  if (initialCoins.length > 0) priceCache.subscribe([...new Set(initialCoins)])

  await entry.start(settings)

  // Re-dispatch durable LLM jobs that were still queued when the process last
  // stopped. Done after price cache + entry engine are up so any builder needing
  // live market context can run. In-flight-at-crash jobs are dropped here.
  await resumeDurableJobs()

  // Load/seed the routing graph and schedule its timer nodes (the engine
  // triggers), then start the infrastructure loops.
  await initRouting()
  startSchedulers(settings)
  fireRoutingStartup()

  // One-shot reconcile on boot: attaches to existing OCOs and re-protects any
  // open position lacking one (e.g. positions opened before exchange-side OCO).
  checkOpenPositions().catch(err =>
    logger.warn('Startup position reconcile failed', { error: err instanceof Error ? err.message : String(err) })
  )

  logger.info(`CryptoBot running. Pipeline cron: ${settings.pipeline_cron}`)
}

export async function shutdown(signal: string): Promise<void> {
  logger.info(`Shutting down (${signal})`)
  stopSchedulers()
  entry.stop()
  priceCache.stop()
  try { await closeBrowser() } catch {}
  if (server) server.close()
  await shutdownDB()
  process.exit(0)
}
