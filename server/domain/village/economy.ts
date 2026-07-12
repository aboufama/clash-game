import { OBSTACLE_DEFINITIONS, type ObstacleType } from '../../../src/game/config/GameDefinitions'
import {
  deleteRefundGold,
  placementCharge,
  upgradeCharge,
  upgradeDurationMs
} from '../../../src/game/config/Economy'
import type { SerializedBuilding, SerializedObstacle } from '../../../src/game/data/Models'
import { VillageRuleError } from './rules'

export interface VillageMutationPricing {
  buildings: SerializedBuilding[]
  charges: { gold: number; ore: number }
  refundGold: number
  obstacleRewards: number
  bill: { gold: number; ore: number }
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/**
 * Price and materialize a proposed layout diff. This function never mutates
 * either input collection, which makes retries and refusal paths atomic.
 */
export function priceVillageMutation(input: {
  currentBuildings: readonly SerializedBuilding[]
  currentObstacles: readonly SerializedObstacle[]
  proposedBuildings: readonly SerializedBuilding[]
  proposedObstacles: readonly SerializedObstacle[]
  now: number
  upgradeTimeScale: number
}): VillageMutationPricing {
  const buildings = input.proposedBuildings.map(building => ({ ...building }))
  const charges = { gold: 0, ore: 0 }
  let refundGold = 0
  let obstacleRewards = 0
  const oldById = new Map(input.currentBuildings.map(building => [building.id, building]))
  const keptIds = new Set<string>()

  for (const next of buildings) {
    keptIds.add(next.id)
    const previous = oldById.get(next.id)
    if (!previous) {
      const charge = placementCharge(next.type, next.level)
      charges.gold += charge.gold
      charges.ore += charge.ore
      next.builtAt = input.now
      continue
    }
    if (previous.type !== next.type) {
      refundGold += deleteRefundGold(previous.type, previous.level)
      const charge = placementCharge(next.type, next.level)
      charges.gold += charge.gold
      charges.ore += charge.ore
      next.builtAt = input.now
      continue
    }
    if (next.level > previous.level) {
      if (next.type === 'wall') {
        const charge = upgradeCharge(next.type, previous.level, next.level)
        charges.gold += charge.gold
        charges.ore += charge.ore
        next.builtAt = input.now
        continue
      }
      if (previous.upgradingTo) {
        throw new VillageRuleError(
          'CONFLICT',
          'UPGRADE_IN_PROGRESS',
          'That building is already being upgraded',
          'UPGRADE_IN_PROGRESS',
          { buildingId: previous.id }
        )
      }
      if (next.level !== previous.level + 1) {
        throw new VillageRuleError('INVALID', 'MULTI_LEVEL_UPGRADE', 'Buildings upgrade one level at a time')
      }
      const charge = upgradeCharge(next.type, previous.level, next.level)
      charges.gold += charge.gold
      charges.ore += charge.ore
      next.upgradingTo = next.level
      next.upgradeEndsAt = input.now
        + Math.round(upgradeDurationMs(next.type, next.level) * input.upgradeTimeScale)
      next.level = previous.level
      next.builtAt = previous.builtAt ?? next.builtAt
      continue
    }

    next.builtAt = previous.builtAt ?? next.builtAt
    if (previous.upgradingTo && next.level === previous.level) {
      next.upgradingTo = previous.upgradingTo
      next.upgradeEndsAt = previous.upgradeEndsAt
    }
  }

  for (const [id, previous] of oldById) {
    if (!keptIds.has(id)) refundGold += deleteRefundGold(previous.type, previous.level)
  }

  const keptObstacles = new Set(input.proposedObstacles.map(obstacle => obstacle.id))
  for (const previous of input.currentObstacles) {
    if (keptObstacles.has(previous.id)) continue
    const definition = hasOwn(OBSTACLE_DEFINITIONS, previous.type)
      ? OBSTACLE_DEFINITIONS[previous.type as ObstacleType]
      : undefined
    if (definition) obstacleRewards += definition.goldReward
  }

  return {
    buildings,
    charges,
    refundGold,
    obstacleRewards,
    bill: { gold: charges.gold - refundGold - obstacleRewards, ore: charges.ore }
  }
}

