// ONE continuous CoC-ad-style shot: the starter hamlet grows into a maxed
// concentric ring fortress — every building placed live, walls rising then
// upgrading level by level as a cohort, troops mustering at the camps.
// Captured at 1080p60 / 40 Mbps VP9 off the real Phaser canvas.
//
//   CLASH_DATA_DIR=<fresh dir> npx vite --port 5174 ...
//   BASE=http://127.0.0.1:5174 node tools/trailer/record-progression.mjs
import puppeteer from 'puppeteer-core'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5174'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = (process.env.OUT ?? new URL('./clips/', import.meta.url).pathname).replace(/\/$/, '')
const WIDTH = Number(process.env.WIDTH ?? 1920)
const HEIGHT = Number(process.env.HEIGHT ?? 1080)
const TOKEN_CACHE = new URL('./.trailer-device-token.json', import.meta.url).pathname

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
  { type: 'storage', spots: [[11, 17], [10, 17], [12, 17]] },
  { type: 'storage', spots: [[5, 11], [5, 10], [5, 12]] },
  { type: 'storage', spots: [[17, 11], [17, 10], [17, 12]] },
  { type: 'xbow', spots: [[17, 5], [16, 5], [17, 6]] },
  { type: 'xbow', spots: [[5, 17], [6, 17], [5, 16]] },
  { type: 'xbow', spots: [[17, 17], [16, 17], [17, 16]] },
  { type: 'mortar', spots: [[10, 7], [13, 7], [7, 10]] },
  { type: 'mortar', spots: [[13, 16], [12, 17], [16, 13]] },
  { type: 'mortar', spots: [[7, 13], [7, 12], [16, 10]] },
  { type: 'ballista', spots: [[7, 5], [14, 5], [5, 7]] },
  { type: 'ballista', spots: [[16, 13], [16, 14], [13, 5]] },
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

async function glide(page, spec) {
  await page.evaluate(async config => {
    const scene = window.__clashGame.scene.keys.MainScene
    const camera = scene.cameras.main
    if (config.fromZoom !== undefined) camera.setZoom(config.fromZoom)
    if (config.fromX !== undefined) camera.centerOn(config.fromX, config.fromY)
    await new Promise(resolve => {
      const start = { zoom: camera.zoom, x: camera.midPoint.x, y: camera.midPoint.y }
      const end = {
        zoom: config.toZoom ?? start.zoom,
        x: config.toX ?? start.x,
        y: config.toY ?? start.y
      }
      scene.tweens.addCounter({
        from: 0,
        to: 1,
        duration: config.duration,
        ease: config.ease ?? 'Sine.easeInOut',
        onUpdate: tween => {
          const t = tween.getValue()
          camera.setZoom(start.zoom + (end.zoom - start.zoom) * t)
          camera.centerOn(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t)
        },
        onComplete: resolve
      })
    })
  }, spec)
}

async function placeBatch(page, userId, batch) {
  const placed = await page.evaluate(async (uid, wanted) => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const results = []
    for (const item of wanted) {
      let done = null
      for (const [x, y] of item.spots) {
        done = await Backend.placeBuilding(uid, item.type, x, y)
        if (done) break
      }
      results.push({ type: item.type, ok: Boolean(done) })
    }
    return results
  }, userId, batch)
  const failed = placed.filter(p => !p.ok)
  if (failed.length) console.warn('unplaced:', JSON.stringify(failed))
  await page.evaluate(() => window.__clashGM.loadBase())
}

async function placeWalls(page, userId, cells) {
  await page.evaluate(async (uid, list) => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    for (const [x, y] of list) await Backend.placeBuilding(uid, 'wall', x, y)
  }, userId, cells)
  await page.evaluate(() => window.__clashGM.loadBase())
}

