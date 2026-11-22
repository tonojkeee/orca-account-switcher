// Orca plugin worker: polls account states, updates status bar, manages built-in OAuth vault & live switches.
import type { OrcaWorkerApi } from 'orca/worker'
import { fetchAgyPoolState, switchAgyPoolAccount, warmAgyTokenCache, type QuotaFetcher } from './agy-pool'
import { readCurrentAgyLogin, type AgyStoredToken } from './keyring'
import {
  exchangeAuthorizationCode,
  fetchProfile,
  parseCallbackInput,
  refreshWithClient,
  resolveOAuthClient,
  startLoopbackOAuthFlow,
  type OAuthClientConfig,
  type PendingOAuthFlow
} from './oauth'
import { fetchOrcaAccounts, selectOrcaAccount, type CommandRunner } from './orca-cli'
import {
  findAgyCli,
  findAgyToolsCli,
  findOrcaCli,
  resolvePlatformPaths,
  runCommand,
  type PlatformPaths
} from './platform'
import type { AccountsSnapshot, OrcaAgentKind, SwitchResult } from './protocol'
import { buildStatusBarState } from './status'
import { listVaultAccounts, removeVaultAccount, saveVaultAccount } from './vault'

export type WorkerDeps = {
  paths?: PlatformPaths
  findOrca?: () => string | null
  findAgy?: () => string | null
  runner?: CommandRunner
  fetcher?: QuotaFetcher
  platform?: NodeJS.Platform
  oauthClient?: OAuthClientConfig | null
  readCurrentLogin?: () => Promise<AgyStoredToken | null>
}

type PluginSettings = {
  pollSeconds: number
  statusClickAction: 'refresh' | 'switchBest'
  showAgyPool: boolean
  autoSwitchLowQuota: boolean
  lowQuotaThreshold: number
  oauthClientId: string
  oauthClientSecret: string
}

export const MIN_POLL_SECONDS = 600
export const DEFAULT_QUOTA_TTL_MS = 5 * 60 * 1000

const DEFAULT_SETTINGS: PluginSettings = {
  pollSeconds: 0,
  statusClickAction: 'refresh',
  showAgyPool: true,
  autoSwitchLowQuota: false,
  lowQuotaThreshold: 5,
  oauthClientId: '',
  oauthClientSecret: ''
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let activeOAuthFlow: PendingOAuthFlow | null = null

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
    oauthClientSecret: typeof raw.oauthClientSecret === 'string' ? raw.oauthClientSecret.trim() : ''
  }
}

