import {
  BUILDING_DEFINITIONS,
  MAP_SIZE,
  STARTER_VILLAGE,
  copyStarterVillageConfig,
  type BuildingType,
  type StarterBuildingPlacement,
  type StarterVillageConfig
} from '../../../src/game/config/GameDefinitions'
import { placementCharge } from '../../../src/game/config/Economy'
import { ApiError } from '../../errors'
import { assertCollisionFreeLayout, MAX_VILLAGE_BUILDINGS } from './layout'

export const STARTER_RESOURCE_MAX = 1_000_000_000

export interface AdminStarterBuildingCatalogEntry {
  type: BuildingType
  name: string
  category: string
  width: number
  height: number
  maxLevel: number
  maxCount: number
}

export class StarterVillageConfigError extends Error {}

function recordOf(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StarterVillageConfigError(`${label} must be an object`)
  }
  return raw as Record<string, unknown>
}

function integer(raw: unknown, label: string, minimum: number, maximum: number): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new StarterVillageConfigError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function hasBuildingType(type: string): type is BuildingType {
  return Object.prototype.hasOwnProperty.call(BUILDING_DEFINITIONS, type)
}

/** Strictly parse the persisted/admin-authored starter template without clamping or dropping rows. */
export function parseStarterVillageConfig(raw: unknown): StarterVillageConfig {
  const root = recordOf(raw, 'starter village')
  const resourceInput = recordOf(root.resources, 'starter resources')
  const resources = {
    gold: integer(resourceInput.gold, 'starting gold', 0, STARTER_RESOURCE_MAX),
    ore: integer(resourceInput.ore, 'starting ore', 0, STARTER_RESOURCE_MAX),
    food: integer(resourceInput.food, 'starting food', 0, STARTER_RESOURCE_MAX)
  }

  if (!Array.isArray(root.buildings)) {
    throw new StarterVillageConfigError('starter buildings must be an array')
  }
  if (root.buildings.length > MAX_VILLAGE_BUILDINGS) {
    throw new StarterVillageConfigError(`starter buildings may not exceed ${MAX_VILLAGE_BUILDINGS} rows`)
  }

  const counts = new Map<BuildingType, number>()
  const buildings: StarterBuildingPlacement[] = root.buildings.map((rawBuilding, index) => {
    const candidate = recordOf(rawBuilding, `starter building ${index + 1}`)
    if (typeof candidate.type !== 'string' || !hasBuildingType(candidate.type)) {
      throw new StarterVillageConfigError(`starter building ${index + 1} has an unknown type`)
    }
    const type = candidate.type
    const definition = BUILDING_DEFINITIONS[type]
    const maximumCount = definition.maxCount ?? MAX_VILLAGE_BUILDINGS
    const nextCount = (counts.get(type) ?? 0) + 1
    if (nextCount > maximumCount) {
      throw new StarterVillageConfigError(`${definition.name} may appear at most ${maximumCount} times`)
    }
    counts.set(type, nextCount)
    return {
      type,
      level: integer(candidate.level, `${definition.name} level`, 1, definition.maxLevel ?? 1),
      gridX: integer(candidate.gridX, `${definition.name} X coordinate`, 0, MAP_SIZE - definition.width),
      gridY: integer(candidate.gridY, `${definition.name} Y coordinate`, 0, MAP_SIZE - definition.height)
    }
  })

  if ((counts.get('town_hall') ?? 0) !== 1) {
    throw new StarterVillageConfigError('starter villages must contain exactly one Town Hall')
  }

  // A starter without a Watchtower enters the mandatory placement lesson.
  // Keep that authored gate completable even when an operator customizes the
  // wallet; starters that already own the tower intentionally skip the lesson.
  if ((counts.get('watchtower') ?? 0) === 0) {
    const watchtowerCharge = placementCharge('watchtower', 1)
    if (resources.gold < watchtowerCharge.gold || resources.ore < watchtowerCharge.ore) {
      throw new StarterVillageConfigError(
        `starter villages without a Watchtower require at least ${watchtowerCharge.gold} gold and ${watchtowerCharge.ore} ore`
      )
    }
  }

  const wallDefinition = BUILDING_DEFINITIONS.wall
  const wallLevel = integer(root.wallLevel, 'starter wall level', 1, wallDefinition.maxLevel ?? 1)
  const placedWallLevels = new Set(buildings
    .filter(building => building.type === 'wall')
    .map(building => building.level))
  if (placedWallLevels.size > 1 || (placedWallLevels.size === 1 && !placedWallLevels.has(wallLevel))) {
    throw new StarterVillageConfigError('every starter wall must match the configured wall cohort level')
  }

  try {
    assertCollisionFreeLayout(buildings.map((building, index) => ({
      id: `starter_${index}`,
      ...building
    })), [])
  } catch (error) {
    throw new StarterVillageConfigError(error instanceof Error ? error.message : 'starter buildings overlap')
  }

  return { buildings, resources, wallLevel }
}

/** Resolve an unset persisted override to the shipped template and always return a detached snapshot. */
export function effectiveStarterVillageConfig(raw: unknown): StarterVillageConfig {
  if (raw === undefined || raw === null) return copyStarterVillageConfig(STARTER_VILLAGE)
  return parseStarterVillageConfig(raw)
}

/** Convert strict starter validation failures into the shared admin API error contract. */
export function adminStarterVillageConfig(raw: unknown): StarterVillageConfig {
  try {
    return parseStarterVillageConfig(raw)
  } catch (error) {
    if (!(error instanceof StarterVillageConfigError)) throw error
    throw new ApiError(400, error.message, 'ADMIN_INVALID_INPUT')
  }
}

export function adminStarterBuildingCatalog(): AdminStarterBuildingCatalogEntry[] {
  return (Object.entries(BUILDING_DEFINITIONS) as Array<[BuildingType, (typeof BUILDING_DEFINITIONS)[BuildingType]]>)
    .map(([type, definition]) => ({
      type,
      name: definition.name,
      category: definition.category ?? 'other',
      width: definition.width,
      height: definition.height,
      maxLevel: definition.maxLevel ?? 1,
      maxCount: definition.maxCount ?? MAX_VILLAGE_BUILDINGS
    }))
}

export const ADMIN_STARTER_LIMITS = {
  mapSize: MAP_SIZE,
  maxBalance: STARTER_RESOURCE_MAX,
  maxBuildings: MAX_VILLAGE_BUILDINGS
} as const
