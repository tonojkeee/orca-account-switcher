// Settings parser and polling bounds for the Account Switcher worker.

export type PluginSettings = {
  pollSeconds: number
  statusClickAction: 'refresh' | 'switchBest'
  showAgyPool: boolean
  autoSwitchLowQuota: boolean
  lowQuotaThreshold: number
  oauthClientId: string
  oauthClientSecret: string
  checkUpdates: boolean
}

export const MIN_POLL_SECONDS = 600
export const DEFAULT_QUOTA_TTL_MS = 5 * 60 * 1000

export const DEFAULT_SETTINGS: PluginSettings = {
  pollSeconds: 0,
  statusClickAction: 'refresh',
  showAgyPool: true,
  autoSwitchLowQuota: false,
  lowQuotaThreshold: 5,
  oauthClientId: '',
  oauthClientSecret: '',
  checkUpdates: true
}

export function parseSettings(raw: Record<string, unknown>): PluginSettings {
  const rawPoll =
    typeof raw.pollSeconds === 'number' && Number.isFinite(raw.pollSeconds)
      ? Math.max(0, Math.min(3600, Math.round(raw.pollSeconds)))
      : DEFAULT_SETTINGS.pollSeconds
  const poll = rawPoll === 0 ? 0 : Math.max(MIN_POLL_SECONDS, rawPoll)
  const statusClickAction = raw.statusClickAction === 'switchBest' ? 'switchBest' : 'refresh'
  const showAgyPool = raw.showAgyPool !== false
  const autoSwitchLowQuota = raw.autoSwitchLowQuota === true
  const lowQuotaThreshold =
    typeof raw.lowQuotaThreshold === 'number' && Number.isFinite(raw.lowQuotaThreshold)
      ? Math.max(1, Math.min(50, Math.round(raw.lowQuotaThreshold)))
      : DEFAULT_SETTINGS.lowQuotaThreshold
  return {
    pollSeconds: poll,
    statusClickAction,
    showAgyPool,
    autoSwitchLowQuota,
    lowQuotaThreshold,
    oauthClientId: typeof raw.oauthClientId === 'string' ? raw.oauthClientId.trim() : '',
    oauthClientSecret: typeof raw.oauthClientSecret === 'string' ? raw.oauthClientSecret.trim() : '',
    checkUpdates: raw.checkUpdates !== false
  }
}
