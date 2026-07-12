import {
  CURRENT_WORLD_GENERATION_VERSION,
  classifyPlot
} from './generation'
import {
  DEFAULT_REGION_SIZE,
  MAX_WORLD_COORDINATE,
  assertGenerationVersion,
  assertPlotCoordinate,
  assertRegionSize,
  assertWorldId,
  regionAddressForPlot,
  regionCoordinatesForPlot,
  type GenerationVersion,
  type PlotCoordinate,
  type RegionAddress,
  type RegionCoordinate
} from './coordinates'
import { INITIAL_PLOT_VERSION, nextPlotVersion } from './plots'

export const ALLOCATION_INDEX_SCHEMA_VERSION = 1
export const DEFAULT_ALLOCATION_PROBE_BUDGET = 4_096
export const MAX_ALLOCATION_PROBE_BUDGET = 100_000

const MAX_ALLOCATION_ORDINAL = (MAX_WORLD_COORDINATE * 2 + 1) ** 2 - 1

/**
 * Persist this once per world. `nextOrdinal` is a high-water cursor, while
 * released slots live in their own indexed persistence table. Neither path
 * rescans previously rejected coordinates from the origin.
 */
export interface WorldAllocationIndex {
  schemaVersion: typeof ALLOCATION_INDEX_SCHEMA_VERSION
  worldId: string
  regionSize: number
  currentGenerationVersion: GenerationVersion
  nextOrdinal: number
}

export interface ReleasedPlotSlot {
  ordinal: number
  /** Version assigned to the next occupant, already advanced past the released claim. */
  plotVersion: number
}

export type AllocationSource = 'RELEASED' | 'FRONTIER'

export interface PlotAllocationCandidate {
  worldId: string
  coordinate: PlotCoordinate
  region: RegionAddress
  ordinal: number
  plotVersion: number
  source: AllocationSource
}

export interface PlotAllocationResult {
  allocation: PlotAllocationCandidate | null
  index: WorldAllocationIndex
  probes: number
  /** Delete these supplied free-slot rows in the same transaction. */
  consumedReleasedOrdinals: readonly number[]
  /** True only at the generous coordinate safety envelope, not after a normal probe budget. */
  exhausted: boolean
}

export type RegionGenerationResolver = (input: {
  worldId: string
  coordinate: RegionCoordinate
  size: number
}) => GenerationVersion | undefined

export interface AllocatePlotOptions {
  isOccupied(candidate: PlotAllocationCandidate): boolean
  /** Generated-world topology epoch. Omitted by production repositories for epoch-zero compatibility. */
  worldSeedVersion?: unknown
  /** Oldest free slots from the world's indexed free-slot table. */
  releasedSlots?: readonly ReleasedPlotSlot[]
  /** Must return the pinned version for an existing region; undefined creates it at the current version. */
  generationVersionForRegion?: RegionGenerationResolver
  maxProbes?: number
}

export function createAllocationIndex(input: {
  worldId: string
  regionSize?: number
  currentGenerationVersion?: GenerationVersion
  nextOrdinal?: number
}): WorldAllocationIndex {
  const index: WorldAllocationIndex = {
    schemaVersion: ALLOCATION_INDEX_SCHEMA_VERSION,
    worldId: input.worldId,
    regionSize: input.regionSize ?? DEFAULT_REGION_SIZE,
    currentGenerationVersion: input.currentGenerationVersion ?? CURRENT_WORLD_GENERATION_VERSION,
    nextOrdinal: input.nextOrdinal ?? 0
  }
  return normalizeAllocationIndex(index)
}

export function normalizeAllocationIndex(index: WorldAllocationIndex): WorldAllocationIndex {
  if (index.schemaVersion !== ALLOCATION_INDEX_SCHEMA_VERSION) {
    throw new RangeError(`unsupported allocation index schema: ${index.schemaVersion}`)
  }
  assertWorldId(index.worldId)
  assertRegionSize(index.regionSize)
  assertGenerationVersion(index.currentGenerationVersion)
  if (!Number.isSafeInteger(index.nextOrdinal) || index.nextOrdinal < 0 || index.nextOrdinal > MAX_ALLOCATION_ORDINAL + 1) {
    throw new RangeError('allocation nextOrdinal is out of range')
  }
  return { ...index }
}

