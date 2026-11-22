// Shared runtime boundary parsing helpers.

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function asTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value.trim())
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10
}
