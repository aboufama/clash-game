// Necromancer/Skeleton DESIGN B verification harness (clean-room designer B).
// Crib of shoot-troops.mjs, but: resumes the SHARED identity (never mints a
// session), seeds clash.sprites.off + clash.design.necromancer/skeleton='B'
// BEFORE boot, and never saves the world (spawn-only — zero side effects).
//
//   BASE=http://127.0.0.1:5173 node shoot-necromancer-b.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = (process.env.OUT ?? new URL('./shots/necromancer-B', import.meta.url).pathname).replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

// Shared identity — NEVER call /api/auth/session (rate-limited, junks the map).
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
    localStorage.setItem('clash.sprites.off', '1')
    localStorage.setItem('clash.design.necromancer', 'B')
    localStorage.setItem('clash.design.skeleton', 'B')
  }, token)
  const errors = []
  page.on('pageerror', e => { errors.push(String(e.message).slice(0, 160)); console.log('PAGE ERROR:', String(e.message).slice(0, 160)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 120000, polling: 500 })
  // The boot cloud-transition can RESTART MainScene after buildings appear,
  // wiping spawned troops. Probe with an off-camera warrior until a spawn
  // survives 1.5 s — only then is the scene stable enough to stage the cast.
  let stable = false
  for (let i = 0; i < 15 && !stable; i++) {
    const n = await page.evaluate(() => {
      const s = window.__clashGame?.scene?.keys?.MainScene
      if (!s?.spawnTroop || !s.troops) return -1
      try { s.spawnTroop(4, 25, 'warrior', 'PLAYER', 1) } catch { return -1 }
      return s.troops.filter(t => t.type === 'warrior').length
    })
    await sleep(1500)
    if (n > 0) {
      const m = await page.evaluate(() => window.__clashGame?.scene?.keys?.MainScene?.troops?.filter(t => t.type === 'warrior').length ?? 0)
      stable = m >= n
    }
  }
  if (!stable) throw new Error('MainScene never stabilized for troop spawns')
  await sleep(1500)

  // ---------- spawn the cast on the south lawn (no target => rooted) -------
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather.setWeatherOverride(0)
    // Necromancer levels row (player) + enemy
    s.spawnTroop(8, 14, 'necromancer', 'PLAYER', 1)
    s.spawnTroop(10, 14, 'necromancer', 'PLAYER', 2)
    s.spawnTroop(12, 14, 'necromancer', 'PLAYER', 3)
    s.spawnTroop(15, 14, 'necromancer', 'ENEMY', 3)
    // Skeleton levels row (player) + enemy
    s.spawnTroop(8, 17.5, 'skeleton', 'PLAYER', 1)
    s.spawnTroop(9.6, 17.5, 'skeleton', 'PLAYER', 2)
    s.spawnTroop(11.2, 17.5, 'skeleton', 'PLAYER', 3)
    s.spawnTroop(13.5, 17.5, 'skeleton', 'ENEMY', 1)
    // 8-direction ring of skeletons (facing set per index below)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      s.spawnTroop(10 + Math.cos(a) * 2.6, 21.5 + Math.sin(a) * 2.6, 'skeleton', 'PLAYER', 2)
    }
    for (const t of s.troops) { t.target = null; t.path = undefined; t.facingAngle = 0.45 }
    // aim the ring outward
    const ring = s.troops.filter(t => t.type === 'skeleton').slice(4)
    ring.forEach((t, i) => { t.facingAngle = (i / 8) * Math.PI * 2 })
    window.__T = (type, idx = 0) => s.troops.filter(t => t.type === type)[idx]
  })
  await sleep(900)

  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const shot = name => page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 340, y: 150, width: 600, height: 600 } })

  const pause = () => page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  const resume = () => page.evaluate(() => window.__clashGame.scene.resume('MainScene'))

  // Pose driver (paused scene; redraw helpers are plain methods).
  // mode: 'idle' | 'walk' | 'hold'; ms: <0 = before the damage tick, >=0 = after.
  const setPose = (type, mode, ms = 0, ang = 0.45, idx = 0) => page.evaluate(({ type, mode, ms, ang, idx }) => {
    const s = window.__clashGame.scene.keys.MainScene
    const t = window.__T(type, idx)
    if (!t) return `missing ${type}`
    t.facingAngle = ang
    const now = s.time.now
    const D = t.attackDelay || 1000
    if (mode === 'walk') {
      s.redrawTroopWithMovement(t, true)
    } else {
      if (mode === 'idle') t.lastAttackTime = -1e7
      else t.lastAttackTime = ms < 0 ? now - (D + ms) : now - ms
      s.redrawTroopWithMovement(t, false)
    }
    return 'ok'
  }, { type, mode, ms, ang, idx })
  const poseAll = () => page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    for (const t of s.troops) { t.lastAttackTime = -1e7; s.redrawTroopWithMovement(t, false) }
  })
  // advance the frozen clock by ~ms (resume → wait → pause), then re-pose.
  const tick = async (ms) => { await resume(); await sleep(ms); await pause() }

  await pause()
  await poseAll()

  // ---------- (1) LEVELS + PALETTES, day ----------------------------------
  await cam(10, 14, 3.1, -10)
  await shot('n1-necro-L1-L2-L3-player-day')
  await cam(15, 14, 4.6, -12)
  await shot('n2-necro-enemy-L3-day')
  await cam(10, 17.5, 3.4, -8)
  await shot('n3-skeleton-L1-L2-L3-P-plus-E-day')

  // ---------- (2) necromancer close-up per level ---------------------------
  for (const [lvl, x] of [[1, 8], [2, 10], [3, 12]]) {
    await cam(x, 14, 6, -14)
    await shot(`n4-necro-L${lvl}-close-idle`)
  }

  // ---------- (3) necromancer IDLE series (2000 ms period; 250 ms steps so
  // the h4 page-flutter and h2 ember land on distinct phases) ---------------
  await cam(12, 14, 6, -14)
  for (let i = 0; i < 4; i++) {
    await setPose('necromancer', 'idle', 0, 0.45, 2)
    await shot(`n5-necro-idle-ph${i}-t${i * 250}ms`)
    if (i < 3) { await tick(250); await poseAll() }
  }

  // ---------- (4) necromancer WALK series (one exact 480 ms stride) --------
  for (let i = 0; i < 4; i++) {
    await setPose('necromancer', 'walk', 0, 0.45, 2)
    await shot(`n6-necro-walk-ph${i}-t${i * 120}ms`)
    if (i < 3) await tick(120)
  }

  // ---------- (5) necromancer ATTACK sequence (delay 1600) -----------------
  for (const [name, ms] of [['windup-early', -420], ['windup-peak', -50], ['strike-tick', 40], ['release', 180], ['follow', 280]]) {
    await setPose('necromancer', 'hold', ms, 0.45, 2)
    await shot(`n7-necro-attack-${name}`)
  }
  await setPose('necromancer', 'idle', 0, 0.45, 2)

  // ---------- (6) skeleton close: idle rattle + walk + lunge ---------------
  await cam(9.6, 17.5, 6, -12)
  for (let i = 0; i < 3; i++) {
    await setPose('skeleton', 'idle', 0, 0.45, 1)
    await shot(`s1-skel-idle-ph${i}`)
    if (i < 2) { await tick(250); await poseAll() }
  }
  for (let i = 0; i < 3; i++) {
    await setPose('skeleton', 'walk', 0, 0.45, 1)
    await shot(`s2-skel-walk-ph${i}-t${i * 100}ms`)
    if (i < 2) await tick(100)
  }
  for (const [name, ms] of [['coil', -180], ['lunge-tick', 30], ['recover', 110]]) {
    await setPose('skeleton', 'hold', ms, 0.45, 1)
    await shot(`s3-skel-${name}`)
  }
  // layering check: aiming up-screen (sin<0) — blade must draw behind
  await setPose('skeleton', 'hold', 30, -Math.PI * 0.65, 1)
  await shot('s4-skel-lunge-upscreen')
  await setPose('skeleton', 'idle', 0, 0.45, 1)

  // ---------- (7) 8-direction ring ------------------------------------------
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const ring = s.troops.filter(t => t.type === 'skeleton').slice(4)
    ring.forEach((t, i) => {
      t.facingAngle = (i / 8) * Math.PI * 2
      t.lastAttackTime = -1e7
      s.redrawTroopWithMovement(t, false)
    })
  })
  await cam(10, 21.5, 3.4, -8)
  await shot('s5-skel-8dir-ring-idle')
  // per-direction close-ups of ONE skeleton — the blade must read at all 8
  await cam(9.6, 17.5, 6, -12)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    await setPose('skeleton', 'idle', 0, a, 1)
    await shot(`s7-skel-dir${i}-idle`)
  }
  await setPose('skeleton', 'idle', 0, 0.45, 1)

  // ---------- (8) NIGHT — set camera + phase LIVE so the world-space grade
  // rect settles over the new view before pausing (else it shoots stale) ----
  const nightShot = async (x, y, zoom, dy, poser, name) => {
    await resume()
    await cam(x, y, zoom, dy)
    await page.evaluate(() => window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.8))
    await sleep(700)
    await pause()
    await poser()
    await shot(name)
  }
  await nightShot(10, 14, 3.1, -10, () => poseAll(), 'n8-necro-levels-night')
  await nightShot(12, 14, 6, -14, () => setPose('necromancer', 'hold', -50, 0.45, 2), 'n9-necro-windup-night')
  await nightShot(9.6, 17.5, 6, -12, () => setPose('skeleton', 'idle', 0, 0.45, 1), 's6-skel-night')

  await resume()
  console.log('necromancer-B shots done →', OUT, 'errors:', errors.length ? errors : 'none')
} finally {
  await browser.close()
}
