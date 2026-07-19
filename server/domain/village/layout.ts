import {
  BUILDING_DEFINITIONS,
  GENERATED_ONLY,
  MAP_SIZE,
  OBSTACLE_DEFINITIONS,
  TROOP_DEFINITIONS,
  type BuildingType,
  type ObstacleType
} from '../../../src/game/config/GameDefinitions'
import { armySpaceUsed, campCapacityOf } from '../../../src/game/config/Economy'
import type { SerializedBuilding, SerializedObstacle } from '../../../src/game/data/Models'
import { VillageRuleError } from './rules'

export const MAX_VILLAGE_BUILDINGS = 600
export const MAX_VILLAGE_OBSTACLES = 400
export const MAX_VILLAGE_ARMY_TYPES = 64

export interface VillageSanitizeContext {
  now: number
  createId: (prefix: 'b' | 'o') => string
}

export interface VillageLayoutProposal {
  buildings: SerializedBuilding[]
  obstacles: SerializedObstacle[]
  wallLevel: number
  changed: boolean
}

export interface PersistedBuildingNormalization {
  buildings: SerializedBuilding[]
  changed: boolean
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function toInt(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.floor(number) : fallback
}

function sanitizeId(value: unknown): string {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96)
}

/**
 * Repair stored buildings after catalog changes without re-sanitizing the
 * owner-authored layout. Known buildings are retained, levels and pending
 * upgrade targets are capped to the current definition, and an upgrade that
 * no longer has a higher legal target is completed at the cap.
 */
export function normalizePersistedBuildings(input: unknown): PersistedBuildingNormalization {
  if (!Array.isArray(input)) return { buildings: [], changed: true }
  const buildings: SerializedBuilding[] = []
  let changed = false
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      changed = true
      continue
    }
    const candidate = raw as SerializedBuilding
    const type = typeof candidate.type === 'string' ? candidate.type as BuildingType : undefined
    const definition = type && hasOwn(BUILDING_DEFINITIONS, type) ? BUILDING_DEFINITIONS[type] : undefined
    if (!definition) {
      changed = true
      continue
    }

    const maxLevel = definition.maxLevel ?? 1
    const level = clamp(toInt(candidate.level, 1), 1, maxLevel)
    const rawUpgradeTarget = toInt(candidate.upgradingTo, 0)
    const upgradeTarget = rawUpgradeTarget > 0 ? clamp(rawUpgradeTarget, 1, maxLevel) : 0
    const hasPendingUpgrade = upgradeTarget > level
    const hasUpgradeMetadata = candidate.upgradingTo !== undefined
      || candidate.upgradeStartedAt !== undefined
      || candidate.upgradeEndsAt !== undefined
    const needsRepair = level !== candidate.level
      || (hasPendingUpgrade && upgradeTarget !== candidate.upgradingTo)
      || (!hasPendingUpgrade && hasUpgradeMetadata)

    if (!needsRepair) {
      buildings.push(candidate)
      continue
    }

    const normalized = { ...candidate, level }
    if (hasPendingUpgrade) {
      normalized.upgradingTo = upgradeTarget
    } else {
      delete normalized.upgradingTo
      delete normalized.upgradeStartedAt
      delete normalized.upgradeEndsAt
    }
    buildings.push(normalized)
    changed = true
  }
  return { buildings, changed }
}

/** Normalize untrusted building payloads without consulting mutable state. */
export function sanitizeBuildings(input: unknown, context: VillageSanitizeContext): SerializedBuilding[] {
  if (!Array.isArray(input)) return []
  const out = new Map<string, SerializedBuilding>()
  const perType = new Map<string, number>()
  for (const raw of input.slice(0, MAX_VILLAGE_BUILDINGS)) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Partial<SerializedBuilding>
    const type = String(candidate.type ?? '') as BuildingType
    const definition = hasOwn(BUILDING_DEFINITIONS, type) ? BUILDING_DEFINITIONS[type] : undefined
    if (!definition) continue
    const id = sanitizeId(candidate.id) || context.createId('b')
    if (out.has(id)) {
      throw new VillageRuleError('INVALID', 'DUPLICATE_BUILDING_ID', `Duplicate building id: ${id}`)
    }
    const already = perType.get(type) ?? 0
    if (already >= (definition.maxCount ?? MAX_VILLAGE_BUILDINGS)) continue
    perType.set(type, already + 1)
    const builtAt = Number(candidate.builtAt)
    out.set(id, {
      id,
      type,
      gridX: clamp(toInt(candidate.gridX, 0), 0, MAP_SIZE - definition.width),
      gridY: clamp(toInt(candidate.gridY, 0), 0, MAP_SIZE - definition.height),
      level: clamp(toInt(candidate.level, 1), 1, definition.maxLevel ?? 1),
      ...(Number.isFinite(builtAt) ? { builtAt: clamp(builtAt, 0, context.now) } : {})
    })
  }
  return [...out.values()]
}

