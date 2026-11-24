import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  applyAgyRemovalToSnapshot,
  applyOrcaRemovalToSnapshot,
  removeAgyAccountEverywhere,
  removeAgyToolsAccountFiles,
  removeOrcaAccountWithGuard
} from './account-remove'
import { resolvePlatformPaths } from './platform'
import type { AccountsSnapshot, OrcaProviderState } from './protocol'
import { listVaultAccounts, saveVaultAccount } from './vault'

function createTestPaths(home: string) {
  const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
  mkdirSync(paths.agyAccountsDir, { recursive: true })
  mkdirSync(paths.orcaAcpDir, { recursive: true })
  mkdirSync(paths.geminiDir, { recursive: true })
  return paths
}

function createMockOrca(): OrcaWorkerApi {
  const store = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  return {
    storage: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => {
        store.set(k, v)
      },
      delete: async (k: string) => {
        store.delete(k)
      }
    },
    secrets: {
      get: async (k: string) => secrets.get(k) ?? null,
      set: async (k: string, v: string) => {
        secrets.set(k, v)
      },
      delete: async (k: string) => {
        secrets.delete(k)
      }
    },
    panels: { post: () => {} },
    host: { call: async () => {} }
  } as unknown as OrcaWorkerApi
}

test('removeAgyToolsAccountFiles deletes profile json and updates accounts.json index cleanly', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-rm-tools-'))
  try {
    const paths = createTestPaths(home)
    const uuid1 = 'acc-uuid-1'
    const uuid2 = 'acc-uuid-2'

    // Write two tool profile files
    writeFileSync(
      path.join(paths.agyAccountsDir, `${uuid1}.json`),
      JSON.stringify({ id: uuid1, email: 'user1@example.com', name: 'User 1', token: { refresh_token: 'rt1' } })
    )
    writeFileSync(
      path.join(paths.agyAccountsDir, `${uuid2}.json`),
      JSON.stringify({ id: uuid2, email: 'user2@example.com', name: 'User 2', token: { refresh_token: 'rt2' } })
    )

    // Write index accounts.json
    const accountsIndexPath = path.join(path.dirname(paths.agyAccountsDir), 'accounts.json')
    writeFileSync(
      accountsIndexPath,
      JSON.stringify({
        version: '2.0',
        accounts: [
          { id: uuid1, email: 'user1@example.com', name: 'User 1' },
          { id: uuid2, email: 'user2@example.com', name: 'User 2' }
        ],
        current_account_id: uuid1,
        current_classic_account_id: uuid1,
        current_agy_account_id: uuid1
      })
    )

    const res = removeAgyToolsAccountFiles(paths, { email: 'user1@example.com', id: uuid1 }, uuid2)
    assert.equal(res.indexUpdated, true)
    assert.deepEqual(res.removedFiles, [`${uuid1}.json`])

    // Verify file is gone and other file remains
    assert.equal(existsSync(path.join(paths.agyAccountsDir, `${uuid1}.json`)), false)
    assert.equal(existsSync(path.join(paths.agyAccountsDir, `${uuid2}.json`)), true)

    // Verify accounts.json updated and active pointers switched to uuid2
    const updatedIndex = JSON.parse(readFileSync(accountsIndexPath, 'utf8'))
    assert.equal(updatedIndex.accounts.length, 1)
    assert.equal(updatedIndex.accounts[0].id, uuid2)
    assert.equal(updatedIndex.current_account_id, uuid2)
    assert.equal(updatedIndex.current_classic_account_id, uuid2)
    assert.equal(updatedIndex.current_agy_account_id, uuid2)

    // Idempotent: repeated removal returns 0 files, no crash
    const res2 = removeAgyToolsAccountFiles(paths, { email: 'user1@example.com', id: uuid1 }, uuid2)
    assert.deepEqual(res2.removedFiles, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('removeAgyAccountEverywhere: inactive account removal leaves gemini and orcaAcp untouched', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-rm-inactive-'))
  try {
    const paths = createTestPaths(home)

    // Write initial gemini and orca acp files
    const initialAcp = JSON.stringify({ client_id: 'cid', refresh_token: 'rt-active' })
    const initialGoogle = JSON.stringify({ active: 'active@example.com' })
    writeFileSync(paths.orcaAcpTokenPath, initialAcp)
    writeFileSync(path.join(paths.geminiDir, 'google_accounts.json'), initialGoogle)

    const orca = createMockOrca()

    // Save inactive account into Vault
    await saveVaultAccount(orca, {
      email: 'inactive@example.com',
      name: 'Inactive User',
      refreshToken: 'rt-inactive',
      source: 'oauth'
    })

    // Save into agy tools as well
    writeFileSync(
      path.join(paths.agyAccountsDir, 'inactive.json'),
      JSON.stringify({ id: 'inact-1', email: 'inactive@example.com', token: { refresh_token: 'rt-inactive' } })
    )

    const res = await removeAgyAccountEverywhere({
      orca,
      email: 'inactive@example.com',
      paths,
      platform: 'linux'
    })

    assert.equal(res.ok, true)
    assert.ok(res.message.includes('Removed inactive@example.com'))

    // Verify vault and tools are cleared
    const vaultRemaining = await listVaultAccounts(orca)
    assert.equal(vaultRemaining.length, 0)
    assert.equal(existsSync(path.join(paths.agyAccountsDir, 'inactive.json')), false)

    // STRICT INVARIANT CHECK: ~/.gemini and acp_token.json are 100% UNTOUCHED
    assert.equal(readFileSync(paths.orcaAcpTokenPath, 'utf8'), initialAcp)
    assert.equal(readFileSync(path.join(paths.geminiDir, 'google_accounts.json'), 'utf8'), initialGoogle)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('removeAgyAccountEverywhere: rejects removing last remaining active account', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-rm-last-'))
  try {
    const paths = createTestPaths(home)
    writeFileSync(path.join(paths.geminiDir, 'google_accounts.json'), JSON.stringify({ active: 'only@example.com' }))

    const orca = createMockOrca()

    await saveVaultAccount(orca, {
      email: 'only@example.com',
      name: 'Only User',
      refreshToken: 'rt-only',
      source: 'oauth'
    })

    const res = await removeAgyAccountEverywhere({
      orca,
      email: 'only@example.com',
      paths,
      platform: 'linux'
    })

    assert.equal(res.ok, false)
    assert.ok(res.message.includes('Cannot remove the last active account'))

    // Account remains in Vault
    const vaultRemaining = await listVaultAccounts(orca)
    assert.equal(vaultRemaining.length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('removeAgyAccountEverywhere: active account auto-switches to survivor before removing', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-rm-autoswitch-'))
  try {
    const paths = createTestPaths(home)
    writeFileSync(path.join(paths.geminiDir, 'google_accounts.json'), JSON.stringify({ active: 'active@example.com' }))
    writeFileSync(
      paths.orcaAcpTokenPath,
      JSON.stringify({ client_id: 'cid', client_secret: 'csec', refresh_token: 'rt-active', token_uri: 'https://oauth.test/token' })
    )

    const orca = createMockOrca()

    await saveVaultAccount(orca, {
      email: 'active@example.com',
      name: 'Active User',
      refreshToken: 'rt-active',
      source: 'oauth'
    })
    await saveVaultAccount(orca, {
      email: 'survivor@example.com',
      name: 'Survivor User',
      refreshToken: 'rt-survivor',
      source: 'oauth'
    })

    const fetcher = async (url: string, init: any) => {
      if (url.includes('/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'at-survivor', expires_in: 3600 }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }

    const res = await removeAgyAccountEverywhere({
      orca,
      email: 'active@example.com',
      paths,
      platform: 'linux',
      oauthClients: [{ clientId: 'cid', clientSecret: 'csec', tokenUri: 'https://oauth.test/token', scopes: [], source: 'settings' } as any],
      fetcher
    })

    assert.equal(res.ok, true)
    assert.equal(res.autoSwitchedTo, 'survivor@example.com')
    assert.ok(res.message.includes('Switched to survivor@example.com and removed active@example.com'))

    // Active login in ~/.gemini/google_accounts.json is now survivor@example.com
    const updatedGoogle = JSON.parse(readFileSync(path.join(paths.geminiDir, 'google_accounts.json'), 'utf8'))
    assert.equal(updatedGoogle.active, 'survivor@example.com')

    // Vault contains only survivor
    const vaultRemaining = await listVaultAccounts(orca)
    assert.equal(vaultRemaining.length, 1)
    assert.equal(vaultRemaining[0].email, 'survivor@example.com')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('removeAgyAccountEverywhere: aborts deletion if auto-switch to survivor fails', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-rm-failswitch-'))
  try {
    const paths = createTestPaths(home)
    writeFileSync(path.join(paths.geminiDir, 'google_accounts.json'), JSON.stringify({ active: 'active@example.com' }))

    const orca = createMockOrca()

    await saveVaultAccount(orca, {
      email: 'active@example.com',
      name: 'Active User',
      refreshToken: 'rt-active',
      source: 'oauth'
    })
    await saveVaultAccount(orca, {
      email: 'survivor@example.com',
      name: 'Survivor User',
      refreshToken: 'rt-survivor',
      source: 'oauth'
    })

    // Fetcher fails with network error during token refresh
    const fetcher = async () => {
      throw new Error('OAuth server unreachable')
    }

    const res = await removeAgyAccountEverywhere({
      orca,
      email: 'active@example.com',
      paths,
      platform: 'linux',
      oauthClients: [{ clientId: 'cid', clientSecret: 'csec', tokenUri: 'https://oauth.test/token', scopes: [], source: 'settings' } as any],
      fetcher
    })

    assert.equal(res.ok, false)
    assert.ok(res.message.includes('Deletion aborted'))

    // Active account is NOT deleted
    const vaultRemaining = await listVaultAccounts(orca)
    assert.equal(vaultRemaining.length, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('removeOrcaAccountWithGuard enforces Last-Account Guard and auto-switches active antigravity', async () => {
  const orca = createMockOrca()
  const home = mkdtempSync(path.join(tmpdir(), 'orca-guard-test-'))
  try {
    const paths = createTestPaths(home)

    // Snapshot with 1 active antigravity account
    const singleSnap: AccountsSnapshot = {
      platform: 'darwin',
      orcaCliFound: true,
      orcaError: null,
      fetchedAt: Date.now(),
      providers: [
        {
          agent: 'antigravity',
          title: 'Antigravity',
          supportsSystemDefault: false,
          activeAccountId: 'ag-1',
          accounts: [{ id: 'ag-1', label: 'ag-1@gmail.com', email: 'ag-1@gmail.com', active: true, needsSignIn: false, buckets: [], effectiveRemaining: 80 }]
        }
      ],
      agyPool: { available: false, oauthReady: false, activeEmail: null, accounts: [], bestEmail: null, error: null }
    }

    // Attempting to remove the last active account fails
    const lastRes = await removeOrcaAccountWithGuard({
      orca,
      agent: 'antigravity',
      account: 'ag-1',
      cliPath: '/bin/orca',
      latestSnapshot: singleSnap,
      paths
    })
    assert.equal(lastRes.ok, false)
    assert.ok(lastRes.message.includes('Cannot remove the last active account'))

    // Multi-account snapshot
    const multiSnap: AccountsSnapshot = {
      ...singleSnap,
      providers: [
        {
          agent: 'antigravity',
          title: 'Antigravity',
          supportsSystemDefault: false,
          activeAccountId: 'ag-1',
          accounts: [
            { id: 'ag-1', label: 'ag-1@gmail.com', email: 'ag-1@gmail.com', active: true, needsSignIn: false, buckets: [], effectiveRemaining: 20 },
            { id: 'ag-2', label: 'ag-2@gmail.com', email: 'ag-2@gmail.com', active: false, needsSignIn: false, buckets: [], effectiveRemaining: 90 }
          ]
        }
      ]
    }

    const runnerCalls: string[][] = []
    const multiRes = await removeOrcaAccountWithGuard({
      orca,
      agent: 'antigravity',
      account: 'ag-1',
      cliPath: '/bin/orca',
      latestSnapshot: multiSnap,
      paths,
      runner: async (_exe, args) => {
        runnerCalls.push([...args])
        return { code: 0, stdout: '{"ok":true}', stderr: '' }
      }
    })

    assert.equal(multiRes.ok, true)
    assert.equal(multiRes.autoSwitchedTo, 'ag-2')
    // Selected ag-2 first, then removed ag-1
    assert.deepEqual(runnerCalls[0], ['account', 'select', '--agent', 'antigravity', '--account', 'ag-2', '--json'])
    assert.deepEqual(runnerCalls[1], ['account', 'rm', '--agent', 'antigravity', '--account', 'ag-1', '--json'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('applyAgyRemovalToSnapshot and applyOrcaRemovalToSnapshot update memory snapshot without network', () => {
  const baseSnap: AccountsSnapshot = {
    platform: 'darwin',
    orcaCliFound: true,
    orcaError: null,
    fetchedAt: 1000,
    providers: [
      {
        agent: 'antigravity',
        title: 'Antigravity',
        supportsSystemDefault: false,
        activeAccountId: 'ag-1',
        accounts: [
          { id: 'ag-1', label: 'one@example.com', email: 'one@example.com', active: true, needsSignIn: false, buckets: [], effectiveRemaining: 10 },
          { id: 'ag-2', label: 'two@example.com', email: 'two@example.com', active: false, needsSignIn: false, buckets: [], effectiveRemaining: 90 }
        ]
      }
    ],
    agyPool: {
      available: true,
      oauthReady: true,
      activeEmail: 'one@example.com',
      bestEmail: 'two@example.com',
      error: null,
      accounts: [
        { email: 'one@example.com', name: 'One', source: 'vault', active: true, gemini5h: 10, geminiWeekly: 10, claude5h: null, claudeWeekly: null, effectiveGemini: 10, error: null },
        { email: 'two@example.com', name: 'Two', source: 'vault', active: false, gemini5h: 90, geminiWeekly: 90, claude5h: null, claudeWeekly: null, effectiveGemini: 90, error: null }
      ]
    }
  }

  const updatedAgy = applyAgyRemovalToSnapshot(baseSnap, 'one@example.com', 'two@example.com')
  assert.equal(updatedAgy.agyPool.accounts.length, 1)
  assert.equal(updatedAgy.agyPool.accounts[0].email, 'two@example.com')
  assert.equal(updatedAgy.agyPool.accounts[0].active, true)
  assert.equal(updatedAgy.agyPool.activeEmail, 'two@example.com')
  assert.equal(updatedAgy.agyPool.bestEmail, 'two@example.com')

  const updatedOrca = applyOrcaRemovalToSnapshot(baseSnap, 'antigravity', 'ag-1', 'ag-2')
  const prov = updatedOrca.providers.find((p) => p.agent === 'antigravity')!
  assert.equal(prov.accounts.length, 1)
  assert.equal(prov.accounts[0].id, 'ag-2')
  assert.equal(prov.activeAccountId, 'ag-2')
})
