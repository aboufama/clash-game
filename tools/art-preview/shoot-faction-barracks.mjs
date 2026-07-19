// Focused visual QA for the two canonical L1-L9 faction barracks.
//
// BASE=http://127.0.0.1:5173 VECTOR=1 PHASE=0.3 node shoot-faction-barracks.mjs
// TYPES=barracks,mystic_barracks LEVELS=1,9 DOOR=1 BURST=3 ...
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = (process.env.OUT ?? new URL('./shots/faction-barracks/', import.meta.url).pathname).replace(/\/$/, '')
const VECTOR = process.env.VECTOR === '1'
const PHASE = Number(process.env.PHASE ?? 0.3)
const DOOR = process.env.DOOR === '1'
const BURST = Math.max(1, Number(process.env.BURST ?? 1))
const BURST_MS = Math.max(50, Number(process.env.BURST_MS ?? 500))
const ALL_TYPES = ['barracks', 'mystic_barracks']
const TYPES = (process.env.TYPES ?? ALL_TYPES.join(','))
  .split(',').map(value => value.trim()).filter(Boolean)
const LEVELS = (process.env.LEVELS ?? '1,2,3,4,5,6,7,8,9')
  .split(',').map(Number).filter(level => Number.isInteger(level) && level >= 1 && level <= 9)
const unknown = TYPES.filter(type => !ALL_TYPES.includes(type))
if (unknown.length) throw new Error(`unknown barracks type(s): ${unknown.join(', ')}`)
if (!LEVELS.length) throw new Error('LEVELS did not contain a value from 1 through 9')
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
  await page.evaluateOnNewDocument(({ token: sessionToken, vector }) => {
    localStorage.setItem('clash.device.token', sessionToken)
    if (vector) localStorage.setItem('clash.sprites.off', '1')
    else localStorage.removeItem('clash.sprites.off')
  }, { token: resumed.token, vector: VECTOR })

  const errors = []
  const failed = []
  page.on('pageerror', error => errors.push(String(error.message ?? error)))
  page.on('requestfailed', request => failed.push(`${request.url()} :: ${request.failure()?.errorText ?? 'failed'}`))
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 90_000, polling: 500 })
  await sleep(5000)

  const firstType = TYPES[0]
  const firstLevel = LEVELS[0]
  await page.evaluate(({ type, level, phase }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.applyWorldToScene({
      id: 'barracks-art-preview', ownerId: 'barracks-art-preview', username: 'ART PREVIEW',
      buildings: [{ id: 'preview_barracks', type, gridX: 11, gridY: 11, level }],
      obstacles: [], resources: { gold: 0, ore: 0, food: 0 }, lastSaveTime: Date.now()
    })
    scene.dayNight.setPhaseOverride(phase)
    scene.weather.setWeatherOverride(0)
  }, { type: firstType, level: firstLevel, phase: PHASE })
  await sleep(5200)

  const writtenShots = []
  for (const type of TYPES) for (const level of LEVELS) {
    await page.evaluate(({ type: unit, level: lv, phase, door }) => {
      const scene = window.__clashGame.scene.keys.MainScene
      scene.dayNight.setPhaseOverride(phase)
      scene.weather.setWeatherOverride(0)
      const building = scene.buildings[0]
      window.__clashBake?.SpriteBank?.release?.(building.graphics)
      if (building.baseGraphics) window.__clashBake?.SpriteBank?.release?.(building.baseGraphics)
      building.type = unit
      building.level = lv
      building.doorOpen = door ? 1 : 0
      building.doorOpenUntil = door ? Number.POSITIVE_INFINITY : 0
      building.lastDrawDoorOpen = -1
      building.graphics.clear()
      building.baseGraphics?.clear()
      scene.drawBuildingVisuals(
        building.graphics, building.gridX, building.gridY, building.type,
        1, null, building, building.baseGraphics
      )
      scene.dayNight.resyncLights?.()
      const isoX = ((11 + 1) - (11 + 1)) * 32
      const isoY = ((11 + 1) + (11 + 1)) * 16
      scene.cameras.main.setZoom(3.2)
      scene.cameras.main.centerOn(isoX, isoY - 18)
    }, { type, level, phase: PHASE, door: DOOR })
    await page.waitForFunction(({ type: unit, level: lv }) => {
      const building = window.__clashGame?.scene?.keys?.MainScene?.buildings?.[0]
      return building?.type === unit && building?.level === lv
    }, { timeout: 45_000, polling: 200 }, { type, level })
    await sleep(700)
    for (let shot = 0; shot < BURST; shot++) {
      if (shot) await sleep(BURST_MS)
      const phaseTag = PHASE >= 0.7 ? 'night' : 'day'
      const doorTag = DOOR ? '-open' : ''
      const burstTag = BURST > 1 ? `-t${shot}` : ''
      const path = `${OUT}/${type}-L${level}-${phaseTag}${doorTag}${burstTag}-${VECTOR ? 'vector' : 'baked'}.png`
      await page.screenshot({
        path,
        clip: { x: 340, y: 145, width: 600, height: 610 }
      })
      if (shot === 0) writtenShots.push({ type, level, path })
    }
  }

  const sheet = await browser.newPage()
  await sheet.setViewport({ width: Math.max(920, LEVELS.length * 202 + 20), height: TYPES.length * 218 + 70 })
  const cards = writtenShots.map(({ type, level, path }) => {
    const src = `data:image/png;base64,${readFileSync(path).toString('base64')}`
    return `<figure><figcaption>${type} · L${level}</figcaption><img src="${src}"></figure>`
  }).join('')
  await sheet.setContent(`<style>
    html,body{margin:0;background:#202630;color:#f3ead5;font:13px system-ui}
    h1{font-size:16px;margin:10px 12px}.grid{display:grid;grid-template-columns:repeat(${LEVELS.length},190px);gap:12px;padding:0 12px 12px}
    figure{margin:0;background:#303844;border:1px solid #4b5766}figcaption{padding:5px 7px;white-space:nowrap}
    img{display:block;width:188px;height:188px;object-fit:cover;image-rendering:pixelated}
  </style><h1>Faction barracks · ${PHASE >= 0.7 ? 'night' : 'day'} · ${DOOR ? 'doors open' : 'doors closed'} · ${VECTOR ? 'vector' : 'baked'}</h1><div class="grid">${cards}</div>`)
  await sheet.screenshot({ path: `${OUT}/contact-${PHASE >= 0.7 ? 'night' : 'day'}${DOOR ? '-open' : ''}-${VECTOR ? 'vector' : 'baked'}.png`, fullPage: true })
  await sheet.close()

  console.log(JSON.stringify({
    status: 'ok', types: TYPES, levels: LEVELS, phase: PHASE, door: DOOR,
    mode: VECTOR ? 'vector' : 'baked', pageErrors: errors, failedRequests: failed
  }))
  if (errors.length || failed.length) process.exitCode = 1
} finally {
  await browser.close()
}
