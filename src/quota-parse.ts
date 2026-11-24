import { asNumber, asString, asTimestampMs, round1 } from './parse'

export type QuotaSummary = {
  gemini5h: number
  geminiWeekly: number
  claude5h: number
  claudeWeekly: number
  effectiveGemini: number
  gemini5hResetsAt: number | null
  geminiWeeklyResetsAt: number | null
  argon5h?: number | null
  argonWeekly?: number | null
  argon5hResetsAt?: number | null
  argonWeeklyResetsAt?: number | null
}

/** Parse Google Cloud Code `retrieveUserQuotaSummary` JSON response into remaining percentages. */
export function parseCloudCodeQuotaResponse(raw: unknown): QuotaSummary {
  let gemini5h = 100
  let geminiWeekly = 100
  let claude5h = 100
  let claudeWeekly = 100
  let gemini5hResetsAt: number | null = null
  let geminiWeeklyResetsAt: number | null = null
  let argon5h: number | null = null
  let argonWeekly: number | null = null
  let argon5hResetsAt: number | null = null
  let argonWeeklyResetsAt: number | null = null

  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const rootQuota = root.quota && typeof root.quota === 'object' ? (root.quota as Record<string, unknown>) : null
  const rawGroups = root.groups ?? root.quota_groups ?? rootQuota?.quota_groups ?? rootQuota?.groups ?? []
  const groups = Array.isArray(rawGroups) ? rawGroups : []

  for (const g of groups) {
    if (!g || typeof g !== 'object') continue
    const group = g as Record<string, unknown>
    const displayName = asString(group.displayName ?? group.display_name) ?? ''
    const groupName = asString(group.name) ?? ''
    const isArgon = displayName.toLowerCase().includes('argon') || groupName.toLowerCase().includes('argon')
    const rawBuckets = group.buckets ?? []
    const buckets = Array.isArray(rawBuckets) ? rawBuckets : []
    for (const b of buckets) {
      if (!b || typeof b !== 'object') continue
      const bucket = b as Record<string, unknown>
      const frac = asNumber(bucket.remainingFraction ?? bucket.remaining_fraction)
      const rawPct = frac !== null ? frac * 100 : asNumber(bucket.percentage)
      if (rawPct === null) continue
      const pct = Math.max(0, Math.min(100, rawPct))
      const bucketName = asString(bucket.name ?? bucket.bucketId ?? bucket.bucket_id ?? '') ?? ''
      const win = asString(bucket.window) ?? (bucketName.includes('weekly') ? 'weekly' : bucketName.includes('5h') ? '5h' : null)
      const resetsAt = asTimestampMs(bucket.resetTime ?? bucket.reset_time ?? bucket.resetsAt)
      const isBucketArgon = isArgon || bucketName.toLowerCase().includes('argon')

      if (isBucketArgon) {
        if (win === '5h') {
          argon5h = pct
          argon5hResetsAt = resetsAt
        } else if (win === 'weekly') {
          argonWeekly = pct
          argonWeeklyResetsAt = resetsAt
        }
      } else if (displayName.toLowerCase().includes('gemini') || groupName.toLowerCase().includes('gemini')) {
        if (win === '5h') {
          gemini5h = pct
          gemini5hResetsAt = resetsAt
        } else if (win === 'weekly') {
          geminiWeekly = pct
          geminiWeeklyResetsAt = resetsAt
        }
      } else if (
        displayName.toLowerCase().includes('claude') ||
        displayName.toLowerCase().includes('gpt') ||
        groupName.toLowerCase().includes('claude') ||
        groupName.toLowerCase().includes('gpt')
      ) {
        if (win === '5h') claude5h = pct
        else if (win === 'weekly') claudeWeekly = pct
      }
    }
  }

  if (argonWeekly === null) {
    const rawModels = root.models ?? rootQuota?.models ?? []
    const models = Array.isArray(rawModels) ? rawModels : []
    for (const m of models) {
      if (!m || typeof m !== 'object') continue
      const model = m as Record<string, unknown>
      const name = asString(model.name) ?? ''
      const disp = asString(model.display_name ?? model.displayName) ?? ''
      if (name.toLowerCase().includes('argon') || disp.toLowerCase().includes('argon')) {
        const frac = asNumber(model.remaining_fraction ?? model.remainingFraction)
        const rawPct = asNumber(model.percentage) ?? (frac !== null ? frac * 100 : null)
        if (rawPct !== null) {
          argonWeekly = Math.max(0, Math.min(100, rawPct))
          argonWeeklyResetsAt = asTimestampMs(model.reset_time ?? model.resetTime ?? model.resetsAt)
          break
        }
      }
    }
  }

  return {
    gemini5h: round1(gemini5h),
    geminiWeekly: round1(geminiWeekly),
    claude5h: round1(claude5h),
    claudeWeekly: round1(claudeWeekly),
    effectiveGemini: round1(Math.min(gemini5h, geminiWeekly)),
    gemini5hResetsAt,
    geminiWeeklyResetsAt,
    argon5h: argon5h !== null ? round1(argon5h) : null,
    argonWeekly: argonWeekly !== null ? round1(argonWeekly) : null,
    argon5hResetsAt,
    argonWeeklyResetsAt
  }
}
