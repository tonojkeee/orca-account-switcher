// OAuth and import action handlers extracted from worker to maintain token limit discipline.
import type { OrcaWorkerApi } from 'orca/worker'
import { warmAgyTokenCache, type QuotaFetcher } from './agy-pool'
import { readCurrentAgyLogin, type AgyStoredToken } from './keyring'
import {
  exchangeAuthorizationCode,
  parseCallbackInput,
  resolveImportedAgyIdentity,
  startLoopbackOAuthFlow,
  type OAuthClientConfig,
  type PendingOAuthFlow
} from './oauth'
import type { PlatformKind, PlatformPaths } from './platform'
import type { AccountsSnapshot, OAuthStartResult, SwitchResult } from './protocol'
import { saveVaultAccount } from './vault'

export type OAuthHelperDeps = {
  orca: OrcaWorkerApi
  paths: PlatformPaths
  platform: PlatformKind
  fetcher?: QuotaFetcher
  getOAuthCandidates: () => OAuthClientConfig[]
  getOAuthClient: () => OAuthClientConfig | null
  readCurrentLogin?: () => Promise<AgyStoredToken | null>
  performAgySwitch: (email: string) => Promise<SwitchResult>
  loadSnapshot: (refresh?: boolean, force?: boolean) => Promise<AccountsSnapshot>
  getLatestSnapshot: () => AccountsSnapshot | null
  clearRecentlyDeleted?: (email: string) => void
}

export async function importCurrentAgyLogin(
  deps: OAuthHelperDeps
): Promise<SwitchResult> {
  const currentLogin = deps.readCurrentLogin
    ? await deps.readCurrentLogin()
    : await readCurrentAgyLogin(deps.paths, deps.platform)
  if (!currentLogin) {
    const snapshot = deps.getLatestSnapshot() ?? (await deps.loadSnapshot(false))
    return {
      ok: false,
      message: 'No active agy / Gemini login found on this machine. Use "+ Add Google Account" to sign in.',
      snapshot
    }
  }

  const { email, name, warmedToken } = await resolveImportedAgyIdentity(
    currentLogin,
    deps.getOAuthCandidates(),
    deps.fetcher
  )

  if (!email) {
    const snapshot = deps.getLatestSnapshot() ?? (await deps.loadSnapshot(false))
    return {
      ok: false,
      message: 'Found an agy token, but could not determine its email. Use "+ Add Google Account" instead.',
      snapshot
    }
  }

  if (warmedToken) {
    warmAgyTokenCache(email, currentLogin.refreshToken, warmedToken.accessToken, warmedToken.expiresIn)
  }

  const { storedInKeyring } = await saveVaultAccount(deps.orca, {
    email,
    name,
    refreshToken: currentLogin.refreshToken,
    source: 'imported'
  })
  deps.clearRecentlyDeleted?.(email)
  const snapshot = await deps.loadSnapshot(true, true)
  const suffix = storedInKeyring ? '' : ' (OS keyring unavailable; stored in plugin storage)'
  return { ok: true, message: `Imported ${email} into AGY Vault${suffix}`, snapshot }
}

export async function beginGoogleOAuthSession(
  deps: OAuthHelperDeps,
  currentFlow: PendingOAuthFlow | null,
  onCompleted: (flow: PendingOAuthFlow | null) => void
): Promise<{ flow: PendingOAuthFlow; startResult: OAuthStartResult }> {
  const client = deps.getOAuthClient()
  if (!client) {
    throw Object.assign(
      new Error(
        'Google OAuth Client ID/Secret not found. Sign into Orca Chat once, install agy CLI, or set custom OAuth credentials in Settings.'
      ),
      { code: 'unavailable' }
    )
  }
  currentFlow?.close()
  let nextFlow: PendingOAuthFlow | null = null
  nextFlow = await startLoopbackOAuthFlow(
    client,
    async (outcome) => {
      onCompleted(null)
      if (!outcome.ok) {
        const snapshot = deps.getLatestSnapshot() ?? (await deps.loadSnapshot(false))
        deps.orca.panels.post('oauth.completed', { ok: false, message: outcome.error, snapshot })
        return
      }
      await saveVaultAccount(deps.orca, {
        email: outcome.account.email,
        name: outcome.account.name,
        refreshToken: outcome.account.refreshToken,
        source: 'oauth'
      })
      deps.clearRecentlyDeleted?.(outcome.account.email)
      const switched = await deps.performAgySwitch(outcome.account.email)
      deps.orca.panels.post('oauth.completed', {
        ok: switched.ok,
        message: `Connected & activated ${outcome.account.email}`,
        snapshot: switched.snapshot
      })
    },
    deps.fetcher
  )
  return {
    flow: nextFlow,
    startResult: { authUrl: nextFlow.authUrl, redirectUri: nextFlow.redirectUri }
  }
}

export async function completeGoogleOAuthManualSession(
  deps: OAuthHelperDeps,
  flow: PendingOAuthFlow | null,
  callbackOrCode: string
): Promise<SwitchResult> {
  if (!flow) {
    const snapshot = await deps.loadSnapshot(false)
    return { ok: false, message: 'No active Google sign-in session. Click "+ Add Google Account" first.', snapshot }
  }
  const { code } = parseCallbackInput(callbackOrCode, flow.state)
  const account = await exchangeAuthorizationCode(
    { client: flow.client, code, redirectUri: flow.redirectUri, codeVerifier: flow.codeVerifier },
    deps.fetcher
  )
  flow.close()
  await saveVaultAccount(deps.orca, {
    email: account.email,
    name: account.name,
    refreshToken: account.refreshToken,
    source: 'oauth'
  })
  deps.clearRecentlyDeleted?.(account.email)
  const switched = await deps.performAgySwitch(account.email)
  return { ok: switched.ok, message: `Connected & activated ${account.email}`, snapshot: switched.snapshot }
}
