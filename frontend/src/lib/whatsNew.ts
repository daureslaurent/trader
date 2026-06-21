// Drives the post-update "What's new" modal.
//
// We can't fetch a changelog after an update because, by then, the app is already
// AT the new version (origin/main has nothing ahead anymore) and the backend can't
// run git. So we capture the commits being applied at the moment the user clicks
// "Update now" and stash them in localStorage. After the rebuild + reload bumps the
// baked-in build number, we detect the jump and surface the stashed changelog once.
import { UpdateCommit } from '../types'
import { APP_BUILD } from '../version'

const SEEN_KEY = 'cb:whatsnew:seenBuild'
const PENDING_KEY = 'cb:whatsnew:pending'

export interface WhatsNewData {
  fromVersion: string
  toVersion: string
  commits: UpdateCommit[]
}

/**
 * Called right before an update is triggered: remember what is about to be applied
 * so we can show it once the new build comes online.
 */
export function stashPendingUpdate(data: WhatsNewData): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(data))
  } catch {
    /* storage disabled — the modal just won't show, no harm */
  }
}

/**
 * Called once on app load. Returns the changelog to show — and only then — when the
 * baked-in build advanced past the last build we showed AND we have a stashed
 * changelog for it. Always records the current build as seen (so it never re-fires),
 * and clears the pending stash. Returns null on a first run or a plain reload.
 */
export function consumeWhatsNew(): WhatsNewData | null {
  let seen = 0
  try {
    seen = parseInt(localStorage.getItem(SEEN_KEY) || '', 10) || 0
  } catch {
    return null
  }

  // Record the current build as seen up front, regardless of outcome.
  try {
    localStorage.setItem(SEEN_KEY, String(APP_BUILD))
  } catch {
    /* ignore */
  }

  // First ever load (nothing seen yet): just bookmark, don't pop a modal.
  if (!seen || APP_BUILD <= seen) {
    try { localStorage.removeItem(PENDING_KEY) } catch { /* ignore */ }
    return null
  }

  let pending: WhatsNewData | null = null
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (raw) pending = JSON.parse(raw) as WhatsNewData
    localStorage.removeItem(PENDING_KEY)
  } catch {
    pending = null
  }

  if (!pending || !Array.isArray(pending.commits) || pending.commits.length === 0) return null
  return pending
}
