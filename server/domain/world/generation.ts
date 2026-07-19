import { botFrontierFillSeedAt, botSeedAt, isWildernessPreserveAt } from '../../../src/game/config/Economy'
import {
  assertGenerationVersion,
  assertPlotCoordinate,
  type GenerationVersion,
  type PlotCoordinate
} from './coordinates'

export const CURRENT_WORLD_GENERATION_VERSION = 1
export const LEGACY_WORLD_COORD_LIMIT = 64
export const LEGACY_HOME_COORD_LIMIT = 62
export const INITIAL_WORLD_PRESENTATION_SEED_VERSION = 0
const MAX_WORLD_PRESENTATION_SEED_VERSION = 0xffff_ffff
const PRESENTATION_SEED_STEP = 0x9e37_79b9

export type PlotEligibility =
  | { kind: 'PLAYER'; settleable: true }
  | { kind: 'BOT'; settleable: false; seed: number }
  | { kind: 'PRESERVE'; settleable: false }

export interface WorldGeneration {
  readonly version: GenerationVersion
  classify(coordinate: PlotCoordinate, worldSeedVersion?: unknown): PlotEligibility
}

/**
 * Normalize the mutable generated-world epoch. Old saves predate this field
 * and therefore map to epoch zero, preserving every shipped bot, preserve and
 * water feature until a developer explicitly reseeds the world.
 */
export function normalizeWorldPresentationSeedVersion(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) return INITIAL_WORLD_PRESENTATION_SEED_VERSION
  return Math.min(MAX_WORLD_PRESENTATION_SEED_VERSION, numeric)
}

/** Advance the local-development topology epoch. Epoch zero remains production-compatible. */
export function nextWorldPresentationSeedVersion(current: unknown): number {
  const normalized = normalizeWorldPresentationSeedVersion(current)
  return normalized >= MAX_WORLD_PRESENTATION_SEED_VERSION
    ? 1
    : normalized + 1
}

/**
 * Derive one bot village's mutable appearance seed from its immutable
 * coordinate-classification seed. Addition by an odd 32-bit constant is a
 * permutation, so consecutive reseeds cannot silently produce the same seed.
 */
export function botVillagePresentationSeed(topologySeed: number, presentationSeedVersion: unknown): number {
  const base = topologySeed >>> 0
  const version = normalizeWorldPresentationSeedVersion(presentationSeedVersion)
  if (version === INITIAL_WORLD_PRESENTATION_SEED_VERSION) return base
  const mixed = (base + Math.imul(version, PRESENTATION_SEED_STEP)) >>> 0
  // Bot generation reserves zero as an invalid seed and normalizes it to one.
  return mixed === 0 ? 1 : mixed
}

/**
 * Classify one generated bot in the current topology epoch and derive its
 * village appearance. Epoch zero exactly reproduces the shipped world.
 */
export function botVillageSeedAt(
  coordinate: PlotCoordinate,
  presentationSeedVersion: unknown = INITIAL_WORLD_PRESENTATION_SEED_VERSION
): number | null {
  assertPlotCoordinate(coordinate)
  const topologySeed = botSeedAt(coordinate.x, coordinate.y, presentationSeedVersion)
  return topologySeed === null
    ? null
    : botVillagePresentationSeed(topologySeed, presentationSeedVersion)
}

/**
 * Generation version 1 is deliberately an adapter over the shipped predicates.
 * At epoch zero, existing absolute coordinates retain exactly the same bot,
 * preserve, and player-home meaning after storage moves to regions.
 */
export const LEGACY_WORLD_GENERATION: WorldGeneration = Object.freeze({
  version: 1,
  classify(coordinate: PlotCoordinate, worldSeedVersion: unknown = INITIAL_WORLD_PRESENTATION_SEED_VERSION): PlotEligibility {
    assertPlotCoordinate(coordinate)
    if (isWildernessPreserveAt(coordinate.x, coordinate.y, worldSeedVersion)) {
      return { kind: 'PRESERVE', settleable: false }
    }
    const seed = botSeedAt(coordinate.x, coordinate.y, worldSeedVersion)
    return seed === null
      ? { kind: 'PLAYER', settleable: true }
      : { kind: 'BOT', settleable: false, seed }
  }
})