/** Normalize untrusted obstacle payloads without consulting mutable state. */
export function sanitizeObstacles(input: unknown, context: VillageSanitizeContext): SerializedObstacle[] {
  if (!Array.isArray(input)) return []
  const out = new Map<string, SerializedObstacle>()
  for (const raw of input.slice(0, MAX_VILLAGE_OBSTACLES)) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Partial<SerializedObstacle>
    const type = String(candidate.type ?? '') as ObstacleType
    const definition = hasOwn(OBSTACLE_DEFINITIONS, type) ? OBSTACLE_DEFINITIONS[type] : undefined
    if (!definition) continue
    const id = sanitizeId(candidate.id) || context.createId('o')
    if (out.has(id)) {
      throw new VillageRuleError('INVALID', 'DUPLICATE_OBSTACLE_ID', `Duplicate obstacle id: ${id}`)
    }
    out.set(id, {
      id,
      type,
      gridX: clamp(toInt(candidate.gridX, 0), 0, MAP_SIZE - definition.width),
      gridY: clamp(toInt(candidate.gridY, 0), 0, MAP_SIZE - definition.height)
    })
  }
  return [...out.values()]
}

/** Normalize persisted or untrusted troop counts into the supported catalog. */
export function sanitizeArmy(input: unknown): Record<string, number> {
  if (!input || typeof input !== 'object') return Object.create(null) as Record<string, number>
  const army = Object.create(null) as Record<string, number>
  for (const [type, count] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(army).length >= MAX_VILLAGE_ARMY_TYPES) break
    const key = sanitizeId(type)
    const value = clamp(toInt(count, 0), 0, 10_000)
    if (key && !GENERATED_ONLY.has(key) && hasOwn(TROOP_DEFINITIONS, key) && value > 0) army[key] = value
  }
  return army
}

export function layoutCollisionSignatures(
  buildings: readonly SerializedBuilding[],
  obstacles: readonly SerializedObstacle[]
): Set<string> {
  const occupied = new Map<string, string[]>()
  const claim = (id: string, x: number, y: number, width: number, height: number) => {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const key = `${x + dx},${y + dy}`
        const ids = occupied.get(key) ?? []
        ids.push(id)
        occupied.set(key, ids)
      }
    }
  }
  for (const building of buildings) {
    const definition = hasOwn(BUILDING_DEFINITIONS, building.type)
      ? BUILDING_DEFINITIONS[building.type as BuildingType]
      : undefined
    if (definition) claim(building.id, building.gridX, building.gridY, definition.width, definition.height)
  }
  for (const obstacle of obstacles) {
    const definition = hasOwn(OBSTACLE_DEFINITIONS, obstacle.type)
      ? OBSTACLE_DEFINITIONS[obstacle.type as ObstacleType]
      : undefined
    if (definition) claim(obstacle.id, obstacle.gridX, obstacle.gridY, definition.width, definition.height)
  }
  const collisions = new Set<string>()
  for (const [tile, rawIds] of occupied) {
    const ids = [...rawIds].sort()
    for (let left = 0; left < ids.length; left++) {
      for (let right = left + 1; right < ids.length; right++) {
        collisions.add(`${tile}:${ids[left]}|${ids[right]}`)
      }
    }
  }
  return collisions
}

export function assertCollisionFreeLayout(
  buildings: readonly SerializedBuilding[],
  obstacles: readonly SerializedObstacle[],
  allowedCollisions: ReadonlySet<string> = new Set()
): void {
  for (const collision of layoutCollisionSignatures(buildings, obstacles)) {
    if (allowedCollisions.has(collision)) continue
    const ids = collision.slice(collision.lastIndexOf(':') + 1).split('|')
    throw new VillageRuleError('INVALID', 'LAYOUT_COLLISION', `Layout collision between ${ids[0]} and ${ids[1]}`)
  }
}

/**
 * Footprint expansions can strand old grass under buildings or valuable
 * obstacles. Drop only stale grass; valuable obstacles remain authoritative.
 */
export function withoutCollidingObstacles(
  buildings: readonly SerializedBuilding[],
  obstacles: readonly SerializedObstacle[]
): SerializedObstacle[] {
  const occupied = new Set<string>()
  const tiles = (x: number, y: number, width: number, height: number) => {
    const result: string[] = []
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) result.push(`${x + dx},${y + dy}`)
    }
    return result
  }
  for (const building of buildings) {
    const definition = hasOwn(BUILDING_DEFINITIONS, building.type)
      ? BUILDING_DEFINITIONS[building.type as BuildingType]
      : undefined
    if (!definition) continue
    for (const tile of tiles(building.gridX, building.gridY, definition.width, definition.height)) occupied.add(tile)
  }
  const kept = new Set<SerializedObstacle>()
  for (const obstacle of obstacles) {
    if (obstacle.type === 'grass_patch') continue
    kept.add(obstacle)
    const definition = hasOwn(OBSTACLE_DEFINITIONS, obstacle.type)
      ? OBSTACLE_DEFINITIONS[obstacle.type as ObstacleType]
      : undefined
    if (!definition) continue
    for (const tile of tiles(obstacle.gridX, obstacle.gridY, definition.width, definition.height)) occupied.add(tile)
  }
  for (const obstacle of obstacles) {
    if (obstacle.type !== 'grass_patch') continue
    const definition = OBSTACLE_DEFINITIONS.grass_patch
    const footprint = tiles(obstacle.gridX, obstacle.gridY, definition.width, definition.height)
    if (footprint.some(tile => occupied.has(tile))) continue
    kept.add(obstacle)
    for (const tile of footprint) occupied.add(tile)
  }
  return obstacles.filter(obstacle => kept.has(obstacle))
}

