import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, test } from 'orca/testing'
import {
  buildGoogleAuthUrl,
  exchangeAuthorizationCode,
  parseCallbackInput,
  resolveOAuthClient,
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
