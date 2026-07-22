// ONE continuous, fixed-camera shot: the starter hamlet grows into a maxed
// concentric ring fortress — every building placed live, walls rising then
// upgrading level by level as a cohort, troops mustering at the camps.
// Captured at 1080p60 / 40 Mbps VP9 off the real Phaser canvas in 10-30s.
//
//   CLASH_DATA_DIR=<fresh dir> CLASH_ALLOW_GUESTS=1 \
//     CLASH_INFINITE_RESOURCES=1 CLASH_UPGRADE_DURATION_MS=350 \
//     npx vite --port 5174
//   BASE=http://127.0.0.1:5174 node tools/trailer/record-progression.mjs
import puppeteer from 'puppeteer-core'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5174'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = (process.env.OUT ?? new URL('./clips/', import.meta.url).pathname).replace(/\/$/, '')
const OUTPUT_NAME = process.env.NAME ?? 'village-maxing-fixed-1080'
const WIDTH = Number(process.env.WIDTH ?? 1920)
const HEIGHT = Number(process.env.HEIGHT ?? 1080)
const FIXED_ZOOM = Number(process.env.ZOOM ?? 0.66)
const PLACEMENT_GAP_MS = Number(process.env.PLACEMENT_GAP_MS ?? 35)
const WALL_UPGRADE_GAP_MS = Number(process.env.WALL_UPGRADE_GAP_MS ?? 22)
const BUILDING_UPGRADE_GAP_MS = Number(process.env.BUILDING_UPGRADE_GAP_MS ?? 45)
const FINAL_HOLD_MS = Number(process.env.FINAL_HOLD_MS ?? 1_500)
const TOKEN_CACHE = process.env.TOKEN_CACHE
  ?? new URL('./.trailer-device-token.json', import.meta.url).pathname

mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function api(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
  })
  const raw = await response.text()
  let json = null
  try { json = raw ? JSON.parse(raw) : null } catch { /* raw carries the message */ }
  return { status: response.status, ok: response.ok, json, raw }
}

/* ------------------------- the ring base layout -------------------------- */
// Inner ring (9,9)-(15,15): 24 walls around the keep. Outer ring
// (4,4)-(20,20): 64 walls. 88 total — a full concentric castle with a 4-tile
// defense band between the rings and the economy skirting outside.

const INNER = { x0: 9, y0: 9, x1: 15, y1: 15 }
const OUTER = { x0: 4, y0: 4, x1: 20, y1: 20 }

function ringCells(r) {
  const cells = []
  for (let x = r.x0; x <= r.x1; x += 1) {
    cells.push([x, r.y0])
    cells.push([x, r.y1])
  }
  for (let y = r.y0 + 1; y <= r.y1 - 1; y += 1) {
    cells.push([r.x0, y])
    cells.push([r.x1, y])
  }
  return cells
}