export default function activate(orca: OrcaWorkerApi, deps: WorkerDeps = {}): void {
  const paths = deps.paths ?? resolvePlatformPaths()
  const platform = deps.platform ?? process.platform
  const resolveCli = deps.findOrca ?? (() => findOrcaCli(platform))
  const resolveAgyBin = deps.findAgy ?? (() => findAgyCli(platform))
  const runner = deps.runner ?? runCommand

  let settings: PluginSettings = DEFAULT_SETTINGS
  let latestSnapshot: AccountsSnapshot | null = null
  let refreshInFlight: Promise<AccountsSnapshot> | null = null
  let lastAutoSwitchAt = 0

  function getOAuthClient(): OAuthClientConfig | null {
    if (deps.oauthClient !== undefined) return deps.oauthClient
    return resolveOAuthClient(
      paths,
      { oauthClientId: settings.oauthClientId, oauthClientSecret: settings.oauthClientSecret },
      resolveAgyBin()
    )
  }

  async function safeHostCall(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await (orca.host.call as (m: string, p: Record<string, unknown>) => Promise<unknown>)(method, params)
    } catch (error) {
      orca.log(`${method} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function updateStatusBar(snapshot: AccountsSnapshot): Promise<void> {
    const bar = buildStatusBarState(snapshot)
    await safeHostCall('statusBar.update', {
      id: 'active-account',
      text: bar.text,
      icon: 'agent',
      tone: bar.tone,
      tooltip: bar.tooltip,
      visible: true
    })
  }

  async function loadSnapshot(refreshQuotas = true, force = false): Promise<AccountsSnapshot> {
    if (!force && refreshQuotas && latestSnapshot && Date.now() - latestSnapshot.fetchedAt < DEFAULT_QUOTA_TTL_MS) {
      return latestSnapshot
    }
    if (refreshInFlight) {
      if (!force) return refreshInFlight
      await refreshInFlight.catch(() => undefined)
    }
    refreshInFlight = (async () => {
      const cliPath = resolveCli()
      const oauthClient = getOAuthClient()
      const vaultAccounts = settings.showAgyPool ? await listVaultAccounts(orca) : []
      const [orcaRes, agyPool] = await Promise.all([
        fetchOrcaAccounts(cliPath, runner),
        settings.showAgyPool
          ? fetchAgyPoolState({
              paths,
              platform,
              vaultAccounts,
              oauthClient,
              fetcher: deps.fetcher,
              refreshQuotas
            })
          : Promise.resolve({
              available: false,
              oauthReady: false,
              activeEmail: null,
              accounts: [],
              bestEmail: null,
              error: null
            })
      ])

      const snapshot: AccountsSnapshot = {
        platform,
        orcaCliFound: orcaRes.cliFound,
        orcaError: orcaRes.error,
        providers: orcaRes.providers,
        agyPool,
        diagnostics: {
          orcaCliPath: cliPath,
          agyCliPath: resolveAgyBin(),
          agyToolsCliPath: findAgyToolsCli(platform),
          oauthClientSource: oauthClient?.source ?? (oauthClient ? 'resolved' : null)
        },
        fetchedAt: Date.now()
      }
      latestSnapshot = snapshot
      await orca.storage.set('lastSnapshot', snapshot).catch(() => undefined)
      await updateStatusBar(snapshot)
      orca.panels.post('accounts.updated', snapshot)
      return snapshot
    })()

    try {
      return await refreshInFlight
    } finally {
      refreshInFlight = null
    }
  }

  async function maybeAutoSwitch(snapshot: AccountsSnapshot): Promise<AccountsSnapshot> {
    if (!settings.autoSwitchLowQuota || !snapshot.agyPool.available) return snapshot
    const active = snapshot.agyPool.accounts.find((a) => a.active)
    if (!active || active.effectiveGemini === null || active.effectiveGemini >= settings.lowQuotaThreshold) {
      return snapshot
    }
    const bestEmail = snapshot.agyPool.bestEmail
    if (!bestEmail || bestEmail.toLowerCase() === active.email.toLowerCase()) return snapshot
    const best = snapshot.agyPool.accounts.find((a) => a.email === bestEmail)
    if (!best || best.effectiveGemini === null || best.effectiveGemini <= active.effectiveGemini) return snapshot
    if (Date.now() - lastAutoSwitchAt < 60_000) return snapshot
    lastAutoSwitchAt = Date.now()

    const switched = await performAgySwitch(bestEmail, snapshot)
    if (switched.ok) {
      await safeHostCall('notifications.show', {
        title: 'Account Switcher',
        body: `Low quota on ${active.email} (${active.effectiveGemini}%). Auto-switched to ${bestEmail} (${best.effectiveGemini}%).`
      })
    }
    return switched.snapshot
  }

  async function performOrcaSelect(agent: OrcaAgentKind, account: string): Promise<SwitchResult> {
    const res = await selectOrcaAccount(agent, account, resolveCli(), runner)
    const snapshot = await loadSnapshot(true, true)
    return { ok: res.ok, message: res.message, snapshot }
  }

  async function performAgySwitch(email: string, preloaded?: AccountsSnapshot): Promise<SwitchResult> {
    const vaultAccounts = await listVaultAccounts(orca)
    const res = await switchAgyPoolAccount(email, {
      paths,
      platform,
      vaultAccounts,
      oauthClient: getOAuthClient(),
      fetcher: deps.fetcher
    })
    let note = res.message
    if (res.ok) {
      const providers =
        preloaded?.providers ??
        latestSnapshot?.providers ??
        (await fetchOrcaAccounts(resolveCli(), runner)).providers
      const antigravity = providers.find((p) => p.agent === 'antigravity')
      const linked = antigravity?.accounts.find((a) => a.email?.toLowerCase() === email.toLowerCase())
      if (linked) {
        const orcaSync = await selectOrcaAccount('antigravity', linked.id, resolveCli(), runner)
        if (!orcaSync.ok) {
          note += `; Orca Antigravity sync warning: ${orcaSync.message}`
        }
      }
    }
    const snapshot = await loadSnapshot(true, true)
    return { ok: res.ok, message: note, snapshot }
  }

  async function performSwitchBest(): Promise<SwitchResult> {
    const current = await loadSnapshot(true, true)
    if (!current.agyPool.available) {
      const ag = current.providers.find((p) => p.agent === 'antigravity')
      const candidates = (ag?.accounts ?? [])
        .filter((a) => a.effectiveRemaining !== null)
        .sort((a, b) => (b.effectiveRemaining ?? -1) - (a.effectiveRemaining ?? -1))
      const best = candidates[0]
      if (!best) {
        return { ok: false, message: 'No Antigravity quota accounts available to pick best.', snapshot: current }
      }
      if (best.active) {
        return { ok: true, message: `${best.label} is already active with ${best.effectiveRemaining}% quota.`, snapshot: current }
      }
      return performOrcaSelect('antigravity', best.id)
    }

    const bestEmail = current.agyPool.bestEmail
    if (!bestEmail) {
      return { ok: false, message: 'No valid account found in AGY Vault / pool.', snapshot: current }
    }
    const best = current.agyPool.accounts.find((a) => a.email === bestEmail)
    if (best?.active) {
      return { ok: true, message: `${bestEmail} is already active (${best.effectiveGemini}% Gemini).`, snapshot: current }
    }
    return performAgySwitch(bestEmail, current)
  }

  async function importCurrentAgyLogin(): Promise<SwitchResult> {
    const currentLogin = deps.readCurrentLogin
      ? await deps.readCurrentLogin()
      : await readCurrentAgyLogin(paths, platform)
    if (!currentLogin) {
      const snapshot = latestSnapshot ?? (await loadSnapshot(false))
      return {
        ok: false,
        message: 'No active agy / Gemini login found on this machine. Use "+ Add Google Account" to sign in.',
        snapshot
      }
    }

    let email = currentLogin.email
    let name = ''
    let warmedToken: { accessToken: string; expiresIn: number } | null = null
    const client = getOAuthClient()
    if (!email && client) {
      try {
        const refreshed = await refreshWithClient(client, currentLogin.refreshToken, deps.fetcher)
        warmedToken = { accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn }
        const profile = await fetchProfile(refreshed.accessToken, deps.fetcher)
        email = profile.email
        name = profile.name
      } catch {
        // Handled below if email remains null
      }
    } else if (!email && currentLogin.accessToken) {
      const profile = await fetchProfile(currentLogin.accessToken, deps.fetcher)
      email = profile.email
      name = profile.name
    }

    if (!email) {
      const snapshot = latestSnapshot ?? (await loadSnapshot(false))
      return {
        ok: false,
        message: 'Found an agy token, but could not determine its email. Use "+ Add Google Account" instead.',
        snapshot
      }
    }

    if (warmedToken) {
      warmAgyTokenCache(email, currentLogin.refreshToken, warmedToken.accessToken, warmedToken.expiresIn)
    }

    const { storedInKeyring } = await saveVaultAccount(orca, {
      email,
      name,
      refreshToken: currentLogin.refreshToken,
      source: 'imported'
    })
    const snapshot = await loadSnapshot(true, true)
    const suffix = storedInKeyring ? '' : ' (OS keyring unavailable; stored in plugin storage)'
    return { ok: true, message: `Imported ${email} into AGY Vault${suffix}`, snapshot }
  }

  function resetPollTimer(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (settings.pollSeconds <= 0) return
    pollTimer = setInterval(() => {
      void loadSnapshot(true).then((snap) => maybeAutoSwitch(snap)).catch(() => undefined)
    }, settings.pollSeconds * 1000)
  }

  async function init(): Promise<void> {
    try {
      settings = parseSettings(await orca.settings.get())
    } catch {
      settings = DEFAULT_SETTINGS
    }
    resetPollTimer()

    const cached = await orca.storage.get<AccountsSnapshot>('lastSnapshot').catch(() => undefined)
    if (cached && typeof cached.fetchedAt === 'number' && Array.isArray(cached.providers)) {
      latestSnapshot = cached
      await updateStatusBar(cached)
      orca.panels.post('accounts.updated', cached)
      if (Date.now() - cached.fetchedAt < DEFAULT_QUOTA_TTL_MS) {
        await maybeAutoSwitch(cached)
        return
      }
    }

    const snap = await loadSnapshot(true)
    await maybeAutoSwitch(snap)
  }

  orca.panels.handle('accounts.snapshot', async (input) =>
    loadSnapshot(input?.refreshQuotas !== false, input?.force === true)
  )
  orca.panels.handle('accounts.selectOrca', async ({ agent, account }) => performOrcaSelect(agent, account))
  orca.panels.handle('accounts.selectAgyPool', async ({ email }) => performAgySwitch(email))
  orca.panels.handle('accounts.switchBestAgy', async () => performSwitchBest())
  orca.panels.handle('accounts.importCurrentAgy', async () => importCurrentAgyLogin())

  orca.panels.handle('accounts.removeVaultAccount', async ({ email }) => {
    const removed = await removeVaultAccount(orca, email)
    const snapshot = await loadSnapshot(true, true)
    return {
      ok: removed,
      message: removed ? `Removed ${email} from AGY Vault` : `${email} was not in AGY Vault`,
      snapshot
    }
  })

  orca.panels.handle('accounts.beginGoogleOAuth', async () => {
    const client = getOAuthClient()
    if (!client) {
      throw Object.assign(
        new Error('Google OAuth Client ID/Secret not found. Sign into Orca Chat once, install agy CLI, or set custom OAuth credentials in Settings.'),
        { code: 'unavailable' }
      )
    }
    activeOAuthFlow?.close()
    activeOAuthFlow = await startLoopbackOAuthFlow(
      client,
      async (outcome) => {
        activeOAuthFlow = null
        if (!outcome.ok) {
          const snapshot = latestSnapshot ?? (await loadSnapshot(false))
          orca.panels.post('oauth.completed', { ok: false, message: outcome.error, snapshot })
          return
        }
        await saveVaultAccount(orca, {
          email: outcome.account.email,
          name: outcome.account.name,
          refreshToken: outcome.account.refreshToken,
          source: 'oauth'
        })
        const switched = await performAgySwitch(outcome.account.email)
        orca.panels.post('oauth.completed', {
          ok: switched.ok,
          message: `Connected & activated ${outcome.account.email}`,
          snapshot: switched.snapshot
        })
      },
      deps.fetcher
    )
    return { authUrl: activeOAuthFlow.authUrl, redirectUri: activeOAuthFlow.redirectUri }
  })

  orca.panels.handle('accounts.completeGoogleOAuthManual', async ({ callbackOrCode }) => {
    const flow = activeOAuthFlow
    if (!flow) {
      const snapshot = await loadSnapshot(false)
      return { ok: false, message: 'No active Google sign-in session. Click "+ Add Google Account" first.', snapshot }
    }
    const { code } = parseCallbackInput(callbackOrCode, flow.state)
    const account = await exchangeAuthorizationCode(
      { client: flow.client, code, redirectUri: flow.redirectUri, codeVerifier: flow.codeVerifier },
      deps.fetcher
    )
    flow.close()
    activeOAuthFlow = null
    await saveVaultAccount(orca, {
      email: account.email,
      name: account.name,
      refreshToken: account.refreshToken,
      source: 'oauth'
    })
    const switched = await performAgySwitch(account.email)
    return { ok: switched.ok, message: `Connected & activated ${account.email}`, snapshot: switched.snapshot }
  })

  orca.panels.handle('accounts.cancelGoogleOAuth', async () => {
    activeOAuthFlow?.close()
    activeOAuthFlow = null
    return { ok: true }
  })

  orca.commands.register('accountSwitcher.refresh', async () => {
    const snap = await loadSnapshot(true, true)
    return `Refreshed accounts (${snap.providers.reduce((n, p) => n + p.accounts.length, 0)} Orca, ${snap.agyPool.accounts.length} AGY)`
  })

  orca.commands.register('accountSwitcher.switchBest', async () => {
    const res = await performSwitchBest()
    await safeHostCall('notifications.show', { title: 'Account Switcher', body: res.message })
    return res.message
  })

  orca.commands.register('accountSwitcher.statusAction', async () => {
    if (settings.statusClickAction === 'switchBest') {
      const res = await performSwitchBest()
      await safeHostCall('notifications.show', { title: 'Account Switcher', body: res.message })
      return res.message
    }
    const snap = await loadSnapshot(true, true)
    return `Refreshed at ${new Date(snap.fetchedAt).toLocaleTimeString()}`
  })

  orca.settings.onDidChange(async () => {
    try {
      settings = parseSettings(await orca.settings.get())
      resetPollTimer()
      await loadSnapshot(true, true)
    } catch {
      // Ignore settings read errors
    }
  })

  void init()
}

export function deactivate(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  activeOAuthFlow?.close()
  activeOAuthFlow = null
}
