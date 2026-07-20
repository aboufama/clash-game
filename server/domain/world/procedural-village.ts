import {
  BUILDING_DEFINITIONS,
  MAP_SIZE,
  OBSTACLE_DEFINITIONS,
  type BuildingType,
  type ObstacleType
} from '../../../src/game/config/GameDefinitions'
import { resourceCapacity } from '../../../src/game/config/Economy'
import type {
  SerializedBuilding,
  SerializedObstacle,
  SerializedWorld
} from '../../../src/game/data/Models'
import { populationCapacity, staffingFactor, workersNeeded } from '../village/simulation'

export const PROCEDURAL_VILLAGE_GENERATOR_VERSION = 3

export type ProceduralVillageDifficulty =
  | 'established'
  | 'strong'
  | 'elite'
  | 'fortress'
  | 'extreme'

export interface ProceduralVillageOptions {
  id?: string
  ownerId?: string
  username?: string
  difficulty?: ProceduralVillageDifficulty
}

type NonWallBuildingType = Exclude<BuildingType, 'wall'>

interface DifficultyProfile {
  wallLevel: number
  defenseLevelFractions: readonly [number, number, number, number, number]
  supportLevelPower: number
  populationFraction: number
  obstacleCount: number
  gold: readonly [number, number]
  stockFraction: readonly [number, number]
  roster: Readonly<Partial<Record<NonWallBuildingType, number>>>
  /** Per-mille weights for rolling 1, 2 or 3 wall loops. */
  loopCountWeights: readonly [number, number, number]
  /** Per-mille chance that an adjacent loop pair gets a curtain-wall run. */
  connectorChance: number
  /**
   * Per-mille chance that curtains CLOSE the circuit (1-2, 2-3, 3-1, or a
   * double run between a pair), walling off a central ward that baits
   * attackers the way real castle baileys do.
   */
  wardChance: number
  /** Per-mille chance of a full outer enceinte wrapped around the keep. */
  concentricChance: number
  /** Per-mille chance that an eligible loop gets an internal dividing wall. */
  subdivisionChance: number
  maxSubdivisions: number
  /** Interior head-room multiplier (per-mille) over the wants-inside footprint. */
  interiorSlack: number
  /** Weight of the marginal range-coverage term when siting defenses. */
  coverageWeight: number
  /** Hashed placement noise — high on sloppy bands, low on disciplined ones. */
  placementJitter: number
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface LoopRect extends Rect {
  level: number
}

interface Lane {
  wallX: number
  wallY: number
  sideAX: number
  sideAY: number
  sideBX: number
  sideBY: number
}

interface WallPlan {
  cells: Map<string, { x: number; y: number; level: number }>
  loops: LoopRect[]
  lanes: Lane[]
}

interface Compartment {
  tiles: ReadonlySet<string>
  area: number
  centroidX: number
  centroidY: number
  defenses: number
  storages: number
}

interface BuildingInstance {
  type: NonWallBuildingType
  ordinal: number
  preferredCompartment: number
}

interface PlacementState {
  occupied: Set<string>
  passableWalls: ReadonlySet<string>
  reserved: ReadonlySet<string>
  buildings: SerializedBuilding[]
  compartments: Compartment[]
  coreCompartment: number
  /** tile index -> compartment index, -1 for exterior and wall cells */
  tileCompartment: Int16Array
  /** Chebyshev distance from each tile to the nearest wall cell */
  wallDistance: Uint8Array
  /** Exterior tiles within 2 tiles of a wall — where attackers walk and drop */
  approachBand: ReadonlyArray<{ x: number; y: number }>
  /** How many already-placed defenses cover each approach-band entry */
  coverCount: Uint8Array
  centroidX: number
  centroidY: number
  skirtAngles: number[]
}

interface PlacementCandidate {
  x: number
  y: number
  score: number
}

const WALL_CAP_RESERVE_FOR_CONNECTORS = 8

const DIFFICULTY_PROFILES: Readonly<Record<ProceduralVillageDifficulty, DifficultyProfile>> = {
  established: {
    wallLevel: 2,
    defenseLevelFractions: [0, 180, 360, 540, 680],
    supportLevelPower: 520,
    populationFraction: 500,
    obstacleCount: 10,
    gold: [3_000, 5_500],
    stockFraction: [380, 620],
    roster: {
      cannon: 3,
      ballista: 1,
      xbow: 1,
      mortar: 1,
      tesla: 1,
      spike_launcher: 1,
      mine: 2,
      farm: 2,
      storage: 2,
      barracks: 1,
      mystic_barracks: 1,
      lab: 1,
      army_camp: 1,
      watchtower: 1
    },
    loopCountWeights: [550, 450, 0],
    connectorChance: 300,
    wardChance: 100,
    concentricChance: 0,
    subdivisionChance: 0,
    maxSubdivisions: 0,
    interiorSlack: 1_200,
    coverageWeight: 22,
    placementJitter: 14_000
  },
  strong: {
    wallLevel: 2,
    defenseLevelFractions: [100, 300, 500, 680, 820],
    supportLevelPower: 650,
    populationFraction: 650,
    obstacleCount: 13,
    gold: [5_500, 9_000],
    stockFraction: [500, 740],
    roster: {
      cannon: 4,
      ballista: 2,
      xbow: 1,
      mortar: 2,
      tesla: 2,
      spike_launcher: 1,
      mine: 3,
      farm: 2,
      storage: 3,
      barracks: 1,
      mystic_barracks: 1,
      lab: 1,
      army_camp: 2,
      watchtower: 1,
      jukebox: 1
    },
    loopCountWeights: [350, 500, 150],
    connectorChance: 450,
    wardChance: 300,
    concentricChance: 0,
    subdivisionChance: 150,
    maxSubdivisions: 1,
    interiorSlack: 1_250,
    coverageWeight: 30,
    placementJitter: 10_000
  },
  elite: {
    wallLevel: 3,
    defenseLevelFractions: [180, 400, 620, 800, 920],
    supportLevelPower: 780,
    populationFraction: 780,
    obstacleCount: 16,
    gold: [9_000, 15_000],
    stockFraction: [620, 840],
    roster: {
      cannon: 5,
      ballista: 2,
      xbow: 2,
      mortar: 3,
      tesla: 2,
      prism: 1,
      spike_launcher: 1,
      mine: 3,
      farm: 3,
      storage: 4,
      barracks: 1,
      mystic_barracks: 1,
      lab: 1,
      army_camp: 2,
      watchtower: 1,
      jukebox: 1
    },
    loopCountWeights: [250, 450, 300],
    connectorChance: 550,
    wardChance: 500,
    concentricChance: 60,
    subdivisionChance: 350,
    maxSubdivisions: 1,
    interiorSlack: 1_300,
    coverageWeight: 38,
    placementJitter: 8_000
  },
  fortress: {
    wallLevel: 4,
    defenseLevelFractions: [260, 500, 720, 880, 1_000],
    supportLevelPower: 900,
    populationFraction: 900,
    obstacleCount: 19,
    gold: [15_000, 25_000],
    stockFraction: [760, 940],
    roster: {
      cannon: 5,
      ballista: 2,
      xbow: 3,
      mortar: 3,
      tesla: 3,
      prism: 1,
      dragons_breath: 1,
      spike_launcher: 2,
      mine: 3,
      farm: 3,
      storage: 4,
      barracks: 1,
      mystic_barracks: 1,
      lab: 1,
      army_camp: 3,
      watchtower: 1,
      jukebox: 1
    },
    loopCountWeights: [120, 440, 440],
    connectorChance: 650,
    wardChance: 780,
    concentricChance: 120,
    subdivisionChance: 550,
    maxSubdivisions: 2,
    interiorSlack: 1_350,
    coverageWeight: 44,
    placementJitter: 7_000
  },
  extreme: {
    wallLevel: 4,
    defenseLevelFractions: [700, 750, 850, 950, 1_000],
    supportLevelPower: 970,
    populationFraction: 1_000,
    obstacleCount: 22,
    gold: [25_000, 40_000],
    stockFraction: [880, 1_000],
    roster: {
      cannon: 5,
      ballista: 2,
      xbow: 3,
      mortar: 3,
      tesla: 3,
      prism: 1,
      dragons_breath: 1,
      spike_launcher: 2,
      mine: 3,
      farm: 3,
      storage: 4,
      barracks: 1,
      mystic_barracks: 1,
      lab: 1,
      army_camp: 4,
      watchtower: 1,
      jukebox: 1
    },
    loopCountWeights: [150, 400, 450],
    connectorChance: 700,
    wardChance: 800,
    concentricChance: 250,
    subdivisionChance: 750,
    maxSubdivisions: 2,
    interiorSlack: 1_450,
    coverageWeight: 50,
    placementJitter: 6_000
  }
}

const TROPHY_RANGES: Readonly<Record<ProceduralVillageDifficulty, readonly [number, number]>> = {
  established: [650, 1_050],
  strong: [1_050, 1_650],
  elite: [1_650, 2_450],
  fortress: [2_450, 3_350],
  extreme: [3_350, 4_500]
}

/** Types the walls exist to protect — their footprints drive loop sizing. */
const WANTS_INSIDE: readonly NonWallBuildingType[] = [
  'town_hall',
  'storage',
  'cannon',
  'ballista',
  'xbow',
  'mortar',
  'tesla',
  'prism',
  'dragons_breath',
  'spike_launcher',
  'lab'
]

/** Defense placement order: anchors first, then fill-ins. */
const DEFENSE_ORDER: readonly NonWallBuildingType[] = [
  'dragons_breath',
  'xbow',
  'mortar',
  'ballista',
  'spike_launcher',
  'prism',
  'cannon',
  'tesla'
]

/** Ring of economy/military props hugging the walls from the outside. */
const SKIRT_ORDER: readonly NonWallBuildingType[] = [
  'army_camp',
  'farm',
  'mine',
  'barracks',
  'mystic_barracks',
  'watchtower',
  'jukebox'
]

const OBSTACLE_PALETTE: readonly ObstacleType[] = [
  'grass_patch',
  'tree_pine',
  'rock_small',
  'grass_patch',
  'tree_oak',
  'rock_large'
]

const ADJECTIVES = ['Ashen', 'Brass', 'Ember', 'Granite', 'Iron', 'Moon', 'Storm', 'Sunken'] as const
const NOUNS = ['Bastion', 'Citadel', 'Hold', 'March', 'Redoubt', 'Ward', 'Watch', 'Works'] as const

const DIFFICULTY_SALT = 0x13d6_3a9f
const TROPHY_SALT = 0x71af_22c3
const TOPOLOGY_SALT = 0x4e91_7bb5
const CURTAIN_SALT = 0x7f4a_7c15
const WARD_SALT = 0x5bd1_e995
const CONCENTRIC_SALT = 0x2545_f491
const SUBDIVISION_SALT = 0x94d0_49bb
const GATE_SALT = 0xc2b2_ae35
const PLACEMENT_SALT = 0x85eb_ca6b
const LEVEL_SALT = 0x27d4_eb2f
const OBSTACLE_SALT = 0x1656_67b1
const RESOURCE_SALT = 0xd3a2_646c
const NAME_SALT = 0x9e37_79b9

class U32Stream {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b_79f5) >>> 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return (value ^ (value >>> 14)) >>> 0
  }

  int(exclusiveMax: number): number {
    if (!Number.isSafeInteger(exclusiveMax) || exclusiveMax <= 0) {
      throw new RangeError(`exclusiveMax must be a positive safe integer: ${exclusiveMax}`)
    }
    const limit = Math.floor(0x1_0000_0000 / exclusiveMax) * exclusiveMax
    let value = this.next()
    while (value >= limit) value = this.next()
    return value % exclusiveMax
  }
}

