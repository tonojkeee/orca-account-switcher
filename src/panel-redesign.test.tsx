import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { AccountsSnapshot } from './protocol'

function makeRedesignSnapshot(): AccountsSnapshot {
  return {
    platform: 'darwin',
    orcaCliFound: true,
    orcaError: null,
    fetchedAt: Date.now() + 60000, // future timestamp to verify Math.min clamp fix
    providers: [
      {
        agent: 'antigravity',
        title: 'Antigravity',
        supportsSystemDefault: false,
        activeAccountId: 'ag-1',
        systemDefaultLabel: null,
        accounts: [
          {
            id: 'ag-1',
            label: 'active@example.com',
            email: 'active@example.com',
            active: true,
            needsSignIn: false,
            buckets: [{ label: 'Gemini Models · Weekly', remainingPercent: 30, windowMinutes: 10080, resetsAt: null }],
            effectiveRemaining: 30
          },
          {
            id: 'ag-2',
            label: 'other@example.com',
            email: 'other@example.com',
            active: false,
            needsSignIn: false,
            buckets: [{ label: 'Gemini Models · Weekly', remainingPercent: 90, windowMinutes: 10080, resetsAt: null }],
            effectiveRemaining: 90
          }
        ]
      },
      {
        agent: 'claude',
        title: 'Claude',
        supportsSystemDefault: true,
        activeAccountId: 'cl-1',
        systemDefaultLabel: null,
        accounts: [
          {
            id: 'cl-1',
            label: 'claude@example.com',
            email: 'claude@example.com',
            active: true,
            needsSignIn: false,
            buckets: [{ label: '5h Session', remainingPercent: 75, windowMinutes: 300, resetsAt: null }],
            effectiveRemaining: 75
          },
          {
            id: 'cl-2',
            label: 'claude-extra@example.com',
            email: 'claude-extra@example.com',
            active: false,
            needsSignIn: false,
            buckets: [],
            effectiveRemaining: null
          }
        ]
      }
    ],
    agyPool: {
      available: true,
      oauthReady: true,
      activeEmail: 'active@example.com',
      bestEmail: 'survivor@example.com',
      error: null,
      accounts: [
        {
          email: 'active@example.com',
          name: 'Active User',
          source: 'both',
          active: true,
          gemini5h: 30,
          geminiWeekly: 30,
          claude5h: 100,
          claudeWeekly: 100,
          effectiveGemini: 30,
          argonWeekly: 8,
          argonWeeklyResetsAt: Date.now() + 3600000,
          error: null
        },
        {
          email: 'survivor@example.com',
          name: 'Survivor User',
          source: 'vault',
          active: false,
          gemini5h: 95,
          geminiWeekly: 95,
          claude5h: 100,
          claudeWeekly: 100,
          effectiveGemini: 95,
          error: null
        },
        {
          email: 'inact1@example.com',
          name: 'Inactive 1',
          source: 'agy-tools',
          active: false,
          gemini5h: 50,
          geminiWeekly: 50,
          claude5h: 100,
          claudeWeekly: 100,
          effectiveGemini: 50,
          error: null
        },
        {
          email: 'inact2@example.com',
          name: 'Inactive 2',
          source: 'vault',
          active: false,
          gemini5h: 60,
          geminiWeekly: 60,
          claude5h: 100,
          claudeWeekly: 100,
          effectiveGemini: 60,
          error: null
        }
      ]
    },
    diagnostics: {
      orcaCliPath: '/usr/local/bin/orca',
      agyCliPath: '/usr/local/bin/agy',
      agyToolsCliPath: null,
      oauthClientSource: 'orca-acp'
    }
  }
}

