import { createHash } from 'node:crypto'
import { BUILDING_DEFINITIONS, TROOP_DEFINITIONS, getBuildingStats, getTroopStats } from '../../src/game/config/GameDefinitions'
import type { BuildingType } from '../../src/game/config/GameDefinitions'
import { defenseDps } from '../../src/game/systems/DefenseBehaviorCatalog'
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

/**
 * Rules v3+: sustained damage-per-second of the snapshot's standing defenses,
 * using the ONE shared fire-model derivation (DefenseBehaviorCatalog). Walls
 * and non-firing structures contribute nothing.
 */
function snapshotDefenseDps(attack: AttackAggregate): number {
  let total = 0
  for (const building of attack.snapshot.buildings) {
    if (BUILDING_DEFINITIONS[building.type].category !== 'defense') continue
    const dps = defenseDps(building.type, getBuildingStats(building.type, building.level))
    if (dps && dps > 0) total += dps
  }
  return total
}

/**
 * Rules v3+ attrition: how long a deployed troop is expected to survive under
 * the snapshot's defenses before it stops earning damage credit. Defensive
 * fire is spread across the whole deployed army (defenses pick one target at
 * a time), and a seed-derived spread of 0.8–1.2 keeps identical troops from
 * sharing one expiry tick. Pure function of the snapshot, the recorded deploy
 * events and the simulation seed — never of any new client input. Earlier
 * rules versions keep the full credit window so recorded replays and
 * settlements reproduce byte-identically.
 */
function attritionLifetimeMs(
  attack: AttackAggregate,
  deploy: TroopDeployedEvent,
  totalDefenseDps: number,
  deployedCount: number
): number {
  // Stored aggregates may reference troop types deleted in a later build;
  // they earn zero credit (see troopDamage), so any lifetime is safe here.
  if (!Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, deploy.troopType)) return attack.rules.maxDamageCreditMs
  if (attack.rules.simulationVersion < 3 || totalDefenseDps <= 0) return attack.rules.maxDamageCreditMs
  const stats = getTroopStats(deploy.troopType, attack.reservation.troopLevel)
  const hitPoints = Math.max(1, Math.floor(stats.health))
  const perTroopDps = totalDefenseDps / Math.max(1, deployedCount)
  const jitterHex = deterministicScore(attack.simulationSeed, `attrition:${deploy.troopInstanceId}`).slice(0, 8)
  const jitter = 0.8 + 0.4 * (Number.parseInt(jitterHex, 16) / 0xffffffff)
  const lifetime = Math.round(hitPoints * 1_000 * jitter / perTroopDps)
  // Rules v4: a troop that deploys hidden (hawk-eye assassin) takes no
  // defensive fire while untargetable, so its credit window starts burning
  // only after the cloak drops — the whole window extends by untargetableMs.
  if (attack.rules.simulationVersion >= 4 && typeof stats.untargetableMs === 'number' && stats.untargetableMs > 0) {
    return Math.min(attack.rules.maxDamageCreditMs, Math.max(1_000, lifetime) + Math.floor(stats.untargetableMs))
  }
  return Math.min(attack.rules.maxDamageCreditMs, Math.max(1_000, lifetime))
}

// ---------------------------------------------------------------------------
// Rules v4 deterministic kit-credit models. Everything below is reached only
// when rules.simulationVersion >= 4 (the attack pins its version at
// preparation), so stored v1–v3 attacks and replays reproduce byte-identically.
// All models are pure functions of the snapshot, the deploy log and the
// simulation seed — like v3 attrition, they are aspatial approximations.
// ---------------------------------------------------------------------------

/** A deploy's base damage-credit window: deploy time plus its attrition
 *  lifetime, clamped by the combat duration and the per-troop credit budget.
 *  "Base" = pre-support-extension; every v4 overlap model measures against
 *  these windows so support credit is non-recursive. */
interface CreditWindow {
  startMs: number
  endMs: number
}

/** Quartermaster war-drum aura: cadence uplift while its window is open. */
interface CadenceWindow extends CreditWindow {
  cadence: number
}

/** Flat lifetime credit for allies of a parked siege tower: the ramp spares
 *  them the walk (and the fire taken) around the wall line. */
const SIEGE_TOWER_PATHING_CREDIT_MS = 2_000

