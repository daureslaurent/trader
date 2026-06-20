import { APP_VERSION, APP_BUILD, APP_DATE } from '../../version'

/**
 * Subtle, modern version chip shown in the sidebar footer.
 * The version auto-bumps on every commit (see scripts/bump-version.mjs).
 */
export function VersionBadge() {
  return (
    <div
      className="group relative mt-2 flex items-center justify-center"
      title={`Build ${APP_BUILD} · ${APP_DATE}`}
    >
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-elevated/60 border border-border text-[10px] font-medium text-muted transition-colors hover:text-foreground hover:border-accent/40">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-gradient-to-br from-accent to-accent2 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-gradient-to-br from-accent to-accent2" />
        </span>
        <span className="font-mono tracking-tight">v{APP_VERSION}</span>
        <span className="text-muted/50">·</span>
        <span className="font-mono tabular-nums text-muted/70">#{APP_BUILD}</span>
      </span>
    </div>
  )
}
