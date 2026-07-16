// Depth-layering regression: stages the wall-overlap matrix deterministically
// (a level-3 wall row + corner + east column), walks representative
// characters (warrior, 16-dir golem, davincitank, and a home
// villager) through sub-tile offsets behind and in front of segments, and
// PIXEL-asserts the occluder-band contract from docs/RENDERING_AND_DEPTH.md:
// no character pixel may render over a wall crest while the character's
// anchor row is behind the wall's tile-center row, and a character in front
// MUST paint over the crest. Also asserts the building band end-to-end
// (town-hall roof NE band, 2x2 tower / 1x1 jukebox north-tile inversions)
// through live runtime depths. Non-zero exit on any violation.
//
// Technique: Phaser renderer.snapshot -> per-segment OPAQUE-BODY masks
// (the wall body atlas frame, alpha > 200, projected through the camera —
// never a hide-the-carrier diff, which would include the translucent
// ground-shadow decal characters legitimately show through), then each
// staged case is diffed against the clean plate inside the union of the
// masks of every segment the character must be occluded by.
//
// Also asserts (2026-07 additions):
// - the SILHOUETTE DEAD ZONE contract: ambient tile pickers never return a
//   stop inside a building's dead zone and a walk arrival there immediately
//   walks out (a stationary figure just behind a building pokes above the
//   drawn roofline and reads as perched on the roof);
// - CONSTRUCTION SCAFFOLD suppression: an upgrade site touching a building
//   in front of it never draws poles/rails across that building's roofline.
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = new URL('./shots/', import.meta.url).pathname
const TOKEN_CACHE = new URL('./.shared-device-token.json', import.meta.url).pathname
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const RUN = `layering-${Date.now().toString(36)}`

const WALL_LEVEL = 3
// Wall "U": one row with a real SW corner and a real east column, so the
// matrix covers straight-north, side (east-west) and diagonal approaches.
const ROW = { y: 12, x0: 6, x1: 16 }
const COLS = [{ x: 6, y0: 13, y1: 16 }, { x: 16, y0: 13, y1: 16 }]
// Buildings sit far enough south that no ambient-animated pixel (chimney
// smoke, waving hall banner) can enter any wall-matrix crop.
const HALL = { x: 11, y: 20 } // 3x3 town hall — roof NE band checks
const TOWER = { x: 5, y: 19 } // 2x2 watchtower — north-tile inversion checks
const JUKEBOX = { x: 21, y: 21 } // 1x1 — north-tile inversion checks
const CANNON = { x: 13, y: 19 } // 1x1 upgrading against the hall's north face
// Character-anchor offsets in ROW units relative to the wall tile center:
// negative = behind (north/west), positive = in front.
const OFFSETS = [-1.0, -0.6, -0.3, -0.15, -0.05, 0.05, 0.3]
// A segment must occlude the character when its center row is beyond this
// margin behind the character row (the occluder band flips within ±0.03).
const ROW_MARGIN = 0.03
const BEHIND_MAX_PX = 2 // tolerated diff noise on must-stay-clean crests
const FRONT_MIN_PX = 10 // minimum crest pixels a front character must cover

const APPROACHES = {
  rowN: {
    cam: [11.5, 12.5],
    target: [11, 12],
    segs: [[9, 12], [10, 12], [11, 12], [12, 12], [13, 12]],
    place: d => [11.5, 12.5 + d],
    troops: ['warrior', 'golem', 'davincitank']
  },
  colE: {
    cam: [16.5, 14.5],
    target: [16, 14],
    segs: [[16, 12], [16, 13], [16, 14], [16, 15], [16, 16]],
    place: d => [16.5 + d, 14.5],
    troops: ['warrior', 'golem']
  },
  corner: {
    cam: [6.5, 12.5],
    target: [6, 12],
    segs: [[6, 12], [7, 12], [8, 12], [6, 13], [6, 14]],
    place: d => [6.5 + d / 2, 12.5 + d / 2],
    troops: ['golem', 'davincitank']
  }
}

// Live-depth band checks: villager staged at `at` must sort under/over the
// named building's runtime graphics depth. These are the exact defect
// geometries (translated to this fixture): the town-hall NE roof band, the
// SW-front edge (the case a front-corner anchor would break), and the
// walkable tile directly north of a 2x2 / 1x1 building.
const BAND_CHECKS = [
  { name: 'hall-NE-band-behind', type: 'town_hall', bx: HALL.x, by: HALL.y, at: [14.4, 19.5], expect: 'under' },
  { name: 'hall-N-behind', type: 'town_hall', bx: HALL.x, by: HALL.y, at: [12.5, 19.7], expect: 'under' },
  { name: 'hall-S-front', type: 'town_hall', bx: HALL.x, by: HALL.y, at: [12.5, 23.3], expect: 'over' },
  { name: 'hall-SW-front-edge', type: 'town_hall', bx: HALL.x, by: HALL.y, at: [11.3, 23.05], expect: 'over' },
  { name: 'hall-E-front', type: 'town_hall', bx: HALL.x, by: HALL.y, at: [14.6, 21.5], expect: 'over' },
  { name: 'tower-N-approach-tile', type: 'watchtower', bx: TOWER.x, by: TOWER.y, at: [5.35, 18.82], expect: 'under' },
  { name: 'tower-NE-band', type: 'watchtower', bx: TOWER.x, by: TOWER.y, at: [6.9, 18.8], expect: 'under' },
  { name: 'tower-S-front', type: 'watchtower', bx: TOWER.x, by: TOWER.y, at: [6.0, 21.4], expect: 'over' },
  { name: 'jukebox-N-tile', type: 'jukebox', bx: JUKEBOX.x, by: JUKEBOX.y, at: [21.5, 20.6], expect: 'under' },
  { name: 'jukebox-front', type: 'jukebox', bx: JUKEBOX.x, by: JUKEBOX.y, at: [21.5, 21.9], expect: 'over' }
]

mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const segKey = ([x, y]) => `${x},${y}`
const segRow = ([x, y]) => x + y + 1 // wall tile-center row
const mustNotTouch = (segs, charRow) => segs.filter(seg => segRow(seg) > charRow + ROW_MARGIN)

async function api(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = { raw: text } }
  if (!response.ok) {
    throw new Error(`${method} /api${path} failed (${response.status}): ${JSON.stringify(payload)}`)
  }
  return payload
}

let cachedToken = null
try { cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null } catch { /* first local run */ }
const session = await api('/auth/session', {
  method: 'POST',
  body: cachedToken ? { token: cachedToken } : {}
})
assert(session?.token, `auth/session returned no token: ${JSON.stringify(session)}`)
const token = session.token
try { writeFileSync(TOKEN_CACHE, JSON.stringify({ token })) } catch { /* cache is an optimization */ }
const authed = (path, options = {}) => api(path, { ...options, token })

function makeFixture() {
  const walls = []
  for (let x = ROW.x0; x <= ROW.x1; x++) {
    walls.push({ id: `layer_wall_${x}_${ROW.y}`, type: 'wall', gridX: x, gridY: ROW.y, level: WALL_LEVEL })
  }
  for (const col of COLS) {
    for (let y = col.y0; y <= col.y1; y++) {
      walls.push({ id: `layer_wall_${col.x}_${y}`, type: 'wall', gridX: col.x, gridY: y, level: WALL_LEVEL })
    }
  }
  return [
    { id: 'layer_hall', type: 'town_hall', gridX: HALL.x, gridY: HALL.y, level: 1 },
    { id: 'layer_tower', type: 'watchtower', gridX: TOWER.x, gridY: TOWER.y, level: 3 },
    { id: 'layer_jukebox', type: 'jukebox', gridX: JUKEBOX.x, gridY: JUKEBOX.y, level: 1 },
    // Directly north of the hall, touching its footprint: the construction-
    // scaffold suppression fixture (a fence rail/pole across the hall's NE
    // roofline was the 2026-07 "planted into the roof face" defect).
    { id: 'layer_cannon', type: 'cannon', gridX: CANNON.x, gridY: CANNON.y, level: 1 },
    ...walls
  ]
}

await authed('/attacks/active/abort', { method: 'POST', body: {} })
const world = (await authed('/world')).world
assert(world, 'GET /world returned no world')
const fixtureBuildings = makeFixture()
// A bare-lawn fixture: obstacles would sway inside the diff crops.
const saved = await authed('/world/save', {
  method: 'POST',
  body: {
    world: { ...world, buildings: fixtureBuildings, obstacles: [], wallLevel: WALL_LEVEL, revision: world.revision },
    requestId: `${RUN}-fixture`
  }
})
const savedIds = new Set((saved.world?.buildings ?? []).map(b => b.id))
for (const b of fixtureBuildings) assert(savedIds.has(b.id), `fixture building was not saved: ${b.id}`)

const failures = []
const note = line => console.log(line)

