import {
  DEFAULT_REGION_SIZE,
  MAX_WORLD_COORDINATE,
  assertPlotCoordinate,
  assertRegionSize,
  regionCoordinatesForPlot,
  type PlotCoordinate,
  type RegionCoordinate
} from './coordinates'

export const DEFAULT_LOCAL_WINDOW_RADIUS = 2
export const MAX_BOUNDED_WINDOW_RADIUS = 32

export interface PlotWindow {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function normalizedRadius(value: number, maxRadius: number): number {
  const parsed = Number.isFinite(value) ? Math.floor(value) : 0
  return Math.max(0, Math.min(maxRadius, parsed))
}

export function assertPlotWindow(window: PlotWindow): void {
  assertPlotCoordinate({ x: window.minX, y: window.minY })
  assertPlotCoordinate({ x: window.maxX, y: window.maxY })
  if (window.minX > window.maxX || window.minY > window.maxY) {
    throw new RangeError('plot window minimum must not exceed its maximum')
  }
}

/**
 * Creates a bounded Chebyshev window. Its default radius matches the existing
 * 5x5 map response; an optional envelope clips legacy edge requests without
 * making the expandable world itself finite.
 */
export function boundedLocalWindow(input: {
  center: PlotCoordinate
  requestedRadius: number
  maxRadius?: number
  envelope?: PlotWindow
}): PlotWindow {
  assertPlotCoordinate(input.center)
  const maxRadius = input.maxRadius ?? DEFAULT_LOCAL_WINDOW_RADIUS
  if (!Number.isSafeInteger(maxRadius) || maxRadius < 0 || maxRadius > MAX_BOUNDED_WINDOW_RADIUS) {
    throw new RangeError(`maxRadius must be an integer from 0 to ${MAX_BOUNDED_WINDOW_RADIUS}`)
  }
  const radius = normalizedRadius(input.requestedRadius, maxRadius)
  let window: PlotWindow = {
    minX: Math.max(-MAX_WORLD_COORDINATE, input.center.x - radius),
    minY: Math.max(-MAX_WORLD_COORDINATE, input.center.y - radius),
    maxX: Math.min(MAX_WORLD_COORDINATE, input.center.x + radius),
    maxY: Math.min(MAX_WORLD_COORDINATE, input.center.y + radius)
  }
  if (input.envelope) {
    assertPlotWindow(input.envelope)
    if (!windowContains(input.envelope, input.center)) {
      throw new RangeError('window center must be inside its envelope')
    }
    window = {
      minX: Math.max(window.minX, input.envelope.minX),
      minY: Math.max(window.minY, input.envelope.minY),
      maxX: Math.min(window.maxX, input.envelope.maxX),
      maxY: Math.min(window.maxY, input.envelope.maxY)
    }
  }
  assertPlotWindow(window)
  return window
}

export function windowContains(window: PlotWindow, coordinate: PlotCoordinate): boolean {
  return coordinate.x >= window.minX && coordinate.x <= window.maxX
    && coordinate.y >= window.minY && coordinate.y <= window.maxY
}

export function windowArea(window: PlotWindow): number {
  assertPlotWindow(window)
  return (window.maxX - window.minX + 1) * (window.maxY - window.minY + 1)
}

/** Coordinates in the same row-major order as the current map endpoint. */
export function* coordinatesInWindow(window: PlotWindow): Generator<PlotCoordinate> {
  assertPlotWindow(window)
  for (let y = window.minY; y <= window.maxY; y += 1) {
    for (let x = window.minX; x <= window.maxX; x += 1) yield { x, y }
  }
}

/** Geometric region partitions intersected by a query; generation is resolved separately. */
export function regionCoordinatesInWindow(
  window: PlotWindow,
  size = DEFAULT_REGION_SIZE
): RegionCoordinate[] {
  assertPlotWindow(window)
  assertRegionSize(size)
  const first = regionCoordinatesForPlot({ x: window.minX, y: window.minY }, size)
  const last = regionCoordinatesForPlot({ x: window.maxX, y: window.maxY }, size)
  const regions: RegionCoordinate[] = []
  for (let y = first.y; y <= last.y; y += 1) {
    for (let x = first.x; x <= last.x; x += 1) regions.push({ x, y })
  }
  return regions
}

export function chebyshevDistance(a: PlotCoordinate, b: PlotCoordinate): number {
  assertPlotCoordinate(a)
  assertPlotCoordinate(b)
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}
