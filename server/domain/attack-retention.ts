const SAFE_ID = /^[a-zA-Z0-9_-]{1,120}$/
const WORLD_COORD_LIMIT = 1_000_000

export const REVENGE_RIGHT_TTL_MS = 48 * 60 * 60_000
export const MAX_REVENGE_RIGHTS_PER_OPPONENT = 3
export const MAX_REVENGE_OPPONENTS = 32
export const BOT_RAID_COOLDOWN_MS = 30 * 60_000
export const MAX_BOT_RAID_COOLDOWNS = 128

export interface RevengeRight {
  count: number
  expiresAt: number
}

export type RevengeRights = Record<string, RevengeRight>
export type BotRaidCooldowns = Record<string, number>

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function revengeCount(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(MAX_REVENGE_RIGHTS_PER_OPPONENT, Math.max(0, Math.floor(value)))
}

function revengeRight(raw: unknown, now: number): RevengeRight | null {
  if (typeof raw === 'number') {
    const count = revengeCount(raw)
    return count > 0 ? { count, expiresAt: now + REVENGE_RIGHT_TTL_MS } : null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const fallbackCount = source.grantedAt === undefined ? 0 : 1
  const count = revengeCount(source.count, fallbackCount)
  const explicitExpiry = finiteInteger(source.expiresAt)
  const grantedAt = finiteInteger(source.grantedAt)
  const expiresAt = explicitExpiry ?? (grantedAt === null ? null : grantedAt + REVENGE_RIGHT_TTL_MS)
  if (count <= 0 || expiresAt === null || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return null
  return { count, expiresAt }
}

/**
 * Converts imported number/{grantedAt} values into the only runtime shape,
 * drops expired/corrupt rights, and retains the 32 latest-expiring opponents.
 */
export function normalizeRevengeRights(source: unknown, now: number): RevengeRights {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  const rights: Array<[string, RevengeRight]> = []
  for (const [opponentId, raw] of Object.entries(source as Record<string, unknown>)) {
    if (!SAFE_ID.test(opponentId)) continue
    const normalized = revengeRight(raw, now)
    if (normalized) rights.push([opponentId, normalized])
  }
  rights.sort((left, right) =>
    right[1].expiresAt - left[1].expiresAt || left[0].localeCompare(right[0]))
  return Object.fromEntries(rights.slice(0, MAX_REVENGE_OPPONENTS))
}

export function spendRevengeRight(
  source: unknown,
  opponentId: string,
  now: number
): RevengeRights {
  const rights = normalizeRevengeRights(source, now)
  const right = rights[opponentId]
  if (!right || right.count <= 1) delete rights[opponentId]
  else rights[opponentId] = { count: right.count - 1, expiresAt: right.expiresAt }
  return rights
}

export function grantRevengeRight(
  source: unknown,
  opponentId: string,
  earnedAt: number,
  now = earnedAt
): RevengeRights {
  const rights = normalizeRevengeRights(source, now)
  if (!SAFE_ID.test(opponentId)) return rights
  const expiresAt = earnedAt + REVENGE_RIGHT_TTL_MS
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return rights
  const current = rights[opponentId]
  rights[opponentId] = {
    count: Math.min(MAX_REVENGE_RIGHTS_PER_OPPONENT, (current?.count ?? 0) + 1),
    expiresAt: Math.max(current?.expiresAt ?? 0, expiresAt)
  }
  return normalizeRevengeRights(rights, now)
}

function coordinateKey(raw: string): string | null {
  const parts = raw.split(',')
  if (parts.length !== 2) return null
  const x = Number(parts[0])
  const y = Number(parts[1])
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)
    || Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) return null
  return `${x},${y}`
}

/** Drop completed-camp timestamps as soon as their 30-minute gate is over. */
export function normalizeBotRaidCooldowns(source: unknown, now: number): BotRaidCooldowns {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  const cutoff = now - BOT_RAID_COOLDOWN_MS
  const newest = new Map<string, number>()
  for (const [rawKey, rawSettledAt] of Object.entries(source as Record<string, unknown>)) {
    const key = coordinateKey(rawKey)
    const parsed = finiteInteger(rawSettledAt)
    if (!key || parsed === null) continue
    const settledAt = Math.min(parsed, now)
    if (settledAt <= cutoff) continue
    newest.set(key, Math.max(newest.get(key) ?? 0, settledAt))
  }
  return Object.fromEntries([...newest.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_BOT_RAID_COOLDOWNS))
}

export function recordBotRaidCooldown(
  source: unknown,
  x: number,
  y: number,
  settledAt: number
): BotRaidCooldowns {
  const cooldowns = normalizeBotRaidCooldowns(source, settledAt)
  cooldowns[`${x},${y}`] = settledAt
  return normalizeBotRaidCooldowns(cooldowns, settledAt)
}
