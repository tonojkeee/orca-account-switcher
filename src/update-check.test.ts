import { assert, test } from 'orca/testing'
import {
  applyPluginSelfUpdate,
  checkForPluginUpdate,
  compareSemver,
  UPDATE_CHECK_TTL_MS
} from './update-check'

test('compareSemver compares major, minor, patch, and prerelease tags accurately', () => {
  assert.equal(compareSemver('0.2.1', '0.2.0'), 1)
  assert.equal(compareSemver('1.0.0', '0.9.9'), 1)
  assert.equal(compareSemver('v0.2.0', '0.2.0'), 0)
  assert.equal(compareSemver('0.2.0-beta.1', '0.2.0'), -1)
  assert.equal(compareSemver('0.1.9', '0.2.0'), -1)
})

test('checkForPluginUpdate respects 6h cache TTL and emits one-time desktop notification per new version', async () => {
  let networkCalls = 0
  const fetcher = async () => {
    networkCalls++
    return { ok: true, status: 200, json: async () => ({ version: '0.3.0' }) }
  }

  // First check discovers 0.3.0 -> shouldNotifyDesktop = true
  const first = await checkForPluginUpdate({
    enabled: true,
    currentVersion: '0.2.0',
    cached: null,
    fetcher,
    now: () => 1_000_000
  })
  assert.equal(networkCalls, 1)
  assert.equal(first.info.hasUpdate, true)
  assert.equal(first.info.latestVersion, '0.3.0')
  assert.equal(first.shouldNotifyDesktop, true)

  // Within 6h TTL -> uses cache with zero network calls and no repeat desktop notification
  const second = await checkForPluginUpdate({
    enabled: true,
    currentVersion: '0.2.0',
    cached: first.nextState,
    fetcher,
    now: () => 1_000_000 + UPDATE_CHECK_TTL_MS - 1000
  })
  assert.equal(networkCalls, 1)
  assert.equal(second.info.hasUpdate, true)
  assert.equal(second.shouldNotifyDesktop, false)

  // After TTL expires, remote is still 0.3.0 -> refreshes cache without re-notifying desktop
  const third = await checkForPluginUpdate({
    enabled: true,
    currentVersion: '0.2.0',
    cached: second.nextState,
    fetcher,
    now: () => 1_000_000 + UPDATE_CHECK_TTL_MS + 1000
  })
  assert.equal(networkCalls, 2)
  assert.equal(third.shouldNotifyDesktop, false)
})

test('applyPluginSelfUpdate invokes orca plugin update for installed key and reports approval hints', async () => {
  const calls: string[][] = []
  const okRes = await applyPluginSelfUpdate({
    cliPath: 'C:\\Orca\\orca.cmd',
    runner: async (_exe, args) => {
      calls.push([...args])
      if (args[1] === 'list') {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            ok: true,
            result: {
              plugins: [{ pluginKey: 'tonojkeee.account-switcher', isDev: false }]
            }
          })
        }
      }
      return { code: 0, stderr: '', stdout: '{"ok":true}' }
    }
  })
  assert.equal(okRes.ok, true)
  assert.deepEqual(calls, [
    ['plugin', 'list', '--json'],
    ['plugin', 'update', 'tonojkeee.account-switcher', '--json']
  ])

  const approvalRes = await applyPluginSelfUpdate({
    cliPath: '/bin/orca',
    runner: async (_exe, args) => {
      if (args[1] === 'list') {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            ok: true,
            result: { plugins: [{ pluginKey: 'tonojkeee.account-switcher', isDev: false }] }
          })
        }
      }
      return {
        code: 3,
        stderr: '',
        stdout: JSON.stringify({
          ok: false,
          error: { code: 'approval_required', message: 'Needs approval', data: { fingerprint: 'ap1-xyz' } }
        })
      }
    }
  })
  assert.equal(approvalRes.ok, false)
  assert.equal(approvalRes.requiresApproval, true)
  assert.ok(approvalRes.message.includes('orca plugin update tonojkeee.account-switcher --approve ap1-xyz'))
})
