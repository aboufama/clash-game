// Real-surface Great Lake regression. A disposable chief earns a level-two
// watchtower, walks to the deterministic owner-vista coordinate, and verifies
// that the server, joined-road topology, multi-plot renderer, panel, desktop,
// and mobile surfaces all agree on the same protected watershed.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8788'
const OUT = (process.env.OUT ?? '/tmp/clash-great-lake-verify').replace(/\/$/, '')
const TARGET = { x: -5, y: -7 }
mkdirSync(OUT, { recursive: true })

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
const mod3 = value => ((value % 3) + 3) % 3
const isLegacyPreserve = plot => mod3(plot.x) === 2 && mod3(plot.y) === 2
const api = async (method, path, { token, body } = {}) => {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
  })
  return { status: response.status, json: await response.json() }
}

const addWatchtower = async (token, initialWorld) => {
  await api('POST', '/resources/apply', {
    token,
    body: { delta: 6000, reason: 'debug_grant', requestId: 'great-lake-gold' }
  })
  await api('POST', '/resources/apply', {
    token,
    body: { delta: 125, resource: 'ore', reason: 'debug_grant', requestId: 'great-lake-ore-1' }
  })
  const funded = await api('GET', '/world', { token })
  const first = structuredClone(funded.json.world ?? initialWorld)
  first.obstacles = (first.obstacles ?? []).filter(obstacle =>
    obstacle.gridX > 7 || obstacle.gridY > 7)
  first.buildings.push(
    { id: 'great-lake-store', type: 'storage', gridX: 2, gridY: 5, level: 1 },
    { id: 'great-lake-eyes', type: 'watchtower', gridX: 2, gridY: 2, level: 1 }
  )
  const savedFirst = await api('POST', '/world/save', {
    token,
    body: { world: first, requestId: 'great-lake-build-eyes' }
  })
  assert(savedFirst.status === 200 && savedFirst.json.world,
    `level-one watchtower save failed: ${JSON.stringify(savedFirst.json)}`)
  await api('POST', '/resources/apply', {
    token,
    body: { delta: 380, resource: 'ore', reason: 'debug_grant', requestId: 'great-lake-ore-2' }
  })
  const refilled = await api('GET', '/world', { token })
  const second = structuredClone(refilled.json.world)
  const tower = second.buildings.find(building => building.id === 'great-lake-eyes')
  assert(tower, 'saved watchtower disappeared')
  tower.level = 2
  const savedSecond = await api('POST', '/world/save', {
    token,
    body: { world: second, requestId: 'great-lake-upgrade-eyes' }
  })
  assert(savedSecond.status === 200 && savedSecond.json.world,
    `level-two watchtower save failed: ${JSON.stringify(savedSecond.json)}`)
}

const walkToVista = async (token, start) => {
  let current = { ...start }
  const visited = new Set([`${current.x},${current.y}`])
  for (let step = 0; step < 24 && (current.x !== TARGET.x || current.y !== TARGET.y); step++) {
    const window = await api('GET', `/map?x=${current.x}&y=${current.y}&r=2`, { token })
    assert(window.status === 200, `map walk failed at ${JSON.stringify(current)}`)
    const candidates = window.json.plots
      .filter(plot => plot.kind === 'empty' && plot.settleable !== false)
      .filter(plot => plot.x !== current.x || plot.y !== current.y)
      .sort((a, b) => {
        const aVisited = visited.has(`${a.x},${a.y}`) ? 1 : 0
        const bVisited = visited.has(`${b.x},${b.y}`) ? 1 : 0
        return chebyshev(a, TARGET) - chebyshev(b, TARGET) || aVisited - bVisited
      })
    const next = candidates.find(plot => chebyshev(plot, TARGET) < chebyshev(current, TARGET)) ?? candidates[0]
    // The origin's first rings intentionally contain only starter bots and
    // preserves. The normal "move me" frontier action escapes that enclosure
    // without bypassing server allocation; subsequent hops use visible plots.
    const moved = await api('POST', '/map/relocate', {
      token,
      body: next ? { x: next.x, y: next.y } : {}
    })
    assert(moved.status === 200 && moved.json.me, `vista relocation failed: ${JSON.stringify(moved.json)}`)
    current = moved.json.me
    visited.add(`${current.x},${current.y}`)
  }
  assert(current.x === TARGET.x && current.y === TARGET.y,
    `failed to reach deterministic vista: ${JSON.stringify(current)}`)
  return current
}

