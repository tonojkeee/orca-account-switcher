// Unified AGY account pool: merges built-in encrypted vault + optional ~/.antigravity_tools/accounts,
// fetches Cloud Code quotas in parallel, and switches `agy` CLI + OS keyring + ~/.gemini + Orca ACP on the fly.
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { readCurrentAgyLogin, writeAgyCliCredentials } from './keyring'
import {
  DEFAULT_SCOPES,
  refreshWithOAuthCandidates,
  resolveOAuthClientCandidates,
  type OAuthClientConfig
} from './oauth'
import { asNumber, asString, asTimestampMs, round1 } from './parse'
import {
  findAgyToolsCli,
  readJsonObject,
  resolvePlatformPaths,
  runCommand,
  type PlatformKind,
  type PlatformPaths
} from './platform'
import type { AgyAccountSource, AgyPoolAccount, AgyPoolState } from './protocol'
import type { VaultAccountSecret } from './vault'

const QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'

function cloudCodeUserAgent(platform: PlatformKind = process.platform): string {
  const osPart = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux'
  const archPart = process.arch === 'x64' ? 'amd64' : process.arch
  return `antigravity/2.25.0 ${osPart}/${archPart} google-api-nodejs-client/10.3.0`
}

export type MergedAgyAccount = {
  id?: string
  email: string
  name: string
  source: AgyAccountSource
  refreshToken: string
  accessToken: string | null
  expiryMs: number
}

export function readActiveGeminiEmail(paths: PlatformPaths): string | null {
  const obj = readJsonObject(path.join(paths.geminiDir, 'google_accounts.json'))
  return asString(obj?.active)
}

export function loadAgyToolsAccounts(agyAccountsDir: string): MergedAgyAccount[] {
  if (!existsSync(agyAccountsDir)) return []
  const files = readdirSync(agyAccountsDir).filter((name) => name.endsWith('.json')).sort()
  const out: MergedAgyAccount[] = []
  for (const file of files) {
    const obj = readJsonObject(path.join(agyAccountsDir, file))
    if (!obj || obj.disabled === true || obj.validation_blocked === true) continue
    const email = asString(obj.email)
    const tok = obj.token && typeof obj.token === 'object' ? (obj.token as Record<string, unknown>) : null
    const refreshToken = asString(tok?.refresh_token)
    if (!email || !refreshToken) continue
    const expirySec = asNumber(tok?.expiry_timestamp) ?? 0
    const id = asString(obj.id) ?? file.replace(/\.json$/, '')
    out.push({
      id,
      email,
      name: asString(obj.name) ?? '',
      source: 'agy-tools',
      refreshToken,
      accessToken: asString(tok?.access_token),
      expiryMs: expirySec * 1000
    })
  }
  return out
}

export function mergeAgySources(
  vaultAccounts: readonly VaultAccountSecret[],
  agyToolsAccounts: readonly MergedAgyAccount[]
): MergedAgyAccount[] {
  const byEmail = new Map<string, MergedAgyAccount>()
  for (const v of vaultAccounts) {
    byEmail.set(v.email.toLowerCase(), {
      email: v.email,
      name: v.name,
      source: 'vault',
      refreshToken: v.refreshToken,
      accessToken: null,
      expiryMs: 0
    })
  }
  for (const t of agyToolsAccounts) {
    const key = t.email.toLowerCase()
    const existing = byEmail.get(key)
    if (existing) {
      byEmail.set(key, {
        ...existing,
        id: existing.id || t.id,
        name: existing.name || t.name,
        source: 'both',
        accessToken: t.accessToken,
        expiryMs: t.expiryMs
      })
    } else {
      byEmail.set(key, t)
    }
  }
  return Array.from(byEmail.values())
}

