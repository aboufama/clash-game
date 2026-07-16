import { BUILDING_DEFINITIONS, normalizeTroopLevel, type BuildingType } from '../../../src/game/config/GameDefinitions'
import { productionRatesPerSecond, resourceCapacity } from '../../../src/game/config/Economy'
import type { SerializedBuilding } from '../../../src/game/data/Models'

/**
 * Persisted simulation contract. Increasing this number is an explicit economy
 * migration; old villages must be materialized before switching versions.
 */
export const VILLAGE_SIMULATION_VERSION = 2
export const POPULATION_BASE_CAPACITY = 2
export const POPULATION_MAX = 30
export const STARTING_POPULATION = 3
export const POPULATION_GROWTH_MS = 3 * 60_000
export const FOOD_PER_GROWTH = 10

const POPULATION_HOUSING: Partial<Record<BuildingType, number>> = {
  town_hall: 3,
  barracks: 1,
  lab: 1,
  army_camp: 1,
  mine: 1,
  farm: 2,
  storage: 1
}

const WORKER_REQUIREMENTS: Partial<Record<BuildingType, number>> = {
  mine: 2,
  farm: 2
}

export interface VillagePopulationState {
  count: number
  lastGrowthAt: number
  bornAt?: number[]
}

/** The minimum persisted fields needed by the deterministic village clock. */
export interface SimulatableVillage {
  buildings: SerializedBuilding[]
  balance: number
  ore: number
  food: number
  lastAccrualAt: number
  population: VillagePopulationState
  productionRemainders?: { ore: number; food: number }
  simulationVersion?: number
  simulatedThrough?: number
}

export interface VillageAdvanceOptions {
  maxBalance?: number
  /** Raid settlement can freeze births while food is reserved as displayed loot. */
  populationLocked?: boolean
  /** Local debug grants may intentionally hold ore/food above storage capacity. */
  preserveOverCapacity?: boolean
}

export interface VillageAdvanceResult {
  from: number
  through: number
  simulationVersion: number
  /** Actual production credited before population consumes food. */
  produced: { gold: number; ore: number; food: number }
  foodConsumed: number
  births: number
  departures: number
  completedUpgradeIds: string[]
  appearanceChanged: boolean
  nextEventAt?: number
}

/**
 * Stable public-cache revision delta for one deterministic catch-up interval.
 * Counting events (instead of returning a boolean) matters for read-only
 * postcard projections: the same checkpoint/time pair yields the same
 * revision, while another birth or completed upgrade yields a newer one.
 */
export function appearanceRevisionDelta(result: VillageAdvanceResult): number {
  return result.completedUpgradeIds.length + result.births + result.departures
}

function finiteInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function workersNeeded(buildings: SerializedBuilding[]): number {
  let needed = 0
  for (const building of buildings) needed += WORKER_REQUIREMENTS[building.type as BuildingType] ?? 0
  return needed
}

export function staffingFactor(buildings: SerializedBuilding[], populationCount: number): number {
  const needed = workersNeeded(buildings)
  return needed <= 0 ? 1 : clamp(populationCount / needed, 0, 1)
}

export function populationCapacity(buildings: SerializedBuilding[]): number {
  let capacity = POPULATION_BASE_CAPACITY
  for (const building of buildings) {
    const housing = POPULATION_HOUSING[building.type as BuildingType]
    if (!housing) continue
    capacity += building.type === 'town_hall'
      ? housing * Math.max(1, finiteInt(building.level, 1))
      : housing
  }
  return Math.min(POPULATION_MAX, capacity)
}

/** All player troops share the strongest completed home-lab level. */
export function troopLevelOf(buildings: SerializedBuilding[]): number {
  let level = 1
  for (const building of buildings) {
    if (building.type === 'lab' && !building.upgradingTo) level = Math.max(level, finiteInt(building.level, 1))
  }
  return normalizeTroopLevel(level)
}

function remaindersOf(village: SimulatableVillage): { ore: number; food: number } {
  const current = village.productionRemainders
  if (current
    && Number.isFinite(current.ore) && current.ore >= 0 && current.ore < 1
    && Number.isFinite(current.food) && current.food >= 0 && current.food < 1) return current
  return (village.productionRemainders = { ore: 0, food: 0 })
}