test('UI redesign: Header Best button, Active Spotlight strip, universal search, flat cards, and 2-step inline removal', async () => {
  const calls: string[] = []
  let currentSnap = makeRedesignSnapshot()

  const host = mockHost({
    requests: {
      'accounts.snapshot': () => currentSnap,
      'accounts.selectOrca': ({ agent, account }) => {
        calls.push(`selectOrca:${agent}:${account}`)
        return { ok: true, message: `Selected ${account}`, snapshot: currentSnap }
      },
      'accounts.selectAgyPool': ({ email }) => {
        calls.push(`selectAgyPool:${email}`)
        return { ok: true, message: `Switched to ${email}`, snapshot: currentSnap }
      },
      'accounts.switchBestAgy': () => {
        calls.push('switchBestAgy')
        return { ok: true, message: 'Switched to best', snapshot: currentSnap }
      },
      'accounts.removeAgyAccount': ({ email }) => {
        calls.push(`removeAgy:${email}`)
        currentSnap = {
          ...currentSnap,
          agyPool: {
            ...currentSnap.agyPool,
            accounts: currentSnap.agyPool.accounts.filter((a) => a.email !== email)
          }
        }
        return { ok: true, message: `Removed ${email}`, snapshot: currentSnap }
      },
      'accounts.removeOrcaAccount': ({ agent, account }) => {
        calls.push(`removeOrca:${agent}:${account}`)
        return { ok: true, message: `Removed ${account} from ${agent}`, snapshot: currentSnap }
      }
    }
  })

  const view = await mount(panel, { host })

  // 1. Header has "Best · 95%" and total count (4 Orca + 4 AGY = 8 accounts)
  assert.ok(view.find({ text: /Best · 95%/ }))
  assert.ok(view.find({ text: /8 accounts/ }))

  // 2. Active Spotlight Strip displays active account, Active badge, effective %, and Argon 8%
  assert.ok(view.find({ text: /Active User \(active@example\.com\)/ }))
  assert.ok(view.find({ text: 'Active' }))
  assert.ok(view.find({ text: 'Argon 8%' }))

  // 3. Flat provider headers: check "ANTIGRAVITY · 2" and "CLAUDE · 2"
  assert.ok(view.find({ text: 'ANTIGRAVITY · 2' }))
  assert.ok(view.find({ text: 'CLAUDE · 2' }))

  // 4. Orca tab search input exists (>3 total Orca accounts)
  const orcaSearch = view.find({ label: 'Search accounts' })
  assert.ok(orcaSearch)
  await view.type({ label: 'Search accounts' }, 'other')
  assert.ok(view.find({ text: 'other@example.com' }))
  assert.equal(view.find({ text: 'claude@example.com' }), null)

  // Clear search
  await view.type({ label: 'Search accounts' }, '', { replace: true })

  // 5. Test 2-step inline removal in Orca tab
  const btn = view.find({ label: 'Remove other@example.com' })
  assert.ok(btn, 'Delete button found')
  await view.press(btn)
  assert.ok(view.find({ text: 'Remove other@example.com?' }))
  assert.ok(view.find({ text: 'Confirm' }))

  // Cancel inline removal
  await view.press({ text: 'Cancel' })
  assert.equal(view.find({ text: 'Remove other@example.com?' }), null)

  // Re-open inline removal and Confirm
  await view.press({ label: 'Remove other@example.com' })
  await view.press({ text: 'Confirm' })
  assert.ok(calls.includes('removeOrca:antigravity:ag-2'))

  // 6. Switch to AGY Vault tab
  await view.select({ type: 'Tabs' }, 'agy')
  assert.ok(view.find({ label: 'Filter AGY accounts' }))

  // Verify Argon cell only rendered when argonWeekly is not null
  // In AGY list, active@example.com has Argon Wk, while inact2@example.com does not
  assert.ok(view.find({ text: 'Argon Wk' }))
  await view.type({ label: 'Filter AGY accounts' }, 'inact2')
  assert.equal(view.find({ text: 'Argon Wk' }), null)
  await view.type({ label: 'Filter AGY accounts' }, '', { replace: true })
  assert.ok(view.find({ text: 'Argon Wk' }))

  // Test active account removal confirmation: warning about auto-switch
  await view.press({ label: 'Remove active@example.com' })
  assert.ok(view.find({ text: /Active account! Auto-switch to survivor@example\.com & remove\?/ }))

  // Switching tab auto-resets confirmation
  await view.select({ type: 'Tabs' }, 'orca')
  await view.select({ type: 'Tabs' }, 'agy')
  assert.equal(view.find({ text: /Auto-switch to survivor@example\.com & remove\?/ }), null)

  // Test inactive account removal confirmation: direct remove
  await view.press({ label: 'Remove inact1@example.com' })
  assert.ok(view.find({ text: 'Remove inact1@example.com?' }))
  await view.press({ text: 'Confirm' })
  assert.ok(calls.includes('removeAgy:inact1@example.com'))

  await view.unmount()
})
