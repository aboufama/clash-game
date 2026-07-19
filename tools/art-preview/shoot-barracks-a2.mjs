// Refinement QA harness for the Mechanica barracks (design A "Foundry
// Bastion") — cribbed from tools/art-preview/shoot-faction-barracks.mjs.
// Differences: rebakes the ground after every world/level apply (the shared
// harness leaks the starter village's town-hall stone border into the ground
// bake), and clears village-life entities so the plot reads clean.
//
// BASE=http://127.0.0.1:5173 PHASE=0.3 LEVELS=1..9 DOOR=1 BURST=6 node shoot-barracks-a2.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = (process.env.OUT ?? '/private/tmp/claude-scratch-design-tournament/barracks-A2/work').replace(/\/$/, '')
const PHASE = Number(process.env.PHASE ?? 0.3)
const DOOR = process.env.DOOR === '1'
const BURST = Math.max(1, Number(process.env.BURST ?? 1))
const BURST_MS = Math.max(50, Number(process.env.BURST_MS ?? 500))
const LEVELS = (process.env.LEVELS ?? '1,2,3,4,5,6,7,8,9')
  .split(',').map(Number).filter(level => Number.isInteger(level) && level >= 1 && level <= 9)
const TYPE = 'barracks'
mkdirSync(OUT, { recursive: true })

const tokenFile = '/Users/andreboufama/Documents/MISC/clash-game/tools/art-preview/.shared-device-token.json'
let token = null
try { token = JSON.parse(readFileSync(tokenFile, 'utf8')).token ?? null } catch { /* none */ }
if (!token) throw new Error('no shared device token — refusing to mint a guest session')
const resumed = await (await fetch(`${BASE}/api/auth/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token })
})).json()
if (!resumed?.token) throw new Error(`auth/session resume failed: ${JSON.stringify(resumed)}`)

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(sessionToken => {
    localStorage.setItem('clash.device.token', sessionToken)
    localStorage.setItem('clash.sprites.off', '1')      // vector authoring view
    localStorage.setItem('clash.design.barracks', 'A')  // pin design slot A
  }, resumed.token)

  const errors = []
  page.on('pageerror', error => errors.push(String(error.message ?? error)))
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 90_000, polling: 500 })
  await sleep(5000)

  const applyPreview = async (level) => {
    await page.evaluate(({ type, level: lv, phase, door }) => {
      const scene = window.__clashGame.scene.keys.MainScene
      scene.applyWorldToScene({
        id: 'barracks-a2-preview', ownerId: 'barracks-a2-preview', username: 'ART PREVIEW',
        buildings: [{ id: 'preview_barracks', type, gridX: 11, gridY: 11, level: lv,
          doorOpen: door ? 1 : 0 }],
        obstacles: [], resources: { gold: 0, ore: 0, food: 0 }, lastSaveTime: Date.now(),
        life: { version: 1, identity: 'barracks-a2-preview', population: 0, bornAt: [], simulatedThrough: Date.now() }
      })
      // The apply keeps the previous village's ground bake — rebake clean.
      scene.rebakeGround('barracks-a2-preview')
      // No wandering figures in art shots.
      const vl = scene.villageLife
      if (vl?.entities) { for (const e of vl.entities) e.gfx?.destroy?.(); vl.entities = [] }
      const building = scene.buildings[0]
      building.doorOpen = door ? 1 : 0
      building.doorOpenUntil = door ? Number.POSITIVE_INFINITY : 0
      building.lastDrawDoorOpen = -1
      scene.dayNight.setPhaseOverride(phase)
      scene.weather.setWeatherOverride(0)
      scene.dayNight.resyncLights?.()
      const isoY = ((11 + 1) + (11 + 1)) * 16
      scene.cameras.main.setZoom(3.2)
      scene.cameras.main.centerOn(0, isoY - 18)
    }, { type: TYPE, level, phase: PHASE, door: DOOR })
  }

  const writtenShots = []
  for (const level of LEVELS) {
    await applyPreview(level)
    await sleep(1400)
    for (let shot = 0; shot < BURST; shot++) {
      if (shot) await sleep(BURST_MS)
      const phaseTag = PHASE >= 0.7 ? 'night' : 'day'
      const doorTag = DOOR ? '-open' : ''
      const burstTag = BURST > 1 ? `-t${shot}` : ''
      const path = `${OUT}/${TYPE}-L${level}-${phaseTag}${doorTag}${burstTag}.png`
      await page.screenshot({ path, clip: { x: 340, y: 145, width: 600, height: 610 } })
      if (shot === 0) writtenShots.push({ level, path })
    }
  }

  const sheet = await browser.newPage()
  await sheet.setViewport({ width: Math.max(920, LEVELS.length * 202 + 20), height: 288 })
  const cards = writtenShots.map(({ level, path }) => {
    const src = `data:image/png;base64,${readFileSync(path).toString('base64')}`
    return `<figure><figcaption>${TYPE} · L${level}</figcaption><img src="${src}"></figure>`
  }).join('')
  await sheet.setContent(`<style>
    html,body{margin:0;background:#202630;color:#f3ead5;font:13px system-ui}
    h1{font-size:16px;margin:10px 12px}.grid{display:grid;grid-template-columns:repeat(${LEVELS.length},190px);gap:12px;padding:0 12px 12px}
    figure{margin:0;background:#303844;border:1px solid #4b5766}figcaption{padding:5px 7px;white-space:nowrap}
    img{display:block;width:188px;height:188px;object-fit:cover;image-rendering:pixelated}
  </style><h1>Foundry Bastion A2 · ${PHASE >= 0.7 ? 'night' : 'day'} · ${DOOR ? 'doors open' : 'doors closed'}</h1><div class="grid">${cards}</div>`)
  await sheet.screenshot({ path: `${OUT}/contact-${PHASE >= 0.7 ? 'night' : 'day'}${DOOR ? '-open' : ''}.png`, fullPage: true })
  await sheet.close()

  console.log(JSON.stringify({ status: 'ok', levels: LEVELS, phase: PHASE, door: DOOR, pageErrors: errors }))
  if (errors.length) process.exitCode = 1
} finally {
  await browser.close()
}
