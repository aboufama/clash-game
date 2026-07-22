/** Minimal structural shape shared by the legacy and normalized runtimes. */
export interface TestModeConfig {
  testModeEnabled?: unknown
  testModeOverrides?: unknown
  testModeGlobalActivationId?: unknown
  testModePlayerActivationIds?: unknown
  revision?: unknown
}

const PLAYER_ID = /^[a-zA-Z0-9_-]{1,96}$/
const ACTIVATION_ID = /^[a-zA-Z0-9_.:-]{1,160}$/

export interface TestModeActivationState {
  testModeEnabled: boolean
  testModeOverrides: Record<string, boolean>
  testModeGlobalActivationId: string | null
  testModePlayerActivationIds: Record<string, string>
}

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

/** Invalid persisted ids never grant or acknowledge an announcement. */
export function normalizeTestModeActivationId(raw: unknown): string | null {
  return typeof raw === 'string' && ACTIVATION_ID.test(raw) ? raw : null
}

export function normalizeTestModePlayerActivationIds(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const normalized: Record<string, string> = {}
  for (const key of Object.keys(raw as Record<string, unknown>).sort()) {
    const activationId = normalizeTestModeActivationId((raw as Record<string, unknown>)[key])
    if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
      && PLAYER_ID.test(key) && activationId) normalized[key] = activationId
  }
  return normalized
}

function legacyRevision(config: TestModeConfig): number {
  const revision = Number(config.revision)
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
}

/**
 * Normalize and deterministically backfill announcement identity for configs
 * written before activation ids existed. The fallback remains stable across
 * restarts and is replaced by an opaque id on the next real activation.
 */
export function normalizeTestModeActivationState(config: TestModeConfig): TestModeActivationState {
  const testModeEnabled = config.testModeEnabled === true
  const testModeOverrides = normalizeTestModeOverrides(config.testModeOverrides)
  const revision = legacyRevision(config)
  const testModeGlobalActivationId = testModeEnabled
    ? normalizeTestModeActivationId(config.testModeGlobalActivationId) ?? `tm.g.legacy.${revision}`
    : null
  const testModePlayerActivationIds = normalizeTestModePlayerActivationIds(
    config.testModePlayerActivationIds
  )

  // Explicitly disabled players can never own an effective activation. When
  // global mode is off, only explicit true overrides remain active.
  for (const playerId of Object.keys(testModePlayerActivationIds)) {
    const override = testModeOverrides[playerId]
    if (override === false || (!testModeEnabled && override !== true)) {
      delete testModePlayerActivationIds[playerId]
    }
  }
  if (!testModeEnabled) {
    for (const [playerId, override] of Object.entries(testModeOverrides)) {
      if (override === true && !testModePlayerActivationIds[playerId]) {
        testModePlayerActivationIds[playerId] = `tm.p.legacy.${revision}.${playerId}`
      }
    }
  }

  return {
    testModeEnabled,
    testModeOverrides,
    testModeGlobalActivationId,
    testModePlayerActivationIds
  }
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

/** Current effective activation, or null while this account is excluded/off. */
export function testModeActivationId(config: TestModeConfig, playerId: string): string | null {
  const state = normalizeTestModeActivationState(config)
  if ((state.testModeOverrides[playerId] ?? state.testModeEnabled) !== true) return null
  return state.testModePlayerActivationIds[playerId] ?? state.testModeGlobalActivationId
}

/**
 * Apply a realm switch without re-announcing to explicit-true accounts whose
 * effective entitlement never turned off.
 */
export function transitionGlobalTestMode(
  config: TestModeConfig,
  enabled: boolean,
  nextActivationId: string
): TestModeActivationState {
  const state = normalizeTestModeActivationState(config)
  if (state.testModeEnabled === enabled) return state
  const activationId = normalizeTestModeActivationId(nextActivationId)
  if (enabled && !activationId) throw new Error('A valid Test Mode activation id is required')

  if (enabled) {
    return {
      ...state,
      testModeEnabled: true,
      testModeGlobalActivationId: activationId
    }
  }

  const preserved: Record<string, string> = {}
  for (const [playerId, override] of Object.entries(state.testModeOverrides)) {
    if (override !== true) continue
    const current = state.testModePlayerActivationIds[playerId]
      ?? state.testModeGlobalActivationId
    if (current) preserved[playerId] = current
  }
  return {
    ...state,
    testModeEnabled: false,
    testModeGlobalActivationId: null,
    testModePlayerActivationIds: preserved
  }
}

/** Apply one override while preserving identity across effective true->true changes. */
export function transitionPlayerTestModeOverride(
  config: TestModeConfig,
  playerId: string,
  override: boolean | null,
  nextActivationId: string
): TestModeActivationState {
  if (!PLAYER_ID.test(playerId)) throw new Error('Invalid Test Mode player id')
  const state = normalizeTestModeActivationState(config)
  const beforeOverride = Object.prototype.hasOwnProperty.call(state.testModeOverrides, playerId)
    ? state.testModeOverrides[playerId]
    : null
  if (beforeOverride === override) return state

  const beforeEffective = (beforeOverride ?? state.testModeEnabled) === true
  const beforeActivationId = beforeEffective
    ? state.testModePlayerActivationIds[playerId] ?? state.testModeGlobalActivationId
    : null
  const testModeOverrides = { ...state.testModeOverrides }
  if (override === null) delete testModeOverrides[playerId]
  else testModeOverrides[playerId] = override
  const afterEffective = (override ?? state.testModeEnabled) === true
  const testModePlayerActivationIds = { ...state.testModePlayerActivationIds }

  if (!afterEffective) {
    delete testModePlayerActivationIds[playerId]
  } else if (beforeEffective) {
    // Changing only the policy source is not a new activation.
    if (beforeActivationId) testModePlayerActivationIds[playerId] = beforeActivationId
  } else {
    const activationId = normalizeTestModeActivationId(nextActivationId)
    if (!activationId) throw new Error('A valid Test Mode activation id is required')
    testModePlayerActivationIds[playerId] = activationId
  }

  return {
    ...state,
    testModeOverrides,
    testModePlayerActivationIds
  }
}
