// CoC-style App Store trailer capture: boots the real game on an ISOLATED
// data dir (CLASH_DATA_DIR world, own guest identity) and films beats with an
// in-page MediaRecorder on the Phaser canvas. Each beat is defensive — a
// failure logs and skips so the run always produces whatever it can.
//
//   CLASH_DATA_DIR=... npx vite --port 5174 ...   (isolated server)
//   BASE=http://127.0.0.1:5174 node tools/trailer/record-trailer.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5174'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = (process.env.OUT ?? new URL('./clips/', import.meta.url).pathname).replace(/\/$/, '')
const WIDTH = Number(process.env.WIDTH ?? 1280)
const HEIGHT = Number(process.env.HEIGHT ?? 720)
const TOKEN_CACHE = new URL('./.trailer-device-token.json', import.meta.url).pathname

mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
  try { json = raw ? JSON.parse(raw) : null } catch { /* raw carries the message */ }
  return { status: response.status, ok: response.ok, json, raw }
}

/* --------------------------- in-page helpers ---------------------------- */

const RECORDER_SNIPPET = `
window.__trailer = window.__trailer ?? {}
window.__trailer.start = () => {
  const canvas = document.querySelector('#game-container canvas') ?? document.querySelector('canvas')
  if (!canvas) throw new Error('no canvas to record')
  const stream = canvas.captureStream(60)
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm'
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 14_000_000 })
  const chunks = []
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mime })
    const buffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const STEP = 0x8000
    for (let i = 0; i < bytes.length; i += STEP) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP))
    }
    window.__trailer.data = btoa(binary)
  }
  window.__trailer.recorder = recorder
  window.__trailer.data = null
  recorder.start(250)
}
window.__trailer.stop = () => window.__trailer.recorder?.stop()
`

async function record(page, name, action) {
  await page.evaluate(RECORDER_SNIPPET)
  await page.evaluate(() => window.__trailer.start())
  try {
    await action()
  } finally {
    await page.evaluate(() => window.__trailer.stop())
  }
  await page.waitForFunction(() => window.__trailer.data !== null, { timeout: 30_000 })
  const data = await page.evaluate(() => {
    const value = window.__trailer.data
    window.__trailer.data = null
    return value
  })
  const path = `${OUT}/${name}.webm`
  writeFileSync(path, Buffer.from(data, 'base64'))
  console.log(`captured ${name} (${(data.length * 0.75 / 1e6).toFixed(1)} MB)`)
  return path
}

/** Smooth camera glide inside the live scene (scene-tween driven). */
async function glide(page, spec) {
  await page.evaluate(async config => {
    const scene = window.__clashGame.scene.keys.MainScene
    const camera = scene.cameras.main
    if (config.fromZoom !== undefined) camera.setZoom(config.fromZoom)
    if (config.fromX !== undefined) camera.centerOn(config.fromX, config.fromY)
    await new Promise(resolve => {
      const start = { zoom: camera.zoom, x: camera.midPoint.x, y: camera.midPoint.y }
      const end = {
        zoom: config.toZoom ?? start.zoom,
        x: config.toX ?? start.x,
        y: config.toY ?? start.y
      }
      scene.tweens.addCounter({
        from: 0,
        to: 1,
        duration: config.duration,
        ease: config.ease ?? 'Sine.easeInOut',
        onUpdate: tween => {
          const t = tween.getValue()
          camera.setZoom(start.zoom + (end.zoom - start.zoom) * t)
          camera.centerOn(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t)
        },
        onComplete: resolve
      })
    })
  }, spec)
}

async function villageCenter(page) {
  return page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const buildings = scene.buildings ?? []
    if (!buildings.length) return { x: 0, y: 0 }
    let sumX = 0
    let sumY = 0
    for (const building of buildings) {
      sumX += building.sprite?.x ?? building.x ?? 0
      sumY += building.sprite?.y ?? building.y ?? 0
    }
    return { x: sumX / buildings.length, y: sumY / buildings.length }
  })
}

