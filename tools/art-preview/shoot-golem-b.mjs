// GOLEM DESIGN B ("Cromlech Warden") verification harness.
// Cribbed setup from shoot-troops.mjs / shoot-defenses.mjs.
// Resumes the ONE shared art-preview identity (never mints guests) and pins
// localStorage clash.sprites.off=1 + clash.design.golem=B before boot.
//
//   BASE=http://127.0.0.1:5175 OUT=<dir> node shoot-golem-b.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5175'
const OUT = (process.env.OUT ?? '/tmp/golem-b').replace(/\/$/, '')
const RAW = `${OUT}/raw`
rmSync(RAW, { recursive: true, force: true }) // stale frames poison the montages
mkdirSync(RAW, { recursive: true })

// ---- shared identity (guest creation is rate-limited; never mint) ----
const TOKEN_CACHE = new URL('./.shared-device-token.json', import.meta.url).pathname
const cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token
const res = await fetch(`${BASE}/api/auth/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: cachedToken })
})
const session = await res.json()
if (!session?.token) throw new Error(`auth/session failed: ${JSON.stringify(session)}`)
const token = session.token
try { writeFileSync(TOKEN_CACHE, JSON.stringify({ token })) } catch { /* non-fatal */ }

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => {
    localStorage.setItem('clash.device.token', tok)
    localStorage.setItem('clash.sprites.off', '1')
    localStorage.setItem('clash.design.golem', 'B')
  }, token)
  const errors = []
  page.on('pageerror', e => { errors.push(String(e.message).slice(0, 200)); console.log('PAGE ERROR:', String(e.message).slice(0, 200)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 90000, polling: 500 })
  await sleep(2500)

  // ---- cast ----
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather.setWeatherOverride(0)
    // level rows: player + enemy (clear lawn, off the campfire patch)
    s.spawnTroop(6.5, 13, 'golem', 'PLAYER', 1)
    s.spawnTroop(9.5, 13, 'golem', 'PLAYER', 2)
    s.spawnTroop(12.5, 13, 'golem', 'PLAYER', 3)
    s.spawnTroop(6.5, 16.4, 'golem', 'ENEMY', 1)
    s.spawnTroop(9.5, 16.4, 'golem', 'ENEMY', 2)
    s.spawnTroop(12.5, 16.4, 'golem', 'ENEMY', 3)
    // headings grid (L2 player): 8 headings, two rows of 4
    for (let k = 0; k < 4; k++) s.spawnTroop(6 + k * 3.2, 21, 'golem', 'PLAYER', 2)
    for (let k = 4; k < 8; k++) s.spawnTroop(6 + (k - 4) * 3.2, 24.4, 'golem', 'PLAYER', 2)
    // demo golem for walk/slam closeups (map is 25x25 — stay on it)
    s.spawnTroop(19.5, 22.5, 'golem', 'PLAYER', 3)
    const gs = s.troops.filter(t => t.type === 'golem')
    gs.forEach(t => { t.target = null; t.path = undefined; t.facingAngle = 0.6 })
    // heading golems face k * PI/4 (screen-space)
    const heads = gs.slice(6, 14)
    heads.forEach((t, k) => { t.facingAngle = k * Math.PI / 4 })
    window.__G = gs
    return gs.length
  }).then(n => console.log('golems spawned:', n))
  await sleep(900) // landing bounce settles

  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const shot = (name, w = 800, h = 560) => page.screenshot({
    path: `${RAW}/${name}.png`,
    clip: { x: 640 - w / 2, y: 450 - h / 2, width: w, height: h }
  })

  const pause = () => page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  const resume = () => page.evaluate(() => window.__clashGame.scene.resume('MainScene'))

  // redraw all golems in a given mode at the frozen clock
  const redrawAll = (moving = false) => page.evaluate(m => {
    const s = window.__clashGame.scene.keys.MainScene
    for (const t of window.__G) { t.lastAttackTime = -1e7; t.slamOffset = 0; s.redrawTroopWithMovement(t, m) }
  }, moving)
  const redrawDemo = (moving, slam, ang) => page.evaluate(({ moving, slam, ang }) => {
    const s = window.__clashGame.scene.keys.MainScene
    const t = window.__G[window.__G.length - 1]
    t.lastAttackTime = -1e7
    t.slamOffset = slam
    if (ang !== null) t.facingAngle = ang
    s.redrawTroopWithMovement(t, moving)
    return s.time.now
  }, { moving, slam, ang })

  await pause()

  // Park every golem back on its parade tile (HOME-mode wandering moves them)
  const park = () => page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const spots = [
      [6.5, 13], [9.5, 13], [12.5, 13],
      [6.5, 16.4], [9.5, 16.4], [12.5, 16.4],
      [6, 21], [9.2, 21], [12.4, 21], [15.6, 21],
      [6, 24.4], [9.2, 24.4], [12.4, 24.4], [15.6, 24.4],
      [19.5, 22.5]
    ]
    window.__G.forEach((t, i) => {
      const [x, y] = spots[i] ?? spots[spots.length - 1]
      t.gridX = x; t.gridY = y
      t.gameObject.setPosition((x - y) * 32, (x + y) * 16)
      if (t.healthBar) t.healthBar.setPosition((x - y) * 32, (x + y) * 16 - 70)
    })
    void s
  })
  await park()
  await redrawAll(false)

  // ---- (1) level rows, day ----
  await cam(9.5, 14.7, 2.2, -20)
  await shot('levels-day', 900, 620)

  // ---- (2) headings grid ----
  await cam(10.8, 22.7, 1.9, -18)
  await shot('headings', 1000, 640)

  // ---- (3) idle breathing series (2000 ms loop, 4 samples) ----
  await cam(19.5, 22.5, 4.2, -28)
  for (let i = 0; i < 4; i++) {
    if (i > 0) { await resume(); await sleep(500); await pause(); await park() }
    const now = await redrawDemo(false, 0, 0.6)
    await shot(`idle-${i}-t${Math.round(now % 2000)}`, 420, 480)
  }

  // ---- (4) walk stride series (1500 ms loop, 6 samples) ----
  for (let i = 0; i < 6; i++) {
    await resume(); await sleep(250); await pause(); await park()
    const now = await redrawDemo(true, 0, 0.6)
    await shot(`walk-${i}-t${Math.round(now % 1500)}`, 420, 480)
  }

  // ---- (5) slam sequence (slamOffset drives the pound; 12 = damage tick) ----
  for (const [i, so] of [0, 3, 7, 10, 12, 6, 0].entries()) {
    await redrawDemo(false, so, 0.5)
    await shot(`slam-${i}-o${so}`, 420, 480)
  }

  // ---- (6) walk in 4 headings (stride pose x direction) ----
  for (const [i, ang] of [0, Math.PI / 2, Math.PI, -Math.PI / 2].entries()) {
    await redrawDemo(true, 0, ang)
    await shot(`walkdir-${i}`, 420, 480)
  }

  // ---- (7) night: set the camera BEFORE pausing — the grade overlay is a
  // world-space rect glued to cam.worldView per frame; freezing the scene
  // then moving the camera leaves a misaligned dark patch. ----
  await resume()
  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.8))
  await cam(9.5, 14.7, 2.2, -20)
  await sleep(2200)
  await pause()
  await park()
  await redrawAll(false)
  await shot('night-levels', 900, 620)
  await resume()
  await cam(19.5, 22.5, 4.2, -28)
  await sleep(700)
  await pause()
  await park()
  await redrawDemo(false, 0, 0.6)
  await shot('night-close', 420, 480)

  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.32))
  await resume()

  // ---- montage helper: stitch labeled frames into one image ----
  const montage = async (name, files, cols) => {
    const imgs = files.map(f => {
      const b64 = readFileSync(`${RAW}/${f}.png`).toString('base64')
      return `<figure style="margin:4px"><img src="data:image/png;base64,${b64}" style="display:block"><figcaption style="color:#ddd;font:12px monospace;text-align:center;padding:2px">${f}</figcaption></figure>`
    }).join('')
    const mp = await browser.newPage()
    await mp.setContent(`<body style="margin:0;background:#181818;display:grid;grid-template-columns:repeat(${cols},max-content);width:max-content">${imgs}</body>`)
    const el = await mp.$('body')
    await el.screenshot({ path: `${OUT}/${name}.png` })
    await mp.close()
  }

  const { readdirSync, copyFileSync } = await import('node:fs')
  const raws = readdirSync(RAW).map(f => f.replace(/\.png$/, ''))
  const pick = prefix => raws.filter(f => f.startsWith(prefix)).sort((a, b) => {
    const ia = Number(a.split('-')[1]); const ib = Number(b.split('-')[1])
    return ia - ib
  })
  await montage('idle-seq', pick('idle-'), 4)
  await montage('walk-seq', pick('walk-').filter(f => !f.startsWith('walkdir')), 6)
  await montage('slam-seq', pick('slam-'), 7)
  await montage('walk-headings', pick('walkdir-'), 4)
  copyFileSync(`${RAW}/levels-day.png`, `${OUT}/levels-day.png`)
  copyFileSync(`${RAW}/headings.png`, `${OUT}/headings.png`)
  copyFileSync(`${RAW}/night-levels.png`, `${OUT}/night-levels.png`)
  copyFileSync(`${RAW}/night-close.png`, `${OUT}/night-close.png`)

  console.log('golem-B shots →', OUT, 'errors:', errors.length ? errors : 'none')
} finally {
  await browser.close()
}
