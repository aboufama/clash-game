// Screenshot probe: force the town hall to 0 health and frame the fallen
// standard, day and night.
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
const BASE = process.env.BASE ?? 'http://127.0.0.1:5174'
const OUT = process.env.OUT ?? '/tmp/fallen-flag'
const sleep = ms => new Promise(r => setTimeout(r, ms))
// Resume or mint the probe identity, then choose a banner — the flag only
// renders once a banner choice is stored.
let cached = null
try {
  cached = JSON.parse(readFileSync(new URL('./.trailer-device-token.json', import.meta.url), 'utf8')).token
} catch { /* minted below */ }
const session = await (await fetch(`${BASE}/api/auth/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cached ? { token: cached } : {})
})).json()
const TOKEN = session.token
const bannerResponse = await fetch(`${BASE}/api/player/banner`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ banner: { palette: 0, emblem: 3, pattern: 1 } })
})
console.log('banner:', bannerResponse.status)
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
await page.evaluateOnNewDocument(t => localStorage.setItem('clash.device.token', t), TOKEN)
await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => {
  const s = window.__clashGame?.scene?.keys?.MainScene
  return Boolean(s?.worldMap && s?.cameras?.main && s?.buildings?.length)
}, { timeout: 60000, polling: 300 })
await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 25000 }).catch(() => {})
await page.addStyleTag({ content: `.app-container > :not(#game-container) { opacity: 0 !important; pointer-events: none !important; }
  .village-bubble-layer, .plot-bubble, .building-bubble { display: none !important; }` })
await sleep(1000)
const framed = await page.evaluate(async () => {
  const scene = window.__clashGame.scene.keys.MainScene
  const hall = scene.buildings.find(b => b.type === 'town_hall')
  if (!hall) return null
  // Drive the banner meta directly — the probe tests the flag renderer, not
  // the onboarding flow.
  scene.villageBannerMeta = {
    identity: 'probe:fallen-flag',
    banner: { palette: 0, emblem: 3, pattern: 1 },
    allowFallback: true
  }
  hall.health = 0
  scene.dayNight?.setPhaseOverride(0.3)
  const { IsoUtils } = await import('/src/game/utils/IsoUtils.ts')
  const p = IsoUtils.cartToIso(hall.gridX + 2.6, hall.gridY + 2.6)
  scene.cameras.main.setZoom(4.2)
  scene.cameras.main.centerOn(p.x, p.y - 6)
  return { x: hall.gridX, y: hall.gridY }
})
console.log('hall', JSON.stringify(framed))
await sleep(800)
await page.screenshot({ path: `${OUT}-day.png` })
await page.evaluate(() => {
  window.__clashGame.scene.keys.MainScene.dayNight?.setPhaseOverride(0.8)
})
await sleep(1200)
await page.screenshot({ path: `${OUT}-night.png` })
await browser.close()
console.log('shots at', OUT)
