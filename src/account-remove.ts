// Complete, safe, and idempotent account deletion across Vault, AGY Tools, and Orca agents.
import { existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  clearAgyAccountTokenCache,
  loadAgyToolsAccounts,
  mergeAgySources,
  readActiveGeminiEmail,
  sortAgyPoolAccounts,
  type QuotaFetcher
} from './agy-pool'
import { readCurrentAgyLogin, type AgyStoredToken } from './keyring'
import type { OAuthClientConfig } from './oauth'
import {
  removeOrcaAccount,
  selectOrcaAccount,
  type CommandRunner
} from './orca-cli'
import { asString } from './parse'
import {
  readJsonObject,
  writeFileAtomic,
  type PlatformKind,
  type PlatformPaths
} from './platform'
import type { AccountsSnapshot, OrcaAgentKind } from './protocol'
import {
  performAgySwitchAction,
  syncAgyCredentialsAfterOrcaSelect
} from './sync'
import { listVaultAccounts, removeVaultAccount } from './vault'

export type AgyToolsTarget = {
  email: string
  id?: string
}

export type RemoveAgyToolsResult = {
  removedFiles: string[]
  indexUpdated: boolean
}

/**
 * Remove matching account JSON files from ~/.antigravity_tools/accounts and update accounts.json index.
 * Idempotent: missing files or index entries do not cause failure.
 */
export function removeAgyToolsAccountFiles(
  paths: PlatformPaths,
  target: AgyToolsTarget,
  nextActiveId?: string | null
): RemoveAgyToolsResult {
  const normEmail = target.email.trim().toLowerCase()
  const removedFiles: string[] = []
  const removedIds = new Set<string>()
  if (target.id) {
    removedIds.add(target.id)
  }

  if (existsSync(paths.agyAccountsDir)) {
    try {
      const files = readdirSync(paths.agyAccountsDir).filter((name) => name.endsWith('.json'))
      for (const file of files) {
        const fullPath = path.join(paths.agyAccountsDir, file)
        const obj = readJsonObject(fullPath)
        const fileId = asString(obj?.id) ?? file.replace(/\.json$/, '')
        const fileEmail = asString(obj?.email)
        const matchId =
          target.id !== undefined &&
          (fileId === target.id || file.toLowerCase() === `${target.id.toLowerCase()}.json`)
        const matchEmail = fileEmail !== null && fileEmail.toLowerCase() === normEmail
        if (matchId || matchEmail) {
          removedIds.add(fileId)
          try {
            rmSync(fullPath, { force: true })
            removedFiles.push(file)
          } catch {
            // Idempotent: ignore file removal error
          }
        }
      }
    } catch {
      // Directory unreadable or removed concurrently
    }
  }

  const accountsIndexPath = path.join(path.dirname(paths.agyAccountsDir), 'accounts.json')
  let indexUpdated = false
  if (existsSync(accountsIndexPath)) {
    try {
      const indexObj = readJsonObject(accountsIndexPath)
      if (indexObj && Array.isArray(indexObj.accounts)) {
        const origLen = indexObj.accounts.length
        indexObj.accounts = indexObj.accounts.filter((acc: unknown) => {
          if (!acc || typeof acc !== 'object') return false
          const a = acc as Record<string, unknown>
          const aId = asString(a.id)
          const aEmail = asString(a.email)
          const matched =
            (aId !== null && removedIds.has(aId)) ||
            (aEmail !== null && aEmail.toLowerCase() === normEmail)
          if (matched && aId) {
            removedIds.add(aId)
          }
          return !matched
        })
        if (indexObj.accounts.length !== origLen) {
          indexUpdated = true
        }

        const currAccId = asString(indexObj.current_account_id)
        if (currAccId && removedIds.has(currAccId)) {
          indexObj.current_account_id = nextActiveId ?? null
          indexUpdated = true
        }
        const currClassicId = asString(indexObj.current_classic_account_id)
        if (currClassicId && removedIds.has(currClassicId)) {
          indexObj.current_classic_account_id = nextActiveId ?? null
          indexUpdated = true
        }
        const currAgyId = asString(indexObj.current_agy_account_id)
        if (currAgyId && removedIds.has(currAgyId)) {
          indexObj.current_agy_account_id = nextActiveId ?? null
          indexUpdated = true
        }

        if (indexUpdated) {
          writeFileAtomic(accountsIndexPath, JSON.stringify(indexObj, null, 2))
        }
      }
    } catch {
      // Ignore accounts.json parse or write errors
    }
  }

  return { removedFiles, indexUpdated }
}

const deletesInFlight = new Set<string>()

