// REAL-PATH probe: raid a bot camp, tear its town hall down with troops,
// and photograph the fallen standard the destruction leaves behind.
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
const BASE = process.env.BASE ?? 'http://127.0.0.1:5174'
const OUT = process.env.OUT ?? '/tmp/fallen-raid'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cached = JSON.parse(readFileSync(new URL('./.trailer-device-token.json', import.meta.url), 'utf8')).token
const session = await (await fetch(`${BASE}/api/auth/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: cached })
})).json()
const TOKEN = session.token
const api = async (m, p, b) => {
  const r = await fetch(`${BASE}/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: m === 'POST' ? JSON.stringify(b ?? {}) : undefined })
  return r.json().catch(() => null)
}
await api('POST', '/intro-battle/complete', {})
await api('POST', '/player/banner', { banner: { palette: 0, emblem: 3, pattern: 1 } })
const act = await api('GET', '/attacks/active')
if (act?.session?.kind === 'bot') {
  await api('POST', '/attacks/bot-settle', { raidId: act.session.raidId, x: act.session.x, y: act.session.y, destruction: 0, deployed: {}, requestId: `ffr-${Date.now()}` })
}

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
await page.evaluateOnNewDocument(t => localStorage.setItem('clash.device.token', t), TOKEN)
await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => {
  const s = window.__clashGame?.scene?.keys?.MainScene
  return Boolean(s?.worldMap && s?.cameras?.main && s?.buildings?.length)
}, { timeout: 60000, polling: 300 })
await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 25000 }).catch(() => {})
await page.addStyleTag({ content: `.app-container > :not(#game-container) { opacity: 0 !important; pointer-events: none !important; }` })
page.on('console', msg => { const t = msg.text(); if (/toast|raid|attack|battle|fail|error/i.test(t)) console.log('[page]', t.slice(0, 200)) })
await sleep(1000)
// Onboarding: the first watchtower goes through its tutorial endpoint.
const uid = session.player?.id ?? session.user?.id
const placed = await page.evaluate(async userId => {
  const { Backend } = await import('/src/game/backend/GameBackend.ts')
  const world = Backend.getCachedWorld(userId)
  if (!world) return 'no world'
  if (world.buildings.some(b => b.type === 'watchtower')) return 'already'
  for (const [x, y] of [[18, 4], [4, 18], [20, 20], [2, 2], [12, 20]]) {
    const occupied = world.buildings.some(b => {
      const w = { town_hall: 3, army_camp: 3, farm: 3 }[b.type] ?? 2
      return x < b.gridX + w && x + 2 > b.gridX && y < b.gridY + w && y + 2 > b.gridY
    })
    if (occupied) continue
    world.buildings.push({ id: `wt_probe_${x}_${y}`, type: 'watchtower', gridX: x, gridY: y, level: 1 })
    Backend.setCachedWorld(userId, world)
    const response = await Backend.apiPost('/api/watchtower-tutorial/place', {
      world: JSON.parse(JSON.stringify(world)), requestId: `wtp-${x}-${y}`
    }).catch(e => ({ error: String(e) }))
    return JSON.stringify(response).slice(0, 120)
  }
  return 'no spot'
}, uid)
console.log('watchtower:', placed)
const bannerAgain = await api('POST', '/player/banner', { banner: { palette: 0, emblem: 3, pattern: 1 } })
console.log('banner:', JSON.stringify(bannerAgain).slice(0, 80))
// The raid gate also wants a trained army: camp + barracks, then warriors.
const campResult = await page.evaluate(async userId => {
  const { Backend } = await import('/src/game/backend/GameBackend.ts')
  let ok = []
  for (const [type, spots] of [['army_camp', [[20, 8], [8, 20], [1, 8]]], ['barracks', [[20, 12], [12, 20], [1, 12]]]]) {
    for (const [x, y] of spots) {
      const done = await Backend.placeBuilding(userId, type, x, y)
      if (done) { ok.push(type); break }
    }
  }
  await Backend.saveNow(userId).catch(e => { ok.push(String(e)) })
  return ok.join(',')
}, uid)
console.log('military:', campResult)
const trained = await api('POST', '/army/train', { type: 'warrior', count: 6, requestId: `ffr-train-${Date.now()}` })
console.log('train:', JSON.stringify(trained).slice(0, 100))
await page.evaluate(() => window.__clashGM.loadBase())
await sleep(1500)
await page.evaluate(() => {
  const gm = window.__clashGM
  if (!window.__wrapped) {
    const orig = gm.setGameMode.bind(gm)
    gm.setGameMode = m => { window.__mode = m; orig(m) }
    window.__wrapped = true
  }
  window.__mode = 'PENDING'
  const origToast = gm.showToast.bind(gm)
  gm.showToast = m => { console.log('TOAST:', m); origToast(m) }
  // No coordinates: the server issues a cloud opponent — no sight needed.
  window.__clashGame.scene.keys.MainScene.attackBotPlot(0, 'Cloud Camp')
})
const engaged = await page.waitForFunction(() => window.__mode === 'ATTACK', { timeout: 25000, polling: 250 }).then(() => true).catch(() => false)
if (!engaged) throw new Error('no raid engaged')
console.log('raiding cloud opponent')
await sleep(3500)
const hallAt = await page.evaluate(() => {
  const scene = window.__clashGame.scene.keys.MainScene
  scene.dayNight?.setPhaseOverride(0.3)
  const hall = scene.buildings.find(b => b.type === 'town_hall')
  if (!hall) return null
  // The exact combat path: health hits zero, destroyBuilding runs (rubble,
  // splice, fallen standard) — surgically triggered instead of balancing an
  // army against an unknown opponent.
  hall.health = 0
  scene.destroyBuilding(hall)
  return { x: hall.gridX, y: hall.gridY }
})
console.log('hall at', JSON.stringify(hallAt))
if (!hallAt) throw new Error('no enemy hall found')
await page.evaluate(async at => {
  const { IsoUtils } = await import('/src/game/utils/IsoUtils.ts')
  const p = IsoUtils.cartToIso(at.x + 1.5, at.y + 1.5)
  const cam = window.__clashGame.scene.keys.MainScene.cameras.main
  cam.setZoom(2.6)
  cam.centerOn(p.x, p.y)
}, hallAt)
const gone = await page.evaluate(() => !window.__clashGame.scene.keys.MainScene.buildings.some(b => b.type === 'town_hall'))
console.log('hall destroyed:', gone)
for (const [name, delay] of [['f00', 60], ['f02', 180], ['f04', 200], ['f06', 200], ['f08', 200], ['f10', 240], ['f20', 900]]) {
  await sleep(delay)
  await page.screenshot({ path: `${OUT}-${name}.png` })
}
const diag = await page.evaluate(() => {
  const scene = window.__clashGame.scene.keys.MainScene
  return {
    site: scene.fallenHallSite ?? null,
    meta: scene.villageBannerMeta ? { identity: scene.villageBannerMeta.identity, allowFallback: scene.villageBannerMeta.allowFallback, banner: scene.villageBannerMeta.banner ?? null } : null,
    gfx: Boolean(scene.hallBannerGfx),
    design: Boolean(scene.hallBannerDesign),
    mode: scene.mode
  }
})
console.log('diag:', JSON.stringify(diag))
const render = await page.evaluate(async () => {
  const scene = window.__clashGame.scene.keys.MainScene
  const g = scene.hallBannerGfx
  const { IsoUtils } = await import('/src/game/utils/IsoUtils.ts')
  const site = scene.fallenHallSite
  const foot = site ? IsoUtils.cartToIso(site.gridX + 3 * 0.94, site.gridY + 3 * 0.94) : null
  const cam = scene.cameras.main
  const rubble = scene.children.list.filter(c => c.depth > (g?.depth ?? 0) && Math.abs((c.x ?? 0) - (foot?.x ?? 0)) < 80 && Math.abs((c.y ?? 0) - (foot?.y ?? 0)) < 80).length
  return {
    depth: g?.depth, visible: g?.visible, alpha: g?.alpha,
    commands: g?.commandBuffer?.length ?? null,
    foot, view: { x: Math.round(cam.worldView.x), y: Math.round(cam.worldView.y), w: Math.round(cam.worldView.width), h: Math.round(cam.worldView.height) },
    overlapping: rubble
  }
})
console.log('render:', JSON.stringify(render))
await page.screenshot({ path: `${OUT}-after.png` })
await browser.close()
const act2 = await api('GET', '/attacks/active')
if (act2?.session?.kind === 'bot') {
  await api('POST', '/attacks/bot-settle', { raidId: act2.session.raidId, x: act2.session.x, y: act2.session.y, destruction: 50, deployed: {}, requestId: `ffr2-${Date.now()}` })
}
console.log('done', `${OUT}-after.png`)
