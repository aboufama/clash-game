import assert from 'node:assert/strict'
import { placementCharge, upgradeCharge, upgradeDurationMs } from '../../../src/game/config/Economy'
import type { SerializedBuilding, SerializedObstacle } from '../../../src/game/data/Models'
import {
  VillageRuleError,
  layoutCollisionSignatures,
  priceVillageMutation,
  sanitizeArmy,
  sanitizeBuildings,
  validateVillageLayout,
  withoutCollidingObstacles
} from './index'

const now = 1_700_000_000_000
let generatedId = 0
const context = { now, createId: (prefix: 'b' | 'o') => `${prefix}_generated_${++generatedId}` }

function building(
  id: string,
  type: SerializedBuilding['type'],
  gridX: number,
  gridY: number,
  level = 1
): SerializedBuilding {
  return { id, type, gridX, gridY, level }
}

function obstacle(
  id: string,
  type: SerializedObstacle['type'],
  gridX: number,
  gridY: number
): SerializedObstacle {
  return { id, type, gridX, gridY }
}

function expectRule(rule: VillageRuleError['rule'], operation: () => unknown): VillageRuleError {
  try {
    operation()
  } catch (error) {
    assert.ok(error instanceof VillageRuleError)
    assert.equal(error.rule, rule)
    return error
  }
  assert.fail(`Expected ${rule}`)
}

const sanitized = sanitizeBuildings([
  { id: 'hall!bad', type: 'town_hall', gridX: -10, gridY: 999, level: 999, builtAt: now + 50 },
  { id: '', type: 'cannon', gridX: 2, gridY: 3, level: 1 },
  { id: 'ignored', type: 'not_a_building', gridX: 0, gridY: 0 }
], context)
assert.equal(sanitized.length, 2)
assert.equal(sanitized[0].id, 'hallbad')
assert.equal(sanitized[0].gridX, 0)
assert.equal(sanitized[0].builtAt, now)
assert.match(sanitized[1].id, /^b_generated_/)
expectRule('DUPLICATE_BUILDING_ID', () => sanitizeBuildings([
  { id: 'same', type: 'town_hall' },
  { id: 'same', type: 'cannon' }
], context))

assert.deepEqual(
  { ...sanitizeArmy({ warrior: 3.8, archer: -4, romanwarrior: 99, bogus: 5 }) },
  { warrior: 3 }
)

const hall = building('hall', 'town_hall', 10, 10)
const rock = obstacle('rock', 'rock_small', 1, 1)
const grassOnHall = obstacle('grass', 'grass_patch', 10, 10)
assert.deepEqual(withoutCollidingObstacles([hall], [grassOnHall, rock]), [rock])

const grandfatheredHall = building('hall', 'town_hall', 10, 10)
const grandfatheredCannon = building('cannon', 'cannon', 11, 11)
const collisionSignatures = layoutCollisionSignatures([grandfatheredHall, grandfatheredCannon], [])
assert.ok(collisionSignatures.size > 0)
const grandfathered = validateVillageLayout({
  currentBuildings: [grandfatheredHall, grandfatheredCannon],
  currentObstacles: [],
  currentWallLevel: 1,
  proposedBuildings: [{ ...grandfatheredHall }, { ...grandfatheredCannon }],
  proposedObstacles: [],
  proposedWallLevel: 1,
  army: {}
})
assert.equal(grandfathered.changed, false)

expectRule('LAYOUT_COLLISION', () => validateVillageLayout({
  currentBuildings: [hall],
  currentObstacles: [],
  currentWallLevel: 1,
  proposedBuildings: [hall, building('new-cannon', 'cannon', 11, 11)],
  proposedObstacles: [],
  proposedWallLevel: 1,
  army: {}
}))

const camp = building('camp', 'army_camp', 3, 3)
const capacityConflict = expectRule('ARMY_OVER_CAPACITY', () => validateVillageLayout({
  currentBuildings: [hall, camp],
  currentObstacles: [],
  currentWallLevel: 1,
  proposedBuildings: [hall],
  proposedObstacles: [],
  proposedWallLevel: 1,
  army: { warrior: 31 }
}))
assert.equal(capacityConflict.clientCode, 'ARMY_OVER_CAPACITY')

