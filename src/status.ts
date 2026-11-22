// Pure status-bar summary formatter for Account Switcher.
import type { AccountsSnapshot } from './protocol'

export type StatusBarState = {
  text: string
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  tooltip: string
}

function shortEmail(emailOrLabel: string): string {
  const at = emailOrLabel.indexOf('@')
  const base = at > 0 ? emailOrLabel.slice(0, at) : emailOrLabel
  return base.length > 18 ? `${base.slice(0, 17)}…` : base
}

function toneForRemaining(pct: number | null): StatusBarState['tone'] {
  if (pct === null) return 'neutral'
  if (pct >= 50) return 'success'
  if (pct >= 15) return 'warning'
  return 'danger'
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`
}

/** Build the compact status bar badge + multi-provider tooltip from the latest snapshot. */
export function buildStatusBarState(snapshot: AccountsSnapshot): StatusBarState {
  const lines: string[] = []
  let primaryName: string | null = null
  let primaryPct: number | null = null

  if (snapshot.agyPool.available && snapshot.agyPool.activeEmail) {
    const active = snapshot.agyPool.accounts.find(
      (a) => a.email.toLowerCase() === snapshot.agyPool.activeEmail?.toLowerCase()
    )
    primaryName = shortEmail(snapshot.agyPool.activeEmail)
    primaryPct = active?.effectiveGemini ?? null
    const pctText = primaryPct === null ? '?' : `${Math.round(primaryPct)}%`
    lines.push(`AGY Pool: ${snapshot.agyPool.activeEmail} (${pctText})`)
  }

  for (const p of snapshot.providers) {
    const active = p.accounts.find((a) => a.active)
    if (active) {
      if (!primaryName) {
        primaryName = shortEmail(active.email ?? active.label)
        primaryPct = active.effectiveRemaining
      }
      const pctText = active.effectiveRemaining === null ? '' : ` (${active.effectiveRemaining}%)`
      lines.push(`${p.title}: ${active.label}${pctText}`)
    } else if (p.supportsSystemDefault && p.systemDefaultLabel) {
      lines.push(`${p.title}: ${p.systemDefaultLabel}`)
    }
  }

  if (!primaryName) {
    return {
      text: 'Accounts',
      tone: snapshot.orcaError ? 'warning' : 'neutral',
      tooltip: truncate(snapshot.orcaError ?? 'Account Switcher: no active managed account', 256)
    }
  }

  const label = primaryPct === null ? primaryName : `${primaryName} · ${Math.round(primaryPct)}%`
  const tooltip = lines.length > 0 ? lines.join(' | ') : 'Account Switcher'
  return {
    text: truncate(label, 64),
    tone: toneForRemaining(primaryPct),
    tooltip: truncate(tooltip, 256)
  }
}
