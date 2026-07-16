// CLOCKWORK BEETLE design-A verification harness (cribbed from
// shoot-icegolem.mjs). Boots the LIVE dev page with the shared identity
// token (never mints a guest), forces the vector path (clash.sprites.off)
// and pins design slot A (clash.design.clockworkbeetle) BEFORE boot.
// Levels/palettes shoot through the scene's own redraw path; the stride
// series, arming ramp and 8-heading sweep draw through
// window.__clashBake.TroopRenderer with PINNED time/attackAge so every
// frame samples an exact phase.
//
//   BASE=http://127.0.0.1:5173 OUT=<dir> node shoot-clockworkbeetle-a.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = (process.env.OUT ?? '/tmp/beetle-a-work').replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

// ---- shared identity ONLY (guest creation is rate-limited + junks the map)
const TOKEN_CACHE = '/home/user/clash-game/tools/art-preview/.shared-device-token.json'
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
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => {
    localStorage.setItem('clash.device.token', tok)
    localStorage.setItem('clash.sprites.off', '1')            // vector path = live art code
    localStorage.setItem('clash.design.clockworkbeetle', 'A') // this design slot
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
      // level rows: player L1..L3 / enemy L1..L3
      [6, 14, 'PLAYER', 1], [8.5, 14, 'PLAYER', 2], [11, 14, 'PLAYER', 3],
      [6, 17, 'ENEMY', 1], [8.5, 17, 'ENEMY', 2], [11, 17, 'ENEMY', 3],
      // the pose model (stride / arming / headings)
      [16, 16, 'PLAYER', 2],
      // L3 model for the heading sweep
      [19, 19, 'PLAYER', 3]
    ]
    for (const [x, y, owner, lvl] of cast) s.spawnTroop(x, y, 'clockworkbeetle', owner, lvl)
    for (const t of s.troops) { t.target = null; t.path = undefined; t.facingAngle = 0.45 }
    window.__CB = idx => s.troops.filter(t => t.type === 'clockworkbeetle')[idx]
  })
  await sleep(900) // landing bounce settles

  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const shot = (name, clip = { x: 440, y: 250, width: 400, height: 400 }) =>
    page.screenshot({ path: `${OUT}/${name}.png`, clip })
  const pause = () => page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  const resume = () => page.evaluate(() => window.__clashGame.scene.resume('MainScene'))

  // Scene-path idle pose (uses the frozen scene clock — proves the wiring).
  const poseAll = () => page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    for (const t of s.troops) {
      if (t.type !== 'clockworkbeetle') continue
      t.lastAttackTime = -1e7
      s.redrawTroopWithMovement(t, false)
    }
  })

  // Pinned-phase draw through the bake bridge (exact time/attackAge/facing).
  const drawModel = (idx, opts) => page.evaluate(({ idx, opts }) => {
    const s = window.__clashGame.scene.keys.MainScene
    const t = window.__CB(idx)
    if (!t) return `missing beetle ${idx}`
    const TR = window.__clashBake.TroopRenderer
    const g = t.gameObject
    g.clear()
    TR.drawTroopVisual(
      g, 'clockworkbeetle', t.owner,
      opts.facing ?? 0.45, opts.moving ?? false, 0, 0, false, 0,
      opts.level ?? t.level ?? 1, opts.time ?? 1000,
      opts.age ?? -1, opts.delay ?? 500
    )
    return 'ok'
  }, { idx, opts })

  await pause()
  await poseAll()

  // ---------- (1) level/palette lineup, day --------------------------------
  await cam(8.5, 15.5, 3.0, -4)
  await shot('lineup-day', { x: 240, y: 130, width: 800, height: 640 })
  await cam(8.5, 14, 4.5, -6)
  await shot('levels-day-player', { x: 190, y: 240, width: 900, height: 420 })
  await cam(8.5, 17, 4.5, -6)
  await shot('levels-day-enemy', { x: 190, y: 240, width: 900, height: 420 })

  // ---------- (2) walk stride series: 6 exact phases + loop check ----------
  await cam(16, 16, 7, -7)
  for (let k = 0; k <= 6; k++) { // 7th frame = t+240 must equal frame 0 (loop seam)
    const r = await drawModel(6, { moving: true, time: 1000 + k * 40, facing: 0.45 })
    if (r !== 'ok') console.log(r)
    await shot(`walk-f${k}-t${k * 40}`, { x: 480, y: 300, width: 320, height: 300 })
  }

  // ---------- (3) the arming overwind: calm -> brink -> flash --------------
  // attackDelay 500, windup = last 450 ms; age is ms since the last tick.
  const ARMING = [
    ['a0-calm', -1], ['a1-early', 125], ['a2-half', 275],
    ['a3-late', 425], ['a4-brink', 495], ['a5-flash', 30]
  ]
  for (const [tag, age] of ARMING) {
    const r = await drawModel(6, { moving: false, time: 1000, age, facing: 0.45 })
    if (r !== 'ok') console.log(r)
    await shot(`arming-${tag}`, { x: 480, y: 300, width: 320, height: 300 })
  }

  // ---------- (4) idle tick series (key escapement, 1000 ms period) --------
  for (const [tag, tm] of [['t000', 1000], ['t125', 1125], ['t375', 1375], ['t625', 1625], ['t875', 1875]]) {
    await drawModel(6, { moving: false, time: tm, age: -1, facing: 0.45 })
    await shot(`idle-${tag}`, { x: 480, y: 300, width: 320, height: 300 })
  }

  // ---------- (5) 8-heading sweep (L3, idle mid-tick pose) -----------------
  await cam(19, 19, 7, -7)
  for (let k = 0; k < 8; k++) {
    const fa = k * Math.PI / 4
    await drawModel(7, { moving: false, time: 1125, age: -1, facing: fa, level: 3 })
    await shot(`heading-${k}`, { x: 480, y: 300, width: 320, height: 300 })
  }
  // walk pose at the two trickiest headings (up-screen: sin < 0)
  await drawModel(7, { moving: true, time: 1060, facing: -Math.PI / 2, level: 3 })
  await shot('heading-up-walk', { x: 480, y: 300, width: 320, height: 300 })
  await drawModel(7, { moving: true, time: 1060, facing: Math.PI * 0.75, level: 3 })
  await shot('heading-upleft-walk', { x: 480, y: 300, width: 320, height: 300 })

  // ---------- (6) night: lineup + ember read + arming ----------------------
  await resume()
  await page.evaluate(() => { window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.8) })
  await cam(8.5, 15.5, 3.0, -4)
  await sleep(2200)
  await pause()
  await poseAll()
  await shot('lineup-night', { x: 240, y: 130, width: 800, height: 640 })
  await cam(16, 16, 7, -7)
  await drawModel(6, { moving: false, time: 1375, age: -1, facing: 0.45 })
  await shot('night-idle', { x: 480, y: 300, width: 320, height: 300 })
  await drawModel(6, { moving: false, time: 1000, age: 425, facing: 0.45 })
  await shot('night-arming-late', { x: 480, y: 300, width: 320, height: 300 })
  await drawModel(6, { moving: false, time: 1000, age: 495, facing: 0.45 })
  await shot('night-arming-brink', { x: 480, y: 300, width: 320, height: 300 })

  await resume()
  await page.evaluate(() => { window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.32) })
  console.log('clockworkbeetle-A shots →', OUT, 'errors:', errors.length ? errors : 'none')
} finally {
  await browser.close()
}