function normalizeState(village: SimulatableVillage, at: number): void {
  village.balance = Math.max(0, Number.isFinite(village.balance) ? village.balance : 0)
  village.ore = Math.max(0, finiteInt(village.ore, 0))
  village.food = Math.max(0, finiteInt(village.food, 0))
  village.lastAccrualAt = Number.isFinite(village.lastAccrualAt) ? Math.min(village.lastAccrualAt, at) : at
  village.population ??= { count: STARTING_POPULATION, lastGrowthAt: village.lastAccrualAt }
  village.population.count = clamp(finiteInt(village.population.count, STARTING_POPULATION), 0, POPULATION_MAX)
  village.population.lastGrowthAt = Number.isFinite(village.population.lastGrowthAt)
    ? Math.min(village.population.lastGrowthAt, at)
    : village.lastAccrualAt
  village.population.bornAt = Array.isArray(village.population.bornAt)
    ? village.population.bornAt.filter(Number.isFinite).slice(-POPULATION_MAX)
    : []
  remaindersOf(village)
}

function nextUpgradeAt(buildings: SerializedBuilding[], after: number): number {
  let next = Number.POSITIVE_INFINITY
  for (const building of buildings) {
    if (!building.upgradingTo) continue
    const endsAt = Number(building.upgradeEndsAt)
    if (Number.isFinite(endsAt) && endsAt > after) next = Math.min(next, endsAt)
  }
  return next
}

function resolveUpgradesAt(village: SimulatableVillage, at: number, completed: string[]): boolean {
  let changed = false
  for (const building of village.buildings) {
    if (!building.upgradingTo || (building.upgradeEndsAt ?? 0) > at) continue
    const definition = BUILDING_DEFINITIONS[building.type as BuildingType]
    building.level = clamp(finiteInt(building.upgradingTo, building.level), 1, definition?.maxLevel ?? finiteInt(building.upgradingTo, 1))
    building.builtAt = Number.isFinite(building.upgradeEndsAt) ? building.upgradeEndsAt : at
    delete building.upgradingTo
    delete building.upgradeStartedAt
    delete building.upgradeEndsAt
    completed.push(building.id)
    changed = true
  }
  return changed
}

function accrueSegment(
  village: SimulatableVillage,
  from: number,
  to: number,
  maxBalance: number,
  produced: VillageAdvanceResult['produced'],
  preserveOverCapacity: boolean
): void {
  if (to <= from) return
  const seconds = (to - from) / 1000
  const rates = productionRatesPerSecond(village.buildings)
  const staffing = staffingFactor(village.buildings, village.population.count)
  const capacities = resourceCapacity(village.buildings)
  const remainders = remaindersOf(village)

  const beforeGold = Math.floor(village.balance)
  village.balance = clamp(village.balance + rates.gold * seconds, 0, maxBalance)
  produced.gold += Math.max(0, Math.floor(village.balance) - beforeGold)

  const credit = (kind: 'ore' | 'food', rate: number, cap: number) => {
    village[kind] = preserveOverCapacity
      ? Math.max(0, finiteInt(village[kind], 0))
      : clamp(finiteInt(village[kind], 0), 0, cap)
    if (village[kind] >= cap) {
      remainders[kind] = 0
      return
    }
    // Quantize fractional production so splitting one interval into many
    // requests cannot lose a whole unit to binary floating-point drift.
    const total = Math.round((remainders[kind] + Math.max(0, rate * staffing * seconds)) * 1e9) / 1e9
    const whole = Math.floor(total)
    const credited = Math.min(cap - village[kind], whole)
    village[kind] += credited
    produced[kind] += credited
    remainders[kind] = village[kind] >= cap ? 0 : total - whole
  }

  credit('ore', rates.ore, capacities.ore)
  credit('food', rates.food, capacities.food)
}

/** Exact time at which production can supply the next due inhabitant's meal. */
function foodReadyAt(village: SimulatableVillage, from: number): number {
  if (village.food >= FOOD_PER_GROWTH) return from
  const cap = resourceCapacity(village.buildings).food
  if (cap < FOOD_PER_GROWTH) return Number.POSITIVE_INFINITY
  const rate = productionRatesPerSecond(village.buildings).food
    * staffingFactor(village.buildings, village.population.count)
  if (!(rate > 0)) return Number.POSITIVE_INFINITY
  const remainder = remaindersOf(village).food
  const unitsNeeded = FOOD_PER_GROWTH - village.food
  const productionNeeded = Math.max(0, unitsNeeded - remainder)
  return from + Math.max(1, Math.ceil(productionNeeded / rate * 1000))
}

