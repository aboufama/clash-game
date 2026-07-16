import {
  BUILDING_DEFINITIONS,
  GENERATED_ONLY,
  MAP_SIZE,
  TROOP_DEFINITIONS,
  normalizeTroopLevel,
  type BuildingType
} from '../../src/game/config/GameDefinitions'
import { AttackDomainError, attackInvariant } from './errors'
import { combatSnapshotHash, simulateCombat, stableHash } from './simulation'
import type {
  AbilityAuthorization,
  ApplyAttackCommandResult,
  ArmyReservationGrant,
  AttackAbilityValidationHooks,
  AttackAggregate,
  AttackCas,
  AttackCommand,
  AttackCommandReceipt,
  AttackEvent,
  AttackFinalization,
  AttackFinalizationReason,
  AttackPhase,
  AttackPreparationHooks,
  AttackRulesSnapshot,
  AttackSettlementPlan,
  AttackSettlementReceipt,
  AttackTargetValidationHooks,
  CompactAttackReplay,
  PrepareAttackInput,
  ResolvedAbilityEffect,
  ResourceAmounts,
  TargetObservation,
  TroopCounts,
  WorldAttackTarget
} from './types'

// v3 (2026-07): deterministic troop attrition — each deployed troop's damage
// credit is capped by its expected survival time against the snapshot's
// defense DPS. Attacks pin the rules version at preparation, so replays and
// settlements recorded under v1/v2 keep reproducing their original results.
export const ATTACK_SIMULATION_VERSION = 3

export const DEFAULT_ATTACK_RULES: Readonly<AttackRulesSnapshot> = Object.freeze({
  simulationVersion: ATTACK_SIMULATION_VERSION,
  preparingTtlMs: 10 * 60_000,
  engagedTtlMs: 2 * 60_000,
  maxCombatDurationMs: 15 * 60_000,
  maxDamageCreditMs: 75_000,
  maxCommands: 2_048,
  maxDeployments: 600,
  deploymentMargin: 2
})

export const ATTACK_TRANSITIONS: Readonly<Record<AttackPhase, readonly AttackPhase[]>> = Object.freeze({
  PREPARING: Object.freeze(['ENGAGED', 'CANCELLED', 'EXPIRED'] as const),
  ENGAGED: Object.freeze(['ACTIVE', 'CANCELLED', 'EXPIRED'] as const),
  ACTIVE: Object.freeze(['FINALIZING'] as const),
  FINALIZING: Object.freeze(['SETTLED'] as const),
  SETTLED: Object.freeze([] as const),
  CANCELLED: Object.freeze([] as const),
  EXPIRED: Object.freeze([] as const)
})

const SAFE_ID = /^[a-zA-Z0-9_-]{1,120}$/

function domainAssert(condition: unknown, message: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new AttackDomainError('INVALID_INPUT', message, details)
}

function strictId(value: unknown, label: string): string {
  domainAssert(typeof value === 'string' && SAFE_ID.test(value), `${label} must be a safe identifier`)
  return value
}

function finiteTime(value: unknown, label: string): number {
  domainAssert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative epoch millisecond`)
  return value
}

function boundedInt(value: unknown, min: number, max: number, label: string): number {
  domainAssert(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be an integer from ${min} to ${max}`)
  return value
}

function normalizedCounts(raw: TroopCounts, label: string): TroopCounts {
  domainAssert(raw && typeof raw === 'object' && !Array.isArray(raw), `${label} must be a troop-count object`)
  const out: TroopCounts = {}
  for (const [rawType, rawCount] of Object.entries(raw)) {
    domainAssert(Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, rawType) && !GENERATED_ONLY.has(rawType), `${label} contains an unknown or generated troop`, { troopType: rawType })
    const count = boundedInt(rawCount, 0, 10_000, `${label}.${rawType}`)
    if (count > 0) out[rawType as keyof TroopCounts] = count
  }
  return out
}

function countsEqual(left: TroopCounts, right: TroopCounts): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if ((left[key as keyof TroopCounts] ?? 0) !== (right[key as keyof TroopCounts] ?? 0)) return false
  }
  return true
}

function countTroops(counts: TroopCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0)
}

function remainingCounts(reserved: TroopCounts, deployed: TroopCounts): TroopCounts {
  const out: TroopCounts = {}
  for (const [type, count] of Object.entries(reserved)) {
    const remaining = (count ?? 0) - (deployed[type as keyof TroopCounts] ?? 0)
    if (remaining > 0) out[type as keyof TroopCounts] = remaining
  }
  return out
}

function normalizeResources(raw: ResourceAmounts, label: string): ResourceAmounts {
  return {
    gold: boundedInt(raw?.gold, 0, 1_000_000_000, `${label}.gold`),
    ore: boundedInt(raw?.ore, 0, 1_000_000_000, `${label}.ore`),
    food: boundedInt(raw?.food, 0, 1_000_000_000, `${label}.food`)
  }
}

