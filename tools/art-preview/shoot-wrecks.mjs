// Screenshot harness for per-building WRECKS (WreckRenderer): boots the game
// headless on :5302, lays every wreck type out across an empty lawn by calling
// the scene's createRubble hook directly (no battle needed), and captures
// wide framings + per-type close-ups, a tesla spark animation pair, a wall
// stub row at L1-4, and "cold" (fire faded) variants of the burning types.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5302'
const OUT = process.env.OUT ?? '/private/tmp/claude-502/-Users-andreboufama-Documents-clash-game/484e1e0f-e1a8-4d1b-8b10-bfb895c28559/scratchpad/verify/wrecks/'
const TAG = process.env.TAG ?? 'v1'
const PHASE = Number(process.env.PHASE ?? 0.3)

mkdirSync(OUT, { recursive: true })

// Wreck layout: [type, level, gridX, gridY, w, h] — 5-tile spacing on the 25x25 lawn.
const WRECKS = [
  ['town_hall', 1, 2, 2, 3, 3],
  ['mine', 3, 8, 2, 2, 2],
  ['farm', 2, 13, 2, 3, 2],
  ['storage', 3, 19, 2, 2, 2],

  ['barracks', 5, 2, 7, 2, 2],
  ['lab', 3, 7, 7, 2, 2],
  ['army_camp', 3, 12, 7, 3, 3],
  ['cannon', 3, 18, 7, 1, 1],
  ['ballista', 3, 21, 7, 2, 2],

  ['xbow', 3, 2, 12, 2, 2],
  ['mortar', 2, 7, 12, 2, 2],
  ['tesla', 2, 12, 12, 1, 1],
  ['prism', 4, 15, 12, 1, 1],
  ['spike_launcher', 4, 18, 12, 2, 2],
  ['watchtower', 3, 22, 12, 2, 2],

  ['dragons_breath', 2, 2, 17, 4, 4],
  ['frostfall', 4, 8, 17, 2, 2],
  ['jukebox', 1, 12, 17, 1, 1],

  ['wall', 1, 8, 21, 1, 1],
  ['wall', 2, 11, 21, 1, 1],
  ['wall', 3, 14, 21, 1, 1],
  ['wall', 4, 17, 21, 1, 1]
]

async function api(path, body, token) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {})
  })
  return res.json()
}

const session = await api('/auth/session')
const token = session.token
const world = session.world
// Keep the starter town hall (same id = free), MOVE it out of the wreck rows
// (moves are unpriced), and drop everything else (deletions refund).
const th = (world.buildings ?? []).find(b => b.type === 'town_hall')
if (!th) throw new Error('starter world has no town hall')
th.gridX = 21
th.gridY = 21
world.buildings = [th]
const saved = await api('/world/save', { world, requestId: `wreck-showcase-${Date.now()}` }, token)
const savedBuildings = saved?.world?.buildings ?? saved?.buildings
if (!Array.isArray(savedBuildings) || savedBuildings.length !== 1) {
  console.log('world save did not stick:', JSON.stringify(saved).slice(0, 300))
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})

const iso = (cx, cy) => [(cx - cy) * 32, (cx + cy) * 16]

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => {
    localStorage.setItem('clash.device.token', tok)
  }, token)
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction(
    () => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 45000, polling: 500 }
  )
  await new Promise(r => setTimeout(r, 1500))

  // Pin day phase + clear weather, then spawn every wreck via the scene hook.
  await page.evaluate(({ phase, wrecks }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(phase)
    s.weather.setWeatherOverride(0)
    for (const [type, level, gx, gy, w, h] of wrecks) {
      s.createRubble(gx, gy, w, h, type, level)
    }
    return s.rubble.length
  }, { phase: PHASE, wrecks: WRECKS })
  await new Promise(r => setTimeout(r, 800))

  const look = async (cx, cy, zoom, dy = -6) => {
    await page.evaluate(({ x, y, zoom, phase, wrecks }) => {
      const s = window.__clashGame.scene.keys.MainScene
      // A dev-server hot reload mid-run wipes scene state — re-pin and re-spawn.
      if (!s.rubble || s.rubble.length === 0) {
        s.dayNight.setPhaseOverride(phase)
        s.weather.setWeatherOverride(0)
        for (const [type, level, gx, gy, w, h] of wrecks) {
          s.createRubble(gx, gy, w, h, type, level)
        }
      }
      s.cameras.main.setZoom(zoom)
      s.cameras.main.centerOn(x, y)
    }, { x: cx, y: cy + dy, zoom, phase: PHASE, wrecks: WRECKS })
    await new Promise(r => setTimeout(r, 350))
  }

  // Two wide framings covering all wrecks
  await look(100, 220, 1.1, 0)
  await page.screenshot({ path: `${OUT}_wide-A-${TAG}.png` })
  await look(-200, 500, 1.1, 0)
  await page.screenshot({ path: `${OUT}_wide-B-${TAG}.png` })

  // Per-type close-ups
  for (const [type, level, gx, gy, w, h] of WRECKS) {
    const [x, y] = iso(gx + w / 2, gy + h / 2)
    const zoom = w >= 4 ? 1.8 : w >= 3 ? 2.2 : w >= 2 ? 3 : 4
    await look(x, y, zoom)
    await page.screenshot({
      path: `${OUT}${type}-L${level}-${TAG}.png`,
      clip: { x: 340, y: 150, width: 600, height: 600 }
    })
  }

  // Tesla spark animation proof: two frames ~400ms apart
  {
    const t = WRECKS.find(w => w[0] === 'tesla')
    const [x, y] = iso(t[2] + t[4] / 2, t[3] + t[5] / 2)
    await look(x, y, 4)
    await page.screenshot({ path: `${OUT}tesla-anim-1-${TAG}.png`, clip: { x: 340, y: 150, width: 600, height: 600 } })
    await new Promise(r => setTimeout(r, 400))
    await page.screenshot({ path: `${OUT}tesla-anim-2-${TAG}.png`, clip: { x: 340, y: 150, width: 600, height: 600 } })
  }

  // Wall stub row (L1-4) in one frame
  await look(-272, 552, 2.2, 0)
  await page.screenshot({ path: `${OUT}walls-L1-4-${TAG}.png` })

  // Cold pass: age everything past the 45s fire fade and reshoot the burners/animated
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.rubble.forEach(r => { r.createdAt -= 60000 })
  })
  await new Promise(r => setTimeout(r, 500))
  for (const type of ['town_hall', 'farm', 'army_camp', 'dragons_breath', 'tesla', 'frostfall']) {
    const t = WRECKS.find(w => w[0] === type)
    if (!t) continue
    const [x, y] = iso(t[2] + t[4] / 2, t[3] + t[5] / 2)
    const zoom = t[4] >= 4 ? 1.8 : t[4] >= 3 ? 2.2 : t[4] >= 2 ? 3 : 4
    await look(x, y, zoom)
    await page.screenshot({
      path: `${OUT}${type}-cold-${TAG}.png`,
      clip: { x: 340, y: 150, width: 600, height: 600 }
    })
  }

  console.log('wreck shots done →', OUT, 'page errors:', errors.length ? errors.slice(0, 3) : 'none')
} finally {
  await browser.close()
}