export type RemoveAgyAccountDeps = {
  orca: OrcaWorkerApi
  email: string
  paths: PlatformPaths
  platform?: PlatformKind
  cliPath?: string | null
  runner?: CommandRunner
  oauthClients?: readonly OAuthClientConfig[]
  fetcher?: QuotaFetcher
  latestSnapshot?: AccountsSnapshot | null
}

export type RemoveAgyAccountResult = {
  ok: boolean
  message: string
  autoSwitchedTo?: string
}

/**
 * Full, safe, and idempotent removal of an AGY account (Vault + ~/.antigravity_tools).
 * Policy:
 * 1. Inactive account: removes credentials from Vault and agy-tools, evicts token cache.
 *    STRICT INVARIANT: Never touches ~/.gemini/*, Keychain, or acp_token.json.
 * 2. Active account (with other accounts in pool): Auto-switch to best surviving account first.
 *    If auto-switch fails, aborts deletion to preserve working authentication.
 * 3. Active account (last remaining): Rejects deletion with Last-Account Guard.
 */
export async function removeAgyAccountEverywhere(
  deps: RemoveAgyAccountDeps
): Promise<RemoveAgyAccountResult> {
  const { orca, email, paths, platform, cliPath, runner, oauthClients, fetcher, latestSnapshot } = deps
  const normEmail = email.trim().toLowerCase()
  if (!normEmail) {
    return { ok: false, message: 'Invalid empty email' }
  }

  if (deletesInFlight.has(normEmail)) {
    return { ok: false, message: `Deletion already in progress for ${email}` }
  }
  deletesInFlight.add(normEmail)

  try {
    const vaultAccounts = await listVaultAccounts(orca)
    const agyToolsAccounts = loadAgyToolsAccounts(paths.agyAccountsDir)
    const stored = mergeAgySources(vaultAccounts, agyToolsAccounts)
    const target = stored.find((a) => a.email.toLowerCase() === normEmail)
    const surviving = stored.filter((a) => a.email.toLowerCase() !== normEmail)

    let activeEmail = readActiveGeminiEmail(paths)
    if (!activeEmail) {
      activeEmail = (await readCurrentAgyLogin(paths, platform).catch(() => null))?.email ?? null
    }
    if (!activeEmail) {
      activeEmail = latestSnapshot?.agyPool.activeEmail ?? null
    }

    const isActive = activeEmail !== null && activeEmail.toLowerCase() === normEmail

    // Case 3: Active and last account
    if (isActive && surviving.length === 0) {
      return {
        ok: false,
        message: 'Cannot remove the last active account. Add or sign into another account first.'
      }
    }

    // Case 2: Active account with other surviving accounts
    if (isActive && surviving.length > 0) {
      let fallbackEmail: string | null = null
      if (
        latestSnapshot?.agyPool.bestEmail &&
        latestSnapshot.agyPool.bestEmail.toLowerCase() !== normEmail &&
        surviving.some((a) => a.email.toLowerCase() === latestSnapshot.agyPool.bestEmail!.toLowerCase())
      ) {
        fallbackEmail = latestSnapshot.agyPool.bestEmail
      } else if (latestSnapshot?.agyPool.accounts && latestSnapshot.agyPool.accounts.length > 0) {
        const snapSurviving = latestSnapshot.agyPool.accounts.filter(
          (a) =>
            a.email.toLowerCase() !== normEmail &&
            surviving.some((s) => s.email.toLowerCase() === a.email.toLowerCase())
        )
        if (snapSurviving.length > 0) {
          fallbackEmail = sortAgyPoolAccounts(snapSurviving)[0]?.email ?? null
        }
      }
      if (!fallbackEmail) {
        fallbackEmail = surviving[0].email
      }

      // Auto-switch to fallback FIRST
      const switchRes = await performAgySwitchAction({
        orca,
        email: fallbackEmail,
        paths,
        platform,
        cliPath,
        runner,
        oauthClients,
        fetcher,
        providers: latestSnapshot?.providers
      })

      if (!switchRes.ok) {
        return {
          ok: false,
          message: `Auto-switch to ${fallbackEmail} failed (${switchRes.message}). Deletion aborted to preserve active sign-in.`
        }
      }

      const fallbackAccount = surviving.find(
        (a) => a.email.toLowerCase() === fallbackEmail!.toLowerCase()
      )
      const nextActiveId = fallbackAccount?.id ?? null

      await removeVaultAccount(orca, email)
      removeAgyToolsAccountFiles(paths, { email, id: target?.id }, nextActiveId)
      clearAgyAccountTokenCache(email)

      return {
        ok: true,
        message: `Switched to ${fallbackEmail} and removed ${email}`,
        autoSwitchedTo: fallbackEmail
      }
    }

    // Case 1: Inactive account
    await removeVaultAccount(orca, email)
    removeAgyToolsAccountFiles(paths, { email, id: target?.id })
    clearAgyAccountTokenCache(email)

    return {
      ok: true,
      message: `Removed ${email}`
    }
  } finally {
    deletesInFlight.delete(normEmail)
  }
}