function normalizeRules(raw: Partial<AttackRulesSnapshot> | undefined): AttackRulesSnapshot {
  const rules = { ...DEFAULT_ATTACK_RULES, ...(raw ?? {}) }
  return {
    simulationVersion: boundedInt(rules.simulationVersion, 1, 1_000, 'rules.simulationVersion'),
    preparingTtlMs: boundedInt(rules.preparingTtlMs, 1_000, 24 * 60 * 60_000, 'rules.preparingTtlMs'),
    engagedTtlMs: boundedInt(rules.engagedTtlMs, 1_000, 24 * 60 * 60_000, 'rules.engagedTtlMs'),
    maxCombatDurationMs: boundedInt(rules.maxCombatDurationMs, 1_000, 24 * 60 * 60_000, 'rules.maxCombatDurationMs'),
    maxDamageCreditMs: boundedInt(rules.maxDamageCreditMs, 1_000, 24 * 60 * 60_000, 'rules.maxDamageCreditMs'),
    maxCommands: boundedInt(rules.maxCommands, 1, 100_000, 'rules.maxCommands'),
    maxDeployments: boundedInt(rules.maxDeployments, 1, 10_000, 'rules.maxDeployments'),
    deploymentMargin: boundedInt(rules.deploymentMargin, 0, 20, 'rules.deploymentMargin')
  }
}

function validateTarget(target: WorldAttackTarget): void {
  strictId(target.targetId, 'target.targetId')
  strictId(target.plot.worldId, 'target.plot.worldId')
  domainAssert(Number.isSafeInteger(target.plot.x) && Number.isSafeInteger(target.plot.y), 'Target plot coordinates must be integers')
  domainAssert(typeof target.plot.version === 'string' && target.plot.version.length > 0 && target.plot.version.length <= 160, 'Target plot version is required')
  domainAssert(typeof target.villageVersion === 'string' && target.villageVersion.length > 0 && target.villageVersion.length <= 160, 'Target village version is required')
  strictId(target.snapshotId, 'target.snapshotId')
  domainAssert(/^[a-f0-9]{64}$/.test(target.snapshotHash), 'target.snapshotHash must be a SHA-256 hex digest')
  if (target.kind === 'PLAYER') {
    domainAssert(target.targetId === strictId(target.playerId, 'target.playerId'), 'PLAYER targetId must equal playerId')
    if (target.shieldBypassExpiresAt !== undefined) {
      finiteTime(target.shieldBypassExpiresAt, 'target.shieldBypassExpiresAt')
    }
  } else if (target.kind === 'BOT') {
    domainAssert(target.targetId === strictId(target.botId, 'target.botId'), 'BOT targetId must equal botId')
    domainAssert(Number.isSafeInteger(target.seed), 'BOT target seed must be an integer')
  } else {
    domainAssert(target.targetId === strictId(target.scenarioId, 'target.scenarioId'), 'SCENARIO targetId must equal scenarioId')
  }
}

function validateSelectionTarget(source: PrepareAttackInput['selectionSource'], target: WorldAttackTarget): void {
  const valid = target.kind === 'PLAYER'
    ? source === 'NEIGHBOR' || source === 'MATCHMADE' || source === 'REVENGE'
    : target.kind === 'BOT'
      ? source === 'BOT_MAP' || source === 'BOT_MATCHMADE'
      : source === 'PRACTICE'
  domainAssert(valid, `Selection source ${source} cannot create a ${target.kind} target`)
}

function validateSnapshot(attackTarget: WorldAttackTarget, input: PrepareAttackInput['snapshot']): void {
  domainAssert(input?.schemaVersion === 1, 'Combat snapshot schemaVersion must be 1')
  domainAssert(input.snapshotId === attackTarget.snapshotId, 'Combat snapshot id does not match target')
  domainAssert(input.villageVersion === attackTarget.villageVersion, 'Combat snapshot village version does not match target')
  domainAssert(Array.isArray(input.buildings) && input.buildings.length > 0 && input.buildings.length <= 1_000, 'Combat snapshot must contain 1-1000 buildings')
  const seen = new Set<string>()
  for (const building of input.buildings) {
    strictId(building.id, 'snapshot.building.id')
    domainAssert(!seen.has(building.id), `Duplicate combat building id: ${building.id}`)
    seen.add(building.id)
    domainAssert(Object.prototype.hasOwnProperty.call(BUILDING_DEFINITIONS, building.type), `Unknown combat building type: ${String(building.type)}`)
    const def = BUILDING_DEFINITIONS[building.type as BuildingType]
    boundedInt(building.level, 1, def.maxLevel ?? 1, `snapshot.${building.id}.level`)
    boundedInt(building.gridX, 0, MAP_SIZE - def.width, `snapshot.${building.id}.gridX`)
    boundedInt(building.gridY, 0, MAP_SIZE - def.height, `snapshot.${building.id}.gridY`)
  }
  domainAssert(combatSnapshotHash(input) === attackTarget.snapshotHash, 'Combat snapshot hash does not match target')
}

function assertCas(attack: AttackAggregate, cas: AttackCas): void {
  if (attack.phase !== cas.expectedPhase || attack.version !== cas.expectedVersion) {
    throw new AttackDomainError('CAS_MISMATCH', 'Attack phase/version compare-and-swap failed', {
      expectedPhase: cas.expectedPhase,
      expectedVersion: cas.expectedVersion,
      actualPhase: attack.phase,
      actualVersion: attack.version
    })
  }
}

function assertPhase(attack: AttackAggregate, phases: AttackPhase[], action: string): void {
  if (!phases.includes(attack.phase)) {
    throw new AttackDomainError('INVALID_TRANSITION', `${action} is not allowed from ${attack.phase}`, { phase: attack.phase, allowed: phases })
  }
}

function cloneAttack(attack: AttackAggregate): AttackAggregate {
  return structuredClone(attack)
}

