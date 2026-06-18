import { AsyncLocalStorage } from 'node:async_hooks'
import OpenAI from 'openai'
import { llmChat, endpointGate, type LLMTarget, type LLMCallMeta } from './llm.js'
import { broadcast } from '../api/ws.js'
import { logger } from './logger.js'
import { llmJobs, nowSql, getSettings } from '../db/index.js'

/**
 * Central LLM scheduler — the single front door every module funnels its chat
 * completions through. It sits *above* `llmChat` (which stays the execution
 * primitive) and adds four things the bare per-URL gate could not:
 *
 *  1. JIT data binding — a job carries a `build(route)` thunk, not a finished
 *     prompt. The thunk runs at the moment of dispatch, so context (order book,
 *     candles, live indicators) is fetched fresh and is never stale from sitting in
 *     a queue. The endpoint/model is likewise re-resolved at dispatch via `route()`.
 *
 *  2. Lane concurrency — the `analyse` lane is serialized (limit 1) while every
 *     other pipeline runs on the `parallel` lane. Lanes admit jobs; they do not
 *     hold endpoint permits, so a serialized analyse job blocking on a busy
 *     endpoint can never deadlock a parallel one.
 *
 *  3. Model-aware ordering — when several jobs contend for the same physical gate
 *     (a serialized one-server endpoint serving multiple models), the scheduler
 *     prefers the model already resident on that server, batching same-model runs
 *     to avoid llama.cpp reloads. Dormant when each endpoint serves one fixed model
 *     (its gate key includes the model, so there is never cross-model contention).
 *     A per-gate anti-starvation cap forces a switch after N consecutive same-model
 *     dispatches so a cold model can never be starved.
 *
 *  4. Durable resume — a job flagged `durable` persists a serializable descriptor
 *     to `llm_jobs`; on restart, still-`queued` rows are rebuilt from the builder
 *     registry and re-dispatched (their fresh context is re-fetched by the builder,
 *     since closures cannot be serialized). In-flight-at-crash jobs are dropped and
 *     re-driven by the owning cron cycle.
 *
 * The dispatcher is event-driven: it is pumped on enqueue and on completion only —
 * never on a timer.
 */

export type Lane = 'analyse' | 'parallel'

/** Concrete endpoint a job will run against. Structurally satisfied by `ResolvedLLM`. */
export interface LLMRoute {
  client: OpenAI
  model: string
  baseURL: string
  maxTokens: number
  fallback?: LLMTarget
}

export interface ScheduleSpec {
  /** Module name for logging / `llm_calls` attribution. */
  module: string
  lane: Lane
  /** Higher dispatches sooner. Defaults: parallel=0, analyse=0. Use >0 to jump the queue (e.g. monitor exits). */
  priority?: number
  coin?: string | null
  cycleId?: string | null
  /**
   * Cheap, synchronous endpoint resolution (a settings lookup + memoized client).
   * Called both for affinity ordering while queued AND again at dispatch, so a
   * Settings change applies live. Typically `() => resolveLLM('analyst')`.
   */
  route: () => LLMRoute
  /** JIT: builds the concrete request at dispatch time using the resolved route. */
  build: (route: LLMRoute) => Promise<OpenAI.ChatCompletionCreateParams>
  /**
   * Marks the job resumable across restarts. The builder must be pre-registered via
   * `registerBuilder(builderId, …)`; `args` is the serializable input replayed to it
   * on resume. Durable jobs are fire-and-forget — their builder owns any persistence
   * of the result, since the original awaiting caller is gone after a restart.
   */
  durable?: { builderId: string; args: Record<string, unknown> }
}

// ── Lane limits ───────────────────────────────────────────────────────────────
// analyse is sequential by mandate; the parallel ceiling is a sanity bound on
// total fan-out (endpoint gates do the real per-server throttling beneath it).
const PARALLEL_LIMIT = Number(process.env.LLM_SCHEDULER_PARALLEL) > 0
  ? Number(process.env.LLM_SCHEDULER_PARALLEL)
  : 16
