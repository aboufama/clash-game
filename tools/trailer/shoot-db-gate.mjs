// Verify the Dragon's Breath opening-volley gate: wake it with one warrior,
// film frames through the rise, confirm no rockets before full emergence.
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
const BASE = 'http://127.0.0.1:5174'
const OUT = process.env.OUT ?? '/tmp/db-gate'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cached = JSON.parse(readFileSync('/Users/andreboufama/Documents/MISC/clash-game/tools/trailer/.trailer-device-token.json', 'utf8')).token
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
await page.addStyleTag({ content: `.app-container > :not(#game-container) { opacity: 0 !important; pointer-events: none !important; }` })
await sleep(1200)
// Raid a MAP camp that fields a Dragon's Breath (fortress/extreme bands).
const mapWin = await api('GET', '/map?r=6')
const armed = (mapWin?.plots ?? []).filter(p => p.kind === 'bot' && p.world
  && p.world.buildings.some(b => b.type === 'dragons_breath'))
if (!armed.length) throw new Error('no camp in sight fields a dragons_breath')
const target = armed[0]
console.log('target', target.username, `@${target.x},${target.y}`)
await page.evaluate(plot => {
  const gm = window.__clashGM
  const orig = gm.setGameMode.bind(gm)
  gm.setGameMode = m => { window.__mode = m; orig(m) }
  window.__mode = 'PENDING'
  window.__clashGame.scene.keys.MainScene.attackBotPlot(plot.seed, plot.username, plot.x, plot.y)
}, { seed: target.seed, username: target.username, x: target.x, y: target.y })
const ok = await page.waitForFunction(() => window.__mode === 'ATTACK', { timeout: 25000, polling: 250 }).then(() => true).catch(() => false)
if (!ok) throw new Error('raid did not engage')
await sleep(3500)
const db = await page.evaluate(() => {
  const scene = window.__clashGame.scene.keys.MainScene
  scene.dayNight?.setPhaseOverride(0.3)
  const found = scene.buildings.find(b => b.type === 'dragons_breath')
  return found ? { x: found.gridX, y: found.gridY } : null
})
if (!db) throw new Error('battle world lost its dragons_breath')
console.log('dragons_breath at', JSON.stringify(db))
// Frame the battery, then wake it with a single warrior dropped at its feet.
await page.evaluate(at => {
  const cam = window.__clashGame.scene.keys.MainScene.cameras.main
  const p = { x: (at.x + 2 - (at.y + 2)) * 32, y: (at.x + 2 + at.y + 2) * 16 }
  cam.setZoom(1.9)
  cam.centerOn(p.x, p.y)
}, db)
await page.evaluate(at => {
  const scene = window.__clashGame.scene.keys.MainScene
  scene.spawnTroop(at.x - 2, at.y + 2, 'warrior', 'PLAYER')
}, db)
for (const [name, delay] of [['t04', 400], ['t08', 400], ['t12', 400], ['t20', 800], ['t30', 1000]]) {
  await sleep(delay)
  await page.screenshot({ path: `${OUT}-${name}.png` })
}
const deployState = await page.evaluate(() => {
  const scene = window.__clashGame.scene.keys.MainScene
  const b = scene.buildings.find(x => x.type === 'dragons_breath')
  return b ? { deploy01: b.deploy01, lastFireTime: b.lastFireTime ?? null } : null
})
console.log('state:', JSON.stringify(deployState))
await browser.close()
console.log('done')
