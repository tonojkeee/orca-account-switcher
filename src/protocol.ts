// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export type OrcaAgentKind = 'antigravity' | 'claude' | 'codex' | 'opencode' | 'devin'

export type QuotaBucket = {
  label: string
  remainingPercent: number
  windowMinutes: number
  resetsAt: number | null
}

export type OrcaManagedAccount = {
  id: string
  label: string
  email: string | null
  active: boolean
  needsSignIn: boolean
  buckets: QuotaBucket[]
  effectiveRemaining: number | null
}

export type OrcaProviderState = {
  agent: OrcaAgentKind
  title: string
  supportsSystemDefault: boolean
  activeAccountId: string | null
  systemDefaultLabel: string | null
  accounts: OrcaManagedAccount[]
}

export type AgyAccountSource = 'vault' | 'agy-tools' | 'both'

export type AgyPoolAccount = {
  email: string
  name: string
  source: AgyAccountSource
  active: boolean
  gemini5h: number | null
  geminiWeekly: number | null
  claude5h: number | null
  claudeWeekly: number | null
  effectiveGemini: number | null
  gemini5hResetsAt?: number | null
  geminiWeeklyResetsAt?: number | null
  error: string | null
}

export type AgyPoolState = {
  available: boolean
  oauthReady: boolean
  activeEmail: string | null
  accounts: AgyPoolAccount[]
  bestEmail: string | null
  error: string | null
}

export type RuntimeDiagnostics = {
  orcaCliPath: string | null
  agyCliPath: string | null
  agyToolsCliPath: string | null
  oauthClientSource: string | null
}

export type PluginUpdateInfo = {
  currentVersion: string
  latestVersion: string | null
  hasUpdate: boolean
  dismissed: boolean
  checkedAt: number | null
  repoUrl: string
  error: string | null
}

export type AccountsSnapshot = {
  platform: string
  orcaCliFound: boolean
  orcaError: string | null
  providers: OrcaProviderState[]
  agyPool: AgyPoolState
  diagnostics?: RuntimeDiagnostics
  update?: PluginUpdateInfo
  fetchedAt: number
}

export type SwitchResult = {
  ok: boolean
  message: string
  snapshot: AccountsSnapshot
}

export type OAuthStartResult = {
  authUrl: string
  redirectUri: string
}

declare module 'orca' {
  interface PluginRequests {
    'accounts.snapshot': { input: { refreshQuotas?: boolean; force?: boolean } | undefined; output: AccountsSnapshot }
    'accounts.selectOrca': { input: { agent: OrcaAgentKind; account: string }; output: SwitchResult }
    'accounts.selectAgyPool': { input: { email: string }; output: SwitchResult }
    'accounts.switchBestAgy': { output: SwitchResult }
    'accounts.beginGoogleOAuth': { output: OAuthStartResult }
    'accounts.completeGoogleOAuthManual': { input: { callbackOrCode: string }; output: SwitchResult }
    'accounts.cancelGoogleOAuth': { output: { ok: true } }
    'accounts.importCurrentAgy': { output: SwitchResult }
    'accounts.removeVaultAccount': { input: { email: string }; output: SwitchResult }
    'accounts.checkUpdate': { output: AccountsSnapshot }
    'accounts.dismissUpdate': { input: { version: string }; output: AccountsSnapshot }
  }
  interface PluginPanelEvents {
    'accounts.updated': AccountsSnapshot
    'oauth.completed': SwitchResult
  }
}