/** New guests must pick a banner before the game accepts input. */
async function resolveBannerGate(page) {
  await sleep(1_200)
  const handled = await page.evaluate(() => {
    const modal = document.querySelector('[class*="banner"]')
    if (!modal) return 'absent'
    const options = modal.querySelectorAll('button, [role="button"], canvas, [class*="option"], [class*="choice"]')
    if (options.length) options[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const confirm = [...modal.querySelectorAll('button')]
      .find(button => /choose|confirm|select|done|ok/i.test(button.textContent ?? ''))
    if (confirm) confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return confirm ? 'confirmed' : options.length ? 'clicked-option' : 'no-controls'
  })
  console.log(`banner gate: ${handled}`)
  await sleep(800)
}

async function bootPage(browser, token) {
  const page = await browser.newPage()
  await page.setViewport({ width: WIDTH, height: HEIGHT })
  await page.evaluateOnNewDocument(value => {
    localStorage.setItem('clash.device.token', value)
  }, token)
  const errors = []
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    return Boolean(scene?.worldMap && scene?.cameras?.main && scene?.buildings?.length)
  }, { timeout: 60_000, polling: 300 })
  await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 25_000 }).catch(() => {})
  await resolveBannerGate(page)
  // Hide the DOM HUD so the film is pure game canvas (after the banner gate!).
  await page.addStyleTag({ content: `
    .app-container > :not(#game-container) { opacity: 0 !important; pointer-events: none !important; }
    .village-bubble-layer, .plot-bubble, .building-bubble { display: none !important; }
  ` })
  await sleep(500)
  return { page, errors }
}

/** Place a roster of buildings through the client's own backend, refreshing
 *  the scene after each batch so the village visibly densifies. */
async function growVillage(page, userId, batches) {
  for (const batch of batches) {
    const placed = await page.evaluate(async (uid, wanted) => {
      const { Backend } = await import('/src/game/backend/GameBackend.ts')
      const world = Backend.getCachedWorld(uid)
      if (!world) throw new Error('no cached world for ' + uid)
      const results = []
      for (const item of wanted) {
        let done = null
        for (const [dx, dy] of item.spots) {
          const anchor = world.buildings.find(b => b.type === 'town_hall')
          const x = (anchor?.gridX ?? 10) + dx
          const y = (anchor?.gridY ?? 10) + dy
          done = await Backend.placeBuilding(uid, item.type, x, y)
          if (done) break
        }
        results.push({ type: item.type, ok: Boolean(done), id: done?.id ?? null })
      }
      return results
    }, userId, batch)
    console.log('placed', JSON.stringify(placed))
    await page.evaluate(() => window.__clashGM.loadBase())
    await sleep(1_300)
  }
}

/* -------------------------------- beats --------------------------------- */

const captured = []
const skipped = []
// BEATS=04-raid,05-dusk-dragon reruns a subset without touching other clips.
const ONLY = (process.env.BEATS ?? '').split(',').map(s => s.trim()).filter(Boolean)

async function beat(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return
  try {
    const path = await fn()
    captured.push({ name, path })
  } catch (error) {
    console.error(`beat ${name} FAILED: ${error.message}`)
    skipped.push({ name, error: error.message })
  }
}

