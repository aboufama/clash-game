// End-to-end home-army regression: save a real barracks/camp fixture with a
// closed wall ring, train through the UI after the standing-army sync, and
// prove the fresh recruit uses the production wall-hop path all the way home.
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = new URL('./shots/', import.meta.url).pathname
const TOKEN_CACHE = new URL('./.shared-device-token.json', import.meta.url).pathname
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const RUN = `camp-hop-${Date.now().toString(36)}`
const MAP_SIZE = 25
// Tightest possible enclosure: one wall row directly around the 3x3 camp.
const RING_SPAN = 5
const OBSTACLE_SIZE = {
  rock_small: [1, 1],
  rock_large: [2, 2],
  tree_oak: [2, 2],
  tree_pine: [1, 1],
  grass_patch: [1, 1]
}

mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const repaintSurface = async page => {
  // Headless SwiftShader may return only tiles damaged since the previous
  // compositor pass. A one-pixel resize forces a complete WebGL repaint.
  await page.setViewport({ width: 1281, height: 901 })
  await sleep(80)
  await page.setViewport({ width: 1280, height: 900 })
  await sleep(160)
}

async function api(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = { raw: text } }
  if (!response.ok) {
    throw new Error(`${method} /api${path} failed (${response.status}): ${JSON.stringify(payload)}`)
  }
  return payload
}

let cachedToken = null
try { cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null } catch { /* first local run */ }
const session = await api('/auth/session', {
  method: 'POST',
  body: cachedToken ? { token: cachedToken } : {}
})
assert(session?.token, `auth/session returned no token: ${JSON.stringify(session)}`)
const token = session.token
try { writeFileSync(TOKEN_CACHE, JSON.stringify({ token })) } catch { /* cache is an optimization */ }
const authed = (path, options = {}) => api(path, { ...options, token })

function occupiedObstacleCells(obstacles) {
  const cells = new Set()
  for (const obstacle of obstacles ?? []) {
    // Colliding grass is legally dropped by village authority. Valuable
    // obstacles cannot move, so fixture buildings must avoid their footprints.
    if (obstacle.type === 'grass_patch') continue
    const [width, height] = OBSTACLE_SIZE[obstacle.type] ?? [1, 1]
    for (let y = obstacle.gridY; y < obstacle.gridY + height; y++) {
      for (let x = obstacle.gridX; x < obstacle.gridX + width; x++) cells.add(`${x},${y}`)
    }
  }
  return cells
}

function footprint(building, width, height) {
  const cells = []
  for (let y = building.gridY; y < building.gridY + height; y++) {
    for (let x = building.gridX; x < building.gridX + width; x++) cells.push(`${x},${y}`)
  }
  return cells
}

