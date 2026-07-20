import { randomBytes } from 'node:crypto'
import {
  CURRENT_WORLD_GENERATION_VERSION,
  DEFAULT_GUEST_PLOT_TTL_MS,
  DEFAULT_REGION_SIZE,
  INITIAL_PLOT_VERSION,
  LEGACY_WORLD_ID,
  MAX_ALLOCATION_PROBE_BUDGET,
  allocationOrdinalOf,
  allocateNextPlayerPlot,
  coordinateAtAllocationOrdinal,
  nextPlotVersion,
  regionAddressForPlot,
  spiralHoleOrdinalsBelowCursor,
  type PlotCoordinate,
  type WorldAllocationIndex
} from '../domain/world'
import type {
  ReleasedWorldPlotRecord,
  UnitOfWork,
  WorldAllocationRecord,
  WorldPlotRecord,
  WorldRegionRecord
} from '../persistence'
import { ApiError } from '../errors'

// Released rows were created from player-eligible claims, so the first row is
// normally usable. A small page avoids locking thousands of unrelated reusable
// plots while retaining the bounded repair loop for malformed legacy rows.
const ALLOCATION_PAGE_SIZE = 64

/** Settlement model 2: bot ordinals are settleable and central holes are indexed. */
const SPIRAL_ALLOCATION_MODEL = 2
const SPIRAL_OCCUPANCY_PROBE_CHUNK = 256

function allocationIndex(record: WorldAllocationRecord): WorldAllocationIndex {
  return {
    schemaVersion: 1,
    worldId: record.worldId,
    regionSize: record.regionSize,
    currentGenerationVersion: record.currentGenerationVersion,
    nextOrdinal: record.nextOrdinal
  }
}

/**
 * One-time spiral-model upgrade, run under the world's allocation row lock.
 * Pre-spiral admission skipped every bot-classified ordinal below the cursor —
 * the entire dense world center — so an upgraded world would otherwise keep
 * spawning new accounts on its old frontier. Index the settleable, unoccupied
 * holes as free slots once; ordinal-ordered reuse then fills the center first.
 * The scan is bounded exactly like the legacy cutover hole scan.
 */
async function upgradeAllocationToSpiralModel(
  tx: UnitOfWork,
  record: WorldAllocationRecord,
  now: Date
): Promise<WorldAllocationRecord> {
  if ((record.allocationModel ?? 1) >= SPIRAL_ALLOCATION_MODEL) return record
  const holes = spiralHoleOrdinalsBelowCursor({
    nextOrdinal: record.nextOrdinal,
    generationVersion: record.currentGenerationVersion
  })
  if (holes.length > 0) {
    // Every released row below the cursor sits at a settleable ordinal, and
    // rows are ordinal-ordered, so the first `holes.length` rows cover them.
    const indexed = new Set(
      (await tx.world.getReleasedSlots(record.worldId, holes.length)).map(slot => slot.ordinal)
    )
    const candidates = holes
      .filter(ordinal => !indexed.has(ordinal))
      .map(ordinal => ({ ordinal, coordinate: coordinateAtAllocationOrdinal(ordinal) }))
    for (let start = 0; start < candidates.length; start += SPIRAL_OCCUPANCY_PROBE_CHUNK) {
      const chunk = candidates.slice(start, start + SPIRAL_OCCUPANCY_PROBE_CHUNK)
      const occupied = new Set(
        (await tx.world.listOccupantsAt(record.worldId, chunk.map(item => item.coordinate)))
          .map(plot => `${plot.x},${plot.y}`)
      )
      for (const item of chunk) {
        if (occupied.has(`${item.coordinate.x},${item.coordinate.y}`)) continue
        await tx.world.putReleasedSlot({
          worldId: record.worldId,
          ordinal: item.ordinal,
          plotVersion: INITIAL_PLOT_VERSION,
          releasedAt: now
        })
      }
    }
  }
  const upgraded: WorldAllocationRecord = {
    ...record,
    allocationModel: SPIRAL_ALLOCATION_MODEL,
    revision: record.revision + 1,
    updatedAt: now
  }
  if (!await tx.world.updateAllocation(upgraded, record.revision)) {
    throw new ApiError(409, 'World allocation changed; retry the request', 'WORLD_ALLOCATION_CONFLICT')
  }
  return upgraded
}

