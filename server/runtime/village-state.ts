import type { SerializedBuilding, SerializedObstacle, SerializedWorld } from '../../src/game/data/Models'
import { GENERATED_ONLY, TROOP_DEFINITIONS } from '../../src/game/config/GameDefinitions'
import { resourceCapacity } from '../../src/game/config/Economy'
import type { PlayerProfile, PublicWorldSnapshot } from '../protocol'
import {
  VILLAGE_SIMULATION_VERSION,
  advanceVillage,
  appearanceRevisionDelta,
  populationCapacity,
  staffingFactor,
  workersNeeded,
  type VillageAdvanceResult,
  type VillagePopulationState
} from '../domain/village'
import type {
  AccountRecord,
  JsonObject,
  JsonValue,
  VillageRecord,
  WorldPlotRecord
} from '../persistence'

export const MAX_PLAYER_GOLD = 1_000_000_000

export function villageBuildings(village: Pick<VillageRecord, 'buildings'>): SerializedBuilding[] {
  return village.buildings as unknown as SerializedBuilding[]
}

export function villageObstacles(village: Pick<VillageRecord, 'obstacles'>): SerializedObstacle[] {
  return village.obstacles as unknown as SerializedObstacle[]
}

export function villageArmy(village: Pick<VillageRecord, 'army'>): Record<string, number> {
  const raw = village.army as unknown as Record<string, number>
  // Mirror the legacy runtime's sanitizeArmy: persisted counts for troop
  // types deleted from the catalog must not survive reads — they would eat
  // camp housing and make attack preparation throw on the unknown type.
  const supported = (type: string) => Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, type) && !GENERATED_ONLY.has(type)
  if (Object.keys(raw).every(supported)) return raw
  const army: Record<string, number> = {}
  for (const [type, count] of Object.entries(raw)) {
    if (supported(type)) army[type] = count
  }
  return army
}

export function villagePopulation(village: Pick<VillageRecord, 'population'>): VillagePopulationState {
  const raw = village.population as Record<string, unknown>
  return {
    count: Number(raw.count) || 0,
    lastGrowthAt: Number(raw.lastGrowthAt) || 0,
    bornAt: Array.isArray(raw.bornAt)
      ? raw.bornAt.filter((value): value is number => Number.isFinite(value))
      : []
  }
}

/**
 * Materialize one normalized village at a caller-supplied clock boundary.
 * The caller owns the transaction/CAS and decides whether this is a persisted
 * owner read or a derived public postcard.
 */
export function materializeVillage(
  village: VillageRecord,
  now: Date,
  options: { populationLocked?: boolean; preserveOverCapacity?: boolean } = {}
): VillageAdvanceResult {
  const simulation = {
    buildings: villageBuildings(village).map(building => ({ ...building })),
    balance: village.gold,
    ore: village.ore,
    food: village.food,
    lastAccrualAt: village.simulatedThrough.getTime(),
    population: villagePopulation(village),
    productionRemainders: { ...village.productionRemainders },
    simulationVersion: village.simulationVersion,
    simulatedThrough: village.simulatedThrough.getTime()
  }
  const result = advanceVillage(simulation, now.getTime(), {
    maxBalance: MAX_PLAYER_GOLD,
    populationLocked: options.populationLocked,
    preserveOverCapacity: options.preserveOverCapacity
  })
  village.buildings = simulation.buildings as unknown as JsonValue[]
  village.gold = simulation.balance
  village.ore = simulation.ore
  village.food = simulation.food
  village.population = simulation.population as unknown as JsonObject
  village.productionRemainders = simulation.productionRemainders ?? { ore: 0, food: 0 }
  village.simulatedThrough = new Date(simulation.simulatedThrough ?? now.getTime())
  village.simulationVersion = simulation.simulationVersion ?? VILLAGE_SIMULATION_VERSION
  village.nextEventAt = result.nextEventAt === undefined ? null : new Date(result.nextEventAt)
  const revisionDelta = appearanceRevisionDelta(result)
  if (revisionDelta > 0) {
    village.appearanceRevision += revisionDelta
    if (result.appearanceChanged) {
      village.lastMutationAt = new Date(Math.max(
        village.lastMutationAt.getTime(),
        ...simulation.buildings.map(building => building.builtAt ?? 0)
      ))
    }
  }
  return result
}

export function profileOf(account: AccountRecord, plot: WorldPlotRecord): PlayerProfile {
  return {
    id: account.id,
    username: account.username,
    trophies: account.trophies,
    plotX: plot.x,
    plotY: plot.y,
    shieldUntil: account.shieldUntil?.getTime() ?? 0,
    createdAt: account.createdAt.getTime(),
    lastSeen: account.lastSeenAt.getTime(),
    registered: account.registered
  }
}

export function stoneMaturityOf(account: AccountRecord, now: Date): number {
  return Math.min(1, Math.max(0, (now.getTime() - account.createdAt.getTime()) / (9 * 60_000)))
}

/** Effective upgrade-clock policy a service advertises on owned world payloads. */
export interface AdvertisedUpgradePolicy {
  fixedDurationMs?: number
  timeScale?: number
}

export function serializedWorldOf(
  account: AccountRecord,
  village: VillageRecord,
  now: Date,
  options: { stoneMaturity?: boolean; upgradePolicy?: AdvertisedUpgradePolicy } = {}
): SerializedWorld {
  const buildings = villageBuildings(village)
  const population = villagePopulation(village)
  return {
    id: `world_${account.id}`,
    ownerId: account.id,
    username: account.username,
    buildings: buildings.map(building => ({ ...building })),
    obstacles: villageObstacles(village).map(obstacle => ({ ...obstacle })),
    resources: { gold: Math.floor(village.gold), ore: village.ore, food: village.food },
    storage: resourceCapacity(buildings),
    population: {
      count: population.count,
      capacity: populationCapacity(buildings),
      workersNeeded: workersNeeded(buildings),
      staffing: staffingFactor(buildings, population.count),
      bornAt: [...(population.bornAt ?? [])]
    },
    life: {
      version: 1,
      identity: account.id,
      population: population.count,
      bornAt: [...(population.bornAt ?? [])],
      simulatedThrough: village.simulatedThrough.getTime()
    },
    army: { ...villageArmy(village) },
    // Own-world payloads carry trophies so a defense loss reaches the HUD on
    // the ordinary world poll instead of waiting for the next attack.
    trophies: account.trophies,
    wallLevel: village.wallLevel,
    lastSaveTime: village.lastMutationAt.getTime(),
    revision: village.economyRevision,
    ...(options.stoneMaturity ? { stoneMaturity: stoneMaturityOf(account, now) } : {}),
    ...(options.upgradePolicy ? { upgradePolicy: { ...options.upgradePolicy } } : {})
  }
}

export function publicWorldOf(
  account: AccountRecord,
  village: VillageRecord
): PublicWorldSnapshot {
  const population = villagePopulation(village)
  return {
    id: `world_${account.id}`,
    ownerId: account.id,
    username: account.username,
    buildings: villageBuildings(village).map(building => ({ ...building })),
    obstacles: villageObstacles(village).map(obstacle => ({ ...obstacle })),
    wallLevel: village.wallLevel,
    lastSaveTime: village.lastMutationAt.getTime(),
    revision: village.appearanceRevision,
    life: {
      version: 1,
      identity: account.id,
      population: population.count,
      bornAt: [...(population.bornAt ?? [])],
      simulatedThrough: village.simulatedThrough.getTime()
    }
  }
}