function baseCreditWindowsV4(
  attack: AttackAggregate,
  deploys: TroopDeployedEvent[],
  durationMs: number,
  totalDefenseDps: number,
  deployedCount: number
): Map<string, CreditWindow> {
  const windows = new Map<string, CreditWindow>()
  for (const deploy of deploys) {
    const lifetime = attritionLifetimeMs(attack, deploy, totalDefenseDps, deployedCount)
    const endMs = Math.min(durationMs, deploy.atMs + Math.min(attack.rules.maxDamageCreditMs, lifetime))
    windows.set(deploy.troopInstanceId, { startMs: deploy.atMs, endMs: Math.max(deploy.atMs, endMs) })
  }
  return windows
}

function quartermasterWindowsV4(
  attack: AttackAggregate,
  deploys: TroopDeployedEvent[],
  baseWindows: Map<string, CreditWindow>
): CadenceWindow[] {
  const windows: CadenceWindow[] = []
  for (const deploy of deploys) {
    if (!Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, deploy.troopType)) continue
    const stats = getTroopStats(deploy.troopType, attack.reservation.troopLevel)
    const cadence = stats.boostCadence ?? 0
    if (cadence <= 0 || cadence >= 1) continue
    const window = baseWindows.get(deploy.troopInstanceId)
    if (window && window.endMs > window.startMs) windows.push({ ...window, cadence })
  }
  return windows
}

/**
 * Rules v4 support-window extension: while a support deploy's credit window
 * is open, allied credit windows extend deterministically. Models (additive,
 * monotonic, non-recursive — every overlap is measured against BASE windows):
 * - Healer (healAmount + healRadius; physician's cart): each heal pulse
 *   (cadence = the healer's attackDelay) that fits inside the overlap grants
 *   the ally healAmount equivalent hit points, converted to lifetime at the
 *   same per-troop defense DPS the v3 attrition model burns at.
 * - Guard (guardRadius + guardRedirectShare; pavise bearer): while the guard
 *   overlaps a RANGED ally (range >= 1.5, mirroring the client redirect
 *   rule), guardRedirectShare of the fire aimed at the ally lands on the
 *   guard's larger pool instead — the ally's burn rate drops by that share,
 *   worth overlapMs x share extra lifetime.
 * - Siege tower ('siegetower', the one type-keyed support until a
 *   declarative ramp field exists): a parked ramp spares each overlapping
 *   ally a flat SIEGE_TOWER_PATHING_CREDIT_MS of wall-line pathing.
 * The extended lifetime stays clamped by maxDamageCreditMs.
 */
function supportExtendedLifetimeMs(
  attack: AttackAggregate,
  deploy: TroopDeployedEvent,
  baseLifetimeMs: number,
  deploys: TroopDeployedEvent[],
  baseWindows: Map<string, CreditWindow>,
  totalDefenseDps: number,
  deployedCount: number
): number {
  if (totalDefenseDps <= 0) return baseLifetimeMs
  if (!Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, deploy.troopType)) return baseLifetimeMs
  const own = baseWindows.get(deploy.troopInstanceId)
  if (!own) return baseLifetimeMs
  const stats = getTroopStats(deploy.troopType, attack.reservation.troopLevel)
  const perTroopDps = totalDefenseDps / Math.max(1, deployedCount)
  let bonusMs = 0
  for (const support of deploys) {
    if (support.troopInstanceId === deploy.troopInstanceId) continue
    if (!Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, support.troopType)) continue
    const supportStats = getTroopStats(support.troopType, attack.reservation.troopLevel)
    const window = baseWindows.get(support.troopInstanceId)
    if (!window) continue
    const overlapMs = Math.min(own.endMs, window.endMs) - Math.max(own.startMs, window.startMs)
    if (overlapMs <= 0) continue
    if ((supportStats.healAmount ?? 0) > 0 && (supportStats.healRadius ?? 0) > 0 && perTroopDps > 0) {
      const pulseMs = Math.max(1_000, Math.floor(supportStats.attackDelay ?? 1_000))
      const pulses = Math.floor(overlapMs / pulseMs)
      if (pulses > 0) bonusMs += Math.round(pulses * (supportStats.healAmount ?? 0) * 1_000 / perTroopDps)
    }
    if ((supportStats.guardRadius ?? 0) > 0 && (supportStats.guardRedirectShare ?? 0) > 0 && stats.range >= 1.5) {
      bonusMs += Math.floor(overlapMs * Math.min(0.95, supportStats.guardRedirectShare ?? 0))
    }
    if (support.troopType === 'siegetower') {
      bonusMs += SIEGE_TOWER_PATHING_CREDIT_MS
    }
  }
  if (bonusMs <= 0) return baseLifetimeMs
  return Math.min(attack.rules.maxDamageCreditMs, baseLifetimeMs + bonusMs)
}

