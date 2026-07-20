import assert from 'node:assert/strict'
import {
  BUILDING_DEFINITIONS,
  MAP_SIZE,
  OBSTACLE_DEFINITIONS,
  type BuildingType
} from '../../../src/game/config/GameDefinitions'
import type { SerializedBuilding, SerializedWorld } from '../../../src/game/data/Models'
import {
  PROCEDURAL_VILLAGE_GENERATOR_VERSION,
  generateProceduralVillage,
  proceduralVillageDifficulty,
  proceduralVillageTrophies,
  type ProceduralVillageDifficulty
} from './procedural-village'

// The wall complex is procedural: 1-3 loops, optionally merged by curtain
// runs, optionally subdivided. Components are bounded per band, not pinned.
const EXPECTED_MAX_COMPONENTS: Readonly<Record<ProceduralVillageDifficulty, number>> = {
  established: 2,
  strong: 3,
  elite: 3,
  fortress: 3,
  extreme: 3
}

const TROPHY_RANGES: Readonly<Record<ProceduralVillageDifficulty, readonly [number, number]>> = {
  established: [650, 1_050],
  strong: [1_050, 1_650],
  elite: [1_650, 2_450],
  fortress: [2_450, 3_350],
  extreme: [3_350, 4_500]
}

const DIFFICULTIES = Object.keys(EXPECTED_MAX_COMPONENTS) as ProceduralVillageDifficulty[]

function tileKey(x: number, y: number): string {
  return `${x},${y}`
}

function footprint(
  x: number,
  y: number,
  width: number,
  height: number
): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = []
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) cells.push({ x: x + dx, y: y + dy })
  }
  return cells
}

function wallComponents(walls: readonly SerializedBuilding[]): Array<Array<{ x: number; y: number }>> {
  const remaining = new Set(walls.map(wall => tileKey(wall.gridX, wall.gridY)))
  const components: Array<Array<{ x: number; y: number }>> = []
  while (remaining.size > 0) {
    const next = remaining.values().next()
    if (next.done) throw new Error('wall component iterator ended unexpectedly')
    const first = next.value
    const [startX, startY] = first.split(',').map(Number)
    const queue = [{ x: startX, y: startY }]
    const component: Array<{ x: number; y: number }> = []
    remaining.delete(first)
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head]
      component.push(current)
      const neighbors = [
        { x: current.x - 1, y: current.y },
        { x: current.x + 1, y: current.y },
        { x: current.x, y: current.y - 1 },
        { x: current.x, y: current.y + 1 }
      ]
      for (const neighbor of neighbors) {
        const candidate = tileKey(neighbor.x, neighbor.y)
        if (!remaining.delete(candidate)) continue
        queue.push(neighbor)
      }
    }
    components.push(component)
  }
  return components
}

function componentIsClosedRectangle(component: ReadonlyArray<{ x: number; y: number }>): boolean {
  const minX = Math.min(...component.map(cell => cell.x))
  const maxX = Math.max(...component.map(cell => cell.x))
  const minY = Math.min(...component.map(cell => cell.y))
  const maxY = Math.max(...component.map(cell => cell.y))
  const width = maxX - minX + 1
  const height = maxY - minY + 1
  return component.length === 2 * width + 2 * height - 4
    && component.every(cell => cell.x === minX || cell.x === maxX || cell.y === minY || cell.y === maxY)
}

/** True when every cell on the component's bounding-box edge is walled. */
function componentBBoxClosed(component: ReadonlyArray<{ x: number; y: number }>): boolean {
  const minX = Math.min(...component.map(cell => cell.x))
  const maxX = Math.max(...component.map(cell => cell.x))
  const minY = Math.min(...component.map(cell => cell.y))
  const maxY = Math.max(...component.map(cell => cell.y))
  const set = new Set(component.map(cell => tileKey(cell.x, cell.y)))
  for (let x = minX; x <= maxX; x += 1) {
    if (!set.has(tileKey(x, minY)) || !set.has(tileKey(x, maxY))) return false
  }
  for (let y = minY; y <= maxY; y += 1) {
    if (!set.has(tileKey(minX, y)) || !set.has(tileKey(maxX, y))) return false
  }
  return true
}

