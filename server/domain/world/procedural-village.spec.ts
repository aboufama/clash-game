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

const EXPECTED_ROOMS: Readonly<Record<ProceduralVillageDifficulty, number>> = {
  established: 3,
  strong: 3,
  elite: 3,
  fortress: 4,
  extreme: 4
}

const TROPHY_RANGES: Readonly<Record<ProceduralVillageDifficulty, readonly [number, number]>> = {
  established: [650, 1_050],
  strong: [1_050, 1_650],
  elite: [1_650, 2_450],
  fortress: [2_450, 3_350],
  extreme: [3_350, 4_500]
}

const DIFFICULTIES = Object.keys(EXPECTED_ROOMS) as ProceduralVillageDifficulty[]

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
  const components = wallComponents(walls)
  assert.equal(components.length, EXPECTED_ROOMS[difficulty])
  for (const component of components) {
    const minX = Math.min(...component.map(cell => cell.x))
    const maxX = Math.max(...component.map(cell => cell.x))
    const minY = Math.min(...component.map(cell => cell.y))
    const maxY = Math.max(...component.map(cell => cell.y))
    const width = maxX - minX + 1
    const height = maxY - minY + 1
    assert.ok(width >= 6 && height >= 6)
    assert.equal(component.length, 2 * width + 2 * height - 4, 'wall section is not a closed rectangle')
    assert.ok(component.every(cell => cell.x === minX || cell.x === maxX || cell.y === minY || cell.y === maxY))
    const guards = world.buildings.filter(building => {
      if (building.type === 'wall' || BUILDING_DEFINITIONS[building.type].category !== 'defense') return false
      const definition = BUILDING_DEFINITIONS[building.type]
      return building.gridX > minX && building.gridY > minY
        && building.gridX + definition.width - 1 < maxX
        && building.gridY + definition.height - 1 < maxY
    })
    assert.ok(guards.length > 0, `closed compartment ${minX},${minY} has no defense`)

    const clearBreachLane = component.some(cell => {
      if (cell.x === minX && cell.y > minY && cell.y < maxY) {
        return !hardBlockers.has(tileKey(cell.x - 1, cell.y)) && !hardBlockers.has(tileKey(cell.x + 1, cell.y))
      }
      if (cell.x === maxX && cell.y > minY && cell.y < maxY) {
        return !hardBlockers.has(tileKey(cell.x + 1, cell.y)) && !hardBlockers.has(tileKey(cell.x - 1, cell.y))
      }
      if (cell.y === minY && cell.x > minX && cell.x < maxX) {
        return !hardBlockers.has(tileKey(cell.x, cell.y - 1)) && !hardBlockers.has(tileKey(cell.x, cell.y + 1))
      }
      if (cell.y === maxY && cell.x > minX && cell.x < maxX) {
        return !hardBlockers.has(tileKey(cell.x, cell.y + 1)) && !hardBlockers.has(tileKey(cell.x, cell.y - 1))
      }
      return false
    })
    assert.ok(clearBreachLane, `closed compartment ${minX},${minY} has no clear breach lane`)
  }
  assert.ok(new Set(walls.map(wall => wall.level)).size >= 2, 'wall compartments should have heterogeneous levels')
  assert.equal(Math.max(...walls.map(wall => wall.level)), world.wallLevel)

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

assert.equal(PROCEDURAL_VILLAGE_GENERATOR_VERSION, 1)
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
assert.equal(custom.life?.identity, 'pv1:bot-owner:7,-3')

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

console.log(`procedural village regression: ${fingerprints.size}/64 unique layouts; distribution ${JSON.stringify(distribution)}`)
