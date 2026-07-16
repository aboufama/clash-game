// Screenshot the baked village figures: day wide, day close-up, night owl window.
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:5173'
const OUT = process.env.OUT ?? '.'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)))
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(3000)

  // Day, camera on the village center where the life entities wander.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.35)
    s.weather?.setWeatherOverride?.(0)
    s.cameras.main.setZoom(1.6)
    const e = s.villageLife?.entities?.[0]
    if (e) {
      const IsoLike = { x: (e.x - e.y) * 32, y: (e.x + e.y) * 16 }
      s.cameras.main.centerOn(IsoLike.x, IsoLike.y)
    } else {
      s.cameras.main.centerOn(32, 420)
    }
  })
  await sleep(1500)
  await page.screenshot({ path: `${OUT}/fig-day-wide.png` })

  // Tight zoom on the first villager for texel inspection.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(4)
  })
  await sleep(900)
  await page.screenshot({ path: `${OUT}/fig-day-close.png` })

  const stats = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const vl = s.villageLife
    const kinds = {}
    for (const e of vl?.entities ?? []) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
    // Count live bank Images that use villager-kind atlases.
    let figureSprites = 0
    for (const child of s.children.list) {
      if (child.texture?.key?.startsWith?.('bank:villagers:')) figureSprites++
    }
    return { entities: vl?.entities?.length ?? 0, kinds, figureSprites }
  })
  console.log('STATS', JSON.stringify(stats))
  console.log('PAGEERRORS', JSON.stringify(errors.slice(0, 5)))
} finally {
  await browser.close()
}
