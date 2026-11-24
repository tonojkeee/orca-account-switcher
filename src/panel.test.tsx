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
          argonWeekly: 7,
          argonWeeklyResetsAt: Date.now() + 86400000,
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
        },
        {
          email: 'three@gmail.com',
          name: 'Three',
          source: 'vault',
          active: false,
          gemini5h: 60,
          geminiWeekly: 60,
          claude5h: 100,
          claudeWeekly: 100,
          effectiveGemini: 60,
          error: null
        },
        {
          email: 'four@gmail.com',
          name: 'Four',
          source: 'vault',
          active: false,
          gemini5h: 70,
          geminiWeekly: 70,
          claude5h: 100,
          claudeWeekly: 100,
          effectiveGemini: 70,
          error: null
        }
      ]
    },
    diagnostics: {
      orcaCliPath: '/usr/local/bin/orca',
      agyCliPath: '/usr/local/bin/agy',
      agyToolsCliPath: null,
      oauthClientSource: 'orca-acp'
    },
    update: {
      currentVersion: '0.2.1',
      latestVersion: '0.2.5',
      hasUpdate: true,
      dismissed: false,
      checkedAt: Date.now(),
      repoUrl: 'https://github.com/tonojkeee/orca-account-switcher',
      error: null
    },
    orcaLaunchLock:
      activeOrcaId === 'ag-locked'
        ? { selectedAccountId: 'ag-1', selectedLabel: 'one@gmail.com', activeEmail: 'unlinked@gmail.com' }
        : null
  }
}

test('panel renders Orca accounts + AGY Vault, update banner, diagnostics, and filter cleanly', async () => {
  let active = 'ag-1'
  let dismissed = false
  const makeCurrent = () => {
    const base = makeSnapshot(active)
    return { ...base, update: { ...base.update!, dismissed } }
  }
  const host = mockHost({
    requests: {
      'accounts.snapshot': () => makeCurrent(),
      'accounts.selectOrca': ({ account }) => {
        active = account
        return { ok: true, message: `Switched antigravity to ${account}`, snapshot: makeCurrent() }
      },
      'accounts.switchBestAgy': () => {
        active = 'ag-2'
        return { ok: true, message: 'Switched agy CLI + Orca ACP to two@gmail.com', snapshot: makeCurrent() }
      },
      'accounts.dismissUpdate': () => {
        dismissed = true
        return makeCurrent()
      },
      'accounts.applyUpdate': () => {
        dismissed = true
        return { ok: true, message: 'Plugin updated cleanly!', snapshot: makeCurrent() }
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
  assert.ok(view.find({ type: 'Collapsible' }))
  assert.ok(view.find({ text: /Update available: v0\.2\.5/ }))

  // Dismiss update banner
  await view.press({ text: 'Dismiss' })
  assert.equal(view.find({ text: /Update available: v0\.2\.5/ }), null)

  // Expand Runtime diagnostics Collapsible and verify detected paths + Update button render
  await view.toggle({ type: 'Collapsible' })
  assert.ok(view.find({ text: /\/usr\/local\/bin\/orca/ }))
  assert.ok(view.find({ text: /Update to v0\.2\.5/ }))
  await view.press({ text: /Update to v0\.2\.5/ })
  assert.ok(view.find({ text: /Plugin updated cleanly!/ }))

  await view.press({ text: /Best/ })
  assert.ok(view.find({ text: /Switched agy CLI \+ Orca ACP to two@gmail\.com/ }))

  // Switch to AGY Vault tab and test live search filter across >3 accounts
  await view.select({ type: 'Tabs' }, 'agy')
  const filterInput = view.find({ label: 'Filter AGY accounts' })
  assert.ok(filterInput)
  assert.ok(view.find({ text: 'three@gmail.com' }))
  assert.ok(view.find({ text: 'Argon Wk' }))
  assert.ok(view.find({ text: '7%' }))
  await view.type({ label: 'Filter AGY accounts' }, 'three')
  assert.ok(view.find({ text: 'three@gmail.com' }))
  assert.equal(view.find({ text: 'four@gmail.com' }), null)
  assert.equal(view.find({ text: 'Argon Wk' }), null)

  await view.post('accounts.updated', makeSnapshot('ag-1'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