function nextEventIndex(attack: AttackAggregate): number {
  return attack.events.length + 1
}

function combatAtMs(attack: AttackAggregate, now: number): number {
  return attack.timestamps.combatStartedAt === undefined
    ? 0
    : Math.max(0, Math.min(attack.rules.maxCombatDurationMs, now - attack.timestamps.combatStartedAt))
}

function appendEvent(attack: AttackAggregate, event: AttackEvent): void {
  attack.events.push(event)
}

function phaseChange(attack: AttackAggregate, phase: AttackPhase, now: number): void {
  attackInvariant(ATTACK_TRANSITIONS[attack.phase].includes(phase), `Illegal attack transition ${attack.phase} -> ${phase}`)
  attack.phase = phase
  attack.timestamps.phaseChangedAt = now
}

function validateObservation(attack: AttackAggregate, observation: TargetObservation, now: number): void {
  domainAssert(observation && typeof observation === 'object', 'Target validation hook returned no observation')
  const observedAt = finiteTime(observation.observedAt, 'observation.observedAt')
  domainAssert(observedAt <= now, 'Target observation cannot come from the future')
  finiteTime(observation.shieldUntil, 'observation.shieldUntil')
  if (!observation.available || observation.targetId !== attack.target.targetId) {
    throw new AttackDomainError('TARGET_UNAVAILABLE', 'The attack target is no longer available')
  }
  const expectedPlot = attack.target.plot
  const observedPlot = observation.plot
  if (observedPlot.worldId !== expectedPlot.worldId || observedPlot.x !== expectedPlot.x || observedPlot.y !== expectedPlot.y || observedPlot.version !== expectedPlot.version) {
    throw new AttackDomainError('TARGET_MOVED', 'The attack target plot changed before engagement', { expectedPlot, observedPlot })
  }
  if (observation.villageVersion !== attack.target.villageVersion) {
    throw new AttackDomainError('TARGET_VERSION_CHANGED', 'The attack target village changed before engagement', {
      expectedVersion: attack.target.villageVersion,
      observedVersion: observation.villageVersion
    })
  }
  const liveRevengeBypass = attack.target.kind === 'PLAYER'
    && attack.target.shieldBypass === 'REVENGE'
    && attack.target.shieldBypassExpiresAt !== undefined
    && attack.target.shieldBypassExpiresAt > now
  if (attack.target.kind === 'PLAYER' && observation.shieldUntil > now && !liveRevengeBypass) {
    throw new AttackDomainError('TARGET_SHIELDED', 'The attack target is protected by a shield', { shieldUntil: observation.shieldUntil })
  }
  if (attack.target.kind === 'PLAYER' && !observation.engagementLease) {
    throw new AttackDomainError('TARGET_LOCK_REQUIRED', 'PLAYER engagement requires an atomic defender lease')
  }
  if (observation.engagementLease) {
    strictId(observation.engagementLease.leaseId, 'engagementLease.leaseId')
    const acquiredAt = finiteTime(observation.engagementLease.acquiredAt, 'engagementLease.acquiredAt')
    const expiresAt = finiteTime(observation.engagementLease.expiresAt, 'engagementLease.expiresAt')
    domainAssert(acquiredAt <= now && expiresAt > now, 'Engagement lease is not live')
  }
}

function shieldDurationForDestruction(destruction: number): number {
  if (destruction >= 90) return 4 * 60 * 60_000
  if (destruction >= 50) return 2 * 60 * 60_000
  if (destruction >= 30) return 60 * 60_000
  return 0
}

function negateResources(resources: ResourceAmounts): ResourceAmounts {
  return { gold: -resources.gold, ore: -resources.ore, food: -resources.food }
}

function zeroResources(): ResourceAmounts {
  return { gold: 0, ore: 0, food: 0 }
}

function buildSettlementPlan(attack: AttackAggregate, finalizedAt: number, result: AttackFinalization['result']): AttackSettlementPlan {
  const settlementId = `settle_${stableHash({ attackId: attack.attackId, resultHash: result.resultHash }).slice(0, 24)}`
  const resourceMode = attack.target.kind === 'PLAYER' ? 'TRANSFER' : attack.target.kind === 'BOT' ? 'MINT' : 'NONE'
  const attackerResources = resourceMode === 'NONE' ? zeroResources() : { ...result.loot }
  return {
    schemaVersion: 1,
    settlementId,
    attackId: attack.attackId,
    resultHash: result.resultHash,
    targetKind: attack.target.kind,
    reservationId: attack.reservation.reservationId,
    consumeArmy: { ...attack.reservation.deployed },
    releaseArmy: remainingCounts(attack.reservation.reserved, attack.reservation.deployed),
    attacker: {
      playerId: attack.attackerId,
      resources: attackerResources,
      requestedTrophyDelta: attack.target.kind === 'PLAYER' ? result.requestedTrophyDelta : 0
    },
    ...(attack.target.kind === 'PLAYER'
      ? {
          defender: {
            playerId: attack.target.playerId,
            resources: negateResources(result.loot),
            requestedTrophyDelta: -result.requestedTrophyDelta,
            shieldUntilAtLeast: finalizedAt + shieldDurationForDestruction(result.destruction),
            revengeAgainstPlayerId: attack.attackerId
          }
        }
      : {}),
    resourceMode
  }
}

