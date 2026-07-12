// Troop-art verification harness.
//
// Strategy: HOME mode's updateTroops() redraws + moves troops every frame,
// so staged poses get overwritten and carrot-targets make troops walk away.
// Instead we let everything spawn and settle LIVE (troops with no target
// stand still), then PAUSE the scene — Phaser keeps rendering a paused
// scene — and drive exact poses by pinning troop.lastAttackTime against the
// frozen clock and calling the scene's own redraw helpers directly.
//
//   BASE=http://127.0.0.1:5301 OUT=/tmp/verify/troops node shoot-troops.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5301'
const OUT = (process.env.OUT ?? new URL('./shots/troops', import.meta.url).pathname).replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

const session = await (await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const token = session.token
const api = async (path, body) => (await fetch(`${BASE}/api${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: body === undefined ? undefined : JSON.stringify(body)
})).json()

// A lived-in hamlet up north; the south lawn stays clear for the line-up.
// The save is PRICED by the server (save-as-transaction), so grant funds
// first and fail loudly if the layout is rejected.
await api('/resources/apply', { delta: 500000, reason: 'debug_grant', requestId: 'tr-g' }).catch(() => {})
await api('/resources/apply', { delta: 50000, resource: 'ore', reason: 'debug_grant', requestId: 'tr-o' }).catch(() => {})
// Keep the starter base as-is and add ONLY an army camp (ore for the priced
// save is capped low on a fresh account, so stay cheap).
const world = (await api('/world')).world ?? session.world
world.buildings = [
  ...(world.buildings ?? []),
  { id: 'TCAMP', type: 'army_camp', gridX: 19, gridY: 19, level: 1 }
]
const saved = await api('/world/save', { world, requestId: 'troop-showcase' })
if (saved?.error) console.log('WORLD SAVE FAILED:', saved.error, '- shooting on the existing base instead')
for (const [i, t] of ['warrior', 'archer', 'sharpshooter', 'giant'].entries()) {
  const trained = await api('/army/train', { type: t, requestId: `tr-${i}` }).catch(e => ({ error: String(e) }))
  if (trained?.error) console.log('train failed:', t, trained.error)
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => localStorage.setItem('clash.device.token', tok), token)
  const errors = []
  page.on('pageerror', e => { errors.push(String(e.message).slice(0, 160)); console.log('PAGE ERROR:', String(e.message).slice(0, 160)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 40000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(2500)

  // ---------- PHASE 1 (live): spawn everything, settle, camp shot --------
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather.setWeatherOverride(0)
    const cast = [
      ['warrior', 6, 14], ['archer', 8, 14], ['sharpshooter', 10, 14],
      ['stormmage', 12, 14], ['ward', 14, 14], ['wallbreaker', 16, 14],
      ['romanwarrior', 18, 14],
      ['giant', 7, 18], ['ram', 12, 18], ['mobilemortar', 16.5, 18],
      ['phalanx', 6, 22], ['golem', 11, 22.6]
    ]
    for (const [type, x, y] of cast) s.spawnTroop(x, y, type, 'PLAYER')
    // level-chip demo warriors
    s.spawnTroop(10, 16, 'warrior', 'PLAYER', 0, 1)
    s.spawnTroop(12, 16, 'warrior', 'PLAYER', 0, 2)
    s.spawnTroop(14, 16, 'warrior', 'PLAYER', 0, 3)
    // enemy palette row
    const foes = [['warrior', 6, 21], ['archer', 8, 21], ['sharpshooter', 10, 21], ['stormmage', 12, 21], ['giant', 14.5, 21.3]]
    for (const [type, x, y] of foes) s.spawnTroop(x, y, type, 'ENEMY')
    // keep everyone rooted: no target -> updateTroops never moves them
    for (const t of s.troops) { t.target = null; t.path = undefined; t.facingAngle = 0.45 }
    window.__T = (type, idx = 0) => s.troops.filter(t => t.type === type)[idx]
  })
  await sleep(800) // landing bounces settle

  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const shot = name => page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 340, y: 150, width: 600, height: 600 } })

  // Army camp figures while everything is still live.
  await cam(20, 20, 2.8, -8)
  await sleep(2200)
  await shot('e1-army-camp-figures')

  // Park villagers along the scale rows, then freeze the world.
  const summonVillagers = (x, y, n = 3, gap = 2) => page.evaluate(({ x, y, n, gap }) => {
    const s = window.__clashGame.scene.keys.MainScene
    const ents = (s.villageLife.entities ?? []).filter(e => e.kind === 'villager' && !e.child)
    for (const [i, e] of ents.slice(0, n).entries()) {
      e.x = x + i * gap
      e.y = y
      e.path = null
      e.state = 'idle'
      if ('idleUntil' in e) e.idleUntil = (s.time.now || 0) + 90000
    }
    return ents.length
  }, { x, y, n, gap })
  console.log('villagers:', await summonVillagers(7, 14.6))
  await sleep(600) // let their gfx tick to the new spot

  const pause = () => page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  const resume = () => page.evaluate(() => window.__clashGame.scene.resume('MainScene'))
  await pause()

  // Pose driver (works while paused; redraw helpers are plain methods).
  // mode: 'idle' | 'walk' | 'hold'; ms: <0 = before the tick, >=0 = after.
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

  // ---------- (a) SCALE PROOF (all idle, villagers in the rows) -----------
  await poseAll()
  await cam(9.5, 14.2, 2.7, -8)
  await shot('a1-scale-row1-warrior-archer-sharpshooter-mage')
  await cam(14.5, 14.2, 2.7, -8)
  await shot('a2-scale-row2-ward-wallbreaker-roman')
  await cam(9.5, 18.2, 2.4, -8)
  await shot('a3-scale-giant-ram')
  await cam(16, 18.2, 2.6, -8)
  await shot('a4-scale-mobilemortar')

  // ---------- (b) WALK + ATTACK frames per troop --------------------------
  const troopSpots = {
    warrior: [6, 14], archer: [8, 14], sharpshooter: [10, 14],
    stormmage: [12, 14], ward: [14, 14], wallbreaker: [16, 14],
    romanwarrior: [18, 14], giant: [7, 18], ram: [12, 18], mobilemortar: [16.5, 18]
  }
  const seq = [
    ['idle', 'idle', 0], ['walk1', 'walk', 0], ['walk2', 'walk', 0],
    ['windup', 'hold', -140], ['strike', 'hold', 55], ['muzzle', 'hold', 360], ['follow', 'hold', 520]
  ]
  for (const type of ['warrior', 'archer', 'sharpshooter', 'stormmage', 'ward', 'wallbreaker', 'romanwarrior']) {
    const [x, y] = troopSpots[type]
    await cam(x, y, 5, -12)
    for (const [name, mode, ms] of seq) {
      if (name === 'walk2') { await resume(); await sleep(160); await pause() }
      const r = await setPose(type, mode, ms, 0.45)
      if (r !== 'ok') { console.log(r); continue }
      await shot(`b-${type}-${name}`)
    }
    await setPose(type, 'idle', 0, 0.45)
  }
  for (const type of ['ram', 'mobilemortar']) {
    const [x, y] = troopSpots[type]
    await cam(x, y, 3.2, -10)
    for (const [name, mode, ms] of [['walk1', 'walk', 0], ['windup', 'hold', -140], ['strike', 'hold', 55], ['follow', 'hold', 430]]) {
      const r = await setPose(type, mode, ms, 0.15)
      if (r !== 'ok') { console.log(r); continue }
      await shot(`b-${type}-${name}`)
    }
    await setPose(type, 'idle', 0, 0.15)
  }
  // formation + monster sanity checks
  await cam(6, 22, 2.8, -10)
  await setPose('phalanx', 'walk', 0, 0.3)
  await shot('b-phalanx-march')
  await setPose('phalanx', 'idle', 0, 0.3)
  await shot('b-phalanx-idle')
  await cam(11, 22.6, 2.6, -18)
  await setPose('golem', 'idle', 0, 0)
  await shot('b-golem-port-check')

  // ---------- (c) GIANT full attack sequence ------------------------------
  const [gx, gy] = troopSpots.giant
  await cam(gx, gy, 4, -16)
  for (const [name, mode, ms] of [
    ['1-menace', 'hold', 1800],
    ['2-rise', 'hold', -520],
    ['3-overhead', 'hold', -95],
    ['4-impact', 'hold', 60],
    ['5-dustroll', 'hold', 300],
    ['6-recovery', 'hold', 800],
    ['7-walk', 'walk', 0],
    ['8-idle', 'idle', 0]
  ]) {
    const r = await setPose('giant', mode, ms, 0.35)
    if (r !== 'ok') { console.log('giant:', r); continue }
    await shot(`c-giant-${name}`)
  }

  // ---------- (d) LEVEL CHIPS ---------------------------------------------
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const demo = s.troops.filter(t => t.type === 'warrior' && t.owner === 'PLAYER').slice(-3)
    const pct = [0.72, 0.45, 0.2]
    demo.forEach((t, i) => {
      t.lastAttackTime = -1e7
      t.health = Math.max(1, Math.round(t.maxHealth * pct[i]))
      t.hasTakenDamage = true
      s.redrawTroopWithMovement(t, false)
      s.updateHealthBar(t)
    })
  })
  await cam(12, 16, 3.4, -10)
  await shot('d1-level-chips-L1-L2-L3')

  // ---------- (f) enemy palette row ----------------------------------------
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    for (const t of s.troops.filter(t => t.owner === 'ENEMY')) {
      t.lastAttackTime = -1e7
      s.redrawTroopWithMovement(t, false)
    }
  })
  await cam(10.5, 21, 2.7, -8)
  await shot('f1-enemy-palette')

  await resume()
  console.log('troop shots done →', OUT, 'errors:', errors.length ? errors : 'none')
} finally {
  await browser.close()
}