async function lockedAllocation(tx: UnitOfWork, now: Date): Promise<WorldAllocationRecord> {
  const existing = await tx.world.getAllocation(LEGACY_WORLD_ID, { forUpdate: true })
  if (existing) return upgradeAllocationToSpiralModel(tx, existing, now)
  const created: WorldAllocationRecord = {
    worldId: LEGACY_WORLD_ID,
    schemaVersion: 1,
    regionSize: DEFAULT_REGION_SIZE,
    currentGenerationVersion: CURRENT_WORLD_GENERATION_VERSION,
    nextOrdinal: 0,
    allocationModel: SPIRAL_ALLOCATION_MODEL,
    botRevisionEpoch: 1,
    revision: 0,
    updatedAt: now
  }
  await tx.world.insertAllocation(created)
  return created
}

async function allocationSnapshot(tx: UnitOfWork, now: Date): Promise<WorldAllocationRecord> {
  return await tx.world.getAllocation(LEGACY_WORLD_ID) ?? lockedAllocation(tx, now)
}

async function ensureRegion(
  tx: UnitOfWork,
  index: WorldAllocationIndex,
  coordinate: PlotCoordinate,
  now: Date
): Promise<WorldRegionRecord> {
  const currentAddress = regionAddressForPlot({
    worldId: index.worldId,
    coordinate,
    size: index.regionSize,
    generationVersion: index.currentGenerationVersion
  })
  const persisted = await tx.world.getRegion(index.worldId, currentAddress.x, currentAddress.y)
  if (persisted) return persisted
  const record: WorldRegionRecord = {
    worldId: index.worldId,
    regionId: currentAddress.id,
    regionX: currentAddress.x,
    regionY: currentAddress.y,
    size: currentAddress.size,
    generationVersion: currentAddress.generationVersion,
    createdAt: now
  }
  await tx.world.ensureRegion(record)
  return record
}

function guestLease(playerId: string, now: Date) {
  return {
    leaseId: `guest:${playerId}:${randomBytes(12).toString('hex')}`,
    leaseIssuedAt: now,
    leaseRenewedAt: now,
    leaseExpiresAt: new Date(now.getTime() + DEFAULT_GUEST_PLOT_TTL_MS)
  }
}

function permanentLease() {
  return {
    leaseId: null,
    leaseIssuedAt: null,
    leaseRenewedAt: null,
    leaseExpiresAt: null
  }
}

export async function allocatePlayerPlot(
  tx: UnitOfWork,
  input: {
    playerId: string
    registered: boolean
    now: Date
    exclude?: readonly PlotCoordinate[]
  }
): Promise<WorldPlotRecord> {
  const allocation = await lockedAllocation(tx, input.now)
  let index = allocationIndex(allocation)
  let probes = 0
  const excludedOrdinals = (input.exclude ?? []).map(allocationOrdinalOf)

  while (probes < MAX_ALLOCATION_PROBE_BUDGET) {
    const remainingProbes = MAX_ALLOCATION_PROBE_BUDGET - probes
    const releasedPageLimit = Math.min(ALLOCATION_PAGE_SIZE, remainingProbes)
    const released = await tx.world.getReleasedSlots(
      index.worldId,
      releasedPageLimit,
      { forUpdate: true, excludeOrdinals: excludedOrdinals }
    )
    // A full page may omit lower-priority free rows. Spend this transition's
    // whole budget on that page so frontier probing starts only after a short
    // query proves the reusable index is exhausted.
    const transitionProbeBudget = released.length === releasedPageLimit
      ? releasedPageLimit
      : remainingProbes
    const result = allocateNextPlayerPlot(index, {
      releasedSlots: released,
      isOccupied: () => false,
      maxProbes: transitionProbeBudget
    })
    probes += result.probes
    index = result.index
    const rejectedReleasedOrdinals = result.consumedReleasedOrdinals
      .filter(ordinal => ordinal !== result.allocation?.ordinal)
    if (rejectedReleasedOrdinals.length > 0) {
      await tx.world.deleteReleasedSlots(index.worldId, rejectedReleasedOrdinals)
    }
    if (!result.allocation) {
      if (result.exhausted) throw new ApiError(503, 'The world has no allocatable village plots')
      continue
    }
    const { coordinate, plotVersion } = result.allocation
    if (input.exclude?.some(item => item.x === coordinate.x && item.y === coordinate.y)) continue
    if (await tx.world.getOccupant(index.worldId, coordinate.x, coordinate.y, { forUpdate: true })) {
      // An occupied released row is stale legacy/corrupt state. Repair it so a
      // retry cannot spin on the same lowest ordinal forever.
      await tx.world.deleteReleasedSlots(index.worldId, [result.allocation.ordinal])
      continue
    }

    const region = await ensureRegion(tx, index, coordinate, input.now)
    const plot: WorldPlotRecord = {
      worldId: index.worldId,
      x: coordinate.x,
      y: coordinate.y,
      regionId: region.regionId,
      playerId: input.playerId,
      plotVersion,
      assignedAt: input.now,
      ...(input.registered ? permanentLease() : guestLease(input.playerId, input.now))
    }
    await tx.world.assign(plot)
    const updated = await tx.world.updateAllocation({
      ...allocation,
      nextOrdinal: index.nextOrdinal,
      revision: allocation.revision + 1,
      updatedAt: input.now
    }, allocation.revision)
    if (!updated) throw new ApiError(409, 'World allocation changed; retry the request', 'WORLD_ALLOCATION_CONFLICT')
    return plot
  }
  throw new ApiError(503, 'No village plot was found within the bounded allocation probe')
}

