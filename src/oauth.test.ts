import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, test } from 'orca/testing'
import {
  buildGoogleAuthUrl,
  clearOAuthClientCache,
  exchangeAuthorizationCode,
  parseCallbackInput,
  refreshWithOAuthCandidates,
  resolveOAuthClient,
  resolveOAuthClientCandidates,
  startLoopbackOAuthFlow
} from './oauth'
import { resolvePlatformPaths } from './platform'

test('resolveOAuthClient reads settings override and acp_token.json', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-oauth-test-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    assert.equal(resolveOAuthClient(paths, {}, null), null)

    const custom = resolveOAuthClient(paths, { oauthClientId: 'id-1', oauthClientSecret: 'sec-1' }, null)
    assert.equal(custom?.clientId, 'id-1')
    assert.equal(custom?.clientSecret, 'sec-1')

    mkdirSync(paths.orcaAcpDir, { recursive: true })
    writeFileSync(
      paths.orcaAcpTokenPath,
      JSON.stringify({ client_id: 'acp-id', client_secret: 'acp-sec', token_uri: 'https://oauth2.googleapis.com/token' })
    )
    const fromAcp = resolveOAuthClient(paths, {}, null)
    assert.equal(fromAcp?.clientId, 'acp-id')
    assert.equal(fromAcp?.clientSecret, 'acp-sec')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('buildGoogleAuthUrl, parseCallbackInput, and exchangeAuthorizationCode work end-to-end', async () => {
  const url = buildGoogleAuthUrl({
    clientId: 'cid',
    redirectUri: 'http://127.0.0.1:1234/auth/callback',
    state: 'st-1',
    codeChallenge: 'ch-1',
    scopes: ['openid', 'email']
  })
  assert.ok(url.includes('access_type=offline'))
  assert.ok(url.includes('code_challenge_method=S256'))

  assert.deepEqual(
    parseCallbackInput('http://127.0.0.1:1234/auth/callback?code=abc&state=st-1', 'st-1'),
    { code: 'abc' }
  )
  assert.deepEqual(parseCallbackInput('raw-code', 'st-1'), { code: 'raw-code' })
  assert.throws(() => parseCallbackInput('http://127.0.0.1:1234/auth/callback?code=abc&state=wrong', 'st-1'))

  const jwtBody = Buffer.from(JSON.stringify({ email: 'oauth@gmail.com', name: 'OAuth User' })).toString('base64url')
  const res = await exchangeAuthorizationCode(
    {
      client: {
        clientId: 'cid',
        clientSecret: 'csec',
        tokenUri: 'https://oauth.test/token',
        scopes: ['openid'],
        rawTemplate: {}
      },
      code: 'abc',
      redirectUri: 'http://127.0.0.1:1234/auth/callback',
      codeVerifier: 'ver'
    },
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        id_token: `h.${jwtBody}.s`,
        expires_in: 3600
      })
    })
  )
  assert.equal(res.email, 'oauth@gmail.com')
  assert.equal(res.name, 'OAuth User')
  assert.equal(res.refreshToken, 'rt-1')
})

test('startLoopbackOAuthFlow binds localhost port and handles error callback cleanly', async () => {
  const outcomes: { ok: boolean; error?: string }[] = []
  const flow = await startLoopbackOAuthFlow(
    {
      clientId: 'cid',
      clientSecret: 'csec',
      tokenUri: 'https://oauth.test/token',
      scopes: ['openid'],
      rawTemplate: {}
    },
    (outcome) => {
      outcomes.push(outcome)
    }
  )
  try {
    assert.ok(flow.redirectUri.startsWith('http://127.0.0.1:'))
    const resp = await fetch(`${flow.redirectUri}?error=access_denied&state=${flow.state}`)
    assert.equal(resp.status, 400)
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].ok, false)
  } finally {
    flow.close()
  }
})