function finalizeInPlace(attack: AttackAggregate, reason: AttackFinalizationReason, now: number): void {
  const combatStartedAt = attack.timestamps.combatStartedAt
  attackInvariant(combatStartedAt !== undefined, 'ACTIVE attack has no combatStartedAt')
  const durationMs = Math.max(0, Math.min(attack.rules.maxCombatDurationMs, now - combatStartedAt))
  const result = simulateCombat(attack, durationMs)
  attack.finalization = {
    reason,
    result,
    settlement: buildSettlementPlan(attack, now, result)
  }
  attack.timestamps.finalizedAt = now
  phaseChange(attack, 'FINALIZING', now)
  appendEvent(attack, {
    type: 'ATTACK_FINALIZED',
    eventIndex: nextEventIndex(attack),
    atMs: durationMs,
    reason,
    resultHash: result.resultHash
  })
}

function quantizedCoordinate(value: unknown, margin: number, label: string): number {
  domainAssert(typeof value === 'number' && Number.isFinite(value), `${label} must be finite`)
  domainAssert(value >= -margin && value <= MAP_SIZE + margin, `${label} is outside the deployment envelope`)
  return Math.round(value * 1_000)
}

function normalizedCommand(command: AttackCommand, rules: AttackRulesSnapshot): AttackCommand {
  strictId(command.commandId, 'command.commandId')
  boundedInt(command.sequence, 1, rules.maxCommands, 'command.sequence')
  if (command.type === 'DEPLOY') {
    strictId(command.troopInstanceId, 'command.troopInstanceId')
    domainAssert(Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, command.troopType), 'Unknown troop deployment')
    const gridXQ = quantizedCoordinate(command.gridX, rules.deploymentMargin, 'command.gridX')
    const gridYQ = quantizedCoordinate(command.gridY, rules.deploymentMargin, 'command.gridY')
    return { ...command, gridX: gridXQ / 1_000, gridY: gridYQ / 1_000 }
  }
  if (command.type === 'ABILITY') {
    strictId(command.abilityId, 'command.abilityId')
    if (command.targetBuildingId !== undefined) strictId(command.targetBuildingId, 'command.targetBuildingId')
    domainAssert((command.gridX === undefined) === (command.gridY === undefined), 'Ability gridX/gridY must be supplied together')
    return {
      ...command,
      ...(command.gridX === undefined
        ? {}
        : {
            gridX: quantizedCoordinate(command.gridX, rules.deploymentMargin, 'command.gridX') / 1_000,
            gridY: quantizedCoordinate(command.gridY, rules.deploymentMargin, 'command.gridY') / 1_000
          })
    }
  }
  return { ...command }
}

function commandDigest(command: AttackCommand): string {
  return stableHash(command)
}

function normalizedAbilityAuthorization(
  attack: AttackAggregate,
  command: Extract<AttackCommand, { type: 'ABILITY' }>,
  authorization: AbilityAuthorization
): AbilityAuthorization {
  strictId(authorization?.authorizationId, 'ability.authorizationId')
  const effect = authorization?.effect
  if (!effect || (effect.kind !== 'DIRECT_DAMAGE' && effect.kind !== 'DAMAGE_BOOST')) {
    throw new AttackDomainError('ABILITY_NOT_AUTHORIZED', 'Ability hook returned no recognized effect')
  }
  let normalized: ResolvedAbilityEffect
  if (effect.kind === 'DIRECT_DAMAGE') {
    const damage = boundedInt(effect.damage, 1, 1_000_000, 'ability.effect.damage')
    const targetBuildingId = effect.targetBuildingId ?? command.targetBuildingId
    if (targetBuildingId !== undefined && !attack.snapshot.buildings.some(building => building.id === targetBuildingId)) {
      throw new AttackDomainError('ABILITY_NOT_AUTHORIZED', 'Ability target building is not in the combat snapshot')
    }
    normalized = { kind: 'DIRECT_DAMAGE', damage, ...(targetBuildingId ? { targetBuildingId } : {}) }
  } else {
    normalized = {
      kind: 'DAMAGE_BOOST',
      bonusBasisPoints: boundedInt(effect.bonusBasisPoints, 1, 10_000, 'ability.effect.bonusBasisPoints'),
      durationMs: boundedInt(effect.durationMs, 1, 60_000, 'ability.effect.durationMs')
    }
  }
  return { authorizationId: authorization.authorizationId, effect: normalized }
}

