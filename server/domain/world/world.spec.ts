import assert from 'node:assert/strict'
import { botSeedAt, isWildernessPreserveAt } from '../../../src/game/config/Economy'
import {
  HYDROLOGY_OWNER_VISTA_WINDOW,
  queryWorldHydrology
} from '../../../src/game/config/WorldHydrology'
import {
  LEGACY_HOME_COORD_LIMIT,
  allocationOrdinalOf,
  allocateNextPlayerPlot,
  botVillagePresentationSeed,
  botVillageSeedAt,
  boundedLocalWindow,
  classifyPlot,
  coordinateAtAllocationOrdinal,
  coordinatesInWindow,
  createAllocationIndex,
  createGuestPlotLease,
  createPlotClaim,
  expiredGuestPlotClaims,
  isGuestPlotLeaseExpired,
  localCoordinatesForPlot,
  matchesPlotReference,
  nextWorldPresentationSeedVersion,
  parseRegionId,
  permanentPlotLease,
  plotFromLocal,
  plotReference,
  promoteGuestPlotClaim,
  regionAddressForPlot,
  regionCoordinatesForPlot,
  regionCoordinatesInWindow,
  releasePlayerPlot,
  releasePlayerPlotForTopology,
  renewGuestPlotClaim,
  renewGuestPlotLease,
  windowArea
} from './index'

// Absolute coordinates survive region partitioning, including negative floor division.
{
  assert.deepEqual(regionCoordinatesForPlot({ x: 0, y: 0 }), { x: 0, y: 0 })
  assert.deepEqual(regionCoordinatesForPlot({ x: 31, y: 31 }), { x: 0, y: 0 })
  assert.deepEqual(regionCoordinatesForPlot({ x: 32, y: -1 }), { x: 1, y: -1 })
  assert.deepEqual(localCoordinatesForPlot({ x: 32, y: -1 }), { x: 0, y: 31 })
  assert.deepEqual(localCoordinatesForPlot({ x: -32, y: -33 }), { x: 0, y: 31 })

  const region = regionAddressForPlot({
    worldId: 'realm|one/%',
    generationVersion: 1,
    coordinate: { x: -33, y: 64 }
  })
  assert.deepEqual(parseRegionId(region.id), region)
  assert.deepEqual(plotFromLocal(region, { x: 31, y: 0 }), { x: -33, y: 64 })
}

// Epoch zero is exact compatibility. Development reseeds rotate generated
// topology itself: bot coordinates, preserves, lakes, rivers and appearance.
{
  const coordinate = { x: 1, y: 0 }
  const classification = classifyPlot(coordinate, 1)
  assert.equal(classification.kind, 'BOT')
  if (classification.kind !== 'BOT') throw new Error('fixture must be a bot plot')

  const initialSeed = botVillageSeedAt(coordinate, 0)
  const firstSeed = botVillageSeedAt(coordinate, 1)
  const secondSeed = botVillageSeedAt(coordinate, nextWorldPresentationSeedVersion(1))
  assert.equal(initialSeed, classification.seed)
  assert.notEqual(firstSeed, initialSeed)
  assert.notEqual(secondSeed, firstSeed)
  assert.equal(botVillagePresentationSeed(classification.seed, Number.NaN), classification.seed)
  assert.deepEqual(classifyPlot(coordinate, 1), classification)

  const originalPreserve = classifyPlot({ x: 2, y: 2 }, 1, 0)
  const reseededPreserve = classifyPlot({ x: 2, y: 2 }, 1, 1)
  assert.equal(originalPreserve.kind, 'PRESERVE')
  assert.notEqual(reseededPreserve.kind, originalPreserve.kind)

  let changedBotOccupancy = 0
  for (let y = -6; y <= 6; y += 1) {
    for (let x = -6; x <= 6; x += 1) {
      const before = classifyPlot({ x, y }, 1, 0).kind === 'BOT'
      const after = classifyPlot({ x, y }, 1, 1).kind === 'BOT'
      if (before !== after) changedBotOccupancy += 1
    }
  }
  assert.ok(changedBotOccupancy > 20, 'reseed did not move enough generated bot occupancy')

  const hydrologySignature = (seedVersion: number) => queryWorldHydrology(
    HYDROLOGY_OWNER_VISTA_WINDOW,
    seedVersion
  ).map(feature => `${feature.id}:${feature.protectedPlots.map(plot => `${plot.x},${plot.y}`).join(';')}`)
  const originalHydrology = hydrologySignature(0)
  const reseededHydrology = hydrologySignature(1)
  assert.ok(originalHydrology.length > 0, 'epoch-zero owner vista fixture disappeared')
  assert.notDeepEqual(reseededHydrology, originalHydrology)
}

