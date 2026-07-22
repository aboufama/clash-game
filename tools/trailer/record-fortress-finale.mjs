// One continuous, UI-free fortress finale captured from the real game:
// trained troops idle at four camps, the visiting merchant trades and then
// naturally packs at nightfall, four server-authoritative upgrade batches
// bring the near-max village to 100%, and the same saved village is loaded
// through startPracticeAttack() and raided with the trained heavy army.
//
// The server must use a short fixed upgrade clock and a disposable data dir.
// The script refuses to alter an account that is not the untouched starter.
//
//   CLASH_DATA_DIR="$(mktemp -d)" CLASH_ALLOW_GUESTS=1 \
//     CLASH_INFINITE_RESOURCES=1 CLASH_UPGRADE_DURATION_MS=1000 \
//     npx vite --port 5176
//   BASE=http://127.0.0.1:5176 \
//     node tools/trailer/record-fortress-finale.mjs
//
// Low-FPS proof pass:
//   FPS=4 NAME=fortress-finale-proof BASE=http://127.0.0.1:5176 \
//     node tools/trailer/record-fortress-finale.mjs
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'

const previewRequire = createRequire(new URL('../art-preview/package.json', import.meta.url))
const puppeteerPackage = previewRequire('puppeteer-core')
const puppeteer = puppeteerPackage.default ?? puppeteerPackage

const BASE = process.env.BASE ?? 'http://127.0.0.1:5176'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
const OUT = (process.env.OUT ?? new URL('./clips/', import.meta.url).pathname).replace(/\/$/, '')
const OUTPUT_NAME = process.env.NAME ?? 'fortress-merchant-max-practice-1080'
const WIDTH = Number(process.env.WIDTH ?? 1920)
const HEIGHT = Number(process.env.HEIGHT ?? 1080)
const FPS = Number(process.env.FPS ?? 60)
const VIDEO_BITRATE = Number(process.env.BITRATE ?? 40_000_000)
const BATCH_INTERVAL_MS = Number(process.env.BATCH_INTERVAL_MS ?? 1_200)
const MAX_UPGRADE_CLOCK_MS = Number(process.env.MAX_UPGRADE_CLOCK_MS ?? 5_000)
const BATTLE_MIN_MS = Number(process.env.BATTLE_MIN_MS ?? 18_000)
const BATTLE_MAX_MS = Number(process.env.BATTLE_MAX_MS ?? 55_000)
const TOKEN_CACHE = process.env.TOKEN_CACHE
  ?? new URL('./.fortress-finale-device-token.json', import.meta.url).pathname

const HOME_ZOOM = Number(process.env.HOME_ZOOM ?? 0.76)
const MERCHANT_ZOOM = Number(process.env.MERCHANT_ZOOM ?? 0.92)
const WIDE_ZOOM = Number(process.env.WIDE_ZOOM ?? 0.68)
const BATTLE_ZOOM = Number(process.env.BATTLE_ZOOM ?? 0.88)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

assert(Number.isInteger(FPS) && FPS >= 1 && FPS <= 60,
  `FPS must be an integer from 1 to 60 (received ${FPS})`)
assert(WIDTH === 1920 && HEIGHT === 1080,
  `the fortress finale is a 1080p deliverable; received ${WIDTH}x${HEIGHT}`)
assert(Number.isFinite(VIDEO_BITRATE) && VIDEO_BITRATE >= 5_000_000,
  `BITRATE must be at least 5000000 (received ${VIDEO_BITRATE})`)
assert(Number.isFinite(BATCH_INTERVAL_MS) && BATCH_INTERVAL_MS >= 800 && BATCH_INTERVAL_MS <= 1_200,
  `BATCH_INTERVAL_MS must be 800-1200 (received ${BATCH_INTERVAL_MS})`)

mkdirSync(OUT, { recursive: true })

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
  try { json = raw ? JSON.parse(raw) : null } catch { /* raw carries the error */ }
  return { status: response.status, ok: response.ok, json, raw }
}

async function authenticate() {
  let cachedToken = null
  try { cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null } catch { /* mint below */ }

  let session = await api('POST', '/auth/session', {
    body: cachedToken ? { token: cachedToken } : {}
  })
  if (session.status !== 200 || !session.json?.token) {
    // Isolated trailer servers routinely outlive the token cache that pointed
    // at the prior process. Retry without it before creating an identity.
    session = await api('POST', '/auth/session', { body: {} })
  }
  if (session.status === 200 && session.json?.registrationRequired === true) {
    const suffix = Date.now().toString(36).slice(-9)
    session = await api('POST', '/auth/register', {
      body: { username: `Finale${suffix}`, password: `fortress-finale-${suffix}` }
    })
  }
  assert(session.status === 200 && session.json?.token,
    `auth/session failed (${session.status}): ${session.raw}`)
  const userId = session.json.user?.id ?? session.json.player?.id
  assert(userId, 'session payload had no player id')
  try { writeFileSync(TOKEN_CACHE, JSON.stringify({ token: session.json.token })) } catch { /* non-fatal */ }
  return { token: session.json.token, userId }
}