function troopDamage(
  attack: AttackAggregate,
  deploy: TroopDeployedEvent,
  durationMs: number,
  boosts: AbilityUsedEvent[],
  lifetimeMs: number,
  cadenceWindows: CadenceWindow[] = []
): number {
  // A troop type deleted after this aggregate was stored settles to zero
  // credit instead of NaN-corrupting (level 1) or throwing (level 2+) in
  // getTroopStats. Surviving types are untouched.
  if (!Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, deploy.troopType)) return 0
  const stats = getTroopStats(deploy.troopType, attack.reservation.troopLevel)
  const delay = Math.max(150, Math.floor(stats.attackDelay ?? 1_000))
  const firstDelay = Math.max(0, Math.floor(stats.firstAttackDelay ?? 0))
  const creditEnd = Math.min(durationMs, deploy.atMs + Math.min(attack.rules.maxDamageCreditMs, lifetimeMs))
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

  // Rules v4 quartermaster war drums: a strike landed while any
  // quartermaster's credit window is open comes cadence-boosted — the
  // effective attack delay shrinks by boostCadence, worth
  // cadence / (1 - cadence) extra damage per boosted strike. Total boosted
  // strikes are capped at the troop's own strike count, so stacked
  // quartermasters never exceed one full aura.
  if (attack.rules.simulationVersion >= 4 && cadenceWindows.length > 0 && perStrike > 0) {
    let boostedStrikes = 0
    let cadence = 0
    for (const window of cadenceWindows) {
      const start = Math.max(deploy.atMs, window.startMs)
      const end = Math.min(creditEnd, window.endMs)
      boostedStrikes += attackCountInWindow(deploy.atMs, firstDelay, delay, start, end)
      cadence = Math.max(cadence, window.cadence)
    }
    boostedStrikes = Math.min(strikes, boostedStrikes)
    if (boostedStrikes > 0 && cadence > 0 && cadence < 1) {
      damage += Math.floor(boostedStrikes * perStrike * cadence / (1 - cadence))
    }
  }

  // Preserve the broad power profile of chain/splash units without accepting
  // client-authored hit lists. Exact targets remain deterministic below.
  if (stats.chainCount && stats.chainCount > 1) {
    damage = Math.floor(damage * (10_000 + Math.min(3, stats.chainCount - 1) * 3_500) / 10_000)
  } else if (stats.splashRadius && stats.splashRadius > 0) {
    damage = Math.floor(damage * 12_500 / 10_000)
  }

  // Rules v4 summoner credit (necromancer): each credited wave fields
  // summonCount units that fight for one summon interval at their sustained
  // DPS. Credited waves = floor(creditWindow / summonIntervalMs), floored at
  // 3 (even a briefly-lived summoner banks its opening waves) and capped by
  // summonCap. Additive on top of the summoner's own strikes and independent
  // of its chain/splash profile.
  if (
    attack.rules.simulationVersion >= 4
    && stats.summonType
    && (stats.summonCount ?? 0) > 0
    && (stats.summonIntervalMs ?? 0) > 0
    && Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, stats.summonType)
  ) {
    const summonStats = getTroopStats(stats.summonType, attack.reservation.troopLevel)
    const summonDelay = Math.max(150, Math.floor(summonStats.attackDelay ?? 1_000))
    const summonDps = Math.max(0, summonStats.damage) * 1_000 / summonDelay
    const waves = Math.min(
      stats.summonCap ?? Number.MAX_SAFE_INTEGER,
      Math.max(3, Math.floor(activeMs / (stats.summonIntervalMs ?? 1)))
    )
    damage += Math.floor((stats.summonCount ?? 0) * waves * summonDps * (stats.summonIntervalMs ?? 0) / 1_000)
  }
  return Math.max(0, damage)
}