// Generation v1 is a compatibility layer over every currently legal home coordinate.
{
  let playerPlots = 0
  let botPlots = 0
  let preserves = 0
  for (let y = -LEGACY_HOME_COORD_LIMIT; y <= LEGACY_HOME_COORD_LIMIT; y += 1) {
    for (let x = -LEGACY_HOME_COORD_LIMIT; x <= LEGACY_HOME_COORD_LIMIT; x += 1) {
      const classification = classifyPlot({ x, y }, 1)
      if (isWildernessPreserveAt(x, y)) {
        assert.equal(classification.kind, 'PRESERVE')
        preserves += 1
      } else {
        const seed = botSeedAt(x, y)
        if (seed === null) {
          assert.equal(classification.kind, 'PLAYER')
          playerPlots += 1
        } else {
          assert.deepEqual(classification, { kind: 'BOT', settleable: false, seed })
          botPlots += 1
        }
      }
    }
  }
  assert.deepEqual({ playerPlots, botPlots, preserves }, {
    playerPlots: 6_088,
    botPlots: 7_568,
    preserves: 1_969
  })
  assert.throws(() => classifyPlot({ x: 0, y: 0 }, 2), /unsupported world generation/)
}

// Local reads stay bounded and row-major, while region queries cross negative boundaries correctly.
{
  const window = boundedLocalWindow({ center: { x: 0, y: 0 }, requestedRadius: 99 })
  assert.deepEqual(window, { minX: -2, minY: -2, maxX: 2, maxY: 2 })
  assert.equal(windowArea(window), 25)
  const coordinates = [...coordinatesInWindow(window)]
  assert.deepEqual(coordinates[0], { x: -2, y: -2 })
  assert.deepEqual(coordinates.at(-1), { x: 2, y: 2 })

  const clipped = boundedLocalWindow({
    center: { x: 64, y: 64 },
    requestedRadius: 2,
    envelope: { minX: -64, minY: -64, maxX: 64, maxY: 64 }
  })
  assert.deepEqual(clipped, { minX: 62, minY: 62, maxX: 64, maxY: 64 })
  assert.deepEqual(regionCoordinatesInWindow({ minX: -1, minY: -1, maxX: 1, maxY: 1 }), [
    { x: -1, y: -1 }, { x: 0, y: -1 },
    { x: -1, y: 0 }, { x: 0, y: 0 }
  ])
}

// Ordinals exactly encode the old ring scan but permit O(1) resume from a high-water mark.
{
  assert.deepEqual(Array.from({ length: 9 }, (_, ordinal) => coordinateAtAllocationOrdinal(ordinal)), [
    { x: 0, y: 0 },
    { x: -1, y: -1 }, { x: -1, y: 0 }, { x: -1, y: 1 },
    { x: 0, y: -1 }, { x: 0, y: 1 },
    { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 }
  ])
  const legacyOrder: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }]
  for (let radius = 1; legacyOrder.length < 20_000; radius += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      const ys = x === -radius || x === radius
        ? Array.from({ length: radius * 2 + 1 }, (_, index) => -radius + index)
        : [-radius, radius]
      for (const y of ys) legacyOrder.push({ x, y })
    }
  }
  for (let ordinal = 0; ordinal < 20_000; ordinal += 1) {
    const coordinate = coordinateAtAllocationOrdinal(ordinal)
    assert.deepEqual(coordinate, legacyOrder[ordinal])
    assert.equal(allocationOrdinalOf(coordinate), ordinal)
  }
}