export function prepareAttack(input: PrepareAttackInput, hooks: AttackPreparationHooks): AttackAggregate {
  const now = finiteTime(input.now, 'now')
  const rules = normalizeRules(input.rules)
  const attackId = strictId(input.attackId, 'attackId')
  const attackerId = strictId(input.attackerId, 'attackerId')
  domainAssert(typeof input.attackerName === 'string' && input.attackerName.trim().length > 0 && input.attackerName.length <= 80, 'attackerName is required')
  domainAssert(typeof input.simulationSeed === 'string' && input.simulationSeed.length >= 8 && input.simulationSeed.length <= 160, 'simulationSeed must contain 8-160 characters')
  validateTarget(input.target)
  validateSelectionTarget(input.selectionSource, input.target)
  domainAssert(input.target.kind !== 'PLAYER' || input.target.playerId !== attackerId, 'Cannot attack yourself')
  validateSnapshot(input.target, input.snapshot)
  const requestedArmy = normalizedCounts(input.requestedArmy, 'requestedArmy')
  if (countTroops(requestedArmy) <= 0) throw new AttackDomainError('ARMY_EMPTY', 'At least one troop must be reserved')
  domainAssert(countTroops(requestedArmy) <= rules.maxDeployments, 'Requested army exceeds maxDeployments')
  const troopLevel = normalizeTroopLevel(input.troopLevel)
  const rewardPolicy = {
    lootCaps: normalizeResources(input.rewardPolicy?.lootCaps, 'rewardPolicy.lootCaps'),
    winTrophyBase: boundedInt(input.rewardPolicy?.winTrophyBase, 0, 10_000, 'rewardPolicy.winTrophyBase'),
    winTrophyPerFivePercent: boundedInt(input.rewardPolicy?.winTrophyPerFivePercent, 0, 1_000, 'rewardPolicy.winTrophyPerFivePercent'),
    lossTrophyDelta: boundedInt(input.rewardPolicy?.lossTrophyDelta, -10_000, 0, 'rewardPolicy.lossTrophyDelta')
  }
  let grant: ArmyReservationGrant
  try {
    grant = hooks.reserveArmy({ attackId, attackerId, requested: { ...requestedArmy }, troopLevel })
  } catch (error) {
    if (error instanceof AttackDomainError) throw error
    throw new AttackDomainError('ARMY_RESERVATION_INVALID', 'Army reservation hook failed', { cause: error instanceof Error ? error.message : String(error) })
  }
  strictId(grant?.reservationId, 'reservation.reservationId')
  boundedInt(grant?.sourceArmyVersion, 0, Number.MAX_SAFE_INTEGER, 'reservation.sourceArmyVersion')
  const grantedArmy = normalizedCounts(grant?.reserved, 'reservation.reserved')
  if (!countsEqual(requestedArmy, grantedArmy) || normalizeTroopLevel(grant?.troopLevel) !== troopLevel) {
    throw new AttackDomainError('ARMY_RESERVATION_INVALID', 'Army reservation does not exactly match the request')
  }
  const attack: AttackAggregate = {
    schemaVersion: 1,
    attackId,
    attackerId,
    attackerName: input.attackerName.trim(),
    selectionSource: input.selectionSource,
    phase: 'PREPARING',
    version: 1,
    target: structuredClone(input.target),
    snapshot: structuredClone(input.snapshot),
    simulationSeed: input.simulationSeed,
    rewardPolicy,
    rules,
    reservation: {
      reservationId: grant.reservationId,
      sourceArmyVersion: grant.sourceArmyVersion,
      reserved: grantedArmy,
      troopLevel,
      state: 'HELD',
      deployed: {}
    },
    timestamps: {
      createdAt: now,
      phaseChangedAt: now,
      expiresAt: now + rules.preparingTtlMs
    },
    lastCommandSequence: 0,
    commandReceipts: {},
    events: []
  }
  assertAttackInvariants(attack)
  return attack
}

export function engageAttack(
  attack: AttackAggregate,
  cas: AttackCas,
  nowInput: number,
  hooks: AttackTargetValidationHooks
): AttackAggregate {
  assertCas(attack, cas)
  assertPhase(attack, ['PREPARING'], 'engageAttack')
  const now = finiteTime(nowInput, 'now')
  if (now >= attack.timestamps.expiresAt) throw new AttackDomainError('ATTACK_EXPIRED', 'Prepared attack has expired')
  const observation = hooks.validateAndLockTarget({ attackId: attack.attackId, attackerId: attack.attackerId, target: structuredClone(attack.target), now })
  validateObservation(attack, observation, now)
  const next = cloneAttack(attack)
  next.engagement = observation.engagementLease ? structuredClone(observation.engagementLease) : undefined
  next.timestamps.engagedAt = now
  next.timestamps.expiresAt = Math.min(
    now + next.rules.engagedTtlMs,
    observation.engagementLease?.expiresAt ?? Number.MAX_SAFE_INTEGER
  )
  phaseChange(next, 'ENGAGED', now)
  appendEvent(next, {
    type: 'ATTACK_ENGAGED',
    eventIndex: nextEventIndex(next),
    atMs: 0,
    ...(next.engagement ? { leaseId: next.engagement.leaseId } : {})
  })
  next.version += 1
  assertAttackInvariants(next)
  return next
}

