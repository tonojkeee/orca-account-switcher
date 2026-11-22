import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, test } from 'orca/testing'
import {
  clearAgyTokenCache,
  fetchAgyPoolState,
  parseCloudCodeQuotaResponse,
  sortAgyPoolAccounts,
  switchAgyPoolAccount,
  type QuotaFetcher
} from './agy-pool'
import { resolvePlatformPaths } from './platform'

test('parseCloudCodeQuotaResponse computes remaining %, effectiveGemini, and resetTime timestamps', () => {
  const parsed = parseCloudCodeQuotaResponse({
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { window: '5h', remainingFraction: 0.8, resetTime: '2026-11-22T15:00:00Z' },
          { window: 'weekly', remainingFraction: 0.45, resetTime: '2026-11-28T00:00:00Z' }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { window: '5h', remainingFraction: 1.0 },
          { window: 'weekly', remainingFraction: 0.9 }
        ]
      }
    ]
  })
  assert.equal(parsed.gemini5h, 80)
  assert.equal(parsed.geminiWeekly, 45)
  assert.equal(parsed.effectiveGemini, 45)
  assert.equal(parsed.claudeWeekly, 90)
  assert.equal(parsed.gemini5hResetsAt, Date.parse('2026-11-22T15:00:00Z'))
  assert.equal(parsed.geminiWeeklyResetsAt, Date.parse('2026-11-28T00:00:00Z'))
})

test('fetchAgyPoolState and switchAgyPoolAccount merge Vault + AGY Tools and switch agy CLI without external managers', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-agy-test-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    mkdirSync(paths.agyAccountsDir, { recursive: true })
    mkdirSync(paths.orcaAcpDir, { recursive: true })
    mkdirSync(paths.geminiDir, { recursive: true })

    writeFileSync(
      paths.orcaAcpTokenPath,
      JSON.stringify({ client_id: 'cid', client_secret: 'csec', refresh_token: 'rt-old', token_uri: 'https://oauth.test/token' })
    )
    writeFileSync(path.join(paths.geminiDir, 'google_accounts.json'), JSON.stringify({ active: 'low@gmail.com' }))

    writeFileSync(
      path.join(paths.agyAccountsDir, 'a.json'),
      JSON.stringify({ email: 'low@gmail.com', name: 'Low', token: { refresh_token: 'rt-low' } })
    )

    const vaultAccounts = [
      { email: 'vault@gmail.com', name: 'Vault User', source: 'oauth' as const, addedAt: 1, refreshToken: 'rt-vault' }
    ]

    const fakeFetch: QuotaFetcher = async (url, init) => {
      if (url === 'https://oauth.test/token') {
        const body = String(init.body)
        const token = body.includes('rt-vault') ? 'at-vault' : 'at-low'
        return { ok: true, status: 200, json: async () => ({ access_token: token, expires_in: 3600 }) }
      }
      const auth = (init.headers as Record<string, string>).Authorization
      const rem = auth === 'Bearer at-vault' ? 0.95 : 0.1
      return {
        ok: true,
        status: 200,
        json: async () => ({
          groups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: rem }, { window: 'weekly', remainingFraction: rem }] }]
        })
      }
    }

    const state = await fetchAgyPoolState({
      paths,
      platform: 'other' as NodeJS.Platform,
      vaultAccounts,
      fetcher: fakeFetch,
      refreshQuotas: true
    })
    assert.equal(state.available, true)
    assert.equal(state.oauthReady, true)
    assert.equal(state.activeEmail, 'low@gmail.com')
    assert.equal(state.bestEmail, 'vault@gmail.com')
    assert.equal(state.accounts[0].source, 'vault')
    assert.equal(state.accounts[0].effectiveGemini, 95)

    const switched = await switchAgyPoolAccount('vault@gmail.com', {
      paths,
      platform: 'other' as NodeJS.Platform,
      vaultAccounts,
      fetcher: fakeFetch
    })
    assert.equal(switched.ok, true)
    const nextAcp = JSON.parse(readFileSync(paths.orcaAcpTokenPath, 'utf8')) as { refresh_token: string }
    assert.equal(nextAcp.refresh_token, 'rt-vault')
    const nextJetski = JSON.parse(readFileSync(path.join(paths.geminiDir, 'jetski-standalone-oauth-token'), 'utf8')) as {
      id_token_email: string
      token: { access_token: string; refresh_token: string }
    }
    assert.equal(nextJetski.id_token_email, 'vault@gmail.com')
    assert.equal(nextJetski.token.access_token, 'at-vault')
    assert.equal(existsSync(path.join(paths.orcaChatDir, 'jetski-standalone-oauth-token')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('sortAgyPoolAccounts orders by effectiveGemini then geminiWeekly then claude5h', () => {
  const sorted = sortAgyPoolAccounts([
    { email: 'a', name: '', source: 'vault', active: false, gemini5h: 50, geminiWeekly: 50, claude5h: 100, claudeWeekly: 100, effectiveGemini: 50, error: null },
    { email: 'b', name: '', source: 'vault', active: false, gemini5h: 80, geminiWeekly: 80, claude5h: 10, claudeWeekly: 10, effectiveGemini: 80, error: null },
    { email: 'err', name: '', source: 'agy-tools', active: false, gemini5h: null, geminiWeekly: null, claude5h: null, claudeWeekly: null, effectiveGemini: null, error: 'fail' }
  ])
  assert.deepEqual(sorted.map((x) => x.email), ['b', 'a', 'err'])
})

test('fetchAgyPoolState polls sequentially with jitter and reuses cached access_token', async () => {
  clearAgyTokenCache()
  const home = mkdtempSync(path.join(tmpdir(), 'orca-agy-seq-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    mkdirSync(paths.orcaAcpDir, { recursive: true })
    mkdirSync(paths.geminiDir, { recursive: true })
    writeFileSync(
      paths.orcaAcpTokenPath,
      JSON.stringify({ client_id: 'cid', client_secret: 'csec', refresh_token: 'rt-1', token_uri: 'https://oauth.test/token' })
    )

    const vaultAccounts = [
      { email: 'one@gmail.com', name: 'One', source: 'oauth' as const, addedAt: 1, refreshToken: 'rt-1-seq-test' },
      { email: 'two@gmail.com', name: 'Two', source: 'oauth' as const, addedAt: 2, refreshToken: 'rt-2-seq-test' }
    ]

    let inFlight = 0
    let maxInFlight = 0
    let tokenCalls = 0
    let jitterCalls = 0

    const fakeFetch: QuotaFetcher = async (url) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await new Promise((r) => setTimeout(r, 5))
        if (url === 'https://oauth.test/token') {
          tokenCalls++
          return { ok: true, status: 200, json: async () => ({ access_token: `at-${tokenCalls}`, expires_in: 3600 }) }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            groups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.9 }, { window: 'weekly', remainingFraction: 0.9 }] }]
          })
        }
      } finally {
        inFlight--
      }
    }

    await fetchAgyPoolState({
      paths,
      platform: 'other' as NodeJS.Platform,
      vaultAccounts,
      fetcher: fakeFetch,
      jitterMs: () => {
        jitterCalls++
        return 0
      }
    })
    assert.equal(maxInFlight, 1)
    assert.equal(jitterCalls, 1)
    assert.equal(tokenCalls, 2)

    // Second quota poll reuses cached access tokens with zero extra /token refreshes.
    await fetchAgyPoolState({
      paths,
      platform: 'other' as NodeJS.Platform,
      vaultAccounts,
      fetcher: fakeFetch,
      jitterMs: () => 0
    })
    assert.equal(tokenCalls, 2)
  } finally {
    clearAgyTokenCache()
    rmSync(home, { recursive: true, force: true })
  }
})

