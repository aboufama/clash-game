// CLOCKWORK BEETLE design-B ("Ironback Scarab") verification harness.
//
// Cribbed from shoot-troops.mjs, but: resumes the ONE shared identity from
// .shared-device-token.json (never mints sessions), and pins BOTH
// clash.sprites.off=1 (vector authoring path) and design slot B
// (clash.design.clockworkbeetle) BEFORE boot. Poses are driven by direct
// TroopRenderer.drawTroopVisual calls through window.__clashBake with pinned
// time/attackAge, so every frame is an exact deterministic sample.
//
//   BASE=http://127.0.0.1:5173 OUT=<dir> node shoot-clockworkbeetle-b.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = (process.env.OUT ?? new URL('./shots/clockworkbeetle-b', import.meta.url).pathname).replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

const { token } = JSON.parse(readFileSync(new URL('./.shared-device-token.json', import.meta.url), 'utf8'))

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
    localStorage.setItem('clash.sprites.off', '1')          // vector authoring path
    localStorage.setItem('clash.design.clockworkbeetle', 'B') // this design slot
  }, token)
  const errors = []
  page.on('pageerror', e => { errors.push(String(e.message).slice(0, 160)); console.log('PAGE ERROR:', String(e.message).slice(0, 160)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 120000, polling: 500 })
  await sleep(2500)

  // Spawn a working row on the south lawn, root everyone, then pause.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather.setWeatherOverride(0)
    // [gridX, gridY, owner, level] — 8 stations on a constant-screen-y
    // diagonal (gx+gy = 30) so the strip clip never cuts the row ends.
    const cast = [
      [8, 22, 'PLAYER', 1], [9, 21, 'PLAYER', 2], [10, 20, 'PLAYER', 3],
      [11, 19, 'ENEMY', 1], [12, 18, 'ENEMY', 2], [13, 17, 'ENEMY', 3],
      [14, 16, 'PLAYER', 2], [15, 15, 'PLAYER', 2]
    ]
    for (const [x, y, owner, lvl] of cast) s.spawnTroop(x, y, 'clockworkbeetle', owner, lvl)
    for (const t of s.troops) { t.target = null; t.path = undefined; t.facingAngle = 0.45 }
    window.__CB = idx => s.troops.filter(t => t.type === 'clockworkbeetle')[idx]
    window.__CBcount = s.troops.filter(t => t.type === 'clockworkbeetle').length
  })
  await sleep(900) // landing bounce settles
  await page.evaluate(() => window.__clashGame.scene.pause('MainScene'))

  // Exact-pose driver: clear the carrier graphics and draw a pinned sample.
  // spec: { idx, owner?, level?, ang?, moving?, time?, age? } (age -1 = no combat)
  const pose = specs => page.evaluate(specs => {
    const B = window.__clashBake
    const out = []
    for (const sp of specs) {
      const t = window.__CB(sp.idx)
      if (!t) { out.push(`missing ${sp.idx}`); continue }
      const g = t.gameObject
      g.clear()
      B.TroopRenderer.drawTroopVisual(
        g, 'clockworkbeetle', sp.owner ?? t.owner,
        sp.ang ?? 0.45, sp.moving ?? false,
        0, 0, false, 0,
        sp.level ?? t.level ?? 1,
        sp.time ?? 1000, sp.age ?? -1, 500
      )
      out.push('ok')
    }
    return out
  }, specs)

  // Small in-canvas labels under each station.
  const label = texts => page.evaluate(texts => {
    const s = window.__clashGame.scene.keys.MainScene
    window.__CBlabels?.forEach(t => t.destroy())
    window.__CBlabels = texts.map(([gx, gy, str]) => {
      const x = (gx - gy) * 32, y = (gx + gy) * 16
      const t = s.add.text(x, y + 18, str, { fontSize: '11px', color: '#ffffff', backgroundColor: '#00000088', padding: { x: 3, y: 1 } })
      t.setOrigin(0.5, 0).setDepth(99999)
      return t
    })
  }, texts)

  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const strip = name => page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 230, width: 1280, height: 440 } })
  const close = name => page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 390, y: 200, width: 500, height: 500 } })

  const stations = [[8, 22], [9, 21], [10, 20], [11, 19], [12, 18], [13, 17], [14, 16], [15, 15]]

  // ---------- 1. levels x palettes (day) ----------
  console.log(await pose([
    { idx: 0, time: 1000 }, { idx: 1, time: 1000 }, { idx: 2, time: 1000 },
    { idx: 3, time: 1000 }, { idx: 4, time: 1000 }, { idx: 5, time: 1000 },
    { idx: 6, time: 1000 }, { idx: 7, time: 1000 }
  ]))
  await label([...stations.slice(0, 6).map(([x, y], i) => [x, y, `${i < 3 ? 'P' : 'E'} L${(i % 3) + 1}`]), [14, 16, 'spare'], [15, 15, 'spare']])
  await cam(11.5, 18.5, 2.3, 6)
  await strip('01-levels-palettes-day')

  // close-ups: P L1 and P L3
  await label([])
  await cam(8, 22, 6, 0)
  await close('02-close-P-L1')
  await cam(10, 20, 6, 0)
  await close('03-close-P-L3')

  // ---------- 2. eight headings (idle, L2 P) ----------
  console.log(await pose(stations.map(([, ], i) => ({ idx: i, owner: 'PLAYER', level: 2, ang: (i / 8) * Math.PI * 2, time: 1000 }))))
  await label(stations.map(([x, y], i) => [x, y, `dir ${i} (${i * 45}°)`]))
  await cam(11.5, 18.5, 2.3, 6)
  await strip('04-headings-8')

  // ---------- 3. walk cycle: one EXACT 240 ms stride in 6 samples ----------
  console.log(await pose(stations.slice(0, 6).map(([, ], k) => ({ idx: k, owner: 'PLAYER', level: 1, ang: 0.45, moving: true, time: Math.round(k * 240 / 6) }))))
  await label(stations.slice(0, 6).map(([x, y], k) => [x, y, `walk t=${Math.round(k * 240 / 6)}ms`]))
  await cam(10.5, 19.5, 2.6, 6)
  await strip('05-walk-stride-240ms')

  // walk at an up-screen heading (layering check while moving)
  console.log(await pose(stations.slice(0, 6).map(([, ], k) => ({ idx: k, owner: 'PLAYER', level: 1, ang: Math.PI * 1.25, moving: true, time: Math.round(k * 240 / 6) }))))
  await label([])
  await cam(10.5, 19.5, 2.6, 6)
  await strip('06-walk-upscreen')

  // ---------- 4. attack: the 500 ms arming overwind ----------
  console.log(await pose([
    { idx: 0, level: 2, ang: 0.45, age: 5, time: 1000 },
    { idx: 1, level: 2, ang: 0.45, age: 150, time: 1000 },
    { idx: 2, level: 2, ang: 0.45, age: 300, time: 1000 },
    { idx: 3, level: 2, ang: 0.45, age: 420, time: 1000 },
    { idx: 4, level: 2, ang: 0.45, age: 475, time: 1000 },
    { idx: 5, level: 2, ang: 0.45, age: 497, time: 1000 }
  ]))
  await label(stations.slice(0, 6).map(([x, y], i) => [x, y, `age ${[5, 150, 300, 420, 475, 497][i]}ms`]))
  await cam(10.5, 19.5, 2.6, 6)
  await strip('07-attack-overwind')

  // ---------- 5. idle: ratchet ticks + ember pulse over 2000 ms ----------
  console.log(await pose(stations.slice(0, 6).map(([, ], i) => ({ idx: i, owner: 'PLAYER', level: 2, ang: 0.45, time: 100000 + [0, 80, 250, 750, 1250, 1750][i] }))))
  await label(stations.slice(0, 6).map(([x, y], i) => [x, y, `idle +${[0, 80, 250, 750, 1250, 1750][i]}ms`]))
  await cam(10.5, 19.5, 2.6, 6)
  await strip('08-idle-ratchet-2000ms')

  // ---------- 6. night (phase 0.8) ----------
  await page.evaluate(() => window.__clashGame.scene.resume('MainScene'))
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.8)
  })
  await sleep(700)
  await page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  console.log(await pose([
    { idx: 0, time: 1000 }, { idx: 1, time: 1000 }, { idx: 2, time: 1000 },
    { idx: 3, time: 1000 }, { idx: 4, time: 1000 }, { idx: 5, time: 1000 },
    { idx: 6, time: 1000 }, { idx: 7, time: 1000 },
    { idx: 0, level: 2, ang: 0.45, age: 480, time: 1000 } // arming, far from the fire pool
  ]))
  await label([])
  await cam(11.5, 18.5, 2.3, 6)
  await strip('09-night-levels')
  await cam(8.6, 21.6, 5, 0)
  await close('10-night-arming-close')

  await page.evaluate(() => window.__clashGame.scene.resume('MainScene'))
  console.log('clockworkbeetle-B shots →', OUT, 'errors:', errors.length ? errors : 'none')
} finally {
  await browser.close()
}
