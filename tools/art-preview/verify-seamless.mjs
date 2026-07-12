// Battery for the seamless batch: zoomed-out rain, stone paths, per-village
// grass in postcards AND in-place battles, night+rain persisting through a
// neighbour raid, hidden name UI, new road cast, and the rebuilt dragons
// breath / frostfall impacts.
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

  // A. Rain fully zoomed out — streaks must stay dense and screen-sized.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.3)
    s.weather.setWeatherOverride(1)
    s.worldMap['nextRefreshAt'] = 0
    s.cameras.main.centerOn(430, 480)
    s.cameras.main.setZoom(0.4)
  })
  await sleep(4500)
  await page.screenshot({ path: `${OUT}/s-rain-zoomed-out.png` })

  // B. Stone paths, fully matured, on the home lawn.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.weather.setWeatherOverride(0)
    const vl = s.villageLife
    vl['stoneMaturitySeconds'] = 9999
    vl['stoneLayoutHash'] = ''
    vl['nextStoneUpdateAt'] = 0
    s.cameras.main.centerOn(0, 400)
    s.cameras.main.setZoom(1.3)
  })
  await sleep(2600)
  const stoneState = await page.evaluate(() => {
    const vl = window.__clashGame.scene.keys.MainScene.villageLife
    return { routes: vl['stoneRoutes'].map(r => r.key), maturity: vl['stoneMaturity'] }
  })
  await page.screenshot({ path: `${OUT}/t-stone-paths.png` })

  // C. Per-village grass: postcards vary; note the target's palette key.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.centerOn(430, 480)
    s.cameras.main.setZoom(0.5)
  })
  await sleep(600)
  await page.screenshot({ path: `${OUT}/u-grass-variation.png` })

  // D. THE SEAMLESS RAID: night + rain, then march on a neighbour.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.8)
    s.weather.setWeatherOverride(0.85)
  })
  await sleep(2200)
  const targetInfo = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const views = [...s.worldMap['views'].values()]
    const bot = views.find(v => v.plot.kind === 'bot')
    s.attackBotPlot(bot.plot.seed, bot.plot.username, bot.plot.x, bot.plot.y)
    return { x: bot.plot.x, y: bot.plot.y, seed: bot.plot.seed }
  })
  await sleep(2500)
  await page.screenshot({ path: `${OUT}/v-march-night-rain.png` })
  await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.mode === 'ATTACK', { timeout: 30000, polling: 300 })
  await sleep(1200)
  const seamless = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const plates = [...document.querySelectorAll('.map-plate')]
    return {
      mode: s.mode,
      battleInPlace: s.battleInPlace,
      groundKey: s['groundPaletteKey'],
      nightStrength: Math.round(s.dayNight['strength'] * 100) / 100,
      rainShown: Math.round(s.weather['shownIntensity'] * 100) / 100,
      platesVisible: plates.filter(p => p.style.display !== 'none').length,
      nameLabelVisible: s.villageNameLabel.visible,
      postcards: s.worldMap['views'].size
    }
  })
  console.log('seamless state:', JSON.stringify(seamless))
  await page.screenshot({ path: `${OUT}/w-battle-night-rain.png` })

  // E. Impacts on this battlefield: dragons breath pod + frostfall shard.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.3)
    s.weather.setWeatherOverride(0)
    s.hasDeployed = true
    s.spawnTroop(8, 16, 'giant', 'PLAYER')
    const fakeDb = { type: 'dragons_breath', owner: 'ENEMY', health: 500, gridX: 12, gridY: 12, level: 2 }
    const silo = { x: (12 - 12) * 32, y: (12 + 12) * 16 - 14 }
    s['shootDragonPod'](fakeDb, silo, 8, 16, 0)
    s.cameras.main.centerOn((8 - 16) * 32 + 60, (8 + 16) * 16)
    s.cameras.main.setZoom(1.6)
  })
  await sleep(1180)
  await page.screenshot({ path: `${OUT}/x-dragon-impact.png` })
  await sleep(500)

  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const fakeFrost = { id: 'vf_frost', type: 'frostfall', owner: 'ENEMY', health: 500, gridX: 10, gridY: 14, level: 2, lastFireTime: 0 }
    s['shootFrostfallShard'](fakeFrost, s.time.now)
  })
  await sleep(5150) // 4200 rise + 600 flight + settle
  await page.screenshot({ path: `${OUT}/y-frost-impact.png` })
  await sleep(3200) // half-melted
  await page.screenshot({ path: `${OUT}/z-frost-melting.png` })

  // F. Home again — lawn, label and plates restored.
  await page.evaluate(async () => {
    const s = window.__clashGame.scene.keys.MainScene
    s.endAttackReplayCapture('aborted')
    await s.goHome()
  })
  await sleep(2500)
  const homeState = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    return { mode: s.mode, groundKey: s['groundPaletteKey'], label: s.villageNameLabel.visible, battleInPlace: s.battleInPlace }
  })
  const kinds = await page.evaluate(() => {
    const wm = window.__clashGame.scene.keys.MainScene.worldMap
    for (let i = 0; i < 8; i++) { wm['nextTravellerAt'] = 0; wm['updateTravellers'](window.__clashGame.scene.keys.MainScene.time.now + i) }
    return wm['travellers'].map(t => t.kind)
  })

  const fps = await page.evaluate(() => Math.round(window.__clashGame.loop.actualFps))
  console.log('stone paths:', JSON.stringify(stoneState))
  console.log('target:', JSON.stringify(targetInfo), '| home:', JSON.stringify(homeState))
  console.log('traffic kinds:', JSON.stringify(kinds))
  console.log(`fps=${fps}, page errors=${errors.length ? errors : 'none'}`)
  if (errors.length > 0) process.exitCode = 1
} finally {
  await browser.close()
}