async function resolveBannerGate(page) {
  await sleep(600)
  await page.evaluate(() => {
    const modal = document.querySelector('[class*="banner"]')
    if (!modal) return
    const choice = modal.querySelector('[class*="option"], [class*="choice"], button')
    choice?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const confirm = [...modal.querySelectorAll('button')]
      .find(button => /choose|confirm|select|done|ok/i.test(button.textContent ?? ''))
    confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(400)
}

/* ---------------------------- fortress plan ----------------------------- */

const RING = { x0: 6, y0: 6, x1: 18, y1: 19 }
const OUTER_CURTAIN = { x0: 4, y0: 4, x1: 20, y1: 20 }

function ringCells({ x0, y0, x1, y1 }) {
  const cells = []
  for (let x = x0; x <= x1; x += 1) {
    cells.push([x, y0], [x, y1])
  }
  for (let y = y0 + 1; y < y1; y += 1) {
    cells.push([x0, y], [x1, y])
  }
  return cells
}

// Twin gatehouses keep the enceinte a real closed-looking fortress while
// preserving the same enterable border-road route used by villagers and the
// production merchant cart. A mathematically sealed wall loop correctly
// rejects the cart instead of letting it ghost through masonry.
const gateOpenings = ([x, y], ring) => !(
    ((x === RING.x0 || x === RING.x1) && y === 12)
    || ((y === RING.y0 || y === RING.y1) && x === 12)
    || ((x === ring.x0 || x === ring.x1) && y === 12)
    || ((y === ring.y0 || y === ring.y1) && x === 12)
  )

// The advertised target is deliberately tougher than the first trailer cut:
// a second, wider curtain forces the heavy army through two real wall lines.
const FORTRESS_WALLS = [
  ...ringCells(RING).filter(cell => gateOpenings(cell, RING)),
  ...ringCells(OUTER_CURTAIN).filter(cell => gateOpenings(cell, OUTER_CURTAIN))
]

// The shipped starter already owns the Town Hall, central Army Camp and one
// mine. Everything below is placed through Backend.placeBuilding, so normal
// bounds, overlap and server layout rules remain in force.
const FORTRESS_BUILDINGS = [
  // Four camps total: the trained roster is visibly stationed around the plot.
  { type: 'army_camp', x: 1, y: 8 },
  { type: 'army_camp', x: 21, y: 8 },
  { type: 'army_camp', x: 8, y: 21 },

  // Productive village skirt.
  { type: 'farm', x: 5, y: 2 },
  { type: 'storage', x: 10, y: 2 },

  // Training and civic silhouette.
  { type: 'barracks', x: 21, y: 13 },
  { type: 'mystic_barracks', x: 1, y: 13 },
  { type: 'lab', x: 2, y: 5 },
  { type: 'watchtower', x: 16, y: 2 },
  { type: 'jukebox', x: 13, y: 3 },

  // One readable example of every defense, packed inside the wall complex.
  { type: 'dragons_breath', x: 14, y: 7 },
  { type: 'mortar', x: 7, y: 7 },
  { type: 'cannon', x: 10, y: 7 },
  { type: 'prism', x: 11, y: 8 },
  { type: 'tesla', x: 12, y: 8 },
  { type: 'xbow', x: 7, y: 14 },
  { type: 'ballista', x: 7, y: 17 },
  { type: 'spike_launcher', x: 14, y: 17 }
]

// Exactly 150-space legal at near-max L3 camps. Ten readable bodies attack
// from the full perimeter: two golems, a siege tower, an armored line and
// compact mechanica artillery. No tiny accent or support troops.
const TRAINED_ARMY = [
  ['davincitank', 1],
  ['golem', 2],
  ['siegetower', 1],
  ['warelephant', 2],
  ['ram', 2],
  ['mobilemortar', 2]
]

const DEPLOY_PLAN = [
  // A true encirclement: every unit starts on the grass at the village edge,
  // split across all four fronts instead of stacking at an interior gate.
  { type: 'davincitank', front: 'west', lane: -9.0, rear: 0.0 },
  { type: 'golem', front: 'west', lane: 7.0, rear: 0.0 },
  { type: 'mobilemortar', front: 'west', lane: 0.0, rear: 0.0 },
  { type: 'golem', front: 'east', lane: -9.0, rear: 0.0 },
  { type: 'warelephant', front: 'east', lane: 7.0, rear: 0.0 },
  { type: 'mobilemortar', front: 'east', lane: 0.0, rear: 0.0 },
  { type: 'siegetower', front: 'north', lane: 6.0, rear: 0.0 },
  { type: 'warelephant', front: 'north', lane: -6.0, rear: 0.0 },
  { type: 'ram', front: 'south', lane: -6.0, rear: 0.0 },
  { type: 'ram', front: 'south', lane: 6.0, rear: 0.0 }
]
const CAMP_FIGURE_TARGET = 10
const CAMP_TYPE_TARGET = 6

async function assertUntouchedStarter(page, userId) {
  return page.evaluate(async uid => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const world = await Backend.forceLoadFromCloud(uid)
    const signature = (world?.buildings ?? [])
      .map(b => `${b.type}:${b.gridX},${b.gridY}:${b.level ?? 1}`)
      .sort()
    const expected = [
      'army_camp:11,15:1',
      'mine:8,11:1',
      'town_hall:11,11:1'
    ].sort()
    return {
      ok: JSON.stringify(signature) === JSON.stringify(expected),
      signature,
      army: world?.army ?? {},
      resources: world?.resources ?? null
    }
  }, userId)
}

async function placeFortress(page, userId) {
  const result = await page.evaluate(async (uid, buildings, walls) => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const placed = []
    for (const item of buildings) {
      const building = await Backend.placeBuilding(uid, item.type, item.x, item.y)
      placed.push({ ...item, ok: Boolean(building), id: building?.id ?? null })
    }
    for (const [x, y] of walls) {
      const building = await Backend.placeBuilding(uid, 'wall', x, y)
      placed.push({ type: 'wall', x, y, ok: Boolean(building), id: building?.id ?? null })
    }
    await Backend.flushPendingSave()
    const world = await Backend.forceLoadFromCloud(uid)
    await window.__clashGM.loadBase()
    return {
      placed,
      authorityCount: world?.buildings?.length ?? 0,
      wallLevel: world?.wallLevel ?? null
    }
  }, userId, FORTRESS_BUILDINGS, FORTRESS_WALLS)
  const failures = result.placed.filter(item => !item.ok)
  assert(failures.length === 0, `fortress placement failed: ${JSON.stringify(failures)}`)
  return result
}

/** Efficient pre-roll only: the same server-authoritative one-level diff used
 * by record-progression, stopped at max-1. None of this is in the take. */
async function preStageNearMax(page, userId) {
  const waves = []
  for (let wave = 0; wave < 12; wave += 1) {
    const started = await page.evaluate(async uid => {
      const { Backend } = await import('/src/game/backend/GameBackend.ts')
      const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
      const world = Backend.getCachedWorld(uid)
      if (!world) throw new Error('no cached world while staging near-max village')
      const touched = []
      for (const building of world.buildings) {
        const max = BUILDING_DEFINITIONS[building.type]?.maxLevel ?? 1
        const target = Math.max(1, max - 1)
        const level = building.level ?? 1
        if (building.upgradingTo || level >= target) continue
        building.level = level + 1
        touched.push({ id: building.id, type: building.type, from: level, to: level + 1 })
      }
      if (!touched.length) return { touched, deadlines: [] }
      world.wallLevel = Math.max(1, ...world.buildings
        .filter(b => b.type === 'wall')
        .map(b => b.level ?? 1))
      Backend.setCachedWorld(uid, world)
      Backend.markLayoutEdited(uid)
      await Backend.saveNow(uid)
      const acknowledged = Backend.getCachedWorld(uid)
      return {
        touched,
        deadlines: (acknowledged?.buildings ?? [])
          .map(b => Number(b.upgradeEndsAt))
          .filter(Number.isFinite)
      }
    }, userId)

    if (!started.touched.length) break
    const maxDeadline = started.deadlines.length ? Math.max(...started.deadlines) : Date.now()
    const clockMs = Math.max(0, maxDeadline - Date.now())
    assert(clockMs <= MAX_UPGRADE_CLOCK_MS,
      `server upgrade clock is ${clockMs}ms; start the trailer server with CLASH_UPGRADE_DURATION_MS=1000`)
    await sleep(clockMs + 90)
    await page.evaluate(async uid => {
      const { Backend } = await import('/src/game/backend/GameBackend.ts')
      await Backend.forceLoadFromCloud(uid)
    }, userId)
    waves.push({ wave: wave + 1, touched: started.touched.length, clockMs })
  }
  await page.evaluate(() => window.__clashGM.loadBase())
  await sleep(500)
  return waves
}

async function auditLevels(page, userId) {
  return page.evaluate(async uid => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
    const world = Backend.getCachedWorld(uid)
    const buildings = (world?.buildings ?? []).map(building => {
      const maxLevel = BUILDING_DEFINITIONS[building.type]?.maxLevel ?? 1
      return {
        id: building.id,
        type: building.type,
        gridX: building.gridX,
        gridY: building.gridY,
        level: building.level ?? 1,
        upgradingTo: building.upgradingTo ?? null,
        upgradeEndsAt: building.upgradeEndsAt ?? null,
        maxLevel
      }
    })
    const presentTypes = new Set(buildings.map(building => building.type))
    return {
      total: buildings.length,
      buildings,
      missingTypes: Object.keys(BUILDING_DEFINITIONS).filter(type => !presentTypes.has(type)),
      belowNearMax: buildings.filter(b => b.level < Math.max(1, b.maxLevel - 1)),
      belowMax: buildings.filter(b => b.level !== b.maxLevel),
      pending: buildings.filter(b => b.upgradingTo !== null)
    }
  }, userId)
}

async function trainArmy(page) {
  return page.evaluate(async wishlist => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const { SpriteBank } = await import('/src/game/render/SpriteBank.ts')
    const { armySpaceUsed, campCapacityOf } = await import('/src/game/config/Economy.ts')
    const results = []
    for (const [type, count] of wishlist) {
      const transaction = await Backend.trainTroop(type, count)
      if (!transaction) throw new Error(`Backend.trainTroop rejected ${type} x${count}`)
      results.push({ type, count, acknowledged: transaction.army[type] ?? 0 })
    }
    await window.__clashGM.loadBase()
    const scene = window.__clashGame.scene.keys.MainScene
    await SpriteBank.waitUntilSettled()
    await SpriteBank.ensureUnits(scene, [
      ...wishlist.map(([unit]) => ({ kind: 'troops', unit })),
      { kind: 'villagers', unit: 'merchant' },
      { kind: 'villagers', unit: 'stall' }
    ])
    const world = Backend.getCachedWorld(scene.userId)
    return {
      results,
      army: { ...(world?.army ?? {}) },
      housingUsed: armySpaceUsed(world?.army ?? {}),
      housingCapacity: campCapacityOf(world?.buildings ?? [])
    }
  }, TRAINED_ARMY)
}

