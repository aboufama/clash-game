export const LEGACY_WORLD_ID = 'main'
export const DEFAULT_REGION_SIZE = 32

// Matches the existing hydrology safety envelope. This is an input-safety
// bound, not a preallocated world border: it exposes four trillion plots.
export const MAX_WORLD_COORDINATE = 1_000_000

/**
 * The MAIN server's advertised world size: plots span ±this on both axes
 * (49×49 = 2,401 plots — room for the ~1,000-player cap after lakes and
 * preserves). This is the WORLD ATLAS frame, not an input-safety bound:
 * the atlas charts every settled player and presents this square as "the
 * world". Multi-server sharding can widen or page this later.
 */
export const WORLD_PLOT_RADIUS = 24

export type GenerationVersion = number
export type RegionId = string

export interface PlotCoordinate {
  x: number
  y: number
}

export interface RegionCoordinate {
  x: number
  y: number
}

export interface LocalPlotCoordinate {
  x: number
  y: number
}

export interface RegionAddress extends RegionCoordinate {
  id: RegionId
  worldId: string
  generationVersion: GenerationVersion
  size: number
}

export interface LocatedPlot {
  coordinate: PlotCoordinate
  local: LocalPlotCoordinate
  region: RegionAddress
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`)
}

export function assertWorldId(worldId: string): void {
  const hasControlCharacter = typeof worldId === 'string'
    && [...worldId].some(character => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  if (typeof worldId !== 'string' || worldId.length < 1 || worldId.length > 128
    || worldId.trim() !== worldId || hasControlCharacter) {
    throw new RangeError('worldId must be a non-empty, trimmed string of at most 128 characters')
  }
}

export function assertGenerationVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError('generationVersion must be a positive safe integer')
  }
}

export function assertRegionSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > 1_024) {
    throw new RangeError('region size must be a safe integer from 1 to 1024')
  }
}

export function assertPlotCoordinate(coordinate: PlotCoordinate): void {
  assertSafeInteger(coordinate.x, 'plot x')
  assertSafeInteger(coordinate.y, 'plot y')
  if (Math.abs(coordinate.x) > MAX_WORLD_COORDINATE || Math.abs(coordinate.y) > MAX_WORLD_COORDINATE) {
    throw new RangeError(`plot coordinates must be within +/-${MAX_WORLD_COORDINATE}`)
  }
}

export function assertRegionCoordinate(coordinate: RegionCoordinate): void {
  assertSafeInteger(coordinate.x, 'region x')
  assertSafeInteger(coordinate.y, 'region y')
}

export function regionCoordinatesForPlot(
  coordinate: PlotCoordinate,
  size = DEFAULT_REGION_SIZE
): RegionCoordinate {
  assertPlotCoordinate(coordinate)
  assertRegionSize(size)
  return { x: Math.floor(coordinate.x / size), y: Math.floor(coordinate.y / size) }
}

export function localCoordinatesForPlot(
  coordinate: PlotCoordinate,
  size = DEFAULT_REGION_SIZE
): LocalPlotCoordinate {
  const region = regionCoordinatesForPlot(coordinate, size)
  return {
    x: coordinate.x - region.x * size,
    y: coordinate.y - region.y * size
  }
}

export function regionIdOf(input: {
  worldId: string
  generationVersion: GenerationVersion
  coordinate: RegionCoordinate
  size?: number
}): RegionId {
  const size = input.size ?? DEFAULT_REGION_SIZE
  assertWorldId(input.worldId)
  assertGenerationVersion(input.generationVersion)
  assertRegionCoordinate(input.coordinate)
  assertRegionSize(size)
  return `${encodeURIComponent(input.worldId)}|g${input.generationVersion}|r${input.coordinate.x},${input.coordinate.y}|s${size}`
}

export function regionAddressForPlot(input: {
  worldId: string
  generationVersion: GenerationVersion
  coordinate: PlotCoordinate
  size?: number
}): RegionAddress {
  const size = input.size ?? DEFAULT_REGION_SIZE
  const coordinate = regionCoordinatesForPlot(input.coordinate, size)
  return {
    ...coordinate,
    id: regionIdOf({
      worldId: input.worldId,
      generationVersion: input.generationVersion,
      coordinate,
      size
    }),
    worldId: input.worldId,
    generationVersion: input.generationVersion,
    size
  }
}

export function locatePlot(input: {
  worldId: string
  generationVersion: GenerationVersion
  coordinate: PlotCoordinate
  size?: number
}): LocatedPlot {
  const size = input.size ?? DEFAULT_REGION_SIZE
  return {
    coordinate: { ...input.coordinate },
    local: localCoordinatesForPlot(input.coordinate, size),
    region: regionAddressForPlot({ ...input, size })
  }
}

export function plotFromLocal(region: RegionAddress, local: LocalPlotCoordinate): PlotCoordinate {
  assertRegionSize(region.size)
  assertRegionCoordinate(region)
  if (!Number.isSafeInteger(local.x) || !Number.isSafeInteger(local.y)
    || local.x < 0 || local.y < 0 || local.x >= region.size || local.y >= region.size) {
    throw new RangeError('local plot coordinates must fall inside their region')
  }
  const coordinate = {
    x: region.x * region.size + local.x,
    y: region.y * region.size + local.y
  }
  assertPlotCoordinate(coordinate)
  return coordinate
}

export function parseRegionId(id: RegionId): RegionAddress {
  const match = /^([^|]+)\|g([1-9]\d*)\|r(-?\d+),(-?\d+)\|s([1-9]\d*)$/.exec(id)
  if (!match) throw new RangeError('invalid region id')
  let worldId: string
  try {
    worldId = decodeURIComponent(match[1])
  } catch {
    throw new RangeError('invalid encoded world id')
  }
  const generationVersion = Number(match[2])
  const coordinate = { x: Number(match[3]), y: Number(match[4]) }
  const size = Number(match[5])
  const canonical = regionIdOf({ worldId, generationVersion, coordinate, size })
  if (canonical !== id) throw new RangeError('non-canonical region id')
  return { id, worldId, generationVersion, size, ...coordinate }
}

/** Stable storage/cache key; unlike comma concatenation, world IDs cannot collide. */
export function plotKey(worldId: string, coordinate: PlotCoordinate): string {
  assertWorldId(worldId)
  assertPlotCoordinate(coordinate)
  return `${worldId}\u0000${coordinate.x}\u0000${coordinate.y}`
}
