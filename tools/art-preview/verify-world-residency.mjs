// Browser proof for full-resolution world-postcard GPU residency.
// Seeds a dense 5x5 player neighborhood, verifies the permanent 3x3 budget,
// and screenshots one ring-two village before and after eviction/rematerialization.
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8788'
const OUT = new URL('./shots/', import.meta.url).pathname
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const api = async (method, path, { token, body, address } = {}) => {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(address ? { 'X-Forwarded-For': address } : {})
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
  })
  const json = await response.json()
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`)
  return json
}

const accounts = []
for (let i = 0; i < 32; i++) {
  accounts.push(await api('POST', '/auth/session', { address: `198.51.100.${i + 1}` }))
}
const me = accounts[0]
await api('POST', '/resources/apply', {
  token: me.token,
  body: { delta: 20_000, reason: 'debug_grant', requestId: 'residency-gold' }
})
await api('POST', '/resources/apply', {
  token: me.token,
  body: { delta: 125, resource: 'ore', reason: 'debug_grant', requestId: 'residency-ore-1' }
})
const storageWorld = (await api('GET', '/world', { token: me.token })).world
storageWorld.buildings.push({ id: 'residency-storage', type: 'storage', gridX: 5, gridY: 5, level: 1 })
await api('POST', '/world/save', {
  token: me.token,
  body: { world: storageWorld, requestId: 'residency-storage' }
})
await api('POST', '/resources/apply', {
  token: me.token,
  body: { delta: 2_000, resource: 'ore', reason: 'debug_grant', requestId: 'residency-ore-2' }
})
const world = (await api('GET', '/world', { token: me.token })).world
world.buildings.push({ id: 'residency-eyes', type: 'watchtower', gridX: 2, gridY: 2, level: 2 })
await api('POST', '/world/save', {
  token: me.token,
  body: { world, requestId: 'residency-watchtower' }
})

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument(token => localStorage.setItem('clash.device.token', token), me.token)
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 30_000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.worldMap, { timeout: 45_000 })
  await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.worldMap.views.size >= 24, { timeout: 30_000 })

  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.dayNight.setPhaseOverride(0.35)
    scene.cameras.main.setZoom(1)
    scene.cameras.main.centerOn(0, 400)
  })
  await sleep(3_500)
  const centered = await page.evaluate(() =>
    window.__clashGame.scene.keys.MainScene.worldMap.postcardTextureStats())
  await page.screenshot({ path: `${OUT}world-residency-centered.png` })

  const selected = await page.evaluate(() => {
    const map = window.__clashGame.scene.keys.MainScene.worldMap
    const choices = [...map.views.values()]
      .filter(view => (view.plot.kind === 'player' || view.plot.kind === 'bot') && Math.max(Math.abs(view.dx), Math.abs(view.dy)) === 2)
      .sort((a, b) => (Math.abs(b.dx) + Math.abs(b.dy)) - (Math.abs(a.dx) + Math.abs(a.dy)))
    const view = choices[0]
    if (!view) return null
    return { key: view.key, dx: view.dx, dy: view.dy }
  })
  if (!selected) throw new Error('dense seed did not create a ring-two village')

  const focusSelected = async () => page.evaluate(({ dx, dy }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const gx = dx * 27 + 12.5
    const gy = dy * 27 + 12.5
    scene.cameras.main.centerOn((gx - gy) * 32, (gx + gy) * 16 - 40)
  }, selected)

  await focusSelected()
  await page.waitForFunction(key => {
    const view = window.__clashGame.scene.keys.MainScene.worldMap.views.get(key)
    return view?.rt?.width === 1600 && view?.rt?.height === 890 && view.rt.scaleX === 1 && view.rt.scaleY === 1
  }, { timeout: 10_000 }, selected.key)
  await sleep(900)
  await page.screenshot({ path: `${OUT}world-residency-before.png` })

  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.cameras.main.centerOn(0, 400))
  await page.waitForFunction(key =>
    window.__clashGame.scene.keys.MainScene.worldMap.views.get(key)?.rt === null,
  { timeout: 10_000 }, selected.key)
  const evicted = await page.evaluate(() =>
    window.__clashGame.scene.keys.MainScene.worldMap.postcardTextureStats())

  await focusSelected()
  await page.waitForFunction(key => {
    const view = window.__clashGame.scene.keys.MainScene.worldMap.views.get(key)
    return view?.rt?.width === 1600 && view?.rt?.height === 890 && view.rt.scaleX === 1 && view.rt.scaleY === 1
  }, { timeout: 10_000 }, selected.key)
  await sleep(900)
  await page.screenshot({ path: `${OUT}world-residency-after.png` })
  const rematerialized = await page.evaluate(() =>
    window.__clashGame.scene.keys.MainScene.worldMap.postcardTextureStats())

  console.log(JSON.stringify({ selected, centered, evicted, rematerialized, pageErrors: errors }, null, 2))
  if (centered.playerSnapshotScale !== 1 || rematerialized.playerSnapshotScale !== 1) {
    throw new Error('player snapshot scale changed')
  }
  if (centered.residentVillageTextures > 8) {
    throw new Error(`centered 5x5 retained ${centered.residentVillageTextures} village textures; expected at most 8`)
  }
  if (errors.length) throw new Error(`browser page errors: ${errors.join('; ')}`)
} finally {
  await browser.close()
}
