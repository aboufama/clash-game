import assert from 'node:assert/strict'
import { botSeedAt, isWildernessPreserveAt } from '../../../src/game/config/Economy'
import {
  HYDROLOGY_OWNER_VISTA_WINDOW,
  queryWorldHydrology
} from '../../../src/game/config/WorldHydrology'
import {
  BOT_FRONTIER_RING_MARGIN,
  LEGACY_HOME_COORD_LIMIT,
  allocationOrdinalOf,
  allocationRingOfOrdinal,
  allocateNextPlayerPlot,
  botFrontierRadiusForCursor,
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
  isSpiralSettleable,
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
  settledFrontierBotVillageSeedAt,
  spiralHoleOrdinalsBelowCursor,
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
  // Spiral settlement: admission takes the FIRST non-preserve ordinal — bot
  // camps are settleable land (the claim replaces the camp); only preserves
  // (and the hydrology folded into them) are skipped.
  assert.equal(isSpiralSettleable(seededAllocation.allocation.coordinate, 1, 1), true)
  let firstSettleableSeeded = 0
  while (!isSpiralSettleable(coordinateAtAllocationOrdinal(firstSettleableSeeded), 1, 1)) {
    firstSettleableSeeded += 1
  }
  assert.equal(seededAllocation.allocation.ordinal, firstSettleableSeeded)

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

// Spiral settlement: closed-form ring math, the settled-frontier bot horizon,
// nearest-center-first admission, and the claim-replaces-bot rule.
{
  // Ring math agrees with the ordinal→coordinate closed form everywhere, and
  // the boundaries are exact: (2r-1)^2 is the first ordinal of ring r.
  assert.equal(allocationRingOfOrdinal(0), 0)
  for (let ordinal = 0; ordinal < 5_000; ordinal += 1) {
    const coordinate = coordinateAtAllocationOrdinal(ordinal)
    assert.equal(
      allocationRingOfOrdinal(ordinal),
      Math.max(Math.abs(coordinate.x), Math.abs(coordinate.y))
    )
  }
  for (let radius = 1; radius <= 12; radius += 1) {
    assert.equal(allocationRingOfOrdinal((radius * 2 - 1) ** 2), radius)
    assert.equal(allocationRingOfOrdinal((radius * 2 - 1) ** 2 - 1), radius - 1)
  }

  // The bot frontier keeps a two-ring margin beyond the outermost claim, so
  // even a single-settler world presents a living first horizon.
  assert.equal(BOT_FRONTIER_RING_MARGIN, 2)
  assert.equal(botFrontierRadiusForCursor(0), BOT_FRONTIER_RING_MARGIN)
  assert.equal(botFrontierRadiusForCursor(1), BOT_FRONTIER_RING_MARGIN)
  assert.equal(botFrontierRadiusForCursor(2), 1 + BOT_FRONTIER_RING_MARGIN)
  assert.equal(botFrontierRadiusForCursor(9), 1 + BOT_FRONTIER_RING_MARGIN)
  assert.equal(botFrontierRadiusForCursor(10), 2 + BOT_FRONTIER_RING_MARGIN)

  // Inside the frontier every unclaimed non-preserve plot presents a
  // deterministic camp; structural clans keep their exact seed; preserves
  // stay wild. The presentation is a pure function of the coordinate.
  const frontierRadius = botFrontierRadiusForCursor(10)
  for (let y = -frontierRadius; y <= frontierRadius; y += 1) {
    for (let x = -frontierRadius; x <= frontierRadius; x += 1) {
      const seed = settledFrontierBotVillageSeedAt({ x, y }, { frontierRadius })
      assert.equal(seed, settledFrontierBotVillageSeedAt({ x, y }, { frontierRadius }))
      const structural = botVillageSeedAt({ x, y }, 0)
      if (isWildernessPreserveAt(x, y)) {
        assert.equal(seed, null, `preserve (${x},${y}) must stay wilderness`)
      } else if (structural !== null) {
        assert.equal(seed, structural, `structural clan (${x},${y}) keeps its seed`)
      } else {
        assert.equal(typeof seed, 'number', `unclaimed settleable (${x},${y}) presents a fill camp`)
      }
    }
  }
  // Beyond the frontier the fill camps vanish; structural clans remain.
  let beyond: { x: number; y: number } | null = null
  for (let ordinal = 0; beyond === null; ordinal += 1) {
    const coordinate = coordinateAtAllocationOrdinal(ordinal)
    if (Math.max(Math.abs(coordinate.x), Math.abs(coordinate.y)) > frontierRadius
      && !isWildernessPreserveAt(coordinate.x, coordinate.y)
      && botVillageSeedAt(coordinate, 0) === null) beyond = coordinate
  }
  assert.equal(settledFrontierBotVillageSeedAt(beyond, { frontierRadius }), null,
    'a structural gap beyond the frontier stays open wilderness')

  // Nearest-center-first admission: the free-slot stream and the frontier
  // cursor merge in ordinal order.
  const firstSettleableFrom = (start: number) => {
    let ordinal = start
    while (!isSpiralSettleable(coordinateAtAllocationOrdinal(ordinal))) ordinal += 1
    return ordinal
  }
  const centralHole = firstSettleableFrom(1)
  const nearFirst = allocateNextPlayerPlot(createAllocationIndex({ worldId: 'main', nextOrdinal: 40 }), {
    isOccupied: () => false,
    releasedSlots: [{ ordinal: centralHole, plotVersion: 5 }]
  })
  assert.equal(nearFirst.allocation?.ordinal, centralHole,
    'a vacated central slot beats the far frontier cursor')
  assert.equal(nearFirst.allocation?.source, 'RELEASED')
  assert.equal(nearFirst.allocation?.plotVersion, 5, 'the released fence rides along')
  assert.equal(nearFirst.index.nextOrdinal, 40, 'central reuse never rewinds or advances the frontier')

  const nearFrontier = firstSettleableFrom(4)
  const farVsNear = allocateNextPlayerPlot(createAllocationIndex({ worldId: 'main', nextOrdinal: 4 }), {
    isOccupied: () => false,
    releasedSlots: [{ ordinal: 600, plotVersion: 9 }]
  })
  assert.equal(farVsNear.allocation?.ordinal, nearFrontier,
    'a far released override never jumps a nearer frontier ring')
  assert.equal(farVsNear.allocation?.source, 'FRONTIER')
  assert.deepEqual(farVsNear.consumedReleasedOrdinals, [],
    'the far slot stays indexed for when the spiral reaches it')

  const tie = allocateNextPlayerPlot(createAllocationIndex({ worldId: 'main', nextOrdinal: centralHole }), {
    isOccupied: () => false,
    releasedSlots: [{ ordinal: centralHole, plotVersion: 7 }]
  })
  assert.equal(tie.allocation?.ordinal, centralHole)
  assert.equal(tie.allocation?.source, 'RELEASED', 'a tie prefers the released row and its fence')
  assert.equal(tie.allocation?.plotVersion, 7)
  assert.ok(tie.index.nextOrdinal > centralHole, 'a slot on the cursor also advances the cursor')

  // The one-time model-upgrade helper enumerates exactly the settleable
  // ordinals below the cursor, and refuses giant imported frontiers.
  const holes = spiralHoleOrdinalsBelowCursor({ nextOrdinal: 30 })
  const expectedHoles: number[] = []
  for (let ordinal = 0; ordinal < 30; ordinal += 1) {
    if (isSpiralSettleable(coordinateAtAllocationOrdinal(ordinal))) expectedHoles.push(ordinal)
  }
  assert.deepEqual(holes, expectedHoles)
  assert.ok(expectedHoles.length < 30, 'the fixture window really contains preserve holes')
  assert.deepEqual(spiralHoleOrdinalsBelowCursor({ nextOrdinal: 26_000 }), [],
    'an oversized imported frontier skips the backfill scan')

  // Claim-replaces-bot: fresh-world admission walks the spiral strictly in
  // order and settles bot-classified ordinals too — the settled-frontier camp
  // at a coordinate exists only until its ordinal is handed out.
  let admissionIndex = createAllocationIndex({ worldId: 'main' })
  const settledCoordinates = new Set<string>()
  const settledOrdinals: number[] = []
  let sawBotClassified = false
  for (let step = 0; step < 12; step += 1) {
    const result = allocateNextPlayerPlot(admissionIndex, {
      isOccupied: candidate => settledCoordinates.has(`${candidate.coordinate.x},${candidate.coordinate.y}`)
    })
    assert.ok(result.allocation)
    settledCoordinates.add(`${result.allocation.coordinate.x},${result.allocation.coordinate.y}`)
    settledOrdinals.push(result.allocation.ordinal)
    if (classifyPlot(result.allocation.coordinate, 1).kind === 'BOT') sawBotClassified = true
    admissionIndex = result.index
  }
  const expectedOrder: number[] = []
  for (let ordinal = 0; expectedOrder.length < 12; ordinal += 1) {
    if (isSpiralSettleable(coordinateAtAllocationOrdinal(ordinal))) expectedOrder.push(ordinal)
  }
  assert.deepEqual(settledOrdinals, expectedOrder,
    'admission is the closed-form spiral order over settleable ordinals')
  assert.ok(sawBotClassified,
    'the dense center includes bot-classified ordinals that admission settles')
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
  // Spiral settlement makes bot-classified land claimable — the claim
  // replaces the generated camp; only preserves refuse a village.
  const botRegion = regionAddressForPlot({ worldId: 'main', generationVersion: 1, coordinate: { x: 1, y: 0 } })
  assert.equal(classifyPlot({ x: 1, y: 0 }, 1).kind, 'BOT')
  const campClaim = createPlotClaim({
    coordinate: { x: 1, y: 0 },
    region: botRegion,
    ownerId: 'guest-2',
    plotVersion: 1,
    assignedAt: 1_000,
    lease
  })
  assert.equal(campClaim.ownerId, 'guest-2')
  const preserveRegion = regionAddressForPlot({ worldId: 'main', generationVersion: 1, coordinate: { x: 2, y: 2 } })
  assert.equal(classifyPlot({ x: 2, y: 2 }, 1).kind, 'PRESERVE')
  assert.throws(() => createPlotClaim({
    coordinate: { x: 2, y: 2 },
    region: preserveRegion,
    ownerId: 'guest-3',
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

console.log('world domain: compatibility, spiral settlement, allocation, windows, and leases passed')