function targetPriority(type: BuildingType, troop: TroopDeployedEvent, simulationVersion: number): number {
  const stats = getTroopStats(troop.troopType, 1)
  if (stats.targetPriority === 'town_hall' && type === 'town_hall') return 0
  if (stats.targetPriority === 'wall' && type === 'wall') return 0
  if (stats.targetPriority === 'defense' && BUILDING_DEFINITIONS[type].category === 'defense') return 0
  // Rules v4: resource raiders (goblin plunderer) head straight for the economy.
  if (simulationVersion >= 4 && stats.targetPriority === 'resource' && BUILDING_DEFINITIONS[type].category === 'resource') return 0
  if (type === 'wall') return 2
  return 1
}

function orderedTargets(states: MutableBuildingState[], attack: AttackAggregate, troop: TroopDeployedEvent): MutableBuildingState[] {
  return states
    .filter(state => state.remainingHitPoints > 0)
    .sort((left, right) => {
      const priority = targetPriority(left.type, troop, attack.rules.simulationVersion) - targetPriority(right.type, troop, attack.rules.simulationVersion)
      if (priority !== 0) return priority
      return deterministicScore(attack.simulationSeed, `${troop.troopInstanceId}:${left.id}`)
        .localeCompare(deterministicScore(attack.simulationSeed, `${troop.troopInstanceId}:${right.id}`))
    })
}

// resourceMultiplier stays 1 for every pre-v4 caller, so the wall-only
// multiplier selection below is byte-identical to the v3 code path.
function applyRawDamage(state: MutableBuildingState, rawDamage: number, wallMultiplier = 1, resourceMultiplier = 1): { consumed: number; dealt: number } {
  if (rawDamage <= 0 || state.remainingHitPoints <= 0) return { consumed: 0, dealt: 0 }
  const multiplier = state.type === 'wall'
    ? Math.max(1, wallMultiplier)
    : resourceMultiplier > 1 && BUILDING_DEFINITIONS[state.type].category === 'resource'
      ? resourceMultiplier
      : 1
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
  const totalDefenseDps = snapshotDefenseDps(attack)
  const deployedCount = attack.events.filter(event => event.type === 'TROOP_DEPLOYED').length
  // Rules v4 precomputes each deploy's BASE credit window once; the aura and
  // support-extension models overlap against these (never against extended
  // windows), keeping the v4 credit deterministic and non-recursive.
  const versionAtLeast4 = attack.rules.simulationVersion >= 4
  const troopDeploys = attack.events.filter((event): event is TroopDeployedEvent => event.type === 'TROOP_DEPLOYED')
  const baseWindows = versionAtLeast4
    ? baseCreditWindowsV4(attack, troopDeploys, durationMs, totalDefenseDps, deployedCount)
    : new Map<string, CreditWindow>()
  const cadenceWindows = versionAtLeast4 ? quartermasterWindowsV4(attack, troopDeploys, baseWindows) : []
  const actions: DamageAction[] = []

  for (const event of attack.events) {
    if (event.type === 'TROOP_DEPLOYED') {
      const baseLifetime = attritionLifetimeMs(attack, event, totalDefenseDps, deployedCount)
      const lifetime = versionAtLeast4
        ? supportExtendedLifetimeMs(attack, event, baseLifetime, troopDeploys, baseWindows, totalDefenseDps, deployedCount)
        : baseLifetime
      actions.push({
        atMs: event.atMs,
        eventIndex: event.eventIndex,
        damage: troopDamage(attack, event, durationMs, boosts, lifetime, cadenceWindows),
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
    // Rules v4: a resource raider converts the share of its budget spent on
    // resource-category buildings at resourceDamageMultiplier — the same
    // deterministic proportional model walls have always used.
    const resourceMultiplier = versionAtLeast4 && stats.targetPriority === 'resource'
      ? Math.max(1, stats.resourceDamageMultiplier ?? 1)
      : 1
    let budget = action.damage
    for (const target of orderedTargets(states, attack, action.troop)) {
      if (budget <= 0) break
      const applied = applyRawDamage(target, budget, stats.wallDamageMultiplier ?? 1, resourceMultiplier)
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
  // Version 3 keeps the v2 scoring but caps each troop's damage-credit window
  // by its deterministic expected survival time (see attritionLifetimeMs), so
  // an army that gets wiped in seconds no longer banks the full credit window.
  // Version 4 keeps the v3 scoring and attrition but credits the declarative
  // troop kits: resource-raider multipliers/tiering, summoner waves,
  // untargetable deploy windows, quartermaster cadence auras and support
  // window extensions (see the "Rules v4" helpers above).
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