async function prepareMerchant(page) {
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.dayNight.setPhaseOverride(0.47)
    scene.time.timeScale = 8
    scene.villageLife.nextMerchantAt = scene.time.now - 1
  })
  await page.waitForFunction(() => Boolean(
    window.__clashGame?.scene?.keys?.MainScene?.villageLife?.merchant
  ), { timeout: 5_000, polling: 50 })
  await page.waitForFunction(() => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    return scene?.villageLife?.merchant?.state === 'trading'
  }, { timeout: 25_000, polling: 100 })
  return page.evaluate(async () => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.time.timeScale = 1
    const merchant = scene.villageLife.merchant
    merchant.leaveAt = scene.time.now + 120_000
    const { IsoUtils } = await import('/src/game/utils/IsoUtils.ts')
    const at = IsoUtils.cartToIso(merchant.x, merchant.y)
    return {
      state: merchant.state,
      x: merchant.x,
      y: merchant.y,
      screen: { x: at.x, y: at.y },
      stallVisible: merchant.stallGfx.visible,
      offerCount: merchant.offers.length
    }
  })
}

/* ------------------------ camera + proof telemetry ---------------------- */

async function installDirector(page) {
  return page.evaluate(async config => {
    const game = window.__clashGame
    const scene = game.scene.keys.MainScene
    const { IsoUtils } = await import('/src/game/utils/IsoUtils.ts')
    const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
    const center = IsoUtils.cartToIso(12.5, 12.5)
    const battleFocus = IsoUtils.cartToIso(12.5, 12.5)
    const maxLevels = Object.fromEntries(Object.entries(BUILDING_DEFINITIONS)
      .map(([type, def]) => [type, def.maxLevel ?? 1]))
    const camera = scene.cameras.main
    camera.stopFollow()
    camera.setZoom(config.homeZoom)
    camera.centerOn(center.x, center.y + 26)
    scene.input.enabled = false

    const audit = {
      frames: 0,
      maxCenterStep: 0,
      maxCenterStepAt: 0,
      maxZoomStep: 0,
      maxZoomStepAt: 0,
      maxNormalizedCenterStep60: 0,
      maxNormalizedZoomStep60: 0,
      cameraMoves: [],
      merchantTransitions: [],
      modeTransitions: [],
      upgradeSamples: [],
      maxNightFactor: 0,
      maxCampFigures: 0,
      campTypes: [],
      maxDestructionPct: 0,
      maxDestroyedBuildings: 0,
      visiblePhaserTextMax: 0,
      cloudCompositeFrames: 0,
      battleOverlayFound: false,
      battleOverlayHidden: false
    }
    let startedAt = 0
    let move = null
    let dusk = null
    let lastCamera = null
    let lastFrameAt = performance.now()
    let lastMerchant = '__unset__'
    let lastMode = '__unset__'
    let lastUpgradeSampleAt = 0
    let cloudTexture = null
    let cloudImage = null

    const smoother = t => t * t * t * (t * (t * 6 - 15) + 10)
    const director = {
      audit,
      center: { x: center.x, y: center.y + 26 },
      startedAt: 0,
      start() {
        startedAt = performance.now()
        this.startedAt = startedAt
      },
      elapsed() { return startedAt ? performance.now() - startedAt : 0 },
      moveTo(spec) {
        const activeScene = game.scene.keys.MainScene
        const activeCamera = activeScene.cameras.main
        move = {
          fromX: activeCamera.midPoint.x,
          fromY: activeCamera.midPoint.y,
          fromZoom: activeCamera.zoom,
          toX: spec.x,
          toY: spec.y,
          toZoom: spec.zoom,
          duration: Math.max(1, spec.duration),
          started: performance.now(),
          label: spec.label
        }
        audit.cameraMoves.push({
          atMs: this.elapsed(), label: spec.label,
          from: { x: move.fromX, y: move.fromY, zoom: move.fromZoom },
          to: { x: move.toX, y: move.toY, zoom: move.toZoom },
          durationMs: move.duration
        })
      },
      duskToNight(spec) {
        dusk = {
          from: spec.from,
          to: spec.to,
          duration: Math.max(1, spec.duration),
          started: performance.now()
        }
      }
    }

    const hideSceneTextAndTools = activeScene => {
      let visibleText = 0
      for (const child of activeScene.children?.list ?? []) {
        if (child?.type === 'Text') {
          if (child.visible) visibleText += 1
          child.setVisible(false)
        }
      }
      for (const key of [
        'selectionGraphics', 'rangeGraphics', 'deploymentGraphics',
        'ghostBuilding', 'gridGraphics', 'buildingHighlight'
      ]) activeScene[key]?.setVisible?.(false)
      audit.visiblePhaserTextMax = Math.max(audit.visiblePhaserTextMax, visibleText)
    }

    // CloudOverlay is a production DOM canvas above Phaser. MediaRecorder is
    // intentionally attached to the game canvas, so mirror those exact pixels
    // into a top-depth world image only while the shipped overlay exists. The
    // image is sized to camera.worldView (not scrollFactor 0), avoiding the
    // zoom-scaled fullscreen-overlay bug documented by MainScene.
    const compositeProductionClouds = (activeScene, activeCamera) => {
      const source = document.querySelector('.cloud-overlay .cloud-canvas')
      if (!(source instanceof HTMLCanvasElement) || !source.width || !source.height) {
        cloudImage?.setVisible(false)
        return
      }
      if (!cloudTexture || cloudTexture.width !== source.width || cloudTexture.height !== source.height) {
        cloudImage?.destroy()
        if (activeScene.textures.exists('fortress_finale_cloud_capture')) {
          activeScene.textures.remove('fortress_finale_cloud_capture')
        }
        cloudTexture = activeScene.textures.createCanvas(
          'fortress_finale_cloud_capture', source.width, source.height)
        if (!cloudTexture) throw new Error('could not create the cloud-transition capture texture')
        cloudTexture.context.imageSmoothingEnabled = false
        cloudTexture.setFilter(Phaser.Textures.FilterMode.NEAREST)
        cloudImage = activeScene.add.image(0, 0, 'fortress_finale_cloud_capture')
          .setOrigin(0.5)
          .setDepth(2_000_000_000)
      }
      cloudTexture.context.clearRect(0, 0, source.width, source.height)
      cloudTexture.context.drawImage(source, 0, 0)
      cloudTexture.refresh()
      cloudImage
        .setVisible(true)
        .setPosition(activeCamera.midPoint.x, activeCamera.midPoint.y)
        .setDisplaySize(activeCamera.width / activeCamera.zoom, activeCamera.height / activeCamera.zoom)
        .setDepth(2_000_000_000)
      audit.cloudCompositeFrames += 1
    }

    const pin = () => {
      const activeScene = game.scene.keys.MainScene
      const activeCamera = activeScene?.cameras?.main
      if (!activeCamera) return
      const battleOverlay = game.scene.keys.BattleOverlay
      if (battleOverlay) {
        audit.battleOverlayFound = true
        battleOverlay.scene.setVisible(false)
        audit.battleOverlayHidden = battleOverlay.sys.settings.visible === false
      }
      const now = performance.now()
      const elapsed = startedAt ? now - startedAt : 0
      activeCamera.stopFollow()
      activeScene.input.enabled = false

      if (move) {
        const raw = Math.max(0, Math.min(1, (now - move.started) / move.duration))
        const t = smoother(raw)
        activeCamera.setZoom(move.fromZoom + (move.toZoom - move.fromZoom) * t)
        activeCamera.centerOn(
          move.fromX + (move.toX - move.fromX) * t,
          move.fromY + (move.toY - move.fromY) * t
        )
      }
      if (dusk) {
        const raw = Math.max(0, Math.min(1, (now - dusk.started) / dusk.duration))
        activeScene.dayNight.setPhaseOverride(dusk.from + (dusk.to - dusk.from) * smoother(raw))
      }
      hideSceneTextAndTools(activeScene)
      compositeProductionClouds(activeScene, activeCamera)

      const current = {
        x: activeCamera.midPoint.x,
        y: activeCamera.midPoint.y,
        zoom: activeCamera.zoom
      }
      if (lastCamera) {
        const centerStep = Math.hypot(current.x - lastCamera.x, current.y - lastCamera.y) * current.zoom
        const zoomStep = Math.abs(current.zoom - lastCamera.zoom)
        const deltaMs = Math.max(1, now - lastFrameAt)
        const normalize60 = (1000 / 60) / deltaMs
        if (centerStep > audit.maxCenterStep) {
          audit.maxCenterStep = centerStep
          audit.maxCenterStepAt = elapsed
        }
        if (zoomStep > audit.maxZoomStep) {
          audit.maxZoomStep = zoomStep
          audit.maxZoomStepAt = elapsed
        }
        audit.maxNormalizedCenterStep60 = Math.max(
          audit.maxNormalizedCenterStep60, centerStep * normalize60)
        audit.maxNormalizedZoomStep60 = Math.max(
          audit.maxNormalizedZoomStep60, zoomStep * normalize60)
      }
      lastCamera = current
      lastFrameAt = now

      const life = activeScene.villageLife
      const merchantState = life?.merchant?.state ?? 'gone'
      if (merchantState !== lastMerchant) {
        audit.merchantTransitions.push({ atMs: elapsed, state: merchantState })
        lastMerchant = merchantState
      }
      if (activeScene.mode !== lastMode) {
        audit.modeTransitions.push({ atMs: elapsed, mode: activeScene.mode })
        lastMode = activeScene.mode
      }
      const campFigures = life?.campFigures ?? []
      audit.maxCampFigures = Math.max(audit.maxCampFigures, campFigures.length)
      audit.campTypes = [...new Set([...audit.campTypes, ...campFigures.map(f => f.type)])]
      audit.maxNightFactor = Math.max(audit.maxNightFactor, activeScene.dayNight.nightFactor())
      audit.maxDestructionPct = Math.max(
        audit.maxDestructionPct,
        typeof activeScene.currentDestructionPct === 'function'
          ? activeScene.currentDestructionPct() : 0)
      audit.maxDestroyedBuildings = Math.max(
        audit.maxDestroyedBuildings, Number(activeScene.destroyedBuildings) || 0)

      if (now - lastUpgradeSampleAt >= 120) {
        lastUpgradeSampleAt = now
        const sample = { pending: 0, maxed: 0, total: activeScene.buildings?.length ?? 0 }
        for (const building of activeScene.buildings ?? []) {
          if (building.upgradingTo) sample.pending += 1
          if ((building.level ?? 1) === (maxLevels[building.type] ?? 1)) sample.maxed += 1
        }
        const previous = audit.upgradeSamples[audit.upgradeSamples.length - 1]
        if (!previous || previous.pending !== sample.pending || previous.maxed !== sample.maxed
          || previous.total !== sample.total) {
          audit.upgradeSamples.push({ atMs: elapsed, ...sample })
        }
      }
      audit.frames += 1
    }

    game.events.on('prerender', pin)
    director.pin = pin
    director.destroy = () => game.events.off('prerender', pin)
    window.__fortressDirector = director
    pin()
    return {
      center: director.center,
      battleFocus: { x: battleFocus.x, y: battleFocus.y + 8 },
      canvas: { width: game.canvas.width, height: game.canvas.height }
    }
  }, { homeZoom: HOME_ZOOM })
}