export function applyAttackCommand(
  attack: AttackAggregate,
  cas: AttackCas,
  rawCommand: AttackCommand,
  nowInput: number,
  abilityHooks?: AttackAbilityValidationHooks
): ApplyAttackCommandResult {
  const command = normalizedCommand(rawCommand, attack.rules)
  const digest = commandDigest(command)
  const prior = attack.commandReceipts[command.commandId]
  if (prior) {
    if (prior.commandDigest !== digest || prior.sequence !== command.sequence) {
      throw new AttackDomainError('COMMAND_ID_REUSED', 'commandId was reused with a different sequence or payload')
    }
    return { attack, receipt: structuredClone(prior), duplicate: true }
  }

  assertCas(attack, cas)
  assertPhase(attack, ['ENGAGED', 'ACTIVE'], 'applyAttackCommand')
  const now = finiteTime(nowInput, 'now')
  if (now >= attack.timestamps.expiresAt) throw new AttackDomainError('ATTACK_EXPIRED', 'Attack command arrived after the phase lease expired')
  if (attack.lastCommandSequence >= attack.rules.maxCommands) throw new AttackDomainError('COMMAND_LIMIT_REACHED', 'Attack command limit reached')
  if (command.sequence <= attack.lastCommandSequence) {
    throw new AttackDomainError('COMMAND_SEQUENCE_REPLAY', 'Command sequence was already consumed', { lastSequence: attack.lastCommandSequence })
  }
  if (command.sequence !== attack.lastCommandSequence + 1) {
    throw new AttackDomainError('COMMAND_SEQUENCE_GAP', 'Command sequence must be contiguous', { expectedSequence: attack.lastCommandSequence + 1 })
  }

  const next = cloneAttack(attack)
  let receiptEventIndex = 0
  if (command.type === 'DEPLOY') {
    if (countTroops(next.reservation.deployed) >= next.rules.maxDeployments) {
      throw new AttackDomainError('DEPLOYMENT_LIMIT_REACHED', 'Attack deployment limit reached')
    }
    if (next.events.some(event => event.type === 'TROOP_DEPLOYED' && event.troopInstanceId === command.troopInstanceId)) {
      throw new AttackDomainError('TROOP_INSTANCE_REUSED', 'troopInstanceId was already deployed')
    }
    const reserved = next.reservation.reserved[command.troopType] ?? 0
    const deployed = next.reservation.deployed[command.troopType] ?? 0
    if (deployed >= reserved) {
      throw new AttackDomainError('TROOP_NOT_RESERVED', `No reserved ${command.troopType} remains`)
    }
    if (next.phase === 'ENGAGED') {
      next.timestamps.combatStartedAt = now
      next.timestamps.expiresAt = Math.min(
        now + next.rules.maxCombatDurationMs,
        next.engagement?.expiresAt ?? Number.MAX_SAFE_INTEGER
      )
      phaseChange(next, 'ACTIVE', now)
    }
    next.reservation.deployed[command.troopType] = deployed + 1
    receiptEventIndex = nextEventIndex(next)
    appendEvent(next, {
      type: 'TROOP_DEPLOYED',
      eventIndex: receiptEventIndex,
      atMs: combatAtMs(next, now),
      commandId: command.commandId,
      sequence: command.sequence,
      troopInstanceId: command.troopInstanceId,
      troopType: command.troopType,
      gridXQ: Math.round(command.gridX * 1_000),
      gridYQ: Math.round(command.gridY * 1_000)
    })
  } else if (command.type === 'ABILITY') {
    assertPhase(next, ['ACTIVE'], 'ABILITY command')
    if (!abilityHooks) throw new AttackDomainError('ABILITY_NOT_AUTHORIZED', 'No ability authorization hook was provided')
    const priorUses = next.events.filter(event => event.type === 'ABILITY_USED' && event.abilityId === command.abilityId).length
    let rawAuthorization: AbilityAuthorization
    try {
      rawAuthorization = abilityHooks.authorizeAbility({
        attackId: next.attackId,
        attackerId: next.attackerId,
        abilityId: command.abilityId,
        ...(command.targetBuildingId ? { targetBuildingId: command.targetBuildingId } : {}),
        ...(command.gridX === undefined ? {} : { gridX: command.gridX, gridY: command.gridY }),
        priorUses
      })
    } catch (error) {
      if (error instanceof AttackDomainError) throw error
      throw new AttackDomainError('ABILITY_NOT_AUTHORIZED', 'Ability authorization hook rejected the command', { cause: error instanceof Error ? error.message : String(error) })
    }
    const authorization = normalizedAbilityAuthorization(next, command, rawAuthorization)
    receiptEventIndex = nextEventIndex(next)
    appendEvent(next, {
      type: 'ABILITY_USED',
      eventIndex: receiptEventIndex,
      atMs: combatAtMs(next, now),
      commandId: command.commandId,
      sequence: command.sequence,
      abilityId: command.abilityId,
      authorizationId: authorization.authorizationId,
      ...(command.targetBuildingId ? { targetBuildingId: command.targetBuildingId } : {}),
      ...(command.gridX === undefined ? {} : { gridXQ: Math.round(command.gridX * 1_000), gridYQ: Math.round((command.gridY ?? 0) * 1_000) }),
      effect: authorization.effect
    })
  } else {
    receiptEventIndex = nextEventIndex(next)
    appendEvent(next, {
      type: 'ATTACK_SURRENDERED',
      eventIndex: receiptEventIndex,
      atMs: combatAtMs(next, now),
      commandId: command.commandId,
      sequence: command.sequence
    })
    if (next.phase === 'ENGAGED') {
      next.reservation.state = 'RELEASED'
      next.timestamps.cancelledAt = now
      phaseChange(next, 'CANCELLED', now)
    } else {
      finalizeInPlace(next, 'SURRENDER', now)
    }
  }

  next.lastCommandSequence = command.sequence
  next.version += 1
  const receipt: AttackCommandReceipt = {
    commandId: command.commandId,
    sequence: command.sequence,
    commandDigest: digest,
    appliedVersion: next.version,
    phase: next.phase,
    eventIndex: receiptEventIndex
  }
  next.commandReceipts[command.commandId] = receipt
  assertAttackInvariants(next)
  return { attack: next, receipt: structuredClone(receipt), duplicate: false }
}

