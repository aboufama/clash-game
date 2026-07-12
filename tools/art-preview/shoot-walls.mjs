// Wall layering test: ring, staircase, cross, T-junctions at L1 and L4.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = new URL('./shots/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const walls = []
const W = (x, y, level) => walls.push(['wall', level, x, y])

// 1. Closed ring around a cannon (L1), 6x5 at (2,2)
for (let x = 2; x <= 7; x++) { W(x, 2, 1); W(x, 6, 1) }
for (let y = 3; y <= 5; y++) { W(2, y, 1); W(7, y, 1) }

// 2. Diagonal staircase (L1) from (10,2)
let sx = 10, sy = 2
for (let i = 0; i < 5; i++) { W(sx, sy, 1); W(sx, sy + 1, 1); sx += 1; sy += 1 }

// 3. Cross + T junctions (L1) at (18,4)
for (let x = 16; x <= 20; x++) W(x, 4, 1)
for (let y = 2; y <= 6; y++) W(18, y, 1)

// 4. Same three patterns in L4 further south
for (let x = 2; x <= 7; x++) { W(x, 12, 4); W(x, 16, 4) }
for (let y = 13; y <= 15; y++) { W(2, y, 4); W(7, y, 4) }
sx = 10; sy = 12
for (let i = 0; i < 5; i++) { W(sx, sy, 4); W(sx, sy + 1, 4); sx += 1; sy += 1 }
for (let x = 16; x <= 20; x++) W(x, 14, 4)
for (let y = 12; y <= 16; y++) W(18, y, 4)

// 5. Buildings interacting with walls (behind/in front)
const SHOWCASE = [
  ...walls,
  ['cannon', 2, 4, 4, 1, 1],
  ['cannon', 3, 4, 14, 1, 1],
  ['barracks', 8, 11, 19, 2, 2],
  ['town_hall', 1, 16, 19, 3, 3]
]
// wall row behind + in front of the barracks
for (let x = 10; x <= 14; x++) { SHOWCASE.push(['wall', 4, x, 18]); SHOWCASE.push(['wall', 4, x, 22]) }

async function api(path, body, token) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {})
  })
  return res.json()
}

const session = await api('/auth/session')
const world = session.world
world.buildings = SHOWCASE.map(([type, level, gridX, gridY], i) => ({ id: `w_${i}`, type, gridX, gridY, level }))
await api('/world/save', { world, requestId: 'walltest' }, session.token)

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => localStorage.setItem('clash.device.token', tok), session.token)
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 20, { timeout: 45000, polling: 500 })
  await new Promise(r => setTimeout(r, 1500))

  const spots = [
    ['ring-L1', 4.5, 4.5, 2.6], ['stairs-L1', 12.5, 4.5, 2.6], ['cross-L1', 18, 4.5, 2.6],
    ['ring-L4', 4.5, 14, 2.6], ['stairs-L4', 12.5, 14, 2.6], ['cross-L4', 18, 14, 2.6],
    ['bldg-walls', 12, 20, 2.2], ['overview', 11, 11, 1.1]
  ]
  for (const [name, gx, gy, zoom] of spots) {
    await page.evaluate(({ gx, gy, zoom }) => {
      const scene = window.__clashGame.scene.keys.MainScene
      scene.cameras.main.setZoom(zoom)
      scene.cameras.main.centerOn((gx - gy) * 32, (gx + gy) * 16 - 10)
    }, { gx, gy, zoom })
    await new Promise(r => setTimeout(r, 250))
    await page.screenshot({ path: `${OUT}wall-${name}.png`, clip: { x: 340, y: 150, width: 600, height: 600 } })
  }
  console.log('wall shots done')
} finally {
  await browser.close()
}
