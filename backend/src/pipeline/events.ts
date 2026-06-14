import { pipelineEvents, nowSql } from '../db/index.js'
import { broadcast } from '../api/ws.js'
import { logger } from '../core/logger.js'
import { PipelineStage } from '../types.js'

/** Persist a pipeline-stage event and broadcast it live to the frontend.
 *  Telemetry-grade and mostly called fire-and-forget, so a transient DB error
 *  is logged and swallowed rather than surfacing as an unhandled rejection. */
export async function logPipelineEvent(
  stage: PipelineStage,
  coin: string,
  cycleId: string,
  data: Record<string, unknown>
): Promise<void> {
  const payload = JSON.stringify(data)
  const created_at = nowSql()
  try {
    const id = await pipelineEvents.insert({
      coin, cycle_id: cycleId, stage, data: payload, created_at,
    })
    broadcast('pipeline_event', { id, coin, cycle_id: cycleId, stage, data: payload, created_at })
  } catch (err) {
    logger.warn('Failed to persist pipeline event', { stage, coin, error: err instanceof Error ? err.message : String(err) })
  }
}