export async function releasePlayerPlotClaim(
  tx: UnitOfWork,
  plot: WorldPlotRecord,
  now: Date
): Promise<void> {
  await releaseLockedPlotClaim(tx, plot, now)
}

async function releaseLockedPlotClaim(
  tx: UnitOfWork,
  plot: WorldPlotRecord,
  now: Date
): Promise<boolean> {
  if (!await tx.world.release(plot.playerId)) return false
  const record: ReleasedWorldPlotRecord = {
    worldId: plot.worldId,
    ordinal: allocationOrdinalOf({ x: plot.x, y: plot.y }),
    plotVersion: nextPlotVersion(plot.plotVersion),
    releasedAt: now
  }
  await tx.world.putReleasedSlot(record)
  return true
}

/**
 * Bounded lease reaper. Claims are locked with SKIP LOCKED and released without
 * touching the high-water cursor, so cleanup workers cannot deadlock with a
 * player flow that already owns the account/village/plot lock chain.
 */
export async function releaseExpiredGuestPlotClaims(
  tx: UnitOfWork,
  now: Date,
  requestedLimit = 50
): Promise<WorldPlotRecord[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(requestedLimit)))
  const expiredAccountIds = (await tx.world.claimExpiredGuestAccountIds(LEGACY_WORLD_ID, now, limit))
    .sort((a, b) => a.localeCompare(b))
  const releasedPlots: WorldPlotRecord[] = []
  for (const playerId of expiredAccountIds) {
    // The repository already owns this account lock on PostgreSQL; the
    // explicit read documents and preserves the same order in every adapter.
    const account = await tx.accounts.getById(playerId, { forUpdate: true })
    if (!account || account.registered) continue
    const plot = await tx.world.getPlayerPlot(playerId, { forUpdate: true })
    if (!plot || plot.worldId !== LEGACY_WORLD_ID || plot.leaseExpiresAt === null
      || plot.leaseExpiresAt > now) continue
    if (await releaseLockedPlotClaim(tx, plot, now)) releasedPlots.push(plot)
  }
  return releasedPlots
}

export async function claimSpecificPlayerPlot(
  tx: UnitOfWork,
  input: {
    playerId: string
    registered: boolean
    coordinate: PlotCoordinate
    now: Date
  }
): Promise<WorldPlotRecord> {
  const allocation = await allocationSnapshot(tx, input.now)
  const ordinal = allocationOrdinalOf(input.coordinate)
  // Match automatic allocation: free-slot row first, coordinate claim second.
  // The assign repository consumes this exact ordinal after its unique insert.
  const released = await tx.world.getReleasedSlot(allocation.worldId, ordinal, { forUpdate: true })
  if (await tx.world.getOccupant(allocation.worldId, input.coordinate.x, input.coordinate.y, { forUpdate: true })) {
    throw new ApiError(409, 'That plot is taken')
  }
  const region = await ensureRegion(tx, allocationIndex(allocation), input.coordinate, input.now)
  const plot: WorldPlotRecord = {
    worldId: allocation.worldId,
    x: input.coordinate.x,
    y: input.coordinate.y,
    regionId: region.regionId,
    playerId: input.playerId,
    plotVersion: released?.plotVersion ?? 1,
    assignedAt: input.now,
    ...(input.registered ? permanentLease() : guestLease(input.playerId, input.now))
  }
  await tx.world.assign(plot)
  return plot
}