// Each entry: type + candidate top-left spots (first free wins).
const CORE = [
  { type: 'prism', spots: [[13, 10], [10, 13], [13, 13]] },
  { type: 'tesla', spots: [[10, 13], [13, 12], [14, 14]] },
  { type: 'cannon', spots: [[13, 11], [10, 14], [12, 13]] },
  { type: 'cannon', spots: [[11, 13], [14, 10], [13, 14]] }
]
const BAND = [
  { type: 'dragons_breath', spots: [[5, 5], [16, 5], [5, 16]] },
  { type: 'storage', spots: [[11, 5], [10, 5], [12, 5]] },
  { type: 'xbow', spots: [[17, 5], [16, 5], [17, 6]] },
  { type: 'xbow', spots: [[5, 17], [6, 17], [5, 16]] },
  { type: 'xbow', spots: [[17, 17], [16, 17], [17, 16]] },
  { type: 'mortar', spots: [[10, 7], [13, 7], [7, 10]] },
  { type: 'mortar', spots: [[13, 16], [12, 17], [16, 13]] },
  { type: 'mortar', spots: [[7, 13], [7, 12], [16, 10]] },
  { type: 'ballista', spots: [[7, 5], [14, 5], [5, 7]] },
  { type: 'spike_launcher', spots: [[13, 5], [14, 6], [5, 13]] },
  { type: 'spike_launcher', spots: [[6, 14], [5, 14], [14, 17]] },
  { type: 'tesla', spots: [[8, 8], [16, 8], [8, 16]] },
  { type: 'tesla', spots: [[16, 16], [16, 8], [8, 16]] },
  { type: 'cannon', spots: [[8, 5], [5, 8], [9, 17]] },
  { type: 'cannon', spots: [[16, 6], [6, 16], [15, 17]] },
  { type: 'cannon', spots: [[5, 15], [15, 5], [17, 9]] }
]
const ECONOMY = [
  { type: 'farm', spots: [[8, 1], [13, 1], [8, 22]] },
  { type: 'farm', spots: [[13, 1], [8, 22], [13, 22]] },
  { type: 'farm', spots: [[8, 22], [13, 22], [1, 8]] },
  { type: 'mine', spots: [[2, 9], [21, 9], [2, 13]] },
  { type: 'mine', spots: [[21, 9], [2, 13], [21, 13]] },
  { type: 'mine', spots: [[2, 13], [21, 13], [9, 2]] }
]
const MILITARY = [
  { type: 'army_camp', spots: [[1, 1], [1, 2], [2, 1]] },
  { type: 'army_camp', spots: [[21, 1], [20, 1], [21, 2]] },
  { type: 'army_camp', spots: [[1, 21], [2, 21], [1, 20]] },
  { type: 'army_camp', spots: [[21, 21], [20, 21], [21, 20]] },
  { type: 'barracks', spots: [[21, 13], [21, 12], [21, 15]] },
  { type: 'mystic_barracks', spots: [[1, 12], [2, 16], [1, 15]] },
  { type: 'lab', spots: [[2, 5], [21, 5], [2, 17]] },
  { type: 'watchtower', spots: [[17, 1], [16, 1], [17, 22]] },
  { type: 'jukebox', spots: [[12, 2], [11, 2], [12, 22]] }
]

/* ----------------------------- page helpers ------------------------------ */

// Chunks stream to node through an exposed binding as they are encoded —
// a long 1080p take never fits through one CDP string.
const RECORDER_SNIPPET = `
window.__trailer = window.__trailer ?? {}
window.__trailer.start = () => {
  const canvas = document.querySelector('#game-container canvas') ?? document.querySelector('canvas')
  if (!canvas) throw new Error('no canvas to record')
  const stream = canvas.captureStream(60)
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm'
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 40_000_000 })
  let sending = Promise.resolve()
  recorder.ondataavailable = event => {
    if (!event.data.size) return
    sending = sending.then(async () => {
      const buffer = await event.data.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const STEP = 0x8000
      for (let i = 0; i < bytes.length; i += STEP) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP))
      }
      await window.__trailerPush(btoa(binary))
    })
  }
  recorder.onstop = () => { sending.then(() => { window.__trailer.finished = true }) }
  window.__trailer.recorder = recorder
  window.__trailer.finished = false
  recorder.start(250)
}
window.__trailer.stop = () => window.__trailer.recorder?.stop()
`

/** Pin the exact same wide composition on every scene update. This prevents
 *  both scripted and game-owned camera motion from reaching a rendered frame. */
async function lockCamera(page, spec) {
  await page.evaluate(config => {
    const game = window.__clashGame
    const previous = window.__trailerCameraLock
    if (previous) game.events.off('prerender', previous)
    const audit = { frames: 0, sceneChanges: 0, maxZoomDelta: 0, maxXDelta: 0, maxYDelta: 0 }
    let lockedScene = null
    const pin = () => {
      const scene = game.scene.keys.MainScene
      const camera = scene?.cameras?.main
      if (!camera) return
      audit.maxZoomDelta = Math.max(audit.maxZoomDelta, Math.abs(camera.zoom - config.zoom))
      audit.maxXDelta = Math.max(audit.maxXDelta, Math.abs(camera.midPoint.x - config.x))
      audit.maxYDelta = Math.max(audit.maxYDelta, Math.abs(camera.midPoint.y - config.y))
      camera.stopFollow()
      camera.setZoom(config.zoom)
      camera.centerOn(config.x, config.y)
      if (scene !== lockedScene) {
        scene.dayNight?.setPhaseOverride(0.3)
        lockedScene = scene
        audit.sceneChanges += 1
      }
      audit.frames += 1
    }
    window.__trailerCameraAudit = audit
    window.__trailerCameraLock = pin
    game.events.on('prerender', pin)
    pin()
  }, spec)
}

