// Periodic GitHub release/manifest version checker with 6-hour storage cache and anti-spam notification state.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StorageApi } from 'orca'
import type { HttpFetcher } from './oauth'
import { asRecord, asString } from './parse'
import type { PluginUpdateInfo } from './protocol'

export const PLUGIN_REPO_URL = 'https://github.com/tonojkeee/orca-account-switcher'
export const REMOTE_MANIFEST_URL =
  'https://raw.githubusercontent.com/tonojkeee/orca-account-switcher/main/orca-plugin.json'
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000
export const UPDATE_STATE_STORAGE_KEY = 'updateCheck.v1'

export type StoredUpdateState = {
  checkedAt: number
  latestVersion: string | null
  notifiedVersion: string | null
  dismissedVersion: string | null
  error: string | null
}

async function defaultUpdateFetcher(
  url: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Read current plugin version from bundled `orca-plugin.json`. */
export function readInstalledPluginVersion(manifestPath?: string): string {
  const candidates = manifestPath
    ? [manifestPath]
    : [
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'orca-plugin.json'),
        path.resolve(process.cwd(), 'orca-plugin.json')
      ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const parsed = asRecord(JSON.parse(readFileSync(file, 'utf8')))
      const version = asString(parsed?.version)
      if (version) return version
    } catch {
      // Try next candidate
    }
  }
  return '0.2.0'
}

function parseSemver(raw: string): { nums: [number, number, number]; pre: string | null } | null {
  const clean = raw.trim().replace(/^v/i, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(clean)
  if (!match) return null
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null
  }
}

/** Compare two semantic versions (`a > b => 1`, `a < b => -1`, `a === b => 0`). */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return a.trim() === b.trim() ? 0 : 0
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] > pb.nums[i]) return 1
    if (pa.nums[i] < pb.nums[i]) return -1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return pa.pre > pb.pre ? 1 : -1
}

export async function checkForPluginUpdate(options: {
  enabled: boolean
  force?: boolean
  currentVersion: string
  cached: StoredUpdateState | null
  fetcher?: HttpFetcher
  now?: () => number
}): Promise<{
  info: PluginUpdateInfo
  nextState: StoredUpdateState
  shouldNotifyDesktop: boolean
}> {
  const now = (options.now ?? Date.now)()
  const cached = options.cached

  if (!options.enabled) {
    const nextState: StoredUpdateState = cached ?? {
      checkedAt: 0,
      latestVersion: null,
      notifiedVersion: null,
      dismissedVersion: null,
      error: null
    }
    return {
      info: {
        currentVersion: options.currentVersion,
        latestVersion: null,
        hasUpdate: false,
        dismissed: false,
        checkedAt: cached?.checkedAt || null,
        repoUrl: PLUGIN_REPO_URL,
        error: null
      },
      nextState,
      shouldNotifyDesktop: false
    }
  }

  let latestVersion = cached?.latestVersion ?? null
  let checkedAt = cached?.checkedAt ?? 0
  let error = cached?.error ?? null
  let dismissedVersion = cached?.dismissedVersion ?? null

  const cacheFresh = !options.force && cached !== null && cached.checkedAt > 0 && now - cached.checkedAt < UPDATE_CHECK_TTL_MS
  if (!cacheFresh) {
    const fetcher = options.fetcher ?? defaultUpdateFetcher
    try {
      const resp = await fetcher(REMOTE_MANIFEST_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache'
        }
      })
      if (!resp.ok) {
        error = `HTTP ${resp.status}`
        checkedAt = now
      } else {
        const parsed = asRecord(await resp.json())
        const remoteVersion = asString(parsed?.version)
        if (!remoteVersion) {
          error = 'Remote manifest missing version field'
        } else {
          latestVersion = remoteVersion
          error = null
        }
        checkedAt = now
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      checkedAt = now
    }
    if (options.force) {
      dismissedVersion = null
    }
  }

  const hasUpdate = latestVersion !== null && compareSemver(latestVersion, options.currentVersion) > 0
  const dismissed = hasUpdate && dismissedVersion === latestVersion
  const shouldNotifyDesktop = hasUpdate && cached?.notifiedVersion !== latestVersion

  const nextState: StoredUpdateState = {
    checkedAt,
    latestVersion,
    notifiedVersion: shouldNotifyDesktop ? latestVersion : cached?.notifiedVersion ?? null,
    dismissedVersion,
    error
  }

  return {
    info: {
      currentVersion: options.currentVersion,
      latestVersion,
      hasUpdate,
      dismissed,
      checkedAt: checkedAt || null,
      repoUrl: PLUGIN_REPO_URL,
      error
    },
    nextState,
    shouldNotifyDesktop
  }
}

export async function runStoredUpdateCheck(
  storage: Pick<StorageApi, 'get' | 'set'>,
  options: {
    enabled: boolean
    force?: boolean
    currentVersion: string
    fetcher?: HttpFetcher
  }
): Promise<{ info: PluginUpdateInfo; shouldNotifyDesktop: boolean }> {
  const cached = await storage.get<StoredUpdateState>(UPDATE_STATE_STORAGE_KEY).catch(() => undefined)
  const result = await checkForPluginUpdate({
    enabled: options.enabled,
    force: options.force,
    currentVersion: options.currentVersion,
    cached: cached && typeof cached.checkedAt === 'number' ? cached : null,
    fetcher: options.fetcher
  })
  await storage.set(UPDATE_STATE_STORAGE_KEY, result.nextState).catch(() => undefined)
  return { info: result.info, shouldNotifyDesktop: result.shouldNotifyDesktop }
}

export async function dismissStoredUpdateVersion(
  storage: Pick<StorageApi, 'get' | 'set'>,
  version: string,
  enabled: boolean,
  currentVersion: string,
  fetcher?: HttpFetcher
): Promise<PluginUpdateInfo> {
  const cached = await storage.get<StoredUpdateState>(UPDATE_STATE_STORAGE_KEY).catch(() => undefined)
  const nextState: StoredUpdateState = {
    checkedAt: cached?.checkedAt ?? Date.now(),
    latestVersion: cached?.latestVersion ?? version,
    notifiedVersion: cached?.notifiedVersion ?? version,
    dismissedVersion: version,
    error: cached?.error ?? null
  }
  await storage.set(UPDATE_STATE_STORAGE_KEY, nextState).catch(() => undefined)
  const { info } = await runStoredUpdateCheck(storage, {
    enabled,
    force: false,
    currentVersion,
    fetcher
  })
  return { ...info, dismissed: true }
}
