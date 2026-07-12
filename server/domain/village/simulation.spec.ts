import assert from 'node:assert/strict'
import type { SerializedBuilding } from '../../../src/game/data/Models'
import { advanceVillage, appearanceRevisionDelta, type SimulatableVillage } from './simulation'

function village(buildings: SerializedBuilding[], overrides: Partial<SimulatableVillage> = {}): SimulatableVillage {
  return {
    buildings,
    balance: 0,
    ore: 0,
    food: 100,
    lastAccrualAt: 0,
    population: { count: 3, lastGrowthAt: 0, bornAt: [] },
    productionRemainders: { ore: 0, food: 0 },
    ...overrides
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function comparable(value: SimulatableVillage) {
  return {
    ...value,
    balance: Number(value.balance.toFixed(8)),
    productionRemainders: {
      ore: Number((value.productionRemainders?.ore ?? 0).toFixed(8)),
      food: Number((value.productionRemainders?.food ?? 0).toFixed(8))
    }
  }
}

function advanceFrequently(
  state: SimulatableVillage,
  target: number,
  interval: number,
  options: Parameters<typeof advanceVillage>[2] = {}
): SimulatableVillage {
  for (let at = interval; at < target; at += interval) advanceVillage(state, at, options)
  advanceVillage(state, target, options)
  return state
}

const tenMinutes = 10 * 60_000

// Population growth changes staffing. Poll cadence must not change output.
{
  const initial = village([
    { id: 'hall', type: 'town_hall', gridX: 0, gridY: 0, level: 1 },
    { id: 'mine', type: 'mine', gridX: 3, gridY: 0, level: 1 },
    { id: 'farm', type: 'farm', gridX: 6, gridY: 0, level: 1 }
  ], { population: { count: 1, lastGrowthAt: 0, bornAt: [] } })
  const once = clone(initial)
  const often = clone(initial)
  advanceVillage(once, tenMinutes)
  advanceFrequently(often, tenMinutes, 7_000)
  assert.deepEqual(comparable(often), comparable(once))
}

// An upgrading producer remains offline until its exact completion boundary;
// the upgraded rate is never applied retroactively to the whole interval.
{
  const initial = village([
    { id: 'hall', type: 'town_hall', gridX: 0, gridY: 0, level: 1 },
    {
      id: 'farm', type: 'farm', gridX: 4, gridY: 0, level: 1,
      upgradingTo: 2, upgradeEndsAt: tenMinutes / 2
    }
  ], { food: 0, population: { count: 3, lastGrowthAt: 0, bornAt: [] } })
  const once = clone(initial)
  const often = clone(initial)
  const result = advanceVillage(once, tenMinutes, { populationLocked: true })
  advanceFrequently(often, tenMinutes, 11_000, { populationLocked: true })
  assert.deepEqual(comparable(often), comparable(once))
  assert.deepEqual(result.completedUpgradeIds, ['farm'])
}

// Capacity pauses the population clock. Expanding housing starts a fresh,
// deterministic interval rather than releasing banked inhabitants.
{
  const initial = village([
    {
      id: 'hall', type: 'town_hall', gridX: 0, gridY: 0, level: 1,
      upgradingTo: 2, upgradeEndsAt: tenMinutes / 2
    }
  ], { population: { count: 5, lastGrowthAt: 0, bornAt: [] } })
  const once = clone(initial)
  const often = clone(initial)
  advanceVillage(once, tenMinutes)
  advanceFrequently(often, tenMinutes, 13_000)
  assert.deepEqual(comparable(often), comparable(once))
}

// Public resident manifests can represent every possible inhabitant's age;
// normalization keeps the newest domain maximum rather than a visual subset.
{
  const births = Array.from({ length: 40 }, (_, index) => index + 1)
  const state = village([
    { id: 'hall', type: 'town_hall', gridX: 0, gridY: 0, level: 1 }
  ], { population: { count: 3, lastGrowthAt: 0, bornAt: births } })
  advanceVillage(state, 0)
  assert.equal(state.population.bornAt?.length, 30)
  assert.deepEqual(state.population.bornAt, births.slice(-30))
}

// Read-only public postcard projections start from a persisted checkpoint.
// Their cache revision must distinguish one catch-up interval from a later
// interval containing additional deterministic appearance events.
{
  const initial = village([
    { id: 'hall', type: 'town_hall', gridX: 0, gridY: 0, level: 2 },
    {
      id: 'farm', type: 'farm', gridX: 4, gridY: 0, level: 1,
      upgradingTo: 2, upgradeEndsAt: 4 * 60_000
    }
  ], { population: { count: 1, lastGrowthAt: 0, bornAt: [] } })
  const early = advanceVillage(clone(initial), 4 * 60_000)
  const later = advanceVillage(clone(initial), 10 * 60_000)
  assert.equal(appearanceRevisionDelta(early), 2, 'one birth and one upgrade are distinct cache events')
  assert(appearanceRevisionDelta(later) > appearanceRevisionDelta(early))
}

console.log('village simulation: cadence invariance passed')