const LANE_LIMIT: Record<Lane, number> = { analyse: 1, parallel: PARALLEL_LIMIT }

// After this many consecutive same-model dispatches on one gate, the next pick
// stops preferring the resident model so a waiting cold model is not starved.
const STARVATION_CAP = Number(process.env.LLM_SCHEDULER_AFFINITY_CAP) > 0
  ? Number(process.env.LLM_SCHEDULER_AFFINITY_CAP)
  : 8

interface Job {
  id: string
  spec: ScheduleSpec
  seq: number
  enqueuedAt: number
  resolve: (r: OpenAI.ChatCompletion) => void
  reject: (e: unknown) => void
  /** Whether a persisted `llm_jobs` row exists for this job (durable). */
  durable: boolean
  /**
   * The agentic session this call belongs to, if any (captured from AsyncLocalStorage at
   * enqueue, so a tool's nested call inherits its parent loop's session). A leased gate is
   * reserved for its owning session; session jobs are never blocked by a lease.
   */
  sessionId?: string
}

const _waiting: Job[] = []
const _laneActive: Record<Lane, number> = { analyse: 0, parallel: 0 }
const _gateActive = new Map<string, number>()
const _residentModel = new Map<string, string>()
const _sameModelStreak = new Map<string, number>()
let _seq = 0

// ── Session leases ───────────────────────────────────────────────────────────
// A multi-round agentic loop (entry agent, agent signal, type-D monitor, chat agent) runs
// as a *session*: it opens with runInSession() and keeps the SAME endpoint busy across all
// its rounds AND the nested LLM calls its tools make (e.g. get_coin_sentiment runs the
// extractor). Without this, the per-round gate permit is released between rounds and an
// unrelated module's call slips onto the same one-slot server, forcing a model swap / full
// context re-ingest mid-session — the thrash that surfaces as "Premature close".
//
// A session takes an EXCLUSIVE lease on its primary endpoint's gate for its whole lifetime.
// While a gate is leased, pickNext() will not dispatch any NON-session job to it; the
// session's own calls — tracked via AsyncLocalStorage, so a tool's nested call inherits the
// parent loop's session — flow normally (still bounded by the gate's permit limit). The
// lease is acquired EAGERLY at session start while the session holds nothing else, so a
// session never waits on a lease while owning one → no deadlock. Sessions on *different*
// endpoints run concurrently (the lease is per gate, not global). A different session's
// nested call into a leased gate is allowed through rather than blocked — that keeps two
// concurrent sessions deadlock-free; the rare cross-session swap it permits is harmless.
interface SessionCtx { id: string }
const _sessionStore = new AsyncLocalStorage<SessionCtx>()
const _gateLeaseOwner = new Map<string, string>()                                   // gateKey → owning sessionId
const _gateLeaseWaiters = new Map<string, { sessionId: string; resolve: () => void }[]>()

function currentSessionId(): string | undefined {
  return _sessionStore.getStore()?.id
}

// Acquire the exclusive lease for `gateKey` for `sessionId`, FIFO. Resolves immediately if
// the gate is free or already owned by this session (re-entrant); otherwise queues.
function acquireLease(gateKey: string, sessionId: string): Promise<void> {
  const owner = _gateLeaseOwner.get(gateKey)
  if (owner === undefined) { _gateLeaseOwner.set(gateKey, sessionId); return Promise.resolve() }
  if (owner === sessionId) return Promise.resolve()
  return new Promise<void>(resolve => {
    const q = _gateLeaseWaiters.get(gateKey) ?? []
    q.push({ sessionId, resolve })
    _gateLeaseWaiters.set(gateKey, q)
  })
}

// Release the lease, handing it to the next FIFO waiter if any, else clearing it. A freed
// gate may unblock queued non-session jobs, so re-pump.
function releaseLease(gateKey: string): void {
  const q = _gateLeaseWaiters.get(gateKey)
  const next = q?.shift()
  if (next) {
    _gateLeaseOwner.set(gateKey, next.sessionId)
    if (q && q.length === 0) _gateLeaseWaiters.delete(gateKey)
    next.resolve()
  } else {
    _gateLeaseOwner.delete(gateKey)
    _gateLeaseWaiters.delete(gateKey)
  }
  pump()
}

