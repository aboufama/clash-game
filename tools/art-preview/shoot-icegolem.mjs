// ICE GOLEM attack + death verification harness (cribbed from
// tools/art-preview/shoot-golem-c.mjs). Boots the LIVE dev server page with
// the shared identity token (never mints a guest), forces the vector path
// (clash.sprites.off), spawns ice golems + a stone golem on the south lawn,
// pauses the scene and drives slamOffset / deaths.
//
//   BASE=http://127.0.0.1:5173 OUT=<dir> node shoot-icegolem.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = (process.env.OUT ?? '/tmp/icegolem-work').replace(/\/$/, '')
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
    localStorage.setItem('clash.sprites.off', '1')   // vector path = live art code
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
      // [x, y, type, owner, level]
      [4, 21, 'icegolem', 'PLAYER', 3],   // 0 attack/heading model
      [7.4, 19.8, 'golem', 'PLAYER', 3],  //    side-by-side stone golem
      [10.6, 19.8, 'icegolem', 'PLAYER', 3], // 1 side-by-side ice golem
      [12.5, 21, 'icegolem', 'PLAYER', 3],  // 2 death model (day)
      [15.5, 21, 'icegolem', 'ENEMY', 2],   // 3 death model (night) + palette
      [6, 14, 'icegolem', 'PLAYER', 1], [9.2, 14, 'icegolem', 'PLAYER', 2], [12.4, 14, 'icegolem', 'PLAYER', 3],
      [6, 17.5, 'icegolem', 'ENEMY', 1], [9.2, 17.5, 'icegolem', 'ENEMY', 2], [12.4, 17.5, 'icegolem', 'ENEMY', 3]
    ]
    for (const [x, y, type, owner, lvl] of cast) s.spawnTroop(x, y, type, owner, lvl)
    for (const t of s.troops) { t.target = null; t.path = undefined; t.facingAngle = 0.9 }
    window.__IG = idx => s.troops.filter(t => t.type === 'icegolem')[idx]
    window.__SG = () => s.troops.filter(t => t.type === 'golem')[0]
  })
  await sleep(900) // landing bounce settles

  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const shot = (name, clip = { x: 440, y: 250, width: 400, height: 420 }) =>
    page.screenshot({ path: `${OUT}/${name}.png`, clip })
  const pause = () => page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  const resume = () => page.evaluate(() => window.__clashGame.scene.resume('MainScene'))

  // redraw a troop (icegolem idx, or the stone golem) with explicit state
  const poseTroop = (which, idx, { moving = false, slam = 0, facing = null } = {}) =>
    page.evaluate(({ which, idx, moving, slam, facing }) => {
      const s = window.__clashGame.scene.keys.MainScene
      const t = which === 'ice' ? window.__IG(idx) : window.__SG()
      if (!t) return `missing troop ${which} ${idx}`
      if (facing !== null) t.facingAngle = facing
      t.slamOffset = slam
      t.lastAttackTime = -1e7
      s.redrawTroopWithMovement(t, moving)
      return 'ok'
    }, { which, idx, moving, slam, facing })
  const poseAll = (facing) => page.evaluate((facing) => {
    const s = window.__clashGame.scene.keys.MainScene
    for (const t of s.troops) {
      if (t.type !== 'icegolem' && t.type !== 'golem') continue
      if (facing !== null) t.facingAngle = facing
      t.slamOffset = 0
      t.lastAttackTime = -1e7
      s.redrawTroopWithMovement(t, false)
    }
  }, facing)

  await pause()
  await poseAll(0.9)

  // ---------- (1) level/palette lineup at impact pose, day ------------------
  await cam(9.2, 15.8, 2.0, -6)
  await shot('lineup-day-idle', { x: 240, y: 130, width: 800, height: 640 })
  for (let i = 4; i <= 9; i++) await poseTroop('ice', i, { slam: 12 })
  await shot('lineup-day-impact', { x: 240, y: 130, width: 800, height: 640 })
  for (let i = 4; i <= 9; i++) await poseTroop('ice', i, { slam: 0 })

  // ---------- (2) attack sequence: 5 phases x 4 headings ---------------------
  await cam(4, 21, 4.2, -22)
  const PHASES = [['s00', 0], ['s04', 4], ['s07', 7], ['s09', 9], ['s12', 12]]
  const HEADINGS = [['h09', 0.9], ['h24', 2.4], ['h38', 3.8], ['h55', 5.5]] // 3.8, 5.5 have sin<0
  for (const [hTag, fa] of HEADINGS) {
    for (const [sTag, v] of PHASES) {
      const r = await poseTroop('ice', 0, { slam: v, facing: fa })
      if (r !== 'ok') console.log(r)
      await shot(`attack-${hTag}-${sTag}`, { x: 460, y: 230, width: 360, height: 430 })
    }
  }
  await poseTroop('ice', 0, { slam: 0, facing: 0.9 })

  // ---------- (3) side-by-side vs stone golem (same driver values) ----------
  await cam(9, 19.8, 3.0, -20)
  for (const [sTag, v] of PHASES) {
    await poseTroop('stone', 0, { slam: v, facing: 0.9 })
    await poseTroop('ice', 1, { slam: v, facing: 0.9 })
    await shot(`sbs-${sTag}`, { x: 340, y: 180, width: 600, height: 520 })
  }
  await poseTroop('stone', 0, { slam: 0 })
  await poseTroop('ice', 1, { slam: 0 })

  // ---------- (4) death sequence, day (resume-slice through the FX) ---------
  await cam(12.5, 21, 3.4, -14)
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const t = window.__IG(2)
    t.facingAngle = 0.9
    s.destroyTroop(t)
  })
  await shot('death-day-t000', { x: 380, y: 180, width: 520, height: 520 })
  const DEATH_SLICES = [[90, 't090'], [160, 't250'], [200, 't450'], [450, 't900'], [1300, 't2200']]
  for (const [dt, tag] of DEATH_SLICES) {
    await resume(); await sleep(dt); await pause()
    await shot(`death-day-${tag}`, { x: 380, y: 180, width: 520, height: 520 })
  }

  // ---------- (5) night: attack + death --------------------------------------
  // (camera must move while the scene RUNS — the day/night overlay redraws
  //  over cam.worldView per frame, so a paused-camera move leaves a seam)
  await resume()
  await page.evaluate(() => { window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.8) })
  await cam(4, 21, 4.2, -22)
  await sleep(2200)
  await pause()
  for (const [sTag, v] of [['s00', 0], ['s07', 7], ['s12', 12]]) {
    await poseTroop('ice', 0, { slam: v, facing: 0.9 })
    await shot(`attack-night-${sTag}`, { x: 460, y: 230, width: 360, height: 430 })
  }
  await poseTroop('ice', 0, { slam: 0 })
  await resume()
  await cam(15.5, 21, 3.4, -14)
  await sleep(500)
  await pause()
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const t = window.__IG(2) // idx 2 is now the former idx 3 (E L2) after the day death
    t.facingAngle = 3.8
    s.destroyTroop(t)
  })
  await shot('death-night-t000', { x: 380, y: 180, width: 520, height: 520 })
  for (const [dt, tag] of DEATH_SLICES) {
    await resume(); await sleep(dt); await pause()
    await shot(`death-night-${tag}`, { x: 380, y: 180, width: 520, height: 520 })
  }

  await resume()
  await page.evaluate(() => { window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.32) })
  console.log('icegolem shots →', OUT, 'errors:', errors.length ? errors : 'none')
} finally {
  await browser.close()
}
