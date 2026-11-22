import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { resolvePlatformPaths } from './platform'
import * as main from './worker'

test('worker imports current agy login into encrypted vault, switches agy + Orca, and removes vault accounts', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-worker-test-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    mkdirSync(paths.orcaAcpDir, { recursive: true })
    mkdirSync(paths.geminiDir, { recursive: true })
    writeFileSync(
      paths.orcaAcpTokenPath,
      JSON.stringify({ client_id: 'cid', client_secret: 'csec', refresh_token: 'rt-1', token_uri: 'https://oauth.test/token' })
    )
    writeFileSync(path.join(paths.geminiDir, 'google_accounts.json'), JSON.stringify({ active: 'one@gmail.com' }))

    let activeOrcaId = 'ag-1'
    const cliCalls: string[][] = []
    const host = mockHost({
      settings: {
        pollSeconds: 0,
        statusClickAction: 'refresh',
        showAgyPool: true,
        autoSwitchLowQuota: false,
        lowQuotaThreshold: 5,
        oauthClientId: '',
        oauthClientSecret: ''
      }
    })

    const deps: main.WorkerDeps = {
      paths,
      platform: 'other' as NodeJS.Platform,
      findOrca: () => '/usr/bin/orca',
      findAgy: () => null,
      readCurrentLogin: async () => ({
        email: 'one@gmail.com',
        refreshToken: 'rt-1',
        accessToken: 'at-1',
        idToken: null,
        source: 'jetski-file'
      }),
      runner: async (_exe, args) => {
        cliCalls.push([...args])
        if (args[1] === 'select') {
          activeOrcaId = args[5]
          return { code: 0, stdout: '{"ok":true}', stderr: '' }
        }
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            ok: true,
            result: {
              claude: { accounts: [], activeAccountId: null },
              codex: { accounts: [], activeAccountId: null },
              opencode: { accounts: [], activeAccountId: null },
              devin: { accounts: [], activeAccountId: null },
              antigravity: {
                accounts: [
                  { id: 'ag-1', email: 'one@gmail.com', usage: { buckets: [{ name: 'Gemini Models · Weekly', usedPercent: 70, windowMinutes: 10080 }] } },
                  { id: 'ag-2', email: 'two@gmail.com', usage: { buckets: [{ name: 'Gemini Models · Weekly', usedPercent: 0, windowMinutes: 10080 }] } }
                ],
                activeAccountId: activeOrcaId
              }
            }
          })
        }
      },
      fetcher: async (url, init) => {
        if (url === 'https://oauth.test/token') {
          const token = String(init.body).includes('rt-2') ? 'at-2' : 'at-1'
          return { ok: true, status: 200, json: async () => ({ access_token: token, expires_in: 3600 }) }
        }
        const rem = (init.headers as Record<string, string>).Authorization === 'Bearer at-2' ? 1.0 : 0.3
        return {
          ok: true,
          status: 200,
          json: async () => ({
            groups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: rem }, { window: 'weekly', remainingFraction: rem }] }]
          })
        }
      }
    }

    const worker = await mountWorker(
      {
        default: (orca) => main.default(orca, deps),
        deactivate: main.deactivate
      },
      { host }
    )

    const imported = await worker.request('accounts.importCurrentAgy')
    assert.equal(imported.ok, true)
    assert.equal(imported.snapshot.agyPool.accounts.length, 1)
    assert.equal(imported.snapshot.agyPool.accounts[0].email, 'one@gmail.com')

    // Switch Orca native account directly
    const orcaSwitched = await worker.request('accounts.selectOrca', { agent: 'antigravity', account: 'ag-2' })
    assert.equal(orcaSwitched.ok, true)
    assert.ok(cliCalls.some((c) => c[0] === 'account' && c[1] === 'select' && c[5] === 'ag-2'))

    const removed = await worker.request('accounts.removeVaultAccount', { email: 'one@gmail.com' })
    assert.equal(removed.ok, true)
    assert.equal(removed.snapshot.agyPool.accounts.length, 0)
    assert.deepEqual(worker.refusals, [])

    await worker.deactivate()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseSettings enforces pollSeconds=0 default and >=600s minimum when enabled', () => {
  assert.equal(main.parseSettings({}).pollSeconds, 0)
  assert.equal(main.parseSettings({ pollSeconds: 0 }).pollSeconds, 0)
  assert.equal(main.parseSettings({ pollSeconds: 60 }).pollSeconds, main.MIN_POLL_SECONDS)
  assert.equal(main.parseSettings({ pollSeconds: 900 }).pollSeconds, 900)
})