/**
 * Run an agentic, multi-round LLM loop as a session that holds its primary endpoint
 * exclusively for its whole lifetime. `route()` resolves that primary endpoint (the same
 * resolver the loop's scheduleChat calls use). Nested LLM calls made inside `fn` — including
 * those a tool issues — inherit the session via AsyncLocalStorage and run re-entrantly,
 * while every OTHER module's call to that endpoint waits until the session ends. A session
 * that can't resolve a gated endpoint simply runs without a lease.
 */
export async function runInSession<T>(opts: { route: () => LLMRoute }, fn: () => Promise<T>): Promise<T> {
  const id = `sess_${Date.now().toString(36)}_${(_seq++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  let leasedKey: string | null = null
  try {
    const r = opts.route()
    const gate = endpointGate(r.baseURL, r.model)
    if (gate) { await acquireLease(gate.key, id); leasedKey = gate.key }
  } catch (err) {
    logger.warn('Session lease skipped — route() failed', { error: (err as Error).message })
  }
  try {
    return await _sessionStore.run({ id }, fn)
  } finally {
    if (leasedKey) releaseLease(leasedKey)
  }
}

// ── Recent-activity history (so a reloaded Control Room rebuilds, not blanks) ────
// The scheduler is the source of truth for live LLM flow; the page is a thin view of
// it. Without these, a page reload loses the feed, the per-endpoint timeline, the swap
// count and the in-flight chips (they lived only in the browser's WS-fed state) until
// new events trickle in. These rings let `getSchedulerState()` replay recent history
// on load. Retention is TIME-based (control_room_retain_hours, ~3h) so the page shows a
// real scrollback window rather than a fixed item count; hard caps below just bound
// memory against a runaway burst. In-memory only: this is live operational telemetry,
// not a durable record — the `llm_jobs` table already covers job resume across restarts.
type JobState = 'queued' | 'dispatching' | 'running' | 'done' | 'error'
interface ActiveJob { id: string; module: string; lane: Lane; coin: string | null; model: string; url: string; state: 'dispatching' | 'running'; at: number }
interface FeedRecord { id: string; text: string; kind: JobState | 'swap'; at: number }
// One entry per dispatch, carrying its real wall-clock span (`at` → `endAt`). Grouped
// by `url` into per-endpoint Gantt timelines: each call renders as a segment whose width
// is its duration, coloured by model. `endAt` is null while the call is still running.
interface DispatchRecord {
  id: string
  url: string
  model: string
  coin: string | null
  module: string
  at: number              // call start (ms epoch)
  endAt: number | null    // call end; null while in flight
  state: 'running' | 'done' | 'error'
}

const MAX_FEED = 1000        // safety cap; time-based retention is the real bound
const MAX_DISPATCHES = 5000

const _active = new Map<string, ActiveJob>()   // currently dispatching/running jobs
const _feed: FeedRecord[] = []                 // newest-first
const _dispatches: DispatchRecord[] = []       // oldest-first; the per-endpoint timeline
let _swapTotal = 0                             // total swaps since start (survives pruning)
let _feedSeq = 0
let _dispatchSeq = 0

const coinShort = (coin: string | null): string => (coin ? coin.replace('/USDC', '') : '')

// Retention window for the Control Room's history, in ms, from settings (hours).
function retentionMs(): number {
  const h = getSettings().control_room_retain_hours
  return (Number.isFinite(h) && h > 0 ? h : 3) * 3_600_000
}

// Drop history older than the retention window (and enforce the memory safety caps).
// _feed is newest-first so stale entries sit at the tail; _dispatches is oldest-first.
function pruneHistory(): void {
  const cutoff = Date.now() - retentionMs()
  while (_dispatches.length && _dispatches[0].at < cutoff) _dispatches.shift()
  if (_dispatches.length > MAX_DISPATCHES) _dispatches.splice(0, _dispatches.length - MAX_DISPATCHES)
  while (_feed.length && _feed[_feed.length - 1].at < cutoff) _feed.pop()
  if (_feed.length > MAX_FEED) _feed.length = MAX_FEED
}

function recordFeed(text: string, kind: JobState | 'swap'): void {
  _feed.unshift({ id: `feed_${_feedSeq++}`, text, kind, at: Date.now() })
  pruneHistory()
}

// Open a dispatch record at call start and return its id; `endDispatch` closes it when
// the call resolves/rejects, stamping the real duration the Gantt timeline renders.
function recordDispatch(url: string, model: string, coin: string | null, module: string): string {
  const id = `disp_${_dispatchSeq++}`
  _dispatches.push({ id, url, model, coin, module, at: Date.now(), endAt: null, state: 'running' })
  pruneHistory()
  return id
}

function endDispatch(id: string, state: 'done' | 'error'): void {
  // Scan from the tail — a just-finished call is almost always among the newest records.
  for (let i = _dispatches.length - 1; i >= 0; i--) {
    if (_dispatches[i].id === id) {
      _dispatches[i].endAt = Date.now()
      _dispatches[i].state = state
      return
    }
  }
}

// Collapse a base URL (optionally a gate key with ::model) to a readable host.
function shortHost(key: string): string {
  const [url, model] = key.split('::')
  let host = url
  try { host = new URL(url).host } catch { /* keep raw */ }
  return model ? `${host} · ${model}` : host
}

// Builder registry for durable resume. id → builder that rebuilds the request from
// the persisted args at dispatch (fresh JIT context fetched inside).
type Builder = (args: Record<string, unknown>, route: LLMRoute) => Promise<OpenAI.ChatCompletionCreateParams>
const _builders = new Map<string, () => LLMRoute>()
const _builderFns = new Map<string, Builder>()

/** Register a durable job's route + builder so persisted jobs can be resumed after a restart. */
export function registerBuilder(builderId: string, route: () => LLMRoute, build: Builder): void {
  _builders.set(builderId, route)
  _builderFns.set(builderId, build)
}

function defaultPriority(spec: ScheduleSpec): number {
  return spec.priority ?? 0
}

/** A monotonic id that is also a usable Mongo `_id` for the durable row. */
function newJobId(): string {
  return `job_${Date.now().toString(36)}_${(_seq).toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Snapshot for the Control Room's initial render / debugging. Beyond the live
 * lane/gate/queue occupancy it replays the recent-activity history (active chips, feed,
 * and the per-endpoint dispatch timeline) so a freshly-loaded or reloaded page rebuilds
 * its full view instead of starting empty. Ages are returned as `agoMs` (ms elapsed)
 * rather than absolute timestamps so the client reconstructs wall-clock times against
 * its own clock. `endpoints[]` is the timeline grouped by base URL — one bar per URL —
 * each carrying its calls as duration spans (`startAgoMs` + `durationMs`), rendered as a
 * Gantt strip where a segment's width is the real call length and its colour is the model.
 */
export function getSchedulerState() {
  pruneHistory()
  const now = Date.now()

  // Per-endpoint Gantt timeline: each call is a span with a real start offset and
  // duration. `startAgoMs` is ms elapsed since the call began; `durationMs` is its
  // wall-clock length (extended to `now` while still running) — the client positions
  // and sizes each segment from these against its own clock.
  const byUrl = new Map<string, { url: string; calls: { model: string; coin: string | null; module: string; startAgoMs: number; durationMs: number; state: 'running' | 'done' | 'error' }[] }>()
  for (const d of _dispatches) {
    let g = byUrl.get(d.url)
    if (!g) { g = { url: d.url, calls: [] }; byUrl.set(d.url, g) }
    const end = d.endAt ?? now
    g.calls.push({
      model: d.model,
      coin: d.coin,
      module: d.module,
      startAgoMs: now - d.at,
      durationMs: Math.max(0, end - d.at),
      state: d.state,
    })
  }
  const endpoints = Array.from(byUrl.values())
    .map(g => ({
      url: g.url,
      host: shortHost(g.url),
      residentModel: g.calls.length ? g.calls[g.calls.length - 1].model : null,
      active: Array.from(_active.values()).filter(a => a.url === g.url).length,
      calls: g.calls,
    }))
    .sort((a, b) => a.url.localeCompare(b.url))

  return {
    lanes: { analyse: { active: _laneActive.analyse, limit: LANE_LIMIT.analyse }, parallel: { active: _laneActive.parallel, limit: LANE_LIMIT.parallel } },
    queueDepth: _waiting.length,
    retainHours: getSettings().control_room_retain_hours,
    gates: Array.from(_gateActive.entries()).map(([key, active]) => ({ key, active, residentModel: _residentModel.get(key) ?? null, streak: _sameModelStreak.get(key) ?? 0 })),
    leases: Array.from(_gateLeaseOwner.entries()).map(([key, sessionId]) => ({ key, host: shortHost(key), sessionId, waiting: _gateLeaseWaiters.get(key)?.length ?? 0 })),
    waiting: _waiting.map(j => ({ id: j.id, module: j.spec.module, lane: j.spec.lane, coin: j.spec.coin ?? null, priority: defaultPriority(j.spec), waitedMs: now - j.enqueuedAt })),
    active: Array.from(_active.values()).map(a => ({ id: a.id, module: a.module, lane: a.lane, coin: a.coin, model: a.model, state: a.state, agoMs: now - a.at })),
    feed: _feed.map(f => ({ id: f.id, text: f.text, kind: f.kind, agoMs: now - f.at })),
    endpoints,
    swapCount: _swapTotal,
  }
}

/**
 * Enqueue an LLM chat completion. Resolves with the `ChatCompletion` once the job
 * is dispatched and `llmChat` returns. The job's prompt is NOT built until dispatch.
 */
export function scheduleChat(spec: ScheduleSpec): Promise<OpenAI.ChatCompletion> {
  return new Promise<OpenAI.ChatCompletion>((resolve, reject) => {
    void enqueue(spec, resolve, reject)
  })
}

async function enqueue(
  spec: ScheduleSpec,
  resolve: (r: OpenAI.ChatCompletion) => void,
  reject: (e: unknown) => void,
  existingId?: string,
): Promise<void> {
  const id = existingId ?? newJobId()
  // Captured synchronously here so a tool's nested scheduleChat (run inside its parent
  // loop's _sessionStore.run scope) is tagged with that session; a durable resume at
  // startup runs outside any session and so is untagged.
  const sessionId = currentSessionId()
  const job: Job = { id, spec, seq: _seq++, enqueuedAt: Date.now(), resolve, reject, durable: !!spec.durable, sessionId }

  if (spec.durable && !existingId) {
    try {
      await llmJobs.upsert(id, {
        _id: id, id, builder_id: spec.durable.builderId, args: JSON.stringify(spec.durable.args),
        module: spec.module, lane: spec.lane, priority: defaultPriority(spec),
        coin: spec.coin ?? null, cycle_id: spec.cycleId ?? null,
        status: 'queued', created_at: nowSql(),
      })
    } catch (err) {
      logger.warn('Failed to persist durable LLM job', { id, error: (err as Error).message })
    }
  }

  _waiting.push(job)
  let model = ''
  let baseURL = ''
  try { const r = spec.route(); model = r.model; baseURL = r.baseURL } catch { /* resolved again at pick */ }
  broadcast('llm_job_enqueued', {
    id, module: spec.module, lane: spec.lane, priority: defaultPriority(spec),
    coin: spec.coin ?? null, cycle_id: spec.cycleId ?? null, model, base_url: baseURL,
    queue_depth: _waiting.length, created_at: nowSql(),
  })
  recordFeed(`${spec.module}${spec.coin ? ` · ${coinShort(spec.coin)}` : ''} queued`, 'queued')
  pump()
}

// Choose the next dispatchable job: highest priority, then model-affinity (prefer
// the model resident on its gate, unless that gate is in starvation cool-off), then
// FIFO. Returns null when nothing can run without exceeding a lane or gate limit.
function pickNext(): { job: Job; route: LLMRoute; gateKey: string | null } | null {
  let best: { job: Job; route: LLMRoute; gateKey: string | null; pr: number; aff: number } | null = null

  for (const job of _waiting) {
    if (_laneActive[job.spec.lane] >= LANE_LIMIT[job.spec.lane]) continue

    let route: LLMRoute
    try { route = job.spec.route() } catch (err) { logger.warn('Job route() threw — skipping this pass', { id: job.id, error: (err as Error).message }); continue }

    const gate = endpointGate(route.baseURL, route.model)
    const gateKey = gate?.key ?? null
    // A leased gate is reserved for its owning session: hold back every NON-session call
    // until the lease is released so an agentic loop's endpoint isn't swapped mid-session.
    // Session jobs (sessionId set) flow regardless — they're either the owner or a harmless
    // cross-session nested call — still bounded by the gate permit limit below.
    if (gateKey && !job.sessionId && _gateLeaseOwner.has(gateKey)) continue
    if (gate && (_gateActive.get(gate.key) ?? 0) >= gate.limit) continue

    const pr = defaultPriority(job.spec)
    // Affinity is suppressed once a gate has run its resident model STARVATION_CAP
    // times in a row, so a different waiting model gets its turn.
    const resident = gateKey ? _residentModel.get(gateKey) : undefined
    const streak = gateKey ? (_sameModelStreak.get(gateKey) ?? 0) : 0
    const aff = gateKey && resident === route.model && streak < STARVATION_CAP ? 1 : 0

    if (!best || pr > best.pr || (pr === best.pr && aff > best.aff)) {
      best = { job, route, gateKey, pr, aff }
    }
    // FIFO tiebreak is implicit: equal (pr, aff) keeps the earlier-seen (earlier-seq) job.
  }

  return best ? { job: best.job, route: best.route, gateKey: best.gateKey } : null
}

// Drain every job that can run right now. Synchronous selection; each dispatch is
// fired without awaiting so siblings on the parallel lane run concurrently.
function pump(): void {
  for (;;) {
    const next = pickNext()
    if (!next) break
    const idx = _waiting.indexOf(next.job)
    if (idx >= 0) _waiting.splice(idx, 1)
    void dispatch(next.job, next.route, next.gateKey)
  }
}

async function dispatch(job: Job, route: LLMRoute, gateKey: string | null): Promise<void> {
  const lane = job.spec.lane
  _laneActive[lane]++
  if (gateKey) _gateActive.set(gateKey, (_gateActive.get(gateKey) ?? 0) + 1)

  // Track model residency + emit a swap marker when the resident model changes on a
  // shared gate. This is the visible signal that batching is (or isn't) working.
  if (gateKey) {
    const prev = _residentModel.get(gateKey)
    if (prev === route.model) {
      _sameModelStreak.set(gateKey, (_sameModelStreak.get(gateKey) ?? 0) + 1)
    } else {
      _sameModelStreak.set(gateKey, 1)
      _residentModel.set(gateKey, route.model)
      if (prev) {
        broadcast('llm_model_swap', { gate_key: gateKey, from_model: prev, to_model: route.model, at: nowSql() })
        _swapTotal++
        recordFeed(`model swap on ${shortHost(gateKey)}: ${prev} → ${route.model}`, 'swap')
      }
    }
  }

  if (job.durable) { try { await llmJobs.update({ _id: job.id }, { status: 'running' }) } catch { /* best effort */ } }

  _active.set(job.id, { id: job.id, module: job.spec.module, lane, coin: job.spec.coin ?? null, model: route.model, url: route.baseURL, state: 'dispatching', at: Date.now() })
  broadcast('llm_job_state', {
    id: job.id, module: job.spec.module, lane, coin: job.spec.coin ?? null,
    model: route.model, base_url: route.baseURL, state: 'dispatching',
    waited_ms: Date.now() - job.enqueuedAt,
  })

  let dispatchId: string | null = null
  try {
    // JIT: build the request now, against the freshly-resolved route.
    const params = await job.spec.build(route)
    const meta: LLMCallMeta = { module: job.spec.module, coin: job.spec.coin ?? null, cycle_id: job.spec.cycleId ?? null, base_url: route.baseURL }
    const active = _active.get(job.id)
    if (active) { active.state = 'running'; active.at = Date.now() }
    dispatchId = recordDispatch(route.baseURL, route.model, job.spec.coin ?? null, job.spec.module)
    broadcast('llm_job_state', { id: job.id, module: job.spec.module, lane, coin: job.spec.coin ?? null, model: route.model, base_url: route.baseURL, state: 'running' })

    const resp = await llmChat(route.client, params, meta, route.fallback)
    if (dispatchId) endDispatch(dispatchId, 'done')
    job.resolve(resp)
    _active.delete(job.id)
    recordFeed(`${job.spec.module}${job.spec.coin ? ` · ${coinShort(job.spec.coin)}` : ''} done`, 'done')
    broadcast('llm_job_state', { id: job.id, module: job.spec.module, lane, coin: job.spec.coin ?? null, state: 'done' })
  } catch (err) {
    if (dispatchId) endDispatch(dispatchId, 'error')
    job.reject(err)
    _active.delete(job.id)
    recordFeed(`${job.spec.module}${job.spec.coin ? ` · ${coinShort(job.spec.coin)}` : ''} error: ${(err as Error).message}`, 'error')
    broadcast('llm_job_state', { id: job.id, module: job.spec.module, lane, coin: job.spec.coin ?? null, state: 'error', error: (err as Error).message })
  } finally {
    _laneActive[lane]--
    if (gateKey) {
      const n = (_gateActive.get(gateKey) ?? 1) - 1
      if (n <= 0) _gateActive.delete(gateKey); else _gateActive.set(gateKey, n)
    }
    if (job.durable) { try { await llmJobs.deleteOne({ _id: job.id }) } catch { /* best effort */ } }
    pump()
  }
}

/**
 * Resume durable jobs persisted before a restart. Called once at startup after the
 * builder registry is populated. Jobs left `queued` are rebuilt and re-dispatched;
 * `running` rows were in flight at crash — they are dropped, and the owning cron
 * cycle re-drives that work. Resumed jobs are fire-and-forget (no caller to await).
 */
export async function resumeDurableJobs(): Promise<void> {
  let rows: { _id: string; builder_id: string; args: string; status: string; module: string; lane: string; priority: number; coin: string | null; cycle_id: string | null }[] = []
  try {
    rows = (await llmJobs.find({})) as unknown as typeof rows
  } catch (err) {
    logger.warn('Could not read durable LLM jobs for resume', { error: (err as Error).message })
    return
  }

  let resumed = 0
  let dropped = 0
  for (const row of rows) {
    if (row.status === 'running') {
      try { await llmJobs.deleteOne({ _id: row._id }) } catch { /* ignore */ }
      dropped++
      continue
    }
    const routeFn = _builders.get(row.builder_id)
    const buildFn = _builderFns.get(row.builder_id)
    if (!routeFn || !buildFn) {
      logger.warn('Durable LLM job has no registered builder — dropping', { id: row._id, builder_id: row.builder_id })
      try { await llmJobs.deleteOne({ _id: row._id }) } catch { /* ignore */ }
      dropped++
      continue
    }
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(row.args) } catch { /* keep empty */ }
    const spec: ScheduleSpec = {
      module: row.module, lane: (row.lane === 'analyse' ? 'analyse' : 'parallel'),
      priority: row.priority, coin: row.coin, cycleId: row.cycle_id,
      route: routeFn,
      build: (route) => buildFn(args, route),
      durable: { builderId: row.builder_id, args },
    }
    // Re-enqueue under the persisted id (no new row written) with no-op handlers.
    await enqueue(spec, () => {}, (err) => logger.warn('Resumed durable job failed', { id: row._id, error: (err as Error).message }), row._id)
    resumed++
  }
  if (resumed || dropped) logger.info('Durable LLM jobs resumed', { resumed, dropped })
}
