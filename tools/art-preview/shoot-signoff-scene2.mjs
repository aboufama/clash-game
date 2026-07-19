// Scene pass 2 for the remaining sign-off slots: fixes the night-grade rect (it only
// re-stretches on live frames — so run a short live window per row AFTER the
// camera move), freezes troops (speedMult=0 + repin) so heal-seekers and
// summons don't drift, and moves the trebuchet row out of the edge cloud bank.
//   BASE=http://127.0.0.1:5175 OUT=<dir> node shoot-signoff-scene2.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5175'
const OUT = (process.env.OUT ?? new URL('./shots/signoff-five/scene2', import.meta.url).pathname).replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

const token = JSON.parse(readFileSync(new URL('./.shared-device-token.json', import.meta.url), 'utf8')).token
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => {
    localStorage.setItem('clash.device.token', tok)
    localStorage.setItem('clash.sprites.off', '1')
  }, token)
  page.on('pageerror', e => console.log('PAGE ERROR:', String(e.message).slice(0, 240)))
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 60000, polling: 500 })
  await sleep(2500)

  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather?.setWeatherOverride?.(0)
    const cast = [
      ['clockworkbeetle', 6, 13.5, 'PLAYER', 1], ['clockworkbeetle', 7.5, 13.5, 'PLAYER', 2], ['clockworkbeetle', 9, 13.5, 'PLAYER', 3],
      ['clockworkbeetle', 7.5, 15, 'ENEMY', 2],
      ['skeleton', 11.5, 13.5, 'PLAYER', 1], ['skeleton', 12.7, 13.5, 'PLAYER', 2], ['skeleton', 13.9, 13.5, 'PLAYER', 3],
      ['skeleton', 12.7, 15, 'ENEMY', 2],
      ['necromancer', 16.5, 13.5, 'PLAYER', 1], ['necromancer', 18.2, 13.5, 'PLAYER', 2], ['necromancer', 19.9, 13.5, 'PLAYER', 3],
      ['necromancer', 18.2, 15.3, 'ENEMY', 2],
      ['physicianscart', 14, 9.3, 'PLAYER', 1], ['physicianscart', 17, 9.3, 'PLAYER', 2], ['physicianscart', 20, 9.3, 'PLAYER', 3],
      ['physicianscart', 17, 11.6, 'ENEMY', 2],
      ['trebuchet', 6, 18, 'PLAYER', 1], ['trebuchet', 10.5, 18, 'PLAYER', 2],
      ['trebuchet', 6, 21, 'PLAYER', 3], ['trebuchet', 10.5, 21, 'ENEMY', 2],
      ['warrior', 21.4, 13.5, 'PLAYER', 1], ['warrior', 11.8, 9.5, 'PLAYER', 1], ['warrior', 13.5, 19.5, 'PLAYER', 1]
    ]
    window.__PINS = []
    for (const [type, x, y, owner, lvl] of cast) {
      s.spawnTroop(x, y, type, owner, lvl)
      window.__PINS.push([x, y])
    }
    s.troops.forEach((t, i) => {
      t.target = null; t.path = undefined; t.navigationPlan = undefined
      t.strategicTarget = null; t.facingAngle = 0.45; t.speedMult = 0
      t.lastAttackTime = -1e7
    })
  })
  await sleep(700)

  const repin = () => page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.troops.forEach((t, i) => {
      const pin = window.__PINS[i]
      if (pin) { t.gridX = pin[0]; t.gridY = pin[1] }
      t.target = null; t.path = undefined; t.navigationPlan = undefined
      t.strategicTarget = null; t.facingAngle = 0.45; t.speedMult = 0
    })
  })
  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const pause = () => page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  const resume = () => page.evaluate(() => window.__clashGame.scene.resume('MainScene'))
  const poseAll = () => page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    for (const t of s.troops) {
      t.lastAttackTime = -1e7
      s.redrawTroopWithMovement(t, false)
    }
  })
  const shot = (name, clip = { x: 240, y: 150, width: 800, height: 600 }) =>
    page.screenshot({ path: `${OUT}/${name}.png`, clip })

  const rows = [
    ['beetle-row', 7.5, 14.2, 3.6, -4],
    ['skeleton-row', 12.7, 14.2, 3.6, -4],
    ['necro-row', 18.2, 14.4, 3.2, -6],
    ['cart-row', 17, 10.4, 2.4, -6],
    ['trebuchet-row', 8.3, 19.5, 1.9, -8]
  ]
  const passRows = async tag => {
    for (const [name, x, y, z, dy] of rows) {
      await repin()
      await cam(x, y, z, dy)
      await sleep(420)      // live frames: grade rect re-stretches to this view
      await pause()
      await poseAll()
      await shot(`${name}-${tag}`)
      await resume()
      await sleep(60)
    }
  }
  await passRows('day')
  await page.evaluate(() => { window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.8) })
  await sleep(1500)
  await passRows('night')
  await page.evaluate(() => { window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.32) })
  console.log('scene2 →', OUT)
} finally {
  await browser.close()
}