function makeFixture(obstacles) {
  const obstacleCells = occupiedObstacleCells(obstacles)
  const origins = []
  for (let minY = 0; minY <= MAP_SIZE - RING_SPAN; minY++) {
    for (let minX = 3; minX <= MAP_SIZE - RING_SPAN; minX++) {
      origins.push({ minX, minY, score: Math.abs(minX - 7) + Math.abs(minY - 7) })
    }
  }
  origins.sort((a, b) => a.score - b.score || a.minY - b.minY || a.minX - b.minX)

  for (const origin of origins) {
    const minX = origin.minX
    const minY = origin.minY
    const maxX = minX + RING_SPAN - 1
    const maxY = minY + RING_SPAN - 1
    const camp = { id: 'camp_hop_camp', type: 'army_camp', gridX: minX + 1, gridY: minY + 1, level: 1 }
    const barracks = { id: 'camp_hop_barracks', type: 'barracks', gridX: minX - 3, gridY: minY + 1, level: 1 }
    const walls = []
    for (let x = minX; x <= maxX; x++) {
      walls.push({ id: `camp_hop_wall_${x}_${minY}`, type: 'wall', gridX: x, gridY: minY, level: 1 })
      walls.push({ id: `camp_hop_wall_${x}_${maxY}`, type: 'wall', gridX: x, gridY: maxY, level: 1 })
    }
    for (let y = minY + 1; y < maxY; y++) {
      walls.push({ id: `camp_hop_wall_${minX}_${y}`, type: 'wall', gridX: minX, gridY: y, level: 1 })
      walls.push({ id: `camp_hop_wall_${maxX}_${y}`, type: 'wall', gridX: maxX, gridY: y, level: 1 })
    }

    const used = new Set()
    const structural = [
      [barracks, 2, 2],
      [camp, 3, 3],
      ...walls.map(wall => [wall, 1, 1])
    ]
    let blocked = false
    for (const [building, width, height] of structural) {
      for (const cell of footprint(building, width, height)) {
        if (obstacleCells.has(cell) || used.has(cell)) blocked = true
        used.add(cell)
      }
    }
    if (blocked) continue

    // Put the required Town Hall outside the ring and far from the recruit's
    // west-to-east route so this remains a wall-specific pathing fixture.
    const hallSpots = []
    for (let y = 0; y <= MAP_SIZE - 3; y++) {
      for (let x = 0; x <= MAP_SIZE - 3; x++) {
        const outside = x + 2 < minX || x > maxX || y + 2 < minY || y > maxY
        if (!outside) continue
        const hall = { id: 'camp_hop_hall', type: 'town_hall', gridX: x, gridY: y, level: 1 }
        const cells = footprint(hall, 3, 3)
        if (cells.some(cell => used.has(cell) || obstacleCells.has(cell))) continue
        const dx = x + 1.5 - (minX + maxX) / 2
        const dy = y + 1.5 - (minY + maxY) / 2
        hallSpots.push({ hall, score: dx * dx + dy * dy })
      }
    }
    hallSpots.sort((a, b) => b.score - a.score)
    if (hallSpots.length === 0) continue

    return {
      ring: { minX, minY, maxX, maxY },
      camp,
      barracks,
      buildings: [hallSpots[0].hall, barracks, camp, ...walls]
    }
  }
  throw new Error(`No collision-free ${RING_SPAN}x${RING_SPAN} camp wall-ring fixture fits this village`)
}

// A previous harness may have left the shared identity in a raid. Abort it so
// the returned army and village layout are both writable, then dismiss every
// troop through the authoritative endpoint before reducing the camp roster.
await authed('/attacks/active/abort', { method: 'POST', body: {} })
let world = (await authed('/world')).world
assert(world, 'GET /world returned no world')
for (const [type, rawCount] of Object.entries(world.army ?? {})) {
  let remaining = Math.max(0, Math.floor(Number(rawCount) || 0))
  let batch = 0
  while (remaining > 0) {
    const count = Math.min(50, remaining)
    await authed('/army/untrain', {
      method: 'POST',
      body: { type, count, requestId: `${RUN}-clear-${type}-${batch++}` }
    })
    remaining -= count
  }
}

world = (await authed('/world')).world
const clearedArmyCount = Object.values(world.army ?? {}).reduce((sum, count) => sum + (Number(count) || 0), 0)
assert(clearedArmyCount === 0, `army did not clear before fixture save: ${JSON.stringify(world.army)}`)

const fixture = makeFixture(world.obstacles ?? [])
const saved = await authed('/world/save', {
  method: 'POST',
  body: {
    world: {
      ...world,
      buildings: fixture.buildings,
      obstacles: world.obstacles ?? [],
      wallLevel: 1,
      revision: world.revision
    },
    requestId: `${RUN}-fixture`
  }
})
const savedWorld = saved.world
assert(savedWorld, `fixture save returned no world: ${JSON.stringify(saved)}`)
const savedIds = new Set((savedWorld.buildings ?? []).map(building => building.id))
for (const building of fixture.buildings) {
  assert(savedIds.has(building.id), `fixture building was not saved: ${building.id}`)
}
const expectedWallCount = RING_SPAN * 4 - 4
assert((savedWorld.buildings ?? []).filter(building => building.type === 'wall').length === expectedWallCount,
  `fixture did not persist its complete ${expectedWallCount}-segment closed wall ring`)

