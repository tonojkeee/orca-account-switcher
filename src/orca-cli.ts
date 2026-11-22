// Boundary parser and runner for Orca's native `orca account list` and `orca account select` CLI.
import { asNumber, asRecord, asString } from './parse'
import { findOrcaCli, runCommand, type ExecResult } from './platform'
import type {
  OrcaAgentKind,
  OrcaLaunchLock,
  OrcaManagedAccount,
  OrcaProviderState,
  QuotaBucket
} from './protocol'

const PROVIDER_META: readonly { agent: OrcaAgentKind; title: string; supportsSystemDefault: boolean }[] = [
  { agent: 'antigravity', title: 'Antigravity', supportsSystemDefault: false },
  { agent: 'claude', title: 'Claude', supportsSystemDefault: true },
  { agent: 'codex', title: 'Codex', supportsSystemDefault: true },
  { agent: 'opencode', title: 'OpenCode', supportsSystemDefault: true },
  { agent: 'devin', title: 'Devin', supportsSystemDefault: true }
]

export type CommandRunner = (executable: string, args: readonly string[], timeoutMs?: number) => Promise<ExecResult>

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function parseUsageBuckets(usageRaw: unknown): QuotaBucket[] {
  const usage = asRecord(usageRaw)
  if (!usage) return []

  const bucketsRaw = Array.isArray(usage.buckets) ? usage.buckets : []
  if (bucketsRaw.length > 0) {
    const out: QuotaBucket[] = []
    for (const item of bucketsRaw) {
      const b = asRecord(item)
      const used = asNumber(b?.usedPercent)
      if (!b || used === null) continue
      const label = asString(b.name) ?? asString(b.group) ?? asString(b.windowName) ?? 'Quota'
      out.push({
        label,
        remainingPercent: clampPercent(100 - used),
        windowMinutes: asNumber(b.windowMinutes) ?? 0,
        resetsAt: asNumber(b.resetsAt)
      })
    }
    if (out.length > 0) return out
  }

  const fallback: QuotaBucket[] = []
  const session = asRecord(usage.session)
  const sessionUsed = asNumber(session?.usedPercent)
  if (session && sessionUsed !== null) {
    fallback.push({
      label: '5h Session',
      remainingPercent: clampPercent(100 - sessionUsed),
      windowMinutes: asNumber(session.windowMinutes) ?? 300,
      resetsAt: asNumber(session.resetsAt)
    })
  }
  const weekly = asRecord(usage.weekly)
  const weeklyUsed = asNumber(weekly?.usedPercent)
  if (weekly && weeklyUsed !== null) {
    fallback.push({
      label: 'Weekly',
      remainingPercent: clampPercent(100 - weeklyUsed),
      windowMinutes: asNumber(weekly.windowMinutes) ?? 10080,
      resetsAt: asNumber(weekly.resetsAt)
    })
  }
  return fallback
}

function computeEffectiveRemaining(buckets: readonly QuotaBucket[]): number | null {
  if (buckets.length === 0) return null
  const geminiBuckets = buckets.filter((b) => b.label.toLowerCase().includes('gemini models'))
  const target = geminiBuckets.length > 0 ? geminiBuckets : buckets
  return Math.min(...target.map((b) => b.remainingPercent))
}

function formatAccountLabel(raw: Record<string, unknown>, id: string): string {
  const displayName = asString(raw.displayName)
  const email = asString(raw.email)
  const label = asString(raw.label)
  if (displayName && email && displayName !== email) return `${displayName} (${email})`
  return displayName ?? email ?? label ?? asString(raw.subject) ?? id
}

function parseProviderAccounts(
  agent: OrcaAgentKind,
  blockRaw: unknown,
  activeFallbackUsage: unknown
): OrcaProviderState {
  const meta = PROVIDER_META.find((m) => m.agent === agent)!
  const block = asRecord(blockRaw)
  const byRuntime = asRecord(block?.activeAccountIdsByRuntime)
  const activeAccountId =
    asString(byRuntime?.host) ?? asString(block?.activeAccountId) ?? null
  const selectedAccountId = asString(block?.selectedAccountId) ?? activeAccountId

  const accountsRaw = Array.isArray(block?.accounts) ? block.accounts : []
  const accounts: OrcaManagedAccount[] = []

  for (const item of accountsRaw) {
    const raw = asRecord(item)
    const id = asString(raw?.id)
    if (!raw || !id) continue
    const active = id === activeAccountId
    const buckets = parseUsageBuckets(raw.usage ?? (active ? activeFallbackUsage : null))
    accounts.push({
      id,
      label: formatAccountLabel(raw, id),
      email: asString(raw.email),
      active,
      needsSignIn: raw.needsSignIn === true,
      buckets,
      effectiveRemaining: computeEffectiveRemaining(buckets)
    })
  }

  let systemDefaultLabel: string | null = null
  const sysDef = asRecord(block?.systemDefault)
  if (sysDef?.hasAuth === true) {
    systemDefaultLabel = asString(sysDef.email) ?? asString(sysDef.workspaceLabel) ?? 'System sign-in'
  }

  return {
    agent,
    title: meta.title,
    supportsSystemDefault: meta.supportsSystemDefault,
    activeAccountId,
    selectedAccountId,
    systemDefaultLabel,
    accounts
  }
}

/** Parse raw `orca account list --json` stdout into normalized provider states. */
export function parseOrcaAccountListJson(stdout: string): OrcaProviderState[] {
  const parsed: unknown = JSON.parse(stdout)
  const root = asRecord(parsed)
  if (!root || root.ok !== true) {
    const errObj = asRecord(root?.error)
    throw new Error(asString(errObj?.message) ?? 'orca account list returned an error')
  }
  const result = asRecord(root.result)
  if (!result) throw new Error('orca account list missing result object')
  const rateLimits = asRecord(result.rateLimits)

  return PROVIDER_META.map((meta) =>
    parseProviderAccounts(meta.agent, result[meta.agent], rateLimits?.[meta.agent])
  )
}