function normalizeSeed(seed: number): number {
  if (!Number.isSafeInteger(seed) || seed < -0x8000_0000 || seed > 0xffff_ffff) {
    throw new RangeError(`procedural village seed must be a 32-bit integer: ${seed}`)
  }
  return seed >>> 0
}

function mix32(input: number): number {
  let value = input >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x7feb_352d)
  value = Math.imul(value ^ (value >>> 15), 0x846c_a68b)
  return (value ^ (value >>> 16)) >>> 0
}

function hashText(text: string): number {
  let hash = 0x811c_9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x0100_0193)
  }
  return hash >>> 0
}

function streamFor(seed: number, salt: number): U32Stream {
  return new U32Stream(mix32(seed ^ salt))
}

function key(x: number, y: number): string {
  return `${x},${y}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function difficultyOfNormalizedSeed(seed: number): ProceduralVillageDifficulty {
  const roll = mix32(seed ^ DIFFICULTY_SALT) % 1_000
  if (roll < 80) return 'established'
  if (roll < 390) return 'strong'
  if (roll < 720) return 'elite'
  if (roll < 920) return 'fortress'
  return 'extreme'
}

export function proceduralVillageDifficulty(seed: number): ProceduralVillageDifficulty {
  return difficultyOfNormalizedSeed(normalizeSeed(seed))
}

function trophiesFor(seed: number, difficulty: ProceduralVillageDifficulty): number {
  const [minimum, maximum] = TROPHY_RANGES[difficulty]
  return minimum + (mix32(seed ^ TROPHY_SALT) % (maximum - minimum + 1))
}

export function proceduralVillageTrophies(seed: number): number {
  const normalized = normalizeSeed(seed)
  return trophiesFor(normalized, difficultyOfNormalizedSeed(normalized))
}

function distanceToBoundary(x: number, y: number): number {
  return Math.min(x, y, MAP_SIZE - 1 - x, MAP_SIZE - 1 - y)
}

function rectsSeparated(a: Rect, b: Rect): boolean {
  return a.x + a.width + 1 <= b.x
    || b.x + b.width + 1 <= a.x
    || a.y + a.height + 1 <= b.y
    || b.y + b.height + 1 <= a.y
}

function rectGap(a: Rect, b: Rect): number {
  const gapX = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)))
  const gapY = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)))
  return Math.max(gapX, gapY)
}

function insideAnyLoop(loops: readonly Rect[], x: number, y: number): boolean {
  return loops.some(loop => x >= loop.x && y >= loop.y
    && x < loop.x + loop.width && y < loop.y + loop.height)
}

function perimeterOf(room: Rect): Array<{ x: number; y: number }> {
  const result: Array<{ x: number; y: number }> = []
  for (let x = room.x; x < room.x + room.width; x += 1) {
    result.push({ x, y: room.y })
    result.push({ x, y: room.y + room.height - 1 })
  }
  for (let y = room.y + 1; y < room.y + room.height - 1; y += 1) {
    result.push({ x: room.x, y })
    result.push({ x: room.x + room.width - 1, y })
  }
  return result
}

function interiorDemand(profile: DifficultyProfile): number {
  let demand = BUILDING_DEFINITIONS.town_hall.width * BUILDING_DEFINITIONS.town_hall.height
  for (const type of WANTS_INSIDE) {
    if (type === 'town_hall') continue
    const count = profile.roster[type] ?? 0
    const definition = BUILDING_DEFINITIONS[type]
    demand += count * definition.width * definition.height
  }
  return Math.floor(demand * profile.interiorSlack / 1_000)
}

function weightedRoll(random: U32Stream, weights: readonly number[]): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let roll = random.int(total)
  for (let index = 0; index < weights.length; index += 1) {
    roll -= weights[index]
    if (roll < 0) return index
  }
  return weights.length - 1
}

/**
 * Roll the wall complex: 1-3 rectangular loops sized so their combined
 * interiors hold the band's wants-inside roster. Nothing is symmetric or
 * template-driven — sizes, aspects and positions all come off the seed.
 */
function planLoops(seed: number, profile: DifficultyProfile, extraReserve = 0): LoopRect[] {
  const random = streamFor(seed, TOPOLOGY_SALT)
  const targetCount = 1 + weightedRoll(random, profile.loopCountWeights)
  const demand = interiorDemand(profile)
  const shares = targetCount === 1
    ? [1_000]
    : targetCount === 2
      ? [620 + random.int(80) - 40, 0]
      : [500 + random.int(80) - 40, 280 + random.int(60) - 30, 0]
  if (targetCount >= 2) {
    const assigned = shares.slice(0, targetCount - 1).reduce((sum, share) => sum + share, 0)
    shares[targetCount - 1] = 1_000 - assigned
  }

  const loops: LoopRect[] = []
  for (let index = 0; index < targetCount; index += 1) {
    const minimumInterior = index === 0 ? 25 : 12
    const targetInterior = Math.max(minimumInterior, Math.floor(demand * shares[index] / 1_000))
    const aspect = [750, 1_000, 1_333][random.int(3)]
    // The primary loop never goes under a 5x5 yard: a smaller interior can be
    // fully blocked for the 3x3 town hall by a single reserved lane tile.
    const minimumSpan = index === 0 ? 5 : 4
    let interiorHeight = clamp(Math.round(Math.sqrt(targetInterior * 1_000 / aspect)), minimumSpan, 15)
    let interiorWidth = clamp(Math.ceil(targetInterior / interiorHeight), minimumSpan, 15)
    let placed = false
    for (let shrink = 0; shrink < 4 && !placed; shrink += 1) {
      const width = interiorWidth + 2
      const height = interiorHeight + 2
      if (index === 0) {
        const x = clamp(
          Math.floor((MAP_SIZE - width) / 2) + random.int(7) - 3,
          1,
          MAP_SIZE - 1 - width
        )
        const y = clamp(
          Math.floor((MAP_SIZE - height) / 2) + random.int(7) - 3,
          1,
          MAP_SIZE - 1 - height
        )
        loops.push({ x, y, width, height, level: profile.wallLevel })
        placed = true
        break
      }
      let best: LoopRect | null = null
      let bestScore = Number.POSITIVE_INFINITY
      for (let attempt = 0; attempt < 140; attempt += 1) {
        const x = 1 + random.int(MAP_SIZE - 1 - width)
        const y = 1 + random.int(MAP_SIZE - 1 - height)
        const candidate: LoopRect = { x, y, width, height, level: profile.wallLevel }
        if (!loops.every(existing => rectsSeparated(existing, candidate))) continue
        const nearestGap = Math.min(...loops.map(existing => rectGap(existing, candidate)))
        const centroidDistance = Math.abs(x * 2 + width - MAP_SIZE) + Math.abs(y * 2 + height - MAP_SIZE)
        const score = Math.abs(nearestGap - 2) * 5_000 + centroidDistance * 250 + random.int(2_000)
        if (score < bestScore) {
          bestScore = score
          best = candidate
        }
      }
      if (best) {
        loops.push(best)
        placed = true
      } else {
        interiorWidth = Math.max(4, interiorWidth - 1)
        interiorHeight = Math.max(4, interiorHeight - 1)
      }
    }
  }

  // Respect the wall catalog cap, leaving room for curtain runs when the
  // complex has more than one loop. Shrink the largest loop first; drop the
  // smallest as a last resort.
  const reserve = (loops.length > 1 ? WALL_CAP_RESERVE_FOR_CONNECTORS : 0) + extraReserve
  const cap = BUILDING_DEFINITIONS.wall.maxCount - reserve
  const perimeterCount = (loop: Rect) => 2 * loop.width + 2 * loop.height - 4
  let guard = 0
  while (loops.reduce((sum, loop) => sum + perimeterCount(loop), 0) > cap && guard < 64) {
    guard += 1
    // The primary keep never shrinks below a 5x5 yard (town-hall guarantee).
    const shrinkable = [...loops]
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .find(loop => Math.max(loop.width, loop.height) > (loop === loops[0] ? 7 : 6))
    if (!shrinkable) {
      let smallest = -1
      for (let index = 1; index < loops.length; index += 1) {
        if (smallest < 0
          || loops[index].width * loops[index].height < loops[smallest].width * loops[smallest].height) {
          smallest = index
        }
      }
      if (smallest < 0) break
      loops.splice(smallest, 1)
      continue
    }
    if (shrinkable.width >= shrinkable.height) shrinkable.width -= 1
    else shrinkable.height -= 1
  }

  // Wall-level enforcer: walls upgrade as a cohort in this game, so every
  // segment of a bot base shares one level — no lagging outer works.
  return loops
}

/**
 * The concentric roll: a keep wrapped by a full outer enceinte, with a 2-3
 * tile ward ring between the walls — the "really crazy" castle format. Both
 * rings must fit the wall catalog cap or the roll is abandoned.
 */
function planConcentric(seed: number, profile: DifficultyProfile): LoopRect[] | null {
  const random = streamFor(seed, CONCENTRIC_SALT)
  const demand = interiorDemand(profile)
  const targetInterior = Math.max(25, Math.floor(demand * (450 + random.int(150)) / 1_000))
  const aspect = [750, 1_000, 1_333][random.int(3)]
  let interiorHeight = clamp(Math.round(Math.sqrt(targetInterior * 1_000 / aspect)), 5, 9)
  let interiorWidth = clamp(Math.ceil(targetInterior / interiorHeight), 5, 9)
  let clearance = 2 + random.int(2)
  const perimeterOfSpan = (width: number, height: number) => 2 * width + 2 * height - 4
  for (let guard = 0; guard < 24; guard += 1) {
    const innerWidth = interiorWidth + 2
    const innerHeight = interiorHeight + 2
    const outerWidth = innerWidth + 2 * clearance + 2
    const outerHeight = innerHeight + 2 * clearance + 2
    const total = perimeterOfSpan(innerWidth, innerHeight) + perimeterOfSpan(outerWidth, outerHeight)
    const fitsMap = outerWidth <= MAP_SIZE - 3 && outerHeight <= MAP_SIZE - 3
    if (total <= BUILDING_DEFINITIONS.wall.maxCount && fitsMap) {
      const outerX = clamp(
        Math.floor((MAP_SIZE - outerWidth) / 2) + random.int(3) - 1,
        1,
        MAP_SIZE - 1 - outerWidth
      )
      const outerY = clamp(
        Math.floor((MAP_SIZE - outerHeight) / 2) + random.int(3) - 1,
        1,
        MAP_SIZE - 1 - outerHeight
      )
      const innerX = clamp(
        outerX + 1 + clearance + random.int(3) - 1,
        outerX + 1 + clearance,
        outerX + outerWidth - 1 - clearance - innerWidth
      )
      const innerY = clamp(
        outerY + 1 + clearance + random.int(3) - 1,
        outerY + 1 + clearance,
        outerY + outerHeight - 1 - clearance - innerHeight
      )
      // Cohort rule: keep and enceinte share the band's wall level.
      return [
        { x: innerX, y: innerY, width: innerWidth, height: innerHeight, level: profile.wallLevel },
        { x: outerX, y: outerY, width: outerWidth, height: outerHeight, level: profile.wallLevel }
      ]
    }
    if (clearance > 2) clearance -= 1
    else if (interiorWidth >= interiorHeight && interiorWidth > 5) interiorWidth -= 1
    else if (interiorHeight > 5) interiorHeight -= 1
    else return null
  }
  return null
}

interface DisjointSet {
  parents: number[]
}

function findRoot(set: DisjointSet, index: number): number {
  let root = index
  while (set.parents[root] !== root) root = set.parents[root]
  set.parents[index] = root
  return root
}

/**
 * Curtain-wall runs joining nearby loops — open wall segments the way real
 * fortifications link bastions. Straight when the loops' interiors face each
 * other, one L-bend otherwise; a tree only, never cycles.
 */
function planConnectors(
  seed: number,
  profile: DifficultyProfile,
  loops: readonly LoopRect[],
  cells: Map<string, { x: number; y: number; level: number }>
): void {
  if (loops.length < 2) return
  const random = streamFor(seed, CURTAIN_SALT)
  const set: DisjointSet = { parents: loops.map((_, index) => index) }
  const pairs: Array<{ a: number; b: number; gap: number }> = []
  for (let a = 0; a < loops.length; a += 1) {
    for (let b = a + 1; b < loops.length; b += 1) {
      pairs.push({ a, b, gap: rectGap(loops[a], loops[b]) })
    }
  }
  pairs.sort((left, right) => left.gap - right.gap || left.a - right.a || left.b - right.b)

  for (const pair of pairs) {
    if (findRoot(set, pair.a) === findRoot(set, pair.b)) continue
    if (random.int(1_000) >= profile.connectorChance) continue
    const path = connectorPath(loops[pair.a], loops[pair.b], loops, cells, random)
    if (!path) continue
    if (cells.size + path.length > BUILDING_DEFINITIONS.wall.maxCount) continue
    const level = Math.min(loops[pair.a].level, loops[pair.b].level)
    for (const cell of path) cells.set(key(cell.x, cell.y), { ...cell, level })
    set.parents[findRoot(set, pair.a)] = findRoot(set, pair.b)
  }
}

/**
 * Ward closure: curtains that close the circuit instead of merely linking.
 * Three loops connect 1-2, 2-3, 3-1 in angular order so the ground between
 * them becomes a fourth fully-enclosed ward; two loops get a DOUBLE curtain
 * enclosing a corridor ward. Real castles bait attackers exactly this way.
 */
function planWardConnectors(
  seed: number,
  loops: readonly LoopRect[],
  cells: Map<string, { x: number; y: number; level: number }>
): void {
  const random = streamFor(seed, CURTAIN_SALT)
  if (loops.length === 2) {
    if (dualCurtain(loops[0], loops[1], loops, cells, random)) return
    const path = connectorPath(loops[0], loops[1], loops, cells, random)
    if (path && cells.size + path.length <= BUILDING_DEFINITIONS.wall.maxCount) {
      const level = Math.min(loops[0].level, loops[1].level)
      for (const cell of path) cells.set(key(cell.x, cell.y), { ...cell, level })
    }
    return
  }
  const centerX = loops.reduce((sum, loop) => sum + loop.x + loop.width / 2, 0) / loops.length
  const centerY = loops.reduce((sum, loop) => sum + loop.y + loop.height / 2, 0) / loops.length
  const order = loops
    .map(loop => ({
      loop,
      angle: Math.atan2(loop.y + loop.height / 2 - centerY, loop.x + loop.width / 2 - centerX)
    }))
    .sort((left, right) => left.angle - right.angle || left.loop.x - right.loop.x || left.loop.y - right.loop.y)
    .map(entry => entry.loop)
  for (let index = 0; index < order.length; index += 1) {
    const a = order[index]
    const b = order[(index + 1) % order.length]
    const path = connectorPath(a, b, loops, cells, random)
    if (!path) continue
    if (cells.size + path.length > BUILDING_DEFINITIONS.wall.maxCount) continue
    const level = Math.min(a.level, b.level)
    for (const cell of path) cells.set(key(cell.x, cell.y), { ...cell, level })
  }
}

/** Two parallel curtain runs between a facing pair, enclosing a corridor ward. */
function dualCurtain(
  a: LoopRect,
  b: LoopRect,
  loops: readonly LoopRect[],
  cells: Map<string, { x: number; y: number; level: number }>,
  random: U32Stream
): boolean {
  const level = Math.min(a.level, b.level)
  const tryRuns = (runs: Array<{ x: number; y: number }>): boolean => {
    if (runs.length === 0) return false
    if (cells.size + runs.length > BUILDING_DEFINITIONS.wall.maxCount) return false
    const valid = runs.every(cell => cell.x >= 1 && cell.y >= 1
      && cell.x <= MAP_SIZE - 2 && cell.y <= MAP_SIZE - 2
      && !cells.has(key(cell.x, cell.y))
      && !insideAnyLoop(loops, cell.x, cell.y))
    if (!valid) return false
    for (const cell of runs) cells.set(key(cell.x, cell.y), { ...cell, level })
    return true
  }

  const columnLow = Math.max(a.x + 1, b.x + 1)
  const columnHigh = Math.min(a.x + a.width - 2, b.x + b.width - 2)
  if (columnHigh - columnLow >= 2) {
    const upper = a.y < b.y ? a : b
    const lower = a.y < b.y ? b : a
    const startY = upper.y + upper.height
    const endY = lower.y - 1
    if (endY >= startY) {
      const first = columnLow + random.int(columnHigh - columnLow - 1)
      const second = first + 2 + random.int(columnHigh - first - 1)
      const runs: Array<{ x: number; y: number }> = []
      for (const column of [first, second]) {
        for (let y = startY; y <= endY; y += 1) runs.push({ x: column, y })
      }
      if (tryRuns(runs)) return true
    }
  }

  const rowLow = Math.max(a.y + 1, b.y + 1)
  const rowHigh = Math.min(a.y + a.height - 2, b.y + b.height - 2)
  if (rowHigh - rowLow >= 2) {
    const left = a.x < b.x ? a : b
    const right = a.x < b.x ? b : a
    const startX = left.x + left.width
    const endX = right.x - 1
    if (endX >= startX) {
      const first = rowLow + random.int(rowHigh - rowLow - 1)
      const second = first + 2 + random.int(rowHigh - first - 1)
      const runs: Array<{ x: number; y: number }> = []
      for (const row of [first, second]) {
        for (let x = startX; x <= endX; x += 1) runs.push({ x, y: row })
      }
      if (tryRuns(runs)) return true
    }
  }
  return false
}

function connectorPath(
  a: LoopRect,
  b: LoopRect,
  loops: readonly LoopRect[],
  cells: ReadonlyMap<string, unknown>,
  random: U32Stream
): Array<{ x: number; y: number }> | null {
  const candidates: Array<Array<{ x: number; y: number }>> = []

  // Straight vertical run where interior columns face each other.
  const columnLow = Math.max(a.x + 1, b.x + 1)
  const columnHigh = Math.min(a.x + a.width - 2, b.x + b.width - 2)
  if (columnLow <= columnHigh) {
    const upper = a.y < b.y ? a : b
    const lower = a.y < b.y ? b : a
    const startY = upper.y + upper.height
    const endY = lower.y - 1
    if (endY >= startY) {
      const column = columnLow + random.int(columnHigh - columnLow + 1)
      const path: Array<{ x: number; y: number }> = []
      for (let y = startY; y <= endY; y += 1) path.push({ x: column, y })
      candidates.push(path)
    }
  }

  // Straight horizontal run where interior rows face each other.
  const rowLow = Math.max(a.y + 1, b.y + 1)
  const rowHigh = Math.min(a.y + a.height - 2, b.y + b.height - 2)
  if (rowLow <= rowHigh) {
    const left = a.x < b.x ? a : b
    const right = a.x < b.x ? b : a
    const startX = left.x + left.width
    const endX = right.x - 1
    if (endX >= startX) {
      const row = rowLow + random.int(rowHigh - rowLow + 1)
      const path: Array<{ x: number; y: number }> = []
      for (let x = startX; x <= endX; x += 1) path.push({ x, y: row })
      candidates.push(path)
    }
  }

  // One L-bend between offset loops: leave a's facing side at mid-height,
  // run to b's centre column, turn, and meet b's facing side. Both legs must
  // actually point toward their target or the bend is geometrically invalid.
  if (candidates.length === 0) {
    const aMidY = a.y + 1 + Math.floor((a.height - 2) / 2)
    const bMidX = b.x + 1 + Math.floor((b.width - 2) / 2)
    const horizontalStep = bMidX >= a.x + a.width ? 1 : -1
    const startX = horizontalStep > 0 ? a.x + a.width : a.x - 1
    const verticalStep = aMidY < b.y ? 1 : -1
    const endY = verticalStep > 0 ? b.y - 1 : b.y + b.height
    if ((bMidX - startX) * horizontalStep >= 0 && (endY - aMidY) * verticalStep >= 0) {
      const path: Array<{ x: number; y: number }> = []
      for (let x = startX; x !== bMidX && path.length <= 24; x += horizontalStep) {
        path.push({ x, y: aMidY })
      }
      for (let y = aMidY; (verticalStep > 0 ? y <= endY : y >= endY) && path.length <= 48; y += verticalStep) {
        path.push({ x: bMidX, y })
      }
      candidates.push(path)
    }
  }

  for (const path of candidates) {
    if (path.length === 0 || path.length > 9) continue
    const valid = path.every(cell => cell.x >= 1 && cell.y >= 1
      && cell.x <= MAP_SIZE - 2 && cell.y <= MAP_SIZE - 2
      && !cells.has(key(cell.x, cell.y))
      && !insideAnyLoop(loops, cell.x, cell.y))
    const distinct = new Set(path.map(cell => key(cell.x, cell.y))).size === path.length
    if (valid && distinct) return path
  }
  return null
}

interface SubdivisionRun {
  cells: Array<{ x: number; y: number }>
}

/**
 * Full internal dividing walls across a loop's interior — sealed CoC-style
 * compartments (breach lanes are reserved later, per compartment).
 */
function planSubdivisions(
  seed: number,
  profile: DifficultyProfile,
  loops: readonly LoopRect[],
  cells: Map<string, { x: number; y: number; level: number }>
): SubdivisionRun[] {
  if (profile.maxSubdivisions === 0) return []
  const random = streamFor(seed, SUBDIVISION_SALT)
  const runs: SubdivisionRun[] = []
  const ranked = [...loops].sort((a, b) => b.width * b.height - a.width * a.height)
  for (const loop of ranked) {
    if (runs.length >= profile.maxSubdivisions) break
    const interiorWidth = loop.width - 2
    const interiorHeight = loop.height - 2
    const axes: Array<'vertical' | 'horizontal'> = []
    if (interiorWidth >= 8 && interiorHeight >= 4) axes.push('vertical')
    if (interiorHeight >= 8 && interiorWidth >= 4) axes.push('horizontal')
    if (axes.length === 0) continue
    if (random.int(1_000) >= profile.subdivisionChance) continue
    // Prefer splitting the longer interior axis; a second run (big keeps on
    // fortress/extreme) crosses perpendicular for a four-cell quarter split.
    axes.sort((left, right) => {
      const leftSpan = left === 'vertical' ? interiorWidth : interiorHeight
      const rightSpan = right === 'vertical' ? interiorWidth : interiorHeight
      return rightSpan - leftSpan
    })
    for (const axis of axes) {
      if (runs.length >= profile.maxSubdivisions) break
      if (cellsAfter(cells, loop, axis) > BUILDING_DEFINITIONS.wall.maxCount) continue
      // Split offset stays in [3, span-4]: both cells keep >=3 tiles of width
      // and one keeps >=4, which the town-hall relax chain relies on.
      const run: SubdivisionRun = { cells: [] }
      if (axis === 'vertical') {
        const offset = clamp(Math.floor(interiorWidth / 2) + random.int(3) - 1, 3, interiorWidth - 4)
        const column = loop.x + 1 + offset
        for (let y = loop.y + 1; y <= loop.y + loop.height - 2; y += 1) {
          run.cells.push({ x: column, y })
        }
      } else {
        const offset = clamp(Math.floor(interiorHeight / 2) + random.int(3) - 1, 3, interiorHeight - 4)
        const row = loop.y + 1 + offset
        for (let x = loop.x + 1; x <= loop.x + loop.width - 2; x += 1) {
          run.cells.push({ x, y: row })
        }
      }
      let added = 0
      for (const cell of run.cells) {
        const cellKey = key(cell.x, cell.y)
        if (cells.has(cellKey)) continue
        cells.set(cellKey, { ...cell, level: loop.level })
        added += 1
      }
      if (added > 0) runs.push(run)
      if (runs.length >= profile.maxSubdivisions || random.int(1_000) >= profile.subdivisionChance) break
    }
  }
  return runs
}

function cellsAfter(
  cells: ReadonlyMap<string, unknown>,
  loop: Rect,
  axis: 'vertical' | 'horizontal'
): number {
  const span = axis === 'vertical' ? loop.height - 2 : loop.width - 2
  return cells.size + span
}

/**
 * One deliberate gate per loop — a wall cell whose inside and outside tiles
 * stay clear so the entrance reads as an entrance.
 */
function planGates(
  seed: number,
  loops: readonly LoopRect[],
  cells: ReadonlyMap<string, { x: number; y: number; level: number }>
): Lane[] {
  const lanes: Lane[] = []
  loops.forEach((loop, loopIndex) => {
    const perimeter = new Set(perimeterOf(loop).map(cell => key(cell.x, cell.y)))
    const candidates: Lane[] = []
    for (let offset = 1; offset < loop.width - 1; offset += 1) {
      const x = loop.x + offset
      candidates.push({ wallX: x, wallY: loop.y, sideAX: x, sideAY: loop.y - 1, sideBX: x, sideBY: loop.y + 1 })
      candidates.push({
        wallX: x,
        wallY: loop.y + loop.height - 1,
        sideAX: x,
        sideAY: loop.y + loop.height,
        sideBX: x,
        sideBY: loop.y + loop.height - 2
      })
    }
    for (let offset = 1; offset < loop.height - 1; offset += 1) {
      const y = loop.y + offset
      candidates.push({ wallX: loop.x, wallY: y, sideAX: loop.x - 1, sideAY: y, sideBX: loop.x + 1, sideBY: y })
      candidates.push({
        wallX: loop.x + loop.width - 1,
        wallY: y,
        sideAX: loop.x + loop.width,
        sideAY: y,
        sideBX: loop.x + loop.width - 2,
        sideBY: y
      })
    }
    const junctionFree = candidates.filter(lane => {
      const neighbors = [
        [lane.wallX - 1, lane.wallY],
        [lane.wallX + 1, lane.wallY],
        [lane.wallX, lane.wallY - 1],
        [lane.wallX, lane.wallY + 1]
      ] as const
      // Reject gate cells touching curtain runs or internal walls: openings
      // belong on clean stretches of the enceinte.
      return neighbors.every(([nx, ny]) => !cells.has(key(nx, ny)) || perimeter.has(key(nx, ny)))
    })
    const pool = junctionFree.length > 0 ? junctionFree : candidates
    pool.sort((left, right) => {
      const leftScore = distanceToBoundary(left.sideAX, left.sideAY) * 10_000
        + (mix32(seed ^ GATE_SALT ^ Math.imul(loopIndex + 1, 0x9e37_79b9)
          ^ Math.imul(left.wallX + 1, 131) ^ (left.wallY + 1)) % 10_000)
      const rightScore = distanceToBoundary(right.sideAX, right.sideAY) * 10_000
        + (mix32(seed ^ GATE_SALT ^ Math.imul(loopIndex + 1, 0x9e37_79b9)
          ^ Math.imul(right.wallX + 1, 131) ^ (right.wallY + 1)) % 10_000)
      return leftScore - rightScore || left.wallY - right.wallY || left.wallX - right.wallX
    })
    lanes.push(pool[0])
  })
  return lanes
}

interface CompartmentScan {
  compartments: Compartment[]
  tileCompartment: Int16Array
}

/**
 * Compartments are DERIVED from the finished wall geometry by flood fill, so
 * loop interiors, subdivided cells and curtain-wall courtyards all emerge
 * uniformly instead of being book-kept per feature.
 */
function scanCompartments(cells: ReadonlyMap<string, unknown>): CompartmentScan {
  const tileCompartment = new Int16Array(MAP_SIZE * MAP_SIZE).fill(-1)
  const visited = new Uint8Array(MAP_SIZE * MAP_SIZE)
  const queue = new Int32Array(MAP_SIZE * MAP_SIZE)

  const flood = (startX: number, startY: number, mark: number): Array<{ x: number; y: number }> => {
    const tiles: Array<{ x: number; y: number }> = []
    let head = 0
    let tail = 0
    const startIndex = startY * MAP_SIZE + startX
    visited[startIndex] = 1
    queue[tail++] = startIndex
    while (head < tail) {
      const index = queue[head++]
      const x = index % MAP_SIZE
      const y = Math.floor(index / MAP_SIZE)
      tiles.push({ x, y })
      if (mark >= 0) tileCompartment[index] = mark
      const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue
        const neighborIndex = ny * MAP_SIZE + nx
        if (visited[neighborIndex] || cells.has(key(nx, ny))) continue
        visited[neighborIndex] = 1
        queue[tail++] = neighborIndex
      }
    }
    return tiles
  }

  for (const cellKey of cells.keys()) {
    const [x, y] = cellKey.split(',').map(Number)
    visited[y * MAP_SIZE + x] = 1
  }
  flood(0, 0, -1) // exterior — the border ring is always clear

  const compartments: Compartment[] = []
  for (let y = 1; y < MAP_SIZE - 1; y += 1) {
    for (let x = 1; x < MAP_SIZE - 1; x += 1) {
      if (visited[y * MAP_SIZE + x]) continue
      const tiles = flood(x, y, compartments.length)
      let sumX = 0
      let sumY = 0
      for (const tile of tiles) {
        sumX += tile.x
        sumY += tile.y
      }
      compartments.push({
        tiles: new Set(tiles.map(tile => key(tile.x, tile.y))),
        area: tiles.length,
        centroidX: sumX / tiles.length,
        centroidY: sumY / tiles.length,
        defenses: 0,
        storages: 0
      })
    }
  }
  return { compartments, tileCompartment }
}

/**
 * Every sealed compartment gets one reserved breach lane — a boundary wall
 * cell kept clear on both sides so attacks always have a way through.
 * Gate lanes count; internal dividing walls are preferred for the rest.
 */
function ensureBreachLanes(
  cells: ReadonlyMap<string, { x: number; y: number; level: number }>,
  scan: CompartmentScan,
  lanes: Lane[]
): void {
  const laneServed = new Set<number>()
  for (const lane of lanes) {
    for (const [sx, sy] of [[lane.sideAX, lane.sideAY], [lane.sideBX, lane.sideBY]] as const) {
      if (sx < 0 || sy < 0 || sx >= MAP_SIZE || sy >= MAP_SIZE) continue
      const compartment = scan.tileCompartment[sy * MAP_SIZE + sx]
      if (compartment >= 0) laneServed.add(compartment)
    }
  }
  scan.compartments.forEach((compartment, index) => {
    if (laneServed.has(index)) return
    let best: Lane | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const tileKey of compartment.tiles) {
      const [tx, ty] = tileKey.split(',').map(Number)
      const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
      for (const [dx, dy] of directions) {
        const wallX = tx + dx
        const wallY = ty + dy
        if (!cells.has(key(wallX, wallY))) continue
        const outX = wallX + dx
        const outY = wallY + dy
        if (outX < 0 || outY < 0 || outX >= MAP_SIZE || outY >= MAP_SIZE) continue
        if (cells.has(key(outX, outY))) continue
        const otherSide = scan.tileCompartment[outY * MAP_SIZE + outX]
        // Prefer lanes into a neighbouring compartment (internal walls),
        // then lanes to the exterior; deterministic ordering.
        const score = (otherSide >= 0 ? 0 : 100_000) + wallY * 100 + wallX
        if (score < bestScore) {
          bestScore = score
          best = { wallX, wallY, sideAX: tx, sideAY: ty, sideBX: outX, sideBY: outY }
        }
      }
    }
    if (best) {
      lanes.push(best)
      laneServed.add(index)
      const otherSide = scan.tileCompartment[best.sideBY * MAP_SIZE + best.sideBX]
      if (otherSide >= 0) laneServed.add(otherSide)
    }
  })
}

function planWalls(seed: number, profile: DifficultyProfile): WallPlan {
  // Roll the format up front so RNG consumption stays stable per seed:
  // concentric enceinte > ward-closed circuit > tree curtains.
  const modeRandom = streamFor(seed, WARD_SALT)
  const rollConcentric = modeRandom.int(1_000) < profile.concentricChance
  const rollWard = modeRandom.int(1_000) < profile.wardChance
  let loops: LoopRect[] | null = null
  let concentric = false
  if (rollConcentric) {
    loops = planConcentric(seed, profile)
    concentric = loops !== null
  }
  if (!loops) loops = planLoops(seed, profile, rollWard ? 10 : 0)
  const cells = new Map<string, { x: number; y: number; level: number }>()
  for (const loop of loops) {
    for (const cell of perimeterOf(loop)) {
      cells.set(key(cell.x, cell.y), { ...cell, level: loop.level })
    }
  }
  if (!concentric) {
    if (rollWard && loops.length >= 2) planWardConnectors(seed, loops, cells)
    else planConnectors(seed, profile, loops, cells)
  }
  // A concentric enceinte never gets sliced — internal walls belong to keeps.
  planSubdivisions(seed, profile, concentric ? [loops[0]] : loops, cells)
  const lanes = planGates(seed, loops, cells)
  return { cells, loops, lanes }
}

function wallBuildings(seedHex: string, plan: WallPlan): SerializedBuilding[] {
  const cells = [...plan.cells.values()]
  cells.sort((a, b) => a.y - b.y || a.x - b.x)
  if (cells.length > BUILDING_DEFINITIONS.wall.maxCount) {
    throw new Error(`procedural village wall plan exceeds catalog cap: ${cells.length}`)
  }
  return cells.map((cell, index) => ({
    id: `pv-${seedHex}-wall-${index}`,
    type: 'wall',
    gridX: cell.x,
    gridY: cell.y,
    level: cell.level
  }))
}

function footprintKeys(x: number, y: number, width: number, height: number): string[] {
  const result: string[] = []
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) result.push(key(x + dx, y + dy))
  }
  return result
}

function navigationIsConnected(
  occupied: ReadonlySet<string>,
  passableWalls: ReadonlySet<string>,
  buildings: readonly SerializedBuilding[]
): boolean {
  const visited = new Uint8Array(MAP_SIZE * MAP_SIZE)
  const queue = new Int16Array(MAP_SIZE * MAP_SIZE)
  let head = 0
  let tail = 0
  const start = 0
  const isBlocked = (x: number, y: number) => {
    const tile = key(x, y)
    return occupied.has(tile) && !passableWalls.has(tile)
  }
  if (isBlocked(0, 0)) return false
  visited[start] = 1
  queue[tail++] = start
  while (head < tail) {
    const index = queue[head++]
    const x = index % MAP_SIZE
    const y = Math.floor(index / MAP_SIZE)
    const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const
    for (const [nextX, nextY] of neighbors) {
      if (nextX < 0 || nextY < 0 || nextX >= MAP_SIZE || nextY >= MAP_SIZE) continue
      const nextIndex = nextY * MAP_SIZE + nextX
      if (visited[nextIndex] || isBlocked(nextX, nextY)) continue
      visited[nextIndex] = 1
      queue[tail++] = nextIndex
    }
  }
  let hardBlockers = 0
  for (const tile of occupied) if (!passableWalls.has(tile)) hardBlockers += 1
  if (tail !== MAP_SIZE * MAP_SIZE - hardBlockers) return false
  for (const building of buildings) {
    const definition = BUILDING_DEFINITIONS[building.type]
    let approachable = false
    for (let x = building.gridX; x < building.gridX + definition.width; x += 1) {
      const above = building.gridY - 1
      const below = building.gridY + definition.height
      if (above >= 0 && visited[above * MAP_SIZE + x]) approachable = true
      if (below < MAP_SIZE && visited[below * MAP_SIZE + x]) approachable = true
    }
    for (let y = building.gridY; y < building.gridY + definition.height; y += 1) {
      const left = building.gridX - 1
      const right = building.gridX + definition.width
      if (left >= 0 && visited[y * MAP_SIZE + left]) approachable = true
      if (right < MAP_SIZE && visited[y * MAP_SIZE + right]) approachable = true
    }
    if (!approachable) return false
  }
  return true
}

function levelFor(
  seed: number,
  profile: DifficultyProfile,
  type: NonWallBuildingType,
  ordinal: number
): number {
  const definition = BUILDING_DEFINITIONS[type]
  const maximum = definition.maxLevel ?? 1
  if (maximum <= 1) return 1
  if (definition.category === 'defense') {
    const offset = mix32(seed ^ LEVEL_SALT ^ hashText(type)) % profile.defenseLevelFractions.length
    const fraction = profile.defenseLevelFractions[(offset + ordinal * 2) % profile.defenseLevelFractions.length]
    return 1 + Math.floor(((maximum - 1) * fraction + 500) / 1_000)
  }
  const supportOffsets = [-150, -50, 35, 100] as const
  const offset = mix32(seed ^ LEVEL_SALT ^ hashText(type) ^ Math.imul(ordinal + 1, 0x9e37_79b9)) % supportOffsets.length
  const fraction = clamp(profile.supportLevelPower + supportOffsets[offset], 0, 1_000)
  return 1 + Math.floor(((maximum - 1) * fraction + 500) / 1_000)
}

function defenseRangesFor(type: NonWallBuildingType, level: number): { range: number; minRange: number } {
  const definition = BUILDING_DEFINITIONS[type]
  const stats = definition.levels?.[level - 1]
  return {
    range: stats?.range ?? definition.range ?? 0,
    minRange: definition.minRange ?? 0
  }
}

function footprintCompartment(
  state: PlacementState,
  x: number,
  y: number,
  width: number,
  height: number
): number {
  const first = state.tileCompartment[y * MAP_SIZE + x]
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      if (state.tileCompartment[(y + dy) * MAP_SIZE + (x + dx)] !== first) return -1
    }
  }
  return first
}

function coverageGain(
  state: PlacementState,
  centerX: number,
  centerY: number,
  range: number,
  minRange: number
): number {
  let gain = 0
  for (let index = 0; index < state.approachBand.length; index += 1) {
    const tile = state.approachBand[index]
    const dx = tile.x + 0.5 - centerX
    const dy = tile.y + 0.5 - centerY
    const distance = Math.sqrt(dx * dx + dy * dy)
    if (distance > range || distance < minRange) continue
    const count = state.coverCount[index]
    gain += count === 0 ? 3 : count === 1 ? 1 : 0
  }
  return gain
}

function recordCoverage(
  state: PlacementState,
  centerX: number,
  centerY: number,
  range: number,
  minRange: number
): void {
  for (let index = 0; index < state.approachBand.length; index += 1) {
    const tile = state.approachBand[index]
    const dx = tile.x + 0.5 - centerX
    const dy = tile.y + 0.5 - centerY
    const distance = Math.sqrt(dx * dx + dy * dy)
    if (distance > range || distance < minRange) continue
    if (state.coverCount[index] < 255) state.coverCount[index] += 1
  }
}

const SKIRT_TYPES: ReadonlySet<NonWallBuildingType> = new Set(SKIRT_ORDER)

function placementScore(
  seed: number,
  profile: DifficultyProfile,
  instance: BuildingInstance,
  level: number,
  state: PlacementState,
  x: number,
  y: number
): number {
  const definition = BUILDING_DEFINITIONS[instance.type]
  const compartment = footprintCompartment(state, x, y, definition.width, definition.height)
  let score = mix32(seed ^ PLACEMENT_SALT ^ hashText(instance.type)
    ^ Math.imul(instance.ordinal + 1, 0x9e37_79b9)
    ^ Math.imul(x + 1, 0x85eb_ca6b)
    ^ Math.imul(y + 1, 0xc2b2_ae35)) % profile.placementJitter

  const centerX = x + definition.width / 2
  const centerY = y + definition.height / 2

  if (instance.type === 'town_hall') {
    score += compartment >= 0 ? (compartment === state.coreCompartment ? -80_000 : -50_000) : 20_000
  } else if (definition.category === 'defense') {
    if (compartment >= 0) {
      score -= 35_000
      if (compartment === state.coreCompartment
        && (instance.type === 'dragons_breath' || instance.type === 'prism' || instance.type === 'tesla')) {
        score -= 10_000
      }
      if (compartment === instance.preferredCompartment) score -= 12_000
    } else {
      score += 6_000
    }
    const ranges = defenseRangesFor(instance.type, level)
    score -= coverageGain(state, centerX, centerY, ranges.range, ranges.minRange) * profile.coverageWeight
  } else if (SKIRT_TYPES.has(instance.type)) {
    // The skirt: hug the walls from the outside, spaced around the complex,
    // denying clean wall-adjacent deployment the way CoC bases do.
    if (compartment >= 0) {
      score += state.compartments[compartment].defenses > 0 ? 14_000 : 60_000
    } else {
      let nearest = Number.POSITIVE_INFINITY
      for (const cellKey of footprintKeys(x, y, definition.width, definition.height)) {
        const [cx, cy] = cellKey.split(',').map(Number)
        nearest = Math.min(nearest, state.wallDistance[cy * MAP_SIZE + cx])
      }
      if (nearest >= 1 && nearest <= 3) score += -22_000 - (3 - nearest) * 800
      else score += Math.min(8_000, nearest * 600)
      const angle = Math.atan2(centerY - state.centroidY, centerX - state.centroidX)
      let minimumDelta = Number.POSITIVE_INFINITY
      for (const placedAngle of state.skirtAngles) {
        const delta = Math.abs(Math.atan2(Math.sin(angle - placedAngle), Math.cos(angle - placedAngle)))
        minimumDelta = Math.min(minimumDelta, delta)
      }
      if (Number.isFinite(minimumDelta)) score -= Math.min(minimumDelta, 1.2) * 9_000
    }
  } else {
    // Storages and the lab shelter inside, but only in compartments that
    // already have a defender — never in an unguarded pocket. (They place
    // after every defense, so guarded compartments are all established.)
    if (compartment >= 0) {
      const guarded = state.compartments[compartment].defenses > 0
      if (guarded) {
        score -= instance.type === 'storage' ? 28_000 : 10_000
        if (instance.type === 'storage' && state.compartments[compartment].storages === 0) score -= 6_000
      } else {
        score += 50_000
      }
    } else if (instance.type === 'storage') {
      score += 4_000
    }
  }
  return score
}

function placeBuilding(
  seed: number,
  seedHex: string,
  profile: DifficultyProfile,
  state: PlacementState,
  instance: BuildingInstance,
  requiredCompartment: number | null = null
): SerializedBuilding {
  const definition = BUILDING_DEFINITIONS[instance.type]
  const level = levelFor(seed, profile, instance.type, instance.ordinal)
  const candidates: PlacementCandidate[] = []
  for (let y = 1; y + definition.height <= MAP_SIZE - 1; y += 1) {
    for (let x = 1; x + definition.width <= MAP_SIZE - 1; x += 1) {
      const cells = footprintKeys(x, y, definition.width, definition.height)
      if (cells.some(cell => state.occupied.has(cell) || state.reserved.has(cell))) continue
      if (requiredCompartment !== null
        && footprintCompartment(state, x, y, definition.width, definition.height) !== requiredCompartment) continue
      candidates.push({
        x,
        y,
        score: placementScore(seed, profile, instance, level, state, x, y)
      })
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x)
  for (const candidate of candidates) {
    const cells = footprintKeys(candidate.x, candidate.y, definition.width, definition.height)
    for (const cell of cells) state.occupied.add(cell)
    const building: SerializedBuilding = {
      id: `pv-${seedHex}-${instance.type}-${instance.ordinal}`,
      type: instance.type,
      gridX: candidate.x,
      gridY: candidate.y,
      level
    }
    state.buildings.push(building)
    if (navigationIsConnected(state.occupied, state.passableWalls, state.buildings)) {
      const compartment = footprintCompartment(
        state, candidate.x, candidate.y, definition.width, definition.height
      )
      if (definition.category === 'defense') {
        if (compartment >= 0) state.compartments[compartment].defenses += 1
        const ranges = defenseRangesFor(instance.type, level)
        recordCoverage(
          state,
          candidate.x + definition.width / 2,
          candidate.y + definition.height / 2,
          ranges.range,
          ranges.minRange
        )
      }
      if (instance.type === 'storage' && compartment >= 0) {
        state.compartments[compartment].storages += 1
      }
      if (SKIRT_TYPES.has(instance.type) && compartment < 0) {
        state.skirtAngles.push(Math.atan2(
          candidate.y + definition.height / 2 - state.centroidY,
          candidate.x + definition.width / 2 - state.centroidX
        ))
      }
      return building
    }
    state.buildings.pop()
    for (const cell of cells) state.occupied.delete(cell)
  }
  if (requiredCompartment !== null) {
    return placeBuilding(seed, seedHex, profile, state, instance, null)
  }
  throw new Error(`unable to place ${instance.type} ${instance.ordinal} for procedural village seed ${seed}`)
}

function coreCompartmentIndex(compartments: readonly Compartment[], loops: readonly LoopRect[]): number {
  // The town hall belongs in a KEEP yard, never in a baiting ward. Yards are
  // bounded by one loop's walls; wards (ring gaps, curtain courtyards,
  // corridor baileys) touch the perimeters of two or more loops.
  const perimeterOwner = new Map<string, number>()
  loops.forEach((loop, index) => {
    for (const cell of perimeterOf(loop)) perimeterOwner.set(key(cell.x, cell.y), index)
  })
  const loopsTouched = (compartment: Compartment): number => {
    const owners = new Set<number>()
    for (const tile of compartment.tiles) {
      const [x, y] = tile.split(',').map(Number)
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        const owner = perimeterOwner.get(key(nx, ny))
        if (owner !== undefined) owners.add(owner)
      }
    }
    return owners.size
  }
  const yardIndices = compartments
    .map((compartment, index) => ({ compartment, index }))
    .filter(entry => loopsTouched(entry.compartment) <= 1)
  const pool = yardIndices.length > 0
    ? yardIndices
    : compartments.map((compartment, index) => ({ compartment, index }))
  let bestIndex = pool[0]?.index ?? 0
  let bestScore = Number.NEGATIVE_INFINITY
  const center = (MAP_SIZE - 1) / 2
  for (const { compartment, index } of pool) {
    const centerDistance = Math.abs(compartment.centroidX - center) + Math.abs(compartment.centroidY - center)
    const score = compartment.area * 2 - centerDistance * 3
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  }
  return bestIndex
}

function desiredCount(profile: DifficultyProfile, type: NonWallBuildingType): number {
  return profile.roster[type] ?? 0
}

function buildPlacementState(
  plan: WallPlan,
  scan: CompartmentScan,
  walls: readonly SerializedBuilding[],
  reserved: ReadonlySet<string>
): PlacementState {
  const passableWalls = new Set(walls.map(wall => key(wall.gridX, wall.gridY)))
  const occupied = new Set(passableWalls)

  // Chebyshev distance to the nearest wall cell (8-direction BFS).
  const wallDistance = new Uint8Array(MAP_SIZE * MAP_SIZE).fill(255)
  const queue = new Int32Array(MAP_SIZE * MAP_SIZE)
  let head = 0
  let tail = 0
  for (const cell of plan.cells.values()) {
    const index = cell.y * MAP_SIZE + cell.x
    wallDistance[index] = 0
    queue[tail++] = index
  }
  while (head < tail) {
    const index = queue[head++]
    const x = index % MAP_SIZE
    const y = Math.floor(index / MAP_SIZE)
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue
        const neighborIndex = ny * MAP_SIZE + nx
        if (wallDistance[neighborIndex] <= wallDistance[index] + 1) continue
        wallDistance[neighborIndex] = wallDistance[index] + 1
        queue[tail++] = neighborIndex
      }
    }
  }

  const approachBand: Array<{ x: number; y: number }> = []
  for (let y = 0; y < MAP_SIZE; y += 1) {
    for (let x = 0; x < MAP_SIZE; x += 1) {
      const index = y * MAP_SIZE + x
      if (scan.tileCompartment[index] >= 0) continue
      if (plan.cells.has(key(x, y))) continue
      if (wallDistance[index] >= 1 && wallDistance[index] <= 2) approachBand.push({ x, y })
    }
  }

  let centroidX = (MAP_SIZE - 1) / 2
  let centroidY = (MAP_SIZE - 1) / 2
  if (plan.cells.size > 0) {
    let sumX = 0
    let sumY = 0
    for (const cell of plan.cells.values()) {
      sumX += cell.x
      sumY += cell.y
    }
    centroidX = sumX / plan.cells.size
    centroidY = sumY / plan.cells.size
  }

  return {
    occupied,
    passableWalls,
    reserved,
    buildings: [],
    compartments: scan.compartments,
    coreCompartment: coreCompartmentIndex(scan.compartments, plan.loops),
    tileCompartment: scan.tileCompartment,
    wallDistance,
    approachBand,
    coverCount: new Uint8Array(approachBand.length),
    centroidX,
    centroidY,
    skirtAngles: []
  }
}

function populateBuildings(
  seed: number,
  seedHex: string,
  profile: DifficultyProfile,
  state: PlacementState,
  walls: readonly SerializedBuilding[]
): SerializedBuilding[] {
  const ordinals = new Map<NonWallBuildingType, number>()
  const nextInstance = (type: NonWallBuildingType, preferredCompartment: number): BuildingInstance => {
    const ordinal = ordinals.get(type) ?? 0
    ordinals.set(type, ordinal + 1)
    return { type, ordinal, preferredCompartment }
  }
  const compartmentCount = Math.max(1, state.compartments.length)
  const ranked = state.compartments
    .map((compartment, index) => ({ index, area: compartment.area }))
    .sort((a, b) => b.area - a.area || a.index - b.index)
    .map(entry => entry.index)

  placeBuilding(seed, seedHex, profile, state, nextInstance('town_hall', state.coreCompartment), state.coreCompartment)

  // The keep is never left unguarded: the first cannon garrisons the core so
  // storages and the town hall always sit behind at least one defense.
  if (desiredCount(profile, 'cannon') > 0) {
    placeBuilding(seed, seedHex, profile, state, nextInstance('cannon', state.coreCompartment), state.coreCompartment)
  }

  for (const type of DEFENSE_ORDER) {
    const count = desiredCount(profile, type)
    const alreadyPlaced = ordinals.get(type) ?? 0
    const typeOffset = mix32(seed ^ hashText(type)) % compartmentCount
    for (let ordinal = alreadyPlaced; ordinal < count; ordinal += 1) {
      const preferred = ranked.length > 0
        ? ranked[(typeOffset + ordinal) % ranked.length]
        : 0
      placeBuilding(seed, seedHex, profile, state, nextInstance(type, preferred))
    }
  }

  for (const type of ['storage', 'lab'] as const) {
    const count = desiredCount(profile, type)
    for (let ordinal = ordinals.get(type) ?? 0; ordinal < count; ordinal += 1) {
      placeBuilding(seed, seedHex, profile, state, nextInstance(type, state.coreCompartment))
    }
  }

  for (const type of SKIRT_ORDER) {
    const count = desiredCount(profile, type)
    for (let ordinal = ordinals.get(type) ?? 0; ordinal < count; ordinal += 1) {
      placeBuilding(seed, seedHex, profile, state, nextInstance(type, -1))
    }
  }
  return [...walls, ...state.buildings]
}

function placeObstacles(
  seed: number,
  seedHex: string,
  targetCount: number,
  tileCompartment: Int16Array,
  reserved: ReadonlySet<string>,
  buildings: readonly SerializedBuilding[]
): SerializedObstacle[] {
  const occupied = new Set<string>()
  const passableWalls = new Set<string>()
  const approachableBuildings = buildings.filter(building => building.type !== 'wall')
  for (const building of buildings) {
    const definition = BUILDING_DEFINITIONS[building.type]
    for (const cell of footprintKeys(building.gridX, building.gridY, definition.width, definition.height)) occupied.add(cell)
    if (building.type === 'wall') passableWalls.add(key(building.gridX, building.gridY))
  }
  const random = streamFor(seed, OBSTACLE_SALT)
  const obstacles: SerializedObstacle[] = []
  for (let index = 0; index < targetCount; index += 1) {
    const preferredType = OBSTACLE_PALETTE[random.int(OBSTACLE_PALETTE.length)]
    const attempts: readonly ObstacleType[] = preferredType === 'grass_patch'
      ? [preferredType]
      : [preferredType, 'grass_patch']
    let placed = false
    for (const type of attempts) {
      const definition = OBSTACLE_DEFINITIONS[type]
      const candidates: PlacementCandidate[] = []
      for (let y = 1; y + definition.height <= MAP_SIZE - 1; y += 1) {
        for (let x = 1; x + definition.width <= MAP_SIZE - 1; x += 1) {
          const cells = footprintKeys(x, y, definition.width, definition.height)
          if (cells.some(cell => occupied.has(cell) || reserved.has(cell))) continue
          let insideCompartment = false
          for (let dy = 0; dy < definition.height && !insideCompartment; dy += 1) {
            for (let dx = 0; dx < definition.width; dx += 1) {
              if (tileCompartment[(y + dy) * MAP_SIZE + (x + dx)] >= 0) {
                insideCompartment = true
                break
              }
            }
          }
          const edgeDistance = distanceToBoundary(x, y)
          const score = (insideCompartment ? 40_000 : 0)
            + edgeDistance * 1_200
            + (mix32(seed ^ OBSTACLE_SALT ^ Math.imul(index + 1, 0x9e37_79b9)
              ^ hashText(type) ^ Math.imul(x + 1, 131) ^ (y + 1)) % 10_000)
          candidates.push({ x, y, score })
        }
      }
      candidates.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x)
      for (const candidate of candidates) {
        const cells = footprintKeys(candidate.x, candidate.y, definition.width, definition.height)
        for (const cell of cells) occupied.add(cell)
        if (navigationIsConnected(occupied, passableWalls, approachableBuildings)) {
          obstacles.push({
            id: `pv-${seedHex}-obstacle-${index}`,
            type,
            gridX: candidate.x,
            gridY: candidate.y
          })
          placed = true
          break
        }
        for (const cell of cells) occupied.delete(cell)
      }
      if (placed) break
    }
    if (!placed) break
  }
  return obstacles
}

function reservedTiles(lanes: readonly Lane[]): Set<string> {
  const reserved = new Set<string>()
  for (let coordinate = 0; coordinate < MAP_SIZE; coordinate += 1) {
    reserved.add(key(coordinate, 0))
    reserved.add(key(coordinate, MAP_SIZE - 1))
    reserved.add(key(0, coordinate))
    reserved.add(key(MAP_SIZE - 1, coordinate))
  }
  for (const lane of lanes) {
    reserved.add(key(lane.wallX, lane.wallY))
    reserved.add(key(lane.sideAX, lane.sideAY))
    reserved.add(key(lane.sideBX, lane.sideBY))
  }
  return reserved
}

function generatedUsername(seed: number): string {
  const random = streamFor(seed, NAME_SALT)
  return `${ADJECTIVES[random.int(ADJECTIVES.length)]} ${NOUNS[random.int(NOUNS.length)]}`
}

function fractionInRange(seed: number, salt: number, range: readonly [number, number]): number {
  return range[0] + (mix32(seed ^ salt) % (range[1] - range[0] + 1))
}

export function generateProceduralVillage(seed: number, options: ProceduralVillageOptions = {}): SerializedWorld {
  const normalized = normalizeSeed(seed)
  const seedHex = normalized.toString(16).padStart(8, '0')
  const difficulty = options.difficulty ?? difficultyOfNormalizedSeed(normalized)
  const profile = DIFFICULTY_PROFILES[difficulty]
  const plan = planWalls(normalized, profile)
  const walls = wallBuildings(seedHex, plan)
  const scan = scanCompartments(plan.cells)
  ensureBreachLanes(plan.cells, scan, plan.lanes)
  const reserved = reservedTiles(plan.lanes)
  const state = buildPlacementState(plan, scan, walls, reserved)
  const buildings = populateBuildings(normalized, seedHex, profile, state, walls)
  const obstacles = placeObstacles(
    normalized,
    seedHex,
    profile.obstacleCount,
    state.tileCompartment,
    reserved,
    buildings
  )
  buildings.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  obstacles.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

  const storage = resourceCapacity(buildings)
  const stockFraction = fractionInRange(normalized, RESOURCE_SALT, profile.stockFraction)
  const capacity = populationCapacity(buildings)
  const populationCount = Math.max(1, Math.floor(capacity * profile.populationFraction / 1_000))
  const workerCount = workersNeeded(buildings)
  const worldId = options.id ?? `bot-${seedHex}`
  const ownerId = options.ownerId ?? `bot-${seedHex}`
  const lifeIdentity = `pv${PROCEDURAL_VILLAGE_GENERATOR_VERSION}:${ownerId}`

  return {
    id: worldId,
    ownerId,
    username: options.username ?? generatedUsername(normalized),
    buildings,
    obstacles,
    resources: {
      gold: fractionInRange(normalized, RESOURCE_SALT ^ 0xa5a5_a5a5, profile.gold),
      ore: Math.floor(storage.ore * stockFraction / 1_000),
      food: Math.floor(storage.food * stockFraction / 1_000)
    },
    storage,
    population: {
      count: populationCount,
      capacity,
      workersNeeded: workerCount,
      staffing: staffingFactor(buildings, populationCount),
      bornAt: []
    },
    life: {
      version: 1,
      identity: lifeIdentity,
      population: populationCount,
      bornAt: [],
      simulatedThrough: 0
    },
    banner: {
      palette: mix32(normalized ^ 0x51ed_270b) % 8,
      emblem: mix32(normalized ^ 0x94d0_49bb) % 6,
      pattern: mix32(normalized ^ 0x369d_ea0f) % 5
    },
    army: {},
    stoneMaturity: (mix32(normalized ^ 0x632b_e59b) % 101) / 100,
    trophies: trophiesFor(normalized, difficulty),
    wallLevel: profile.wallLevel,
    lastSaveTime: 0,
    revision: 0
  }
}
