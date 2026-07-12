// LIVE battle verification for the troop overhaul: a practice attack on the
// account's own starter base (it has defenses), troops deployed directly via
// spawnTroop. Verifies the real combat loop: damage-synced attack cycles,
// musket ball + flash, archer arrows, giant slam + dust on the tick, and
// level chips appearing when defenses hurt troops. Also one night shot.
//
//   BASE=http://127.0.0.1:5301 OUT=/tmp/verify/troops node shoot-troops-battle.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5301'
const OUT = (process.env.OUT ?? new URL('./shots/troops', import.meta.url).pathname).replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

const session = await (await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => localStorage.setItem('clash.device.token', tok), session.token)
  const errors = []
  page.on('pageerror', e => { errors.push(String(e.message).slice(0, 200)); console.log('PAGE ERROR:', String(e.message).slice(0, 200)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 40000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(2500)

  // Start a practice attack against the player's own base (the scene
  // registers the action on the GameManager, exposed as __clashGM).
  const started = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather.setWeatherOverride(0)
    const gm = window.__clashGM
    if (gm && typeof gm.startPracticeAttack === 'function') { gm.startPracticeAttack(); return 'practice' }
    return 'no-practice-fn'
  })
  console.log('attack start:', started)
  await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.mode === 'ATTACK', { timeout: 30000, polling: 300 })
  await sleep(1500)

  const info = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const defenses = s.buildings.filter(b => b.owner === 'ENEMY' && ['cannon', 'mortar', 'ballista', 'xbow', 'tesla', 'prism'].includes(b.type))
    const anyB = s.buildings.filter(b => b.owner === 'ENEMY')
    return { defenses: defenses.map(b => `${b.type}@${b.gridX},${b.gridY}`), buildings: anyB.length }
  })
  console.log('enemy base:', JSON.stringify(info))

  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const shot = name => page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 240, y: 100, width: 800, height: 700 } })

  // Deploy a wave from the south-west so they march visibly.
  const target = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const th = s.buildings.find(b => b.owner === 'ENEMY' && b.type === 'town_hall') ?? s.buildings.find(b => b.owner === 'ENEMY')
    const tx = th ? th.gridX : 12, ty = th ? th.gridY : 12
    s.spawnTroop(Math.max(1, tx - 8), ty + 5, 'giant', 'PLAYER')
    s.spawnTroop(Math.max(1, tx - 7), ty + 6.2, 'warrior', 'PLAYER')
    s.spawnTroop(Math.max(1, tx - 6), ty + 7.4, 'archer', 'PLAYER')
    s.spawnTroop(Math.max(1, tx - 8.5), ty + 7, 'sharpshooter', 'PLAYER')
    s.spawnTroop(Math.max(1, tx - 5), ty + 8, 'stormmage', 'PLAYER')
    return { tx, ty }
  })
  console.log('deployed at SW of', JSON.stringify(target))

  // March shots.
  await cam(target.tx - 5, target.ty + 5, 2.2, -6)
  await sleep(900)
  await shot('g1-battle-march')
  await sleep(1200)
  await shot('g2-battle-march2')

  // Wait for the giant's first slam: poll lastAttackTime, then catch the
  // impact ~80ms later and the dust roll ~300ms later.
  const gotSlam = await page.evaluate(() => new Promise(resolve => {
    const s = window.__clashGame.scene.keys.MainScene
    const g = s.troops.find(t => t.type === 'giant')
    if (!g) return resolve('no giant')
    const t0 = s.time.now
    const check = () => {
      if (!g.gameObject || !g.gameObject.active) return resolve('giant died')
      if (g.lastAttackTime > t0 && s.time.now - g.lastAttackTime < 45) {
        const isoX = (g.gridX - g.gridY) * 32
        const isoY = (g.gridX + g.gridY) * 16
        s.cameras.main.setZoom(3.2)
        s.cameras.main.centerOn(isoX, isoY - 12)
        return resolve('slam')
      }
      if (s.time.now - t0 > 45000) return resolve('timeout')
      setTimeout(check, 25)
    }
    check()
  }))
  console.log('giant slam:', gotSlam)
  if (gotSlam === 'slam') {
    await shot('g3-giant-slam-impact-live')
    await sleep(240)
    await shot('g4-giant-slam-dust-live')
  }

  // Catch a musket shot: fires MUSKET_FIRE_MS (330) after the tick.
  const gotShot = await page.evaluate(() => new Promise(resolve => {
    const s = window.__clashGame.scene.keys.MainScene
    const m = s.troops.find(t => t.type === 'sharpshooter')
    if (!m) return resolve('no sharpshooter')
    const t0 = s.time.now
    const check = () => {
      if (!m.gameObject || !m.gameObject.active) return resolve('sharpshooter died')
      const age = s.time.now - m.lastAttackTime
      if (m.lastAttackTime > t0 && age > 300 && age < 380) {
        const isoX = (m.gridX - m.gridY) * 32
        const isoY = (m.gridX + m.gridY) * 16
        s.cameras.main.setZoom(3.6)
        s.cameras.main.centerOn(isoX + 20, isoY - 10)
        return resolve('bang')
      }
      if (s.time.now - t0 > 45000) return resolve('timeout')
      setTimeout(check, 12)
    }
    check()
  }))
  console.log('musket:', gotShot)
  if (gotShot === 'bang') {
    await shot('g5-musket-flash-live')
    await sleep(300)
    await shot('g6-musket-smoke-live')
  }

  // Wide battle shot: bars + chips after defenses have dealt damage.
  await sleep(2500)
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const hurt = s.troops.find(t => t.hasTakenDamage)
    const t = hurt ?? s.troops[0]
    if (t) {
      const isoX = (t.gridX - t.gridY) * 32
      const isoY = (t.gridX + t.gridY) * 16
      s.cameras.main.setZoom(3)
      s.cameras.main.centerOn(isoX, isoY - 10)
    }
    return hurt ? 'hurt' : 'none-hurt'
  })
  await shot('g7-battle-chip-live')
  await cam(target.tx, target.ty, 1.7, 0)
  await shot('g8-battle-wide')

  // Night pass on the same battle.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.8)
  })
  await sleep(2000)
  await cam(target.tx - 2, target.ty + 2, 2.4, -6)
  await shot('g9-battle-night')

  console.log('battle shots done →', OUT, 'errors:', errors.length ? errors : 'none')
} finally {
  await browser.close()
}