async function placeBatch(page, batch, gapMs = PLACEMENT_GAP_MS) {
  return page.evaluate(async (wanted, gap) => {
    const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
    const scene = window.__clashGame.scene.keys.MainScene
    const results = []
    for (const item of wanted) {
      const definition = BUILDING_DEFINITIONS[item.type]
      const already = scene.buildings.filter(building => building.type === item.type).length
      if (definition?.maxCount && already >= definition.maxCount) {
        results.push({ type: item.type, ok: true, skippedExisting: true })
        continue
      }
      let done = false
      for (const [x, y] of item.spots) {
        if (!scene.isPositionValid(x, y, item.type)) continue
        done = await scene.placeBuilding(x, y, item.type, 'PLAYER', true, true)
        if (done) break
      }
      results.push({ type: item.type, ok: Boolean(done) })
      // At least two rendered frames between placements: visible growth with
      // none of the one-frame whole-village swaps caused by loadBase().
      await new Promise(resolve => setTimeout(resolve, gap))
    }
    // Building ground decals are already baked pixel sprites. A full-ground
    // quantize after the last placement is both redundant and a visible hitch
    // at this wide zoom, so keep the already-quantized lawn and direct decals.
    scene.groundPixelDirtyAt = 0
    return results
  }, batch, gapMs)
}

async function placeWalls(page, cells) {
  return placeBatch(page, cells.map(([x, y]) => ({ type: 'wall', spots: [[x, y]] })))
}

/** Advance one server-authoritative level wave without rebuilding the scene.
 * The visible village stays put until the final one-building-at-a-time max
 * cascade, keeping the clip short while final persistence remains genuine. */
async function advanceAuthorityWave(page, userId) {
  await page.evaluate(async uid => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
    const world = Backend.getCachedWorld(uid)
    for (const building of world.buildings) {
      const max = BUILDING_DEFINITIONS[building.type]?.maxLevel ?? 1
      const level = building.level ?? 1
      if (level >= max || building.upgradingTo) continue
      building.level = level + 1
    }
    world.wallLevel = Math.max(1, ...world.buildings
      .filter(b => b.type === 'wall')
      .map(b => b.level ?? 1))
    Backend.setCachedWorld(uid, world)
    Backend.markLayoutEdited(uid)
    await Backend.saveNow(uid)
  }, userId)

  // The save starts real server-owned upgrade clocks. Wait for the advertised
  // deadlines, then force a browser-side authority fetch so the next wave
  // begins from the matured levels instead of a stale optimistic cache.
  const clockWaitMs = await page.evaluate(async uid => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const cached = Backend.getCachedWorld(uid)
    const deadlines = (cached?.buildings ?? [])
      .map(building => Number(building.upgradeEndsAt))
      .filter(Number.isFinite)
    return deadlines.length ? Math.max(0, Math.max(...deadlines) - Date.now()) : 0
  }, userId)
  await sleep(clockWaitMs + 80)
  const remaining = await page.evaluate(async uid => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
    const world = await Backend.forceLoadFromCloud(uid)
    return (world?.buildings ?? []).filter(building => {
      const max = BUILDING_DEFINITIONS[building.type]?.maxLevel ?? 1
      return (building.level ?? 1) < max
    }).length
  }, userId)
  return remaining
}

/** Switch each live baked carrier directly to its already-authoritative max
 * level. One structure changes per beat; the scene, ground and clouds never
 * clear, so no whole-frame white flash is possible. */
