import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { AccountsSnapshot } from './protocol'

function makeSnapshot(activeOrcaId: string): AccountsSnapshot {
  return {
    platform: 'darwin',
    orcaCliFound: true,
    orcaError: null,
    fetchedAt: Date.now(),
    providers: [
      {
        agent: 'antigravity',
        title: 'Antigravity',
        supportsSystemDefault: false,
        activeAccountId: activeOrcaId,
        systemDefaultLabel: null,
        accounts: [
          {
            id: 'ag-1',
            label: 'one@gmail.com',
            email: 'one@gmail.com',
            active: activeOrcaId === 'ag-1',
            needsSignIn: false,
            buckets: [{ label: 'Gemini Models · Weekly', remainingPercent: 20, windowMinutes: 10080, resetsAt: null }],
            effectiveRemaining: 20
          },
          {
            id: 'ag-2',
            label: 'two@gmail.com',
            email: 'two@gmail.com',
            active: activeOrcaId === 'ag-2',
            needsSignIn: false,
            buckets: [{ label: 'Gemini Models · Weekly', remainingPercent: 95, windowMinutes: 10080, resetsAt: null }],
            effectiveRemaining: 95
          }
        ]
      }
    ],
    agyPool: {
      available: true,
      oauthReady: true,
      activeEmail: 'one@gmail.com',
      bestEmail: 'two@gmail.com',
      error: null,
      accounts: [
        {
          email: 'two@gmail.com',
          name: 'Two',
          source: 'vault',
          active: false,
          gemini5h: 100,
          geminiWeekly: 95,
          claude5h: 100,
          claudeWeekly: 100,
          effectiveGemini: 95,
          error: null
        },
        {
          email: 'one@gmail.com',
          name: 'One',
          source: 'agy-tools',
          active: true,
          gemini5h: 20,
          geminiWeekly: 20,
          claude5h: 100,
          claudeWeekly: 100,
          effectiveGemini: 20,
          error: null
        }
      ]
    }
  }
}

test('panel renders Orca accounts + AGY Vault, switches on press, and supports OAuth / Import actions', async () => {
  let active = 'ag-1'
  const host = mockHost({
    requests: {
      'accounts.snapshot': () => makeSnapshot(active),
      'accounts.selectOrca': ({ account }) => {
        active = account
        return { ok: true, message: `Switched antigravity to ${account}`, snapshot: makeSnapshot(active) }
      },
      'accounts.switchBestAgy': () => {
        active = 'ag-2'
        return { ok: true, message: 'Switched agy CLI + Orca ACP to two@gmail.com', snapshot: makeSnapshot(active) }
      },
      'accounts.beginGoogleOAuth': () => ({
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?mock=1',
        redirectUri: 'http://127.0.0.1:4444/auth/callback'
      }),
      'accounts.cancelGoogleOAuth': () => ({ ok: true })
    }
  })

  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /one@gmail\.com/ }))
  assert.ok(view.find({ text: /two@gmail\.com/ }))

  await view.press({ text: 'Best' })
  assert.ok(view.find({ text: /Switched agy CLI \+ Orca ACP to two@gmail\.com/ }))

  await view.post('accounts.updated', makeSnapshot('ag-1'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