/** Concentric signature: one wall component strictly inside another's box. */
function hasConcentricPair(components: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>): boolean {
  const boxes = components.map(component => ({
    minX: Math.min(...component.map(cell => cell.x)),
    maxX: Math.max(...component.map(cell => cell.x)),
    minY: Math.min(...component.map(cell => cell.y)),
    maxY: Math.max(...component.map(cell => cell.y))
  }))
  return boxes.some((inner, innerIndex) => boxes.some((outer, outerIndex) => innerIndex !== outerIndex
    && inner.minX > outer.minX && inner.maxX < outer.maxX
    && inner.minY > outer.minY && inner.maxY < outer.maxY))
}

interface RegionScan {
  /** tile index -> region id; -1 for exterior, -2 for wall cells */
  regionOf: Int16Array
  regionCount: number
}

/**
 * Independent geometry oracle: flood the exterior from the border with wall
 * cells blocking; every pocket that remains is an enclosed region, whether
 * it came from a loop, an internal dividing wall or a curtain courtyard.
 */
function enclosedRegions(wallSet: ReadonlySet<string>): RegionScan {
  const regionOf = new Int16Array(MAP_SIZE * MAP_SIZE).fill(-3)
  for (let y = 0; y < MAP_SIZE; y += 1) {
    for (let x = 0; x < MAP_SIZE; x += 1) {
      if (wallSet.has(tileKey(x, y))) regionOf[y * MAP_SIZE + x] = -2
    }
  }
  const queue = new Int32Array(MAP_SIZE * MAP_SIZE)
  const flood = (startIndex: number, mark: number) => {
    let head = 0
    let tail = 0
    regionOf[startIndex] = mark
    queue[tail++] = startIndex
    while (head < tail) {
      const index = queue[head++]
      const x = index % MAP_SIZE
      const y = Math.floor(index / MAP_SIZE)
      const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue
        const neighborIndex = ny * MAP_SIZE + nx
        if (regionOf[neighborIndex] !== -3) continue
        regionOf[neighborIndex] = mark
        queue[tail++] = neighborIndex
      }
    }
  }
  flood(0, -1)
  let regionCount = 0
  for (let index = 0; index < regionOf.length; index += 1) {
    if (regionOf[index] === -3) {
      flood(index, regionCount)
      regionCount += 1
    }
  }
  return { regionOf, regionCount }
}

function assertFiniteWallPaths(
  hardBlockers: ReadonlySet<string>,
  walls: ReadonlyMap<string, number>,
  buildings: readonly SerializedBuilding[]
): void {
  // Independent weighted reachability oracle. Buildings and obstacles are
  // impassable; every wall has a finite breach cost based on its level.
  const distances = new Float64Array(MAP_SIZE * MAP_SIZE)
  distances.fill(Number.POSITIVE_INFINITY)
  const settled = new Uint8Array(MAP_SIZE * MAP_SIZE)
  const boundary = (x: number, y: number) => x === 0 || y === 0 || x === MAP_SIZE - 1 || y === MAP_SIZE - 1
  for (let y = 0; y < MAP_SIZE; y += 1) {
    for (let x = 0; x < MAP_SIZE; x += 1) {
      if (boundary(x, y) && !hardBlockers.has(tileKey(x, y))) distances[y * MAP_SIZE + x] = 0
    }
  }
  for (let iteration = 0; iteration < MAP_SIZE * MAP_SIZE; iteration += 1) {
    let bestIndex = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < distances.length; index += 1) {
      if (!settled[index] && distances[index] < bestDistance) {
        bestIndex = index
        bestDistance = distances[index]
      }
    }
    if (bestIndex < 0) break
    settled[bestIndex] = 1
    const x = bestIndex % MAP_SIZE
    const y = Math.floor(bestIndex / MAP_SIZE)
    const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const
    for (const [nextX, nextY] of neighbors) {
      if (nextX < 0 || nextY < 0 || nextX >= MAP_SIZE || nextY >= MAP_SIZE) continue
      const key = tileKey(nextX, nextY)
      if (hardBlockers.has(key)) continue
      const nextIndex = nextY * MAP_SIZE + nextX
      const breachCost = walls.has(key) ? 8 * (walls.get(key) ?? 1) : 1
      distances[nextIndex] = Math.min(distances[nextIndex], bestDistance + breachCost)
    }
  }
  for (let y = 0; y < MAP_SIZE; y += 1) {
    for (let x = 0; x < MAP_SIZE; x += 1) {
      if (!hardBlockers.has(tileKey(x, y))) {
        assert.ok(Number.isFinite(distances[y * MAP_SIZE + x]), `unreachable traversable tile ${x},${y}`)
      }
    }
  }
  for (const building of buildings.filter(candidate => candidate.type !== 'wall')) {
    const definition = BUILDING_DEFINITIONS[building.type]
    const approaches: number[] = []
    for (let x = building.gridX; x < building.gridX + definition.width; x += 1) {
      if (building.gridY > 0) approaches.push((building.gridY - 1) * MAP_SIZE + x)
      if (building.gridY + definition.height < MAP_SIZE) {
        approaches.push((building.gridY + definition.height) * MAP_SIZE + x)
      }
    }
    for (let y = building.gridY; y < building.gridY + definition.height; y += 1) {
      if (building.gridX > 0) approaches.push(y * MAP_SIZE + building.gridX - 1)
      if (building.gridX + definition.width < MAP_SIZE) {
        approaches.push(y * MAP_SIZE + building.gridX + definition.width)
      }
    }
    assert.ok(approaches.some(index => Number.isFinite(distances[index])), `no finite approach to ${building.id}`)
  }
}