async function hideBattleOverlay(page) {
  return page.evaluate(() => {
    const overlay = window.__clashGame?.scene?.keys?.BattleOverlay
    if (!overlay) return { found: false, hidden: false }
    overlay.scene.setVisible(false)
    return {
      found: true,
      hidden: overlay.sys.settings.visible === false,
      childCount: overlay.children?.list?.length ?? 0
    }
  })
}

async function moveCamera(page, spec) {
  await page.evaluate(value => window.__fortressDirector.moveTo(value), spec)
}

async function beginDusk(page, duration) {
  // Stop at warm early night instead of the blue-white deep-night peak. This
  // still triggers the real merchant/firefly/night routines while keeping the
  // production ADD light rigs subtle and source-colored in a dense fortress.
  await page.evaluate(ms => window.__fortressDirector.duskToNight({ from: 0.47, to: 0.65, duration: ms }), duration)
}

async function installRecorder(page, outputPath) {
  writeFileSync(outputPath, Buffer.alloc(0))
  let written = 0
  await page.exposeFunction('__fortressPush', chunk => {
    const buffer = Buffer.from(chunk, 'base64')
    appendFileSync(outputPath, buffer)
    written += buffer.length
  })
  await page.evaluate(config => {
    window.__fortressRecorder = {
      finished: false,
      start() {
        const canvas = document.querySelector('#game-container canvas') ?? document.querySelector('canvas')
        if (!canvas) throw new Error('no Phaser canvas to record')
        const stream = canvas.captureStream(config.fps)
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
          ? 'video/webm;codecs=vp9' : 'video/webm'
        const recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: config.bitrate
        })
        let sending = Promise.resolve()
        recorder.ondataavailable = event => {
          if (!event.data.size) return
          sending = sending.then(async () => {
            const bytes = new Uint8Array(await event.data.arrayBuffer())
            let binary = ''
            const step = 0x8000
            for (let i = 0; i < bytes.length; i += step) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
            }
            await window.__fortressPush(btoa(binary))
          })
        }
        recorder.onstop = () => {
          sending.then(() => { window.__fortressRecorder.finished = true })
        }
        this.recorder = recorder
        this.finished = false
        recorder.start(250)
      },
      stop() { this.recorder?.stop() }
    }
  }, { fps: FPS, bitrate: VIDEO_BITRATE })
  return { bytes: () => written }
}

/* --------------------- authoritative finale + raid ---------------------- */

async function planFinalBatches(page, userId) {
  return page.evaluate(async uid => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
    const world = Backend.getCachedWorld(uid)
    const batches = [[], [], [], []]
    for (const building of world?.buildings ?? []) {
      const max = BUILDING_DEFINITIONS[building.type]?.maxLevel ?? 1
      if ((building.level ?? 1) >= max) continue
      const cx = building.gridX + (BUILDING_DEFINITIONS[building.type]?.width ?? 1) / 2
      const cy = building.gridY + (BUILDING_DEFINITIONS[building.type]?.height ?? 1) / 2
      // Walls are a single authored cohort, so the north-west batch starts
      // their one real bulk upgrade. Other buildings cascade by quadrant.
      const index = building.type === 'wall'
        ? 0
        : (cx >= 12.5 ? 1 : 0) + (cy >= 12.5 ? 2 : 0)
      batches[index].push({
        id: building.id,
        type: building.type,
        gridX: building.gridX,
        gridY: building.gridY,
        from: building.level ?? 1,
        to: max
      })
    }
    return batches.map((items, index) => ({ index, items }))
  }, userId)
}

