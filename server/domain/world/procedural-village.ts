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

export const PROCEDURAL_VILLAGE_GENERATOR_VERSION = 1

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
  roomCount: 3 | 4
  wallLevel: number
  defenseLevelFractions: readonly [number, number, number, number, number]
  supportLevelPower: number
  populationFraction: number
  obstacleCount: number
  gold: readonly [number, number]
  stockFraction: readonly [number, number]
  roster: Readonly<Partial<Record<NonWallBuildingType, number>>>
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Gate {
  x: number
  y: number
  outsideX: number
  outsideY: number
  insideX: number
  insideY: number
}

interface Room extends Rect {
  gate: Gate
}

interface BuildingInstance {
  type: NonWallBuildingType
  ordinal: number
  preferredRoom: number
}

interface PlacementState {
  occupied: Set<string>
  passableWalls: ReadonlySet<string>
  reserved: ReadonlySet<string>
  rooms: readonly Room[]
  buildings: SerializedBuilding[]
}

interface PlacementCandidate {
  x: number
  y: number
  score: number
}

const DIFFICULTY_PROFILES: Readonly<Record<ProceduralVillageDifficulty, DifficultyProfile>> = {
  established: {
    roomCount: 3,
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
    }
  },
  strong: {
    roomCount: 3,
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
    }
  },
  elite: {
    roomCount: 3,
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
    }
  },
  fortress: {
    roomCount: 4,
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
    }
  },
  extreme: {
    roomCount: 4,
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
    }
  }
}

const TROPHY_RANGES: Readonly<Record<ProceduralVillageDifficulty, readonly [number, number]>> = {
  established: [650, 1_050],
  strong: [1_050, 1_650],
  elite: [1_650, 2_450],
  fortress: [2_450, 3_350],
  extreme: [3_350, 4_500]
}

const THREE_ROOM_TEMPLATES: readonly (readonly Rect[])[] = [
  [
    { x: 1, y: 1, width: 9, height: 9 },
    { x: 15, y: 1, width: 9, height: 9 },
    { x: 8, y: 15, width: 9, height: 9 }
  ],
  [
    { x: 1, y: 2, width: 8, height: 10 },
    { x: 16, y: 1, width: 8, height: 10 },
    { x: 8, y: 14, width: 9, height: 10 }
  ],
  [
    { x: 2, y: 1, width: 9, height: 8 },
    { x: 14, y: 2, width: 9, height: 8 },
    { x: 8, y: 15, width: 9, height: 9 }
  ]
]

const FOUR_ROOM_TEMPLATES: readonly (readonly Rect[])[] = [
  [
    { x: 1, y: 1, width: 7, height: 7 },
    { x: 17, y: 1, width: 7, height: 7 },
    { x: 1, y: 17, width: 7, height: 7 },
    { x: 17, y: 17, width: 7, height: 7 }
  ],
  [
    { x: 1, y: 1, width: 8, height: 6 },
    { x: 16, y: 4, width: 8, height: 6 },
    { x: 1, y: 15, width: 8, height: 6 },
    { x: 16, y: 18, width: 8, height: 6 }
  ],
  [
    { x: 9, y: 8, width: 8, height: 7 },
    { x: 1, y: 1, width: 6, height: 7 },
    { x: 18, y: 1, width: 6, height: 7 },
    { x: 9, y: 17, width: 7, height: 7 }
  ]
]

