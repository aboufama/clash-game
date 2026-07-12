// Focused check: army-camp figures (VillageLifeSystem reuses the troop
// renderer at 0.92 scale — verify they read at villager scale at the camp).
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5301'
const OUT = (process.env.OUT ?? '/tmp/verify/troops').replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

const session = await (await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const api = async (path, body) => (await fetch(`${BASE}/api${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
  body: body === undefined ? undefined : JSON.stringify(body)
})).json()

await api('/resources/apply', { delta: 500000, reason: 'debug_grant', requestId: 'pc-g' }).catch(() => {})
const world = (await api('/world')).world ?? session.world
if (!world.buildings.some(b => b.type === 'army_camp')) {
  world.buildings.push({ id: 'PCAMP', type: 'army_camp', gridX: 15, gridY: 15, level: 1 })
  const saved = await api('/world/save', { world, requestId: 'probe-camp' })
  if (saved?.error) console.log('save failed:', saved.error)
}
for (let i = 0; i < 4; i++) await api('/army/train', { type: 'warrior', requestId: `pc-w${i}` }).catch(() => {})
const camp = world.buildings.find(b => b.type === 'army_camp')
console.log('camp at', camp?.gridX, camp?.gridY)

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
  page.on('pageerror', e => console.log('PAGE ERROR:', String(e.message).slice(0, 160)))
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 40000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather.setWeatherOverride(0)
  })
  await sleep(12000) // let figures spawn at the barracks and march to camp
  const st = await page.evaluate(({ cx, cy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    const vl = s.villageLife
    const n = vl.campFigures ? vl.campFigures.length : -1
    s.cameras.main.setZoom(3)
    s.cameras.main.centerOn((cx - cy) * 32, (cx + cy) * 16 - 6)
    return { figures: n }
  }, { cx: (camp?.gridX ?? 15) + 1, cy: (camp?.gridY ?? 15) + 1 })
  console.log('camp figures:', JSON.stringify(st))
  await sleep(1200)
  await page.screenshot({ path: `${OUT}/e1-army-camp-figures.png`, clip: { x: 340, y: 150, width: 600, height: 600 } })
  console.log('camp shot done')
} finally {
  await browser.close()
}
