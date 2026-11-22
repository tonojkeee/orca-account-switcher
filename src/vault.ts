// Encrypted plugin vault for storing AGY/Google accounts without external managers.
import type { OrcaWorkerApi } from 'orca/worker'

export type VaultAccountMeta = {
  email: string
  name: string
  source: 'oauth' | 'imported'
  addedAt: number
}

export type VaultAccountSecret = VaultAccountMeta & {
  refreshToken: string
}

const VAULT_META_KEY = 'agyVault.accounts'
const SECRET_PREFIX = 'agyVault.rt.'
const FALLBACK_SECRET_PREFIX = 'agyVault.fallbackRt.'

function secretKeyFor(email: string): string {
  const slug = Buffer.from(email.toLowerCase(), 'utf8').toString('base64url')
  return `${SECRET_PREFIX}${slug}`
}

function fallbackKeyFor(email: string): string {
  const slug = Buffer.from(email.toLowerCase(), 'utf8').toString('base64url')
  return `${FALLBACK_SECRET_PREFIX}${slug}`
}

async function readMetaList(orca: OrcaWorkerApi): Promise<VaultAccountMeta[]> {
  const raw = await orca.storage.get(VAULT_META_KEY)
  if (!Array.isArray(raw)) return []
  const out: VaultAccountMeta[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    const email = typeof rec.email === 'string' && rec.email.trim() ? rec.email.trim() : null
    if (!email) continue
    out.push({
      email,
      name: typeof rec.name === 'string' ? rec.name : '',
      source: rec.source === 'imported' ? 'imported' : 'oauth',
      addedAt: typeof rec.addedAt === 'number' && Number.isFinite(rec.addedAt) ? rec.addedAt : Date.now()
    })
  }
  return out
}

export async function listVaultAccounts(orca: OrcaWorkerApi): Promise<VaultAccountSecret[]> {
  const metas = await readMetaList(orca)
  const out: VaultAccountSecret[] = []
  for (const meta of metas) {
    let rt = await orca.secrets.get(secretKeyFor(meta.email)).catch(() => null)
    if (!rt) {
      const fb = await orca.storage.get(fallbackKeyFor(meta.email)).catch(() => null)
      rt = typeof fb === 'string' && fb.trim() ? fb.trim() : null
    }
    if (!rt) continue
    out.push({ ...meta, refreshToken: rt })
  }
  return out
}

export async function saveVaultAccount(
  orca: OrcaWorkerApi,
  account: { email: string; name?: string; refreshToken: string; source: 'oauth' | 'imported' }
): Promise<{ storedInKeyring: boolean }> {
  const email = account.email.trim()
  let storedInKeyring = true
  try {
    await orca.secrets.set(secretKeyFor(email), account.refreshToken)
    await orca.storage.delete(fallbackKeyFor(email)).catch(() => undefined)
  } catch {
    storedInKeyring = false
    await orca.storage.set(fallbackKeyFor(email), account.refreshToken)
  }

  const metas = await readMetaList(orca)
  const idx = metas.findIndex((m) => m.email.toLowerCase() === email.toLowerCase())
  const nextItem: VaultAccountMeta = {
    email,
    name: account.name?.trim() ?? (idx >= 0 ? metas[idx].name : ''),
    source: account.source,
    addedAt: idx >= 0 ? metas[idx].addedAt : Date.now()
  }
  const nextList = idx >= 0 ? metas.map((m, i) => (i === idx ? nextItem : m)) : [...metas, nextItem]
  await orca.storage.set(VAULT_META_KEY, nextList)
  return { storedInKeyring }
}

export async function removeVaultAccount(orca: OrcaWorkerApi, email: string): Promise<boolean> {
  const metas = await readMetaList(orca)
  const next = metas.filter((m) => m.email.toLowerCase() !== email.toLowerCase())
  if (next.length === metas.length) return false
  await orca.storage.set(VAULT_META_KEY, next)
  await orca.secrets.delete(secretKeyFor(email)).catch(() => undefined)
  await orca.storage.delete(fallbackKeyFor(email)).catch(() => undefined)
  return true
}