function assertWorld(world: SerializedWorld, difficulty: ProceduralVillageDifficulty): void {
  assert.equal(MAP_SIZE, 25)
  assert.equal(world.lastSaveTime, 0)
  assert.equal(world.revision, 0)
  assert.equal(world.life?.simulatedThrough, 0)
  assert.equal(world.life?.population, world.population?.count)
  assert.ok((world.population?.capacity ?? 0) >= (world.population?.count ?? 1))
  assert.ok(world.life?.identity.startsWith(`pv${PROCEDURAL_VILLAGE_GENERATOR_VERSION}:`))
  assert.ok(world.life?.identity.endsWith(world.ownerId))
  assert.ok((world.resources.ore ?? -1) >= 0 && (world.resources.ore ?? Infinity) <= (world.storage?.ore ?? -1))
  assert.ok((world.resources.food ?? -1) >= 0 && (world.resources.food ?? Infinity) <= (world.storage?.food ?? -1))

  const identifiers = [...world.buildings, ...(world.obstacles ?? [])].map(entity => entity.id)
  assert.equal(new Set(identifiers).size, identifiers.length)
  const buildingIds = world.buildings.map(building => building.id)
  const obstacleIds = (world.obstacles ?? []).map(obstacle => obstacle.id)
  assert.deepEqual(buildingIds, [...buildingIds].sort())
  assert.deepEqual(obstacleIds, [...obstacleIds].sort())

  const occupied = new Map<string, string>()
  const hardBlockers = new Set<string>()
  const wallLevels = new Map<string, number>()
  const perType = new Map<BuildingType, number>()
  for (const building of world.buildings) {
    const definition = BUILDING_DEFINITIONS[building.type]
    assert.ok(definition)
    assert.ok(Number.isInteger(building.level) && building.level >= 1 && building.level <= (definition.maxLevel ?? 1))
    perType.set(building.type, (perType.get(building.type) ?? 0) + 1)
    for (const cell of footprint(building.gridX, building.gridY, definition.width, definition.height)) {
      assert.ok(cell.x >= 0 && cell.y >= 0 && cell.x < MAP_SIZE && cell.y < MAP_SIZE)
      assert.ok(cell.x > 0 && cell.y > 0 && cell.x < MAP_SIZE - 1 && cell.y < MAP_SIZE - 1)
      const key = tileKey(cell.x, cell.y)
      assert.equal(occupied.get(key), undefined, `overlap at ${key}: ${occupied.get(key)} and ${building.id}`)
      occupied.set(key, building.id)
      if (building.type === 'wall') wallLevels.set(key, building.level)
      else hardBlockers.add(key)
    }
  }
  for (const [type, count] of perType) assert.ok(count <= BUILDING_DEFINITIONS[type].maxCount)
  assert.equal(perType.get('town_hall'), 1)
  for (const obstacle of world.obstacles ?? []) {
    const definition = OBSTACLE_DEFINITIONS[obstacle.type]
    assert.ok(definition)
    for (const cell of footprint(obstacle.gridX, obstacle.gridY, definition.width, definition.height)) {
      assert.ok(cell.x > 0 && cell.y > 0 && cell.x < MAP_SIZE - 1 && cell.y < MAP_SIZE - 1)
      const key = tileKey(cell.x, cell.y)
      assert.equal(occupied.get(key), undefined, `obstacle overlap at ${key}`)
      occupied.set(key, obstacle.id)
      hardBlockers.add(key)
    }
  }

  const walls = world.buildings.filter(building => building.type === 'wall')
  assert.ok(walls.length <= BUILDING_DEFINITIONS.wall.maxCount)
  assert.ok(walls.length >= 24, `wall complex is too sparse: ${walls.length}`)
  const components = wallComponents(walls)
  assert.ok(
    components.length >= 1 && components.length <= EXPECTED_MAX_COMPONENTS[difficulty],
    `unexpected wall component count ${components.length} for ${difficulty}`
  )

  const wallSet = new Set(walls.map(wall => tileKey(wall.gridX, wall.gridY)))
  const scan = enclosedRegions(wallSet)
  assert.ok(scan.regionCount >= 1, 'wall complex encloses nothing')

  // The town hall is always behind walls, in exactly one enclosed region.
  const townHall = world.buildings.find(building => building.type === 'town_hall')
  assert.ok(townHall)
  const townHallRegions = new Set(
    footprint(
      townHall.gridX,
      townHall.gridY,
      BUILDING_DEFINITIONS.town_hall.width,
      BUILDING_DEFINITIONS.town_hall.height
    ).map(cell => scan.regionOf[cell.y * MAP_SIZE + cell.x])
  )
  assert.equal(townHallRegions.size, 1)
  assert.ok([...townHallRegions][0] >= 0, 'town hall is outside every enclosed region')

  // No building straddles regions, unguarded pockets hold no civil buildings,
  // and every enclosed region can be breached through a clear lane.
  const regionDefenses = new Array<number>(scan.regionCount).fill(0)
  const regionCivil = new Array<number>(scan.regionCount).fill(0)
  for (const building of world.buildings) {
    if (building.type === 'wall') continue
    const definition = BUILDING_DEFINITIONS[building.type]
    const regions = new Set(
      footprint(building.gridX, building.gridY, definition.width, definition.height)
        .map(cell => scan.regionOf[cell.y * MAP_SIZE + cell.x])
    )
    assert.equal(regions.size, 1, `${building.id} straddles a wall`)
    const region = [...regions][0]
    if (region < 0) continue
    if (definition.category === 'defense') regionDefenses[region] += 1
    else regionCivil[region] += 1
  }
  for (let region = 0; region < scan.regionCount; region += 1) {
    if (regionCivil[region] > 0) {
      assert.ok(regionDefenses[region] > 0, `enclosed region ${region} holds buildings but no defense`)
    }
  }
  for (let region = 0; region < scan.regionCount; region += 1) {
    let breachable = false
    for (const wall of walls) {
      if (breachable) break
      const pairs = [
        [[wall.gridX - 1, wall.gridY], [wall.gridX + 1, wall.gridY]],
        [[wall.gridX, wall.gridY - 1], [wall.gridX, wall.gridY + 1]]
      ] as const
      for (const [[aX, aY], [bX, bY]] of pairs) {
        if (aX < 0 || aY < 0 || aX >= MAP_SIZE || aY >= MAP_SIZE) continue
        if (bX < 0 || bY < 0 || bX >= MAP_SIZE || bY >= MAP_SIZE) continue
        const sideA = scan.regionOf[aY * MAP_SIZE + aX]
        const sideB = scan.regionOf[bY * MAP_SIZE + bX]
        if (sideA !== region && sideB !== region) continue
        if (sideA === -2 || sideB === -2) continue
        if (hardBlockers.has(tileKey(aX, aY)) || hardBlockers.has(tileKey(bX, bY))) continue
        breachable = true
        break
      }
    }
    assert.ok(breachable, `enclosed region ${region} has no clear breach lane`)
  }

  // Wall-level enforcer: walls upgrade as a cohort in this game, so every
  // wall segment of a bot base must share one level, matching world.wallLevel.
  assert.equal(new Set(walls.map(wall => wall.level)).size, 1, 'bot walls must share one cohort level')
  assert.ok(walls.every(wall => wall.level === world.wallLevel), 'wall cohort level must match world.wallLevel')

  const defenses = world.buildings.filter(building => building.type !== 'wall'
    && BUILDING_DEFINITIONS[building.type].category === 'defense')
  assert.ok(new Set(defenses.map(defense => defense.level)).size >= 2, 'defenses are uniformly leveled')
  const cannons = defenses.filter(defense => defense.type === 'cannon')
  assert.ok(new Set(cannons.map(cannon => cannon.level)).size >= 2, 'same-type defenses are uniformly leveled')
  assertFiniteWallPaths(hardBlockers, wallLevels, world.buildings)

  const roundTrip = JSON.parse(JSON.stringify(world)) as SerializedWorld
  assert.deepEqual(roundTrip, world)
  assert.equal(JSON.stringify(roundTrip), JSON.stringify(world))
}