let browser = null
try {
  let cachedToken = null
  try {
    cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null
  } catch { /* minted below */ }
  const session = await api('POST', '/auth/session', { body: cachedToken ? { token: cachedToken } : {} })
  if (session.status !== 200 || !session.json?.token) {
    throw new Error(`auth/session failed (${session.status}): ${session.raw}`)
  }
  const token = session.json.token
  const userId = session.json.user?.id ?? session.json.player?.id ?? session.json.userId ?? null
  writeFileSync(TOKEN_CACHE, JSON.stringify({ token }))
  console.log('session user', userId, Object.keys(session.json))

  // The server refuses saves/training until the village banner is chosen.
  const banner = await api('POST', '/player/banner', {
    token,
    body: { banner: { palette: 2, emblem: 1, pattern: 0 } }
  })
  console.log(`banner: ${banner.status}${banner.ok ? '' : ` ${banner.raw}`}`)

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', `--window-size=${WIDTH},${HEIGHT}`]
  })
  const { page } = await bootPage(browser, token)
  let center = await villageCenter(page)
  console.log('village center', center)

  // BEAT 1 — dawn reveal: wide establishing shot gliding into the hamlet.
  await beat('01-dawn-reveal', async () => {
    await page.evaluate(() => window.__clashGM.advanceDayNight())
    await sleep(700)
    return record(page, '01-dawn-reveal', async () => {
      await glide(page, {
        fromZoom: 0.55, fromX: center.x + 700, fromY: center.y + 380,
        toZoom: 1.05, toX: center.x, toY: center.y,
        duration: 5_600
      })
      await sleep(400)
    })
  })

  // BEAT 2 — the village grows: real placements popping in batches, a wall
  // ring closing around the core, then a power surge to high-level art.
  await beat('02-grows', async () => {
    if (!userId) throw new Error('no userId in session payload')
    return record(page, '02-grows', async () => {
      await glide(page, { fromZoom: 0.95, fromX: center.x, fromY: center.y, toZoom: 0.9, duration: 300 })
      await growVillage(page, userId, [
        [{ type: 'farm', spots: [[-6, 2], [-7, 3], [6, -2]] },
          { type: 'mine', spots: [[6, 2], [7, 3], [-6, -3]] }],
        [{ type: 'army_camp', spots: [[6, 6], [-8, -2], [2, 7]] },
          { type: 'barracks', spots: [[-6, -6], [4, -7], [-2, 7]] },
          { type: 'mystic_barracks', spots: [[7, -6], [-7, 6], [0, -8]] }],
        [{ type: 'cannon', spots: [[3, -3], [-3, 3], [0, 5]] },
          { type: 'storage', spots: [[-4, 0], [4, 0], [0, -5]] },
          { type: 'cannon', spots: [[-3, -4], [5, 1], [1, -6]] },
          { type: 'watchtower', spots: [[8, -3], [-8, 2], [2, -8]] }]
      ])
      // The wall ring closes around the keep in one visible pass.
      await page.evaluate(async uid => {
        const { Backend } = await import('/src/game/backend/GameBackend.ts')
        const world = Backend.getCachedWorld(uid)
        const anchor = world.buildings.find(b => b.type === 'town_hall')
        if (!anchor) return
        const x0 = anchor.gridX - 5
        const y0 = anchor.gridY - 5
        const span = 12
        for (let i = 0; i < span; i += 1) {
          await Backend.placeBuilding(uid, 'wall', x0 + i, y0)
          await Backend.placeBuilding(uid, 'wall', x0 + i, y0 + span - 1)
          if (i > 0 && i < span - 1) {
            await Backend.placeBuilding(uid, 'wall', x0, y0 + i)
            await Backend.placeBuilding(uid, 'wall', x0 + span - 1, y0 + i)
          }
        }
      }, userId)
      await page.evaluate(() => window.__clashGM.loadBase())
      await sleep(1_400)
      // Power surge: the server clocks each level (1s in dev), so climb one
      // level per save cycle — the scaffolds popping ARE the time-lapse.
      for (let cycle = 0; cycle < 8; cycle += 1) {
        const pending = await page.evaluate(async uid => {
          const { Backend } = await import('/src/game/backend/GameBackend.ts')
          const { BUILDING_DEFINITIONS } = await import('/src/game/config/GameDefinitions.ts')
          const world = Backend.getCachedWorld(uid)
          const TARGET = {
            army_camp: 4, barracks: 7, mystic_barracks: 7, cannon: 4,
            storage: 3, farm: 3, mine: 3, wall: 4, watchtower: 2
          }
          let remaining = 0
          for (const building of world.buildings) {
            const goal = TARGET[building.type]
            if (!goal) continue
            const max = BUILDING_DEFINITIONS[building.type]?.maxLevel ?? 1
            const target = Math.min(goal, max)
            const level = building.level ?? 1
            if (level >= target || building.upgradingTo) {
              if ((building.level ?? 1) < target) remaining += 1
              continue
            }
            building.level = level + 1
            remaining += Number(building.level < target)
          }
          world.wallLevel = Math.min(4, Math.max(world.wallLevel ?? 1,
            ...world.buildings.filter(b => b.type === 'wall').map(b => b.level ?? 1)))
          Backend.setCachedWorld(uid, world)
          Backend.markLayoutEdited(uid)
          await Backend.saveNow(uid)
          return remaining
        }, userId)
        await sleep(1_500)
        await api('GET', '/world', { token })
        await page.evaluate(() => window.__clashGM.loadBase())
        await sleep(400)
        if (pending === 0) break
      }
      await sleep(700)
      center = await villageCenter(page)
      await glide(page, { toZoom: 1.05, toX: center.x, toY: center.y, duration: 1_600 })
      await sleep(500)
    })
  })

  // BEAT 3 — the wilds: neighbourhood view, glide over water and nature.
  await beat('03-wilds', async () => {
    await page.evaluate(() => window.__clashGM.showNeighborhood())
    await sleep(2_800)
    try {
      return await record(page, '03-wilds', async () => {
        await glide(page, {
          fromZoom: 0.30, fromX: center.x - 1800, fromY: center.y + 900,
          toZoom: 0.42, toX: center.x + 1500, toY: center.y - 600,
          duration: 7_000
        })
      })
    } finally {
      await page.evaluate(() => window.__clashGM.showNeighborhood())
      await sleep(1_500)
    }
  })

  // BEAT 4 — the raid: train an army, matchmake (bot fortresses rotate in),
  // deploy along an edge and film the assault.
  await beat('04-raid', async () => {
    // Clear any raid session a previous (crashed) run left open — the server
    // refuses new raids while one is active.
    const active = await api('GET', '/attacks/active', { token })
    const stale = active.json?.session
    if (stale?.kind === 'bot' && stale.raidId) {
      const settled = await api('POST', '/attacks/bot-settle', {
        token,
        body: {
          raidId: stale.raidId, x: stale.x, y: stale.y,
          destruction: 0, deployed: {}, requestId: `trailer-abort-${Date.now()}`
        }
      })
      console.log(`stale bot raid ${stale.raidId} settled: ${settled.status}`)
    }
    // Spectacle-first training order so the big units secure camp space.
    const wishlist = [
      ['warelephant', 2], ['trebuchet', 2], ['stormmage', 4],
      ['phalanx', 4], ['warrior', 10], ['archer', 8]
    ]
    for (const [type, count] of wishlist) {
      const result = await api('POST', '/army/train', {
        token,
        body: { type, count, requestId: `trailer-${type}-${Date.now()}` }
      })
      if (!result.ok) console.warn(`train ${type} -> ${result.status}: ${result.raw}`)
    }
    // Fresh boot so the client hydrates the newly trained army before war.
    await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => {
      const scene = window.__clashGame?.scene?.keys?.MainScene
      return Boolean(scene?.worldMap && scene?.cameras?.main && scene?.buildings?.length)
    }, { timeout: 60_000, polling: 300 })
    await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 25_000 }).catch(() => {})
    await page.addStyleTag({ content: `
      .app-container > :not(#game-container) { opacity: 0 !important; pointer-events: none !important; }
      .village-bubble-layer, .plot-bubble, .building-bubble { display: none !important; }
    ` })
    await sleep(1_000)
    // Pick the most dramatic fortress in sight: prefer ward-closed layouts
    // (multiple wall works / many walls), then trophies.
    const map = await api('GET', '/map?r=6', { token })
    const camps = (map.json?.plots ?? []).filter(plot => plot.kind === 'bot' && plot.world)
    if (!camps.length) throw new Error('no bot camps in sight')
    const drama = plot => {
      const walls = (plot.world.buildings ?? []).filter(b => b.type === 'wall')
      const cells = new Set(walls.map(w => `${w.gridX},${w.gridY}`))
      let components = 0
      const seen = new Set()
      for (const start of cells) {
        if (seen.has(start)) continue
        components += 1
        const queue = [start]
        seen.add(start)
        while (queue.length) {
          const [cx, cy] = queue.pop().split(',').map(Number)
          for (const next of [`${cx - 1},${cy}`, `${cx + 1},${cy}`, `${cx},${cy - 1}`, `${cx},${cy + 1}`]) {
            if (cells.has(next) && !seen.has(next)) {
              seen.add(next)
              queue.push(next)
            }
          }
        }
      }
      return components * 10_000 + walls.length * 20 + (plot.trophies ?? 0) / 100
    }
    const target = camps.reduce((best, plot) => drama(plot) > drama(best) ? plot : best)
    console.log('raiding', target.username, target.trophies, `@${target.x},${target.y}`,
      'walls', (target.world.buildings ?? []).filter(b => b.type === 'wall').length)
    await page.evaluate(plot => {
      // Track mode changes at the manager so the wait is UI-independent.
      const manager = window.__clashGM
      if (!window.__modeWrapped) {
        const original = manager.setGameMode.bind(manager)
        manager.setGameMode = mode => {
          window.__gameMode = mode
          original(mode)
        }
        window.__modeWrapped = true
      }
      const scene = window.__clashGame.scene.keys.MainScene
      scene.attackBotPlot(plot.seed, plot.username, plot.x, plot.y)
    }, { seed: target.seed, username: target.username, x: target.x, y: target.y })
    await page.waitForFunction(() => window.__gameMode === 'ATTACK', {
      timeout: 40_000,
      polling: 250
    }).catch(() => {
      throw new Error('attack mode never engaged (bot raid failed to start)')
    })
    await sleep(4_000)
    // The battlefield grid renders at canonical iso coordinates; postcards
    // offset AROUND it. Its centre is therefore cartToIso of the grid middle.
    const enemyCenter = await page.evaluate(async () => {
      const { IsoUtils } = await import('/src/game/utils/IsoUtils.ts')
      return IsoUtils.cartToIso(12.5, 12.5)
    })
    console.log('battle center', enemyCenter)
    return record(page, '04-raid', async () => {
      await glide(page, {
        fromZoom: 0.85, fromX: enemyCenter.x, fromY: enemyCenter.y + 150,
        toZoom: 1.0, toX: enemyCenter.x, toY: enemyCenter.y,
        duration: 1_800
      })
      // Siege line via the scene's own deploy entry (grid coords, snapped to
      // legal ground): elephants crack walls, infantry floods, ranged and
      // artillery hold the rear — classic CoC deployment theatre.
      const spawnWave = async wave => {
        await page.evaluate(units => {
          const scene = window.__clashGame.scene.keys.MainScene
          for (const [type, gx, gy] of units) scene.spawnTroop(gx, gy, type, 'PLAYER')
        }, wave)
      }
      await spawnWave([['warelephant', 6, 22], ['warelephant', 14, 22]])
      await sleep(900)
      await spawnWave([
        ['warrior', 4, 21], ['warrior', 6, 23], ['warrior', 8, 22],
        ['warrior', 10, 23], ['warrior', 12, 22], ['warrior', 14, 23],
        ['warrior', 16, 21], ['warrior', 9, 24]
      ])
      await sleep(700)
      await spawnWave([['phalanx', 5, 23], ['phalanx', 15, 23]])
      await sleep(700)
      await spawnWave([
        ['archer', 6, 24], ['archer', 9, 24], ['archer', 12, 24],
        ['archer', 15, 24], ['archer', 18, 23]
      ])
      await sleep(700)
      await spawnWave([['stormmage', 8, 24], ['stormmage', 13, 24]])
      await spawnWave([['trebuchet', 5, 24], ['trebuchet', 16, 24]])
      // Ride the assault: push into the melee, hold, then pull wide as the
      // fortress comes apart.
      await glide(page, {
        toZoom: 1.45, toX: enemyCenter.x - 30, toY: enemyCenter.y + 120,
        duration: 5_000
      })
      await sleep(2_500)
      await glide(page, {
        toZoom: 1.3, toX: enemyCenter.x + 60, toY: enemyCenter.y - 30,
        duration: 5_500
      })
      await glide(page, {
        toZoom: 0.95, toX: enemyCenter.x, toY: enemyCenter.y,
        duration: 4_500
      })
      await sleep(4_000)
    })
  })

  // BEAT 5 — dusk + dragon: home again, night falls, the shadow sweeps.
  await beat('05-dusk-dragon', async () => {
    // Settle whatever raid is open, then boot fresh into home mode.
    const active = await api('GET', '/attacks/active', { token })
    const open = active.json?.session
    if (open?.kind === 'bot' && open.raidId) {
      await api('POST', '/attacks/bot-settle', {
        token,
        body: {
          raidId: open.raidId, x: open.x, y: open.y,
          destruction: 60, deployed: {}, requestId: `trailer-settle-${Date.now()}`
        }
      })
    }
    await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => {
      const scene = window.__clashGame?.scene?.keys?.MainScene
      return Boolean(scene?.worldMap && scene?.cameras?.main && scene?.buildings?.length)
    }, { timeout: 60_000, polling: 300 })
    await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 25_000 }).catch(() => {})
    await page.addStyleTag({ content: `
      .app-container > :not(#game-container) { opacity: 0 !important; pointer-events: none !important; }
      .village-bubble-layer, .plot-bubble, .building-bubble { display: none !important; }
    ` })
    center = await villageCenter(page)
    await sleep(1_200)
    await page.evaluate(() => {
      window.__clashGM.advanceDayNight()
      window.__clashGM.advanceDayNight()
    })
    await sleep(700)
    return record(page, '05-dusk-dragon', async () => {
      await page.evaluate(() => window.__clashGM.summonDragon())
      await glide(page, {
        fromZoom: 1.1, fromX: center.x, fromY: center.y,
        toZoom: 0.62, toX: center.x + 120, toY: center.y + 90,
        duration: 6_400
      })
    })
  })

  writeFileSync(`${OUT}/manifest.json`, JSON.stringify({ captured, skipped, width: WIDTH, height: HEIGHT }, null, 2))
  console.log(JSON.stringify({ captured: captured.map(c => c.name), skipped }, null, 2))
} finally {
  await browser?.close()
}