export async function fetchOrcaAccounts(
  cliPath: string | null = findOrcaCli(),
  runner: CommandRunner = runCommand
): Promise<{ cliFound: boolean; providers: OrcaProviderState[]; error: string | null }> {
  if (!cliPath) {
    return {
      cliFound: false,
      providers: PROVIDER_META.map((m) => ({
        agent: m.agent,
        title: m.title,
        supportsSystemDefault: m.supportsSystemDefault,
        activeAccountId: null,
        selectedAccountId: null,
        systemDefaultLabel: null,
        accounts: []
      })),
      error: 'Orca CLI was not found on PATH or standard install locations.'
    }
  }

  const res = await runner(cliPath, ['account', 'list', '--json'], 15000)
  if (res.code !== 0) {
    return {
      cliFound: true,
      providers: [],
      error: res.stderr.trim() || res.stdout.trim() || `orca account list exited with code ${res.code}`
    }
  }

  try {
    return { cliFound: true, providers: parseOrcaAccountListJson(res.stdout), error: null }
  } catch (error) {
    return {
      cliFound: true,
      providers: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function selectOrcaAccount(
  agent: OrcaAgentKind,
  account: string,
  cliPath: string | null = findOrcaCli(),
  runner: CommandRunner = runCommand
): Promise<{ ok: boolean; message: string }> {
  if (!cliPath) {
    return { ok: false, message: 'Orca CLI not found on this machine.' }
  }
  const res = await runner(cliPath, ['account', 'select', '--agent', agent, '--account', account, '--json'], 15000)
  if (res.code !== 0) {
    const errMsg = extractCliError(res.stdout) ?? (res.stderr.trim() || `Failed with exit code ${res.code}`)
    return { ok: false, message: errMsg }
  }
  return { ok: true, message: `Switched ${agent} to ${account}` }
}

function extractCliError(stdout: string): string | null {
  try {
    const parsed = asRecord(JSON.parse(stdout))
    const err = asRecord(parsed?.error)
    return asString(err?.message)
  } catch {
    return null
  }
}

export function computeOrcaLaunchLock(
  providers: readonly OrcaProviderState[],
  activeEmail: string | null
): OrcaLaunchLock | null {
  const antigravity = providers.find((p) => p.agent === 'antigravity')
  const selectedId = antigravity?.selectedAccountId ?? antigravity?.activeAccountId ?? null
  if (!antigravity || !selectedId) return null
  if (antigravity.activeAccountId === selectedId) {
    const selected = antigravity.accounts.find((a) => a.id === selectedId)
    if (!activeEmail || !selected?.email || selected.email.toLowerCase() === activeEmail.toLowerCase()) {
      return null
    }
  }
  const selected = antigravity.accounts.find((a) => a.id === selectedId)
  return {
    selectedAccountId: selectedId,
    selectedLabel: selected?.email ?? selected?.label ?? selectedId,
    activeEmail
  }
}

export async function syncOrcaAntigravityAfterAgySwitch(
  email: string,
  cliPath: string | null,
  runner: CommandRunner,
  fallbackProviders: readonly OrcaProviderState[] = []
): Promise<string | null> {
  const freshOrca = await fetchOrcaAccounts(cliPath, runner)
  const providers = freshOrca.cliFound && !freshOrca.error ? freshOrca.providers : fallbackProviders
  const antigravity = providers.find((p) => p.agent === 'antigravity')
  const linked = antigravity?.accounts.find((a) => a.email?.toLowerCase() === email.toLowerCase())
  if (linked) {
    const sync = await selectOrcaAccount('antigravity', linked.id, cliPath, runner)
    return sync.ok ? null : `Orca Antigravity sync warning: ${sync.message}`
  }
  const selectedId = antigravity?.selectedAccountId ?? antigravity?.activeAccountId ?? null
  if (!selectedId) return null
  const selected = antigravity?.accounts.find((a) => a.id === selectedId)
  const selectedLabel = selected?.email ?? selected?.label ?? selectedId
  return `Warning: Orca Antigravity is still pinned to ${selectedLabel}, so launching agy in Orca terminals will fail until ${email} is saved in Orca Settings > AI Provider Accounts or you switch back.`
}

/**
 * If the live agy login already exists in Orca's Antigravity list (e.g. just saved in Orca Settings)
 * while Orca's `selectedAccountId` is still pinned to an older account, select the matching account
 * automatically so `prepareForLaunch()` does not block terminal launches.
 */
export async function reconcileOrcaAntigravitySelection(
  providers: readonly OrcaProviderState[],
  activeEmail: string | null,
  cliPath: string | null,
  runner: CommandRunner
): Promise<OrcaProviderState[]> {
  const mutable = [...providers]
  if (!cliPath) return mutable
  const antigravity = mutable.find((p) => p.agent === 'antigravity')
  const selectedId = antigravity?.selectedAccountId ?? null
  if (!antigravity || !selectedId) return mutable

  const targetId =
    antigravity.activeAccountId ??
    (activeEmail
      ? antigravity.accounts.find((a) => a.email?.toLowerCase() === activeEmail.toLowerCase())?.id ?? null
      : null)

  if (!targetId || targetId === selectedId) return mutable

  const synced = await selectOrcaAccount('antigravity', targetId, cliPath, runner)
  if (!synced.ok) return mutable
  const refreshed = await fetchOrcaAccounts(cliPath, runner)
  return refreshed.cliFound && !refreshed.error ? refreshed.providers : mutable
}
