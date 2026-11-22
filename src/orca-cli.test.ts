import { assert, test } from 'orca/testing'
import { fetchOrcaAccounts, parseOrcaAccountListJson, selectOrcaAccount } from './orca-cli'

const SAMPLE_LIST_JSON = JSON.stringify({
  ok: true,
  result: {
    claude: {
      accounts: [
        { id: 'cl-1', email: 'work@example.com', displayName: 'Work', needsSignIn: false },
        { id: 'cl-2', email: 'personal@example.com', needsSignIn: true }
      ],
      activeAccountId: 'cl-1',
      activeAccountIdsByRuntime: { host: 'cl-1', wsl: {} }
    },
    codex: {
      accounts: [],
      activeAccountId: null,
      systemDefault: { hasAuth: true, authKind: 'oauth', email: 'dev@example.com' }
    },
    opencode: { accounts: [], activeAccountId: null },
    devin: { accounts: [], activeAccountId: null },
    antigravity: {
      accounts: [
        {
          id: 'ag-1',
          email: 'low@gmail.com',
          usage: {
            buckets: [
              { name: 'Gemini Models · Five Hour', usedPercent: 90, windowMinutes: 300, resetsAt: 1000 },
              { name: 'Gemini Models · Weekly', usedPercent: 20, windowMinutes: 10080, resetsAt: 2000 }
            ]
          }
        },
        {
          id: 'ag-2',
          email: 'fresh@gmail.com',
          usage: {
            buckets: [
              { name: 'Gemini Models · Five Hour', usedPercent: 0, windowMinutes: 300, resetsAt: 1000 },
              { name: 'Gemini Models · Weekly', usedPercent: 10, windowMinutes: 10080, resetsAt: 2000 }
            ]
          }
        }
      ],
      activeAccountId: 'ag-1'
    }
  }
})

test('parseOrcaAccountListJson normalizes providers, labels, and remaining quotas', () => {
  const providers = parseOrcaAccountListJson(SAMPLE_LIST_JSON)
  const ag = providers.find((p) => p.agent === 'antigravity')!
  assert.equal(ag.accounts.length, 2)
  assert.equal(ag.accounts[0].active, true)
  assert.equal(ag.accounts[0].effectiveRemaining, 10)
  assert.equal(ag.accounts[1].effectiveRemaining, 90)

  const claude = providers.find((p) => p.agent === 'claude')!
  assert.equal(claude.accounts[0].label, 'Work (work@example.com)')
  assert.equal(claude.accounts[0].active, true)
  assert.equal(claude.accounts[1].needsSignIn, true)

  const codex = providers.find((p) => p.agent === 'codex')!
  assert.equal(codex.systemDefaultLabel, 'dev@example.com')
})

test('fetchOrcaAccounts and selectOrcaAccount handle missing CLI and selection calls', async () => {
  const missing = await fetchOrcaAccounts(null)
  assert.equal(missing.cliFound, false)
  assert.ok(missing.error?.includes('not found'))

  const calls: string[][] = []
  const okList = await fetchOrcaAccounts('/bin/orca', async (_exe, args) => {
    calls.push([...args])
    return { code: 0, stdout: SAMPLE_LIST_JSON, stderr: '' }
  })
  assert.equal(okList.cliFound, true)
  assert.equal(okList.error, null)
  assert.deepEqual(calls, [['account', 'list', '--json']])

  const selCalls: string[][] = []
  const switched = await selectOrcaAccount('claude', 'cl-2', '/bin/orca', async (_exe, args) => {
    selCalls.push([...args])
    return { code: 0, stdout: '{"ok":true}', stderr: '' }
  })
  assert.equal(switched.ok, true)
  assert.deepEqual(selCalls, [['account', 'select', '--agent', 'claude', '--account', 'cl-2', '--json']])
})