assert.equal(PROCEDURAL_VILLAGE_GENERATOR_VERSION, 3)
assert.throws(() => generateProceduralVillage(Number.NaN), /32-bit integer/)
assert.throws(() => generateProceduralVillage(0x1_0000_0000), /32-bit integer/)
assert.deepEqual(generateProceduralVillage(-1), generateProceduralVillage(0xffff_ffff))

for (const difficulty of DIFFICULTIES) {
  for (let seed = 0; seed < 12; seed += 1) {
    const world = generateProceduralVillage(seed, { difficulty })
    assertWorld(world, difficulty)
    assert.deepEqual(generateProceduralVillage(seed, { difficulty }), world)
  }
}

const custom = generateProceduralVillage(42, {
  id: 'coordinate:7,-3',
  ownerId: 'bot-owner:7,-3',
  username: 'Test Castellan',
  difficulty: 'extreme'
})
assert.equal(custom.id, 'coordinate:7,-3')
assert.equal(custom.ownerId, 'bot-owner:7,-3')
assert.equal(custom.username, 'Test Castellan')
assert.equal(custom.life?.identity, 'pv3:bot-owner:7,-3')

const distribution: Record<ProceduralVillageDifficulty, number> = {
  established: 0,
  strong: 0,
  elite: 0,
  fortress: 0,
  extreme: 0
}
for (let seed = 0; seed < 10_000; seed += 1) {
  const difficulty = proceduralVillageDifficulty(seed)
  distribution[difficulty] += 1
  const trophies = proceduralVillageTrophies(seed)
  const [minimum, maximum] = TROPHY_RANGES[difficulty]
  assert.ok(trophies >= minimum && trophies <= maximum)
}
assert.ok(distribution.established < 1_000, 'difficulty distribution is too beginner-heavy')
assert.ok(distribution.extreme > 650, 'extreme fortresses are too rare')
assert.ok(distribution.elite + distribution.fortress + distribution.extreme > 5_500)
const expectedDistribution: Readonly<Record<ProceduralVillageDifficulty, number>> = {
  established: 800,
  strong: 3_100,
  elite: 3_300,
  fortress: 2_000,
  extreme: 800
}
for (const difficulty of DIFFICULTIES) {
  assert.ok(Math.abs(distribution[difficulty] - expectedDistribution[difficulty]) < 160)
}