const adjacentPair = plots => {
  const keys = new Set(plots.map(plot => `${plot.x},${plot.y}`))
  for (const plot of plots) {
    if (keys.has(`${plot.x + 1},${plot.y}`)) return [plot, plots.find(item => item.x === plot.x + 1 && item.y === plot.y)]
    if (keys.has(`${plot.x},${plot.y + 1}`)) return [plot, plots.find(item => item.x === plot.x && item.y === plot.y + 1)]
  }
  return null
}

const gridToDom = async (page, gx, gy) => page.evaluate(({ gx: x, gy: y }) => {
  const scene = window.__clashGame.scene.keys.MainScene
  const camera = scene.cameras.main
  const worldX = (x - y) * 32
  const worldY = (x + y) * 16
  const canvas = scene.game.canvas
  const rect = canvas.getBoundingClientRect()
  const screenX = camera.x + (worldX - camera.worldView.x) * camera.zoom
  const screenY = camera.y + (worldY - camera.worldView.y) * camera.zoom
  return {
    x: rect.left + screenX * (rect.width / canvas.width),
    y: rect.top + screenY * (rect.height / canvas.height),
    screenX,
    screenY
  }
}, { gx, gy })

let token = null
let browser = null
let primaryError = null
try {
  const session = await api('POST', '/auth/session')
  assert(session.status === 200 && session.json.token && session.json.world, 'could not create Great Lake guest')
  token = session.json.token
  await addWatchtower(token, session.json.world)
  const home = await walkToVista(token, {
    x: session.json.player.plotX,
    y: session.json.player.plotY
  })

  const map = await api('GET', `/map?x=${home.x}&y=${home.y}&r=2`, { token })
  assert(map.status === 200 && map.json.plots.length >= 24, 'full vista map was not returned')
  const lakePlots = map.json.plots.filter(plot =>
    plot.kind === 'empty' && plot.settleable === false && !isLegacyPreserve(plot))
  // Four lake parcels are non-legacy preserves; the fifth visible rapid plot
  // also happens to satisfy the older mod-3 preserve lattice.
  assert(lakePlots.length >= 4, `Great Lake did not occupy the expected live vista: ${JSON.stringify(lakePlots)}`)
  const pair = adjacentPair(lakePlots)
  assert(pair, 'Great Lake has no adjacent protected plots in the live vista')
  const forbidden = await api('POST', '/map/relocate', {
    token,
    body: { x: lakePlots[0].x, y: lakePlots[0].y }
  })
  assert(forbidden.status === 409, 'server allowed settlement inside the Great Lake watershed')

  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1480,980']
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1480, height: 980 })
  await page.evaluateOnNewDocument(value => localStorage.setItem('clash.device.token', value), token)
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 45_000 })
  await page.waitForFunction(keys => {
    const mapSystem = window.__clashGame?.scene?.keys?.MainScene?.worldMap
    if (!mapSystem?.views) return false
    return keys.every(key => {
      const view = mapSystem.views.get(key)
      return view?.plot.kind === 'empty'
        && view.plot.settleable === false
        && view.contentKind === 'nature'
        && String(view.renderedRevision).includes('_hydroart_v')
        && view.rt?.active
    })
  }, { timeout: 45_000, polling: 250 }, lakePlots.map(plot => `${plot.x},${plot.y}`))
  await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 12_000 })
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.dayNight?.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)
  })

  const state = await page.evaluate(({ plots, pair: adjacent }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const mapSystem = scene.worldMap
    const views = plots.map(plot => mapSystem.views.get(`${plot.x},${plot.y}`))
    const topology = mapSystem.wildernessTopology
    const [a, b] = adjacent
    const joined = a.y === b.y
      ? topology.verticalJoins.some(join => join.worldBoundaryX === Math.max(a.x, b.x) && join.worldPlotY === a.y)
      : topology.horizontalJoins.some(join => join.worldPlotX === a.x && join.worldBoundaryY === Math.max(a.y, b.y))
    return {
      home: mapSystem.myPlot,
      allNature: views.every(view => view?.contentKind === 'nature' && view.rt?.active),
      revisions: views.map(view => view?.renderedRevision),
      lifeAnchors: views.reduce((sum, view) => sum + (view?.natureLife?.length ?? 0), 0),
      joined,
      linkLayerActive: Boolean(mapSystem.wildernessLinks?.active),
      roadShapes: [...new Set(topology.roadJunctions.map(junction => junction.shape))]
    }
  }, { plots: lakePlots, pair })
  assert(state.home.x === TARGET.x && state.home.y === TARGET.y && state.allNature,
    `browser did not load the lake vista: ${JSON.stringify(state)}`)
  assert(state.joined && state.linkLayerActive, `lake plots retained a road seam: ${JSON.stringify(state)}`)

  await page.click('.action-btn.map')
  await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.cameras.main.zoom <= 0.44,
    { timeout: 3500, polling: 50 })
  await page.evaluate(plots => {
    const scene = window.__clashGame.scene.keys.MainScene
    const mapSystem = scene.worldMap
    const avgX = plots.reduce((sum, plot) => sum + (plot.x - mapSystem.myPlot.x) * 27 + 12.5, 0) / plots.length
    const avgY = plots.reduce((sum, plot) => sum + (plot.y - mapSystem.myPlot.y) * 27 + 12.5, 0) / plots.length
    scene.cameras.main.centerOn((avgX - avgY) * 32, (avgX + avgY) * 16 - 45)
    scene.cameras.main.setZoom(0.4)
  }, lakePlots)
  await new Promise(resolve => setTimeout(resolve, 1200))
  await page.screenshot({ path: `${OUT}/great-lake-desktop.png` })
  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.cameras.main.setZoom(0.56))
  await new Promise(resolve => setTimeout(resolve, 500))
  await page.screenshot({ path: `${OUT}/great-lake-close.png` })
  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.cameras.main.setZoom(0.4))

  const chosen = lakePlots.find(plot => plot.x === pair[0].x && plot.y === pair[0].y) ?? lakePlots[0]
  const chosenPoint = await gridToDom(page,
    (chosen.x - home.x) * 27 + 12.5,
    (chosen.y - home.y) * 27 + 12.5)
  await page.mouse.click(chosenPoint.x, chosenPoint.y)
  await page.waitForFunction(() => document.querySelector('.plot-title-name')?.textContent?.includes('Lake '),
    { timeout: 3500, polling: 50 })
  const panel = await page.evaluate(() => ({
    title: document.querySelector('.plot-title-name')?.textContent?.trim(),
    actions: [...document.querySelectorAll('.plot-action')].map(button => button.textContent?.trim())
  }))
  assert(panel.title?.includes('Protected wilderness · Lake '), `wrong Great Lake title: ${JSON.stringify(panel)}`)
  assert(panel.actions.some(action => action === 'Great Lake preserve'), `Great Lake panel action missing: ${JSON.stringify(panel)}`)
  await page.screenshot({ path: `${OUT}/great-lake-panel.png` })

  await page.evaluate(() => document.querySelector('.plot-overlay-clear')?.click())
  await page.waitForSelector('.plot-bubble', { hidden: true, timeout: 3000 })
  const [a, b] = pair
  const gapGrid = a.y === b.y
    ? { x: (Math.max(a.x, b.x) - home.x) * 27 - 1, y: (a.y - home.y) * 27 + 12.5 }
    : { x: (a.x - home.x) * 27 + 12.5, y: (Math.max(a.y, b.y) - home.y) * 27 - 1 }
  const gapPoint = await gridToDom(page, gapGrid.x, gapGrid.y)
  await page.mouse.click(gapPoint.x, gapPoint.y)
  await page.waitForFunction(() => document.querySelector('.plot-title-name')?.textContent?.includes('Lake '),
    { timeout: 3500, polling: 50 })
  assert(errors.length === 0, `desktop browser errors: ${errors.join(' | ')}`)

  await page.evaluate(() => document.querySelector('.plot-overlay-clear')?.click())
  await page.waitForSelector('.plot-bubble', { hidden: true, timeout: 3000 })
  const roundedCorner = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const junction = scene.worldMap.wildernessTopology.roadJunctions
      .filter(item => item.shape === 'l')
      .sort((a, b) => Math.hypot(a.boundaryX, a.boundaryY) - Math.hypot(b.boundaryX, b.boundaryY))[0]
    if (!junction) return null
    const gx = junction.boundaryX * 27 - 1
    const gy = junction.boundaryY * 27 - 1
    scene.cameras.main.centerOn((gx - gy) * 32, (gx + gy) * 16)
    scene.cameras.main.setZoom(1.15)
    return { worldKey: junction.worldKey, inner: junction.arms }
  })
  assert(roundedCorner, 'the real vista did not expose a rounded L-road fixture')
  await new Promise(resolve => setTimeout(resolve, 500))
  await page.screenshot({ path: `${OUT}/rounded-road-corner.png` })

  const mobile = await browser.newPage()
  await mobile.setViewport({ width: 430, height: 900, isMobile: true, hasTouch: true })
  await mobile.evaluateOnNewDocument(value => localStorage.setItem('clash.device.token', value), token)
  const mobileErrors = []
  mobile.on('pageerror', error => mobileErrors.push(String(error.message)))
  await mobile.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 45_000 })
  await mobile.waitForFunction(keys => {
    const views = window.__clashGame?.scene?.keys?.MainScene?.worldMap?.views
    return views && keys.every(key => String(views.get(key)?.renderedRevision).includes('_hydroart_v'))
  }, { timeout: 45_000, polling: 250 }, lakePlots.map(plot => `${plot.x},${plot.y}`))
  await mobile.waitForSelector('.cloud-overlay', { hidden: true, timeout: 12_000 })
  await mobile.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.dayNight?.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)
  })
  const button = await mobile.$('.action-btn.map')
  const box = await button?.boundingBox()
  assert(box, 'mobile map button is missing')
  await mobile.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  await new Promise(resolve => setTimeout(resolve, 1200))
  await mobile.evaluate(plots => {
    const scene = window.__clashGame.scene.keys.MainScene
    const mapSystem = scene.worldMap
    const avgX = plots.reduce((sum, plot) => sum + (plot.x - mapSystem.myPlot.x) * 27 + 12.5, 0) / plots.length
    const avgY = plots.reduce((sum, plot) => sum + (plot.y - mapSystem.myPlot.y) * 27 + 12.5, 0) / plots.length
    scene.cameras.main.centerOn((avgX - avgY) * 32, (avgX + avgY) * 16 - 30)
    scene.cameras.main.setZoom(0.16)
  }, lakePlots)
  await new Promise(resolve => setTimeout(resolve, 500))
  await mobile.screenshot({ path: `${OUT}/great-lake-mobile.png` })
  assert(mobileErrors.length === 0, `mobile browser errors: ${mobileErrors.join(' | ')}`)

  // Shift the disposable home one plot south so the upstream source parcel
  // enters the earned 5x5. This is the same authoritative relocation flow,
  // and lets the art pass inspect the spring rather than merely graph-test it.
  const sourceHome = await api('POST', '/map/relocate', {
    token,
    body: { x: -5, y: -9 }
  })
  assert(sourceHome.status === 200, `could not open the source vista: ${JSON.stringify(sourceHome.json)}`)
  await page.reload({ waitUntil: 'networkidle2', timeout: 45_000 })
  await page.waitForFunction(() => {
    const view = window.__clashGame?.scene?.keys?.MainScene?.worldMap?.views?.get('-7,-10')
    return view?.contentKind === 'nature' && String(view.renderedRevision).includes('_hydroart_v')
  }, { timeout: 45_000, polling: 250 })
  // The relocation reload can restart the deliberately long homecoming cloud
  // curtain even after the source postcard is ready. The reveal itself was
  // already verified above; remove only that DOM curtain for this art crop.
  await new Promise(resolve => setTimeout(resolve, 1200))
  await page.evaluate(() => {
    const overlay = document.querySelector('.cloud-overlay')
    if (overlay instanceof HTMLElement) overlay.style.display = 'none'
    const scene = window.__clashGame.scene.keys.MainScene
    scene.dayNight?.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)
  })
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    // Source is near the centre of protected plot (-7,-10), local (-2,-1).
    const gx = -2 * 27 + 12.5
    const gy = -1 * 27 + 12.5
    scene.cameras.main.centerOn((gx - gy) * 32, (gx + gy) * 16)
    scene.cameras.main.setZoom(0.9)
  })
  await new Promise(resolve => setTimeout(resolve, 700))
  await page.screenshot({ path: `${OUT}/great-lake-source.png` })
  assert(errors.length === 0, `source-vista browser errors: ${errors.join(' | ')}`)

  console.log('Great Lake real-surface regression passed', {
    home,
    lakePlots: lakePlots.map(({ x, y }) => ({ x, y })),
    state,
    panel,
    out: OUT
  })
} catch (error) {
  primaryError = error
  throw error
} finally {
  let cleanupError = null
  try { await browser?.close() } catch (error) { cleanupError = error }
  if (token) {
    try {
      const logout = await api('POST', '/auth/logout', { token })
      if (logout.status !== 200) throw new Error(`Great Lake guest cleanup failed (${logout.status})`)
    } catch (error) {
      cleanupError ??= error
    }
  }
  if (cleanupError) {
    if (primaryError) console.error('Great Lake cleanup also failed:', cleanupError)
    else throw cleanupError
  }
}
