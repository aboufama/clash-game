import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
const BASE = process.env.BASE ?? 'http://127.0.0.1:5174'
const TOKEN_CACHE = new URL('./.trailer-device-token.json', import.meta.url)
const TOKEN = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (m, p, b) => {
  const r = await fetch(`${BASE}/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: m === 'POST' ? JSON.stringify(b ?? {}) : undefined })
  return r.json().catch(() => null)
}
// settle any stale raid
const act = await api('GET', '/attacks/active')
if (act?.session?.kind === 'bot') {
  await api('POST', '/attacks/bot-settle', { raidId: act.session.raidId, x: act.session.x, y: act.session.y, destruction: 0, deployed: {}, requestId: `diag-${Date.now()}` })
}
const map = await api('GET', '/map?r=6')
const camps = (map?.plots ?? []).filter(p => p.kind === 'bot' && p.world)
const target = camps.find(p => (p.world.buildings ?? []).filter(b => b.type === 'wall').length >= 90) ?? camps[0]
const serverWalls = (target.world.buildings ?? []).filter(b => b.type === 'wall').length
console.log('target', target.username, '@', target.x, target.y, 'serverWalls', serverWalls, 'serverBuildings', target.world.buildings.length)
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 720 })
await page.evaluateOnNewDocument(t => localStorage.setItem('clash.device.token', t), TOKEN)
await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => {
  const s = window.__clashGame?.scene?.keys?.MainScene
  return Boolean(s?.worldMap && s?.cameras?.main && s?.buildings?.length)
}, { timeout: 60000, polling: 300 })
await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 25000 }).catch(() => {})
await sleep(800)
await page.evaluate(plot => {
  const gm = window.__clashGM
  const orig = gm.setGameMode.bind(gm)
  gm.setGameMode = m => { window.__gameMode = m; orig(m) }
  window.__clashGame.scene.keys.MainScene.attackBotPlot(plot.seed, plot.username, plot.x, plot.y)
}, { seed: target.seed, username: target.username, x: target.x, y: target.y })
await page.waitForFunction(() => window.__gameMode === 'ATTACK', { timeout: 40000, polling: 250 })
await sleep(5000)
const sceneState = await page.evaluate(() => {
  const scene = window.__clashGame.scene.keys.MainScene
  const list = (scene.buildings ?? []).map(b => ({ type: b.type ?? b.buildingType, x: b.gridX, y: b.gridY }))
  const walls = list.filter(b => b.type === 'wall').length
  const counts = {}
  for (const b of list) counts[b.type] = (counts[b.type] ?? 0) + 1
  return { total: list.length, walls, counts }
})
console.log('scene during battle:', JSON.stringify(sceneState))
await browser.close()