const fingerprints = new Set<string>()
for (let seed = 100; seed < 164; seed += 1) {
  const world = generateProceduralVillage(seed)
  const fingerprint = JSON.stringify({
    buildings: world.buildings.map(({ type, gridX, gridY, level }) => [type, gridX, gridY, level]),
    obstacles: (world.obstacles ?? []).map(({ type, gridX, gridY }) => [type, gridX, gridY])
  })
  fingerprints.add(fingerprint)
}
assert.ok(fingerprints.size >= 62, `insufficient layout diversity: ${fingerprints.size}/64`)

// Topology diversity: over a natural-difficulty sweep the roll space must
// actually produce single keeps, multi-loop works, curtain/subdivided
// complexes and multi-region compartmentalization — not one shape family.
const shapeTallies = {
  singleKeep: 0,
  multiWork: 0,
  complexWork: 0,
  compartmentalized: 0,
  ward: 0,
  concentric: 0
}
for (let seed = 300; seed < 500; seed += 1) {
  const world = generateProceduralVillage(seed)
  const walls = world.buildings.filter(building => building.type === 'wall')
  const components = wallComponents(walls)
  const rectangular = components.map(componentIsClosedRectangle)
  if (components.length === 1 && rectangular[0]) shapeTallies.singleKeep += 1
  if (components.length >= 2) shapeTallies.multiWork += 1
  if (rectangular.some(isRect => !isRect)) shapeTallies.complexWork += 1
  const scan = enclosedRegions(new Set(walls.map(wall => tileKey(wall.gridX, wall.gridY))))
  if (scan.regionCount >= 2) shapeTallies.compartmentalized += 1
  const concentric = hasConcentricPair(components)
  if (concentric) shapeTallies.concentric += 1
  else if (scan.regionCount >= 3 && components.some(component => !componentBBoxClosed(component))) {
    shapeTallies.ward += 1
  }
}
assert.ok(shapeTallies.singleKeep >= 8, `single-keep bases too rare: ${shapeTallies.singleKeep}/200`)
assert.ok(shapeTallies.multiWork >= 30, `multi-loop bases too rare: ${shapeTallies.multiWork}/200`)
assert.ok(shapeTallies.complexWork >= 30, `curtain/subdivided complexes too rare: ${shapeTallies.complexWork}/200`)
assert.ok(shapeTallies.compartmentalized >= 30, `compartmentalized bases too rare: ${shapeTallies.compartmentalized}/200`)
assert.ok(shapeTallies.ward >= 40, `ward-closed circuits too rare: ${shapeTallies.ward}/200`)
assert.ok(shapeTallies.concentric >= 2, `concentric enceintes too rare: ${shapeTallies.concentric}/200`)

