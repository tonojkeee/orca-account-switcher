// Bi-directional synchronization between Orca managed Antigravity accounts and native agy CLI / ACP.
import type { OrcaWorkerApi } from 'orca/worker'
import {
  loadAgyToolsAccounts,
  mergeAgySources,
  switchAgyPoolAccount,
  type QuotaFetcher
} from './agy-pool'
import { invalidateAgyAcpSession } from './keyring'
import type { OAuthClientConfig } from './oauth'
import {
  computeOrcaLaunchLock,
  fetchOrcaAccounts,
  selectOrcaAccount,
  syncOrcaAntigravityAfterAgySwitch,
  type CommandRunner
} from './orca-cli'
import type { PlatformKind, PlatformPaths } from './platform'
import type {
  AccountsSnapshot,
  OrcaProviderState,
  PluginUpdateInfo,
  RuntimeDiagnostics
} from './protocol'
import { listVaultAccounts, saveVaultAccount } from './vault'

export { invalidateAgyAcpSession, syncOrcaAntigravityAfterAgySwitch }

export type SyncOrcaAgyOptions = {
  orca: OrcaWorkerApi
  account: string
  paths: PlatformPaths
  platform?: PlatformKind
  cliPath?: string | null
  runner?: CommandRunner
  providers?: readonly OrcaProviderState[]
  oauthClients?: readonly OAuthClientConfig[]
  fetcher?: QuotaFetcher
}

export type SyncOrcaAgyResult = {
  synced: boolean
  email: string | null
  message: string | null
}

export async function syncAgyCredentialsAfterOrcaSelect(
  options: SyncOrcaAgyOptions
): Promise<SyncOrcaAgyResult> {
  const { orca, account, paths, platform, cliPath, runner, oauthClients, fetcher } = options
  let providers = options.providers
  if (!providers || providers.length === 0) {
    const fetched = await fetchOrcaAccounts(cliPath, runner)
    if (fetched.cliFound && !fetched.error) {
      providers = fetched.providers
    }
  }

  const antigravity = providers?.find((p) => p.agent === 'antigravity')
  const matchedOrca = antigravity?.accounts.find(
    (a) => a.id === account || a.email?.toLowerCase() === account.toLowerCase()
  )
  const targetEmail = matchedOrca?.email ?? (account.includes('@') ? account : null)

  let vaultAccounts = await listVaultAccounts(orca)
  const agyToolsAccounts = loadAgyToolsAccounts(paths.agyAccountsDir)
  let stored = mergeAgySources(vaultAccounts, agyToolsAccounts)

  let match = targetEmail
    ? stored.find((a) => a.email.toLowerCase() === targetEmail.toLowerCase())
    : stored.find((a) => (a.id && a.id.toLowerCase() === account.toLowerCase()) || a.email.toLowerCase() === account.toLowerCase())

  if (!match && matchedOrca?.refreshToken) {
    const emailToSave = targetEmail ?? account
    await saveVaultAccount(orca, {
      email: emailToSave,
      name: matchedOrca.label,
      refreshToken: matchedOrca.refreshToken,
      source: 'imported'
    })
    vaultAccounts = await listVaultAccounts(orca)
    stored = mergeAgySources(vaultAccounts, agyToolsAccounts)
    match = stored.find((a) => a.email.toLowerCase() === emailToSave.toLowerCase())
  }

  if (match) {
    const switched = await switchAgyPoolAccount(match.email, {
      paths,
      platform,
      vaultAccounts,
      oauthClients,
      fetcher
    })
    invalidateAgyAcpSession(paths)
    return {
      synced: switched.ok,
      email: match.email,
      message: switched.message
    }
  }

  invalidateAgyAcpSession(paths)
  return {
    synced: false,
    email: targetEmail,
    message: null
  }
}

export type PerformAgySwitchOptions = {
  orca: OrcaWorkerApi
  email: string
  paths: PlatformPaths
  platform?: PlatformKind
  cliPath?: string | null
  runner?: CommandRunner
  providers?: readonly OrcaProviderState[]
  oauthClients?: readonly OAuthClientConfig[]
  fetcher?: QuotaFetcher
}

export async function performAgySwitchAction(
  options: PerformAgySwitchOptions
): Promise<{ ok: boolean; message: string }> {
  const { orca, email, paths, platform, cliPath, runner, oauthClients, fetcher, providers } = options
  const vaultAccounts = await listVaultAccounts(orca)
  const res = await switchAgyPoolAccount(email, {
    paths,
    platform,
    vaultAccounts,
    oauthClients,
    fetcher
  })
  let note = res.message
  if (res.ok) {
    const warning = await syncOrcaAntigravityAfterAgySwitch(email, cliPath, runner, providers ?? [])
    if (warning) note += `; ${warning}`
  }
  return { ok: res.ok, message: note }
}

export function hydrateCachedSnapshot(
  cached: AccountsSnapshot,
  liveEmail: string | null,
  freshOrca: { cliFound: boolean; providers: OrcaProviderState[]; error: string | null },
  providers: OrcaProviderState[],
  update: PluginUpdateInfo,
  diagnostics: RuntimeDiagnostics
): AccountsSnapshot {
  return {
    ...cached,
    orcaCliFound: freshOrca.cliFound || cached.orcaCliFound,
    orcaError: freshOrca.error,
    providers,
    agyPool: {
      ...cached.agyPool,
      activeEmail: liveEmail,
      accounts: cached.agyPool.accounts.map((a) => ({
        ...a,
        active: liveEmail !== null && a.email.toLowerCase() === liveEmail.toLowerCase()
      }))
    },
    diagnostics,
    update,
    orcaLaunchLock: computeOrcaLaunchLock(providers, liveEmail)
  }
}
