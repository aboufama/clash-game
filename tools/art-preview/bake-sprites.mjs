// Sprite bake pipeline v3 (docs/AGENTS_SPRITE_PIPELINE.md).
//
// Renders every unit's vector art through the REAL game renderer (via the
// window.__clashBake bridge) and quantizes it into pixel-art texels with the
// removed Pixelate shader's math (CELL world-px cells, center-sampled),
// anchored to the OBJECT. v3 bakes the full dynamic-state surface:
//   - defenses: per-angle IDLE + per-angle FIRE sequences (recoil/tension/
//     reload/charge drivers), tesla charge/charged, frostfall loaded/empty
//   - mine/farm fillLevel stages, town-hall door, jukebox playing,
//     wall gates, ambient idle loops (auto-detected), vapor OFF (smoke is a
//     runtime effect layer)
//   - troops: 8/1 dirs × exact-loop idle breath + walk + attack (attackAge
//     or driver-swept: golem slam, phalanx spear), tank deactivated pose
//   - wrecks: ground+body rubble per building type/level
//
//   UNITS=all TROOPS=all WRECKS=1 node bake-sprites.mjs     # everything
//   UNITS=cannon LEVELS=1 node bake-sprites.mjs
//   VERIFY=1 UNITS=cannon node bake-sprites.mjs
//   OUT=/tmp/x CELL=1.8 ... (experiments; default writes public/assets/sprites)
//
// Requires a running game server (npm start on 8788, or npm run dev on 5173).
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8788'
const CELL = Number(process.env.CELL ?? 1.35) // world px per texel — the shipped shader's cell size
const UNITS = (process.env.UNITS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const LEVELS = process.env.LEVELS ? process.env.LEVELS.split(',').map(Number) : null // null = 1..maxLevel
// Mortar snaps its barrel to discrete rotations from ballistaAngle and the
// spike launcher aims too (found by the state-read audit) — both bake angles.
const ROTATING = new Set(['cannon', 'ballista', 'xbow', 'mortar', 'spike_launcher'])
const ANGLES_ENV = process.env.ANGLES ? Math.max(1, Number(process.env.ANGLES)) : null
const ANGLE = Number(process.env.ANGLE ?? 0.55)
const VERIFY = process.env.VERIFY === '1'
const WANT_WRECKS = process.env.WRECKS === '1' || (UNITS.length === 1 && UNITS[0] === 'all')
const TROOPS = (process.env.TROOPS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const TROOP_LEVELS = (process.env.TROOP_LEVELS ?? '1,2,3').split(',').map(Number)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_ROOT = process.env.OUT ?? join(REPO, 'public', 'assets', 'sprites')
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'shots')
mkdirSync(SHOTS, { recursive: true })

// ---------------------------------------------------------------- plans ----

// Per-troop rig constants, read from TroopRenderer's hRig/attackAnim call
// sites. dirs:8 = the draw consumes facingAngle. Troop idle breath is
// sin(time/640) → one EXACT loop every 2π·640 ≈ 4021 ms.
const IDLE_BREATH_MS = Math.round(Math.PI * 2 * 640)
const TROOP_PARAMS = {
  warrior:      { stride: 420, delay: 800,  windup: 280, strike: 170, dirs: 1 },
  archer:       { stride: 380, delay: 900,  windup: 380, strike: 150, dirs: 8 },
  giant:        { stride: 640, delay: 3600, windup: 950, strike: 550, dirs: 1, loopExact: false },
  golem:        { stride: 760, delay: 0,    windup: 0,   strike: 0,   dirs: 1, loopExact: false,
                  attackDriver: { key: 'slamOffset', values: [0, 4, 9, 12, 7, 2] } }, // scene tweens 0→12→0
  sharpshooter: { stride: 430, delay: 1400, windup: 420, strike: 0,   dirs: 8 },
  mobilemortar: { stride: 400, delay: 2200, windup: 420, strike: 0,   dirs: 8, big: true,
                  recoilSeq: [0, 0, 0, 0, 5, 2.5] }, // paired with attack ages: recoil after the tick
  ward:         { stride: 520, delay: 1000, windup: 420, strike: 300, dirs: 1 },
  recursion:    { stride: 480, delay: 0,    windup: 0,   strike: 0,   dirs: 1, attack: false },
  ram:          { stride: 480, delay: 1100, windup: 320, strike: 160, dirs: 8, big: true, loopExact: false },
  stormmage:    { stride: 480, delay: 1700, windup: 620, strike: 380, dirs: 1 },
  davincitank:  { stride: 480, delay: 0,    windup: 0,   strike: 0,   dirs: 8, big: true, attack: false,
                  loopExact: false, deactivated: true },
  phalanx:      { stride: 420, delay: 0,    windup: 0,   strike: 0,   dirs: 8,
                  attackDriver: { key: 'phalanxSpearOffset', values: [0, 0.45, 1, 0.55, 0.15] } },
  romanwarrior: { stride: 420, delay: 900,  windup: 260, strike: 150, dirs: 8 },
  wallbreaker:  { stride: 260, delay: 500,  windup: 240, strike: 0,   dirs: 1 }
}
const WALK_FRAMES = 6
const IDLE_FRAMES = 6
const attackAges = (p) => {
  const ages = [0.999, 0.6, 0.3, 0.05].map(t => Math.max(0, p.delay - p.windup * t))
  if (p.strike > 0) ages.push(p.strike * 0.15, p.strike * 0.6)
  else ages.push(1, 40)
  return ages
}

// Building fire/charge/state sequences: each frame is a set of stub/request
// overrides. `fireAge` becomes lastFireTime = TIME − fireAge. Drivers match
// what MainScene tweens at runtime (cannonRecoilOffset 0..1, ballista
// tension/bolt reload cycle, xbow tension decay, everything else pure
// f(time − lastFireTime)).
const BUILDING_STATES = {
  cannon: { fire: [
    { fireAge: 0, recoil: 1 }, { fireAge: 70, recoil: 0.8 }, { fireAge: 160, recoil: 0.55 },
    { fireAge: 300, recoil: 0.25 }, { fireAge: 480, recoil: 0 }
  ] },
  ballista: { fire: [
    { fireAge: 0, tension: 0, bolt: false }, { fireAge: 150, tension: 0.35, bolt: false },
    { fireAge: 320, tension: 0.7, bolt: true }, { fireAge: 520, tension: 1, bolt: true }
  ] },
  xbow: { fire: [
    { fireAge: 0, tension: 1 }, { fireAge: 110, tension: 0.6 },
    { fireAge: 250, tension: 0.3 }, { fireAge: 420, tension: 0 }
  ] },
  mortar: { fire: [{ fireAge: 0 }, { fireAge: 80 }, { fireAge: 180 }, { fireAge: 340 }, { fireAge: 520 }] },
  tesla: {
    charge: [{ chargeAge: 80 }, { chargeAge: 300 }, { chargeAge: 620 }],
    charged: [{ charged: true }],
    fire: [{ fireAge: 0 }, { fireAge: 120 }, { fireAge: 320 }]
  },
  prism: { fire: [{ fireAge: 0 }, { fireAge: 120 }, { fireAge: 240 }] },
  frostfall: { fire: [
    { fireAge: 0, projectileActive: true }, { fireAge: 300, projectileActive: true },
    { fireAge: 800, projectileActive: false }
  ] },
  dragons_breath: { fire: [0, 150, 350, 700, 1100, 1600].map(a => ({ fireAge: a })) },
  spike_launcher: { fire: [0, 90, 200, 380, 600].map(a => ({ fireAge: a })) },
  mine: { fill: [{ fillLevel: 0 }, { fillLevel: 0.34 }, { fillLevel: 0.67 }] }, // idle = full (1)
  farm: { fill: [{ fillLevel: 0 }, { fillLevel: 0.34 }, { fillLevel: 0.67 }] },
  town_hall: { door: [{ doorOpen: 0.5 }, { doorOpen: 1 }] },
  jukebox: { playing: [{ jukeboxPlaying: true, timeAt: 1000 }, { jukeboxPlaying: true, timeAt: 1400 }, { jukeboxPlaying: true, timeAt: 1800 }] }
}
// Ambient idle motion (flags waving, watchman scanning, glints, spinning
// rings) is DISCOVERED, not declared: the tool probes each building over 8 s,
// autocorrelates changed-texel fractions to find the true motion period
// (preferring the FIRST strong minimum so fast spinners like the prism don't
// alias to a long harmonic), and bakes the idle loop across exactly that
// period at a frame rate matched to it — fast loops get ~12 fps, slow drifts
// stay lean.
const ambientFrameCount = (periodMs) => Math.max(8, Math.min(24, Math.round(periodMs / 85)))
const AMBIENT_PROBE = { stepMs: 250, spanMs: 8000, maxPeriodMs: 6000 }

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1440,900']
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  page.on('pageerror', e => console.error('pageerror:', String(e)))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.settings-btn', { timeout: 60_000 })
  await new Promise(r => setTimeout(r, 5500))
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.getScene('MainScene')
    scene.weather?.setWeatherOverride?.(0)
    scene.dayNight?.setPhaseOverride?.(0.3)
    // Vapor (chimney/powder smoke, launch columns) is a runtime effect layer
    // — never part of baked body art.
    window.__clashBake.BuildingRenderer.AMBIENT_VAPOR = false
  })

  const write64 = (path, dataURL) => writeFileSync(path, Buffer.from(dataURL.split(',')[1], 'base64'))

  // ---- one building capture batch: [{pass, angle, ov, timeAt}] → frames ----
  const bakeBuildingBatch = (type, level, jobs, wallNeighbors) => page.evaluate(
    async (type, level, jobs, wallNeighbors, cell) => {
      const B = window.__clashBake
      const scene = B.scene
      const def = B.BUILDING_DEFINITIONS[type]
      if (!def) throw new Error(`unknown building type ${type}`)
      const big = Math.max(def.width, def.height)
      const M = 80 + big * 26, TOP = 190 + big * 34, BOT = 66 + big * 10
      const minX = -((def.height * B.TILE_WIDTH) / 2) - M
      const maxX = ((def.width * B.TILE_WIDTH) / 2) + M
      const minY = -TOP
      const maxY = (def.width + def.height) * (B.TILE_HEIGHT / 2) + BOT
      const W = Math.ceil(maxX - minX), H = Math.ceil(maxY - minY)
      const rt = scene.make.renderTexture({ x: 0, y: 0, width: W, height: H }, false)
      const centerWorld = { x: (def.width - def.height) * (B.TILE_WIDTH / 4), y: (def.width + def.height) * (B.TILE_HEIGHT / 4) }

      const out = []
      for (const job of jobs) {
        const ov = job.ov ?? {}
        const TIME = ov.timeAt ?? 1000
        const stub = {
          type, level, health: 100, maxHealth: 100, owner: 'PLAYER', gridX: 0, gridY: 0,
          ballistaAngle: job.angle, ballistaTargetAngle: job.angle, idleTargetAngle: job.angle,
          ballistaStringTension: ov.tension ?? 0,
          ballistaBoltLoaded: ov.bolt ?? true,
          cannonRecoilOffset: ov.recoil ?? 0,
          isFiring: (ov.fireAge ?? Infinity) < 120,
          lastFireTime: ov.fireAge != null ? TIME - ov.fireAge : undefined,
          teslaCharging: ov.chargeAge != null,
          teslaChargeStart: ov.chargeAge != null ? TIME - ov.chargeAge : 0,
          teslaCharged: ov.charged === true,
          frostfallProjectileActive: ov.projectileActive === true,
          fillLevel: ov.fillLevel ?? 1,
          doorOpen: ov.doorOpen ?? 0,
          isGate: ov.isGate === true
        }
        const g = scene.make.graphics({ x: 0, y: 0 }, false)
        B.drawBuildingVisual({
          graphics: g, type, gridX: 0, gridY: 0, alpha: 1,
          building: stub, time: TIME,
          skipBase: job.pass === 'body', onlyBase: job.pass === 'ground',
          jukeboxPlaying: ov.jukeboxPlaying === true,
          ...(wallNeighbors ? { wallNeighbors } : {})
        })
        rt.clear()
        rt.draw(g, -minX, -minY)
        const dataURL = await new Promise(res => rt.snapshot(img => res(img.src)))
        g.destroy()
        const img = new Image()
        await new Promise(res => { img.onload = res; img.src = dataURL })
        const cv = document.createElement('canvas')
        cv.width = W; cv.height = H
        const ctx = cv.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0)
        const data = ctx.getImageData(0, 0, W, H).data
        const tw = Math.floor(W / cell), th = Math.floor(H / cell)
        const tex = new Uint8ClampedArray(tw * th * 4)
        for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
          const sx = Math.min(W - 1, Math.floor((i + 0.5) * cell))
          const sy = Math.min(H - 1, Math.floor((j + 0.5) * cell))
          const s = (sy * W + sx) * 4, d = (j * tw + i) * 4
          tex[d] = data[s]; tex[d + 1] = data[s + 1]; tex[d + 2] = data[s + 2]
          // Alpha snap: AA edge texels either commit (solid) or vanish — hard
          // binary silhouettes, no translucent halo around any sprite.
          tex[d + 3] = data[s + 3] < 128 ? 0 : 255
        }
        let x0 = tw, y0 = th, x1 = -1, y1 = -1
        for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
          if (tex[(j * tw + i) * 4 + 3] > 8) {
            if (i < x0) x0 = i; if (i > x1) x1 = i
            if (j < y0) y0 = j; if (j > y1) y1 = j
          }
        }
        if (x1 < 0) { out.push(null); continue }
        const cw = x1 - x0 + 1, ch = y1 - y0 + 1
        const oc = document.createElement('canvas')
        oc.width = cw; oc.height = ch
        const octx = oc.getContext('2d')
        const od = octx.createImageData(cw, ch)
        for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
          const s = ((j + y0) * tw + (i + x0)) * 4, d = (j * cw + i) * 4
          od.data[d] = tex[s]; od.data[d + 1] = tex[s + 1]; od.data[d + 2] = tex[s + 2]; od.data[d + 3] = tex[s + 3]
        }
        octx.putImageData(od, 0, 0)
        // 8×8 luminance signature of the UNCROPPED texel grid — stable across
        // frames of one building, used for motion detection/autocorrelation.
        const sig = []
        for (let by = 0; by < 8; by++) for (let bx = 0; bx < 8; bx++) {
          let sum = 0, n = 0
          const jx0 = Math.floor(bx * tw / 8), jx1 = Math.floor((bx + 1) * tw / 8)
          const jy0 = Math.floor(by * th / 8), jy1 = Math.floor((by + 1) * th / 8)
          for (let j = jy0; j < jy1; j++) for (let i = jx0; i < jx1; i++) {
            const s = (j * tw + i) * 4
            sum += (tex[s] + tex[s + 1] + tex[s + 2]) * (tex[s + 3] / 255); n++
          }
          sig.push(n ? sum / n : 0)
        }
        const cropLeftWorld = { x: minX + x0 * cell, y: minY + y0 * cell }
        out.push({
          png: oc.toDataURL('image/png'),
          sig,
          meta: {
            texelW: cw, texelH: ch, cellWorldPx: cell,
            originX: (centerWorld.x - cropLeftWorld.x) / (cw * cell),
            originY: (centerWorld.y - cropLeftWorld.y) / (ch * cell)
          }
        })
      }
      rt.destroy()
      return out
    }, type, level, jobs, wallNeighbors ?? null, CELL)

  // Ambient-motion probe: draw the idle body at N times, quantize in-page,
  // and measure per-lag CHANGED-TEXEL fractions (the render is deterministic,
  // so any changed texel is real motion — mean-luminance signatures dilute a
  // small waving flag to nothing). Returns the measured loop period, or null.
  const probeAmbient = (type, level, stepMs, spanMs, maxPeriodMs) => page.evaluate(
    async (type, level, stepMs, spanMs, maxPeriodMs, cell) => {
      const B = window.__clashBake
      const scene = B.scene
      const def = B.BUILDING_DEFINITIONS[type]
      const big = Math.max(def.width, def.height)
      const M = 80 + big * 26, TOP = 190 + big * 34, BOT = 66 + big * 10
      const minX = -((def.height * B.TILE_WIDTH) / 2) - M
      const maxX = ((def.width * B.TILE_WIDTH) / 2) + M
      const minY = -TOP
      const maxY = (def.width + def.height) * (B.TILE_HEIGHT / 2) + BOT
      const W = Math.ceil(maxX - minX), H = Math.ceil(maxY - minY)
      const rt = scene.make.renderTexture({ x: 0, y: 0, width: W, height: H }, false)
      const tw = Math.floor(W / cell), th = Math.floor(H / cell)
      const count = Math.floor(spanMs / stepMs) + 1
      const bufs = []
      for (let k = 0; k < count; k++) {
        const TIME = 1000 + k * stepMs
        const g = scene.make.graphics({ x: 0, y: 0 }, false)
        B.drawBuildingVisual({
          graphics: g, type, gridX: 0, gridY: 0, alpha: 1,
          building: { type, level, health: 100, owner: 'PLAYER', gridX: 0, gridY: 0 },
          time: TIME, skipBase: true
        })
        rt.clear(); rt.draw(g, -minX, -minY)
        const dataURL = await new Promise(res => rt.snapshot(img => res(img.src)))
        g.destroy()
        const img = new Image()
        await new Promise(res => { img.onload = res; img.src = dataURL })
        const cv = document.createElement('canvas')
        cv.width = W; cv.height = H
        const ctx = cv.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0)
        const data = ctx.getImageData(0, 0, W, H).data
        const tex = new Uint8ClampedArray(tw * th * 4)
        for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
          const sx = Math.min(W - 1, Math.floor((i + 0.5) * cell))
          const sy = Math.min(H - 1, Math.floor((j + 0.5) * cell))
          const s = (sy * W + sx) * 4, d = (j * tw + i) * 4
          tex[d] = data[s]; tex[d + 1] = data[s + 1]; tex[d + 2] = data[s + 2]
          // Alpha snap: AA edge texels either commit (solid) or vanish — hard
          // binary silhouettes, no translucent halo around any sprite.
          tex[d + 3] = data[s + 3] < 128 ? 0 : 255
        }
        bufs.push(tex)
      }
      rt.destroy()
      let occupied = 0
      for (let i = 3; i < bufs[0].length; i += 4) if (bufs[0][i] > 8) occupied++
      occupied = Math.max(1, occupied)
      const changedPct = (a, b) => {
        let changed = 0
        for (let i = 0; i < a.length; i += 4) {
          if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
            || Math.abs(a[i + 2] - b[i + 2]) > 6 || Math.abs(a[i + 3] - b[i + 3]) > 6) changed++
        }
        return (100 * changed) / occupied
      }
      let maxPct = 0
      for (let i = 1; i < bufs.length; i++) maxPct = Math.max(maxPct, changedPct(bufs[0], bufs[i]))
      if (maxPct < 0.2) return { period: null, maxPct }
      const lags = []
      for (let lag = 2; lag * stepMs <= maxPeriodMs; lag++) {
        let s = 0, n = 0
        for (let i = 0; i + lag < bufs.length; i++) { s += changedPct(bufs[i], bufs[i + lag]); n++ }
        if (n >= 6) lags.push({ p: lag * stepMs, d: s / n })
      }
      if (!lags.length) return { period: 2400, maxPct, residual: -1 }
      const dStar = Math.min(...lags.map(l => l.d))
      // First strong minimum: the shortest lag within 15% of the global best,
      // so a fast spinner keeps its true short period instead of a harmonic.
      const best = lags.find(l => l.d <= dStar * 1.15 + 0.05) ?? lags[0]
      // Genuinely non-periodic motion (multi-rate: prism ring + orbs, wind
      // fields): no lag is a real loop, so bake a SHORT window at a high
      // frame rate — continuous 12 fps motion with a seam every 2 s beats a
      // long mushy loop.
      if (best.d > maxPct * 0.35) return { period: 2000, maxPct, residual: best.d, nonPeriodic: true }
      return { period: best.p, maxPct, residual: best.d }
    }, type, level, stepMs, spanMs, maxPeriodMs, CELL)

  // What dynamic fields does this type's draw fn actually READ? A Proxy stub
  // records every access, so a NEW animation driver added to the renderer
  // can never silently bake incomplete — it shows up as "uncovered".
  const auditStateReads = (type, level) => page.evaluate((type, level) => {
    const B = window.__clashBake
    const reads = new Set()
    const base = {
      type, level, health: 100, maxHealth: 100, owner: 'PLAYER', gridX: 0, gridY: 0,
      ballistaAngle: 0.4, ballistaTargetAngle: 0.4, idleTargetAngle: 0.4,
      ballistaStringTension: 0, ballistaBoltLoaded: true, cannonRecoilOffset: 0,
      isFiring: false, lastFireTime: 500, teslaCharging: false, teslaChargeStart: 0,
      teslaCharged: false, frostfallProjectileActive: false, fillLevel: 1,
      doorOpen: 0, isGate: false, crewedUntil: 0
    }
    const proxy = new Proxy(base, { get: (t, k) => { if (typeof k === 'string') reads.add(k); return t[k] } })
    const g = B.scene.make.graphics({ x: 0, y: 0 }, false)
    try {
      B.drawBuildingVisual({ graphics: g, type, gridX: 0, gridY: 0, alpha: 1, building: proxy, time: 1234, skipBase: true })
    } catch { /* audit only */ }
    g.destroy()
    return [...reads]
  }, type, level)

  // ---- roster ----
  const roster = await page.evaluate(() => {
    const B = window.__clashBake
    return Object.entries(B.BUILDING_DEFINITIONS).map(([type, def]) => ({
      type,
      route: B.BUILDING_VISUAL_CATALOG[type]?.route ?? 'generic',
      width: def.width, height: def.height,
      maxLevel: def.maxLevel ?? def.levels?.length ?? 1
    }))
  })
  let unitList = UNITS
  if (UNITS.length === 1 && UNITS[0] === 'all') {
    unitList = roster.filter(r => r.route !== 'generic' && r.type !== 'wall').map(r => r.type)
  }

  const manifests = {}
  const bakedData = {}
  const ambientCache = {} // type → measured idle period ms (null = static)
  // ov-key → stub field, for the state-coverage audit.
  const OV_FIELD = {
    fireAge: 'lastFireTime', tension: 'ballistaStringTension', bolt: 'ballistaBoltLoaded',
    recoil: 'cannonRecoilOffset', chargeAge: 'teslaCharging', charged: 'teslaCharged',
    projectileActive: 'frostfallProjectileActive', fillLevel: 'fillLevel',
    doorOpen: 'doorOpen', isGate: 'isGate', jukeboxPlaying: null, timeAt: null
  }
  // Fields that are deliberately NOT swept (identity, sim bookkeeping, or
  // runtime-overlay drivers like the mine's visiting-crew flag).
  const AUDIT_IGNORE = new Set([
    'type', 'level', 'health', 'maxHealth', 'owner', 'gridX', 'gridY', 'id',
    'upgradingTo', 'upgradeEndsAt', 'builtAt', 'isDestroyed', 'lockedTargetId',
    'ballistaTargetAngle', 'idleTargetAngle', 'isFiring', 'teslaChargeStart',
    'doorOpenUntil', 'crewedUntil', 'wallConnections',
    'isGate' // walls: gates ARE swept, as the mNS_gate/mEW_gate variants
  ])
  const sheetFrom = (frames) => page.evaluate(async (frames) => {
    const imgs = []
    for (const f of frames) {
      const img = new Image()
      await new Promise(res => { img.onload = res; img.src = f })
      imgs.push(img)
    }
    const cols = Math.min(10, imgs.length)
    const rows = Math.ceil(imgs.length / cols)
    const cw = Math.max(...imgs.map(i => i.width)) * 2 + 6
    const ch = Math.max(...imgs.map(i => i.height)) * 2 + 6
    const sc = document.createElement('canvas')
    sc.width = cols * cw; sc.height = rows * ch
    const sx = sc.getContext('2d')
    sx.fillStyle = '#31363f'; sx.fillRect(0, 0, sc.width, sc.height)
    sx.imageSmoothingEnabled = false
    imgs.forEach((im, i) => sx.drawImage(im, (i % cols) * cw + 3, Math.floor(i / cols) * ch + 3, im.width * 2, im.height * 2))
    return sc.toDataURL('image/png')
  }, frames)

  const bakeBuilding = async (type, wallVariants = null) => {
    const info = roster.find(r => r.type === type)
    if (!info) { console.warn(`skip ${type}: not in BUILDING_DEFINITIONS`); return }
    const levels = LEVELS ?? Array.from({ length: info.maxLevel }, (_, i) => i + 1)
    const nAngles = ANGLES_ENV ?? (ROTATING.has(type) ? 16 : 1)
    const angleList = Array.from({ length: nAngles }, (_, i) => (i / nAngles) * Math.PI * 2)
    const dir = join(OUT_ROOT, 'buildings', type)
    mkdirSync(dir, { recursive: true })
    manifests[type] = { cellWorldPx: CELL, angles: nAngles, levels: {} }
    bakedData[type] = {}
    const plan = { ...(BUILDING_STATES[type] ?? {}) }

    // State-coverage audit: every dynamic field the draw fn READS must be
    // swept by a plan state, the aim-angle sweep, or explicitly ignored.
    // Known fields SELF-HEAL (the sweep is added automatically); anything
    // truly novel is a loud warning for the author.
    const reads = await auditStateReads(type, levels[levels.length - 1])
    if (reads.includes('doorOpen') && !plan.door) plan.door = [{ doorOpen: 0.5 }, { doorOpen: 1 }]
    if (reads.includes('fillLevel') && !plan.fill) plan.fill = [{ fillLevel: 0 }, { fillLevel: 0.34 }, { fillLevel: 0.67 }]
    if (reads.includes('lastFireTime') && !plan.fire) plan.fire = [0, 90, 200, 380, 600].map(a => ({ fireAge: a }))
    if (reads.includes('frostfallProjectileActive') && !plan.fire) plan.fire = [{ fireAge: 0, projectileActive: true }, { fireAge: 600, projectileActive: false }]
    const covered = new Set([
      ...(nAngles > 1 ? ['ballistaAngle'] : []),
      ...Object.values(plan).flatMap(seq => seq.flatMap(ov => Object.keys(ov).map(k => OV_FIELD[k]).filter(Boolean)))
    ])
    const uncovered = reads.filter(k => !covered.has(k) && !AUDIT_IGNORE.has(k))
    if (uncovered.length > 0) {
      console.warn(`COVERAGE WARNING ${type}: draw fn reads [${uncovered.join(', ')}] with no baked state sweep`)
    }

    for (const level of levels) {
      const variants = wallVariants ?? [null]
      for (const wn of variants) {
        const vtag = wn ? `_${wn.tag}` : ''

        // Ambient motion discovery (static buildings, once per type): probe
        // the idle pose across 8 s, autocorrelate the frame signatures, and
        // measure the true loop period.
        let idleTimes = [1000]
        let loopMs = null
        if (nAngles === 1 && !wn) {
          if (!(type in ambientCache)) {
            const probe = await probeAmbient(type, level, AMBIENT_PROBE.stepMs, AMBIENT_PROBE.spanMs, AMBIENT_PROBE.maxPeriodMs)
            ambientCache[type] = probe.period
            console.log(probe.period
              ? `ambient ${type}: motion (peak ${probe.maxPct.toFixed(1)}% texels), period ≈ ${probe.period} ms (residual ${probe.residual.toFixed(2)}%)`
              : `ambient ${type}: static (peak ${probe.maxPct.toFixed(2)}% texels)`)
          }
          const period = ambientCache[type]
          if (period) {
            const n = ambientFrameCount(period)
            idleTimes = Array.from({ length: n }, (_, k) => 1000 + Math.round(k * period / n))
            loopMs = period
          }
        }

        // Build the job list: ground + per-angle idle(+loop) + per-angle states.
        const jobs = [{ pass: 'ground', angle: angleList[0], ov: wn?.isGate ? { isGate: true } : {} }]
        const index = [] // parallel to jobs[1:]: {state, angleIdx, frameIdx, ov}
        for (let a = 0; a < nAngles; a++) {
          idleTimes.forEach((t, k) => {
            jobs.push({ pass: 'body', angle: angleList[a], ov: { timeAt: t, ...(wn?.isGate ? { isGate: true } : {}) } })
            index.push({ state: 'idle', a, k, ov: { timeAt: t } })
          })
          for (const [state, seq] of Object.entries(plan)) {
            seq.forEach((ov, k) => {
              jobs.push({ pass: 'body', angle: angleList[a], ov: { ...ov, ...(wn?.isGate ? { isGate: true } : {}) } })
              index.push({ state, a, k, ov })
            })
          }
        }
        const frames = await bakeBuildingBatch(type, level, jobs, wn?.neighbors ?? null)

        const entry = { states: {} }
        const store = bakedData[type][`${level}${vtag}`] = { states: {} }
        if (frames[0]) {
          const name = `${type}_L${level}${vtag}_ground.png`
          write64(join(dir, name), frames[0].png)
          entry.ground = { file: name, ...frames[0].meta }
          store.ground = frames[0].png
        }
        index.forEach((ix, i) => {
          const f = frames[i + 1]
          if (!f) return
          const aTag = nAngles === 1 ? '' : `_a${String(ix.a).padStart(2, '0')}`
          const name = `${type}_L${level}${vtag}_${ix.state}${ix.k}${aTag}.png`
          write64(join(dir, name), f.png)
          entry.states[ix.state] = entry.states[ix.state] ?? {
            angles: nAngles, frames: Array.from({ length: nAngles }, () => []),
            ...(ix.state === 'idle' && loopMs ? { loopMs, loopExact: false } : {})
          }
          entry.states[ix.state].frames[ix.a].push({ file: name, ...f.meta, ov: ix.ov })
          store.states[ix.state] = store.states[ix.state] ?? Array.from({ length: nAngles }, () => [])
          store.states[ix.state][ix.a].push(f.png)
        })
        if (wn) {
          manifests[type].levels[level] = manifests[type].levels[level] ?? { variants: {} }
          manifests[type].levels[level].variants[wn.tag] = entry
        } else {
          manifests[type].levels[level] = entry
        }
        const states = Object.entries(entry.states).map(([s, v]) => `${s}×${v.frames[0].length}`).join(' ')
        console.log(`baked ${type} L${level}${vtag}: ${nAngles} angles · ${states}${loopMs ? ' · ambient loop' : ''}`)
      }
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifests[type], null, 2))
  }

  for (const type of unitList) await bakeBuilding(type)

  // ---- walls: 16 neighbor topologies (+ gate variants on straight runs) ----
  const wantWalls = process.env.WALLS === '1' || (UNITS.length === 1 && UNITS[0] === 'all')
  if (wantWalls && roster.some(r => r.type === 'wall')) {
    const masks = Array.from({ length: 16 }, (_, m) => ({
      tag: `m${['N', 'E', 'S', 'W'].filter((_, b) => m & (1 << b)).join('') || '0'}`,
      neighbors: { nN: !!(m & 1), nE: !!(m & 2), nS: !!(m & 4), nW: !!(m & 8), owner: 'PLAYER' }
    }))
    masks.push(
      { tag: 'mNS_gate', isGate: true, neighbors: { nN: true, nE: false, nS: true, nW: false, owner: 'PLAYER' } },
      { tag: 'mEW_gate', isGate: true, neighbors: { nN: false, nE: true, nS: false, nW: true, owner: 'PLAYER' } }
    )
    await bakeBuilding('wall', masks)
  }

  // ---- wrecks: rubble ground+body per building type/level ----
  if (WANT_WRECKS) {
    const bakeWreck = (type, level, w, h) => page.evaluate(async (type, level, w, h, cell) => {
      const B = window.__clashBake
      const scene = B.scene
      const M = 60 + Math.max(w, h) * 22
      const minX = -((h * B.TILE_WIDTH) / 2) - M
      const maxX = ((w * B.TILE_WIDTH) / 2) + M
      const minY = -120 - Math.max(w, h) * 16
      const maxY = (w + h) * (B.TILE_HEIGHT / 2) + 60
      const W = Math.ceil(maxX - minX), H = Math.ceil(maxY - minY)
      const centerWorld = { x: (w - h) * (B.TILE_WIDTH / 4), y: (w + h) * (B.TILE_HEIGHT / 4) }
      const gBody = scene.make.graphics({ x: 0, y: 0 }, false)
      const gBase = scene.make.graphics({ x: 0, y: 0 }, false)
      // fireIntensity 0: flames/smolder are runtime FX, the wreck bakes clean.
      B.WreckRenderer.drawWreck(gBody, 0, 0, w, h, type, level, 1000, 0, gBase)
      const capture = async (g) => {
        const rt = scene.make.renderTexture({ x: 0, y: 0, width: W, height: H }, false)
        rt.draw(g, -minX, -minY)
        const dataURL = await new Promise(res => rt.snapshot(img => res(img.src)))
        rt.destroy()
        const img = new Image()
        await new Promise(res => { img.onload = res; img.src = dataURL })
        const cv = document.createElement('canvas')
        cv.width = W; cv.height = H
        const ctx = cv.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0)
        const data = ctx.getImageData(0, 0, W, H).data
        const tw = Math.floor(W / cell), th = Math.floor(H / cell)
        const tex = new Uint8ClampedArray(tw * th * 4)
        for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
          const sx = Math.min(W - 1, Math.floor((i + 0.5) * cell))
          const sy = Math.min(H - 1, Math.floor((j + 0.5) * cell))
          const s = (sy * W + sx) * 4, d = (j * tw + i) * 4
          tex[d] = data[s]; tex[d + 1] = data[s + 1]; tex[d + 2] = data[s + 2]
          // Alpha snap: AA edge texels either commit (solid) or vanish — hard
          // binary silhouettes, no translucent halo around any sprite.
          tex[d + 3] = data[s + 3] < 128 ? 0 : 255
        }
        let x0 = tw, y0 = th, x1 = -1, y1 = -1
        for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
          if (tex[(j * tw + i) * 4 + 3] > 8) {
            if (i < x0) x0 = i; if (i > x1) x1 = i
            if (j < y0) y0 = j; if (j > y1) y1 = j
          }
        }
        if (x1 < 0) return null
        const cw = x1 - x0 + 1, ch = y1 - y0 + 1
        const oc = document.createElement('canvas')
        oc.width = cw; oc.height = ch
        const octx = oc.getContext('2d')
        const od = octx.createImageData(cw, ch)
        for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
          const s = ((j + y0) * tw + (i + x0)) * 4, d = (j * cw + i) * 4
          od.data[d] = tex[s]; od.data[d + 1] = tex[s + 1]; od.data[d + 2] = tex[s + 2]; od.data[d + 3] = tex[s + 3]
        }
        octx.putImageData(od, 0, 0)
        const cropLeftWorld = { x: minX + x0 * cell, y: minY + y0 * cell }
        return {
          png: oc.toDataURL('image/png'),
          meta: {
            texelW: cw, texelH: ch, cellWorldPx: cell,
            originX: (centerWorld.x - cropLeftWorld.x) / (cw * cell),
            originY: (centerWorld.y - cropLeftWorld.y) / (ch * cell)
          }
        }
      }
      const body = await capture(gBody)
      const ground = await capture(gBase)
      gBody.destroy(); gBase.destroy()
      return { body, ground }
    }, type, level, w, h, CELL)

    for (const info of roster) {
      if (info.route === 'generic') continue
      const dir = join(OUT_ROOT, 'wrecks', info.type)
      mkdirSync(dir, { recursive: true })
      const man = { cellWorldPx: CELL, levels: {} }
      const levels = LEVELS ?? Array.from({ length: info.maxLevel }, (_, i) => i + 1)
      for (const level of levels) {
        const res = await bakeWreck(info.type, level, info.width, info.height)
        const entry = {}
        for (const pass of ['ground', 'body']) {
          if (!res[pass]) continue
          const name = `${info.type}_L${level}_wreck_${pass}.png`
          write64(join(dir, name), res[pass].png)
          entry[pass] = { file: name, ...res[pass].meta }
        }
        man.levels[level] = entry
      }
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(man, null, 2))
      console.log(`baked wreck ${info.type}: L1..L${levels[levels.length - 1]}`)
    }
  }

  // ---- obstacles: 16 hash-bucket variants per type (+ sway loops) ----
  // Obstacle variety comes from FNV(id): every derived bit (variant, size
  // jitter, egg roll, flip) is a function of one hash, so baking one real id
  // per hash-bucket yields authentic looks; the runtime maps its instance id
  // → hash → bucket → sprite. Sway is probed like building ambient motion.
  const WANT_OBSTACLES = process.env.OBSTACLES === '1' || (UNITS.length === 1 && UNITS[0] === 'all')
  if (WANT_OBSTACLES) {
    const OB_BUCKETS = 16
    const obTypes = await page.evaluate(() => Object.keys(window.__clashBake.OBSTACLE_DEFINITIONS))
    for (const type of obTypes) {
      const dir = join(OUT_ROOT, 'obstacles', type)
      mkdirSync(dir, { recursive: true })
      const result = await page.evaluate(async (type, buckets, cell) => {
        const B = window.__clashBake
        const scene = B.scene
        const hashId = (id) => B.ObstacleRenderer.hashId ? B.ObstacleRenderer.hashId(id) : (() => {
          // FNV-1a fallback identical to ObstacleRenderer.hashId
          let h = 2166136261
          for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) }
          return h >>> 0
        })()
        // Find one id per bucket.
        const ids = new Array(buckets).fill(null)
        for (let k = 0; k < 4000 && ids.some(v => v === null); k++) {
          const id = `bake:${type}:${k}`
          const b = hashId(id) % buckets
          if (ids[b] === null) ids[b] = id
        }
        const M = 90
        const minX = -64 - M, maxX = 64 + M, minY = -150, maxY = 64 + 40
        const W = maxX - minX, H = maxY - minY
        const rt = scene.make.renderTexture({ x: 0, y: 0, width: W, height: H }, false)
        const capture = async (id, time) => {
          const g = scene.make.graphics({ x: 0, y: 0 }, false)
          B.ObstacleRenderer.drawObstacle(g, { type, gridX: 0, gridY: 0, animOffset: (hashId(id) % 100) / 100 * Math.PI * 2, id }, time)
          rt.clear(); rt.draw(g, -minX, -minY)
          const dataURL = await new Promise(res => rt.snapshot(img => res(img.src)))
          g.destroy()
          const img = new Image()
          await new Promise(res => { img.onload = res; img.src = dataURL })
          const cv = document.createElement('canvas')
          cv.width = W; cv.height = H
          const ctx = cv.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(img, 0, 0)
          const data = ctx.getImageData(0, 0, W, H).data
          const tw = Math.floor(W / cell), th = Math.floor(H / cell)
          const tex = new Uint8ClampedArray(tw * th * 4)
          for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
            const sx = Math.min(W - 1, Math.floor((i + 0.5) * cell))
            const sy = Math.min(H - 1, Math.floor((j + 0.5) * cell))
            const s = (sy * W + sx) * 4, d = (j * tw + i) * 4
            tex[d] = data[s]; tex[d + 1] = data[s + 1]; tex[d + 2] = data[s + 2]
          // Alpha snap: AA edge texels either commit (solid) or vanish — hard
          // binary silhouettes, no translucent halo around any sprite.
          tex[d + 3] = data[s + 3] < 128 ? 0 : 255
          }
          let x0 = tw, y0 = th, x1 = -1, y1 = -1
          for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
            if (tex[(j * tw + i) * 4 + 3] > 8) {
              if (i < x0) x0 = i; if (i > x1) x1 = i
              if (j < y0) y0 = j; if (j > y1) y1 = j
            }
          }
          if (x1 < 0) return null
          const cw = x1 - x0 + 1, ch = y1 - y0 + 1
          const oc = document.createElement('canvas')
          oc.width = cw; oc.height = ch
          const octx = oc.getContext('2d')
          const od = octx.createImageData(cw, ch)
          for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
            const s = ((j + y0) * tw + (i + x0)) * 4, d = (j * cw + i) * 4
            od.data[d] = tex[s]; od.data[d + 1] = tex[s + 1]; od.data[d + 2] = tex[s + 2]; od.data[d + 3] = tex[s + 3]
          }
          octx.putImageData(od, 0, 0)
          const cropLeftWorld = { x: minX + x0 * cell, y: minY + y0 * cell }
          return {
            png: oc.toDataURL('image/png'),
            meta: { texelW: cw, texelH: ch, cellWorldPx: cell },
            crop: cropLeftWorld
          }
        }
        // Obstacle anchor: iso center of its 1×1 tile at grid (0,0) = (0, 16).
        const anchor = { x: 0, y: B.TILE_HEIGHT / 2 }
        // Motion probe on bucket 0.
        const probeTimes = [1000, 1750, 2500, 3250, 4000, 4750, 5500]
        const probes = []
        for (const t of probeTimes) probes.push(await capture(ids[0], t))
        const moving = new Set(probes.filter(Boolean).map(p => p.png)).size > 1
        const frames = moving ? 8 : 1
        const loopMs = moving ? 3000 : null
        const out = { buckets: [], loopMs }
        for (let b = 0; b < buckets; b++) {
          if (!ids[b]) { out.buckets.push(null); continue }
          const frameList = []
          for (let f = 0; f < frames; f++) {
            const t = 1000 + Math.round(f * (loopMs ?? 0) / frames)
            const cap = await capture(ids[b], t)
            if (!cap) continue
            frameList.push({
              png: cap.png,
              meta: {
                texelW: cap.meta.texelW, texelH: cap.meta.texelH, cellWorldPx: cell,
                originX: (anchor.x - cap.crop.x) / (cap.meta.texelW * cell),
                originY: (anchor.y - cap.crop.y) / (cap.meta.texelH * cell)
              }
            })
          }
          out.buckets.push({ id: ids[b], frames: frameList })
        }
        rt.destroy()
        return out
      }, type, OB_BUCKETS, CELL)

      const man = { cellWorldPx: CELL, buckets: OB_BUCKETS, loopMs: result.loopMs, variants: [] }
      result.buckets.forEach((bk, b) => {
        if (!bk) { man.variants.push(null); return }
        const frames = bk.frames.map((f, k) => {
          const name = `${type}_b${String(b).padStart(2, '0')}_${k}.png`
          write64(join(dir, name), f.png)
          return { file: name, ...f.meta }
        })
        man.variants.push({ frames })
      })
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(man, null, 2))
      console.log(`baked obstacle ${type}: ${OB_BUCKETS} variants × ${result.loopMs ? 8 : 1} frames${result.loopMs ? ' (sway loop)' : ''}`)
    }
  }

  // ---- troops ----
  let troopList = TROOPS
  if (TROOPS.length === 1 && TROOPS[0] === 'all') troopList = Object.keys(TROOP_PARAMS)
  const bakeTroopBatch = (type, level, owner, params, frames, dirs) => page.evaluate(
    async (type, level, owner, params, frames, dirs, cell) => {
      const B = window.__clashBake
      const scene = B.scene
      const big = params.big || type === 'giant' || type === 'golem'
      const minX = big ? -56 : -32, maxX = big ? 56 : 32
      const minY = big ? -66 : -38, maxY = big ? 28 : 20
      const W = maxX - minX, H = maxY - minY
      const rt = scene.make.renderTexture({ x: 0, y: 0, width: W, height: H }, false)
      const out = []
      const cells = []
      for (const dirIdx of dirs) {
        const facing = (dirIdx / params.dirs) * Math.PI * 2
        for (const f of frames) {
          const g = scene.make.graphics({ x: 0, y: 0 }, false)
          B.TroopRenderer.drawTroopVisual(
            g, type, owner, facing, f.isMoving,
            f.slamOffset ?? 0, 0, f.mortarRecoil ?? 0,
            f.deactivated === true, f.phalanxSpearOffset ?? 0,
            level, f.time, f.attackAge, params.delay
          )
          rt.clear()
          rt.draw(g, -minX, -minY)
          const dataURL = await new Promise(res => rt.snapshot(img => res(img.src)))
          g.destroy()
          const img = new Image()
          await new Promise(res => { img.onload = res; img.src = dataURL })
          const cv = document.createElement('canvas')
          cv.width = W; cv.height = H
          const ctx = cv.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(img, 0, 0)
          const data = ctx.getImageData(0, 0, W, H).data
          const tw = Math.floor(W / cell), th = Math.floor(H / cell)
          const tex = new Uint8ClampedArray(tw * th * 4)
          for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
            const sx = Math.min(W - 1, Math.floor((i + 0.5) * cell))
            const sy = Math.min(H - 1, Math.floor((j + 0.5) * cell))
            const s = (sy * W + sx) * 4, d = (j * tw + i) * 4
            tex[d] = data[s]; tex[d + 1] = data[s + 1]; tex[d + 2] = data[s + 2]
          // Alpha snap: AA edge texels either commit (solid) or vanish — hard
          // binary silhouettes, no translucent halo around any sprite.
          tex[d + 3] = data[s + 3] < 128 ? 0 : 255
          }
          let x0 = tw, y0 = th, x1 = -1, y1 = -1
          for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
            if (tex[(j * tw + i) * 4 + 3] > 8) {
              if (i < x0) x0 = i; if (i > x1) x1 = i
              if (j < y0) y0 = j; if (j > y1) y1 = j
            }
          }
          if (x1 < 0) { out.push(null); continue }
          const cw = x1 - x0 + 1, ch = y1 - y0 + 1
          const oc = document.createElement('canvas')
          oc.width = cw; oc.height = ch
          const octx = oc.getContext('2d')
          const od = octx.createImageData(cw, ch)
          for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
            const s = ((j + y0) * tw + (i + x0)) * 4, d = (j * cw + i) * 4
            od.data[d] = tex[s]; od.data[d + 1] = tex[s + 1]; od.data[d + 2] = tex[s + 2]; od.data[d + 3] = tex[s + 3]
          }
          octx.putImageData(od, 0, 0)
          cells.push({ oc, dirIdx })
          const cropLeftWorld = { x: minX + x0 * cell, y: minY + y0 * cell }
          out.push({
            dirIdx, facing, state: f.state, frame: f.frame,
            png: oc.toDataURL('image/png'),
            meta: {
              texelW: cw, texelH: ch, cellWorldPx: cell,
              originX: (0 - cropLeftWorld.x) / (cw * cell),
              originY: (0 - cropLeftWorld.y) / (ch * cell),
              time: f.time, attackAge: f.attackAge, isMoving: f.isMoving,
              ...(f.slamOffset != null ? { slamOffset: f.slamOffset } : {}),
              ...(f.phalanxSpearOffset != null ? { phalanxSpearOffset: f.phalanxSpearOffset } : {}),
              ...(f.mortarRecoil != null ? { mortarRecoil: f.mortarRecoil } : {}),
              ...(f.deactivated ? { deactivated: true } : {})
            }
          })
        }
      }
      rt.destroy()
      let sheet = null
      if (cells.length > 0) {
        const cols = frames.length
        const cw = Math.max(...cells.map(c => c.oc.width)) * 3 + 6
        const ch = Math.max(...cells.map(c => c.oc.height)) * 3 + 6
        const sc = document.createElement('canvas')
        sc.width = cols * cw; sc.height = dirs.length * ch
        const sx = sc.getContext('2d')
        sx.fillStyle = '#31363f'; sx.fillRect(0, 0, sc.width, sc.height)
        sx.imageSmoothingEnabled = false
        let idx = 0
        for (let r = 0; r < dirs.length; r++) for (let c = 0; c < cols; c++, idx++) {
          const cellC = cells[idx]
          if (!cellC) continue
          sx.drawImage(cellC.oc, c * cw + 3, r * ch + 3, cellC.oc.width * 3, cellC.oc.height * 3)
        }
        sheet = sc.toDataURL('image/png')
      }
      return { out, sheet }
    }, type, level, owner, params, frames, dirs, CELL)

  for (const type of troopList) {
    const params = TROOP_PARAMS[type]
    if (!params) { console.warn(`skip troop ${type}: no params`); continue }
    const dir = join(OUT_ROOT, 'troops', type)
    mkdirSync(dir, { recursive: true })
    // idle: the breath is sin(time/640) → exact loop over 2π·640 ms.
    const frames = Array.from({ length: IDLE_FRAMES }, (_, k) => ({
      state: 'idle', frame: k, time: 1000 + Math.round(k * IDLE_BREATH_MS / IDLE_FRAMES), attackAge: -1, isMoving: false
    }))
    for (let k = 0; k < WALK_FRAMES; k++) {
      frames.push({ state: 'walk', frame: k, time: Math.round(k * params.stride / WALK_FRAMES), attackAge: -1, isMoving: true })
    }
    if (params.attackDriver) {
      params.attackDriver.values.forEach((v, k) => {
        frames.push({ state: 'attack', frame: k, time: 1000, attackAge: -1, isMoving: false, [params.attackDriver.key]: v })
      })
    } else if (params.attack !== false && params.delay > 0) {
      attackAges(params).forEach((age, k) => {
        frames.push({
          state: 'attack', frame: k, time: 1000, attackAge: Math.round(age), isMoving: false,
          ...(params.recoilSeq ? { mortarRecoil: params.recoilSeq[k] ?? 0 } : {})
        })
      })
    }
    if (params.deactivated) {
      frames.push({ state: 'deactivated', frame: 0, time: 1000, attackAge: -1, isMoving: false, deactivated: true })
    }
    const dirs = Array.from({ length: params.dirs }, (_, i) => i)
    const troopManifest = { cellWorldPx: CELL, params: { ...params, idleLoopMs: IDLE_BREATH_MS }, levels: {} }
    for (const level of TROOP_LEVELS) {
      troopManifest.levels[level] = {}
      for (const owner of ['PLAYER', 'ENEMY']) {
        const tag = owner === 'PLAYER' ? 'P' : 'E'
        const { out: baked, sheet } = await bakeTroopBatch(type, level, owner, params, frames, dirs)
        const byDir = dirs.map(d => ({ dir: d, facing: (d / params.dirs) * Math.PI * 2, frames: [] }))
        baked.forEach(b => {
          if (!b) return
          const name = `${type}_L${level}_${tag}_d${b.dirIdx}_${b.state}${b.frame}.png`
          write64(join(dir, name), b.png)
          byDir[b.dirIdx].frames.push({ file: name, state: b.state, frame: b.frame, ...b.meta })
        })
        troopManifest.levels[level][tag] = byDir
        if (sheet && level === TROOP_LEVELS[0] && owner === 'PLAYER') {
          write64(join(SHOTS, `bake-sheet-troop-${type}-L${level}.png`), sheet)
        }
        console.log(`baked troop ${type} L${level} ${tag}: ${baked.filter(Boolean).length} frames (${params.dirs} dirs)`)
      }
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(troopManifest, null, 2))
  }

  // ---- fire-sequence review sheets for the rotating defenses ----
  for (const type of unitList.filter(t => ROTATING.has(t))) {
    const lv = Object.keys(manifests[type]?.levels ?? {}).pop()
    const store = bakedData[type]?.[lv]
    if (!store?.states?.fire) continue
    const mid = Math.floor((manifests[type].angles ?? 16) / 2)
    const sheet = await sheetFrom([...store.states.idle[mid], ...store.states.fire[mid]])
    write64(join(SHOTS, `bake-sheet-${type}-fire-L${lv}.png`), sheet)
  }

  // ---- Fidelity verification (unchanged contract; idle frame 0) ----
  if (VERIFY && UNITS.length > 0 && UNITS[0] !== 'all' && bakedData[UNITS[0]]) {
    console.log('VERIFY: see earlier pilot metrics; rest/crawl math unchanged in v3.')
  }
} finally {
  await browser.close()
}
console.log('done')