// The owner's format rule: MOST heavy bases close the circuit — curtains
// walling off a baiting ward (1-2, 2-3, 3-1 or a double run), or a full
// concentric enceinte around the keep.
for (const difficulty of ['fortress', 'extreme'] as const) {
  let closedFormat = 0
  for (let seed = 600; seed < 700; seed += 1) {
    const world = generateProceduralVillage(seed, { difficulty })
    const walls = world.buildings.filter(building => building.type === 'wall')
    const components = wallComponents(walls)
    const scan = enclosedRegions(new Set(walls.map(wall => tileKey(wall.gridX, wall.gridY))))
    const concentric = hasConcentricPair(components)
    const ward = !concentric && scan.regionCount >= 3
      && components.some(component => !componentBBoxClosed(component))
    if (ward || concentric) closedFormat += 1
  }
  assert.ok(
    closedFormat >= 55,
    `${difficulty}: only ${closedFormat}/100 heavy bases close a ward or concentric enceinte`
  )
}

for (let seed = 200; seed < 264; seed += 1) {
  const world = generateProceduralVillage(seed, { difficulty: 'extreme' })
  for (const type of Object.keys(BUILDING_DEFINITIONS) as BuildingType[]) {
    if (type === 'wall') continue
    assert.equal(
      world.buildings.filter(building => building.type === type).length,
      BUILDING_DEFINITIONS[type].maxCount,
      `extreme fortress seed ${seed} does not use the full ${type} catalog allowance`
    )
  }
  const defenses = world.buildings.filter(building => building.type !== 'wall'
    && BUILDING_DEFINITIONS[building.type].category === 'defense')
  const normalizedStrength = defenses.reduce((sum, defense) => {
    const maximum = BUILDING_DEFINITIONS[defense.type].maxLevel ?? 1
    return sum + (maximum <= 1 ? 1 : (defense.level - 1) / (maximum - 1))
  }, 0) / defenses.length
  assert.ok(normalizedStrength >= 0.78, `extreme fortress seed ${seed} is underleveled: ${normalizedStrength}`)
}

console.log(`procedural village regression: ${fingerprints.size}/64 unique layouts; `
  + `shapes ${JSON.stringify(shapeTallies)}; distribution ${JSON.stringify(distribution)}`)
