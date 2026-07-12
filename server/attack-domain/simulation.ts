import { createHash } from 'node:crypto'
import { BUILDING_DEFINITIONS, getBuildingStats, getTroopStats } from '../../src/game/config/GameDefinitions'
import type { BuildingType } from '../../src/game/config/GameDefinitions'
import type {
  AbilityUsedEvent,
  AttackAggregate,
  CombatVillageSnapshot,
  DeterministicCombatResult,
  ResourceAmounts,
  TroopDeployedEvent
} from './types'

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) out[key] = stableValue(source[key])
  }
  return out
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

export function combatSnapshotHash(snapshot: CombatVillageSnapshot): string {
  return stableHash({
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    villageVersion: snapshot.villageVersion,
    buildings: [...snapshot.buildings]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(building => ({
        id: building.id,
        type: building.type,
        level: building.level,
        gridX: building.gridX,
        gridY: building.gridY
      }))
  })
}

interface MutableBuildingState {
  id: string
  type: BuildingType
  maxHitPoints: number
  remainingHitPoints: number
}

interface DamageAction {
  atMs: number
  eventIndex: number
  damage: number
  troop?: TroopDeployedEvent
  directTargetId?: string
}

function deterministicScore(seed: string, value: string): string {
  return stableHash(`${seed}:${value}`)
}

function attackCount(activeMs: number, firstDelay: number, delay: number): number {
  if (activeMs < firstDelay) return 0
  return 1 + Math.floor((activeMs - firstDelay) / delay)
}

function attackCountInWindow(
  deployAt: number,
  firstDelay: number,
  delay: number,
  windowStart: number,
  windowEnd: number
): number {
  if (windowEnd < windowStart) return 0
  const firstStrike = deployAt + firstDelay
  if (windowEnd < firstStrike) return 0
  const firstIndex = Math.max(0, Math.ceil((windowStart - firstStrike) / delay))
  const lastIndex = Math.floor((windowEnd - firstStrike) / delay)
  return Math.max(0, lastIndex - firstIndex + 1)
}

function troopDamage(
  attack: AttackAggregate,
  deploy: TroopDeployedEvent,
  durationMs: number,
  boosts: AbilityUsedEvent[]
): number {
  const stats = getTroopStats(deploy.troopType, attack.reservation.troopLevel)
  const delay = Math.max(150, Math.floor(stats.attackDelay ?? 1_000))
  const firstDelay = Math.max(0, Math.floor(stats.firstAttackDelay ?? 0))
  const creditEnd = Math.min(durationMs, deploy.atMs + attack.rules.maxDamageCreditMs)
  const activeMs = Math.max(0, creditEnd - deploy.atMs)
  const strikes = attackCount(activeMs, firstDelay, delay)
  if (strikes <= 0) return 0

  const perStrike = Math.max(0, Math.floor(stats.damage))
  let damage = strikes * perStrike
  for (const ability of boosts) {
    if (ability.effect.kind !== 'DAMAGE_BOOST') continue
    const start = Math.max(deploy.atMs, ability.atMs)
    const end = Math.min(creditEnd, ability.atMs + ability.effect.durationMs)
    const boostedStrikes = attackCountInWindow(deploy.atMs, firstDelay, delay, start, end)
    damage += Math.floor(boostedStrikes * perStrike * ability.effect.bonusBasisPoints / 10_000)
  }

  // Preserve the broad power profile of chain/splash units without accepting
  // client-authored hit lists. Exact targets remain deterministic below.
  if (stats.chainCount && stats.chainCount > 1) {
    damage = Math.floor(damage * (10_000 + Math.min(3, stats.chainCount - 1) * 3_500) / 10_000)
  } else if (stats.splashRadius && stats.splashRadius > 0) {
    damage = Math.floor(damage * 12_500 / 10_000)
  }
  return Math.max(0, damage)
}

function targetPriority(type: BuildingType, troop: TroopDeployedEvent): number {
  const stats = getTroopStats(troop.troopType, 1)
  if (stats.targetPriority === 'town_hall' && type === 'town_hall') return 0
  if (stats.targetPriority === 'wall' && type === 'wall') return 0
  if (stats.targetPriority === 'defense' && BUILDING_DEFINITIONS[type].category === 'defense') return 0
  if (type === 'wall') return 2
  return 1
}

function orderedTargets(states: MutableBuildingState[], attack: AttackAggregate, troop: TroopDeployedEvent): MutableBuildingState[] {
  return states
    .filter(state => state.remainingHitPoints > 0)
    .sort((left, right) => {
      const priority = targetPriority(left.type, troop) - targetPriority(right.type, troop)
      if (priority !== 0) return priority
      return deterministicScore(attack.simulationSeed, `${troop.troopInstanceId}:${left.id}`)
        .localeCompare(deterministicScore(attack.simulationSeed, `${troop.troopInstanceId}:${right.id}`))
    })
}

function applyRawDamage(state: MutableBuildingState, rawDamage: number, wallMultiplier = 1): { consumed: number; dealt: number } {
  if (rawDamage <= 0 || state.remainingHitPoints <= 0) return { consumed: 0, dealt: 0 }
  const multiplier = state.type === 'wall' ? Math.max(1, wallMultiplier) : 1
  const possible = Math.floor(rawDamage * multiplier)
  const dealt = Math.min(state.remainingHitPoints, possible)
  state.remainingHitPoints -= dealt
  return { consumed: Math.min(rawDamage, Math.ceil(dealt / multiplier)), dealt }
}

