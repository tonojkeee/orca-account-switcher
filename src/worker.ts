// Orca plugin worker: polls account states, updates status bar, manages built-in OAuth vault & live switches.
import type { OrcaWorkerApi } from 'orca/worker'
import { fetchAgyPoolState, warmAgyTokenCache, type QuotaFetcher } from './agy-pool'
import { readCurrentAgyLogin, type AgyStoredToken } from './keyring'
import {
  exchangeAuthorizationCode,
  parseCallbackInput,
  resolveImportedAgyIdentity,
  resolveOAuthClientCandidates,
  startLoopbackOAuthFlow,
  type HttpFetcher,
  type OAuthClientConfig,
  type PendingOAuthFlow
} from './oauth'
import {
  computeOrcaLaunchLock,
  fetchOrcaAccounts,
  reconcileOrcaAntigravitySelection,
  selectOrcaAccount,
  type CommandRunner
} from './orca-cli'
import {
  findAgyCli,
  findAgyToolsCli,
  findOrcaCli,
  resolvePlatformPaths,
  runCommand,
  type PlatformPaths
} from './platform'
import type { AccountsSnapshot, OrcaAgentKind, PluginUpdateInfo, SwitchResult } from './protocol'
import { buildStatusBarState } from './status'
import {
  hydrateCachedSnapshot,
  performAgySwitchAction,
  syncAgyCredentialsAfterOrcaSelect
} from './sync'
import {
  applyPluginSelfUpdate,
  dismissStoredUpdateVersion,
  readInstalledPluginVersion,
  runStoredUpdateCheck
} from './update-check'
import { listVaultAccounts, removeVaultAccount, saveVaultAccount } from './vault'
import {
  DEFAULT_QUOTA_TTL_MS,
  DEFAULT_SETTINGS,
  MIN_POLL_SECONDS,
  parseSettings,
  type PluginSettings
} from './worker-settings'

export { DEFAULT_QUOTA_TTL_MS, MIN_POLL_SECONDS, parseSettings }

