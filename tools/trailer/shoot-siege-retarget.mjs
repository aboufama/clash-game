// Diagnose wall-retargeting: warriors chew a sealed ring, then a siege tower
// ramp opens, then an unrelated wall breaks — do the chewers re-target?
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
const BASE = 'http://127.0.0.1:5174'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cached = JSON.parse(readFileSync(new URL('./.trailer-device-token.json', import.meta.url), 'utf8')).token
const session = await (await fetch(`${BASE}/api/auth/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: cached })
})).json()
const TOKEN = session.token
const api = async (m, p, b) => {
  const r = await fetch(`${BASE}/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: m === 'POST' ? JSON.stringify(b ?? {}) : undefined })
  return r.json().catch(() => null)
}
await api('POST', '/intro-battle/complete', {})
const w0 = (await api('GET', '/world'))?.world
if (!w0.buildings.some(b => b.type === 'watchtower')) {
  w0.buildings.push({ id: `wt_${Date.now()}`, type: 'watchtower', gridX: 18, gridY: 4, level: 1 })
  await api('POST', '/watchtower-tutorial/place', { world: w0, requestId: `wt-${Date.now()}` })
}
await api('POST', '/player/banner', { banner: { palette: 0, emblem: 3, pattern: 1 } })
const w1 = (await api('GET', '/world'))?.world
for (const [type, x, y] of [['army_camp', 20, 8], ['barracks', 20, 12]]) {
  if (!w1.buildings.some(b => b.type === type)) w1.buildings.push({ id: `${type}_${Date.now()}`, type, gridX: x, gridY: y, level: 1 })
}
await api('POST', '/world/save', { world: w1, expectedRevision: w1.revision, requestId: `sv-${Date.now()}` })
await api('POST', '/army/train', { type: 'warrior', count: 6, requestId: `tr-${Date.now()}` })
const act = await api('GET', '/attacks/active')
if (act?.session?.kind === 'bot') {
  await api('POST', '/attacks/bot-settle', { raidId: act.session.raidId, x: act.session.x, y: act.session.y, destruction: 0, deployed: {}, requestId: `ab-${Date.now()}` })
}
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
await page.evaluateOnNewDocument(t => localStorage.setItem('clash.device.token', t), TOKEN)
await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => {
  const s = window.__clashGame?.scene?.keys?.MainScene
  return Boolean(s?.worldMap && s?.cameras?.main && s?.buildings?.length)
}, { timeout: 60000, polling: 300 })
await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 25000 }).catch(() => {})
await sleep(1200)
await page.evaluate(() => {
  const gm = window.__clashGM
  const orig = gm.setGameMode.bind(gm)
  gm.setGameMode = m => { window.__mode = m; orig(m) }
  window.__mode = 'PENDING'
  window.__clashGame.scene.keys.MainScene.attackBotPlot(0, 'Cloud Camp')
})
const ok = await page.waitForFunction(() => window.__mode === 'ATTACK', { timeout: 25000, polling: 250 }).then(() => true).catch(() => false)
if (!ok) throw new Error('raid did not engage')
await sleep(3500)

// Spawn warriors outside a sealed wall segment that has NO exterior
// buildings nearby (so the blocked route forces wall-chewing), and keep the
// probe squad immortal — this diagnoses targeting, not survivability.
const setup = await page.evaluate(() => {
  const scene = window.__clashGame.scene.keys.MainScene
  scene.dayNight?.setPhaseOverride(0.3)
  const walls = scene.buildings.filter(b => b.type === 'wall')
  if (walls.length < 8) return null
  const others = scene.buildings.filter(b => b.type !== 'wall')
  const clearOutside = walls.filter(w => !others.some(o =>
    Math.abs(o.gridX - w.gridX) + Math.abs(o.gridY - w.gridY) < 7))
  const pool = clearOutside.length ? clearOutside : walls
  const wall = pool.reduce((best, w) => (w.gridX + w.gridY > best.gridX + best.gridY ? w : best))
  for (const [dx, dy] of [[0, 2], [1, 2], [-1, 2], [2, 2]]) {
    scene.spawnTroop(wall.gridX + dx, wall.gridY + dy, 'warrior', 'PLAYER', 5)
  }
  window.__immortal = setInterval(() => {
    for (const t of scene.troops) if (t.owner === 'PLAYER') t.health = Math.max(t.health, 4000)
  }, 250)
  return { wall: { id: wall.id, x: wall.gridX, y: wall.gridY }, walls: walls.length }
})
console.log('setup:', JSON.stringify(setup))
if (!setup) throw new Error('no walls in battle world')
const sample = label => page.evaluate(tag => {
  const scene = window.__clashGame.scene.keys.MainScene
  return {
    tag,
    ramped: [...(scene.rampedWallsByOwner?.PLAYER ?? [])].length,
    troops: scene.troops.filter(t => t.owner === 'PLAYER' && t.health > 0).map(t => ({
      type: t.type,
      target: t.target ? `${t.target.type ?? '?'}:${(t.target.id ?? '').slice(-6)}` : null,
      parked: t.parked01 !== undefined
    }))
  }
}, label)
await sleep(2500)
console.log(JSON.stringify(await sample('before-tower')))

// Siege tower from further back: it selects its ray wall and deploys.
await page.evaluate(at => {
  const scene = window.__clashGame.scene.keys.MainScene
  scene.spawnTroop(at.x + 3, at.y + 5, 'siegetower', 'PLAYER', 5)
}, { x: setup.wall.x, y: setup.wall.y })
const ramped = await page.waitForFunction(() => {
  const scene = window.__clashGame.scene.keys.MainScene
  return (scene.rampedWallsByOwner?.PLAYER?.size ?? 0) > 0
}, { timeout: 30000, polling: 300 }).then(() => true).catch(() => false)
console.log('ramp opened:', ramped)
await sleep(600)
console.log(JSON.stringify(await sample('after-ramp-0.6s')))
await sleep(2000)
console.log(JSON.stringify(await sample('after-ramp-2.6s')))

// Break an unrelated wall far from the warriors: chewers must re-target.
const broke = await page.evaluate(() => {
  const scene = window.__clashGame.scene.keys.MainScene
  const walls = scene.buildings.filter(b => b.type === 'wall')
  if (!walls.length) return false
  const far = walls.reduce((best, w) => (w.gridX + w.gridY < best.gridX + best.gridY ? w : best))
  far.health = 0
  scene.destroyBuilding(far)
  return true
})
console.log('far wall broken:', broke)
await sleep(1200)
console.log(JSON.stringify(await sample('after-break-1.2s')))
await browser.close()
