// TEMP harness (mystic_barracks design-A refinement round) — do not commit.
// Cribbed from shoot-faction-barracks.mjs; forces vector mode + design slot A.
//
// BASE=http://127.0.0.1:5173 PHASE=0.3 LEVELS=1,5,9 DOOR=0 BURST=1 TAG=base node shoot-mystic-a2.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = (process.env.OUT ?? '/private/tmp/claude-scratch-design-tournament/mystic_barracks-A2/shots').replace(/\/$/, '')
const PHASE = Number(process.env.PHASE ?? 0.3)
const DOOR = Number(process.env.DOOR ?? 0)               // 0..1 continuous
const BURST = Math.max(1, Number(process.env.BURST ?? 1))
const BURST_MS = Math.max(50, Number(process.env.BURST_MS ?? 500))
const TAG = process.env.TAG ?? ''
const TYPE = 'mystic_barracks'
const LEVELS = (process.env.LEVELS ?? '1,2,3,4,5,6,7,8,9')
  .split(',').map(Number).filter(l => Number.isInteger(l) && l >= 1 && l <= 9)
mkdirSync(OUT, { recursive: true })

const tokenFile = new URL('./.shared-device-token.json', import.meta.url).pathname
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
    localStorage.setItem('clash.sprites.off', '1')
    localStorage.setItem('clash.design.mystic_barracks', 'A')
  }, resumed.token)

  const errors = []
  page.on('pageerror', error => errors.push(String(error.message ?? error)))
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 90_000, polling: 500 })
  await sleep(5000)

  await page.evaluate(({ type, level, phase }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.applyWorldToScene({
      id: 'barracks-art-preview', ownerId: 'barracks-art-preview', username: 'ART PREVIEW',
      buildings: [{ id: 'preview_barracks', type, gridX: 11, gridY: 11, level }],
      obstacles: [], resources: { gold: 0, ore: 0, food: 0 }, lastSaveTime: Date.now()
    })
    scene.dayNight.setPhaseOverride(phase)
    scene.weather.setWeatherOverride(0)
  }, { type: TYPE, level: LEVELS[0], phase: PHASE })
  await sleep(5200)

  const writtenShots = []
  for (const level of LEVELS) {
    await page.evaluate(({ type: unit, level: lv, phase, door }) => {
      const scene = window.__clashGame.scene.keys.MainScene
      scene.dayNight.setPhaseOverride(phase)
      scene.weather.setWeatherOverride(0)
      const building = scene.buildings[0]
      window.__clashBake?.SpriteBank?.release?.(building.graphics)
      if (building.baseGraphics) window.__clashBake?.SpriteBank?.release?.(building.baseGraphics)
      building.type = unit
      building.level = lv
      building.doorOpen = door
      building.doorOpenUntil = door > 0 ? Number.POSITIVE_INFINITY : 0
      building.lastDrawDoorOpen = -1
      building.graphics.clear()
      building.baseGraphics?.clear()
      scene.drawBuildingVisuals(
        building.graphics, building.gridX, building.gridY, building.type,
        1, null, building, building.baseGraphics
      )
      scene.dayNight.resyncLights?.()
      const isoX = 0
      const isoY = ((11 + 1) + (11 + 1)) * 16
      scene.cameras.main.setZoom(3.2)
      scene.cameras.main.centerOn(isoX, isoY - 18)
    }, { type: TYPE, level, phase: PHASE, door: DOOR })
    await page.waitForFunction(({ level: lv }) => {
      const building = window.__clashGame?.scene?.keys?.MainScene?.buildings?.[0]
      return building?.level === lv
    }, { timeout: 45_000, polling: 200 }, { level })
    await sleep(700)
    for (let shot = 0; shot < BURST; shot++) {
      if (shot) await sleep(BURST_MS)
      // The shared identity has no banner in its world payload — the required
      // picker re-mounts on React re-renders, so strip it before every shot.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('.modal-overlay, [role="dialog"]')) el.remove()
      })
      const phaseTag = PHASE >= 0.7 ? 'night' : 'day'
      const doorTag = DOOR > 0 ? `-open${DOOR}` : ''
      const burstTag = BURST > 1 ? `-t${shot}` : ''
      const tag = TAG ? `-${TAG}` : ''
      const path = `${OUT}/${TYPE}-L${level}-${phaseTag}${doorTag}${burstTag}${tag}.png`
      await page.screenshot({ path, clip: { x: 340, y: 145, width: 600, height: 610 } })
      if (shot === 0) writtenShots.push({ level, path })
    }
  }

  if (writtenShots.length > 1) {
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
    </style><h1>mystic_barracks A · ${PHASE >= 0.7 ? 'night' : 'day'}${DOOR > 0 ? ' · door ' + DOOR : ''}${TAG ? ' · ' + TAG : ''}</h1><div class="grid">${cards}</div>`)
    await sheet.screenshot({ path: `${OUT}/contact-${PHASE >= 0.7 ? 'night' : 'day'}${DOOR > 0 ? '-open' : ''}${TAG ? '-' + TAG : ''}.png`, fullPage: true })
    await sheet.close()
  }

  console.log(JSON.stringify({ status: 'ok', levels: LEVELS, phase: PHASE, door: DOOR, pageErrors: errors }))
  if (errors.length) process.exitCode = 1
} finally {
  await browser.close()
}