function emptyResources(): ResourceAmounts {
  return { gold: 0, ore: 0, food: 0 }
}

/**
 * Rebuilds the authoritative outcome from the immutable village snapshot and
 * compact command events. It performs no I/O and uses no wall clock or random
 * source, so workers and API nodes produce byte-identical results.
 */
export function simulateCombat(attack: AttackAggregate, rawDurationMs: number): DeterministicCombatResult {
  const durationMs = Math.max(0, Math.min(Math.floor(rawDurationMs), attack.rules.maxCombatDurationMs))
  const states: MutableBuildingState[] = attack.snapshot.buildings.map(building => {
    const stats = getBuildingStats(building.type, building.level)
    const hp = Math.max(1, Math.floor(stats.maxHealth))
    return { id: building.id, type: building.type, maxHitPoints: hp, remainingHitPoints: hp }
  })
  const boosts = attack.events.filter((event): event is AbilityUsedEvent => event.type === 'ABILITY_USED' && event.effect.kind === 'DAMAGE_BOOST')
  const actions: DamageAction[] = []

  for (const event of attack.events) {
    if (event.type === 'TROOP_DEPLOYED') {
      actions.push({
        atMs: event.atMs,
        eventIndex: event.eventIndex,
        damage: troopDamage(attack, event, durationMs, boosts),
        troop: event
      })
    } else if (event.type === 'ABILITY_USED' && event.effect.kind === 'DIRECT_DAMAGE') {
      actions.push({
        atMs: event.atMs,
        eventIndex: event.eventIndex,
        damage: event.effect.damage,
        directTargetId: event.effect.targetBuildingId ?? event.targetBuildingId
      })
    }
  }
  actions.sort((a, b) => a.atMs - b.atMs || a.eventIndex - b.eventIndex)

  let damageDealt = 0
  for (const action of actions) {
    if (action.damage <= 0) continue
    if (!action.troop) {
      const target = action.directTargetId
        ? states.find(state => state.id === action.directTargetId && state.remainingHitPoints > 0)
        : states
          .filter(state => state.remainingHitPoints > 0 && state.type !== 'wall')
          .sort((a, b) => deterministicScore(attack.simulationSeed, `ability:${action.eventIndex}:${a.id}`)
            .localeCompare(deterministicScore(attack.simulationSeed, `ability:${action.eventIndex}:${b.id}`)))[0]
      if (target) damageDealt += applyRawDamage(target, action.damage).dealt
      continue
    }

    const stats = getTroopStats(action.troop.troopType, attack.reservation.troopLevel)
    let budget = action.damage
    for (const target of orderedTargets(states, attack, action.troop)) {
      if (budget <= 0) break
      const applied = applyRawDamage(target, budget, stats.wallDamageMultiplier ?? 1)
      budget -= applied.consumed
      damageDealt += applied.dealt
    }
  }

  const scoring = states.filter(state => state.type !== 'wall')
  const scoringHitPoints = scoring.reduce((sum, state) => sum + state.maxHitPoints, 0)
  const scoringRemaining = scoring.reduce((sum, state) => sum + state.remainingHitPoints, 0)
  // Version 1 counted only completely destroyed structures. Keep that branch
  // forever so an in-flight/imported replay is reproducible after upgrades.
  // Version 2 scores partial structural damage by HP, avoiding count cliffs.
  const destruction = attack.rules.simulationVersion <= 1
    ? (scoring.length > 0
        ? Math.min(100, Math.round(scoring.filter(state => state.remainingHitPoints <= 0).length * 100 / scoring.length))
        : 0)
    : (scoringHitPoints > 0
        ? Math.min(100, Math.round((scoringHitPoints - scoringRemaining) * 100 / scoringHitPoints))
        : 0)
  const victory = destruction >= 50
  const loot = attack.target.kind === 'SCENARIO'
    ? emptyResources()
    : {
        gold: Math.floor(attack.rewardPolicy.lootCaps.gold * destruction / 100),
        ore: Math.floor(attack.rewardPolicy.lootCaps.ore * destruction / 100),
        food: Math.floor(attack.rewardPolicy.lootCaps.food * destruction / 100)
      }
  const requestedTrophyDelta = attack.target.kind !== 'PLAYER'
    ? 0
    : victory
      ? attack.rewardPolicy.winTrophyBase + Math.round(destruction / 5) * attack.rewardPolicy.winTrophyPerFivePercent
      : attack.rewardPolicy.lossTrophyDelta
  const buildings = states
    .map(state => ({ id: state.id, remainingHitPoints: state.remainingHitPoints, destroyed: state.remainingHitPoints <= 0 }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const resultWithoutHash = {
    simulationVersion: attack.rules.simulationVersion,
    durationMs,
    destruction,
    victory,
    damageDealt,
    totalHitPoints: states.reduce((sum, state) => sum + state.maxHitPoints, 0),
    buildings,
    destroyedBuildingIds: buildings.filter(building => building.destroyed).map(building => building.id),
    loot,
    requestedTrophyDelta
  }
  return { ...resultWithoutHash, resultHash: stableHash(resultWithoutHash) }
}
