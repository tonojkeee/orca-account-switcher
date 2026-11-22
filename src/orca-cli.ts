// Boundary parser and runner for Orca's native `orca account list` and `orca account select` CLI.
import { findOrcaCli, runCommand, type ExecResult } from './platform'
import type { OrcaAgentKind, OrcaManagedAccount, OrcaProviderState, QuotaBucket } from './protocol'

const PROVIDER_META: readonly { agent: OrcaAgentKind; title: string; supportsSystemDefault: boolean }[] = [
  { agent: 'antigravity', title: 'Antigravity', supportsSystemDefault: false },
  { agent: 'claude', title: 'Claude', supportsSystemDefault: true },
  { agent: 'codex', title: 'Codex', supportsSystemDefault: true },
  { agent: 'opencode', title: 'OpenCode', supportsSystemDefault: true },
  { agent: 'devin', title: 'Devin', supportsSystemDefault: true }
]

export type CommandRunner = (executable: string, args: readonly string[], timeoutMs?: number) => Promise<ExecResult>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

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
