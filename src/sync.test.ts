import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { resolvePlatformPaths } from './platform'
import { invalidateAgyAcpSession, syncAgyCredentialsAfterOrcaSelect } from './sync'
import { saveVaultAccount } from './vault'
import * as main from './worker'

test('invalidateAgyAcpSession writes .token_timestamp and touches credentials in geminiDir and orcaAcpDir', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-sync-test-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    mkdirSync(paths.geminiDir, { recursive: true })
    mkdirSync(paths.orcaAcpDir, { recursive: true })
    mkdirSync(paths.orcaChatDir, { recursive: true })
    writeFileSync(paths.orcaAcpTokenPath, '{}')
    writeFileSync(path.join(paths.geminiDir, 'jetski-standalone-oauth-token'), '{}')

    const res = invalidateAgyAcpSession(paths)
    assert.equal(res.success, true)
    assert.ok(typeof res.timestamp === 'number')

    const acpStampPath = path.join(paths.orcaAcpDir, '.token_timestamp')
    const geminiStampPath = path.join(paths.geminiDir, '.token_timestamp')
    assert.equal(existsSync(acpStampPath), true)
    assert.equal(existsSync(geminiStampPath), true)

    const acpStamp = JSON.parse(readFileSync(acpStampPath, 'utf8')) as { timestamp: number }
    assert.equal(acpStamp.timestamp, res.timestamp)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('syncAgyCredentialsAfterOrcaSelect syncs credentials when account matches AGY Vault', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-sync-vault-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    mkdirSync(paths.geminiDir, { recursive: true })
    mkdirSync(paths.orcaAcpDir, { recursive: true })
    mkdirSync(paths.orcaChatDir, { recursive: true })
    writeFileSync(
      paths.orcaAcpTokenPath,
      JSON.stringify({ client_id: 'cid', client_secret: 'csec', refresh_token: 'rt-old', token_uri: 'https://oauth.test/token' })
    )

    const host = mockHost({
      settings: { pollSeconds: 0, showAgyPool: true, checkUpdates: false }
    })

    let capturedOrca!: OrcaWorkerApi
    const worker = await mountWorker(
      {
        default: (orca) => {
          capturedOrca = orca
          return main.default(orca, { paths, platform: 'other' as NodeJS.Platform })
        },
        deactivate: main.deactivate
      },
      { host }
    )

    // Save account in vault
    await saveVaultAccount(capturedOrca, {
      email: 'matched@gmail.com',
      name: 'Matched User',
      refreshToken: 'rt-matched',
      source: 'oauth'
    })

    const syncRes = await syncAgyCredentialsAfterOrcaSelect({
      orca: capturedOrca,
      account: 'ag-matched-id',
      paths,
      platform: 'other' as NodeJS.Platform,
      providers: [
        {
          agent: 'antigravity',
          title: 'Antigravity',
          supportsSystemDefault: false,
          activeAccountId: 'ag-old',
          selectedAccountId: 'ag-old',
          systemDefaultLabel: null,
          accounts: [
            {
              id: 'ag-matched-id',
              label: 'Matched User',
              email: 'matched@gmail.com',
              active: false,
              needsSignIn: false,
              buckets: [],
              effectiveRemaining: 100
            }
          ]
        }
      ],
      fetcher: async (url) => {
        if (url === 'https://oauth.test/token') {
          return { ok: true, status: 200, json: async () => ({ access_token: 'at-matched-fresh', expires_in: 3600 }) }
        }
        return { ok: true, status: 200, json: async () => ({}) }
      }
    })

    assert.equal(syncRes.synced, true)
    assert.equal(syncRes.email, 'matched@gmail.com')

    // Verify ~/.gemini and Orca ACP credentials were fully written
    const jetski = JSON.parse(readFileSync(path.join(paths.geminiDir, 'jetski-standalone-oauth-token'), 'utf8')) as {
      token: { access_token: string; refresh_token: string }
    }
    assert.equal(jetski.token.access_token, 'at-matched-fresh')
    assert.equal(jetski.token.refresh_token, 'rt-matched')

    const oauthCreds = JSON.parse(readFileSync(path.join(paths.geminiDir, 'oauth_creds.json'), 'utf8')) as {
      access_token: string
      refresh_token: string
    }
    assert.equal(oauthCreds.access_token, 'at-matched-fresh')
    assert.equal(oauthCreds.refresh_token, 'rt-matched')

    const acp = JSON.parse(readFileSync(paths.orcaAcpTokenPath, 'utf8')) as { refresh_token: string }
    assert.equal(acp.refresh_token, 'rt-matched')

    await worker.deactivate()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('syncAgyCredentialsAfterOrcaSelect syncs credentials when account matches ~/.antigravity_tools/accounts', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-sync-tools-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    mkdirSync(paths.geminiDir, { recursive: true })
    mkdirSync(paths.orcaAcpDir, { recursive: true })
    mkdirSync(paths.orcaChatDir, { recursive: true })
    mkdirSync(paths.agyAccountsDir, { recursive: true })
    writeFileSync(
      paths.orcaAcpTokenPath,
      JSON.stringify({ client_id: 'cid', client_secret: 'csec', refresh_token: 'rt-old', token_uri: 'https://oauth.test/token' })
    )

    // Write account into ~/.antigravity_tools/accounts/tools-uuid.json
    writeFileSync(
      path.join(paths.agyAccountsDir, 'tools-uuid.json'),
      JSON.stringify({
        id: 'tools-uuid',
        email: 'tools@gmail.com',
        name: 'Tools User',
        token: {
          access_token: 'at-tools',
          refresh_token: 'rt-tools',
          expires_in: 3600,
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        }
      })
    )

    const host = mockHost({
      settings: { pollSeconds: 0, showAgyPool: true, checkUpdates: false }
    })

    let capturedOrca!: OrcaWorkerApi
    const worker = await mountWorker(
      {
        default: (orca) => {
          capturedOrca = orca
          return main.default(orca, { paths, platform: 'other' as NodeJS.Platform })
        },
        deactivate: main.deactivate
      },
      { host }
    )

    const syncRes = await syncAgyCredentialsAfterOrcaSelect({
      orca: capturedOrca,
      account: 'tools-uuid',
      paths,
      platform: 'other' as NodeJS.Platform,
      providers: [
        {
          agent: 'antigravity',
          title: 'Antigravity',
          supportsSystemDefault: false,
          activeAccountId: 'other',
          selectedAccountId: 'other',
          systemDefaultLabel: null,
          accounts: [
            {
              id: 'tools-uuid',
              label: 'Tools User',
              email: 'tools@gmail.com',
              active: false,
              needsSignIn: false,
              buckets: [],
              effectiveRemaining: 80
            }
          ]
        }
      ],
      fetcher: async (url) => {
        if (url === 'https://oauth.test/token') {
          return { ok: true, status: 200, json: async () => ({ access_token: 'at-tools-fresh', expires_in: 3600 }) }
        }
        return { ok: true, status: 200, json: async () => ({}) }
      }
    })

    assert.equal(syncRes.synced, true)
    assert.equal(syncRes.email, 'tools@gmail.com')

    const acp = JSON.parse(readFileSync(paths.orcaAcpTokenPath, 'utf8')) as { refresh_token: string }
    assert.equal(acp.refresh_token, 'rt-tools')

    await worker.deactivate()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('syncAgyCredentialsAfterOrcaSelect imports and syncs when Orca account store contains refreshToken', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-sync-store-token-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    mkdirSync(paths.geminiDir, { recursive: true })
    mkdirSync(paths.orcaAcpDir, { recursive: true })
    mkdirSync(paths.orcaChatDir, { recursive: true })
    writeFileSync(
      paths.orcaAcpTokenPath,
      JSON.stringify({ client_id: 'cid', client_secret: 'csec', refresh_token: 'rt-old', token_uri: 'https://oauth.test/token' })
    )

    const host = mockHost({
      settings: { pollSeconds: 0, showAgyPool: true, checkUpdates: false }
    })

    let capturedOrca!: OrcaWorkerApi
    const worker = await mountWorker(
      {
        default: (orca) => {
          capturedOrca = orca
          return main.default(orca, { paths, platform: 'other' as NodeJS.Platform })
        },
        deactivate: main.deactivate
      },
      { host }
    )

    const syncRes = await syncAgyCredentialsAfterOrcaSelect({
      orca: capturedOrca,
      account: 'account-with-token',
      paths,
      platform: 'other' as NodeJS.Platform,
      providers: [
        {
          agent: 'antigravity',
          title: 'Antigravity',
          supportsSystemDefault: false,
          activeAccountId: 'other',
          selectedAccountId: 'other',
          systemDefaultLabel: null,
          accounts: [
            {
              id: 'account-with-token',
              label: 'Direct Token Account',
              email: 'direct@gmail.com',
              active: false,
              needsSignIn: false,
              buckets: [],
              effectiveRemaining: 90,
              refreshToken: 'rt-direct'
            }
          ]
        }
      ],
      fetcher: async (url) => {
        if (url === 'https://oauth.test/token') {
          return { ok: true, status: 200, json: async () => ({ access_token: 'at-direct-fresh', expires_in: 3600 }) }
        }
        return { ok: true, status: 200, json: async () => ({}) }
      }
    })

    assert.equal(syncRes.synced, true)
    assert.equal(syncRes.email, 'direct@gmail.com')

    const acp = JSON.parse(readFileSync(paths.orcaAcpTokenPath, 'utf8')) as { refresh_token: string }
    assert.equal(acp.refresh_token, 'rt-direct')

    const jetski = JSON.parse(readFileSync(path.join(paths.geminiDir, 'jetski-standalone-oauth-token'), 'utf8')) as {
      token: { access_token: string; refresh_token: string }
    }
    assert.equal(jetski.token.refresh_token, 'rt-direct')

    await worker.deactivate()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('worker performOrcaSelect bi-directionally syncs agy CLI credentials when selecting antigravity provider account', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-select-bidirectional-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    mkdirSync(paths.geminiDir, { recursive: true })
    mkdirSync(paths.orcaAcpDir, { recursive: true })
    mkdirSync(paths.orcaChatDir, { recursive: true })
    mkdirSync(paths.agyAccountsDir, { recursive: true })
    writeFileSync(
      paths.orcaAcpTokenPath,
      JSON.stringify({ client_id: 'cid', client_secret: 'csec', refresh_token: 'rt-initial', token_uri: 'https://oauth.test/token' })
    )

    // Account 2 in agy tools
    writeFileSync(
      path.join(paths.agyAccountsDir, 'ag-2.json'),
      JSON.stringify({
        id: 'ag-2',
        email: 'two@gmail.com',
        name: 'Two User',
        token: {
          access_token: 'at-two',
          refresh_token: 'rt-two',
          expires_in: 3600,
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
        }
      })
    )

    let selectedOrcaId = 'ag-1'
    const cliCalls: string[][] = []

    const host = mockHost({
      settings: { pollSeconds: 0, showAgyPool: true, checkUpdates: false }
    })

    const worker = await mountWorker(
      {
        default: (orca) =>
          main.default(orca, {
            paths,
            platform: 'other' as NodeJS.Platform,
            findOrca: () => '/usr/bin/orca',
            findAgy: () => null,
            runner: async (_exe, args) => {
              cliCalls.push([...args])
              if (args[1] === 'select') {
                selectedOrcaId = args[5]
                return { code: 0, stdout: '{"ok":true}', stderr: '' }
              }
              return {
                code: 0,
                stderr: '',
                stdout: JSON.stringify({
                  ok: true,
                  result: {
                    antigravity: {
                      accounts: [
                        { id: 'ag-1', email: 'one@gmail.com' },
                        { id: 'ag-2', email: 'two@gmail.com' }
                      ],
                      activeAccountId: selectedOrcaId
                    }
                  }
                })
              }
            },
            fetcher: async (url) => {
              if (url === 'https://oauth.test/token') {
                return { ok: true, status: 200, json: async () => ({ access_token: 'at-two-fresh', expires_in: 3600 }) }
              }
              return { ok: true, status: 200, json: async () => ({ groups: [] }) }
            }
          }),
        deactivate: main.deactivate
      },
      { host }
    )

    // Perform selectOrca on antigravity provider
    const res = await worker.request('accounts.selectOrca', { agent: 'antigravity', account: 'ag-2' })
    assert.equal(res.ok, true)
    assert.ok(res.message.includes('ag-2'))
    assert.ok(res.message.includes('two@gmail.com'))

    // Verify agy CLI credentials were synchronized!
    const acp = JSON.parse(readFileSync(paths.orcaAcpTokenPath, 'utf8')) as { refresh_token: string }
    assert.equal(acp.refresh_token, 'rt-two')

    const jetski = JSON.parse(readFileSync(path.join(paths.geminiDir, 'jetski-standalone-oauth-token'), 'utf8')) as {
      token: { access_token: string; refresh_token: string }
    }
    assert.equal(jetski.token.refresh_token, 'rt-two')
    assert.equal(jetski.token.access_token, 'at-two-fresh')

    await worker.deactivate()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