export type QuotaFetcher = (
  url: string,
  init: RequestInit
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

async function defaultFetch(
  url: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

type CachedAccessToken = {
  accessToken: string
  expiresAtMs: number
}

const accessTokenCache = new Map<string, CachedAccessToken>()
const TOKEN_EXPIRY_SAFETY_MS = 60_000

export function clearAgyTokenCache(): void {
  accessTokenCache.clear()
}

export function warmAgyTokenCache(
  email: string,
  refreshToken: string,
  accessToken: string,
  expiresInSeconds: number
): void {
  if (!email.trim() || !refreshToken.trim() || !accessToken.trim()) return
  accessTokenCache.set(tokenCacheKey(email, refreshToken), {
    accessToken,
    expiresAtMs: Date.now() + Math.max(60, expiresInSeconds) * 1000
  })
}

function tokenCacheKey(email: string, refreshToken: string): string {
  return `${email.toLowerCase()}::${refreshToken.slice(-12)}`
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultJitterMs(): number {
  return 250 + Math.floor(Math.random() * 300)
}

async function resolveAccessToken(
  account: MergedAgyAccount,
  clients: readonly OAuthClientConfig[],
  fetcher: QuotaFetcher,
  forceRefresh = false
): Promise<{ token: string } | { error: string }> {
  const key = tokenCacheKey(account.email, account.refreshToken)
  const now = Date.now()

  if (!forceRefresh) {
    const cached = accessTokenCache.get(key)
    if (cached && cached.expiresAtMs > now + TOKEN_EXPIRY_SAFETY_MS) {
      return { token: cached.accessToken }
    }
    if (account.accessToken && account.expiryMs > now + TOKEN_EXPIRY_SAFETY_MS) {
      accessTokenCache.set(key, { accessToken: account.accessToken, expiresAtMs: account.expiryMs })
      return { token: account.accessToken }
    }
  }

  if (clients.length > 0) {
    try {
      const refreshed = await refreshWithOAuthCandidates(clients, account.refreshToken, fetcher)
      accessTokenCache.set(key, {
        accessToken: refreshed.accessToken,
        expiresAtMs: Date.now() + refreshed.expiresIn * 1000
      })
      return { token: refreshed.accessToken }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  if (account.accessToken && account.expiryMs > now + 30_000) {
    return { token: account.accessToken }
  }
  return { error: 'OAuth client config not found (open Orca Chat or set Client ID/Secret in settings)' }
}

/** Parse Google Cloud Code `retrieveUserQuotaSummary` JSON response into remaining percentages. */
export function parseCloudCodeQuotaResponse(raw: unknown): {
  gemini5h: number
  geminiWeekly: number
  claude5h: number
  claudeWeekly: number
  effectiveGemini: number
  gemini5hResetsAt: number | null
  geminiWeeklyResetsAt: number | null
  argon5h?: number | null
  argonWeekly?: number | null
  argon5hResetsAt?: number | null
  argonWeeklyResetsAt?: number | null
} {
  let gemini5h = 100
  let geminiWeekly = 100
  let claude5h = 100
  let claudeWeekly = 100
  let gemini5hResetsAt: number | null = null
  let geminiWeeklyResetsAt: number | null = null
  let argon5h: number | null = null
  let argonWeekly: number | null = null
  let argon5hResetsAt: number | null = null
  let argonWeeklyResetsAt: number | null = null

  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const groups = Array.isArray(root.groups) ? root.groups : []

  for (const g of groups) {
    if (!g || typeof g !== 'object') continue
    const group = g as Record<string, unknown>
    const displayName = asString(group.displayName) ?? ''
    const isArgon =
      displayName.toLowerCase().includes('argon') ||
      (group.name !== undefined && group.name !== null && String(group.name).toLowerCase().includes('argon'))
    const buckets = Array.isArray(group.buckets) ? group.buckets : []
    for (const b of buckets) {
      if (!b || typeof b !== 'object') continue
      const bucket = b as Record<string, unknown>
      const frac = asNumber(bucket.remainingFraction)
      if (frac === null) continue
      const pct = Math.max(0, Math.min(100, frac * 100))
      const win = asString(bucket.window)
      const resetsAt = asTimestampMs(bucket.resetTime ?? bucket.resetsAt)
      const isBucketArgon =
        isArgon ||
        (bucket.name !== undefined && bucket.name !== null && String(bucket.name).toLowerCase().includes('argon'))

      if (isBucketArgon) {
        if (win === '5h') {
          argon5h = pct
          argon5hResetsAt = resetsAt
        } else if (win === 'weekly') {
          argonWeekly = pct
          argonWeeklyResetsAt = resetsAt
        }
      } else if (displayName.includes('Gemini')) {
        if (win === '5h') {
          gemini5h = pct
          gemini5hResetsAt = resetsAt
        } else if (win === 'weekly') {
          geminiWeekly = pct
          geminiWeeklyResetsAt = resetsAt
        }
      } else if (displayName.includes('Claude') || displayName.includes('GPT')) {
        if (win === '5h') claude5h = pct
        else if (win === 'weekly') claudeWeekly = pct
      }
    }
  }

  return {
    gemini5h: round1(gemini5h),
    geminiWeekly: round1(geminiWeekly),
    claude5h: round1(claude5h),
    claudeWeekly: round1(claudeWeekly),
    effectiveGemini: round1(Math.min(gemini5h, geminiWeekly)),
    gemini5hResetsAt,
    geminiWeeklyResetsAt,
    argon5h: argon5h !== null ? round1(argon5h) : null,
    argonWeekly: argonWeekly !== null ? round1(argonWeekly) : null,
    argon5hResetsAt,
    argonWeeklyResetsAt
  }
}

type FetchOneResult = {
  account: AgyPoolAccount
  circuitBreakerReason: string | null
}

function emptyPoolAccount(
  account: MergedAgyAccount,
  activeEmail: string | null,
  error: string | null
): AgyPoolAccount {
  return {
    email: account.email,
    name: account.name,
    source: account.source,
    active: activeEmail !== null && account.email.toLowerCase() === activeEmail.toLowerCase(),
    gemini5h: null,
    geminiWeekly: null,
    claude5h: null,
    claudeWeekly: null,
    effectiveGemini: null,
    gemini5hResetsAt: null,
    geminiWeeklyResetsAt: null,
    argon5h: null,
    argonWeekly: null,
    argon5hResetsAt: null,
    argonWeeklyResetsAt: null,
    error
  }
}

async function fetchOneAccount(
  account: MergedAgyAccount,
  activeEmail: string | null,
  clients: readonly OAuthClientConfig[],
  fetcher: QuotaFetcher
): Promise<FetchOneResult> {
  const fail = (error: string, circuitBreakerReason: string | null = null): FetchOneResult => ({
    account: emptyPoolAccount(account, activeEmail, error),
    circuitBreakerReason
  })

  try {
    let auth = await resolveAccessToken(account, clients, fetcher, false)
    if ('error' in auth) return fail(auth.error)

    const callQuota = (token: string) =>
      fetcher(QUOTA_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': cloudCodeUserAgent(),
          'X-Goog-Api-Client': 'gl-node/22.21.1'
        },
        body: '{}'
      })

    let resp = await callQuota(auth.token)
    if (resp.status === 401 && clients.length > 0) {
      accessTokenCache.delete(tokenCacheKey(account.email, account.refreshToken))
      auth = await resolveAccessToken(account, clients, fetcher, true)
      if ('error' in auth) return fail(auth.error)
      resp = await callQuota(auth.token)
    }

    if (resp.status === 429 || resp.status === 403) {
      return fail(
        `Quota HTTP ${resp.status}`,
        `Quota HTTP ${resp.status} on ${account.email} — polling paused to protect pool accounts from IP rate limits`
      )
    }
    if (!resp.ok) return fail(`Quota HTTP ${resp.status}`)

    const quotas = parseCloudCodeQuotaResponse(await resp.json())
    return {
      account: {
        email: account.email,
        name: account.name,
        source: account.source,
        active: activeEmail !== null && account.email.toLowerCase() === activeEmail.toLowerCase(),
        ...quotas,
        error: null
      },
      circuitBreakerReason: null
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** Sort valid accounts descending by effective Gemini quota, then weekly Gemini, then Claude 5h. */
export function sortAgyPoolAccounts(accounts: readonly AgyPoolAccount[]): AgyPoolAccount[] {
  return [...accounts].sort((a, b) => {
    const ea = a.effectiveGemini ?? -1
    const eb = b.effectiveGemini ?? -1
    if (eb !== ea) return eb - ea
    const wa = a.geminiWeekly ?? -1
    const wb = b.geminiWeekly ?? -1
    if (wb !== wa) return wb - wa
    return (b.claude5h ?? -1) - (a.claude5h ?? -1)
  })
}

function resolvePoolClients(
  paths: PlatformPaths,
  options: { oauthClient?: OAuthClientConfig | null; oauthClients?: readonly OAuthClientConfig[] }
): readonly OAuthClientConfig[] {
  if (options.oauthClients) return options.oauthClients
  if (options.oauthClient === null) return []
  if (options.oauthClient !== undefined) return [options.oauthClient]
  return resolveOAuthClientCandidates(paths)
}

export async function fetchAgyPoolState(
  options: {
    paths?: PlatformPaths
    platform?: PlatformKind
    vaultAccounts?: readonly VaultAccountSecret[]
    oauthClient?: OAuthClientConfig | null
    oauthClients?: readonly OAuthClientConfig[]
    fetcher?: QuotaFetcher
    refreshQuotas?: boolean
    jitterMs?: () => number
  } = {}
): Promise<AgyPoolState> {
  const paths = options.paths ?? resolvePlatformPaths()
  const platform = options.platform ?? process.platform
  const fetcher = options.fetcher ?? defaultFetch
  const clients = resolvePoolClients(paths, options)
  const oauthReady = clients.length > 0
  const stored = mergeAgySources(options.vaultAccounts ?? [], loadAgyToolsAccounts(paths.agyAccountsDir))

  const currentLogin = await readCurrentAgyLogin(paths, platform).catch(() => null)
  const activeEmail = currentLogin?.email ?? readActiveGeminiEmail(paths)

  if (stored.length === 0) {
    return { available: false, oauthReady, activeEmail, accounts: [], bestEmail: null, error: null }
  }

  if (options.refreshQuotas === false) {
    return {
      available: true,
      oauthReady,
      activeEmail,
      accounts: stored.map((a) => emptyPoolAccount(a, activeEmail, null)),
      bestEmail: null,
      error: null
    }
  }

  // Sequential polling with human-like jitter and immediate circuit-breaking on 429/403 avoids IP bursts.
  const getJitter = options.jitterMs ?? defaultJitterMs
  const fetched: AgyPoolAccount[] = []
  let haltedError: string | null = null
  for (let i = 0; i < stored.length; i++) {
    if (i > 0) await sleep(getJitter())
    const outcome = await fetchOneAccount(stored[i], activeEmail, clients, fetcher)
    fetched.push(outcome.account)
    if (outcome.circuitBreakerReason) {
      haltedError = outcome.circuitBreakerReason
      for (let j = i + 1; j < stored.length; j++) {
        fetched.push(emptyPoolAccount(stored[j], activeEmail, 'Skipped (rate limit protection)'))
      }
      break
    }
  }
  const sorted = sortAgyPoolAccounts(fetched)
  const best = sorted.find((a) => a.error === null && a.effectiveGemini !== null) ?? null
  return {
    available: true,
    oauthReady,
    activeEmail,
    accounts: sorted,
    bestEmail: best?.email ?? null,
    error: haltedError
  }
}

/**
 * Switch `agy` CLI + OS keyring + ~/.gemini + Orca ACP directly on the fly (no external manager required).
 * Also calls `antigravity-tools switch` if installed and the account exists in `~/.antigravity_tools/accounts`.
 */
export async function switchAgyPoolAccount(
  targetEmail: string,
  options: {
    paths?: PlatformPaths
    platform?: PlatformKind
    vaultAccounts?: readonly VaultAccountSecret[]
    oauthClient?: OAuthClientConfig | null
    oauthClients?: readonly OAuthClientConfig[]
    fetcher?: QuotaFetcher
  } = {}
): Promise<{ ok: boolean; message: string }> {
  const paths = options.paths ?? resolvePlatformPaths()
  const platform = options.platform ?? process.platform
  const fetcher = options.fetcher ?? defaultFetch
  const agyToolsAccounts = loadAgyToolsAccounts(paths.agyAccountsDir)
  const stored = mergeAgySources(options.vaultAccounts ?? [], agyToolsAccounts)
  const match = stored.find(
    (a) =>
      a.email.toLowerCase() === targetEmail.toLowerCase() ||
      (a.id && a.id.toLowerCase() === targetEmail.toLowerCase())
  )
  if (!match) {
    return { ok: false, message: `Account ${targetEmail} not found in AGY Vault or ~/.antigravity_tools` }
  }

  const clients = resolvePoolClients(paths, options)
  let workingClient: OAuthClientConfig | null = clients[0] ?? null
  const warnings: string[] = []

  // Obtain fresh access_token + id_token for `agy` CLI & Gemini CLI when OAuth client is available.
  let accessToken = match.accessToken ?? ''
  let idToken: string | null = null
  let expiresIn = 3599

  if (clients.length > 0) {
    try {
      const refreshed = await refreshWithOAuthCandidates(clients, match.refreshToken, fetcher)
      accessToken = refreshed.accessToken
      idToken = refreshed.idToken
      expiresIn = refreshed.expiresIn
      workingClient = refreshed.client
      accessTokenCache.set(tokenCacheKey(match.email, match.refreshToken), {
        accessToken,
        expiresAtMs: Date.now() + expiresIn * 1000
      })
    } catch (error) {
      return {
        ok: false,
        message: `Failed to refresh token for ${match.email}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  } else if (!accessToken) {
    return {
      ok: false,
      message: 'Cannot refresh access token: OAuth client config not found (initialize Orca Chat or set Client ID/Secret in settings)'
    }
  }

  const expiryMs = Date.now() + expiresIn * 1000
  const credWrite = await writeAgyCliCredentials(
    {
      email: match.email,
      accessToken,
      refreshToken: match.refreshToken,
      expiresIn,
      expiryIso: new Date(expiryMs).toISOString(),
      expiryMs,
      idToken,
      scope: (workingClient?.scopes ?? DEFAULT_SCOPES).join(' '),
      oauthTemplate: workingClient?.rawTemplate ?? null
    },
    paths,
    platform
  )
  warnings.push(...credWrite.warnings)

  // Keep optional antigravity-tools CLI state aligned if installed and present in its pool.
  if (match.source === 'agy-tools' || match.source === 'both') {
    const agyToolsCli = findAgyToolsCli(platform)
    if (agyToolsCli) {
      const res = await runCommand(agyToolsCli, ['switch', match.email], 15000)
      if (res.code !== 0) {
        warnings.push(`antigravity-tools sync note: ${res.stderr.trim() || res.code}`)
      }
    }
  }

  const suffix = warnings.length > 0 ? ` (${warnings.join('; ')})` : ''
  return { ok: true, message: `Switched agy CLI + Orca ACP to ${match.email}${suffix}` }
}