export type RemoveOrcaAccountDeps = {
  orca: OrcaWorkerApi
  agent: OrcaAgentKind
  account: string
  cliPath?: string | null
  runner?: CommandRunner
  latestSnapshot?: AccountsSnapshot | null
  paths: PlatformPaths
  platform?: PlatformKind
  oauthClients?: readonly OAuthClientConfig[]
  fetcher?: QuotaFetcher
}

export async function removeOrcaAccountWithGuard(
  deps: RemoveOrcaAccountDeps
): Promise<{ ok: boolean; message: string; autoSwitchedTo?: string }> {
  const { orca, agent, account, cliPath, runner, latestSnapshot, paths, platform, oauthClients, fetcher } = deps
  const provider = latestSnapshot?.providers.find((p) => p.agent === agent)
  const targetAcc = provider?.accounts.find(
    (a) => a.id === account || a.email?.toLowerCase() === account.toLowerCase()
  )
  const isActive = targetAcc?.active === true || provider?.activeAccountId === account
  let autoSwitchedTo: string | undefined

  if (agent === 'antigravity' && isActive) {
    const surviving = provider?.accounts.filter((a) => a.id !== targetAcc?.id && a.id !== account) ?? []
    if (surviving.length === 0) {
      return {
        ok: false,
        message: 'Cannot remove the last active account. Add or sign into another account first.'
      }
    }
    const fallback = surviving.find((a) => a.effectiveRemaining !== null) ?? surviving[0]
    const selectRes = await selectOrcaAccount('antigravity', fallback.id, cliPath, runner)
    if (!selectRes.ok) {
      return {
        ok: false,
        message: `Auto-switch to ${fallback.label} failed (${selectRes.message}). Deletion aborted.`
      }
    }
    autoSwitchedTo = fallback.id
    await syncAgyCredentialsAfterOrcaSelect({
      orca,
      account: fallback.id,
      paths,
      platform,
      cliPath,
      runner,
      providers: latestSnapshot?.providers,
      oauthClients,
      fetcher
    })
  }

  const res = await removeOrcaAccount(agent, targetAcc?.id ?? account, cliPath, runner)
  return { ...res, autoSwitchedTo }
}

/**
 * Apply AGY account removal to an existing snapshot in memory without network polling.
 */
export function applyAgyRemovalToSnapshot(
  snapshot: AccountsSnapshot,
  email: string,
  autoSwitchedTo?: string
): AccountsSnapshot {
  const norm = email.trim().toLowerCase()
  const nextAgy = snapshot.agyPool.accounts.filter(
    (a) => a.email.toLowerCase() !== norm
  )
  if (autoSwitchedTo) {
    const sw = autoSwitchedTo.toLowerCase()
    for (const a of nextAgy) {
      a.active = a.email.toLowerCase() === sw
    }
  }
  const nextActive =
    autoSwitchedTo ??
    (snapshot.agyPool.activeEmail?.toLowerCase() === norm ? null : snapshot.agyPool.activeEmail)
  const sorted = sortAgyPoolAccounts(nextAgy)

  return {
    ...snapshot,
    agyPool: {
      ...snapshot.agyPool,
      accounts: nextAgy,
      activeEmail: nextActive,
      bestEmail: sorted[0]?.email ?? null
    },
    fetchedAt: Date.now()
  }
}

/**
 * Apply Orca Managed Account removal to an existing snapshot in memory without network polling.
 */
export function applyOrcaRemovalToSnapshot(
  snapshot: AccountsSnapshot,
  agent: OrcaAgentKind,
  account: string,
  autoSwitchedTo?: string
): AccountsSnapshot {
  const normAcc = account.trim().toLowerCase()
  const nextProviders = snapshot.providers.map((p) => {
    if (p.agent !== agent) return p
    const nextAccounts = p.accounts.filter(
      (a) => a.id.toLowerCase() !== normAcc && a.email?.toLowerCase() !== normAcc
    )
    let nextActive = p.activeAccountId
    if (autoSwitchedTo) {
      nextActive = autoSwitchedTo
      for (const a of nextAccounts) {
        a.active = a.id === autoSwitchedTo
      }
    } else if (p.activeAccountId?.toLowerCase() === normAcc) {
      nextActive = null
    }
    return {
      ...p,
      accounts: nextAccounts,
      activeAccountId: nextActive,
      selectedAccountId: nextActive
    }
  })

  return {
    ...snapshot,
    providers: nextProviders,
    fetchedAt: Date.now()
  }
}