function normalizeReleasedSlots(slots: readonly ReleasedPlotSlot[]): ReleasedPlotSlot[] {
  const releasedByOrdinal = new Map<number, ReleasedPlotSlot>()
  for (const slot of slots) {
    if (!Number.isSafeInteger(slot.ordinal) || slot.ordinal < 0 || slot.ordinal > MAX_ALLOCATION_ORDINAL) {
      throw new RangeError('released allocation ordinal is out of range')
    }
    if (!Number.isSafeInteger(slot.plotVersion) || slot.plotVersion < INITIAL_PLOT_VERSION) {
      throw new RangeError('released slot plotVersion must be a positive safe integer')
    }
    if (releasedByOrdinal.has(slot.ordinal)) throw new RangeError('released allocation ordinals must be unique')
    releasedByOrdinal.set(slot.ordinal, { ...slot })
  }
  return [...releasedByOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal)
}

/** Direct lookup in the legacy ring order used by GameService.nextFreePlot. */
export function coordinateAtAllocationOrdinal(ordinal: number): PlotCoordinate {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > MAX_ALLOCATION_ORDINAL) {
    throw new RangeError('allocation ordinal is out of range')
  }
  if (ordinal === 0) return { x: 0, y: 0 }

  let radius = Math.ceil((Math.sqrt(ordinal + 1) - 1) / 2)
  while ((radius * 2 - 1) ** 2 > ordinal) radius -= 1
  while ((radius * 2 + 1) ** 2 <= ordinal) radius += 1
  const ringStart = (radius * 2 - 1) ** 2
  let offset = ordinal - ringStart
  const verticalEdgeLength = radius * 2 + 1

  if (offset < verticalEdgeLength) return { x: -radius, y: -radius + offset }
  offset -= verticalEdgeLength

  const horizontalInteriorLength = radius * 4 - 2
  if (offset < horizontalInteriorLength) {
    return {
      x: -radius + 1 + Math.floor(offset / 2),
      y: offset % 2 === 0 ? -radius : radius
    }
  }
  offset -= horizontalInteriorLength
  return { x: radius, y: -radius + offset }
}

/** Inverse of coordinateAtAllocationOrdinal, used to index a released plot. */
export function allocationOrdinalOf(coordinate: PlotCoordinate): number {
  assertPlotCoordinate(coordinate)
  const radius = Math.max(Math.abs(coordinate.x), Math.abs(coordinate.y))
  if (radius === 0) return 0
  const ringStart = (radius * 2 - 1) ** 2
  const verticalEdgeLength = radius * 2 + 1
  const horizontalInteriorLength = radius * 4 - 2
  let offset: number
  if (coordinate.x === -radius) {
    offset = coordinate.y + radius
  } else if (coordinate.x === radius) {
    offset = verticalEdgeLength + horizontalInteriorLength + coordinate.y + radius
  } else {
    // A non-vertical-edge point on this Chebyshev ring is on the top or bottom edge.
    offset = verticalEdgeLength
      + (coordinate.x - (-radius + 1)) * 2
      + (coordinate.y === -radius ? 0 : 1)
  }
  const ordinal = ringStart + offset
  if (!Number.isSafeInteger(ordinal) || ordinal > MAX_ALLOCATION_ORDINAL) {
    throw new RangeError('coordinate cannot be represented by the allocation index')
  }
  return ordinal
}

function resolvedRegion(
  index: WorldAllocationIndex,
  coordinate: PlotCoordinate,
  resolver?: RegionGenerationResolver
): RegionAddress {
  const regionCoordinate = regionCoordinatesForPlot(coordinate, index.regionSize)
  const generationVersion = resolver?.({
    worldId: index.worldId,
    coordinate: regionCoordinate,
    size: index.regionSize
  }) ?? index.currentGenerationVersion
  assertGenerationVersion(generationVersion)
  return regionAddressForPlot({
    worldId: index.worldId,
    coordinate,
    size: index.regionSize,
    generationVersion
  })
}

function probeBudget(raw: number | undefined): number {
  const value = raw ?? DEFAULT_ALLOCATION_PROBE_BUDGET
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ALLOCATION_PROBE_BUDGET) {
    throw new RangeError(`maxProbes must be an integer from 1 to ${MAX_ALLOCATION_PROBE_BUDGET}`)
  }
  return value
}

