import { withoutCollidingObstacles, sameCombatLayout, sameObstacleLayout } from './layout'
import type { SerializedBuilding, SerializedObstacle } from '../../../src/game/data/Models'

/**
 * The one layout mutation admitted before ordinary gameplay unlocks.
 * Existing buildings must be byte-for-gameplay identical, the wall cohort
 * cannot move, and obstacle changes are limited to grass displaced by the
 * new Watchtower footprint (the ordinary layout canonicalizer performs that
 * exact cleanup).
 */
export function isExactFirstWatchtowerPlacement(input: {
  currentBuildings: readonly SerializedBuilding[]
  currentObstacles: readonly SerializedObstacle[]
  currentWallLevel: number
  proposedBuildings: readonly SerializedBuilding[]
  proposedObstacles: readonly SerializedObstacle[]
  proposedWallLevel: number
}): boolean {
  if (input.proposedWallLevel !== input.currentWallLevel) return false
  if (input.currentBuildings.some(building => building.type === 'watchtower')) return false
  if (input.proposedBuildings.length !== input.currentBuildings.length + 1) return false

  const currentIds = new Set(input.currentBuildings.map(building => building.id))
  const additions = input.proposedBuildings.filter(building => !currentIds.has(building.id))
  if (additions.length !== 1) return false
  const watchtower = additions[0]
  if (watchtower.type !== 'watchtower' || watchtower.level !== 1) return false

  const retained = input.proposedBuildings.filter(building => currentIds.has(building.id))
  if (!sameCombatLayout(input.currentBuildings, retained)) return false

  const expectedObstacles = withoutCollidingObstacles(
    [...input.currentBuildings, watchtower],
    input.currentObstacles
  )
  return sameObstacleLayout(expectedObstacles, input.proposedObstacles)
}
