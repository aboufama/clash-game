/** Minimal structural shape shared by the legacy and normalized runtimes. */
export interface TestModeConfig {
  testModeEnabled?: unknown
  testModeOverrides?: unknown
}

const PLAYER_ID = /^[a-zA-Z0-9_-]{1,96}$/

/**
 * Normalize persisted/admin-supplied overrides into a prototype-safe,
 * deterministic player-id map. Invalid legacy values simply inherit global
 * mode rather than accidentally granting test privileges.
 */
export function normalizeTestModeOverrides(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const normalized: Record<string, boolean> = {}
  for (const key of Object.keys(raw as Record<string, unknown>).sort()) {
    const value = (raw as Record<string, unknown>)[key]
    if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
      && PLAYER_ID.test(key) && typeof value === 'boolean') normalized[key] = value
  }
  return normalized
}

/** Null means that this player inherits the global switch. */
export function testModeOverride(config: TestModeConfig, playerId: string): boolean | null {
  const overrides = config.testModeOverrides
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null
  const value = (overrides as Record<string, unknown>)[playerId]
  return Object.prototype.hasOwnProperty.call(overrides, playerId) && typeof value === 'boolean'
    ? value
    : null
}

/** One authoritative effective-mode rule for admin reads and gameplay. */
export function testModeEnabled(config: TestModeConfig, playerId: string): boolean {
  return testModeOverride(config, playerId) ?? (config.testModeEnabled === true)
}
