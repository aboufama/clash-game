// Visual verification for the aliveness batch: construction scaffolds, battle
// scars, global rain (day + night fire-dimming), night events (owl/forge/
// wolves), road travellers with bonfires, and living neighbour postcards.
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5199'
const OUT = process.env.OUT ?? '/tmp/verify'
import { mkdirSync } from 'node:fs'
mkdirSync(OUT, { recursive: true })

const api = async (path, token, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return res.json()
}

const session = await api('/auth/session', null, {})
await api('/resources/apply', session.token, { delta: 20000, reason: 'debug_grant', requestId: 'vf-g' })
await api('/resources/apply', session.token, { delta: 120, resource: 'ore', reason: 'debug_grant', requestId: 'vf-o' })
const world = (await api('/world', session.token)).world
world.buildings.push(
  { id: 'vf_mine', type: 'mine', gridX: 4, gridY: 17, level: 1 },
  { id: 'vf_farm', type: 'farm', gridX: 8, gridY: 17, level: 1 },
  { id: 'vf_store', type: 'storage', gridX: 16, gridY: 4, level: 1 }
)
await api('/world/save', session.token, { world, requestId: 'vf-save' })

// A neighbour for the postcard-life shot.
const neighbor = (await api('/auth/session', null, {}))
const me = (await api('/map?x=0&y=0&r=0', session.token))
await api('/map/relocate', neighbor.token, { x: me.me.x + 1, y: me.me.y })

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
  page.on('pageerror', e => { errors.push(String(e.message).slice(0, 240)); console.log('PAGE ERROR:', String(e.message).slice(0, 160)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 40000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(2500)

  // A. Construction scaffold on the barracks + a fresh upgrade on the mine.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const barracks = s.buildings.find(b => b.type === 'barracks')
    const mine = s.buildings.find(b => b.type === 'mine')
    if (barracks) s.villageLife.onConstruction(barracks, 'place')
    if (mine) s.villageLife.onConstruction(mine, 'upgrade')
    s.cameras.main.centerOn(0, 380); s.cameras.main.setZoom(1.15)
  })
  await sleep(2200)
  await page.screenshot({ path: `${OUT}/a-construction.png` })

  // B. Battle scars + repair smoke.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.villageLife.applyBattleScars(70)
  })
  await sleep(1400)
  await page.screenshot({ path: `${OUT}/b-scars.png` })

  // C. Rain, midday.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.3)
    s.weather.setWeatherOverride(0.95)
  })
  await sleep(3500)
  const rainState = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    return { raining: s.weather.isRaining(), sheltering: s.villageLife['rainMode'] }
  })
  await page.screenshot({ path: `${OUT}/c-rain-day.png` })

  // D. Rain at night — hearth fires dimmed, lights hiss under the wet.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.8)
  })
  await sleep(2000)
  await page.screenshot({ path: `${OUT}/d-rain-night.png` })

  // E. Clear night: owl + midnight forge + wolves, all forced.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.weather.setWeatherOverride(0)
    const vl = s.villageLife
    vl['spawnOwl']()
    if (vl['owl']) { vl['owl'].x = 12; vl['owl'].y = 14; vl['owl'].hooted = true }
    vl['startMidnightForge'](s.time.now)
    vl['spawnWolves'](s.time.now)
    if (vl['wolves']) { vl['wolves'].x = 2; vl['wolves'].y = -1; vl['wolves'].howled = true }
  })
  await sleep(1500)
  await page.screenshot({ path: `${OUT}/e-night-events.png` })
  const nightState = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const vl = s.villageLife
    return { owl: Boolean(vl['owl']), forge: Boolean(vl['forge']), wolves: Boolean(vl['wolves']), patrol: Boolean(vl['patrolRoute']) }
  })

  // F. A traveller camping on the border road with a bonfire.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const wm = s.worldMap
    wm['nextTravellerAt'] = 0
  })
  await sleep(400)
  const travellerState = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const wm = s.worldMap
    const trav = wm['travellers'][0]
    if (!trav) return { spawned: false }
    // Park him on the visible south road and pitch camp.
    trav.x = 12; trav.y = 26; trav.tx = 30; trav.ty = 26
    trav.state = 'camp'
    trav.camped = true
    trav.campUntil = s.time.now + 120000
    trav.lightId = s.dayNight.addTransientLight({ gx: trav.x + 0.7, gy: trav.y, radius: 46, tint: 0xffa14a, until: Date.now() + 300000 })
    s.cameras.main.centerOn(...(() => { const p = { x: (12 - 26) * 32, y: (12 + 26) * 16 }; return [p.x, p.y] })())
    s.cameras.main.setZoom(1.4)
    return { spawned: true }
  })
  await sleep(1200)
  await page.screenshot({ path: `${OUT}/f-traveller-camp.png` })

  // G. Living postcards: zoom out over the neighbourhood by day.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.35)
    s.weather.setWeatherOverride(0)
    s.worldMap['nextRefreshAt'] = 0
    s.cameras.main.centerOn(430, 500)
    s.cameras.main.setZoom(0.42)
  })
  await sleep(5000)
  await page.screenshot({ path: `${OUT}/g-postcards.png` })
  const postcardState = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const views = [...s.worldMap['views'].values()]
    return {
      views: views.length,
      withLife: views.filter(v => v.life).length,
      withHearth: views.filter(v => v.hearth).length
    }
  })

  const fps = await page.evaluate(() => Math.round(window.__clashGame.loop.actualFps))
  console.log('rain:', JSON.stringify(rainState))
  console.log('night events:', JSON.stringify(nightState))
  console.log('traveller:', JSON.stringify(travellerState))
  console.log('postcards:', JSON.stringify(postcardState))
  console.log(`fps=${fps}, page errors=${errors.length ? errors : 'none'}`)
  if (errors.length > 0) process.exitCode = 1
} finally {
  await browser.close()
}
