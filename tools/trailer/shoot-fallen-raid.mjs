// REAL-PATH probe: raid a bot camp, tear its town hall down with troops,
// and photograph the fallen standard the destruction leaves behind.
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
const BASE = process.env.BASE ?? 'http://127.0.0.1:5174'
const OUT = process.env.OUT ?? '/tmp/fallen-raid'
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
await api('POST', '/player/banner', { banner: { palette: 0, emblem: 3, pattern: 1 } })
const act = await api('GET', '/attacks/active')
if (act?.session?.kind === 'bot') {
  await api('POST', '/attacks/bot-settle', { raidId: act.session.raidId, x: act.session.x, y: act.session.y, destruction: 0, deployed: {}, requestId: `ffr-${Date.now()}` })
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
page.on('console', msg => { const t = msg.text(); if (/toast|raid|attack|battle|fail|error/i.test(t)) console.log('[page]', t.slice(0, 200)) })
await sleep(1000)
// Onboarding: the first watchtower must be placed before any raid.
const uid = session.player?.id ?? session.user?.id
await page.evaluate(async userId => {
  const { Backend } = await import('/src/game/backend/GameBackend.ts')
  for (const [x, y] of [[18, 4], [4, 18], [20, 20], [2, 2], [12, 20]]) {
    const done = await Backend.placeBuilding(userId, 'watchtower', x, y)
    if (done) break
  }
  await Backend.saveNow(userId)
  await window.__clashGM.loadBase()
}, uid)
await sleep(1500)
await page.evaluate(() => {
  const gm = window.__clashGM
  if (!window.__wrapped) {
    const orig = gm.setGameMode.bind(gm)
    gm.setGameMode = m => { window.__mode = m; orig(m) }
    window.__wrapped = true
  }
  window.__mode = 'PENDING'
  const origToast = gm.showToast.bind(gm)
  gm.showToast = m => { console.log('TOAST:', m); origToast(m) }
  // No coordinates: the server issues a cloud opponent — no sight needed.
  window.__clashGame.scene.keys.MainScene.attackBotPlot(0, 'Cloud Camp')
})
const engaged = await page.waitForFunction(() => window.__mode === 'ATTACK', { timeout: 25000, polling: 250 }).then(() => true).catch(() => false)
if (!engaged) throw new Error('no raid engaged')
console.log('raiding cloud opponent')
await sleep(3500)
const hallAt = await page.evaluate(() => {
  const scene = window.__clashGame.scene.keys.MainScene
  scene.dayNight?.setPhaseOverride(0.3)
  const hall = scene.buildings.find(b => b.type === 'town_hall')
  if (!hall) return null
  // A stampede of elephants straight onto the keep.
  for (const [dx, dy] of [[-2, 0], [0, -2], [2, 3], [3, 1], [-1, 3], [3, -1]]) {
    scene.spawnTroop(hall.gridX + 1 + dx, hall.gridY + 1 + dy, 'warelephant', 'PLAYER', 3)
  }
  return { x: hall.gridX, y: hall.gridY }
})
console.log('hall at', JSON.stringify(hallAt))
if (!hallAt) throw new Error('no enemy hall found')
await page.evaluate(async at => {
  const { IsoUtils } = await import('/src/game/utils/IsoUtils.ts')
  const p = IsoUtils.cartToIso(at.x + 1.5, at.y + 1.5)
  const cam = window.__clashGame.scene.keys.MainScene.cameras.main
  cam.setZoom(2.6)
  cam.centerOn(p.x, p.y)
}, hallAt)
const gone = await page.waitForFunction(() => {
  const scene = window.__clashGame.scene.keys.MainScene
  return !scene.buildings.some(b => b.type === 'town_hall')
}, { timeout: 90000, polling: 500 }).then(() => true).catch(() => false)
console.log('hall destroyed:', gone)
await sleep(1600)
await page.screenshot({ path: `${OUT}-after.png` })
await browser.close()
const act2 = await api('GET', '/attacks/active')
if (act2?.session?.kind === 'bot') {
  await api('POST', '/attacks/bot-settle', { raidId: act2.session.raidId, x: act2.session.x, y: act2.session.y, destruction: 50, deployed: {}, requestId: `ffr2-${Date.now()}` })
}
console.log('done', `${OUT}-after.png`)