async function cascadeLiveToAuthority(page) {
  return page.evaluate(async ({ wallGap, buildingGap }) => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
    const scene = window.__clashGame.scene.keys.MainScene
    const world = Backend.getCachedWorld(scene.userId)
    const authority = new Map(world.buildings.map(building => [building.id, building]))
    const order = scene.buildings.slice().sort((a, b) => {
      const da = Math.hypot(a.gridX - 12.5, a.gridY - 12.5)
      const db = Math.hypot(b.gridX - 12.5, b.gridY - 12.5)
      return da - db || a.gridY - b.gridY || a.gridX - b.gridX
    })
    let changed = 0
    for (const live of order) {
      const cached = authority.get(live.id)
      if (!cached) continue
      const max = BUILDING_DEFINITIONS[live.type]?.maxLevel ?? 1
      const next = Math.min(max, cached.level ?? 1)
      if (next === (live.level ?? 1)) continue
      live.level = next
      live.builtAt = cached.builtAt ?? Date.now()
      const hp = BUILDING_DEFINITIONS[live.type]?.levels?.[next - 1]?.hp
        ?? BUILDING_DEFINITIONS[live.type]?.maxHealth
        ?? live.maxHealth
      live.maxHealth = hp
      live.health = hp
      live.graphics.clear()
      if (live.baseGraphics) live.baseGraphics.clear()
      scene.drawBuildingVisuals(
        live.graphics, live.gridX, live.gridY, live.type,
        1, null, live, live.baseGraphics, true
      )
      scene.updateHealthBar(live)
      if (live.type === 'wall') {
        scene.preferredWallLevel = Math.max(scene.preferredWallLevel, next)
        scene.refreshWallNeighbors(live.gridX, live.gridY, live.owner)
      }
      changed += 1
      await new Promise(resolve => setTimeout(
        resolve,
        live.type === 'wall' ? wallGap : buildingGap
      ))
    }
    return { changed }
  }, { wallGap: WALL_UPGRADE_GAP_MS, buildingGap: BUILDING_UPGRADE_GAP_MS })
}

async function scheduleWeatherImprovement(page, delayMs = 5_500, durationMs = 3_500) {
  await page.evaluate(({ delay, duration }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const start = performance.now()
    const audit = {
      initialOverride: 0.72,
      transitionDelayMs: delay,
      transitionDurationMs: duration,
      samples: []
    }
    window.__trailerWeatherAudit = audit
    const tick = now => {
      const elapsed = now - start
      const t = Math.max(0, Math.min(1, (elapsed - delay) / duration))
      // Smoothstep: a soft break in the storm, never a tint cut.
      const eased = t * t * (3 - 2 * t)
      const intensity = 0.72 * (1 - eased)
      scene.weather?.setWeatherOverride?.(intensity)
      if (!audit.samples.length || elapsed - audit.samples.at(-1).elapsedMs >= 500) {
        audit.samples.push({
          elapsedMs: Math.round(elapsed),
          override: Number(intensity.toFixed(3)),
          shown: Number((scene.weather?.rainFactor?.() ?? 0).toFixed(3))
        })
      }
      if (t < 1) requestAnimationFrame(tick)
      else audit.completed = true
    }
    requestAnimationFrame(tick)
  }, { delay: delayMs, duration: durationMs })
}

async function train(token, wishlist) {
  for (const [type, count] of wishlist) {
    const result = await api('POST', '/army/train', {
      token,
      body: { type, count, requestId: `prog-${type}-${Date.now()}` }
    })
    if (!result.ok) console.warn(`train ${type} -> ${result.status}`)
  }
}

/** Prove the last frame is genuinely maxed against the live definitions. */
async function auditMaxLevels(page, userId) {
  return page.evaluate(async uid => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
    const world = Backend.getCachedWorld(uid)
    const buildings = (world?.buildings ?? []).map(building => {
      const maxLevel = BUILDING_DEFINITIONS[building.type]?.maxLevel ?? 1
      return {
        id: building.id,
        type: building.type,
        level: building.level ?? 1,
        maxLevel
      }
    })
    const belowMax = buildings.filter(building => building.level !== building.maxLevel)
    const presentTypes = new Set(buildings.map(building => building.type))
    const missingTypes = Object.keys(BUILDING_DEFINITIONS)
      .filter(type => !presentTypes.has(type))
    return {
      total: buildings.length,
      maxed: buildings.length - belowMax.length,
      belowMax,
      missingTypes
    }
  }, userId)
}

/* --------------------------------- run ----------------------------------- */