/** One upgrade wave: every building climbs one level toward its max. */
async function upgradeWave(page, userId, token) {
  const pending = await page.evaluate(async uid => {
    const { Backend } = await import('/src/game/backend/GameBackend.ts')
    const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
    const world = Backend.getCachedWorld(uid)
    let remaining = 0
    for (const building of world.buildings) {
      const max = BUILDING_DEFINITIONS[building.type]?.maxLevel ?? 1
      const level = building.level ?? 1
      if (level >= max || building.upgradingTo) {
        if ((building.level ?? 1) < max) remaining += 1
        continue
      }
      building.level = level + 1
      if (building.level < max) remaining += 1
    }
    world.wallLevel = Math.max(1, ...world.buildings
      .filter(b => b.type === 'wall')
      .map(b => b.level ?? 1))
    Backend.setCachedWorld(uid, world)
    Backend.markLayoutEdited(uid)
    await Backend.saveNow(uid)
    return remaining
  }, userId)
  await sleep(1_500)
  await api('GET', '/world', { token })
  await page.evaluate(() => window.__clashGM.loadBase())
  await sleep(450)
  return pending
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

/* --------------------------------- run ----------------------------------- */

let browser = null
try {
  let cachedToken = null
  try {
    cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null
  } catch { /* minted below */ }
  const session = await api('POST', '/auth/session', { body: cachedToken ? { token: cachedToken } : {} })
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
  await sleep(1_000)

  const center = await page.evaluate(async () => {
    const { IsoUtils } = await import('/src/game/utils/IsoUtils.ts')
    return IsoUtils.cartToIso(12.5, 12.5)
  })

  const outputPath = `${OUT}/progression.webm`
  writeFileSync(outputPath, Buffer.alloc(0))
  let written = 0
  await page.exposeFunction('__trailerPush', chunk => {
    const buffer = Buffer.from(chunk, 'base64')
    appendFileSync(outputPath, buffer)
    written += buffer.length
  })
  await page.evaluate(RECORDER_SNIPPET)
  await page.evaluate(() => window.__trailer.start())

  // Opening: tight on the starter hamlet.
  await glide(page, {
    fromZoom: 1.55, fromX: center.x, fromY: center.y - 40,
    toZoom: 1.35, toX: center.x, toY: center.y,
    duration: 3_000
  })

  // Economy, then the war machine, arriving in rhythmic pops.
  await placeBatch(page, userId, ECONOMY.slice(0, 3))
  await sleep(900)
  await placeBatch(page, userId, ECONOMY.slice(3))
  await glide(page, { toZoom: 1.05, toX: center.x, toY: center.y, duration: 2_200 })
  await placeBatch(page, userId, MILITARY.slice(0, 4))
  await sleep(900)
  await placeBatch(page, userId, MILITARY.slice(4))
  await sleep(900)

  // The inner ring closes around the keep.
  await glide(page, { toZoom: 1.25, toX: center.x, toY: center.y - 30, duration: 1_600 })
  await placeWalls(page, userId, ringCells(INNER))
  await sleep(1_200)
  await placeBatch(page, userId, CORE)
  await sleep(900)

  // The defense band fills, then the outer enceinte seals the castle.
  await glide(page, { toZoom: 1.0, toX: center.x + 60, toY: center.y, duration: 2_400 })
  await placeBatch(page, userId, BAND.slice(0, 10))
  await sleep(900)
  await glide(page, { toZoom: 1.0, toX: center.x - 60, toY: center.y, duration: 2_400 })
  await placeBatch(page, userId, BAND.slice(10))
  await sleep(900)
  await glide(page, { toZoom: 0.82, toX: center.x, toY: center.y, duration: 2_000 })
  await placeWalls(page, userId, ringCells(OUTER))
  await sleep(1_500)

  // Upgrade waves: the whole fortress climbs level by level; walls change
  // dress as a cohort. Troops muster at the camps as they unlock.
  const drifts = [
    { toX: center.x + 90, toY: center.y - 50 },
    { toX: center.x - 90, toY: center.y + 50 },
    { toX: center.x + 60, toY: center.y + 60 },
    { toX: center.x - 60, toY: center.y - 60 }
  ]
  for (let wave = 0; wave < 10; wave += 1) {
    const drift = drifts[wave % drifts.length]
    void glide(page, { toZoom: 0.92, ...drift, duration: 1_900, ease: 'Linear' })
    const pending = await upgradeWave(page, userId, token)
    if (wave === 2) await train(token, [['warrior', 12], ['archer', 10]])
    if (wave === 4) await train(token, [['phalanx', 6]])
    if (wave === 7) {
      await train(token, [['warelephant', 2], ['trebuchet', 2], ['stormmage', 4]])
      await page.evaluate(() => window.__clashGM.loadBase())
    }
    if (pending === 0 && wave >= 8) break
  }

  // The finished castle: a slow, proud pull-out.
  await glide(page, { toZoom: 1.2, toX: center.x, toY: center.y - 20, duration: 2_600 })
  await sleep(1_200)
  await glide(page, { toZoom: 0.66, toX: center.x, toY: center.y + 30, duration: 4_200 })
  await sleep(2_000)

  await page.evaluate(() => window.__trailer.stop())
  await page.waitForFunction(() => window.__trailer.finished === true, { timeout: 90_000 })
  console.log(`captured progression.webm (${(written / 1e6).toFixed(1)} MB streamed)`)
} finally {
  await browser?.close()
}