let browser = null
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(value => localStorage.setItem('clash.device.token', value), token)

  const pageErrors = []
  page.on('pageerror', error => {
    const message = String(error?.message ?? error)
    pageErrors.push(message)
    console.error('PAGE ERROR:', message)
  })

  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForFunction(
    ids => {
      const scene = window.__clashGame?.scene?.keys?.MainScene
      if (!scene) return false
      const live = new Set(scene.buildings.map(b => b.id))
      return ids.every(id => live.has(id))
    },
    { timeout: 90_000, polling: 250 },
    fixtureBuildings.map(b => b.id)
  )
  await page.waitForFunction(() => !document.querySelector('.cloud-overlay'), { timeout: 90_000, polling: 100 })

  // ---- in-page probe kit: fixed day, no weather, snapshot/diff helpers ----
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather.setWeatherOverride(0)
    const P = window.__layerProbe = { shots: {}, masks: {} }
    P.waitFrames = k => new Promise(resolve => {
      let n = 0
      const step = () => { if (++n >= k) resolve(); else requestAnimationFrame(step) }
      requestAnimationFrame(step)
    })
    P.setCam = (cx, cy, zoom) => {
      const cam = window.__clashGame.scene.keys.MainScene.cameras.main
      cam.setZoom(zoom)
      cam.centerOn((cx - cy) * 32, (cx + cy) * 16 - 14)
    }
    // Crop is taken around a WORLD tile center; vertically biased upward so
    // the crest above the tile is inside the window.
    P.capture = (name, cx, cy) => new Promise(resolve => {
      const game = window.__clashGame
      const cam = game.scene.keys.MainScene.cameras.main
      const sx = ((cx - cy) * 32 - cam.worldView.x) * cam.zoom
      const sy = ((cx + cy) * 16 - cam.worldView.y) * cam.zoom
      const x0 = Math.round(sx - 230)
      const y0 = Math.round(sy - 210)
      game.renderer.snapshot(img => {
        const canvas = document.createElement('canvas')
        canvas.width = 460
        canvas.height = 340
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, x0, y0, 460, 340, 0, 0, 460, 340)
        P.shots[name] = ctx.getImageData(0, 0, 460, 340)
        // Crop origin + camera state so callers can map crop px -> world px.
        resolve({ x0, y0, viewX: cam.worldView.x, viewY: cam.worldView.y, zoom: cam.zoom })
      })
    })
    P.changed = (A, B, i) =>
      Math.abs(A[i] - B[i]) > 12 || Math.abs(A[i + 1] - B[i + 1]) > 12 || Math.abs(A[i + 2] - B[i + 2]) > 12
    // `noiseName` drops any pixel known to flutter on its own (ambient art)
    // from the mask being built.
    P.makeMask = (allName, minusName, maskName, noiseName) => {
      const a = P.shots[allName].data
      const b = P.shots[minusName].data
      const noise = noiseName ? P.masks[noiseName] : null
      const mask = new Uint8Array(a.length / 4)
      let n = 0
      for (let i = 0; i < a.length; i += 4) {
        if (noise && noise[i >> 2]) continue
        if (P.changed(a, b, i)) { mask[i >> 2] = 1; n++ }
      }
      P.masks[maskName] = mask
      return n
    }
    P.unionMasks = (names, outName) => {
      const out = new Uint8Array(P.masks[names[0]].length)
      let n = 0
      for (const name of names) {
        const m = P.masks[name]
        for (let j = 0; j < m.length; j++) if (m[j] && !out[j]) { out[j] = 1; n++ }
      }
      P.masks[outName] = out
      return n
    }
    // Diff a staged shot against the clean plate inside the union of the
    // given segment masks; `noiseName` (a second clean plate diffed against
    // the first) subtracts any pixel that flutters on its own, so a stray
    // ambient loop can never fake a violation.
    P.diffAgainst = (allName, caseName, maskNames, noiseName) => {
      const a = P.shots[allName].data
      const b = P.shots[caseName].data
      const noise = noiseName ? P.masks[noiseName] : null
      let union = null
      if (maskNames && maskNames.length) {
        union = new Uint8Array(a.length / 4)
        for (const maskName of maskNames) {
          const mask = P.masks[maskName]
          for (let j = 0; j < mask.length; j++) if (mask[j]) union[j] = 1
        }
      }
      let n = 0
      const w = P.shots[allName].width
      let box = null
      for (let i = 0; i < a.length; i += 4) {
        const j = i >> 2
        if (union && !union[j]) continue
        if (noise && noise[j]) continue
        if (P.changed(a, b, i)) {
          n++
          const x = j % w
          const y = (j / w) | 0
          if (!box) box = { x0: x, y0: y, x1: x, y1: y }
          else {
            box.x0 = Math.min(box.x0, x)
            box.y0 = Math.min(box.y0, y)
            box.x1 = Math.max(box.x1, x)
            box.y1 = Math.max(box.y1, y)
          }
        }
      }
      return { n, box }
    }
    P.dataUrl = name => {
      const shot = P.shots[name]
      const canvas = document.createElement('canvas')
      canvas.width = shot.width
      canvas.height = shot.height
      canvas.getContext('2d').putImageData(shot, 0, 0)
      return canvas.toDataURL()
    }
    // Opaque-body mask for a wall segment, built from the baked atlas frame
    // itself (alpha > 200) projected through the camera into crop space.
    // The old hide-the-carrier diff mask silently included the wall's
    // TRANSLUCENT ground-shadow decal (a 2026-07 addition riding the carrier
    // as a second shadow image) — characters legitimately show through that
    // decal, so it produced false "over the crest" hits at the wall base.
    // Only OPAQUE BODY pixels are pixels a behind-character must never win.
    P.buildBodyMask = (maskName, wx, wy, origin) => {
      const scene = window.__clashGame.scene.keys.MainScene
      const cam = scene.cameras.main
      const cx = (wx - wy) * 32
      const cy = (wx + wy + 1) * 16
      const candidates = scene.children.list.filter(o => o.type === 'Image'
        && o.texture?.key === 'bank:buildings:wall'
        && Math.abs(o.x - cx) < 26 && Math.abs(o.y - cy) < 30)
      if (candidates.length === 0) return 0
      // Body rides above the ground decal (carrier−0.05 vs carrier−0.1).
      const body = candidates.reduce((a, b) => (a.depth >= b.depth ? a : b))
      const canvas = document.createElement('canvas')
      canvas.width = 460
      canvas.height = 340
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      const frame = body.frame
      const dw = body.displayWidth * cam.zoom
      const dh = body.displayHeight * cam.zoom
      const dx = (body.x - body.originX * body.displayWidth - cam.worldView.x) * cam.zoom - origin.x0
      const dy = (body.y - body.originY * body.displayHeight - cam.worldView.y) * cam.zoom - origin.y0
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(frame.source.image, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight, dx, dy, dw, dh)
      const data = ctx.getImageData(0, 0, 460, 340).data
      let mask = new Uint8Array(460 * 340)
      for (let j = 0; j < mask.length; j++) {
        if (data[j * 4 + 3] > 200) mask[j] = 1
      }
      // Erode 2px: the canvas NEAREST projection and the GL NEAREST render
      // disagree by up to a pixel at silhouette edges (sub-texel sampling
      // phase), so the outermost fringe of the mask can legitimately show
      // background/character colour. Real paint-overs are tens of INTERIOR
      // pixels — erosion only removes the fringe.
      const W = 460
      const H = 340
      for (let pass = 0; pass < 2; pass++) {
        const eroded = new Uint8Array(mask.length)
        for (let y = 1; y < H - 1; y++) {
          for (let x = 1; x < W - 1; x++) {
            const j = y * W + x
            if (!mask[j]) continue
            if (mask[j - 1] && mask[j + 1] && mask[j - W] && mask[j + W] &&
                mask[j - W - 1] && mask[j - W + 1] && mask[j + W - 1] && mask[j + W + 1]) {
              eroded[j] = 1
            }
          }
        }
        mask = eroded
      }
      let n = 0
      for (let j = 0; j < mask.length; j++) if (mask[j]) n++
      P.masks[maskName] = mask
      return n
    }
  })

  const waitFrames = k => page.evaluate(n => window.__layerProbe.waitFrames(n), k)
  const setCam = (cx, cy, zoom) => page.evaluate(([a, b, z]) => window.__layerProbe.setCam(a, b, z), [cx, cy, zoom])
  const capture = (name, cx, cy) => page.evaluate(([n, a, b]) => window.__layerProbe.capture(n, a, b), [name, cx, cy])

  // Park every ambient life entity far from the crops and freeze it; keep
  // one adult villager as the staged character.
  const villagerReady = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const vl = scene.villageLife
    if (!vl) return false
    const entities = vl.entities ?? []
    const hero = entities.find(e => e.kind === 'villager' && !e.child)
    if (!hero) return false
    const far = scene.time.now + 1e9
    for (const e of entities) {
      e.state = 'idle'
      e.path = null
      e.stateUntil = far
      // Clear ambient bookkeeping picked up before this freeze: a leftover
      // pendingEnterId / haulStage turns a later STAGED walk arrival into
      // enterBuilding / haul handling instead of the branch under test
      // (the dead-zone escape flaked exactly this way: the hero entered
      // the hall, state 'inside' for up to 10.5s > the 8s deadline).
      e.pendingEnterId = undefined
      e.haulStage = undefined
      e.workFaceAt = undefined
      e.workUntil = undefined
      e.workBuildingId = undefined
      // An entity caught INDOORS at parking time keeps a faded/fading gfx
      // (hideInside tween) — staged as the hero it would be invisible and
      // fail every front-cover assert. Surface it.
      e.insideId = undefined
      e.hiddenUntil = undefined
      if (e.gfx) {
        scene.tweens.killTweensOf(e.gfx)
        e.gfx.setAlpha(1)
      }
      if (e !== hero) {
        e.x = 1 + (entities.indexOf(e) % 4) * 0.5
        e.y = 23
        e.gfx?.setVisible(false)
      }
    }
    vl.__probeVillager = hero
    return true
  })
  assert(villagerReady, 'no adult villager available to stage (village life not populated?)')

  const stageVillager = ([x, y]) => page.evaluate(([vx, vy]) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const vl = scene.villageLife
    const e = vl.__probeVillager
    e.x = vx
    e.y = vy
    e.state = 'idle'
    e.path = null
    e.stateUntil = scene.time.now + 1e9
    e.lastPlaceTick = undefined
    vl.placeGfx(e)
    return { depth: e.gfx.depth, x: e.x, y: e.y }
  }, [x, y])

  const parkVillager = () => stageVillager([2.5, 23])

  // ---------------- Phase A: building band, live depths (HOME) -----------
  for (const check of BAND_CHECKS) {
    await setCam(check.at[0], check.at[1], 2.5)
    await waitFrames(2)
    const result = await page.evaluate(([type, bx, by]) => {
      const scene = window.__clashGame.scene.keys.MainScene
      const b = scene.buildings.find(v => v.type === type && v.gridX === bx && v.gridY === by)
      return b ? { depth: b.graphics.depth } : null
    }, [check.type, check.bx, check.by])
    assert(result, `${check.name}: fixture building ${check.type}@${check.bx},${check.by} missing`)
    const staged = await stageVillager(check.at)
    await waitFrames(3)
    const ok = check.expect === 'under' ? staged.depth < result.depth : staged.depth > result.depth
    note(`band ${check.name}: villager(${check.at}) depth ${staged.depth} ${check.expect} ${check.type} depth ${result.depth} -> ${ok ? 'ok' : 'FAIL'}`)
    if (!ok) failures.push(`band ${check.name}: villager depth ${staged.depth} should be ${check.expect} building depth ${result.depth}`)
  }
  await parkVillager()

  // ------------- Phase A2: villager vs wall matrix (HOME, pixels) --------
  async function runMatrix(phase, app, name, placeChar, charLabel) {
    const camKey = `${phase}:${name}`
    await setCam(app.cam[0], app.cam[1], 3)
    await waitFrames(3)
    const cropOrigin = await capture(`${camKey}:all`, app.cam[0], app.cam[1])
    // Two extra clean plates at other instants -> self-flutter (ambient)
    // noise mask, subtracted from every case diff.
    await sleep(260)
    await capture(`${camKey}:all2`, app.cam[0], app.cam[1])
    await sleep(260)
    await capture(`${camKey}:all3`, app.cam[0], app.cam[1])
    await page.evaluate(key => {
      const P = window.__layerProbe
      P.makeMask(`${key}:all`, `${key}:all2`, `${key}:n2`)
      P.makeMask(`${key}:all`, `${key}:all3`, `${key}:n3`)
      return P.unionMasks([`${key}:n2`, `${key}:n3`], `${key}:noise`)
    }, camKey).then(noisePx => note(`${camKey}: ambient noise plate ${noisePx}px`))
    for (const seg of app.segs) {
      // Segment mask = the wall body frame's OPAQUE pixels, projected into
      // the crop (never a hide-diff: that included the translucent ground
      // decal that characters legitimately show through).
      const px = await page.evaluate(([sx, sy, mask, origin]) =>
        window.__layerProbe.buildBodyMask(mask, sx, sy, origin),
      [seg[0], seg[1], `${camKey}:seg:${segKey(seg)}`, cropOrigin])
      assert(px > 150, `${camKey}: opaque-body mask for segment ${segKey(seg)} too small (${px}px) — wall sprite missing in crop?`)
    }

    for (const offset of OFFSETS) {
      const [px, py] = app.place(offset)
      const charRow = px + py
      const behindSegs = mustNotTouch(app.segs, charRow)
      const stage = await placeChar([px, py])
      await waitFrames(4)
      const shotName = `${camKey}:${charLabel}:${offset}`
      await capture(shotName, app.cam[0], app.cam[1])
      const drift = await placeCheck(charLabel)
      assert(Math.abs(drift.x - px) < 0.02 && Math.abs(drift.y - py) < 0.02,
        `${shotName}: staged character drifted to ${drift.x},${drift.y}`)
      const behind = behindSegs.length === 0 ? { n: 0, box: null } : await page.evaluate(([all, shot, maskNames, noise]) =>
        window.__layerProbe.diffAgainst(all, shot, maskNames, noise),
      [`${camKey}:all`, shotName, behindSegs.map(seg => `${camKey}:seg:${segKey(seg)}`), `${camKey}:noise`])
      // Front coverage: at +0.05 every character's body overlaps the target
      // crest. At +0.3 a SMALL character standing between crest tops is
      // legitimately covered by the next segment (which he is behind), so
      // only tall/wide troops must still cover crest pixels there.
      const tallEnough = ['golem', 'davincitank'].includes(charLabel)
      let front = null
      if (offset > ROW_MARGIN && (offset <= 0.1 || tallEnough)) {
        front = await page.evaluate(([all, shot, maskNames, noise]) =>
          window.__layerProbe.diffAgainst(all, shot, maskNames, noise),
        [`${camKey}:all`, shotName, [`${camKey}:seg:${segKey(app.target)}`], `${camKey}:noise`])
      }
      const behindOk = behind.n <= BEHIND_MAX_PX
      const frontOk = front === null || front.n >= FRONT_MIN_PX
      note(`${camKey} ${charLabel} offset ${offset}: over-behind-crest px=${behind.n}${front === null ? '' : ` front-cover px=${front.n}`} depth=${stage.depth} -> ${behindOk && frontOk ? 'ok' : 'FAIL'}`)
      if (!behindOk || !frontOk || process.env.DUMP) {
        const url = await page.evaluate(n => window.__layerProbe.dataUrl(n), shotName)
        const file = `${OUT}layerfail-${shotName.replace(/[:.]/g, '-')}.png`
        writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'))
        note(`  shot saved: ${file}${behind.box ? ` violation box ${JSON.stringify(behind.box)}` : ''}`)
      }
      if (!behindOk) failures.push(`${camKey} ${charLabel} offset ${offset}: ${behind.n}px painted over crests the character stands behind (segments ${behindSegs.map(segKey).join(' ')})`)
      if (!frontOk) failures.push(`${camKey} ${charLabel} offset ${offset}: character in front covered only ${front.n}px of the crest (expected >= ${FRONT_MIN_PX})`)
    }
  }

  let placeCheck = () => page.evaluate(() => {
    const e = window.__clashGame.scene.keys.MainScene.villageLife.__probeVillager
    return { x: e.x, y: e.y }
  })
  await runMatrix('home', APPROACHES.rowN, 'rowN', stageVillager, 'villager')
  await parkVillager()
  await waitFrames(3)

  // ------- Phase A3: silhouette dead zone (behavioural invariants) -------
  // A figure STOPPED just behind a building pokes above the drawn roofline
  // and reads as perched on the roof (painter order is pixel-correct — the
  // body shows against sky INSIDE the art's rect). The contract: ambient
  // tile pickers never return dead-zone tiles, and a walk that ends in the
  // zone immediately walks out. See docs/RENDERING_AND_DEPTH.md.
  const zone = await page.evaluate(([hall]) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const vl = scene.villageLife
    const inShadow = (x, y) => vl.inSilhouetteShadow(x, y)
    const predicate = [
      ['hall-behind-N', inShadow(hall.x + 0.6, hall.y - 0.5), true],
      ['hall-front-S', inShadow(hall.x + 1.5, hall.y + 3.3), false],
      ['hall-doorstep', inShadow(hall.x + 1.5, hall.y + 3.5), false]
    ].filter(([, got, want]) => got !== want)
    const picks = []
    for (let x = 2; x < 26; x++) {
      for (let y = 15; y < 26; y++) {
        const t = vl.openTileAt(x + 0.5, y + 0.5)
        if (t && inShadow(t.x + 0.5, t.y + 0.5)) picks.push(['openTileAt', x, y, t])
      }
    }
    const hallB = scene.buildings.find(b => b.type === 'town_hall')
    for (let i = 0; i < 80; i++) {
      const t = vl.openTileNear(hallB, 2)
      if (t && inShadow(t.x + 0.5, t.y + 0.5)) picks.push(['openTileNear', t])
    }
    return { predicate, picks: picks.slice(0, 10), pickCount: picks.length }
  }, [HALL])
  note(`deadzone predicate mismatches: ${zone.predicate.length}, tainted picks: ${zone.pickCount}`)
  if (zone.predicate.length > 0) failures.push(`deadzone predicate wrong at: ${JSON.stringify(zone.predicate)}`)
  if (zone.pickCount > 0) failures.push(`ambient tile pickers returned ${zone.pickCount} dead-zone tiles, e.g. ${JSON.stringify(zone.picks)}`)

  // Arrival escape: walk the probe villager to a stop INSIDE the hall's
  // dead zone and require it to settle OUTSIDE within 8s (never lingering).
  const escape = await page.evaluate(([hall]) => new Promise(resolve => {
    const scene = window.__clashGame.scene.keys.MainScene
    const vl = scene.villageLife
    const e = vl.__probeVillager
    e.x = hall.x + 0.5
    e.y = hall.y - 1.5
    e.lastPlaceTick = undefined
    vl.placeGfx(e)
    e.speed = 0.004
    e.state = 'walk'
    e.stateUntil = scene.time.now + 60000
    // The arrival must exercise the dead-zone escape branch, nothing else:
    // any ambient bookkeeping still on the hero (pendingEnterId from a
    // pre-parking stroll toward a door, a haulStage, a work chore) hijacks
    // the arrival into enterBuilding/haul handlers — the hero goes
    // 'inside' (invisible, legitimate in-game, but not the contract under
    // test) and the 8s escape deadline reads it as lingering.
    e.pendingEnterId = undefined
    e.haulStage = undefined
    e.workFaceAt = undefined
    e.workUntil = undefined
    e.workBuildingId = undefined
    e.path = [{ x: hall.x, y: hall.y - 1 }]
    const t0 = performance.now()
    const timer = setInterval(() => {
      const settled = e.state === 'idle'
      const inBand = vl.inSilhouetteShadow(e.x, e.y)
      if ((settled && !inBand) || performance.now() - t0 > 8000) {
        clearInterval(timer)
        resolve({ x: +e.x.toFixed(2), y: +e.y.toFixed(2), state: e.state, inBand, ms: Math.round(performance.now() - t0) })
      }
    }, 200)
  }), [HALL])
  note(`deadzone escape: settled at (${escape.x},${escape.y}) state=${escape.state} inBand=${escape.inBand} after ${escape.ms}ms`)
  if (escape.inBand) failures.push(`walk arrival lingered in the silhouette dead zone at (${escape.x},${escape.y}) state=${escape.state}`)
  await parkVillager()
  await waitFrames(3)

  // ------- Phase A4: construction scaffold never crosses a neighbour -----
  // The upgrading cannon touches the hall's north face: every scaffold
  // element that would plant on the shared boundary or run along the hall's
  // roofline must be suppressed — the visible scaffold pixels must all stay
  // in the E-pole column of the cannon's own tile.
  await setCam(CANNON.x + 0.5, CANNON.y + 0.5, 3)
  await waitFrames(3)
  const sitedepth = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const vl = scene.villageLife
    // No builder theatre during the pixel diff: flag every entity as
    // already claimed so the site cannot summon one into the crop.
    for (const e of vl.entities) e.buildSiteId = e.buildSiteId ?? 'layer_parked'
    const b = scene.buildings.find(v => v.type === 'cannon')
    const now = Date.now()
    b.upgradingTo = 2
    b.upgradeStartedAt = now
    b.upgradeEndsAt = now + 600_000
    vl.onConstruction(b, 'upgrade')
    // The work tag animates (hammer + live countdown) inside the crop —
    // clear it; only the scaffold gfx is under test.
    scene.villageBubbles?.clear(`construct_${b.id}`)
    const site = vl.constructionSites.find(x => x.buildingId === b.id)
    window.__layerSite = { site, b }
    return site.gfx.depth
  })
  note(`scaffold site depth ${sitedepth}`)
  await waitFrames(3)
  const scOrigin = await capture('scaffold:on', CANNON.x + 0.5, CANNON.y + 0.5)
  await sleep(260)
  await capture('scaffold:on2', CANNON.x + 0.5, CANNON.y + 0.5)
  await sleep(430)
  await capture('scaffold:on3', CANNON.x + 0.5, CANNON.y + 0.5)
  await page.evaluate(() => window.__layerSite.site.gfx.setAlpha(0.001))
  await waitFrames(3)
  await capture('scaffold:off', CANNON.x + 0.5, CANNON.y + 0.5)
  // Allowed region (world px): the cannon's own art zone + its E corner
  // pole column (ambient cannon glints flutter there too). Everything the
  // suppressed W/S poles and SW/SE rails used to draw lies WEST of it
  // (over the hall roofline) or BELOW it (the hall-boundary corners) and
  // must stay empty.
  const isoEx = (CANNON.x + 1 - CANNON.y) * 32
  const isoEy = (CANNON.x + 1 + CANNON.y) * 16
  const allowed = { x0: isoEx - 64, x1: isoEx + 12, y0: isoEy - 60, y1: isoEy + 8 }
  const allowedCrop = {
    x0: (allowed.x0 - scOrigin.viewX) * scOrigin.zoom - scOrigin.x0,
    x1: (allowed.x1 - scOrigin.viewX) * scOrigin.zoom - scOrigin.x0,
    y0: (allowed.y0 - scOrigin.viewY) * scOrigin.zoom - scOrigin.y0,
    y1: (allowed.y1 - scOrigin.viewY) * scOrigin.zoom - scOrigin.y0
  }
  const scaffoldDiff = await page.evaluate(rect => {
    const P = window.__layerProbe
    P.makeMask('scaffold:on', 'scaffold:on2', 'scaffold:n2')
    P.makeMask('scaffold:on', 'scaffold:on3', 'scaffold:n3')
    P.unionMasks(['scaffold:n2', 'scaffold:n3'], 'scaffold:noise')
    const a = P.shots['scaffold:on'].data
    const b = P.shots['scaffold:off'].data
    const noise = P.masks['scaffold:noise']
    const w = P.shots['scaffold:on'].width
    let inside = 0
    let outside = 0
    let box = null
    for (let i = 0; i < a.length; i += 4) {
      const j = i >> 2
      if (noise[j]) continue
      if (!P.changed(a, b, i)) continue
      const x = j % w
      const y = (j / w) | 0
      if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) { inside++; continue }
      outside++
      if (!box) box = { x0: x, y0: y, x1: x, y1: y }
      else {
        box.x0 = Math.min(box.x0, x)
        box.y0 = Math.min(box.y0, y)
        box.x1 = Math.max(box.x1, x)
        box.y1 = Math.max(box.y1, y)
      }
    }
    return { inside, outside, box }
  }, allowedCrop)
  const boxWorld = scaffoldDiff.box === null ? null : {
    x0: +(scOrigin.viewX + (scOrigin.x0 + scaffoldDiff.box.x0) / scOrigin.zoom).toFixed(1),
    x1: +(scOrigin.viewX + (scOrigin.x0 + scaffoldDiff.box.x1) / scOrigin.zoom).toFixed(1),
    y0: +(scOrigin.viewY + (scOrigin.y0 + scaffoldDiff.box.y0) / scOrigin.zoom).toFixed(1),
    y1: +(scOrigin.viewY + (scOrigin.y0 + scaffoldDiff.box.y1) / scOrigin.zoom).toFixed(1)
  }
  const scaffoldOk = scaffoldDiff.inside >= 20 && scaffoldDiff.outside <= 8
  note(`scaffold diff inside-allowed px=${scaffoldDiff.inside} outside px=${scaffoldDiff.outside}${boxWorld ? ` stray world box=${JSON.stringify(boxWorld)}` : ''} -> ${scaffoldOk ? 'ok' : 'FAIL'}`)
  if (scaffoldDiff.inside < 20) failures.push(`scaffold: suppressed site rendered almost nothing (${scaffoldDiff.inside}px in the E-pole column)`)
  if (scaffoldDiff.outside > 8) {
    failures.push(`scaffold drew ${scaffoldDiff.outside}px outside its allowed E-pole column (stray world box ${JSON.stringify(boxWorld)}) — rails/poles crossing the hall again?`)
    const url = await page.evaluate(n => window.__layerProbe.dataUrl(n), 'scaffold:on')
    const file = `${OUT}layerfail-scaffold-on.png`
    writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'))
    note(`  shot saved: ${file}`)
  }
  await page.evaluate(() => {
    const vl = window.__clashGame.scene.keys.MainScene.villageLife
    const { b } = window.__layerSite
    vl.cancelConstruction(b.id)
    b.upgradingTo = undefined
    b.upgradeEndsAt = undefined
    delete b.upgradeStartedAt
    for (const e of vl.entities) if (e.buildSiteId === 'layer_parked') e.buildSiteId = undefined
  })
  await waitFrames(3)

  // ------------- Phase B: troops vs wall matrix (practice attack) --------
  await page.evaluate(() => window.__clashGM.startPracticeAttack())
  await page.waitForFunction(count => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    return scene?.mode === 'ATTACK' && scene.buildings.filter(b => b.type === 'wall').length === count
  }, { timeout: 60_000, polling: 100 }, fixtureBuildings.filter(b => b.type === 'wall').length)
  await sleep(5500) // battle-transition clouds
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather.setWeatherOverride(0)
    // FREEZE EVERY DEFENSE for the staged matrix. The fixture cannon's
    // range (7) reaches the colE staging tiles (~5.75 from its center), so
    // a live defense shoots the staged troop between captures. Neither
    // painter that puts in the crops is a layering bug — the shell rides
    // the projectile band (base+60, clears same-row crests BY DESIGN) and
    // the resulting health bar + level chip live in BattleOverlay at depth
    // 30000/30001 (readable over everything BY DESIGN) — but both land
    // inside the wall-body masks and fake an occluder-band violation (the
    // 2026-07 intermittent colE:warrior FAIL: a faded bar border + amber
    // fill read as "helmet + torch" pixels; the character body itself
    // never painted over a crest). The matrix already freezes the troop
    // side (speedMult/attackDelay); frozenUntil is the defense-side
    // equivalent — the ice-golem full-stop gate: no shots, no charge, no
    // idle swivel, and no visual side effects of its own (tint/overlay
    // only come from applyDefenseFreezeVisual, which we never call).
    for (const b of scene.buildings) b.frozenUntil = scene.time.now + 1e9
  })

  // Freeze the troop (no walking, no attacking) and stage it EXACTLY as
  // updateTroops presents a moved troop: setPosition(cartToIso) +
  // setDepth(Math.round(depthForTroop)) — updateTroops itself only re-syncs
  // on movement, which the freeze suppresses.
  const stageTroop = type => async ([x, y]) => page.evaluate(([t, px, py]) => {
    const scene = window.__clashGame.scene.keys.MainScene
    let troop = scene.troops.find(v => v.__probe === t && v.health > 0)
    if (!troop) {
      scene.spawnTroop(3, 21, t, 'PLAYER')
      troop = scene.troops[scene.troops.length - 1]
      troop.__probe = t
    }
    scene.tweens.killTweensOf(troop.gameObject)
    troop.speedMult = 0
    troop.velocityX = 0
    troop.velocityY = 0
    troop.knockbackUntil = 0
    troop.attackDelay = 1e9
    troop.lastAttackTime = scene.time.now
    troop.retargetPauseUntil = scene.time.now + 1e9
    troop.gridX = px
    troop.gridY = py
    troop.gameObject.setPosition((px - py) * 32, (px + py) * 16)
    const depth = Math.round(window.__clashDepth.depthForTroop(px, py, t))
    troop.lastDepth = depth
    troop.gameObject.setDepth(depth)
    return { depth }
  }, [type, x, y])

  const parkTroop = type => page.evaluate(t => {
    const scene = window.__clashGame.scene.keys.MainScene
    const troop = scene.troops.find(v => v.__probe === t)
    if (!troop) return
    troop.gridX = 1
    troop.gridY = 22
    troop.gameObject.setPosition((1 - 22) * 32, (1 + 22) * 16)
  }, type)

  for (const [name, app] of Object.entries(APPROACHES)) {
    for (const type of app.troops) {
      placeCheck = () => page.evaluate(t => {
        const troop = window.__clashGame.scene.keys.MainScene.troops.find(v => v.__probe === t)
        return { x: troop.gridX, y: troop.gridY }
      }, type)
      await runMatrix('attack', app, `${name}:${type}`, stageTroop(type), type)
      await parkTroop(type)
      await waitFrames(3)
    }
  }

  // ---------------- human-facing record shots ----------------------------
  const record = [
    ['attack:rowN:golem', APPROACHES.rowN, 'golem', -0.05],
    ['attack:rowN:golem-front', APPROACHES.rowN, 'golem', 0.3],
    ['attack:corner:davincitank', APPROACHES.corner, 'davincitank', -1.0]
  ]
  for (const [label, app, type, offset] of record) {
    await stageTroop(type)(app.place(offset))
    await setCam(app.cam[0], app.cam[1], 3)
    await waitFrames(4)
    await page.setViewport({ width: 1281, height: 901 })
    await sleep(80)
    await page.setViewport({ width: 1280, height: 900 })
    await setCam(app.cam[0], app.cam[1], 3)
    await sleep(200)
    await page.screenshot({ path: `${OUT}layering-${label.replace(/[:.]/g, '-')}.png` })
    await parkTroop(type)
  }

  assert(pageErrors.length === 0, `browser emitted page errors: ${JSON.stringify(pageErrors)}`)
} finally {
  await browser?.close()
}

if (failures.length > 0) {
  console.error(`\nLAYERING: ${failures.length} violation(s)`)
  for (const f of failures) console.error(' - ' + f)
  process.exit(1)
}
console.log('\nLAYERING: PASS')