let browser = null
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(value => localStorage.setItem('clash.device.token', value), token)

  const pageErrors = []
  page.on('pageerror', error => {
    const message = String(error?.message ?? error)
    pageErrors.push(message)
    console.error('PAGE ERROR:', message)
  })

  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForFunction(
    ids => {
      const scene = window.__clashGame?.scene?.keys?.MainScene
      if (!scene) return false
      const live = new Set(scene.buildings.map(building => building.id))
      return ids.every(id => live.has(id))
    },
    { timeout: 90_000, polling: 250 },
    fixture.buildings.map(building => building.id)
  )
  await page.waitForFunction(() => !document.querySelector('.cloud-overlay'), { timeout: 90_000, polling: 100 })

  await page.evaluate(({ ring }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather.setWeatherOverride(0)
    const cx = (ring.minX + ring.maxX) / 2
    const cy = (ring.minY + ring.maxY) / 2
    scene.cameras.main.setZoom(1.25)
    scene.cameras.main.centerOn((cx - cy) * 32, (cx + cy) * 16 - 12)
  }, fixture)

  // The first sync treats the loaded army as already stationed. Waiting for
  // it before training is what makes this warrior a genuine fresh recruit
  // that must leave the barracks and navigate to the camp.
  await page.waitForFunction(() => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    const life = scene?.villageLife
    return scene?.mode === 'HOME' && life?.armySynced === true && life?.campFigures?.length === 0
  }, { timeout: 45_000, polling: 50 })

  await page.click('.action-btn.raid')
  await page.waitForSelector('.training-modal', { visible: true, timeout: 10_000 })
  const warriorCard = await page.$('.troop-grid-item:has(.warrior-icon)')
  assert(warriorCard, 'warrior training card was not present')
  const cardState = await warriorCard.evaluate(element => ({
    locked: element.classList.contains('locked'),
    disabled: element.classList.contains('disabled')
  }))
  assert(!cardState.locked && !cardState.disabled, `warrior training card was unavailable: ${JSON.stringify(cardState)}`)
  await warriorCard.click()
  await page.waitForSelector('.army-queue .warrior-icon', { visible: true, timeout: 10_000 })
  await page.click('.header-btn.close')
  await page.waitForFunction(() => !document.querySelector('.training-modal'), { timeout: 10_000, polling: 50 })

  // Prove the UI action reached authority, not merely the optimistic React
  // counter, before evaluating its presentation in VillageLifeSystem.
  const armyDeadline = Date.now() + 12_000
  let trainedWorld = null
  while (Date.now() < armyDeadline) {
    trainedWorld = (await authed('/world')).world
    const total = Object.values(trainedWorld.army ?? {}).reduce((sum, count) => sum + (Number(count) || 0), 0)
    if (trainedWorld.army?.warrior === 1 && total === 1) break
    await sleep(100)
  }
  const trainedTotal = Object.values(trainedWorld?.army ?? {}).reduce((sum, count) => sum + (Number(count) || 0), 0)
  assert(trainedWorld?.army?.warrior === 1 && trainedTotal === 1,
    `UI training did not produce one authoritative warrior: ${JSON.stringify(trainedWorld?.army)}`)

  await page.waitForFunction(campId => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    const figure = scene?.villageLife?.campFigures?.find(item => item.type === 'warrior' && item.campId === campId)
    if (!figure || figure.state !== 'march' || !figure.path?.length) return false
    const walls = new Set(scene.buildings
      .filter(building => building.type === 'wall' && building.health > 0 && !building.isDestroyed)
      .map(building => `${building.gridX},${building.gridY}`))
    return figure.path.some(point => walls.has(`${point.x},${point.y}`))
  }, { timeout: 15_000, polling: 20 }, fixture.camp.id)

  const routeProof = await page.evaluate(campId => {
    const scene = window.__clashGame.scene.keys.MainScene
    const figure = scene.villageLife.campFigures.find(item => item.type === 'warrior' && item.campId === campId)
    const walls = new Set(scene.buildings
      .filter(building => building.type === 'wall' && building.health > 0 && !building.isDestroyed)
      .map(building => `${building.gridX},${building.gridY}`))
    const path = figure.path.map(point => ({ x: point.x, y: point.y }))
    return {
      state: figure.state,
      start: { x: figure.x, y: figure.y },
      pathLength: path.length,
      wallWaypoints: path.filter(point => walls.has(`${point.x},${point.y}`)),
      legacyGateFields: scene.buildings.filter(building =>
        building.type === 'wall' && Object.hasOwn(building, 'isGate')).length
    }
  }, fixture.camp.id)
  assert(routeProof.state === 'march' && routeProof.wallWaypoints.length > 0,
    `fresh recruit did not start on a wall-crossing march: ${JSON.stringify(routeProof)}`)
  assert(routeProof.legacyGateFields === 0,
    `live walls retained legacy gate state: ${JSON.stringify(routeProof)}`)

  // hopTile is the production movement marker; the carrier must also be
  // visibly above its unmodified isometric ground position in the same frame.
  await page.waitForFunction(campId => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    const figure = scene?.villageLife?.campFigures?.find(item => item.type === 'warrior' && item.campId === campId)
    if (!figure?.hopTile || figure.state !== 'march') return false
    const groundY = (figure.x + figure.y) * 16
    return groundY - figure.gfx.y >= 3
  }, { timeout: 15_000, polling: 'raf' }, fixture.camp.id)

  const midHop = await page.evaluate(campId => {
    const scene = window.__clashGame.scene.keys.MainScene
    const figure = scene.villageLife.campFigures.find(item => item.type === 'warrior' && item.campId === campId)
    const lift = (figure.x + figure.y) * 16 - figure.gfx.y
    figure.__campHopHarnessSpeed = figure.speed
    figure.speed = 0
    return {
      state: figure.state,
      at: { x: figure.x, y: figure.y },
      hopTile: { ...figure.hopTile },
      lift
    }
  }, fixture.camp.id)
  assert(midHop.hopTile && midHop.lift >= 3, `hop had no visible lift: ${JSON.stringify(midHop)}`)
  await repaintSurface(page)
  await page.screenshot({ path: `${OUT}camp-wall-hop-mid.png` })
  await page.evaluate(campId => {
    const figure = window.__clashGame.scene.keys.MainScene.villageLife.campFigures
      .find(item => item.type === 'warrior' && item.campId === campId)
    if (!figure) return
    figure.speed = figure.__campHopHarnessSpeed
    delete figure.__campHopHarnessSpeed
  }, fixture.camp.id)

  await page.waitForFunction(({ camp, ring }) => {
    const figure = window.__clashGame?.scene?.keys?.MainScene?.villageLife?.campFigures
      ?.find(item => item.type === 'warrior' && item.campId === camp.id)
    if (!figure || figure.state !== 'idle') return false
    const insideRing = figure.x > ring.minX && figure.x < ring.maxX
      && figure.y > ring.minY && figure.y < ring.maxY
    const dx = Math.max(camp.gridX - figure.x, 0, figure.x - (camp.gridX + 3))
    const dy = Math.max(camp.gridY - figure.y, 0, figure.y - (camp.gridY + 3))
    return insideRing && Math.hypot(dx, dy) <= 2.1
  }, { timeout: 25_000, polling: 50 }, fixture)

  const finalState = await page.evaluate(({ camp, ring }) => {
    const figure = window.__clashGame.scene.keys.MainScene.villageLife.campFigures
      .find(item => item.type === 'warrior' && item.campId === camp.id)
    return {
      state: figure.state,
      at: { x: figure.x, y: figure.y },
      campId: figure.campId,
      insideRing: figure.x > ring.minX && figure.x < ring.maxX
        && figure.y > ring.minY && figure.y < ring.maxY
    }
  }, fixture)

  assert(finalState.state === 'idle' && finalState.insideRing && finalState.campId === fixture.camp.id,
    `warrior did not settle at the enclosed camp: ${JSON.stringify(finalState)}`)
  assert(pageErrors.length === 0, `browser emitted page errors: ${JSON.stringify(pageErrors)}`)

  console.log('fixture:', JSON.stringify({ ring: fixture.ring, barracks: fixture.barracks, camp: fixture.camp }))
  console.log('route:', JSON.stringify(routeProof))
  console.log('mid-hop:', JSON.stringify(midHop))
  console.log('final:', JSON.stringify(finalState))
  console.log(`screenshot: ${OUT}camp-wall-hop-mid.png`)
  console.log('CAMP WALL HOP: PASS')
} finally {
  await browser?.close()
}