const ROSTER_ORDER: readonly NonWallBuildingType[] = [
  'dragons_breath',
  'army_camp',
  'farm',
  'ballista',
  'xbow',
  'mortar',
  'spike_launcher',
  'barracks',
  'mystic_barracks',
  'lab',
  'storage',
  'mine',
  'watchtower',
  'cannon',
  'tesla',
  'prism',
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

function transformRect(rect: Rect, quarterTurns: number, reflect: boolean): Rect {
  let transformed = { ...rect }
  for (let turn = 0; turn < quarterTurns; turn += 1) {
    transformed = {
      x: MAP_SIZE - transformed.y - transformed.height,
      y: transformed.x,
      width: transformed.height,
      height: transformed.width
    }
  }
  if (reflect) {
    transformed.x = MAP_SIZE - transformed.x - transformed.width
  }
  return transformed
}

function roomsHaveAisles(rects: readonly Rect[]): boolean {
  for (const rect of rects) {
    if (rect.x < 1 || rect.y < 1 || rect.x + rect.width > MAP_SIZE - 1 || rect.y + rect.height > MAP_SIZE - 1) {
      return false
    }
    if (rect.width < 6 || rect.height < 6) return false
  }
  for (let left = 0; left < rects.length; left += 1) {
    const a = rects[left]
    for (let right = left + 1; right < rects.length; right += 1) {
      const b = rects[right]
      const separated = a.x + a.width + 1 <= b.x
        || b.x + b.width + 1 <= a.x
        || a.y + a.height + 1 <= b.y
        || b.y + b.height + 1 <= a.y
      if (!separated) return false
    }
  }
  return true
}

function gateCandidates(room: Rect): Gate[] {
  const candidates: Gate[] = []
  for (let offset = 1; offset < room.width - 1; offset += 1) {
    const x = room.x + offset
    candidates.push({ x, y: room.y, outsideX: x, outsideY: room.y - 1, insideX: x, insideY: room.y + 1 })
    candidates.push({
      x,
      y: room.y + room.height - 1,
      outsideX: x,
      outsideY: room.y + room.height,
      insideX: x,
      insideY: room.y + room.height - 2
    })
  }
  for (let offset = 1; offset < room.height - 1; offset += 1) {
    const y = room.y + offset
    candidates.push({ x: room.x, y, outsideX: room.x - 1, outsideY: y, insideX: room.x + 1, insideY: y })
    candidates.push({
      x: room.x + room.width - 1,
      y,
      outsideX: room.x + room.width,
      outsideY: y,
      insideX: room.x + room.width - 2,
      insideY: y
    })
  }
  return candidates
}

function distanceToBoundary(x: number, y: number): number {
  return Math.min(x, y, MAP_SIZE - 1 - x, MAP_SIZE - 1 - y)
}

function roomPlan(seed: number, count: 3 | 4): Room[] {
  const random = streamFor(seed, TOPOLOGY_SALT)
  const templates = count === 3 ? THREE_ROOM_TEMPLATES : FOUR_ROOM_TEMPLATES
  const template = templates[random.int(templates.length)]
  const quarterTurns = random.int(4)
  const reflect = random.int(2) === 1
  const transformed = template.map(rect => transformRect(rect, quarterTurns, reflect))
  let chosen = transformed
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const jittered = transformed.map(rect => ({
      ...rect,
      x: rect.x + random.int(3) - 1,
      y: rect.y + random.int(3) - 1
    }))
    if (roomsHaveAisles(jittered)) {
      chosen = jittered
      break
    }
  }
  if (!roomsHaveAisles(chosen)) {
    throw new Error(`invalid built-in procedural village room template for seed ${seed}`)
  }
  chosen.sort((a, b) => a.y - b.y || a.x - b.x || a.width - b.width || a.height - b.height)
  return chosen.map((rect, roomIndex) => {
    const candidates = gateCandidates(rect)
    candidates.sort((a, b) => {
      const aScore = distanceToBoundary(a.outsideX, a.outsideY) * 10_000
        + (mix32(seed ^ GATE_SALT ^ Math.imul(roomIndex + 1, 0x9e37_79b9) ^ Math.imul(a.x + 1, 131) ^ (a.y + 1)) % 10_000)
      const bScore = distanceToBoundary(b.outsideX, b.outsideY) * 10_000
        + (mix32(seed ^ GATE_SALT ^ Math.imul(roomIndex + 1, 0x9e37_79b9) ^ Math.imul(b.x + 1, 131) ^ (b.y + 1)) % 10_000)
      return aScore - bScore || a.y - b.y || a.x - b.x
    })
    const gate = candidates[0]
    return { ...rect, gate }
  })
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

function wallBuildings(seed: number, seedHex: string, rooms: readonly Room[], level: number): SerializedBuilding[] {
  const lowerLevelRoom = mix32(seed ^ LEVEL_SALT ^ hashText('wall')) % rooms.length
  const cells = rooms.flatMap((room, roomIndex) => perimeterOf(room).map(cell => ({
    ...cell,
    level: roomIndex === lowerLevelRoom && level > 1 ? level - 1 : level
  })))
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

function roomContainingFootprint(rooms: readonly Room[], x: number, y: number, width: number, height: number): number {
  return rooms.findIndex(room => x >= room.x + 1
    && y >= room.y + 1
    && x + width <= room.x + room.width - 1
    && y + height <= room.y + room.height - 1)
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

function placementScore(
  seed: number,
  instance: BuildingInstance,
  rooms: readonly Room[],
  buildings: readonly SerializedBuilding[],
  x: number,
  y: number
): number {
  const definition = BUILDING_DEFINITIONS[instance.type]
  const containingRoom = roomContainingFootprint(rooms, x, y, definition.width, definition.height)
  let score = mix32(seed ^ PLACEMENT_SALT ^ hashText(instance.type)
    ^ Math.imul(instance.ordinal + 1, 0x9e37_79b9)
    ^ Math.imul(x + 1, 0x85eb_ca6b)
    ^ Math.imul(y + 1, 0xc2b2_ae35)) % 10_000
  if (definition.category === 'defense') {
    score += containingRoom === instance.preferredRoom ? -60_000 : containingRoom >= 0 ? -38_000 : 8_000
  } else if (instance.type === 'storage' || instance.type === 'lab'
    || instance.type === 'barracks' || instance.type === 'mystic_barracks') {
    score += containingRoom >= 0 ? -24_000 : 2_000
  } else if (instance.type === 'farm' || instance.type === 'mine' || instance.type === 'army_camp') {
    score += containingRoom >= 0 ? 15_000 : 0
  } else {
    score += containingRoom >= 0 ? -8_000 : 0
  }
  const centerX = x + definition.width / 2
  const centerY = y + definition.height / 2
  for (const building of buildings) {
    const other = BUILDING_DEFINITIONS[building.type]
    const distance = Math.abs(centerX - building.gridX - other.width / 2)
      + Math.abs(centerY - building.gridY - other.height / 2)
    score += Math.max(0, 6 - distance) * 900
  }
  return score
}

function placeBuilding(
  seed: number,
  seedHex: string,
  profile: DifficultyProfile,
  state: PlacementState,
  instance: BuildingInstance,
  requiredRoom: number | null = null
): SerializedBuilding {
  const definition = BUILDING_DEFINITIONS[instance.type]
  const candidates: PlacementCandidate[] = []
  for (let y = 1; y + definition.height <= MAP_SIZE - 1; y += 1) {
    for (let x = 1; x + definition.width <= MAP_SIZE - 1; x += 1) {
      const cells = footprintKeys(x, y, definition.width, definition.height)
      if (cells.some(cell => state.occupied.has(cell) || state.reserved.has(cell))) continue
      const containingRoom = roomContainingFootprint(state.rooms, x, y, definition.width, definition.height)
      if (requiredRoom !== null && containingRoom !== requiredRoom) continue
      candidates.push({
        x,
        y,
        score: placementScore(seed, instance, state.rooms, state.buildings, x, y)
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
      level: levelFor(seed, profile, instance.type, instance.ordinal)
    }
    state.buildings.push(building)
    if (navigationIsConnected(state.occupied, state.passableWalls, state.buildings)) return building
    state.buildings.pop()
    for (const cell of cells) state.occupied.delete(cell)
  }
  throw new Error(`unable to place ${instance.type} ${instance.ordinal} for procedural village seed ${seed}`)
}

function coreRoomIndex(rooms: readonly Room[]): number {
  let bestIndex = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let index = 0; index < rooms.length; index += 1) {
    const room = rooms[index]
    const centerX2 = room.x * 2 + room.width
    const centerY2 = room.y * 2 + room.height
    const centerDistance = Math.abs(centerX2 - MAP_SIZE) + Math.abs(centerY2 - MAP_SIZE)
    const areaBonus = (room.width - 2) * (room.height - 2) * 100
    const score = centerDistance * 10 - areaBonus
    if (score < bestScore) {
      bestScore = score
      bestIndex = index
    }
  }
  return bestIndex
}

function desiredCount(profile: DifficultyProfile, type: NonWallBuildingType): number {
  return profile.roster[type] ?? 0
}

function populateBuildings(
  seed: number,
  seedHex: string,
  profile: DifficultyProfile,
  rooms: readonly Room[],
  walls: readonly SerializedBuilding[],
  reserved: ReadonlySet<string>
): SerializedBuilding[] {
  const passableWalls = new Set(walls.map(wall => key(wall.gridX, wall.gridY)))
  const occupied = new Set(passableWalls)
  const state: PlacementState = { occupied, passableWalls, reserved, rooms, buildings: [] }
  const ordinals = new Map<NonWallBuildingType, number>()
  const nextInstance = (type: NonWallBuildingType, preferredRoom: number): BuildingInstance => {
    const ordinal = ordinals.get(type) ?? 0
    ordinals.set(type, ordinal + 1)
    return { type, ordinal, preferredRoom }
  }
  const coreIndex = coreRoomIndex(rooms)
  placeBuilding(seed, seedHex, profile, state, nextInstance('town_hall', coreIndex), coreIndex)

  if (desiredCount(profile, 'dragons_breath') > 0) {
    const preferredRoom = (coreIndex + 1 + (mix32(seed ^ hashText('dragons_breath')) % (rooms.length - 1))) % rooms.length
    placeBuilding(seed, seedHex, profile, state, nextInstance('dragons_breath', preferredRoom))
  }

  for (let roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
    placeBuilding(seed, seedHex, profile, state, nextInstance('cannon', roomIndex), roomIndex)
  }

  const remaining: BuildingInstance[] = []
  for (const type of ROSTER_ORDER) {
    const count = desiredCount(profile, type)
    const alreadyPlaced = ordinals.get(type) ?? 0
    for (let ordinal = alreadyPlaced; ordinal < count; ordinal += 1) {
      ordinals.set(type, ordinal + 1)
      remaining.push({
        type,
        ordinal,
        preferredRoom: mix32(seed ^ hashText(type) ^ Math.imul(ordinal + 1, 0x9e37_79b9)) % rooms.length
      })
    }
  }
  remaining.sort((a, b) => {
    const aDefinition = BUILDING_DEFINITIONS[a.type]
    const bDefinition = BUILDING_DEFINITIONS[b.type]
    const areaDifference = bDefinition.width * bDefinition.height - aDefinition.width * aDefinition.height
    if (areaDifference !== 0) return areaDifference
    const defenseDifference = Number(bDefinition.category === 'defense') - Number(aDefinition.category === 'defense')
    if (defenseDifference !== 0) return defenseDifference
    return hashText(a.type) - hashText(b.type) || a.ordinal - b.ordinal
  })
  for (const instance of remaining) placeBuilding(seed, seedHex, profile, state, instance)
  return [...walls, ...state.buildings]
}

function placeObstacles(
  seed: number,
  seedHex: string,
  targetCount: number,
  rooms: readonly Room[],
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
          const containingRoom = roomContainingFootprint(rooms, x, y, definition.width, definition.height)
          const edgeDistance = distanceToBoundary(x, y)
          const score = (containingRoom >= 0 ? 40_000 : 0)
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

function reservedTiles(rooms: readonly Room[]): Set<string> {
  const reserved = new Set<string>()
  for (let coordinate = 0; coordinate < MAP_SIZE; coordinate += 1) {
    reserved.add(key(coordinate, 0))
    reserved.add(key(coordinate, MAP_SIZE - 1))
    reserved.add(key(0, coordinate))
    reserved.add(key(MAP_SIZE - 1, coordinate))
  }
  for (const room of rooms) {
    reserved.add(key(room.gate.x, room.gate.y))
    reserved.add(key(room.gate.outsideX, room.gate.outsideY))
    reserved.add(key(room.gate.insideX, room.gate.insideY))
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
  const rooms = roomPlan(normalized, profile.roomCount)
  const reserved = reservedTiles(rooms)
  const walls = wallBuildings(normalized, seedHex, rooms, profile.wallLevel)
  const buildings = populateBuildings(normalized, seedHex, profile, rooms, walls, reserved)
  const obstacles = placeObstacles(
    normalized,
    seedHex,
    profile.obstacleCount,
    rooms,
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
