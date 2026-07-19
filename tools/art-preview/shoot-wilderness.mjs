// Wilderness art review harness. Boots the real game with the SHARED
// art-preview identity, asks the renderer for one deterministic coordinate per
// archetype, then uses WorldMapSystem's real postcard pipeline for close and
// overview screenshots.
//
// Requires the Vite dev server because the page imports the renderer's source
// module directly:
//   npm run dev
//   node tools/art-preview/shoot-wilderness.mjs
//
// Design-tournament runs: DESIGNS="deadwood=A" (comma-separated unit=slot
// pairs) seeds localStorage['clash.design.<unit>'] before the page boots, so
// a variant round's slot renders into the postcards. Pair it with OUT=... to
// keep each slot's shots separate.
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = (process.env.OUT ?? new URL('./shots/wilderness/', import.meta.url).pathname).replace(/\/$/, '')
const CLOSE_OUT = `${OUT}/close`
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SEARCH_RADIUS = Number(process.env.SEARCH_RADIUS ?? 96)
const SEED_VERSION_OVERRIDE = process.env.SEED_VERSION === undefined
  ? null
  : Number(process.env.SEED_VERSION)
// DESIGNS="deadwood=A,otherunit=B" → [['deadwood','A'], ...]
const DESIGNS = (process.env.DESIGNS ?? '')
  .split(',')
  .map(pair => pair.trim())
  .filter(Boolean)
  .map(pair => {
    const [unit, slot] = pair.split('=').map(part => part.trim())
    if (!unit || !['A', 'B', 'C'].includes(slot)) {
      throw new Error(`DESIGNS entries must look like "<unit>=A|B|C" (received "${pair}")`)
    }
    return [unit, slot]
  })

const DESKTOP = { width: 1280, height: 900 }
const MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true }
const CONTACT_COLS = 4
const CONTACT_ROWS = 3
const CONTACT_PATH = `${OUT}/wilderness-contact-sheet-desktop.png`
const MOBILE_CONTACT_PATH = `${OUT}/wilderness-contact-sheet-mobile.png`
const CLOSE_CLIP = { x: 190, y: 100, width: 900, height: 700 }

mkdirSync(CLOSE_OUT, { recursive: true })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

assert(Number.isInteger(SEARCH_RADIUS) && SEARCH_RADIUS > 0,
  `SEARCH_RADIUS must be a positive integer (received ${process.env.SEARCH_RADIUS})`)
assert(SEED_VERSION_OVERRIDE === null
  || (Number.isSafeInteger(SEED_VERSION_OVERRIDE) && SEED_VERSION_OVERRIDE >= 0),
`SEED_VERSION must be a non-negative safe integer (received ${process.env.SEED_VERSION})`)

const slug = value => String(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'wilderness'

async function api(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
  })
  const raw = await response.text()
  let json = null
  try {
    json = raw ? JSON.parse(raw) : null
  } catch {
    // The status and raw body below still make a useful failure message.
  }
  return { status: response.status, ok: response.ok, json, raw }
}

async function bootPage(browser, viewport, token) {
  const page = await browser.newPage()
  await page.setViewport(viewport)
  await page.evaluateOnNewDocument((value, designs) => {
    localStorage.setItem('clash.device.token', value)
    for (const [unit, slot] of designs) {
      localStorage.setItem(`clash.design.${unit}`, slot)
    }
  }, token, DESIGNS)

  const errors = []
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('error', error => errors.push(`page crash: ${error.message}`))

  // Vite keeps its HMR transport alive by design, so network-idle is not a
  // meaningful readiness signal. The scene assertion below is the authority.
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page.waitForFunction(() => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    return Boolean(scene?.worldMap && scene?.cameras?.main && scene?.buildings?.length)
  }, { timeout: 45_000, polling: 300 })
  await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 15_000 })
  await sleep(500)

  return { page, errors }
}