export function sameCombatLayout(
  snapshot: readonly SerializedBuilding[],
  current: readonly SerializedBuilding[]
): boolean {
  if (snapshot.length !== current.length) return false
  const currentById = new Map(current.map(building => [building.id, building]))
  for (const building of snapshot) {
    const live = currentById.get(building.id)
    if (!live || live.type !== building.type || live.gridX !== building.gridX
      || live.gridY !== building.gridY || live.level !== building.level) return false
  }
  return true
}

export function sameObstacleLayout(
  snapshot: readonly SerializedObstacle[],
  current: readonly SerializedObstacle[]
): boolean {
  if (snapshot.length !== current.length) return false
  const currentById = new Map(current.map(obstacle => [obstacle.id, obstacle]))
  for (const obstacle of snapshot) {
    const live = currentById.get(obstacle.id)
    if (!live || live.type !== obstacle.type || live.gridX !== obstacle.gridX || live.gridY !== obstacle.gridY) return false
  }
  return true
}

/** Validate all cross-object rules and return the canonical proposal. */
export function validateVillageLayout(input: {
  currentBuildings: readonly SerializedBuilding[]
  currentObstacles: readonly SerializedObstacle[]
  currentWallLevel: number
  proposedBuildings: SerializedBuilding[]
  proposedObstacles: SerializedObstacle[]
  proposedWallLevel: unknown
  army: Readonly<Record<string, number>>
}): VillageLayoutProposal {
  if (!input.proposedBuildings.some(building => building.type === 'town_hall')) {
    throw new VillageRuleError('INVALID', 'MISSING_TOWN_HALL', 'A base must contain a town hall')
  }

  const oldObstacles = new Map(input.currentObstacles.map(obstacle => [obstacle.id, obstacle]))
  for (const obstacle of input.proposedObstacles) {
    const previous = oldObstacles.get(obstacle.id)
    if (previous) {
      if (obstacle.type !== previous.type || obstacle.gridX !== previous.gridX || obstacle.gridY !== previous.gridY) {
        throw new VillageRuleError('INVALID', 'OBSTACLE_MUTATED', `Obstacle ${obstacle.id} cannot be moved or changed`)
      }
    } else if (obstacle.type !== 'grass_patch') {
      throw new VillageRuleError('INVALID', 'OBSTACLE_CREATED', 'Only newly grown grass may be added to a saved village')
    }
  }

  const obstacles = withoutCollidingObstacles(input.proposedBuildings, input.proposedObstacles)
  const baselineCollisions = layoutCollisionSignatures(input.currentBuildings, input.currentObstacles)
  assertCollisionFreeLayout(input.proposedBuildings, obstacles, baselineCollisions)

  const capacity = campCapacityOf(input.proposedBuildings)
  const used = armySpaceUsed(input.army)
  if (used > capacity) {
    throw new VillageRuleError(
      'CONFLICT',
      'ARMY_OVER_CAPACITY',
      `The proposed camps hold ${capacity} space, but ${used} is occupied`,
      'ARMY_OVER_CAPACITY',
      { capacity, used }
    )
  }

  const wallLevels = new Set(input.proposedBuildings
    .filter(building => building.type === 'wall')
    .map(building => building.level))
  if (wallLevels.size > 1) {
    throw new VillageRuleError('INVALID', 'MIXED_WALL_LEVELS', 'Every wall segment must share one cohort level')
  }
  const wallDefinition = BUILDING_DEFINITIONS.wall
  const wallLevel = wallLevels.size === 1
    ? [...wallLevels][0]
    : clamp(toInt(input.proposedWallLevel, input.currentWallLevel), 1, wallDefinition.maxLevel ?? 1)
  if (wallLevels.size === 1 && toInt(input.proposedWallLevel, wallLevel) !== wallLevel) {
    throw new VillageRuleError('INVALID', 'WALL_COHORT_MISMATCH', 'wallLevel must match the wall cohort')
  }

  return {
    buildings: input.proposedBuildings,
    obstacles,
    wallLevel,
    changed: !sameCombatLayout(input.proposedBuildings, input.currentBuildings)
      || !sameObstacleLayout(obstacles, input.currentObstacles)
      || wallLevel !== input.currentWallLevel
  }
}