async function startFinalBatch(page, userId, batch) {
  return page.evaluate(async (uid, planned) => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
    const scene = window.__clashGame.scene.keys.MainScene
    const gm = window.__clashGM
    const world = Backend.getCachedWorld(uid)
    if (!world) throw new Error('missing cached world for final upgrade batch')
    const requested = new Set(planned.items.map(item => item.id))
    let wallVisualStarted = false
    const visualTargets = []

    for (const cached of world.buildings) {
      if (!requested.has(cached.id)) continue
      const max = BUILDING_DEFINITIONS[cached.type]?.maxLevel ?? 1
      const level = cached.level ?? 1
      if (level >= max || cached.upgradingTo) continue
      if (cached.type === 'wall') {
        if (!wallVisualStarted) {
          const live = scene.buildings.find(candidate => candidate.id === cached.id)
          if (live) {
            scene.selectedInWorld = live
            visualTargets.push({ id: live.id, type: live.type, target: gm.upgradeSelectedBuilding() })
          }
          wallVisualStarted = true
        }
        // Cohort mutation mirrors Backend.upgradeBuilding's wall branch.
        for (const wall of world.buildings) {
          if (wall.type === 'wall' && (wall.level ?? 1) === level) wall.level = level + 1
        }
        world.wallLevel = level + 1
        continue
      }

      cached.level = level + 1
      const live = scene.buildings.find(candidate => candidate.id === cached.id)
      if (live) {
        scene.selectedInWorld = live
        visualTargets.push({ id: live.id, type: live.type, target: gm.upgradeSelectedBuilding() })
      }
    }

    Backend.setCachedWorld(uid, world)
    Backend.markLayoutEdited(uid)
    // The transaction starts before the provisional scene work is rendered,
    // matching App.tsx's exact save-first / immediate-visual ordering.
    await Backend.saveNow(uid)
    scene.selectedInWorld = null
    const acknowledged = Backend.getCachedWorld(uid)
    const records = planned.items.map(item => {
      const building = acknowledged?.buildings.find(candidate => candidate.id === item.id)
      return {
        ...item,
        level: building?.level ?? null,
        upgradingTo: building?.upgradingTo ?? null,
        upgradeStartedAt: building?.upgradeStartedAt ?? null,
        upgradeEndsAt: building?.upgradeEndsAt ?? null
      }
    })
    return {
      index: planned.index,
      requested: planned.items.length,
      visualTargets,
      records,
      startedNonWalls: records.filter(record => record.type !== 'wall'
        && (record.upgradingTo === record.to || record.level === record.to)).length,
      wallsMaxed: records.filter(record => record.type === 'wall'
        && record.level === record.to).length,
      deadlines: records.map(record => Number(record.upgradeEndsAt)).filter(Number.isFinite)
    }
  }, userId, batch)
}

async function materializeFinalAuthority(page, userId) {
  return page.evaluate(async uid => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const world = await Backend.forceLoadFromCloud(uid)
    await window.__clashGM.loadBase()
    return { revision: world?.revision ?? null, count: world?.buildings?.length ?? 0 }
  }, userId)
}

async function worldSignature(page, userId, practice = false) {
  return page.evaluate(async (uid, fromPractice) => {
    if (fromPractice) {
      const scene = window.__clashGame.scene.keys.MainScene
      return scene.buildings
        .filter(building => building.owner === 'ENEMY')
        .map(b => `${b.id}|${b.type}|${b.gridX},${b.gridY}|${b.level ?? 1}`)
        .sort()
    }
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const world = await Backend.forceLoadFromCloud(uid)
    return (world?.buildings ?? [])
      .map(b => `${b.id}|${b.type}|${b.gridX},${b.gridY}|${b.level ?? 1}`)
      .sort()
  }, userId, practice)
}

async function startPractice(page) {
  const requestedAt = Date.now()
  await page.evaluate(() => window.__clashGM.startPracticeAttack())
  await page.waitForSelector('.cloud-overlay', { visible: true, timeout: 3_000 })
  const coveredAt = Date.now()
  await page.waitForFunction(() => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    return scene?.mode === 'ATTACK'
      && scene?.currentEnemyWorld?.id === 'practice'
      && scene?.buildings?.some(building => building.owner === 'ENEMY')
  }, { timeout: 15_000, polling: 80 })
  const worldReadyAt = Date.now()
  // Let the real React/CSS cloud bank part before the troops land. The
  // loading percentage is hidden by CSS, but the shipped cloud art is intact.
  await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 8_000 })
  const revealedAt = Date.now()
  const sceneAudit = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    return {
      mode: scene.mode,
      enemyId: scene.currentEnemyWorld?.id ?? null,
      enemyBuildings: scene.buildings.filter(b => b.owner === 'ENEMY').length,
      initialEnemyBuildings: scene.initialEnemyBuildings,
      initialEnemyScoringHP: scene.initialEnemyScoringHP
    }
  })
  return {
    ...sceneAudit,
    cloudWipe: {
      requestedToCoverMs: coveredAt - requestedAt,
      coveredToWorldReadyMs: worldReadyAt - coveredAt,
      visibleMs: revealedAt - coveredAt
    }
  }
}

async function deployOne(page, plan, index) {
  return page.evaluate((deployment, order) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const gm = window.__clashGM
    const unit = deployment.type
    const armyBefore = gm.getArmy()[unit] ?? 0
    if (scene.mode !== 'ATTACK' || armyBefore <= 0) {
      return { type: unit, ok: false, reason: 'unavailable', armyBefore }
    }
    // Normal input permits any in-bounds point outside the per-building red
    // zones. Start at the authored wall openings instead of the map border:
    // max-level slow troops should fight, not spend half the commercial hiking.
    const lane = Number(deployment.lane) || 0
    const rear = Math.max(0, Number(deployment.rear) || 0)
    const anchors = {
      west: { x: 0.75 - rear, y: 12 + lane },
      east: { x: 24.25 + rear, y: 12 + lane },
      north: { x: 12 + lane, y: 0.75 - rear },
      south: { x: 12 + lane, y: 24.25 + rear }
    }
    const anchor = anchors[deployment.front] ?? anchors.west
    const candidates = []
    for (let radius = 0; radius <= 3; radius += 1) {
      const d = radius * 0.45
      candidates.push(
        { x: anchor.x, y: anchor.y },
        { x: anchor.x + d, y: anchor.y },
        { x: anchor.x - d, y: anchor.y },
        { x: anchor.x, y: anchor.y + d },
        { x: anchor.x, y: anchor.y - d }
      )
    }
    // Close-ring fallbacks remain ordinary legal deploys; the distant border
    // is last resort only, never the authored composition.
    for (let offset = 0; offset < 18; offset += 1) {
      const p = 4 + ((order * 5 + offset * 3) % 17)
      candidates.push(
        { x: p, y: 4.25 }, { x: 20.75, y: p },
        { x: 24 - p, y: 20.75 }, { x: 4.25, y: 24 - p }
      )
    }
    const point = candidates.find(candidate => !scene.isDeployForbidden(candidate.x, candidate.y))
    if (!point) return { type: unit, ok: false, reason: 'no-legal-border-point', armyBefore }
    const troop = scene.spawnTroop(point.x, point.y, unit, 'PLAYER')
    if (!troop) return { type: unit, ok: false, reason: 'spawn-rejected', armyBefore, point }
    // This is the second half of the normal SceneInputController deployment
    // pair. It debits the trained army instead of merely drawing a QA troop.
    gm.deployTroop(unit)
    return {
      type: unit,
      ok: true,
      troopId: troop.id,
      level: troop.level,
      point,
      armyBefore,
      deployedCount: scene.deployedThisBattle[unit] ?? 0
    }
  }, plan, index)
}

async function battleStatus(page) {
  return page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const enemies = scene.buildings.filter(building => building.owner === 'ENEMY')
    return {
      mode: scene.mode,
      enemyId: scene.currentEnemyWorld?.id ?? null,
      destroyedBuildings: Number(scene.destroyedBuildings) || 0,
      destructionPct: typeof scene.currentDestructionPct === 'function'
        ? scene.currentDestructionPct() : 0,
      aliveNonWalls: enemies.filter(b => b.type !== 'wall' && b.health > 0 && !b.isDestroyed).length,
      destroyedTypes: [...new Set(enemies
        .filter(b => b.health <= 0 || b.isDestroyed)
        .map(b => b.type))],
      livePlayerTroops: scene.troops.filter(troop => troop.owner === 'PLAYER' && troop.health > 0).length,
      deployedThisBattle: { ...scene.deployedThisBattle },
      raidEndScheduled: Boolean(scene.raidEndScheduled),
      armyAfter: { ...window.__clashGM.getArmy() }
    }
  })
}

