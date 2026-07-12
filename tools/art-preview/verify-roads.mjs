// Visual battery for the roads batch: worn-path texture, real bot villages,
// merchant road arrival, road traffic + texture variety, and the road-march
// neighbour invasion with the battle fought in place on the world map.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5199'
const OUT = process.env.OUT ?? '/tmp/verify'
mkdirSync(OUT, { recursive: true })

const session = await (await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1380,940']
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1380, height: 940 })
  await page.evaluateOnNewDocument(tok => localStorage.setItem('clash.device.token', tok), session.token)
  const errors = []
  page.on('pageerror', e => { errors.push(String(e.message).slice(0, 200)); console.log('PAGE ERROR:', String(e.message).slice(0, 160)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 40000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(3000)

  // A. Worn paths: paint a route directly into the heat map, force a redraw.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.3)
    s.weather.setWeatherOverride(0)
    const vl = s.villageLife
    const heat = vl['pathHeat']
    const m = s.mapSize
    const put = (x, y, h) => { heat[y * m + x] = h }
    for (let x = 6; x <= 17; x++) put(x, 13, x < 9 ? 0.3 : 0.85)   // one long route, two bands
    for (let y = 9; y <= 13; y++) put(9, y, 0.55)                   // a branch
    vl['pathsDirty'] = true
    vl['nextPathRedrawAt'] = 0
    s.cameras.main.centerOn(0, 400)
    s.cameras.main.setZoom(1.5)
  })
  await sleep(600)
  await page.screenshot({ path: `${OUT}/m-worn-paths.png` })

  // B. Traffic + texture: force several travellers, look at a road.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const wm = s.worldMap
    for (let i = 0; i < 5; i++) { wm['nextTravellerAt'] = 0; wm['updateTravellers'](s.time.now + i) }
    // Park them spread along the visible south road.
    wm['travellers'].forEach((t, i) => { t.x = 4 + i * 5; t.y = 26; t.tx = 40; t.ty = 26; t.state = 'walk' })
    s.cameras.main.centerOn(-180, 560)
    s.cameras.main.setZoom(1.5)
  })
  await sleep(700)
  const kinds = await page.evaluate(() => window.__clashGame.scene.keys.MainScene.worldMap['travellers'].map(t => t.kind))
  await page.screenshot({ path: `${OUT}/n-road-traffic.png` })

  // C. Merchant: force a visit, catch him on the road walking up.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.villageLife['nextMerchantAt'] = 1
  })
  await sleep(1300)
  const merchantSpot = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const m = s.villageLife['merchant']
    if (!m) return null
    s.cameras.main.centerOn((m.x - m.y) * 32, (m.x + m.y) * 16)
    s.cameras.main.setZoom(1.7)
    return { x: m.x, y: m.y, state: m.state }
  })
  await sleep(400)
  await page.screenshot({ path: `${OUT}/o-merchant-road.png` })

  // D. Bot village layout: a neighbour postcard shows the new anatomy.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.worldMap['nextRefreshAt'] = 0
  })
  await sleep(4500)
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.centerOn(870, 420)
    s.cameras.main.setZoom(0.8)
  })
  await sleep(400)
  await page.screenshot({ path: `${OUT}/p-bot-village.png` })

  // E. THE MARCH: attack the east bot neighbour by road.
  const marchInfo = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const wm = s.worldMap
    const views = [...wm['views'].values()]
    const bot = views.find(v => v.plot.kind === 'bot')
    if (!bot) return null
    s.attackBotPlot(bot.plot.seed, bot.plot.username, bot.plot.x, bot.plot.y)
    return { x: bot.plot.x, y: bot.plot.y, me: wm['myPlot'] }
  })
  console.log('march target:', JSON.stringify(marchInfo))
  await sleep(2600)
  const midMarch = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const c = s.worldMap['caravan']
    return c ? { x: c.x, y: c.y, mode: s.mode } : { mode: s.mode }
  })
  await page.screenshot({ path: `${OUT}/q-caravan-march.png` })
  console.log('mid-march:', JSON.stringify(midMarch))

  // Wait for arrival + in-place battle.
  await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.mode === 'ATTACK', { timeout: 30000, polling: 300 })
  await sleep(1500)
  const battleState = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.centerOn(0, 400)
    s.cameras.main.setZoom(0.55)
    return {
      mode: s.mode,
      focus: s.worldMap['focusPlot'],
      postcards: s.worldMap['views'].size,
      enemyBuildings: s.buildings.filter(b => b.owner === 'ENEMY').length
    }
  })
  await sleep(600)
  await page.screenshot({ path: `${OUT}/r-battle-in-place.png` })
  console.log('battle state:', JSON.stringify(battleState))

  // Fight a little, then walk home; the world map must return to normal.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.hasDeployed = true
    s.spawnTroop(2, 12, 'warrior', 'PLAYER')
    s.spawnTroop(3, 12, 'archer', 'PLAYER')
  })
  await sleep(4000)
  await page.evaluate(async () => {
    const s = window.__clashGame.scene.keys.MainScene
    s.endAttackReplayCapture('aborted')
    await s.goHome()
  })
  await sleep(2500)
  const homeState = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    return { mode: s.mode, focus: s.worldMap['focusPlot'], views: s.worldMap['views'].size }
  })
  console.log('back home:', JSON.stringify(homeState))

  const fps = await page.evaluate(() => Math.round(window.__clashGame.loop.actualFps))
  console.log('traffic kinds:', JSON.stringify(kinds), '| merchant:', JSON.stringify(merchantSpot))
  console.log(`fps=${fps}, page errors=${errors.length ? errors : 'none'}`)
  if (errors.length > 0) process.exitCode = 1
} finally {
  await browser.close()
}