export function finalizeAttack(
  attack: AttackAggregate,
  cas: AttackCas,
  reason: AttackFinalizationReason,
  nowInput: number
): AttackAggregate {
  assertCas(attack, cas)
  assertPhase(attack, ['ACTIVE'], 'finalizeAttack')
  const now = finiteTime(nowInput, 'now')
  const next = cloneAttack(attack)
  finalizeInPlace(next, reason, now)
  next.version += 1
  assertAttackInvariants(next)
  return next
}

function receiptMatches(existing: AttackSettlementReceipt, incoming: AttackSettlementReceipt): boolean {
  return stableHash(existing) === stableHash(incoming)
}

function validateSettlementReceipt(plan: AttackSettlementPlan, result: AttackFinalization['result'], receipt: AttackSettlementReceipt): void {
  strictId(receipt.settlementId, 'receipt.settlementId')
  strictId(receipt.transactionId, 'receipt.transactionId')
  finiteTime(receipt.committedAt, 'receipt.committedAt')
  if (receipt.settlementId !== plan.settlementId || receipt.resultHash !== plan.resultHash) {
    throw new AttackDomainError('SETTLEMENT_MISMATCH', 'Settlement receipt does not identify the finalization plan')
  }
  const appliedLoot = normalizeResources(receipt.applied?.loot, 'receipt.applied.loot')
  for (const kind of ['gold', 'ore', 'food'] as const) {
    if (appliedLoot[kind] > result.loot[kind]) {
      throw new AttackDomainError('SETTLEMENT_MISMATCH', 'Applied loot exceeds the deterministic result', { kind })
    }
  }
  const consumed = normalizedCounts(receipt.applied?.consumedArmy, 'receipt.applied.consumedArmy')
  if (!countsEqual(consumed, plan.consumeArmy)) {
    throw new AttackDomainError('SETTLEMENT_MISMATCH', 'Applied army consumption differs from deployed reservation')
  }
  const appliedTrophies = boundedInt(receipt.applied?.trophyDelta, -10_000, 10_000, 'receipt.applied.trophyDelta')
  const requested = result.requestedTrophyDelta
  const validRating = requested < 0 ? appliedTrophies >= requested && appliedTrophies <= 0 : appliedTrophies === requested
  if (!validRating) throw new AttackDomainError('SETTLEMENT_MISMATCH', 'Applied trophy delta violates the requested bounded delta')
}

/** Idempotent when the same durable transaction receipt is replayed. */
export function settleAttack(
  attack: AttackAggregate,
  cas: AttackCas,
  receipt: AttackSettlementReceipt
): AttackAggregate {
  if (attack.phase === 'SETTLED' && attack.finalization?.receipt) {
    if (!receiptMatches(attack.finalization.receipt, receipt)) {
      throw new AttackDomainError('SETTLEMENT_MISMATCH', 'Attack is already settled by a different receipt')
    }
    return attack
  }
  assertCas(attack, cas)
  assertPhase(attack, ['FINALIZING'], 'settleAttack')
  attackInvariant(attack.finalization, 'FINALIZING attack has no finalization')
  if (receipt.committedAt < (attack.timestamps.finalizedAt ?? 0)) {
    throw new AttackDomainError('SETTLEMENT_MISMATCH', 'Settlement receipt predates attack finalization')
  }
  validateSettlementReceipt(attack.finalization.settlement, attack.finalization.result, receipt)
  const next = cloneAttack(attack)
  attackInvariant(next.finalization, 'Cloned FINALIZING attack has no finalization')
  next.finalization.receipt = structuredClone(receipt)
  next.reservation.state = 'COMMITTED'
  next.timestamps.settledAt = receipt.committedAt
  phaseChange(next, 'SETTLED', receipt.committedAt)
  appendEvent(next, {
    type: 'ATTACK_SETTLED',
    eventIndex: nextEventIndex(next),
    atMs: next.finalization.result.durationMs,
    settlementId: receipt.settlementId
  })
  next.version += 1
  assertAttackInvariants(next)
  return next
}

export function cancelAttack(attack: AttackAggregate, cas: AttackCas, nowInput: number, reason = 'cancelled'): AttackAggregate {
  assertCas(attack, cas)
  assertPhase(attack, ['PREPARING', 'ENGAGED'], 'cancelAttack')
  const now = finiteTime(nowInput, 'now')
  domainAssert(typeof reason === 'string' && reason.length > 0 && reason.length <= 160, 'Cancellation reason must contain 1-160 characters')
  attackInvariant(countTroops(attack.reservation.deployed) === 0, 'An attack with deployments must be finalized, not cancelled')
  const next = cloneAttack(attack)
  next.reservation.state = 'RELEASED'
  next.timestamps.cancelledAt = now
  phaseChange(next, 'CANCELLED', now)
  appendEvent(next, { type: 'ATTACK_CANCELLED', eventIndex: nextEventIndex(next), atMs: 0, reason })
  next.version += 1
  assertAttackInvariants(next)
  return next
}

/** PREPARING/ENGAGED expire without cost; ACTIVE timeout produces a settlement plan. */
export function expireAttack(attack: AttackAggregate, cas: AttackCas, nowInput: number): AttackAggregate {
  assertCas(attack, cas)
  assertPhase(attack, ['PREPARING', 'ENGAGED', 'ACTIVE'], 'expireAttack')
  const now = finiteTime(nowInput, 'now')
  domainAssert(now >= attack.timestamps.expiresAt, 'Attack cannot expire before expiresAt')
  if (attack.phase === 'ACTIVE') return finalizeAttack(attack, cas, 'TIMEOUT', now)
  const next = cloneAttack(attack)
  next.reservation.state = 'RELEASED'
  next.timestamps.expiredAt = now
  phaseChange(next, 'EXPIRED', now)
  appendEvent(next, { type: 'ATTACK_EXPIRED', eventIndex: nextEventIndex(next), atMs: 0 })
  next.version += 1
  assertAttackInvariants(next)
  return next
}

