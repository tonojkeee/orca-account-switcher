// Standalone cross-platform Google OAuth2 PKCE + loopback flow for adding AGY accounts without external managers.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { decodeJwtPayload } from './keyring'
import { asString } from './parse'
import { findAgyCli, readJsonObject, type PlatformPaths } from './platform'

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

/**
 * Resolve Google Desktop OAuth client credentials from local runtime artifacts without hardcoding secrets:
 * 1) Explicit plugin settings override, 2) Orca acp_token.json, 3) ~/.gemini/oauth_creds.json, 4) local `agy` binary.
 */
export function resolveOAuthClient(
  paths: PlatformPaths,
  settings: { oauthClientId?: string; oauthClientSecret?: string } = {},
  agyBin: string | null = findAgyCli()
): OAuthClientConfig | null {
  const customId = settings.oauthClientId?.trim()
  const customSecret = settings.oauthClientSecret?.trim()
  if (customId && customSecret) {
    return {
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
      return {
        clientId,
        clientSecret,
        tokenUri: asString(obj.token_uri) ?? GOOGLE_TOKEN_URL,
        scopes: mergeAgyScopes(scopes),
        source: candidate.source,
        rawTemplate: obj
      }
    }
  }

  if (agyBin) {
    const extracted = extractOAuthClientFromBinary(agyBin)
    if (extracted) return extracted
  }

  return null
}

function extractOAuthClientFromBinary(binPath: string): OAuthClientConfig | null {
  try {
    const buf = readFileSync(binPath)
    const idMarker = Buffer.from('.apps.googleusercontent.com', 'utf8')
    const idIdx = buf.indexOf(idMarker)
    if (idIdx === -1) return null
    const idStart = Math.max(0, idIdx - 96)
    const idSlice = buf.slice(idStart, idIdx + idMarker.length).toString('latin1')
    const idMatch = /(\d{6,}-[a-z0-9]{12,}\.apps\.googleusercontent\.com)/.exec(idSlice)
    if (!idMatch) return null

    const secretMarker = Buffer.from('GOCSPX-', 'utf8')
    // Search nearby first, then whole binary
    const windowStart = Math.max(0, idIdx - 4096)
    const windowEnd = Math.min(buf.length, idIdx + 4096)
    let secIdx = buf.slice(windowStart, windowEnd).indexOf(secretMarker)
    let secSlice = ''
    if (secIdx !== -1) {
      secSlice = buf.slice(windowStart + secIdx, Math.min(buf.length, windowStart + secIdx + 64)).toString('latin1')
    } else {
      secIdx = buf.indexOf(secretMarker)
      if (secIdx !== -1) {
        secSlice = buf.slice(secIdx, Math.min(buf.length, secIdx + 64)).toString('latin1')
      }
    }
    const secMatch = /(GOCSPX-[A-Za-z0-9_-]{20,40})/.exec(secSlice)
    if (!secMatch) return null

    return {
      clientId: idMatch[1],
      clientSecret: secMatch[1],
      tokenUri: GOOGLE_TOKEN_URL,
      scopes: DEFAULT_SCOPES,
      source: 'agy-binary',
      rawTemplate: {
        client_id: idMatch[1],
        client_secret: secMatch[1],
        token_uri: GOOGLE_TOKEN_URL,
        scopes: DEFAULT_SCOPES
      }
    }
  } catch {
    return null
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
    const desc = asString(data?.error_description) ?? asString(data?.error) ?? `HTTP ${resp.status}`
    throw new Error(`Token refresh failed: ${desc}`)
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