test('fetchAgyPoolState trips 429 circuit breaker immediately without polling remaining accounts', async () => {
  clearAgyTokenCache()
  const home = mkdtempSync(path.join(tmpdir(), 'orca-agy-429-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    mkdirSync(paths.orcaAcpDir, { recursive: true })
    mkdirSync(paths.geminiDir, { recursive: true })
    writeFileSync(
      paths.orcaAcpTokenPath,
      JSON.stringify({ client_id: 'cid', client_secret: 'csec', token_uri: 'https://oauth.test/token' })
    )

    const vaultAccounts = [
      { email: 'one@gmail.com', name: 'One', source: 'oauth' as const, addedAt: 1, refreshToken: 'rt-429-1' },
      { email: 'two@gmail.com', name: 'Two', source: 'oauth' as const, addedAt: 2, refreshToken: 'rt-429-2' },
      { email: 'three@gmail.com', name: 'Three', source: 'oauth' as const, addedAt: 3, refreshToken: 'rt-429-3' }
    ]

    let quotaCalls = 0
    const state = await fetchAgyPoolState({
      paths,
      platform: 'other' as NodeJS.Platform,
      vaultAccounts,
      jitterMs: () => 0,
      fetcher: async (url) => {
        if (url === 'https://oauth.test/token') {
          return { ok: true, status: 200, json: async () => ({ access_token: 'at-429', expires_in: 3600 }) }
        }
        quotaCalls++
        return { ok: false, status: 429, json: async () => ({}) }
      }
    })

    assert.equal(quotaCalls, 1)
    assert.ok(state.error?.includes('429'))
    assert.equal(state.accounts.length, 3)
    assert.equal(state.accounts[0].error, 'Quota HTTP 429')
    assert.equal(state.accounts[1].error, 'Skipped (rate limit protection)')
    assert.equal(state.accounts[2].error, 'Skipped (rate limit protection)')
  } finally {
    clearAgyTokenCache()
    rmSync(home, { recursive: true, force: true })
  }
})