// Generation implementations are immutable code, not runtime registrations.
// Adding v2 means adding one entry while all persisted v1 regions retain v1.
const GENERATIONS: ReadonlyMap<GenerationVersion, WorldGeneration> = new Map([
  [LEGACY_WORLD_GENERATION.version, LEGACY_WORLD_GENERATION]
])

export function worldGeneration(version: GenerationVersion): WorldGeneration {
  assertGenerationVersion(version)
  const generation = GENERATIONS.get(version)
  if (!generation) throw new RangeError(`unsupported world generation version: ${version}`)
  return generation
}

export function classifyPlot(
  coordinate: PlotCoordinate,
  generationVersion = CURRENT_WORLD_GENERATION_VERSION,
  worldSeedVersion: unknown = INITIAL_WORLD_PRESENTATION_SEED_VERSION
): PlotEligibility {
  return worldGeneration(generationVersion).classify(coordinate, worldSeedVersion)
}

export function isPlayerPlotEligible(
  coordinate: PlotCoordinate,
  generationVersion = CURRENT_WORLD_GENERATION_VERSION,
  worldSeedVersion: unknown = INITIAL_WORLD_PRESENTATION_SEED_VERSION
): boolean {
  return classifyPlot(coordinate, generationVersion, worldSeedVersion).kind === 'PLAYER'
}

/**
 * The spiral settlement rule: every plot that is not a preserve (including
 * the hydrology plots folded into preserves) can be claimed by a player.
 * Claiming a BOT-classified coordinate replaces that generated camp — the
 * occupancy index always wins over generated presentation.
 */
export function isSpiralSettleable(
  coordinate: PlotCoordinate,
  generationVersion = CURRENT_WORLD_GENERATION_VERSION,
  worldSeedVersion: unknown = INITIAL_WORLD_PRESENTATION_SEED_VERSION
): boolean {
  return classifyPlot(coordinate, generationVersion, worldSeedVersion).kind !== 'PRESERVE'
}

/**
 * Which bot village (if any) presents at an UNOCCUPIED coordinate, given the
 * settled frontier around the world origin. Structural clans from botSeedAt
 * show everywhere, exactly as before. Inside the frontier every remaining
 * settleable plot additionally presents a deterministic fill camp, so the
 * world center reads as one dense bot neighbourhood that new accounts replace
 * plot by plot as the spiral hands those coordinates out. Preserves and
 * beyond-frontier gaps stay wilderness. Callers must check real occupancy
 * first; a claimed plot never presents as a bot.
 */
export function settledFrontierBotVillageSeedAt(
  coordinate: PlotCoordinate,
  input: { frontierRadius: number; presentationSeedVersion?: unknown }
): number | null {
  assertPlotCoordinate(coordinate)
  const seedVersion = input.presentationSeedVersion ?? INITIAL_WORLD_PRESENTATION_SEED_VERSION
  const structural = botVillageSeedAt(coordinate, seedVersion)
  if (structural !== null) return structural
  if (!Number.isSafeInteger(input.frontierRadius) || input.frontierRadius < 0) return null
  if (Math.max(Math.abs(coordinate.x), Math.abs(coordinate.y)) > input.frontierRadius) return null
  const fillSeed = botFrontierFillSeedAt(coordinate.x, coordinate.y, seedVersion)
  return fillSeed === null ? null : botVillagePresentationSeed(fillSeed, seedVersion)
}

export function isInsideLegacyWorld(coordinate: PlotCoordinate): boolean {
  assertPlotCoordinate(coordinate)
  return Math.abs(coordinate.x) <= LEGACY_WORLD_COORD_LIMIT
    && Math.abs(coordinate.y) <= LEGACY_WORLD_COORD_LIMIT
}

export function isInsideLegacyHomeArea(coordinate: PlotCoordinate): boolean {
  assertPlotCoordinate(coordinate)
  return Math.abs(coordinate.x) <= LEGACY_HOME_COORD_LIMIT
    && Math.abs(coordinate.y) <= LEGACY_HOME_COORD_LIMIT
}