function transcode(webmPath, mp4Path) {
  const result = spawnSync(FFMPEG, [
    '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y',
    '-i', webmPath,
    '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '14',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart',
    mp4Path
  ], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  assert(result.status === 0,
    `ffmpeg failed (code=${result.status}, signal=${result.signal}):\n${result.error?.stack ?? result.stderr}`)
}

/* --------------------------------- run ---------------------------------- */

let browser = null
let outputBytes = 0
try {
  const { token, userId } = await authenticate()
  await api('POST', '/player/banner', {
    token,
    body: { banner: { palette: 2, emblem: 1, pattern: 0 } }
  })

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--use-gl=swiftshader',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--force-device-scale-factor=1',
      `--window-size=${WIDTH},${HEIGHT}`
    ]
  })
  const page = await browser.newPage()
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`))
  page.on('error', error => browserErrors.push(`page crash: ${error.message}`))
  await page.evaluateOnNewDocument(value => {
    localStorage.setItem('clash.device.token', value)
  }, token)
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    return Boolean(scene?.worldMap && scene?.dayNight && scene?.villageLife
      && scene?.cameras?.main && scene?.buildings?.length)
  }, { timeout: 60_000, polling: 250 })
  await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 25_000 }).catch(() => {})
  await resolveBannerGate(page)
  await page.addStyleTag({ content: `
    html, body, #root, .app-container, #game-container {
      margin: 0 !important; width: 100% !important; height: 100% !important;
      overflow: hidden !important; background: #111 !important;
    }
    .app-container > :not(#game-container):not(.cloud-overlay),
    .village-bubble-layer, .plot-bubble, .building-bubble,
    [class*="toast"], [class*="modal"], [class*="hud"], [class*="panel"] {
      opacity: 0 !important; visibility: hidden !important;
      pointer-events: none !important;
    }
    /* The production cloud canvas is part of the transition, not HUD. Keep
       its wipe, but suppress its numeric loading panel and every text layer. */
    .cloud-overlay {
      opacity: 1 !important; visibility: visible !important;
      pointer-events: none !important;
    }
    .cloud-loading-panel { display: none !important; }
  ` })

  const untouched = await assertUntouchedStarter(page, userId)
  assert(untouched.ok,
    `refusing to mutate a non-starter account; use a fresh CLASH_DATA_DIR and TOKEN_CACHE. Found ${untouched.signature.join(', ')}`)
  assert(Object.values(untouched.army).every(count => !count),
    'starter account already has an army; use a fresh disposable trailer server')

  console.log('placing the valid fortress through the live Backend')
  const placement = await placeFortress(page, userId)
  console.log(`placed ${placement.placed.length} structures (${FORTRESS_WALLS.length} wall segments)`)

  console.log('pre-staging every upgradeable structure at max-1')
  const preStageWaves = await preStageNearMax(page, userId)
  const nearMaxAudit = await auditLevels(page, userId)
  assert(nearMaxAudit.belowNearMax.length === 0,
    `${nearMaxAudit.belowNearMax.length} buildings failed to reach max-1`)
  assert(nearMaxAudit.pending.length === 0,
    `${nearMaxAudit.pending.length} pre-roll upgrades were still pending`)
  assert(nearMaxAudit.belowMax.length > 0,
    'pre-roll accidentally maxed the whole village; no finale remained')
  assert(nearMaxAudit.belowMax.every(building => building.level === building.maxLevel - 1),
    'near-max village contains a building more than one level below max')
  assert(nearMaxAudit.missingTypes.length === 0,
    `fortress is missing building types: ${nearMaxAudit.missingTypes.join(', ')}`)

  console.log(`training the 150-space heavy army and settling ${CAMP_FIGURE_TARGET} camp figures`)
  const armyAudit = await trainArmy(page)
  assert(armyAudit.housingUsed === 150,
    `expected a full 150 housing, got ${armyAudit.housingUsed}`)
  assert(armyAudit.housingUsed <= armyAudit.housingCapacity,
    `trained army exceeds housing (${armyAudit.housingUsed}/${armyAudit.housingCapacity})`)
  await page.waitForFunction(expected => {
    const figures = window.__clashGame?.scene?.keys?.MainScene?.villageLife?.campFigures ?? []
    return figures.length === expected
  }, { timeout: 12_000, polling: 100 }, CAMP_FIGURE_TARGET)

  console.log('letting the real merchant arrive, build the stall and begin trading')
  const merchantAudit = await prepareMerchant(page)
  assert(merchantAudit.offerCount === 3 && merchantAudit.stallVisible,
    `merchant did not open a complete live stall: ${JSON.stringify(merchantAudit)}`)

  const directorSetup = await installDirector(page)
  assert(directorSetup.canvas.width === WIDTH && directorSetup.canvas.height === HEIGHT,
    `Phaser backing canvas is ${directorSetup.canvas.width}x${directorSetup.canvas.height}, expected ${WIDTH}x${HEIGHT}`)
  const battleOverlayBeforeRecording = await hideBattleOverlay(page)
  assert(battleOverlayBeforeRecording.found && battleOverlayBeforeRecording.hidden,
    `BattleOverlay was not hidden before recording: ${JSON.stringify(battleOverlayBeforeRecording)}`)
  await page.evaluate(async () => {
    const scene = window.__clashGame.scene.keys.MainScene
    await scene.worldMap.prime(scene.time.now)
  })
  await sleep(900)

  const webmPath = `${OUT}/${OUTPUT_NAME}.webm`
  const mp4Path = `${OUT}/${OUTPUT_NAME}.mp4`
  const reportPath = `${OUT}/${OUTPUT_NAME}-report.json`
  const recorder = await installRecorder(page, webmPath)
  await page.evaluate(() => {
    window.__fortressDirector.start()
    window.__fortressRecorder.start()
  })
  const recordingStartedAt = Date.now()

  // Shot 1: the varied standing army and an actual open market. Ease closer
  // to the stall; no selection, labels or HUD ever reach the canvas.
  await moveCamera(page, {
    x: merchantAudit.screen.x,
    y: merchantAudit.screen.y - 28,
    zoom: MERCHANT_ZOOM,
    duration: 2_000,
    label: 'merchant-trading-push'
  })
  await sleep(2_000)
  await page.screenshot({
    path: `${OUT}/${OUTPUT_NAME}-home.png`, type: 'png', captureBeyondViewport: false
  })

  // Shot 2: the real global day/night system crosses its bedtime threshold.
  // VillageLife observes that threshold itself, reverses the stall build, and
  // sends the merchant down his real return path. No departMerchant call.
  const duskDuration = 4_500
  await beginDusk(page, duskDuration)
  await moveCamera(page, {
    x: directorSetup.center.x,
    y: directorSetup.center.y,
    zoom: WIDE_ZOOM,
    duration: duskDuration,
    label: 'nightfall-reveal'
  })
  await sleep(duskDuration)
  await page.waitForFunction(() => {
    const state = window.__clashGame?.scene?.keys?.MainScene?.villageLife?.merchant?.state
    return state === 'leaving' || state === undefined || state === null
  }, { timeout: 4_000, polling: 50 })
  await sleep(800)

  // Shot 3: four spatially staggered server transactions. Every non-wall
  // shows its normal timed scaffold; the wall ring changes as one true cohort.
  const finalBatches = await planFinalBatches(page, userId)
  assert(finalBatches.length === 4 && finalBatches.every(batch => batch.items.length > 0),
    `final cascade did not produce four populated batches: ${JSON.stringify(finalBatches.map(b => b.items.length))}`)
  const upgradeStartedAt = Date.now()
  const batchAudits = []
  const deadlines = []
  await moveCamera(page, {
    x: directorSetup.center.x,
    y: directorSetup.center.y + 18,
    zoom: HOME_ZOOM,
    duration: 4_200,
    label: 'four-batch-max-cascade'
  })
  for (const batch of finalBatches) {
    const targetRequestAt = batch.index * BATCH_INTERVAL_MS
    const waitForCadence = targetRequestAt - (Date.now() - upgradeStartedAt)
    if (waitForCadence > 0) await sleep(waitForCadence)
    const requestedAtMs = Date.now() - upgradeStartedAt
    const audit = await startFinalBatch(page, userId, batch)
    batchAudits.push({
      ...audit,
      requestedAtMs,
      acknowledgedAtMs: Date.now() - upgradeStartedAt
    })
    deadlines.push(...audit.deadlines)
    if (batch.index === 1) {
      await page.screenshot({
        path: `${OUT}/${OUTPUT_NAME}-upgrade.png`, type: 'png', captureBeyondViewport: false
      })
    }
  }
  const batchStartSpanMs = batchAudits.at(-1).requestedAtMs - batchAudits[0].requestedAtMs
  const finalDeadline = deadlines.length ? Math.max(...deadlines) : Date.now()
  const finalClockWait = Math.max(0, finalDeadline - Date.now())
  assert(finalClockWait <= MAX_UPGRADE_CLOCK_MS,
    `final authoritative clock is ${finalClockWait}ms; expected <=${MAX_UPGRADE_CLOCK_MS}ms`)
  await sleep(finalClockWait + 120)
  let finalAuthority = await materializeFinalAuthority(page, userId)
  await sleep(350)
  let maxAudit = await auditLevels(page, userId)
  const recoveryBatches = []
  // Belt-and-suspenders finalization: if an authority race ever survives the
  // scheduled cascade, buy only the still-low rows one level at a time and
  // re-read authority. The max screenshot is never taken on trust.
  for (let attempt = 0; attempt < 3 && maxAudit.belowMax.length > 0; attempt += 1) {
    const recoveryPlan = {
      index: finalBatches.length + attempt,
      items: maxAudit.belowMax.map(building => ({
        id: building.id,
        type: building.type,
        gridX: building.gridX,
        gridY: building.gridY,
        from: building.level,
        to: building.maxLevel
      }))
    }
    const recovery = await startFinalBatch(page, userId, recoveryPlan)
    recoveryBatches.push(recovery)
    const recoveryDeadline = recovery.deadlines.length
      ? Math.max(...recovery.deadlines) : Date.now()
    await sleep(Math.max(0, recoveryDeadline - Date.now()) + 90)
    finalAuthority = await materializeFinalAuthority(page, userId)
    await sleep(180)
    maxAudit = await auditLevels(page, userId)
  }
  const upgradeCompletedAt = Date.now()
  const materializationLatencyMs = upgradeCompletedAt - upgradeStartedAt
  await page.screenshot({
    path: `${OUT}/${OUTPUT_NAME}-max.png`, type: 'png', captureBeyondViewport: false
  })

  // A clean hero hold proves the endpoint before the same authority snapshot
  // is handed to practice mode.
  await moveCamera(page, {
    x: directorSetup.center.x,
    y: directorSetup.center.y + 12,
    zoom: HOME_ZOOM + 0.05,
    duration: 900,
    label: 'fully-maxed-hold'
  })
  await sleep(1_450)
  const homeSignature = await worldSignature(page, userId, false)

  // Shot 4: gameManager.startPracticeAttack is the production entry point.
  // It reloads this exact authority snapshot as the enemy village.
  await moveCamera(page, {
    x: directorSetup.center.x,
    y: directorSetup.center.y + 20,
    zoom: WIDE_ZOOM + 0.02,
    duration: 1_200,
    label: 'practice-transition-settle'
  })
  const practiceAudit = await startPractice(page)
  const battleOverlayBeforeAttack = await hideBattleOverlay(page)
  assert(battleOverlayBeforeAttack.found && battleOverlayBeforeAttack.hidden,
    `BattleOverlay was not hidden before attack: ${JSON.stringify(battleOverlayBeforeAttack)}`)
  const practiceSignature = await worldSignature(page, userId, true)
  const samePracticeBase = JSON.stringify(homeSignature) === JSON.stringify(practiceSignature)

  // Deploy the exact trained roster using the same two calls as pointer input:
  // live spawn followed by GameManager's army debit.
  await moveCamera(page, {
    x: directorSetup.battleFocus.x,
    y: directorSetup.battleFocus.y,
    zoom: BATTLE_ZOOM,
    duration: 3_400,
    label: 'heavy-siege-assault-push'
  })
  const deployments = []
  for (let index = 0; index < DEPLOY_PLAN.length; index += 1) {
    deployments.push(await deployOne(page, DEPLOY_PLAN[index], index))
    await sleep(95)
  }
  // Let the eased hero push reach a readable ~1.15x before the proof still.
  await sleep(800)
  await page.screenshot({
    path: `${OUT}/${OUTPUT_NAME}-battle.png`, type: 'png', captureBeyondViewport: false
  })

  const battleStartedAt = Date.now()
  let polledStatus = await battleStatus(page)
  let lastAttackStatus = null
  let peakAttackStatus = null
  const rememberAttackStatus = snapshot => {
    if (snapshot.mode !== 'ATTACK') return
    lastAttackStatus = snapshot
    if (!peakAttackStatus || snapshot.destructionPct > peakAttackStatus.destructionPct) {
      peakAttackStatus = snapshot
    }
  }
  rememberAttackStatus(polledStatus)
  let secondBattleMoveStarted = false
  while (Date.now() - battleStartedAt < BATTLE_MAX_MS) {
    const elapsed = Date.now() - battleStartedAt
    polledStatus = await battleStatus(page)
    if (polledStatus.mode !== 'ATTACK') break
    rememberAttackStatus(polledStatus)
    // End-of-raid statistics are reset during goHome(). Stop inside the real
    // two-second grace while the ruined enemy base is still on screen; HOME
    // state must never masquerade as a successful zero-survivor attack.
    if (polledStatus.raidEndScheduled) break
    if (!secondBattleMoveStarted && elapsed >= 5_000) {
      secondBattleMoveStarted = true
      await moveCamera(page, {
        x: directorSetup.center.x,
        y: directorSetup.center.y + 18,
        zoom: 0.90,
        duration: 5_000,
        label: 'battle-destruction-pullback'
      })
    }
    if (elapsed >= BATTLE_MIN_MS
      && (polledStatus.aliveNonWalls === 0 || polledStatus.destructionPct >= 70)) break
    await sleep(200)
  }
  const terminalStatus = await battleStatus(page)
  rememberAttackStatus(terminalStatus)
  const status = peakAttackStatus ?? lastAttackStatus ?? terminalStatus
  const battleElapsedMs = Date.now() - battleStartedAt
  // Preserve a visual proof of the real ATTACK endpoint before the raid grace
  // can return HOME and clear combat state. This is intentionally separate
  // from the initial deployment still.
  await sleep(200)
  await page.screenshot({
    path: `${OUT}/${OUTPUT_NAME}-destroyed.png`, type: 'png', captureBeyondViewport: false
  })
  await sleep(100)

  await page.evaluate(() => window.__fortressRecorder.stop())
  await page.waitForFunction(() => window.__fortressRecorder.finished === true,
    { timeout: 90_000, polling: 100 })
  outputBytes = recorder.bytes()
  const durationSeconds = (Date.now() - recordingStartedAt) / 1_000
  const directorAudit = await page.evaluate(() => window.__fortressDirector.audit)
  const uiAudit = await page.evaluate(() => {
    const visibleDomText = [...document.querySelectorAll('body *')].filter(element => {
      if (element.closest('#game-container')) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const ownText = [...element.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent ?? '')
        .join('')
        .trim()
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
        && ownText.length > 0
    }).length
    const visiblePhaserText = (window.__clashGame.scene.keys.MainScene.children?.list ?? [])
      .filter(child => child?.type === 'Text' && child.visible).length
    const overlay = window.__clashGame.scene.keys.BattleOverlay
    return {
      visibleDomText,
      visiblePhaserText,
      battleOverlayFound: Boolean(overlay),
      battleOverlayVisible: overlay?.sys?.settings?.visible ?? null
    }
  })

  transcode(webmPath, mp4Path)

  const uniqueDeployedTypes = [...new Set(deployments.filter(item => item.ok).map(item => item.type))]
  const merchantStates = directorAudit.merchantTransitions.map(item => item.state)
  const report = {
    output: { webmPath, mp4Path, bytes: outputBytes, width: WIDTH, height: HEIGHT, fps: FPS },
    durationSeconds,
    server: { base: BASE, fixedClockLimitMs: MAX_UPGRADE_CLOCK_MS },
    untouchedStarter: untouched,
    placement: {
      authorityCount: placement.authorityCount,
      requested: placement.placed.length,
      wallSegments: FORTRESS_WALLS.length
    },
    preStageWaves,
    nearMax: {
      total: nearMaxAudit.total,
      belowMax: nearMaxAudit.belowMax.length,
      missingTypes: nearMaxAudit.missingTypes
    },
    army: {
      ...armyAudit,
      campFigureTarget: CAMP_FIGURE_TARGET,
      campTypeTarget: CAMP_TYPE_TARGET
    },
    merchant: { initial: merchantAudit, transitions: directorAudit.merchantTransitions },
    finalUpgrade: {
      batches: batchAudits,
      recoveryBatches,
      batchStartSpanMs,
      materializationLatencyMs,
      finalAuthority,
      total: maxAudit.total,
      belowMax: maxAudit.belowMax,
      pending: maxAudit.pending,
      missingTypes: maxAudit.missingTypes
    },
    practice: {
      ...practiceAudit,
      exactAuthoritySignature: samePracticeBase,
      signatureRows: homeSignature.length
    },
    battle: {
      deployments,
      uniqueDeployedTypes,
      status,
      lastAttackStatus,
      peakAttackStatus,
      terminalStatus,
      elapsedMs: battleElapsedMs
    },
    cameraAndScene: directorAudit,
    uiAudit: {
      ...uiAudit,
      beforeRecording: battleOverlayBeforeRecording,
      beforeAttack: battleOverlayBeforeAttack
    },
    browserErrors
  }

  const failures = []
  if (durationSeconds < 25 || durationSeconds > 80) {
    failures.push(`duration ${durationSeconds.toFixed(2)}s is outside the 25-80s finale envelope`)
  }
  if (outputBytes < 1_000_000) failures.push(`encoded WebM is suspiciously small (${outputBytes} bytes)`)
  if (!merchantStates.includes('trading') || !merchantStates.includes('packing') || !merchantStates.includes('leaving')) {
    failures.push(`merchant lifecycle incomplete: ${merchantStates.join(' -> ')}`)
  }
  const tradingIndex = merchantStates.indexOf('trading')
  const packingIndex = merchantStates.indexOf('packing')
  const leavingIndex = merchantStates.indexOf('leaving')
  if (!(tradingIndex >= 0 && packingIndex > tradingIndex && leavingIndex > packingIndex)) {
    failures.push(`merchant lifecycle order invalid: ${merchantStates.join(' -> ')}`)
  }
  // This cut intentionally stops in warm early night so the production light
  // rigs stay source-colored instead of blooming white at their deep-night
  // peak. The merchant/firefly threshold is still crossed decisively.
  if (directorAudit.maxNightFactor < 0.62) {
    failures.push(`night never became deep enough (${directorAudit.maxNightFactor.toFixed(3)})`)
  }
  if (directorAudit.maxCampFigures < CAMP_FIGURE_TARGET
    || directorAudit.campTypes.length < CAMP_TYPE_TARGET) {
    failures.push(`standing army coverage was ${directorAudit.maxCampFigures} figures / ${directorAudit.campTypes.length} types`)
  }
  if (batchAudits.length !== 4
    || batchAudits.some(batch => batch.startedNonWalls + batch.wallsMaxed <= 0)) {
    failures.push('one or more final authoritative upgrade batches had no acknowledged target')
  }
  if (batchStartSpanMs < 2_400 || batchStartSpanMs > 4_000) {
    failures.push(`authoritative batch start cascade spanned ${batchStartSpanMs}ms instead of roughly 3s`)
  }
  if (maxAudit.belowMax.length || maxAudit.pending.length || maxAudit.missingTypes.length) {
    failures.push(`final authority was not fully maxed: below=${maxAudit.belowMax.length}, pending=${maxAudit.pending.length}, missing=${maxAudit.missingTypes.join(',')}`)
  }
  if (!samePracticeBase) failures.push('practice mode did not instantiate the exact final authority snapshot')
  if (directorAudit.cloudCompositeFrames < 15 || practiceAudit.cloudWipe.visibleMs < 500) {
    failures.push(`production cloud wipe was not captured long enough (${directorAudit.cloudCompositeFrames} game frames / ${practiceAudit.cloudWipe.visibleMs}ms)`)
  }
  if (uniqueDeployedTypes.length < CAMP_TYPE_TARGET) {
    failures.push(`only ${uniqueDeployedTypes.length} distinct trained troop types deployed`)
  }
  if (deployments.some(item => !item.ok)) {
    failures.push(`one or more trained deployments failed: ${JSON.stringify(deployments.filter(item => !item.ok))}`)
  }
  const reachedDestructionTarget = peakAttackStatus?.mode === 'ATTACK'
    && peakAttackStatus.destructionPct >= 70
  const clearedNonWallsInAttack = lastAttackStatus?.mode === 'ATTACK'
    && lastAttackStatus.aliveNonWalls === 0
  if (!reachedDestructionTarget && !clearedNonWallsInAttack) {
    failures.push(`practice assault failed in ATTACK state: peak=${peakAttackStatus?.destructionPct?.toFixed(1) ?? 'none'}%, lastAlive=${lastAttackStatus?.aliveNonWalls ?? 'none'}, terminalMode=${terminalStatus.mode}`)
  }
  if (directorAudit.maxNormalizedCenterStep60 > 5.0) {
    failures.push(`camera center motion exceeded smooth threshold (${directorAudit.maxNormalizedCenterStep60.toFixed(2)} px/60fps frame)`)
  }
  if (directorAudit.maxNormalizedZoomStep60 > 0.006) {
    failures.push(`camera zoom motion exceeded smooth threshold (${directorAudit.maxNormalizedZoomStep60.toFixed(5)}/60fps frame)`)
  }
  if (uiAudit.visibleDomText || uiAudit.visiblePhaserText
    || !battleOverlayBeforeRecording.hidden || !battleOverlayBeforeAttack.hidden
    || !directorAudit.battleOverlayFound || !directorAudit.battleOverlayHidden
    || uiAudit.battleOverlayVisible !== false) {
    failures.push(`text/UI overlay was not fully suppressed: ${JSON.stringify({
      uiAudit,
      battleOverlayBeforeRecording,
      battleOverlayBeforeAttack,
      director: {
        found: directorAudit.battleOverlayFound,
        hidden: directorAudit.battleOverlayHidden
      }
    })}`)
  }
  if (browserErrors.length) failures.push(`browser errors:\n${browserErrors.join('\n')}`)
  report.failures = failures
  writeFileSync(reportPath, JSON.stringify(report, null, 2))

  console.log(`captured ${OUTPUT_NAME}.mp4 (${durationSeconds.toFixed(2)}s, ${(outputBytes / 1e6).toFixed(1)} MB WebM source)`)
  console.log(`merchant: ${merchantStates.join(' -> ')}`)
  console.log(`max cascade: ${batchStartSpanMs}ms start span, ${materializationLatencyMs}ms through final authority`)
  console.log(`practice: ${uniqueDeployedTypes.length} troop types, ${status.destroyedBuildings} buildings, ${status.destructionPct.toFixed(1)}%`)
  assert(failures.length === 0, `fortress finale proof failed:\n- ${failures.join('\n- ')}`)
} finally {
  await browser?.close()
}