expectRule('MIXED_WALL_LEVELS', () => validateVillageLayout({
  currentBuildings: [hall],
  currentObstacles: [],
  currentWallLevel: 1,
  proposedBuildings: [hall, building('wall-1', 'wall', 0, 0, 1), building('wall-2', 'wall', 1, 0, 2)],
  proposedObstacles: [],
  proposedWallLevel: 1,
  army: {}
}))

const oldCannon = { ...building('cannon', 'cannon', 1, 1), builtAt: now - 10_000 }
const oldRock = obstacle('old-rock', 'rock_small', 8, 8)
const proposed = [hall, building('cannon', 'cannon', 1, 1, 2), building('camp', 'army_camp', 5, 5)]
const proposedBefore = structuredClone(proposed)
const pricing = priceVillageMutation({
  currentBuildings: [hall, oldCannon],
  currentObstacles: [oldRock],
  proposedBuildings: proposed,
  proposedObstacles: [],
  now,
  upgradeTimeScale: 0.5
})
assert.deepEqual(proposed, proposedBefore, 'pricing must not mutate the proposal')
const cannonUpgrade = upgradeCharge('cannon', 1, 2)
const campPlacement = placementCharge('army_camp', 1)
assert.deepEqual(pricing.charges, {
  gold: cannonUpgrade.gold + campPlacement.gold,
  ore: cannonUpgrade.ore + campPlacement.ore
})
assert.equal(pricing.buildings.find(entry => entry.id === 'cannon')?.level, 1)
assert.equal(pricing.buildings.find(entry => entry.id === 'cannon')?.upgradingTo, 2)
assert.equal(pricing.buildings.find(entry => entry.id === 'cannon')?.upgradeStartedAt, now)
assert.equal(
  pricing.buildings.find(entry => entry.id === 'cannon')?.upgradeEndsAt,
  now + Math.round(upgradeDurationMs('cannon', 2) * 0.5)
)
assert.ok(pricing.obstacleRewards > 0)

const fixedPricing = priceVillageMutation({
  currentBuildings: [hall, oldCannon],
  currentObstacles: [],
  proposedBuildings: [hall, building('cannon', 'cannon', 1, 1, 2)],
  proposedObstacles: [],
  now,
  upgradeTimeScale: 0.001,
  fixedUpgradeDurationMs: 1_000
})
assert.equal(
  fixedPricing.buildings.find(entry => entry.id === 'cannon')?.upgradeEndsAt,
  now + 1_000,
  'a fixed duration overrides the building-specific scaled clock exactly'
)
assert.equal(fixedPricing.buildings.find(entry => entry.id === 'cannon')?.upgradeStartedAt, now)

const echoedUpgrade = priceVillageMutation({
  currentBuildings: [hall, {
    ...oldCannon,
    upgradingTo: 2,
    upgradeStartedAt: now - 1_000,
    upgradeEndsAt: now + 5_000
  }],
  currentObstacles: [],
  proposedBuildings: [hall, oldCannon],
  proposedObstacles: [],
  now,
  upgradeTimeScale: 1
}).buildings.find(entry => entry.id === 'cannon')
assert.equal(echoedUpgrade?.upgradingTo, 2)
assert.equal(echoedUpgrade?.upgradeStartedAt, now - 1_000)
assert.equal(echoedUpgrade?.upgradeEndsAt, now + 5_000)

const legacyEcho = priceVillageMutation({
  currentBuildings: [hall, { ...oldCannon, upgradingTo: 2, upgradeEndsAt: now + 5_000 }],
  currentObstacles: [],
  proposedBuildings: [hall, oldCannon],
  proposedObstacles: [],
  now,
  upgradeTimeScale: 1
}).buildings.find(entry => entry.id === 'cannon')
assert.equal(legacyEcho?.upgradeStartedAt, undefined, 'old pending saves remain valid without a start stamp')

const upgrading = { ...oldCannon, upgradingTo: 2, upgradeEndsAt: now + 5_000 }
expectRule('UPGRADE_IN_PROGRESS', () => priceVillageMutation({
  currentBuildings: [hall, upgrading],
  currentObstacles: [],
  proposedBuildings: [hall, building('cannon', 'cannon', 1, 1, 2)],
  proposedObstacles: [],
  now,
  upgradeTimeScale: 1
}))

console.log('village layout/economy: focused rules passed')
