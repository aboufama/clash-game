// Prod-build reproduction probe: full onboarding via HTTP, then a bot raid,
// then screenshots of the attack screen where roads reportedly render black.
import puppeteer from 'puppeteer-core'
const BASE = process.env.BASE ?? 'http://127.0.0.1:8788'
const OUT = process.env.OUT ?? '/tmp/roads-prod'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const iso = (gx, gy) => ({ x: (gx - gy) * 32, y: (gx + gy) * 16 })

const session = await (await fetch(`${BASE}/api/auth/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
})).json()
const TOKEN = session.token
const api = async (m, p, b) => {
  const r = await fetch(`${BASE}/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: m === 'POST' ? JSON.stringify(b ?? {}) : undefined })
  return r.json().catch(() => null)
}
await api('POST', '/intro-battle/complete', {})
// Watchtower gate via its tutorial endpoint with a hand-built world payload.
const w0 = (await api('GET', '/world'))?.world
if (!w0.buildings.some(b => b.type === 'watchtower')) {
  w0.buildings.push({ id: `wt_${Date.now()}`, type: 'watchtower', gridX: 18, gridY: 4, level: 1 })
  const wt = await api('POST', '/watchtower-tutorial/place', { world: w0, requestId: `wt-${Date.now()}` })
  console.log('watchtower:', wt?.error ?? 'ok')
}
console.log('banner:', (await api('POST', '/player/banner', { banner: { palette: 0, emblem: 3, pattern: 1 } }))?.error ?? 'ok')
// Army camp + barracks via world save, then train the gate-satisfying squad.
const w1 = (await api('GET', '/world'))?.world
for (const [type, x, y] of [['army_camp', 20, 8], ['barracks', 20, 12]]) {
  if (!w1.buildings.some(b => b.type === type)) {
    w1.buildings.push({ id: `${type}_${Date.now()}`, type, gridX: x, gridY: y, level: 1 })
  }
}
const saved = await api('POST', '/world/save', { world: w1, expectedRevision: w1.revision, requestId: `sv-${Date.now()}` })
console.log('save:', saved?.error ?? 'ok')
console.log('train:', (await api('POST', '/army/train', { type: 'warrior', count: 6, requestId: `tr-${Date.now()}` }))?.error ?? 'ok')

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
await page.evaluateOnNewDocument(t => localStorage.setItem('clash.device.token', t), TOKEN)
page.on('console', msg => { const t = msg.text(); if (/error|fail|black|road/i.test(t)) console.log('[page]', t.slice(0, 180)) })
await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => {
  const s = window.__clashGame?.scene?.keys?.MainScene
  return Boolean(s?.worldMap && s?.cameras?.main && s?.buildings?.length)
}, { timeout: 60000, polling: 300 })
await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 25000 }).catch(() => {})
await page.addStyleTag({ content: `.app-container > :not(#game-container) { opacity: 0 !important; pointer-events: none !important; }` })
await sleep(1500)
await page.evaluate(() => {
  const gm = window.__clashGM
  const orig = gm.setGameMode.bind(gm)
  gm.setGameMode = m => { window.__mode = m; orig(m) }
  window.__mode = 'PENDING'
  const scene = window.__clashGame.scene.keys.MainScene
  scene.dayNight?.setPhaseOverride(0.3)
  scene.attackBotPlot(0, 'Cloud Camp')
})
const engaged = await page.waitForFunction(() => window.__mode === 'ATTACK', { timeout: 25000, polling: 250 }).then(() => true).catch(() => false)
console.log('engaged:', engaged)
await sleep(4500)
// Frame WIDE so the between-plot roads around the battlefield are visible.
const hallAt = await page.evaluate(() => {
  const scene = window.__clashGame.scene.keys.MainScene
  const hall = scene.buildings.find(b => b.type === 'town_hall')
  return hall ? { x: hall.gridX, y: hall.gridY } : { x: 12, y: 12 }
})
const c = iso(hallAt.x + 1.5, hallAt.y + 1.5)
await page.evaluate(p => {
  const cam = window.__clashGame.scene.keys.MainScene.cameras.main
  cam.setZoom(0.55)
  cam.centerOn(p.x, p.y)
}, c)
await sleep(1200)
await page.screenshot({ path: `${OUT}-wide.png` })
await page.evaluate(p => {
  const cam = window.__clashGame.scene.keys.MainScene.cameras.main
  cam.setZoom(1.1)
  cam.centerOn(p.x, p.y + 200)
}, c)
await sleep(700)
await page.screenshot({ path: `${OUT}-close.png` })
await browser.close()
console.log('done')