function nextSimulationEventAt(village: SimulatableVillage, from: number, populationLocked: boolean): number {
  let next = nextUpgradeAt(village.buildings, from)
  const capacity = populationCapacity(village.buildings)
  if (!populationLocked && village.population.count < capacity) {
    const growthDue = village.population.lastGrowthAt + POPULATION_GROWTH_MS
    next = Math.min(next, growthDue > from ? growthDue : foodReadyAt(village, from))
  }
  return next
}

/**
 * Advances one village without wall-clock reads or background ticks.
 *
 * The function is deterministic for `(state, targetTime, options)` and walks
 * only meaningful event boundaries. Calling it once for a week produces the
 * same state as calling it once per second, including upgrade-rate changes and
 * population staffing changes.
 */
export function advanceVillage(
  village: SimulatableVillage,
  targetTime: number,
  options: VillageAdvanceOptions = {}
): VillageAdvanceResult {
  const target = Number.isFinite(targetTime) ? Math.max(0, Math.floor(targetTime)) : 0
  normalizeState(village, target)
  const from = village.lastAccrualAt
  const maxBalance = Number.isFinite(options.maxBalance) ? Math.max(0, options.maxBalance!) : 1_000_000_000
  const result: VillageAdvanceResult = {
    from,
    through: from,
    simulationVersion: VILLAGE_SIMULATION_VERSION,
    produced: { gold: 0, ore: 0, food: 0 },
    foodConsumed: 0,
    births: 0,
    departures: 0,
    completedUpgradeIds: [],
    appearanceChanged: false
  }

  let cursor = from
  // A corrupted future checkpoint must never run the economy backwards.
  if (cursor > target) cursor = target

  while (cursor <= target) {
    const capacityBefore = populationCapacity(village.buildings)
    const wasAtCapacity = village.population.count >= capacityBefore
    if (resolveUpgradesAt(village, cursor, result.completedUpgradeIds)) {
      result.appearanceChanged = true
      const capacityAfter = populationCapacity(village.buildings)
      // A newly expanded full village starts its next growth interval at the
      // exact completion boundary; it does not bank residents while full.
      if (wasAtCapacity && capacityAfter > capacityBefore) village.population.lastGrowthAt = cursor
    }

    const capacity = populationCapacity(village.buildings)
    if (village.population.count > capacity) {
      result.departures += village.population.count - capacity
      village.population.count = capacity
      village.population.lastGrowthAt = cursor
    }

    let handledImmediateEvent = false
    if (!options.populationLocked && village.population.count < capacity) {
      const dueAt = village.population.lastGrowthAt + POPULATION_GROWTH_MS
      if (dueAt <= cursor && village.food >= FOOD_PER_GROWTH) {
        village.food -= FOOD_PER_GROWTH
        result.foodConsumed += FOOD_PER_GROWTH
        village.population.count += 1
        village.population.lastGrowthAt = dueAt
        village.population.bornAt!.push(cursor)
        if (village.population.bornAt!.length > POPULATION_MAX) {
          village.population.bornAt!.splice(0, village.population.bornAt!.length - POPULATION_MAX)
        }
        result.births += 1
        handledImmediateEvent = true
      }
    }
    if (handledImmediateEvent) continue

    if (cursor >= target) break
    let boundary = Math.min(target, nextUpgradeAt(village.buildings, cursor))
    const currentCapacity = populationCapacity(village.buildings)
    if (!options.populationLocked && village.population.count < currentCapacity) {
      const dueAt = village.population.lastGrowthAt + POPULATION_GROWTH_MS
      boundary = Math.min(boundary, dueAt > cursor ? dueAt : foodReadyAt(village, cursor))
    }
    if (!Number.isFinite(boundary) || boundary <= cursor) boundary = target
    accrueSegment(village, cursor, boundary, maxBalance, result.produced, Boolean(options.preserveOverCapacity))
    cursor = boundary
    village.lastAccrualAt = cursor
    result.through = cursor
  }

  // While housing is full, time is deliberately not banked. This assignment
  // is cadence-invariant because every intermediate call makes the same pause.
  if (village.population.count >= populationCapacity(village.buildings)) {
    village.population.lastGrowthAt = target
  }
  village.lastAccrualAt = target
  village.simulatedThrough = target
  village.simulationVersion = VILLAGE_SIMULATION_VERSION
  result.through = target
  const next = nextSimulationEventAt(village, target, Boolean(options.populationLocked))
  if (Number.isFinite(next)) result.nextEventAt = Math.max(target, next)
  return result
}