test('startLoopbackOAuthFlow completes end-to-end callback exchange with injected fetcher', async () => {
  const outcomes: { ok: boolean; email?: string }[] = []
  const jwtBody = Buffer.from(JSON.stringify({ email: 'loop@gmail.com', name: 'Loopback' })).toString('base64url')
  const flow = await startLoopbackOAuthFlow(
    {
      clientId: 'cid',
      clientSecret: 'csec',
      tokenUri: 'https://oauth.test/token',
      scopes: ['openid'],
      rawTemplate: {}
    },
    (outcome) => {
      outcomes.push(outcome.ok ? { ok: true, email: outcome.account.email } : { ok: false })
    },
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'at-loop',
        refresh_token: 'rt-loop',
        id_token: `h.${jwtBody}.s`,
        expires_in: 3600
      })
    })
  )
  try {
    const resp = await fetch(`${flow.redirectUri}?code=good-code&state=${flow.state}`)
    assert.equal(resp.status, 200)
    assert.equal(outcomes.length, 1)
    assert.deepEqual(outcomes[0], { ok: true, email: 'loop@gmail.com' })
  } finally {
    flow.close()
  }
})

test('extracts exact 35-char GOCSPX secrets from Go .rodata concatenated strings and retries on invalid_client', async () => {
  clearOAuthClientCache()
  const home = mkdtempSync(path.join(tmpdir(), 'orca-oauth-bin-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    mkdirSync(paths.orcaAcpDir, { recursive: true })
    mkdirSync(paths.geminiDir, { recursive: true })

    // Simulate Go binary .rodata where secrets are concatenated directly against "https://" and "cloudcode-pa.sandbox"
    const sec0 = 'GOCSPX-' + 'a'.repeat(28)
    const sec1 = 'GOCSPX-' + 'b'.repeat(28)
    const id0 = '884354919052-abcdef123456.apps.googleusercontent.com'
    const id1 = '1071006060591-zyxwvu654321.apps.googleusercontent.com'
    const fakeBin = path.join(home, 'agy.exe')
    writeFileSync(
      fakeBin,
      `PRE${sec0}https://cloudcode-pa${sec1}cloudcode-pa.sandbox` + '\0'.repeat(9000) + `${id0}SetUser${id1}GetHub`
    )

    // Prioritize prod 1071006060591 slot with clean 35-char secret (without trailing "cloudcode-pa")
    const primary = resolveOAuthClient(paths, {}, fakeBin)
    assert.equal(primary?.clientId, id1)
    assert.equal(primary?.clientSecret, sec1)
    assert.equal(primary?.clientSecret.length, 35)

    // Simulate a poisoned acp_token.json written earlier + valid binary fallback
    writeFileSync(
      paths.orcaAcpTokenPath,
      JSON.stringify({ client_id: id0, client_secret: 'GOCSPX-' + 'c'.repeat(28) + 'cloudcode-pa' })
    )
    const candidates = resolveOAuthClientCandidates(paths, {}, fakeBin)
    assert.ok(candidates.some((c) => c.clientSecret === 'GOCSPX-' + 'c'.repeat(28)))
    assert.ok(candidates.some((c) => c.clientId === id1 && c.clientSecret === sec1))

    // refreshWithOAuthCandidates skips candidates rejected with invalid_client and remembers working one
    const seenSecrets: string[] = []
    const refreshed = await refreshWithOAuthCandidates(candidates, 'rt-1', async (_url, init) => {
      const params = new URLSearchParams(String(init?.body))
      const cid = params.get('client_id') ?? ''
      const csec = params.get('client_secret') ?? ''
      seenSecrets.push(csec)
      if (cid === id1 && csec === sec1) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'at-ok', expires_in: 3600 }) }
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_client', error_description: 'The provided client secret is invalid.' })
      }
    })
    assert.equal(refreshed.accessToken, 'at-ok')
    assert.equal(refreshed.client.clientId, id1)
    assert.ok(seenSecrets.length >= 2)
  } finally {
    clearOAuthClientCache()
    rmSync(home, { recursive: true, force: true })
  }
})