export function assertAttackInvariants(attack: AttackAggregate): void {
  attackInvariant(attack.schemaVersion === 1, 'Unsupported attack schemaVersion')
  attackInvariant(Number.isSafeInteger(attack.version) && attack.version >= 1, 'Attack version must be positive')
  attackInvariant(attack.events.every((event, index) => event.eventIndex === index + 1), 'Attack event indexes must be contiguous')
  attackInvariant(Number.isSafeInteger(attack.lastCommandSequence) && attack.lastCommandSequence >= 0, 'lastCommandSequence is invalid')
  const receipts = Object.values(attack.commandReceipts)
  attackInvariant(receipts.length === attack.lastCommandSequence, 'Every accepted command sequence must have one receipt')
  attackInvariant(receipts.every(receipt => attack.commandReceipts[receipt.commandId] === receipt), 'Command receipt index is inconsistent')
  for (const [type, deployed] of Object.entries(attack.reservation.deployed)) {
    attackInvariant((deployed ?? 0) <= (attack.reservation.reserved[type as keyof TroopCounts] ?? 0), 'Deployed army exceeds reservation', { type })
  }
  attackInvariant(attack.snapshot.snapshotId === attack.target.snapshotId, 'Snapshot id drifted from target')
  attackInvariant(attack.snapshot.villageVersion === attack.target.villageVersion, 'Snapshot version drifted from target')
  attackInvariant(combatSnapshotHash(attack.snapshot) === attack.target.snapshotHash, 'Snapshot hash drifted from target')

  if (attack.phase === 'PREPARING') {
    attackInvariant(!attack.engagement && !attack.timestamps.combatStartedAt && !attack.finalization, 'PREPARING fields are inconsistent')
    attackInvariant(attack.reservation.state === 'HELD', 'PREPARING reservation must be held')
  } else if (attack.phase === 'ENGAGED') {
    attackInvariant(attack.timestamps.engagedAt !== undefined && attack.timestamps.combatStartedAt === undefined && !attack.finalization, 'ENGAGED fields are inconsistent')
    attackInvariant(attack.target.kind !== 'PLAYER' || Boolean(attack.engagement), 'PLAYER ENGAGED attack must retain its lease')
    attackInvariant(attack.reservation.state === 'HELD', 'ENGAGED reservation must be held')
  } else if (attack.phase === 'ACTIVE') {
    attackInvariant(attack.timestamps.combatStartedAt !== undefined && countTroops(attack.reservation.deployed) > 0 && !attack.finalization, 'ACTIVE fields are inconsistent')
    attackInvariant(attack.reservation.state === 'HELD', 'ACTIVE reservation must be held')
  } else if (attack.phase === 'FINALIZING') {
    attackInvariant(attack.timestamps.combatStartedAt !== undefined && attack.timestamps.finalizedAt !== undefined && Boolean(attack.finalization), 'FINALIZING fields are inconsistent')
    attackInvariant(attack.reservation.state === 'HELD', 'FINALIZING reservation must stay held until commit')
  } else if (attack.phase === 'SETTLED') {
    attackInvariant(Boolean(attack.finalization?.receipt) && attack.timestamps.settledAt !== undefined, 'SETTLED attack requires a receipt')
    attackInvariant(attack.reservation.state === 'COMMITTED', 'SETTLED reservation must be committed')
  } else if (attack.phase === 'CANCELLED') {
    attackInvariant(attack.timestamps.cancelledAt !== undefined && !attack.finalization, 'CANCELLED fields are inconsistent')
    attackInvariant(attack.reservation.state === 'RELEASED', 'CANCELLED reservation must be released')
  } else {
    attackInvariant(attack.timestamps.expiredAt !== undefined && !attack.finalization, 'EXPIRED fields are inconsistent')
    attackInvariant(attack.reservation.state === 'RELEASED', 'EXPIRED reservation must be released')
  }
}

export function compactReplay(attack: AttackAggregate, options: { includeEconomy?: boolean } = {}): CompactAttackReplay {
  assertAttackInvariants(attack)
  const result = attack.finalization?.result
  let visibleResult: CompactAttackReplay['result']
  if (result) {
    const { loot, requestedTrophyDelta, ...publicResult } = structuredClone(result)
    visibleResult = options.includeEconomy
      ? { ...publicResult, loot, requestedTrophyDelta }
      : publicResult
  }
  return {
    schemaVersion: 1,
    simulationVersion: attack.rules.simulationVersion,
    attackId: attack.attackId,
    attackerId: attack.attackerId,
    attackerName: attack.attackerName,
    target: structuredClone(attack.target),
    snapshot: {
      snapshotId: attack.target.snapshotId,
      snapshotHash: attack.target.snapshotHash,
      villageVersion: attack.target.villageVersion
    },
    troopLevel: attack.reservation.troopLevel,
    simulationSeed: attack.simulationSeed,
    phase: attack.phase,
    events: structuredClone(attack.events),
    ...(visibleResult ? { result: visibleResult } : {})
  }
}