async function prepareGallery(page, includeCloseViews) {
  return page.evaluate(async config => {
    const game = window.__clashGame
    const scene = game?.scene?.keys?.MainScene
    const mapSystem = scene?.worldMap
    if (!scene || !mapSystem || typeof mapSystem.renderNaturePostcard !== 'function') {
      throw new Error('MainScene WorldMapSystem postcard renderer is unavailable')
    }

    const module = await import('/src/game/renderers/WildernessRenderer.ts')
    const Renderer = module.WildernessRenderer
    if (typeof Renderer?.archetypeKeys !== 'function' || typeof Renderer?.findShowcasePlots !== 'function') {
      throw new Error('WildernessRenderer showcase API is unavailable; expected archetypeKeys() and findShowcasePlots()')
    }

    const seedVersion = config.seedVersionOverride ?? (
      Number.isSafeInteger(mapSystem.presentationSeedVersion)
        ? mapSystem.presentationSeedVersion
        : 0
    )
    // Art-only override: exercise another deterministic generation without
    // mutating the server or the developer's real village data.
    if (config.seedVersionOverride !== null) mapSystem.presentationSeedVersion = seedVersion
    const keys = Renderer.archetypeKeys()
    const found = Renderer.findShowcasePlots(config.searchRadius, seedVersion)
    if (!Array.isArray(keys) || keys.length === 0) throw new Error('archetypeKeys() returned no wilderness archetypes')
    if (keys.length > config.cols * config.rows) {
      throw new Error(`${keys.length} archetypes cannot fit in the requested ${config.cols}x${config.rows} contact sheet`)
    }
    if (!Array.isArray(found)) throw new Error('findShowcasePlots() did not return an array')

    const byKey = new Map()
    for (const plot of found) {
      if (!plot || typeof plot.key !== 'string') throw new Error('findShowcasePlots() returned an invalid entry')
      if (byKey.has(plot.key)) throw new Error(`findShowcasePlots() returned duplicate key ${plot.key}`)
      if (!Number.isInteger(plot.x) || !Number.isInteger(plot.y)) {
        throw new Error(`showcase coordinates for ${plot.key} are not integers`)
      }
      byKey.set(plot.key, {
        key: plot.key,
        label: String(plot.label || plot.key),
        x: plot.x,
        y: plot.y
      })
    }
    const showcases = keys.map(key => {
      const plot = byKey.get(key)
      if (!plot) throw new Error(`findShowcasePlots() did not provide a coordinate for ${key}`)
      return plot
    })

    // Hide every existing live-world object before making the synthetic art.
    // Pausing after construction prevents map polls/ambient systems from adding
    // new visible objects while the camera moves between shots.
    mapSystem.closePanel?.()
    scene.input.enabled = false
    scene.tweens.pauseAll()
    for (const runningScene of game.scene.getScenes(true)) {
      for (const child of [...runningScene.children.list]) child.setVisible?.(false)
      if (runningScene !== scene) runningScene.scene.pause()
    }

    let style = document.getElementById('wilderness-shot-style')
    if (!style) {
      style = document.createElement('style')
      style.id = 'wilderness-shot-style'
      document.head.appendChild(style)
    }
    style.textContent = `
      .app-container > :not(#game-container) { display: none !important; }
      #game-container { z-index: 0 !important; background: #9295a8 !important; }
      .village-bubble-layer, .plot-bubble, .building-bubble { display: none !important; }
      #wilderness-shot-labels {
        position: fixed; inset: 0; z-index: 20; pointer-events: none;
        font-family: monospace; font-weight: 700; text-transform: uppercase;
      }
      .wilderness-shot-label {
        position: absolute; transform: translate(-50%, 0);
        color: #f5e8bd; background: rgba(32, 23, 15, 0.88);
        border: 1px solid rgba(218, 165, 32, 0.9); border-radius: 3px;
        padding: 2px 5px; white-space: nowrap; line-height: 1.15;
        text-shadow: 1px 1px #000;
      }
    `
    document.body.style.background = '#9295a8'

    let labelsHost = document.getElementById('wilderness-shot-labels')
    if (!labelsHost) {
      labelsHost = document.createElement('div')
      labelsHost.id = 'wilderness-shot-labels'
      document.body.appendChild(labelsHost)
    }
    labelsHost.replaceChildren()

    const camera = scene.cameras.main
    camera.setBackgroundColor('#9295a8')
    camera.setRotation(0)
    camera.setScroll(0, 0)
    camera.roundPixels = true
    camera.fadeEffect?.reset?.()

    const makeView = (plot, dx, dy, suffix) => {
      const view = {
        key: `wilderness-shot:${plot.key}:${suffix}`,
        plot: { x: plot.x, y: plot.y, kind: 'empty', settleable: false },
        rt: null,
        battle: null,
        battleTween: null,
        renderedRevision: null,
        contentKind: null,
        knownRevision: null,
        life: null,
        hearth: null
      }
      mapSystem.renderNaturePostcard(view, dx, dy)
      if (!view.rt?.active || view.contentKind !== 'nature') {
        throw new Error(`postcard render failed for ${plot.key} at (${plot.x}, ${plot.y})`)
      }
      view.rt.setVisible(false)
      return view
    }

    // Close views all occupy the home offset, which deliberately exercises the
    // postcard renderer's highest-resolution near LOD. Only one is shown at a
    // time, so their identical positions are intentional.
    const closeViews = config.includeCloseViews
      ? showcases.map((plot, index) => {
          const view = makeView(plot, 0, 0, `close-${index}`)
          view.rt.setDepth(500 + index)
          return view
        })
      : []

    // Contact entries are placed on a screen-aligned rectangle. Convert those
    // desired screen-space centers back through the inverse iso transform, then
    // through the 27-tile plot pitch expected by renderNaturePostcard().
    const PITCH = 27
    const HALF_PLOT = 12.5
    const CELL_X = 1850
    const CELL_Y = 1150
    const contactEntries = showcases.map((plot, index) => {
      const col = index % config.cols
      const row = Math.floor(index / config.cols)
      const centerX = (col - (config.cols - 1) / 2) * CELL_X
      const centerY = (row - (config.rows - 1) / 2) * CELL_Y
      const centerGridX = centerX / 64 + centerY / 32
      const centerGridY = centerY / 32 - centerX / 64
      const dx = (centerGridX - HALF_PLOT) / PITCH
      const dy = (centerGridY - HALF_PLOT) / PITCH
      const view = makeView(plot, dx, dy, `contact-${index}`)
      view.rt.setDepth(100 + index)

      const label = document.createElement('div')
      label.className = 'wilderness-shot-label'
      label.textContent = plot.label
      label.title = `${plot.key} @ ${plot.x},${plot.y}`
      labelsHost.appendChild(label)
      return { view, centerX, centerY, label }
    })

    const bounds = contactEntries.reduce((box, entry) => {
      const b = entry.view.rt.getBounds()
      box.minX = Math.min(box.minX, b.left)
      box.minY = Math.min(box.minY, b.top)
      box.maxX = Math.max(box.maxX, b.right)
      box.maxY = Math.max(box.maxY, b.bottom)
      return box
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
    bounds.minY -= 40
    bounds.maxY += 180

    const hideLabels = () => {
      labelsHost.style.display = 'none'
    }
    const showClose = index => {
      if (!closeViews[index]) throw new Error(`close showcase index ${index} is unavailable`)
      for (const view of closeViews) view.rt.setVisible(false)
      for (const entry of contactEntries) entry.view.rt.setVisible(false)
      closeViews[index].rt.setVisible(true)
      hideLabels()
      const b = closeViews[index].rt.getBounds()
      camera.setZoom(0.54)
      camera.centerOn((b.left + b.right) / 2, (b.top + b.bottom) / 2)
      return { key: showcases[index].key, zoom: camera.zoom }
    }
    const showContact = mobile => {
      for (const view of closeViews) view.rt.setVisible(false)
      for (const entry of contactEntries) entry.view.rt.setVisible(true)

      const margin = mobile ? 12 : 42
      const width = bounds.maxX - bounds.minX
      const height = bounds.maxY - bounds.minY
      const zoom = Math.min(
        (camera.width - margin * 2) / width,
        (camera.height - margin * 2) / height,
        mobile ? 0.14 : 0.28
      )
      const centerX = (bounds.minX + bounds.maxX) / 2
      const centerY = (bounds.minY + bounds.maxY) / 2
      camera.setZoom(zoom)
      camera.centerOn(centerX, centerY)

      labelsHost.style.display = 'block'
      labelsHost.style.fontSize = mobile ? '8px' : '11px'
      for (const entry of contactEntries) {
        const x = camera.x + camera.width / 2 + (entry.centerX - centerX) * zoom
        const y = camera.y + camera.height / 2 + (entry.centerY - centerY + 420) * zoom + (mobile ? 3 : 7)
        entry.label.style.left = `${x}px`
        entry.label.style.top = `${y}px`
      }
      return { zoom, bounds: { ...bounds } }
    }

    window.__wildernessShotGallery = { showClose, showContact }
    scene.scene.pause()

    return { showcases, seedVersion }
  }, {
    searchRadius: SEARCH_RADIUS,
    cols: CONTACT_COLS,
    rows: CONTACT_ROWS,
    includeCloseViews,
    seedVersionOverride: SEED_VERSION_OVERRIDE
  })
}

let browser = null

try {
  // ONE shared art-preview identity for every harness run on this machine:
  // resuming the cached token bypasses the guest-creation rate limit
  // (30/hour) and stops screenshot runs from littering the world map with
  // junk guest villages. Delete the cache file to mint a fresh identity.
  const TOKEN_CACHE = new URL('./.shared-device-token.json', import.meta.url).pathname
  let cachedToken = null
  try {
    cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null
  } catch {
    // No cache yet — the session call below mints and seeds it.
  }
  const session = await api('POST', '/auth/session', { body: cachedToken ? { token: cachedToken } : {} })
  assert(session.status === 200 && session.json?.token,
    `auth/session failed (${session.status}): ${session.raw} — if this is the 429 guest limit, wait for the window to roll (≤1h) and re-run; the first success re-seeds ${TOKEN_CACHE}`)
  const token = session.json.token
  try {
    writeFileSync(TOKEN_CACHE, JSON.stringify({ token }))
  } catch {
    // Non-fatal: the run proceeds, the next run just re-resumes or re-mints.
  }

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', `--window-size=${DESKTOP.width},${DESKTOP.height}`]
  })

  const desktop = await bootPage(browser, DESKTOP, token)
  const desktopGallery = await prepareGallery(desktop.page, true)

  const closePaths = []
  for (const [index, showcase] of desktopGallery.showcases.entries()) {
    const state = await desktop.page.evaluate(i => window.__wildernessShotGallery.showClose(i), index)
    assert(state?.key === showcase.key, `close camera selected ${state?.key} instead of ${showcase.key}`)
    await sleep(180)
    const name = `${String(index + 1).padStart(2, '0')}-${slug(showcase.key)}.png`
    const path = `${CLOSE_OUT}/${name}`
    await desktop.page.screenshot({ path, clip: CLOSE_CLIP })
    closePaths.push(path)
  }

  const desktopContact = await desktop.page.evaluate(() => window.__wildernessShotGallery.showContact(false))
  assert(Number.isFinite(desktopContact?.zoom) && desktopContact.zoom > 0,
    `desktop contact sheet received an invalid zoom: ${JSON.stringify(desktopContact)}`)
  await sleep(250)
  await desktop.page.screenshot({ path: CONTACT_PATH })

  const mobile = await bootPage(browser, MOBILE, token)
  const mobileGallery = await prepareGallery(mobile.page, false)
  assert(JSON.stringify(mobileGallery.showcases) === JSON.stringify(desktopGallery.showcases),
    'desktop and mobile showcase coordinates did not match')
  const mobileContact = await mobile.page.evaluate(() => window.__wildernessShotGallery.showContact(true))
  assert(Number.isFinite(mobileContact?.zoom) && mobileContact.zoom > 0,
    `mobile contact sheet received an invalid zoom: ${JSON.stringify(mobileContact)}`)
  await sleep(250)
  await mobile.page.screenshot({ path: MOBILE_CONTACT_PATH })

  const pageErrors = [...desktop.errors, ...mobile.errors]
  assert(pageErrors.length === 0, `browser errors while shooting wilderness:\n${pageErrors.join('\n')}`)

  console.log('wilderness shots complete', {
    designs: Object.fromEntries(DESIGNS),
    seedVersion: desktopGallery.seedVersion,
    archetypes: desktopGallery.showcases,
    closePaths,
    contactSheet: CONTACT_PATH,
    mobileContactSheet: MOBILE_CONTACT_PATH,
    desktopZoom: desktopContact.zoom,
    mobileZoom: mobileContact.zoom
  })
} finally {
  // The shared identity must SURVIVE the run — never log it out.
  await browser?.close()
}
