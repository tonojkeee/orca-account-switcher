// Standalone cross-platform Google OAuth2 PKCE + loopback flow for adding AGY accounts without external managers.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { decodeJwtPayload } from './keyring'
import { asString } from './parse'
import { findAgyCliCandidates, readJsonObject, type PlatformPaths } from './platform'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
export const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'openid'
]

function mergeAgyScopes(existing?: readonly string[]): string[] {
  const merged = new Set<string>(DEFAULT_SCOPES)
  for (const s of existing ?? []) {
    if (s.trim()) merged.add(s.trim())
  }
  return Array.from(merged)
}

export type OAuthClientConfig = {
  clientId: string
  clientSecret: string
  tokenUri: string
  scopes: string[]
  rawTemplate: Record<string, unknown>
  source?: 'settings' | 'orca-acp' | 'gemini-cli' | 'agy-binary'
}

export type OAuthExchangeResult = {
  email: string
  name: string
  refreshToken: string
  accessToken: string
  idToken: string | null
  expiresIn: number
}

export type HttpFetcher = (
  url: string,
  init?: RequestInit
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

let cachedWorkingClient: OAuthClientConfig | null = null

export function clearOAuthClientCache(): void {
  cachedWorkingClient = null
}

function sanitizeGoogleSecret(secret: string): string[] {
  const m = /^GOCSPX-[A-Za-z0-9_-]{28}/.exec(secret)
  if (m && m[0] !== secret) {
    // Recover cleanly if a prior version wrote Go-concatenated trailing chars into acp_token.json.
    return [m[0], secret]
  }
  return [secret]
}

/**
 * Resolve ordered Google Desktop OAuth client candidates without hardcoding secrets:
 * 1) Explicit settings override, 2) Cached working client, 3) Orca acp_token.json,
 * 4) ~/.gemini/oauth_creds.json, 5) local `agy` binary pairs (with 35-char GOCSPX bounds).
 */
export function resolveOAuthClientCandidates(
  paths: PlatformPaths,
  settings: { oauthClientId?: string; oauthClientSecret?: string } = {},
  agyBin: string | null | undefined = undefined
): OAuthClientConfig[] {
  const customId = settings.oauthClientId?.trim()
  const customSecret = settings.oauthClientSecret?.trim()
  if (customId && customSecret) {
    return [
      {
        clientId: customId,
        clientSecret: customSecret,
        tokenUri: GOOGLE_TOKEN_URL,
        scopes: DEFAULT_SCOPES,
        source: 'settings',
        rawTemplate: {
          client_id: customId,
          client_secret: customSecret,
          token_uri: GOOGLE_TOKEN_URL,
          scopes: DEFAULT_SCOPES
        }
      }
    ]
  }

  const out: OAuthClientConfig[] = []
  const seen = new Set<string>()
  const push = (cfg: OAuthClientConfig) => {
    const key = `${cfg.clientId}::${cfg.clientSecret}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(cfg)
  }

  if (cachedWorkingClient) {
    push(cachedWorkingClient)
  }

  const fileCandidates: { path: string; source: 'orca-acp' | 'gemini-cli' }[] = [
    { path: paths.orcaAcpTokenPath, source: 'orca-acp' },
    { path: path.join(paths.geminiDir, 'oauth_creds.json'), source: 'gemini-cli' }
  ]

  for (const candidate of fileCandidates) {
    const obj = readJsonObject(candidate.path)
    const clientId = asString(obj?.client_id)
    const clientSecret = asString(obj?.client_secret)
    if (obj && clientId && clientSecret) {
      const scopes = Array.isArray(obj.scopes)
        ? obj.scopes.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : []
      const tokenUri = asString(obj.token_uri) ?? GOOGLE_TOKEN_URL
      for (const sec of sanitizeGoogleSecret(clientSecret)) {
        push({
          clientId,
          clientSecret: sec,
          tokenUri,
          scopes: mergeAgyScopes(scopes),
          source: candidate.source,
          rawTemplate: { ...obj, client_id: clientId, client_secret: sec, token_uri: tokenUri }
        })
      }
    }
  }

  const binCandidates =
    agyBin === null
      ? []
      : agyBin === undefined
        ? findAgyCliCandidates()
        : /\.(?:cmd|bat)$/i.test(agyBin)
          ? findAgyCliCandidates()
          : [agyBin]

  for (const binPath of binCandidates) {
    for (const cfg of extractOAuthClientCandidatesFromBinary(binPath)) {
      push(cfg)
    }
  }

  return out
}

/** Return the primary OAuth client config (backward-compatible helper). */
export function resolveOAuthClient(
  paths: PlatformPaths,
  settings: { oauthClientId?: string; oauthClientSecret?: string } = {},
  agyBin: string | null | undefined = undefined
): OAuthClientConfig | null {
  return resolveOAuthClientCandidates(paths, settings, agyBin)[0] ?? null
}

function makeBinaryClientConfig(clientId: string, clientSecret: string): OAuthClientConfig {
  return {
    clientId,
    clientSecret,
    tokenUri: GOOGLE_TOKEN_URL,
    scopes: DEFAULT_SCOPES,
    source: 'agy-binary',
    rawTemplate: {
      client_id: clientId,
      client_secret: clientSecret,
      token_uri: GOOGLE_TOKEN_URL,
      scopes: DEFAULT_SCOPES
    }
  }
}

function extractOAuthClientCandidatesFromBinary(binPath: string): OAuthClientConfig[] {
  try {
    if (/\.(?:cmd|bat)$/i.test(binPath)) return []
    const text = readFileSync(binPath).toString('latin1')
    const idHits: { value: string; index: number }[] = []
    const seenIds = new Set<string>()
    const idRe = /\d{6,}-[a-z0-9]{12,}\.apps\.googleusercontent\.com/g
    for (let m = idRe.exec(text); m !== null; m = idRe.exec(text)) {
      if (!seenIds.has(m[0])) {
        seenIds.add(m[0])
        idHits.push({ value: m[0], index: m.index })
      }
    }
    if (idHits.length === 0) return []

    // Standard Google GOCSPX client secrets are always 35 chars (7-char prefix + 28 chars).
    // Capping at 28 prevents Go .rodata concatenated strings (like "cloudcode-pa") from leaking in.
    const secHits: { value: string; index: number }[] = []
    const seenSecs = new Set<string>()
    const secRe = /GOCSPX-[A-Za-z0-9_-]{28}/g
    for (let m = secRe.exec(text); m !== null; m = secRe.exec(text)) {
      if (!seenSecs.has(m[0])) {
        seenSecs.add(m[0])
        secHits.push({ value: m[0], index: m.index })
      }
    }
    if (secHits.length === 0) return []

    const out: OAuthClientConfig[] = []
    const seenPairs = new Set<string>()
    const addPair = (id: string, sec: string) => {
      const k = `${id}::${sec}`
      if (seenPairs.has(k)) return
      seenPairs.add(k)
      out.push(makeBinaryClientConfig(id, sec))
    }

    // 1. Proximity pairs (text configs, scripts, JS bundles)
    for (const idHit of idHits) {
      for (const secHit of secHits) {
        if (Math.abs(idHit.index - secHit.index) <= 8192) {
          addPair(idHit.value, secHit.value)
        }
      }
    }

    // 2. Index-aligned Go .rodata table pairs (prefer known Antigravity prod clientId slot first if present)
    const minLen = Math.min(idHits.length, secHits.length)
    const alignedIndices = Array.from({ length: minLen }, (_, i) => i)
    const prodIdx = alignedIndices.find((i) => idHits[i].value.startsWith('1071006060591-'))
    if (prodIdx !== undefined && prodIdx > 0) {
      addPair(idHits[prodIdx].value, secHits[prodIdx].value)
    }
    for (const i of alignedIndices) {
      addPair(idHits[i].value, secHits[i].value)
    }

    // 3. Cross-product fallback bounded to avoid excessive retries
    for (const idHit of idHits.slice(0, 4)) {
      for (const secHit of secHits.slice(0, 4)) {
        if (out.length >= 12) break
        addPair(idHit.value, secHit.value)
      }
    }

    return out
  } catch {
    return []
  }
}

export function buildGoogleAuthUrl(params: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  scopes: readonly string[]
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: params.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256'
  })
  return `${GOOGLE_AUTH_URL}?${query.toString()}`
}

export async function exchangeAuthorizationCode(
  params: {
    client: OAuthClientConfig
    code: string
    redirectUri: string
    codeVerifier: string
  },
  fetcher: HttpFetcher = fetch
): Promise<OAuthExchangeResult> {
  const body = new URLSearchParams({
    client_id: params.client.clientId,
    client_secret: params.client.clientSecret,
    code: params.code.trim(),
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: params.codeVerifier
  })
  const resp = await fetcher(params.client.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  const data = (await resp.json()) as Record<string, unknown>
  if (!resp.ok) {
    const desc = asString(data?.error_description) ?? asString(data?.error) ?? `HTTP ${resp.status}`
    throw new Error(`OAuth token exchange failed: ${desc}`)
  }

  const refreshToken = asString(data.refresh_token)
  const accessToken = asString(data.access_token)
  if (!refreshToken || !accessToken) {
    throw new Error('Google did not return a refresh_token (try revoking prior access or signing in with prompt=consent)')
  }

  const idToken = asString(data.id_token)
  const claims = decodeJwtPayload(idToken)
  let email = asString(claims?.email)
  let name = asString(claims?.name) ?? ''

  if (!email) {
    const profile = await fetchProfile(accessToken, fetcher)
    email = profile.email
    if (!name) name = profile.name
  }
  if (!email) {
    throw new Error('Could not resolve Google account email from OAuth response')
  }

  const expiresIn = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) ? data.expires_in : 3599
  return { email, name, refreshToken, accessToken, idToken, expiresIn }
}

export async function fetchProfile(
  accessToken: string,
  fetcher: HttpFetcher = fetch
): Promise<{ email: string | null; name: string }> {
  try {
    const resp = await fetcher(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!resp.ok) return { email: null, name: '' }
    const data = (await resp.json()) as Record<string, unknown>
    return {
      email: asString(data.email),
      name: asString(data.name) ?? ''
    }
  } catch {
    return { email: null, name: '' }
  }
}

export async function refreshWithClient(
  client: OAuthClientConfig,
  refreshToken: string,
  fetcher: HttpFetcher = fetch
): Promise<{ accessToken: string; idToken: string | null; expiresIn: number }> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  const resp = await fetcher(client.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  const data = (await resp.json()) as Record<string, unknown>
  if (!resp.ok) {
    const code = asString(data?.error)
    const desc = asString(data?.error_description) ?? code ?? `HTTP ${resp.status}`
    throw Object.assign(new Error(`Token refresh failed: ${desc}`), { oauthError: code })
  }
  const accessToken = asString(data.access_token)
  if (!accessToken) throw new Error('Token refresh returned no access_token')
  const expiresIn = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) ? data.expires_in : 3599
  return {
    accessToken,
    idToken: asString(data.id_token),
    expiresIn
  }
}

function isRetryableClientError(error: unknown): boolean {
  const code = (error as { oauthError?: string | null })?.oauthError?.toLowerCase() ?? ''
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    code === 'invalid_client' ||
    code === 'unauthorized_client' ||
    code === 'deleted_client' ||
    msg.includes('client secret is invalid') ||
    msg.includes('oauth client was not found') ||
    msg.includes('unauthorized_client')
  )
}

/**
 * Refresh using ordered OAuth client candidates, falling back cleanly if the first local client
 * (e.g. a corrupted/mismatched acp_token.json or sandbox slot in agy.exe) rejects the secret.
 */
export async function refreshWithOAuthCandidates(
  candidates: readonly OAuthClientConfig[],
  refreshToken: string,
  fetcher: HttpFetcher = fetch
): Promise<{ accessToken: string; idToken: string | null; expiresIn: number; client: OAuthClientConfig }> {
  let lastError: unknown = new Error('OAuth client config not found')
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    try {
      const refreshed = await refreshWithClient(candidate, refreshToken, fetcher)
      cachedWorkingClient = candidate
      return { ...refreshed, client: candidate }
    } catch (error) {
      lastError = error
      if (!isRetryableClientError(error) || i === candidates.length - 1) {
        throw error
      }
    }
  }
  return lastError instanceof Error ? Promise.reject(lastError) : Promise.reject(new Error(String(lastError)))
}

export async function resolveImportedAgyIdentity(
  login: { email: string | null; refreshToken: string; accessToken: string | null },
  clients: readonly OAuthClientConfig[],
  fetcher: HttpFetcher = fetch
): Promise<{ email: string | null; name: string; warmedToken: { accessToken: string; expiresIn: number } | null }> {
  if (login.email) return { email: login.email, name: '', warmedToken: null }
  if (clients.length > 0) {
    try {
      const refreshed = await refreshWithOAuthCandidates(clients, login.refreshToken, fetcher)
      const profile = await fetchProfile(refreshed.accessToken, fetcher)
      return {
        email: profile.email,
        name: profile.name,
        warmedToken: { accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn }
      }
    } catch {
      return { email: null, name: '', warmedToken: null }
    }
  }
  if (login.accessToken) {
    const profile = await fetchProfile(login.accessToken, fetcher)
    return { email: profile.email, name: profile.name, warmedToken: null }
  }
  return { email: null, name: '', warmedToken: null }
}

export type PendingOAuthFlow = {
  authUrl: string
  redirectUri: string
  state: string
  codeVerifier: string
  client: OAuthClientConfig
  close(): void
}

/** Parse either a full redirected callback URL or a bare authorization code pasted manually. */
export function parseCallbackInput(rawInput: string, expectedState: string): { code: string } {
  const trimmed = rawInput.trim()
  if (!trimmed) throw new Error('Paste the callback URL or authorization code first')
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed)
    const err = url.searchParams.get('error')
    if (err) throw new Error(`Google sign-in returned error: ${err}`)
    const state = url.searchParams.get('state')
    if (state && state !== expectedState) throw new Error('OAuth state mismatch; start a fresh sign-in')
    const code = url.searchParams.get('code')
    if (!code) throw new Error('Callback URL has no ?code= parameter')
    return { code }
  }
  return { code: trimmed }
}

const SUCCESS_HTML = `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:40px;background:#111;color:#eee"><h2>Account connected to Orca</h2><p>You can close this tab and return to Orca Account Switcher.</p></body></html>`
const ERROR_HTML = (msg: string) =>
  `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:40px;background:#111;color:#f87171"><h2>Sign-in failed</h2><p>${msg.replace(/[<>&]/g, '')}</p></body></html>`

/** Start a local 127.0.0.1 loopback server to capture the Google OAuth callback automatically. */
export async function startLoopbackOAuthFlow(
  client: OAuthClientConfig,
  onCompleted: (result: { ok: true; account: OAuthExchangeResult } | { ok: false; error: string }) => void | Promise<void>,
  fetcher?: HttpFetcher
): Promise<PendingOAuthFlow> {
  const state = randomBytes(16).toString('hex')
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

  let closed = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (reqUrl.pathname !== '/auth/callback') {
      res.writeHead(404).end('Not found')
      return
    }
    const err = reqUrl.searchParams.get('error')
    const gotState = reqUrl.searchParams.get('state')
    const code = reqUrl.searchParams.get('code')

    if (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(ERROR_HTML(err))
      close()
      await onCompleted({ ok: false, error: `Google sign-in cancelled or failed: ${err}` })
      return
    }
    if (!code || gotState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(ERROR_HTML('Invalid OAuth state or missing code'))
      close()
      await onCompleted({ ok: false, error: 'Invalid OAuth callback state or missing code' })
      return
    }

    try {
      const account = await exchangeAuthorizationCode({ client, code, redirectUri, codeVerifier }, fetcher)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML)
      close()
      await onCompleted({ ok: true, account })
    } catch (exchangeErr) {
      const msg = exchangeErr instanceof Error ? exchangeErr.message : String(exchangeErr)
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(ERROR_HTML(msg))
      close()
      await onCompleted({ ok: false, error: msg })
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error) => reject(err)
    server.once('error', onListenError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onListenError)
      resolve()
    })
  })

  server.on('error', (err) => {
    if (closed) return
    close()
    void onCompleted({ ok: false, error: `OAuth loopback server error: ${err.message}` })
  })

  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : 0
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`
  const authUrl = buildGoogleAuthUrl({
    clientId: client.clientId,
    redirectUri,
    state,
    codeChallenge,
    scopes: client.scopes
  })

  const close = () => {
    if (closed) return
    closed = true
    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = null
    try {
      server.close()
    } catch {
      // Ignore
    }
  }

  timeoutHandle = setTimeout(() => {
    close()
    void onCompleted({ ok: false, error: 'Google sign-in timed out after 3 minutes' })
  }, 180_000)

  return { authUrl, redirectUri, state, codeVerifier, client, close }
}