// Allocation advances monotonically, reuses explicit free slots, and advances plotVersion.
{
  const occupied = new Set<string>()
  const key = (x: number, y: number) => `${x},${y}`
  let index = createAllocationIndex({ worldId: 'main' })
  const first = allocateNextPlayerPlot(index, {
    isOccupied: candidate => occupied.has(key(candidate.coordinate.x, candidate.coordinate.y))
  })
  assert.deepEqual(first.allocation?.coordinate, { x: 0, y: 0 })
  assert.equal(first.allocation?.plotVersion, 1)
  assert.equal(first.allocation?.source, 'FRONTIER')
  index = first.index
  occupied.add('0,0')

  const cursorBefore = index.nextOrdinal
  const observedOrdinals: number[] = []
  const second = allocateNextPlayerPlot(index, {
    isOccupied: candidate => {
      observedOrdinals.push(candidate.ordinal)
      return occupied.has(key(candidate.coordinate.x, candidate.coordinate.y))
    }
  })
  assert.ok(second.allocation)
  assert.ok(second.allocation.ordinal >= cursorBefore)
  assert.ok(observedOrdinals.every(ordinal => ordinal >= cursorBefore))
  index = second.index

  occupied.delete('0,0')
  const frontierBeforeRelease = index.nextOrdinal
  const released = releasePlayerPlot(index, { coordinate: { x: 0, y: 0 }, plotVersion: 1 })
  index = released.index
  const reused = allocateNextPlayerPlot(index, {
    isOccupied: () => false,
    releasedSlots: [released.releasedSlot]
  })
  assert.deepEqual(reused.allocation?.coordinate, { x: 0, y: 0 })
  assert.equal(reused.allocation?.source, 'RELEASED')
  assert.equal(reused.allocation?.plotVersion, 2)
  assert.equal(reused.index.nextOrdinal, frontierBeforeRelease)
  assert.deepEqual(reused.consumedReleasedOrdinals, [0])

  // The original home is a valid pinned player override after epoch one puts
  // a preserve beneath it. Vacating it reveals generated terrain, not a free
  // player slot, and seeded frontier allocation must skip it too.
  assert.equal(classifyPlot({ x: 0, y: 0 }, 1, 1).kind, 'PRESERVE')
  const hiddenByReseed = releasePlayerPlotForTopology(
    index,
    { coordinate: { x: 0, y: 0 }, plotVersion: 7 },
    1
  )
  assert.equal(hiddenByReseed.releasedSlot, null)
  const seededAllocation = allocateNextPlayerPlot(createAllocationIndex({ worldId: 'main' }), {
    worldSeedVersion: 1,
    isOccupied: () => false
  })
  assert.ok(seededAllocation.allocation)
  assert.notDeepEqual(seededAllocation.allocation.coordinate, { x: 0, y: 0 })
  assert.equal(classifyPlot(seededAllocation.allocation.coordinate, 1, 1).kind, 'PLAYER')

  const denseWorldFrontier = 50_000
  const postReseedAdmission = allocateNextPlayerPlot(createAllocationIndex({
    worldId: 'main',
    nextOrdinal: denseWorldFrontier
  }), {
    worldSeedVersion: 1,
    isOccupied: () => false
  })
  assert.ok(postReseedAdmission.allocation)
  assert.ok((postReseedAdmission.allocation?.ordinal ?? -1) >= denseWorldFrontier)

  const budgeted = allocateNextPlayerPlot(createAllocationIndex({ worldId: 'main', nextOrdinal: 1 }), {
    isOccupied: () => false,
    maxProbes: 1
  })
  assert.equal(budgeted.allocation, null)
  assert.equal(budgeted.probes, 1)
  assert.equal(budgeted.index.nextOrdinal, 2)
  assert.equal(budgeted.exhausted, false)
}

// Guest leases expire exactly at their deadline, renew only while active, and promote in place.
{
  const lease = createGuestPlotLease({ leaseId: 'lease-1', now: 1_000, ttlMs: 100 })
  assert.equal(isGuestPlotLeaseExpired(lease, 1_099), false)
  assert.equal(isGuestPlotLeaseExpired(lease, 1_100), true)
  const renewedLease = renewGuestPlotLease(lease, { now: 1_050, ttlMs: 100 })
  assert.equal(renewedLease.expiresAt, 1_150)
  assert.throws(() => renewGuestPlotLease(lease, { now: 1_100 }), /cannot be renewed/)

  const region = regionAddressForPlot({ worldId: 'main', generationVersion: 1, coordinate: { x: 0, y: 0 } })
  const claim = createPlotClaim({
    coordinate: { x: 0, y: 0 },
    region,
    ownerId: 'guest-1',
    plotVersion: 1,
    assignedAt: 1_000,
    lease
  })
  const botRegion = regionAddressForPlot({ worldId: 'main', generationVersion: 1, coordinate: { x: 1, y: 0 } })
  assert.throws(() => createPlotClaim({
    coordinate: { x: 1, y: 0 },
    region: botRegion,
    ownerId: 'guest-2',
    plotVersion: 1,
    assignedAt: 1_000,
    lease
  }), /not eligible/)
  assert.deepEqual(expiredGuestPlotClaims([claim], 1_100), [claim])
  const renewedClaim = renewGuestPlotClaim(claim, { now: 1_050, ttlMs: 100 })
  assert.equal(renewedClaim.lease.kind === 'GUEST' && renewedClaim.lease.expiresAt, 1_150)
  const reference = plotReference(claim)
  assert.equal(matchesPlotReference(claim, reference), true)
  assert.equal(matchesPlotReference({ ...claim, plotVersion: 2 }, reference), false)

  const promoted = promoteGuestPlotClaim(claim, 1_050)
  assert.deepEqual(promoted.lease, permanentPlotLease())
  assert.equal(promoted.plotVersion, claim.plotVersion)
  assert.throws(() => promoteGuestPlotClaim(claim, 1_100), /cannot be promoted/)
}

console.log('world domain: compatibility, allocation, windows, and leases passed')
