// Clockwork Beetle — design C verification harness (clean-room designer C).
// Spawns beetles in a HOME-mode scene (client-side only — never saves the
// world, never trains, never mints guests: resumes the shared identity),
// pauses the scene and drives exact poses via redrawTroopWithMovement.
//
//   BASE=http://127.0.0.1:5175 OUT=/path/to/shots node shoot-clockworkbeetle-c.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5175'
const OUT = (process.env.OUT ?? new URL('./shots/clockworkbeetle-c', import.meta.url).pathname).replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

const { token } = JSON.parse(readFileSync(new URL('./.shared-device-token.json', import.meta.url), 'utf8'))

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
    localStorage.setItem('clash.sprites.off', '1')          // vector authoring path
    localStorage.setItem('clash.design.clockworkbeetle', 'C') // MY slot
  }, token)
  const errors = []
  page.on('pageerror', e => { errors.push(String(e.message).slice(0, 200)); console.log('PAGE ERROR:', String(e.message).slice(0, 200)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 40000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(2000)

  // Spawn the full cast on the south lawn (client-side scene state only).
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather.setWeatherOverride(0)
    // levels row (player) + enemy pair
    s.spawnTroop(8, 20, 'clockworkbeetle', 'PLAYER', 1)
    s.spawnTroop(9.4, 20, 'clockworkbeetle', 'PLAYER', 2)
    s.spawnTroop(10.8, 20, 'clockworkbeetle', 'PLAYER', 3)
    s.spawnTroop(12.4, 20, 'clockworkbeetle', 'ENEMY', 2)
    // scale reference
    s.spawnTroop(14, 20, 'warrior', 'PLAYER', 1)
    // headings ring (8 dirs)
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4
      s.spawnTroop(17 + Math.cos(a) * 1.7, 15 + Math.sin(a) * 1.7, 'clockworkbeetle', 'PLAYER', 2)
    }
    // pose subject + swarm cluster
    s.spawnTroop(6, 15, 'clockworkbeetle', 'PLAYER', 2)
    const sw = [[20, 20], [20.9, 20.4], [21.7, 19.8], [20.4, 21.1], [21.3, 21.4], [22.1, 20.7], [19.6, 20.9], [22, 21.8], [20.8, 22.2]]
    for (const [x, y] of sw) s.spawnTroop(x, y, 'clockworkbeetle', 'PLAYER', 1)
    for (const t of s.troops) { t.target = null; t.path = undefined; t.facingAngle = 0.45 }
    // aim the ring outward
    const ring = s.troops.filter(t => t.type === 'clockworkbeetle').slice(4, 12)
    ring.forEach((t, i) => { t.facingAngle = i * Math.PI / 4 })
    window.__B = idx => s.troops.filter(t => t.type === 'clockworkbeetle')[idx]
  })
  await sleep(700)

  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const shot = name => page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 340, y: 150, width: 600, height: 600 } })
  const pause = () => page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  const resume = () => page.evaluate(() => window.__clashGame.scene.resume('MainScene'))

  // Pose one beetle by index. mode 'idle'|'walk'|'hold'; ms<0 = before tick.
  const setPose = (idx, mode, ms = 0, ang = null) => page.evaluate(({ idx, mode, ms, ang }) => {
    const s = window.__clashGame.scene.keys.MainScene
    const t = window.__B(idx)
    if (!t) return `missing beetle ${idx}`
    if (ang !== null) t.facingAngle = ang
    const now = s.time.now
    const D = t.attackDelay || 500
    if (mode === 'walk') {
      s.redrawTroopWithMovement(t, true)
    } else {
      if (mode === 'idle') t.lastAttackTime = -1e7
      else t.lastAttackTime = ms < 0 ? now - (D + ms) : now - ms
      s.redrawTroopWithMovement(t, false)
    }
    return 'ok'
  }, { idx, mode, ms, ang })
  const poseAll = mode => page.evaluate(m => {
    const s = window.__clashGame.scene.keys.MainScene
    for (const t of s.troops) { t.lastAttackTime = -1e7; s.redrawTroopWithMovement(t, m === 'walk') }
  }, mode)

  await pause()

  // ---- (1) levels + enemy palette + scale (day) ----
  await poseAll('idle')
  await cam(10.8, 20, 3.4, -6)
  await shot('a1-levels-enemy-scale-day')
  await cam(9.4, 20, 6, -6)
  await shot('a2-levels-close')

  // ---- (2) 8 headings, walking ----
  await poseAll('walk')
  await cam(17, 15, 3.6, -6)
  await shot('b1-headings-ring-walk')
  // singles at the tricky up-screen headings
  for (const [name, ang] of [['e', 0], ['se', Math.PI / 4], ['s', Math.PI / 2], ['nw', -3 * Math.PI / 4], ['n', -Math.PI / 2], ['w', Math.PI]]) {
    await setPose(12, 'walk', 0, ang)
    await cam(6, 15, 7, -4)
    await shot(`b2-heading-${name}-walk`)
  }

  // ---- (3) walk stride series (240 ms loop, ~4 phases) ----
  await setPose(12, 'walk', 0, 0.45)
  await cam(6, 15, 7, -4)
  await shot('c1-stride-ph0')
  for (let i = 1; i <= 3; i++) {
    await resume(); await sleep(55); await pause()
    await setPose(12, 'walk', 0, 0.45)
    await shot(`c1-stride-ph${i}`)
  }

  // ---- (4) idle series (2000 ms loop, 4 phases) ----
  await setPose(12, 'idle', 0, 0.45)
  await shot('d1-idle-ph0')
  for (let i = 1; i <= 3; i++) {
    await resume(); await sleep(480); await pause()
    await setPose(12, 'idle', 0, 0.45)
    await shot(`d1-idle-ph${i}`)
  }

  // ---- (5) attack / detonation telegraph sequence ----
  for (const [name, ms] of [['w0-start', -238], ['w1-mid', -140], ['w2-late', -60], ['w3-peak', -8], ['x1-burst', 1], ['x2-burst', 40]]) {
    await setPose(12, 'hold', ms, 0.45)
    await shot(`e1-attack-${name}`)
  }
  // up-screen detonation (layering check)
  await setPose(12, 'hold', -8, -2.2)
  await shot('e2-attack-peak-upscreen')

  // ---- (6) swarm readability ----
  await poseAll('walk')
  await cam(21, 20.8, 2.2, -6)
  await shot('f1-swarm-zoomed-out')

  // ---- (7) night ----
  // The grade rect stretches over cam.worldView per frame — move the camera
  // FIRST, then let the scene run a beat so the grade covers the new view,
  // then pause and pose.
  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.8))
  await cam(10.8, 20, 3.4, -6)
  await resume(); await sleep(450); await pause()
  await poseAll('idle')
  await shot('g1-levels-night')
  await cam(6, 15, 7, -4)
  await resume(); await sleep(450); await pause()
  await setPose(12, 'hold', -8, 0.45)
  await shot('g2-windup-night')

  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.32))
  await resume()
  console.log('beetle-C shots →', OUT, 'errors:', errors.length ? errors : 'none')
} finally {
  await browser.close()
}
