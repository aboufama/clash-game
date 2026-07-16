// Quartermaster design-B verification shots (clean-room tournament).
//
// Draws the design directly through the BakeBridge's TroopRenderer with
// PINNED times on a paused scene, so every beat/stride phase is exact:
//   row 1: 3 levels x both palettes (idle, poised)   row 2: 2000ms beat series
//   row 3: 450ms walk series                          plus closeup + night.
//
//   BASE=http://127.0.0.1:5173 node shoot-quartermaster-b.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = (process.env.OUT ?? new URL('./shots/quartermaster-b', import.meta.url).pathname).replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

// Shared identity — never mint sessions (guest creation is rate-limited and
// junks the world map).
const token = JSON.parse(readFileSync(new URL('./.shared-device-token.json', import.meta.url), 'utf8')).token

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => {
    localStorage.setItem('clash.device.token', tok)
    localStorage.setItem('clash.sprites.off', '1')          // vector authoring path
    localStorage.setItem('clash.design.quartermaster', 'B') // this design
  }, token)
  const errors = []
  page.on('pageerror', e => { errors.push(String(e.message).slice(0, 160)); console.log('PAGE ERROR:', String(e.message).slice(0, 160)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(2500)

  // Day, calm, then freeze the world. Direct pinned-time draws from here on.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather.setWeatherOverride(0)
    window.__QBG = []
    window.__QB = (gx, gy, { owner = 'PLAYER', level = 1, moving = false, t = 0 } = {}) => {
      const g = s.add.graphics()
      g.setPosition((gx - gy) * 32, (gx + gy) * 16)
      g.setDepth(500000)
      window.__clashBake.TroopRenderer.drawTroopVisual(
        g, 'quartermaster', owner, 0, moving, 0, 0, false, 0, level, t, -1, 0)
      window.__QBG.push(g)
      return true
    }
    window.__QBclear = () => { for (const g of window.__QBG) g.destroy(); window.__QBG = [] }
  })
  await sleep(700) // let the day grade settle
  await page.evaluate(() => window.__clashGame.scene.pause('MainScene'))

  const cam = (wx, wy, zoom) => page.evaluate(({ wx, wy, zoom }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn(wx, wy)
  }, { wx, wy, zoom })
  const shot = (name, clip) => page.screenshot({ path: `${OUT}/${name}.png`, clip })
  const rowClip = { x: 60, y: 240, width: 1160, height: 420 }

  const draw = (gx, gy, opts) => page.evaluate(({ gx, gy, opts }) => window.__QB(gx, gy, opts), { gx, gy, opts })
  // Screen-horizontal rows: step (gx + d, gy - d) so gx+gy (screen y) stays
  // constant; d = 0.75 grid gives 48 world px spacing.
  const rowSpots = (gx0, gy0, n, d = 0.75) =>
    Array.from({ length: n }, (_, i) => [gx0 + i * d, gy0 - i * d])
  const rowCam = async (spots, zoom) => {
    const wx = spots.map(([x, y]) => (x - y) * 32).reduce((a, b) => a + b, 0) / spots.length
    const wy = (spots[0][0] + spots[0][1]) * 16 - 12 // art spans y -34..+10
    await cam(wx, wy, zoom)
  }

  // ---------- row 1: levels x palettes (idle, poised phase t=1350) ----------
  const r1 = rowSpots(10, 20, 6, 0.85)
  for (const [i, [gx, gy]] of r1.entries()) {
    await draw(gx, gy, { owner: i < 3 ? 'PLAYER' : 'ENEMY', level: (i % 3) + 1, moving: false, t: 1350 })
  }
  await rowCam(r1, 3.2)
  await shot('r1-levels-P123-E123-day', rowClip)

  // ---------- row 2: the 2000ms war-drum beat, 8 phase samples ----------
  const beatTimes = [0, 250, 450, 560, 640, 800, 1100, 1350]
  const r2 = rowSpots(10, 22, 8)
  for (const [i, [gx, gy]] of r2.entries()) {
    await draw(gx, gy, { owner: 'PLAYER', level: 3, moving: false, t: beatTimes[i] })
  }
  await rowCam(r2, 3.2)
  await shot('r2-idle-beat-2000ms-8phases', rowClip)

  // ---------- row 3: the 450ms march, 6 phase samples (one exact period) ----------
  const walkTimes = [0, 75, 150, 225, 300, 375]
  const r3 = rowSpots(13.5, 23.5, 6)
  for (const [i, [gx, gy]] of r3.entries()) {
    await draw(gx, gy, { owner: 'PLAYER', level: 2, moving: true, t: walkTimes[i] })
  }
  await rowCam(r3, 3.2)
  await shot('r3-walk-450ms-6phases', rowClip)

  // ---------- closeup: L3 player, poised + contact (clean stage) ----------
  await page.evaluate(() => window.__QBclear())
  await draw(14, 21, { owner: 'PLAYER', level: 3, moving: false, t: 450 })     // poised
  await draw(15.5, 19.5, { owner: 'PLAYER', level: 3, moving: false, t: 640 }) // contact flash + glint
  await cam(((14.75) - (20.25)) * 32, (14 + 21) * 16 - 26, 6)
  await shot('r4-closeup-L3-poised-and-strike', { x: 240, y: 130, width: 800, height: 640 })
  // restore the three rows for the night pass
  for (const [i, [gx, gy]] of r1.entries()) {
    await draw(gx, gy, { owner: i < 3 ? 'PLAYER' : 'ENEMY', level: (i % 3) + 1, moving: false, t: 1350 })
  }

  // ---------- night pass (phase 0.8) on the level/palette row ----------
  await page.evaluate(() => window.__clashGame.scene.resume('MainScene'))
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.8)
  })
  await sleep(900)
  await page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  await rowCam(r1, 3.2)
  await shot('r5-levels-night', rowClip)

  await page.evaluate(() => window.__clashGame.scene.resume('MainScene'))
  console.log('quartermaster-B shots done →', OUT, 'errors:', errors.length ? errors : 'none')
} finally {
  await browser.close()
}
