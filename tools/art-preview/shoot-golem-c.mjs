// GOLEM DESIGN C ("Runebound Cairn") verification harness.
// Cribbed from shoot-troops.mjs / shoot-defenses.mjs. Boots the LIVE dev
// server page with the shared identity token (never mints a guest), forces
// the vector path (clash.sprites.off) + design slot C (clash.design.golem),
// spawns golems on the south lawn, pauses the scene and drives poses.
//
//   BASE=http://127.0.0.1:5175 OUT=<dir> node shoot-golem-c.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5175'
const OUT = (process.env.OUT ?? '/tmp/golem-c-work').replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

// ---- shared identity ONLY (guest creation is rate-limited + junks the map)
const TOKEN_CACHE = new URL('./.shared-device-token.json', import.meta.url).pathname
let cachedToken = null
try { cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null } catch { /* none */ }
if (!cachedToken) throw new Error('no shared device token — refusing to mint a guest session')
const session = await (await fetch(`${BASE}/api/auth/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: cachedToken })
})).json()
if (!session?.token) throw new Error(`auth/session resume failed: ${JSON.stringify(session)}`)
const token = session.token

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => {
    localStorage.setItem('clash.device.token', tok)
    localStorage.setItem('clash.sprites.off', '1')   // vector path = live design code
    localStorage.setItem('clash.design.golem', 'C')  // MY slot
  }, token)
  const errors = []
  page.on('pageerror', e => { errors.push(String(e.message).slice(0, 200)); console.log('PAGE ERROR:', String(e.message).slice(0, 200)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 90000, polling: 500 })
  await sleep(2500)

  // ---- spawn the cast live, root everyone, then pause
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather.setWeatherOverride(0)
    const cast = [
      // [x, y, owner, level, tag]
      [6, 14, 'PLAYER', 1], [9.2, 14, 'PLAYER', 2], [12.4, 14, 'PLAYER', 3],
      [6, 17.8, 'ENEMY', 1], [9.2, 17.8, 'ENEMY', 2], [12.4, 17.8, 'ENEMY', 3],
      [3.5, 19, 'PLAYER', 2],   // heading + walk + idle model
      [3.5, 22.5, 'PLAYER', 3]  // slam model
    ]
    for (const [x, y, owner, lvl] of cast) s.spawnTroop(x, y, 'golem', owner, lvl)
    for (const t of s.troops) { t.target = null; t.path = undefined; t.facingAngle = 0.9 }
    window.__G = idx => s.troops.filter(t => t.type === 'golem')[idx]
  })
  await sleep(900) // landing bounce settles (scale → 1)

  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const shot = (name, clip = { x: 340, y: 150, width: 600, height: 600 }) =>
    page.screenshot({ path: `${OUT}/${name}.png`, clip })
  const pause = () => page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  const resume = () => page.evaluate(() => window.__clashGame.scene.resume('MainScene'))

  // redraw golem idx with explicit state (works while paused)
  const poseGolem = (idx, { moving = false, slam = 0, facing = null } = {}) => page.evaluate(({ idx, moving, slam, facing }) => {
    const s = window.__clashGame.scene.keys.MainScene
    const t = window.__G(idx)
    if (!t) return `missing golem ${idx}`
    if (facing !== null) t.facingAngle = facing
    t.slamOffset = slam
    t.lastAttackTime = -1e7
    s.redrawTroopWithMovement(t, moving)
    return 'ok'
  }, { idx, moving, slam, facing })
  const poseAll = (facing) => page.evaluate((facing) => {
    const s = window.__clashGame.scene.keys.MainScene
    for (const t of s.troops) {
      if (t.type !== 'golem') continue
      if (facing !== null) t.facingAngle = facing
      t.slamOffset = 0
      t.lastAttackTime = -1e7
      s.redrawTroopWithMovement(t, false)
    }
  }, facing)

  await pause()
  await poseAll(0.9)

  // ---------- (1) level lineup, day: P row + E row --------------------------
  await cam(9.2, 16, 2.0, -6)
  await shot('lineup-day', { x: 240, y: 130, width: 800, height: 640 })
  // close-ups per level
  const spots = [[6, 14, 'P-L1'], [9.2, 14, 'P-L2'], [12.4, 14, 'P-L3'], [6, 17.8, 'E-L1'], [9.2, 17.8, 'E-L2'], [12.4, 17.8, 'E-L3']]
  for (const [x, y, tag] of spots) {
    await cam(x, y, 4.2, -22)
    await shot(`close-${tag}`, { x: 440, y: 250, width: 400, height: 420 })
  }

  // ---------- (2) 16 headings ----------------------------------------------
  await cam(3.5, 19, 4.2, -22)
  for (let k = 0; k < 16; k++) {
    const r = await poseGolem(6, { facing: (k * Math.PI * 2) / 16 })
    if (r !== 'ok') console.log(r)
    await shot(`heading-${String(k).padStart(2, '0')}`, { x: 460, y: 270, width: 360, height: 380 })
  }

  // ---------- (3) walk stride (resume slices across the 1000 ms cycle) -----
  for (let f = 0; f < 6; f++) {
    if (f > 0) { await resume(); await sleep(166); await pause() }
    const r = await poseGolem(6, { moving: true, facing: 0.9 })
    if (r !== 'ok') console.log(r)
    await shot(`walk-${f}`, { x: 460, y: 270, width: 360, height: 380 })
  }

  // ---------- (4) slam sequence (slamOffset drives everything) -------------
  await cam(3.5, 22.5, 4.2, -22)
  for (const [name, v] of [['0-stance', 0], ['1-drive', 4], ['2-drive', 8], ['3-impact', 12], ['4-settle', 7], ['5-settle', 2]]) {
    const r = await poseGolem(7, { slam: v, facing: 0.9 })
    if (r !== 'ok') console.log(r)
    await shot(`slam-${name}`, { x: 460, y: 250, width: 360, height: 400 })
  }
  await poseGolem(7, { slam: 0 })

  // ---------- (5) idle motion series (live, 500 ms apart over the 2 s loop) -
  await cam(3.5, 19, 4.2, -22)
  await poseGolem(6, { facing: 0.9 })
  for (let f = 0; f < 5; f++) {
    await resume(); await sleep(f === 0 ? 60 : 500); await pause()
    await page.evaluate(() => { const t = window.__G(6); t.slamOffset = 0; t.lastAttackTime = -1e7 })
    await poseGolem(6, { facing: 0.9 })
    await shot(`idle-${f}`, { x: 460, y: 270, width: 360, height: 380 })
  }

  // ---------- (6) night ------------------------------------------------------
  await resume()
  await page.evaluate(() => { window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.8) })
  await sleep(2200)
  await pause()
  await poseAll(0.9)
  await cam(9.2, 16, 2.3, -6)
  await shot('lineup-night', { x: 240, y: 130, width: 800, height: 640 })
  // L3 night portrait + slam on the clear south-west lawn (away from window
  // light pools that overexpose the sandstone)
  await cam(3.5, 22.5, 4.2, -22)
  await poseGolem(7, { facing: 0.9 })
  await shot('night-P-L3', { x: 440, y: 250, width: 400, height: 420 })
  await poseGolem(7, { slam: 12, facing: 0.9 })
  await shot('night-slam', { x: 460, y: 250, width: 360, height: 400 })
  await poseGolem(7, { slam: 0 })

  await resume()
  await page.evaluate(() => { window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.32) })
  console.log('golem-C shots →', OUT, 'errors:', errors.length ? errors : 'none')
} finally {
  await browser.close()
}