/**
 * Pure allocator transition. Persist the returned index and successful plot
 * claim in one serializable transaction guarded by the world's allocation row.
 */
export function allocateNextPlayerPlot(
  rawIndex: WorldAllocationIndex,
  options: AllocatePlotOptions
): PlotAllocationResult {
  const current = normalizeAllocationIndex(rawIndex)
  const budget = probeBudget(options.maxProbes)
  const released = normalizeReleasedSlots(options.releasedSlots ?? [])
  const consumedReleasedOrdinals: number[] = []
  let nextOrdinal = current.nextOrdinal
  let probes = 0

  const tryOrdinal = (
    ordinal: number,
    plotVersion: number,
    source: AllocationSource
  ): PlotAllocationCandidate | null => {
    probes += 1
    const coordinate = coordinateAtAllocationOrdinal(ordinal)
    const region = resolvedRegion(current, coordinate, options.generationVersionForRegion)
    if (classifyPlot(coordinate, region.generationVersion, options.worldSeedVersion).kind !== 'PLAYER') return null
    const candidate = { worldId: current.worldId, coordinate, region, ordinal, plotVersion, source }
    return options.isOccupied(candidate) ? null : candidate
  }

  while (released.length > 0 && probes < budget) {
    const slot = released.shift()!
    consumedReleasedOrdinals.push(slot.ordinal)
    const allocation = tryOrdinal(slot.ordinal, slot.plotVersion, 'RELEASED')
    if (allocation) {
      return {
        allocation,
        probes,
        consumedReleasedOrdinals,
        exhausted: false,
        index: { ...current, nextOrdinal }
      }
    }
  }

  while (nextOrdinal <= MAX_ALLOCATION_ORDINAL && probes < budget) {
    const ordinal = nextOrdinal
    nextOrdinal += 1
    const allocation = tryOrdinal(ordinal, INITIAL_PLOT_VERSION, 'FRONTIER')
    if (allocation) {
      return {
        allocation,
        probes,
        consumedReleasedOrdinals,
        exhausted: false,
        index: { ...current, nextOrdinal }
      }
    }
  }

  return {
    allocation: null,
    probes,
    consumedReleasedOrdinals,
    exhausted: nextOrdinal > MAX_ALLOCATION_ORDINAL,
    index: { ...current, nextOrdinal }
  }
}

/** Adds a vacated past coordinate to the reusable index without rewinding the frontier. */
export function releasePlayerPlot(
  rawIndex: WorldAllocationIndex,
  released: { coordinate: PlotCoordinate; plotVersion: number }
): { index: WorldAllocationIndex; releasedSlot: ReleasedPlotSlot } {
  const index = normalizeAllocationIndex(rawIndex)
  const ordinal = allocationOrdinalOf(released.coordinate)
  return {
    index,
    releasedSlot: { ordinal, plotVersion: nextPlotVersion(released.plotVersion) }
  }
}

/**
 * Release a real-player override only when its coordinate is player land in
 * the selected generated topology. Vacating a pinned village can reveal a bot,
 * preserve, lake or river; those coordinates must not enter the free index.
 */
export function releasePlayerPlotForTopology(
  rawIndex: WorldAllocationIndex,
  released: { coordinate: PlotCoordinate; plotVersion: number },
  worldSeedVersion: unknown
): { index: WorldAllocationIndex; releasedSlot: ReleasedPlotSlot | null } {
  const index = normalizeAllocationIndex(rawIndex)
  if (classifyPlot(
    released.coordinate,
    index.currentGenerationVersion,
    worldSeedVersion
  ).kind !== 'PLAYER') {
    return { index, releasedSlot: null }
  }
  return releasePlayerPlot(index, released)
}

/** Changes only the generator assigned to regions created after this transition. */
export function useGenerationForNewRegions(
  rawIndex: WorldAllocationIndex,
  generationVersion: GenerationVersion
): WorldAllocationIndex {
  assertGenerationVersion(generationVersion)
  return { ...normalizeAllocationIndex(rawIndex), currentGenerationVersion: generationVersion }
}
