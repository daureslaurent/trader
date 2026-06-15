// Host self-update bridge. The backend runs inside a container, but the update
// itself (`update_run.sh`: git pull + `docker compose down/up --build`) must run
// on the *host*, because it tears down and rebuilds this very container — a
// process can't reliably kill its own container and survive to bring it back.
//
// We decouple the two: this module never runs docker or git. It only drops a
// small trigger file into a bind-mounted directory. A host-side systemd watcher
// (installed via tools/updater/install-updater.sh) sees the file appear and runs
// update_run.sh. Because the watcher lives on the host, `docker compose down`
// can't kill it. No Docker socket is exposed to the container.
import fs from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import path from 'node:path'

// Bind-mounted in docker-compose as ./.update -> /app/.update. Override with
// UPDATE_TRIGGER_DIR for non-Docker / custom layouts.
const TRIGGER_DIR = process.env.UPDATE_TRIGGER_DIR || '/app/.update'
const TRIGGER_FILE = path.join(TRIGGER_DIR, 'trigger')

export interface UpdateReadiness {
  /** True when the trigger directory is mounted and writable. */
  ready: boolean
  /** Human-readable reason when not ready (for a Settings-page hint). */
  reason?: string
}

// Whether dropping a trigger would actually reach the host. A false here almost
// always means the ./.update bind mount is missing from docker-compose, so the
// button would silently do nothing — we surface that to the UI instead.
export async function getUpdateReadiness(): Promise<UpdateReadiness> {
  try {
    await fs.access(TRIGGER_DIR, FS.W_OK)
    return { ready: true }
  } catch {
    return { ready: false, reason: `trigger directory ${TRIGGER_DIR} is not mounted or not writable` }
  }
}

// Signal the host watcher to update. The file content is informational only —
// the watcher triggers on the file's existence and removes it before running.
export async function requestUpdate(meta: { by?: string } = {}): Promise<void> {
  await fs.mkdir(TRIGGER_DIR, { recursive: true })
  const payload = JSON.stringify({ requestedAt: new Date().toISOString(), by: meta.by ?? 'web' })
  await fs.writeFile(TRIGGER_FILE, payload + '\n', 'utf8')
}