let browser = null
try {
  let cachedToken = null
  try {
    cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null
  } catch { /* minted below */ }
  let session = await api('POST', '/auth/session', { body: cachedToken ? { token: cachedToken } : {} })
  if (session.status === 200 && session.json?.registrationRequired === true) {
    const suffix = Date.now().toString(36).slice(-9)
    session = await api('POST', '/auth/register', {
      body: { username: `Trailer${suffix}`, password: `trailer-capture-${suffix}` }
    })
  }
  if (session.status !== 200 || !session.json?.token) {
    throw new Error(`auth/session failed (${session.status}): ${session.raw}`)
  }
  const token = session.json.token
  const userId = session.json.user?.id ?? session.json.player?.id ?? null
  if (!userId) throw new Error('session payload had no user id')
  writeFileSync(TOKEN_CACHE, JSON.stringify({ token }))
  await api('POST', '/player/banner', { token, body: { banner: { palette: 2, emblem: 1, pattern: 0 } } })

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', `--window-size=${WIDTH},${HEIGHT}`]
  })
  const page = await browser.newPage()
  await page.setViewport({ width: WIDTH, height: HEIGHT })
  await page.evaluateOnNewDocument(value => {
    localStorage.setItem('clash.device.token', value)
  }, token)
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    return Boolean(scene?.worldMap && scene?.cameras?.main && scene?.buildings?.length)
  }, { timeout: 60_000, polling: 300 })
  await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 25_000 }).catch(() => {})
  await page.addStyleTag({ content: `
    .app-container > :not(#game-container) { opacity: 0 !important; pointer-events: none !important; }
    .village-bubble-layer, .plot-bubble, .building-bubble { display: none !important; }
  ` })

  const center = await page.evaluate(async () => {
    const { IsoUtils } = await import('/src/game/utils/IsoUtils.ts')
    return IsoUtils.cartToIso(12.5, 12.5)
  })

  // The complete 25x25 build remains in frame from the first starter hut to
  // the final max-level fortress. No zoom, pan, follow, or drift is allowed.
  await lockCamera(page, { zoom: FIXED_ZOOM, x: center.x, y: center.y + 30 })

  // Finish the opening cloud reveal and force the neighbourhood postcards to
  // exist before frame one. Their late arrival can read as a false zoom-out
  // even when the camera coordinates are perfectly fixed. Prime AFTER the
  // camera lock so WorldMap requests the radius needed by the wide framing.
  await page.evaluate(async () => {
    const scene = window.__clashGame.scene.keys.MainScene
    await scene.worldMap.prime(scene.time.now)
  })
  await sleep(3_500)
  const fogFreeze = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const worldMap = scene.worldMap
    const radius = worldMap.computeViewRadius(false)
    worldMap.cancelFogReveal?.()
    worldMap.ensureFog(radius)
    // This clip is about the village, not map discovery. Keep the already
    // rendered cloud boundary and its postcards immutable while the tower
    // grows, avoiding the expensive fog-bank rebuild and camera toggle.
    worldMap.computeViewRadius = () => radius
    worldMap.nextRefreshAt = Number.MAX_SAFE_INTEGER
    scene.weather?.setWeatherOverride?.(0.72)
    return { radius, frozenBeforeRecording: true }
  })
  // Let real WeatherSystem rain reach its steady gloomy opening before frame
  // one; the improvement is scheduled only after recording begins.
  await sleep(2_200)

  const outputPath = `${OUT}/${OUTPUT_NAME}.webm`
  writeFileSync(outputPath, Buffer.alloc(0))
  let written = 0
  await page.exposeFunction('__trailerPush', chunk => {
    const buffer = Buffer.from(chunk, 'base64')
    appendFileSync(outputPath, buffer)
    written += buffer.length
  })
  await page.evaluate(RECORDER_SNIPPET)
  await page.evaluate(() => window.__trailer.start())
  const recordingStartedAt = Date.now()
  await scheduleWeatherImprovement(page)
  await page.evaluate(() => {
    const audit = { frames: 0, maxGapMs: 0, gapsOver50Ms: 0, gapsOver100Ms: 0 }
    let previous = performance.now()
    const sample = now => {
      if (window.__trailer?.finished) return
      const gap = now - previous
      previous = now
      audit.frames += 1
      audit.maxGapMs = Math.max(audit.maxGapMs, gap)
      if (gap > 50) audit.gapsOver50Ms += 1
      if (gap > 100) audit.gapsOver100Ms += 1
      requestAnimationFrame(sample)
    }
    window.__trailerFramePacingAudit = audit
    requestAnimationFrame(sample)
  })

  // Opening hold on the starter hamlet.
  await sleep(650)

  // Economy, then the war machine, arriving in rhythmic pops.
  const placements = []
  placements.push(...await placeBatch(page, ECONOMY.slice(0, 3)))
  placements.push(...await placeBatch(page, ECONOMY.slice(3)))
  placements.push(...await placeBatch(page, MILITARY.slice(0, 4)))
  placements.push(...await placeBatch(page, MILITARY.slice(4)))
  await sleep(180)

  // The inner ring closes around the keep.
  placements.push(...await placeWalls(page, ringCells(INNER)))
  placements.push(...await placeBatch(page, CORE))
  await sleep(180)

  // The defense band fills, then the outer enceinte seals the castle.
  placements.push(...await placeBatch(page, BAND.slice(0, 10)))
  placements.push(...await placeBatch(page, BAND.slice(10)))
  placements.push(...await placeWalls(page, ringCells(OUTER)))
  await sleep(280)

  // Mature the real save first, then reveal that completed authority as one
  // compact visible cascade. No reload occurs anywhere inside the recording.
  for (let wave = 0; wave < 20; wave += 1) {
    const pending = await advanceAuthorityWave(page, userId)
    if (pending === 0) break
  }
  const cascadeAudit = await cascadeLiveToAuthority(page)

  // Hold on the finished max-level castle in the same composition.
  const maxLevelAudit = await auditMaxLevels(page, userId)
  const liveMaxAudit = await page.evaluate(async () => {
    const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
    const scene = window.__clashGame.scene.keys.MainScene
    const belowMax = scene.buildings.filter(building => {
      const max = BUILDING_DEFINITIONS[building.type]?.maxLevel ?? 1
      return (building.level ?? 1) !== max
    }).map(building => ({ id: building.id, type: building.type, level: building.level }))
    return { total: scene.buildings.length, maxed: scene.buildings.length - belowMax.length, belowMax }
  })
  await sleep(FINAL_HOLD_MS)

  await page.evaluate(() => window.__trailer.stop())
  await page.waitForFunction(() => window.__trailer.finished === true, { timeout: 90_000 })
  const cameraAudit = await page.evaluate(() => window.__trailerCameraAudit)
  const weatherAudit = await page.evaluate(() => ({
    ...window.__trailerWeatherAudit,
    finalShown: window.__clashGame.scene.keys.MainScene.weather?.rainFactor?.() ?? null
  }))
  const framePacingAudit = await page.evaluate(() => window.__trailerFramePacingAudit)
  const durationSeconds = (Date.now() - recordingStartedAt) / 1_000
  writeFileSync(`${OUT}/${OUTPUT_NAME}-report.json`, JSON.stringify({
    durationSeconds,
    fixedCamera: { zoom: FIXED_ZOOM, x: center.x, y: center.y + 30 },
    cameraAudit,
    fogFreeze,
    weatherAudit,
    framePacingAudit,
    flashPrevention: {
      sceneReloadsDuringRecording: 0,
      cloudRevealsDuringRecording: 0,
      placementGapMs: PLACEMENT_GAP_MS,
      wallUpgradeGapMs: WALL_UPGRADE_GAP_MS,
      buildingUpgradeGapMs: BUILDING_UPGRADE_GAP_MS
    },
    placementAudit: {
      requested: placements.length,
      placed: placements.filter(item => item.ok).length,
      failed: placements.filter(item => !item.ok)
    },
    cascadeAudit,
    maxLevelAudit,
    liveMaxAudit
  }, null, 2))
  console.log('camera lock audit', JSON.stringify(cameraAudit))
  console.log('max-level audit', JSON.stringify(maxLevelAudit))
  console.log(`duration ${durationSeconds.toFixed(2)}s`)
  if (maxLevelAudit.belowMax.length) {
    throw new Error(`${maxLevelAudit.belowMax.length} buildings were below max in the final frame`)
  }
  if (liveMaxAudit.belowMax.length) {
    throw new Error(`${liveMaxAudit.belowMax.length} live buildings were below max in the final frame`)
  }
  if (maxLevelAudit.missingTypes.length) {
    throw new Error(`final village was missing building types: ${maxLevelAudit.missingTypes.join(', ')}`)
  }
  if (durationSeconds < 10 || durationSeconds > 30) {
    throw new Error(`fixed-camera clip must be 10-30s, got ${durationSeconds.toFixed(2)}s`)
  }
  console.log(`captured ${OUTPUT_NAME}.webm (${(written / 1e6).toFixed(1)} MB streamed)`)
} finally {
  await browser?.close()
}