export type WorkerDeps = {
  paths?: PlatformPaths
  findOrca?: () => string | null
  findAgy?: () => string | null
  runner?: CommandRunner
  fetcher?: QuotaFetcher
  updateFetcher?: HttpFetcher | null
  pluginVersion?: string
  platform?: NodeJS.Platform
  oauthClient?: OAuthClientConfig | null
  readCurrentLogin?: () => Promise<AgyStoredToken | null>
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let activeOAuthFlow: PendingOAuthFlow | null = null

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
  const currentVersion = deps.pluginVersion ?? readInstalledPluginVersion()

  async function runUpdateCheck(force = false): Promise<PluginUpdateInfo> {
    const { info, shouldNotifyDesktop } = await runStoredUpdateCheck(orca.storage, {
      enabled: settings.checkUpdates && deps.updateFetcher !== null,
      force,
      currentVersion,
      fetcher: deps.updateFetcher ?? undefined
    })
    if (shouldNotifyDesktop && info.latestVersion) {
      await safeHostCall('notifications.show', {
        title: 'Account Switcher update available',
        body: `Version v${info.latestVersion} is available (installed v${info.currentVersion}). Run "orca plugin update --all" or open GitHub in the Accounts panel.`
      })
    }
    return info
  }

  function getOAuthCandidates(): OAuthClientConfig[] {
    if (deps.oauthClient !== undefined) return deps.oauthClient ? [deps.oauthClient] : []
    return resolveOAuthClientCandidates(
      paths,
      { oauthClientId: settings.oauthClientId, oauthClientSecret: settings.oauthClientSecret },
      resolveAgyBin()
    )
  }

  function getOAuthClient(): OAuthClientConfig | null {
    return getOAuthCandidates()[0] ?? null
  }

  function collectDiagnostics(oauthClient: OAuthClientConfig | null = getOAuthClient()) {
    return {
      orcaCliPath: resolveCli(),
      agyCliPath: resolveAgyBin(),
      agyToolsCliPath: findAgyToolsCli(platform),
      oauthClientSource: oauthClient?.source ?? (oauthClient ? 'resolved' : null)
    }
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
      const oauthClients = getOAuthCandidates()
      const oauthClient = oauthClients[0] ?? null
      const vaultAccounts = settings.showAgyPool ? await listVaultAccounts(orca) : []
      const [orcaRes, agyPool, update] = await Promise.all([
        fetchOrcaAccounts(cliPath, runner),
        settings.showAgyPool
          ? fetchAgyPoolState({
              paths,
              platform,
              vaultAccounts,
              oauthClients: oauthClients,
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
            }),
        runUpdateCheck(force)
      ])

      const providers =
        orcaRes.cliFound && !orcaRes.error
          ? await reconcileOrcaAntigravitySelection(orcaRes.providers, agyPool.activeEmail, cliPath, runner)
          : orcaRes.providers

      const snapshot: AccountsSnapshot = {
        platform,
        orcaCliFound: orcaRes.cliFound,
        orcaError: orcaRes.error,
        providers,
        agyPool,
        diagnostics: collectDiagnostics(oauthClient),
        update,
        orcaLaunchLock: computeOrcaLaunchLock(providers, agyPool.activeEmail),
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
    if (!res.ok) {
      const snapshot = latestSnapshot ?? (await loadSnapshot(false))
      return { ok: false, message: res.message, snapshot }
    }

    let note = res.message
    if (agent === 'antigravity') {
      const syncRes = await syncAgyCredentialsAfterOrcaSelect({
        orca,
        account,
        paths,
        platform,
        cliPath: resolveCli(),
        runner,
        providers: latestSnapshot?.providers,
        oauthClients: getOAuthCandidates(),
        fetcher: deps.fetcher
      })
      if (syncRes.message) {
        note += `; ${syncRes.message}`
      }
    }

    const snapshot = await loadSnapshot(true, true)
    return { ok: true, message: note, snapshot }
  }

  async function performAgySwitch(email: string, preloaded?: AccountsSnapshot): Promise<SwitchResult> {
    const res = await performAgySwitchAction({
      orca,
      email,
      paths,
      platform,
      cliPath: resolveCli(),
      runner,
      providers: preloaded?.providers ?? latestSnapshot?.providers ?? [],
      oauthClients: getOAuthCandidates(),
      fetcher: deps.fetcher
    })
    const snapshot = await loadSnapshot(true, true)
    return { ok: res.ok, message: res.message, snapshot }
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

    const { email, name, warmedToken } = await resolveImportedAgyIdentity(
      currentLogin,
      getOAuthCandidates(),
      deps.fetcher
    )

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
      const cliPath = resolveCli()
      const currentLogin = deps.readCurrentLogin
        ? await deps.readCurrentLogin().catch(() => null)
        : await readCurrentAgyLogin(paths, platform).catch(() => null)
      const liveEmail = currentLogin?.email ?? cached.agyPool.activeEmail
      const freshOrca = await fetchOrcaAccounts(cliPath, runner)
      const providers =
        freshOrca.cliFound && !freshOrca.error
          ? await reconcileOrcaAntigravitySelection(freshOrca.providers, liveEmail, cliPath, runner)
          : cached.providers
      const update = await runUpdateCheck(false)
      const hydrated = hydrateCachedSnapshot(
        cached,
        liveEmail,
        freshOrca,
        providers,
        update,
        collectDiagnostics()
      )
      latestSnapshot = hydrated
      await orca.storage.set('lastSnapshot', hydrated).catch(() => undefined)
      await updateStatusBar(hydrated)
      orca.panels.post('accounts.updated', hydrated)
      if (Date.now() - hydrated.fetchedAt < DEFAULT_QUOTA_TTL_MS) {
        await maybeAutoSwitch(hydrated)
        return
      }
    }

    const snap = await loadSnapshot(true)
    await maybeAutoSwitch(snap)
  }

  orca.panels.handle('accounts.snapshot', async (input) =>
    loadSnapshot(input?.refreshQuotas !== false, input?.force === true)
  )
  orca.panels.handle('accounts.checkUpdate', async () => {
    const update = await runUpdateCheck(true)
    if (!latestSnapshot) return loadSnapshot(false)
    const next: AccountsSnapshot = { ...latestSnapshot, update }
    latestSnapshot = next
    await orca.storage.set('lastSnapshot', next).catch(() => undefined)
    orca.panels.post('accounts.updated', next)
    return next
  })
  orca.panels.handle('accounts.dismissUpdate', async ({ version }) => {
    const update = await dismissStoredUpdateVersion(
      orca.storage,
      version,
      settings.checkUpdates && deps.updateFetcher !== null,
      currentVersion,
      deps.updateFetcher ?? undefined
    )
    if (!latestSnapshot) return loadSnapshot(false)
    const next: AccountsSnapshot = { ...latestSnapshot, update }
    latestSnapshot = next
    await orca.storage.set('lastSnapshot', next).catch(() => undefined)
    orca.panels.post('accounts.updated', next)
    return next
  })
  orca.panels.handle('accounts.applyUpdate', async () => {
    const res = await applyPluginSelfUpdate({ cliPath: resolveCli(), runner })
    const snapshot = await loadSnapshot(false, res.ok)
    return { ok: res.ok, message: res.message, snapshot }
  })
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
