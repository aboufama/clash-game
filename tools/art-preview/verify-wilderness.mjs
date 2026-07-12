// Real-surface regression for permanent wilderness preserves and the MAP
// neighborhood toggle. Uses a disposable server account.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8788'
const OUT = (process.env.OUT ?? '/tmp/clash-wilderness-verify').replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

const api = async (method, path, { token, body } = {}) => {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
  })
  return { status: response.status, json: await response.json() }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

let token = null
let browser = null
let primaryError = null
try {
  const session = await api('POST', '/auth/session')
  assert(session.status === 200 && session.json.token, 'could not create wilderness verification account')
  token = session.json.token
  await api('POST', '/resources/apply', { token, body: { delta: 5000, reason: 'debug_grant', requestId: 'wild-gold' } })
  await api('POST', '/resources/apply', { token, body: { delta: 125, resource: 'ore', reason: 'debug_grant', requestId: 'wild-ore' } })
  const world = (await api('GET', '/world', { token })).json.world
  world.buildings.push({ id: 'wild-eyes', type: 'watchtower', gridX: 2, gridY: 2, level: 1 })
  const saved = await api('POST', '/world/save', { token, body: { world, requestId: 'wild-watchtower' } })
  assert(saved.status === 200, `watchtower save failed: ${JSON.stringify(saved.json)}`)

  const map = await api('GET', `/map?x=${session.json.player.plotX}&y=${session.json.player.plotY}&r=1`, { token })
  const preserve = map.json.plots.find(plot => plot.kind === 'empty' && plot.settleable === false)
  assert(preserve, 'server map did not return a protected wilderness plot')
  const botPlot = map.json.plots.find(plot => plot.kind === 'bot')
  assert(botPlot, 'wilderness comparison fixture did not include a neighboring bot camp')
  const relocate = await api('POST', '/map/relocate', { token, body: { x: preserve.x, y: preserve.y } })
  assert(relocate.status === 409, 'protected wilderness was settleable through the real API')

  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(value => localStorage.setItem('clash.device.token', value), token)
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 45_000 })
  await page.waitForFunction(({ x, y }) => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    if (!scene?.worldMap?.views) return false
    const view = scene.worldMap.views.get(`${x},${y}`)
    return view?.plot.kind === 'empty'
      && view.plot.settleable === false
      && String(view.renderedRevision).startsWith('wilds_v')
      && view.contentKind === 'nature'
      && view.rt?.active
  }, { timeout: 45_000, polling: 300 }, preserve)
  await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 10_000 })

  // Reproduce the reported upgrade state exactly: an old starter-village RT
  // incorrectly carrying the legacy generic "wilds" marker. The current
  // empty classification must destroy it and repaint coordinate-versioned
  // nature before the plot is shown.
  const staleTransition = await page.evaluate(async ({ x, y }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const mapSystem = scene.worldMap
    const key = `${x},${y}`
    const view = mapSystem.views.get(key)
    const dx = x - mapSystem.myPlot.x
    const dy = y - mapSystem.myPlot.y
    const starter = {
      id: 'departed-starter',
      ownerId: 'departed-starter',
      username: 'Departed test chief',
      buildings: [
        { id: 'stale-th', type: 'town_hall', gridX: 11, gridY: 11, level: 1 },
        { id: 'stale-cannon', type: 'cannon', gridX: 8, gridY: 11, level: 1 },
        { id: 'stale-barracks', type: 'barracks', gridX: 15, gridY: 11, level: 1 },
        { id: 'stale-camp', type: 'army_camp', gridX: 11, gridY: 15, level: 1 }
      ],
      obstacles: [],
      resources: { gold: 0, ore: 0, food: 0 },
      army: {},
      wallLevel: 1,
      lastSaveTime: Date.now(),
      revision: 1
    }
    mapSystem.renderSnapshot(view, starter, dx, dy)
    view.renderedRevision = 'wilds'
    const staleRt = view.rt
    await mapSystem.ensureView(key, { x, y, kind: 'empty', settleable: false }, dx, dy)
    return {
      staleDestroyed: staleRt !== view.rt && !staleRt.active,
      contentKind: view.contentKind,
      revision: view.renderedRevision,
      hearth: view.hearth,
      hasLife: Boolean(view.life),
      active: view.rt?.active
    }
  }, preserve)
  assert(staleTransition.staleDestroyed, 'legacy starter-village postcard survived the empty transition')
  assert(staleTransition.contentKind === 'nature' && String(staleTransition.revision).startsWith('wilds_v')
    && staleTransition.hearth === null && !staleTransition.hasLife && staleTransition.active,
  `empty transition did not produce clean nature: ${JSON.stringify(staleTransition)}`)

  await page.click('.action-btn.map')
  await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.cameras.main.zoom <= 0.44, {
    timeout: 3000,
    polling: 50
  })
  await new Promise(resolve => setTimeout(resolve, 900))

  const surface = await page.evaluate(({ x, y }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const view = scene.worldMap.views.get(`${x},${y}`)
    if (!view) return null
    const dx = view.plot.x - scene.worldMap.myPlot.x
    const dy = view.plot.y - scene.worldMap.myPlot.y
    const gx = dx * 27 + 12.5
    const gy = dy * 27 + 12.5
    const worldX = (gx - gy) * 32
    const worldY = (gx + gy) * 16
    const camera = scene.cameras.main
    const screenX = (worldX - camera.worldView.x) * camera.zoom
    const screenY = (worldY - camera.worldView.y) * camera.zoom
    const canvas = scene.game.canvas
    const rect = canvas.getBoundingClientRect()
    const domX = rect.left + (camera.x + screenX) * (rect.width / canvas.width)
    const domY = rect.top + (camera.y + screenY) * (rect.height / canvas.height)
    return {
      plot: view.plot,
      renderedRevision: view.renderedRevision,
      contentKind: view.contentKind,
      hearth: view.hearth,
      hasLife: Boolean(view.life),
      active: view.rt?.active,
      zoom: camera.zoom,
      screenX: camera.x + screenX,
      screenY: camera.y + screenY,
      domX,
      domY
    }
  }, preserve)
  assert(surface?.plot.x === preserve.x && surface.plot.y === preserve.y
    && surface.plot.kind === 'empty' && surface.plot.settleable === false
    && !surface.plot.ownerId && surface.contentKind === 'nature'
    && String(surface.renderedRevision).startsWith('wilds_v')
    && surface.hearth === null && !surface.hasLife && surface.active,
  `the API preserve did not render as pure nature: ${JSON.stringify(surface)}`)
  assert(surface.screenX > 4 && surface.screenX < 1276 && surface.screenY > 4 && surface.screenY < 896,
    `wilderness was still outside the neighborhood framing: ${JSON.stringify(surface)}`)
  const preserveClip = {
    x: Math.max(0, surface.domX - 220),
    y: Math.max(0, surface.domY - 150),
    width: Math.min(440, 1280 - Math.max(0, surface.domX - 220)),
    height: Math.min(300, 900 - Math.max(0, surface.domY - 150))
  }
  await page.screenshot({ path: `${OUT}/wilderness-preserve-close.png`, clip: preserveClip })
  await page.mouse.click(surface.domX, surface.domY)

  await page.waitForSelector('.plot-bubble', { timeout: 3000 })
  const panel = await page.evaluate(() => ({
    title: document.querySelector('.plot-title-name')?.textContent?.trim(),
    actions: [...document.querySelectorAll('.plot-action')].map(button => button.textContent?.trim()),
    hasSettle: Boolean(document.querySelector('.plot-action.settle'))
  }))
  assert(panel.title?.includes('Protected wilderness'), `wrong wilderness title: ${panel.title}`)
  assert(panel.actions.some(label => label?.includes('Wilderness preserve')), 'preserve explanation action is missing')
  assert(!panel.hasSettle, 'protected wilderness panel still offers settlement')

  const botSurface = await page.evaluate(({ x, y }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const view = scene.worldMap.views.get(`${x},${y}`)
    if (!view) return null
    const dx = x - scene.worldMap.myPlot.x
    const dy = y - scene.worldMap.myPlot.y
    const gx = dx * 27 + 12.5
    const gy = dy * 27 + 12.5
    const worldX = (gx - gy) * 32
    const worldY = (gx + gy) * 16
    const camera = scene.cameras.main
    const canvas = scene.game.canvas
    const rect = canvas.getBoundingClientRect()
    const screenX = camera.x + (worldX - camera.worldView.x) * camera.zoom
    const screenY = camera.y + (worldY - camera.worldView.y) * camera.zoom
    return {
      plot: view.plot,
      contentKind: view.contentKind,
      domX: rect.left + screenX * (rect.width / canvas.width),
      domY: rect.top + screenY * (rect.height / canvas.height)
    }
  }, botPlot)
  assert(botSurface?.plot.kind === 'bot' && botSurface.contentKind === 'village',
    `bot comparison plot was not rendered as a camp: ${JSON.stringify(botSurface)}`)
  await page.evaluate(() => document.querySelector('.plot-overlay-clear')?.click())
  await page.waitForSelector('.plot-bubble', { hidden: true, timeout: 3000 })
  await page.mouse.click(botSurface.domX, botSurface.domY)
  await page.waitForFunction(name => document.querySelector('.plot-title-name')?.textContent?.includes(name), {
    timeout: 3000,
    polling: 50
  }, botPlot.username)
  const botPanel = await page.evaluate(() => ({
    title: document.querySelector('.plot-title-name')?.textContent?.trim(),
    actions: [...document.querySelectorAll('.plot-action')].map(button => button.textContent?.trim())
  }))
  assert(botPanel.actions.some(label => label === 'Attack') && !botPanel.title?.includes('wilderness'),
    `bot camp was mislabeled as wilderness: ${JSON.stringify(botPanel)}`)

  // Restore the exact preserve selection for the overview screenshot.
  await page.evaluate(() => document.querySelector('.plot-overlay-clear')?.click())
  await page.waitForSelector('.plot-bubble', { hidden: true, timeout: 3000 })
  await page.mouse.click(surface.domX, surface.domY)
  await page.waitForFunction(() => document.querySelector('.plot-title-name')?.textContent?.includes('Protected wilderness'), {
    timeout: 3000,
    polling: 50
  })
  assert(errors.length === 0, `browser errors: ${errors.join(' | ')}`)

  await page.screenshot({ path: `${OUT}/wilderness-neighborhood.png` })

  // Repeat at a narrow touch viewport. This catches the original hard-coded
  // zoom regression, and the preserve must be reached through real canvas
  // input rather than calling WorldMapSystem.handleTap directly.
  const mobilePage = await browser.newPage()
  await mobilePage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await mobilePage.evaluateOnNewDocument(value => localStorage.setItem('clash.device.token', value), token)
  const mobileErrors = []
  mobilePage.on('pageerror', error => mobileErrors.push(String(error.message)))
  await mobilePage.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 45_000 })
  await mobilePage.waitForFunction(({ x, y }) => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    const view = scene?.worldMap?.views?.get(`${x},${y}`)
    return view?.plot.kind === 'empty' && view.plot.settleable === false
      && view.contentKind === 'nature' && String(view.renderedRevision).startsWith('wilds_v')
  }, { timeout: 45_000, polling: 300 }, preserve)
  await mobilePage.waitForSelector('.cloud-overlay', { hidden: true, timeout: 10_000 })
  const mobileMapButton = await mobilePage.$('.action-btn.map')
  const mobileMapBox = await mobileMapButton?.boundingBox()
  assert(mobileMapBox, 'mobile MAP control was not visible')
  await mobilePage.touchscreen.tap(
    mobileMapBox.x + mobileMapBox.width / 2,
    mobileMapBox.y + mobileMapBox.height / 2
  )
  await new Promise(resolve => setTimeout(resolve, 1400))
  const mobileMapState = await mobilePage.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    return {
      zoom: scene.cameras.main.zoom,
      mode: scene.mode,
      buildings: scene.buildings.length
    }
  })
  assert(mobileMapState.zoom <= 0.12,
    `mobile MAP control did not open the fitted neighborhood: ${JSON.stringify(mobileMapState)}`)
  const mobileSurface = await mobilePage.evaluate(({ x, y }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const view = scene.worldMap.views.get(`${x},${y}`)
    if (!view) return null
    const dx = view.plot.x - scene.worldMap.myPlot.x
    const dy = view.plot.y - scene.worldMap.myPlot.y
    const gx = dx * 27 + 12.5
    const gy = dy * 27 + 12.5
    const worldX = (gx - gy) * 32
    const worldY = (gx + gy) * 16
    const camera = scene.cameras.main
    const canvas = scene.game.canvas
    const rect = canvas.getBoundingClientRect()
    const screenX = camera.x + (worldX - camera.worldView.x) * camera.zoom
    const screenY = camera.y + (worldY - camera.worldView.y) * camera.zoom
    return {
      zoom: camera.zoom,
      contentKind: view.contentKind,
      revision: view.renderedRevision,
      screenX,
      screenY,
      domX: rect.left + screenX * (rect.width / canvas.width),
      domY: rect.top + screenY * (rect.height / canvas.height)
    }
  }, preserve)
  assert(mobileSurface && mobileSurface.screenX > 4 && mobileSurface.screenX < 386
    && mobileSurface.screenY > 4 && mobileSurface.screenY < 840
    && mobileSurface.contentKind === 'nature' && String(mobileSurface.revision).startsWith('wilds_v'),
  `wilderness was outside the mobile viewport: ${JSON.stringify(mobileSurface)}`)
  await mobilePage.touchscreen.tap(mobileSurface.domX, mobileSurface.domY)
  await mobilePage.waitForFunction(() => document.querySelector('.plot-title-name')?.textContent?.includes('Protected wilderness'), {
    timeout: 3000,
    polling: 50
  })
  assert(mobileErrors.length === 0, `mobile browser errors: ${mobileErrors.join(' | ')}`)
  await mobilePage.screenshot({ path: `${OUT}/wilderness-neighborhood-mobile.png` })

  console.log('wilderness browser regression passed', {
    preserve, surface, staleTransition, panel, botPlot, botPanel, mobileSurface, out: OUT
  })
} catch (error) {
  primaryError = error
  throw error
} finally {
  let cleanupError = null
  try {
    await browser?.close()
  } catch (error) {
    cleanupError = error
  }
  if (token) {
    try {
      const logout = await api('POST', '/auth/logout', { token })
      if (logout.status !== 200) throw new Error(`verification guest cleanup failed (${logout.status})`)
    } catch (error) {
      cleanupError ??= error
    }
  }
  if (cleanupError) {
    if (primaryError) console.error('wilderness verification cleanup also failed:', cleanupError)
    else throw cleanupError
  }
}
