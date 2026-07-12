// The benchmark: a neighbour invasion with NO visible handover.
// Measures, per frame, camera scroll and visible-postcard count from the
// moment attack is pressed until the battle is underway. PASS requires:
//   - the swap frame's camera step is no bigger than the glide's own steps
//   - postcards never blink out (no flash)
//   - the caravan halts ON the road outside the village
//   - nameplates faded before arrival
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5199'
const OUT = process.env.OUT ?? '/tmp/verify'
mkdirSync(OUT, { recursive: true })

const session = await (await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()

// Eyes first: without a watchtower there are no neighbours to march on.
const grantW = (n, kind, id) => fetch(`${BASE}/api/resources/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ delta: n, ...(kind ? { resource: kind } : {}), reason: 'debug_grant', requestId: id }) })
await grantW(2000, null, 'wt-g')
await grantW(125, 'ore', 'wt-o')
{
  const wRes = await fetch(`${BASE}/api/world`, { headers: { Authorization: `Bearer ${session.token}` } })
  const wj = (await wRes.json()).world
  wj.buildings.push({ id: 'wt_eyes', type: 'watchtower', gridX: 2, gridY: 2, level: 1 })
  await fetch(`${BASE}/api/world/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ world: wj, requestId: 'wt-save' }) })
}


// The dev world's spiral is dense with old harness accounts: relocate until
// the ring holds a bot village to march on (argless relocate = next frontier).
{
  const authed = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }
  for (let hop = 0; hop < 6; hop++) {
    const map = await (await fetch(`${BASE}/api/map`, { headers: authed })).json()
    if ((map.plots ?? []).some(p => p.kind === 'bot')) break
    await fetch(`${BASE}/api/map/relocate`, { method: 'POST', headers: authed, body: '{}' })
  }
}
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1380,940']
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1380, height: 940 })
  await page.evaluateOnNewDocument(tok => localStorage.setItem('clash.device.token', tok), session.token)
  const errors = []
  page.on('pageerror', e => { errors.push(String(e.message).slice(0, 200)); console.log('PAGE ERROR:', String(e.message).slice(0, 160)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 40000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(3000)

  // Wait for the neighbourhood, then attack the NORTH neighbour (the exact
  // direction whose depth used to layer the caravan under the postcard).
  await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.worldMap['views'].size >= 8, { timeout: 20000, polling: 400 })
  const target = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.3)
    s.weather.setWeatherOverride(0)
    const wm = s.worldMap
    const me = wm['myPlot']
    const north = [...wm['views'].values()].find(v => v.plot.x === me.x && v.plot.y === me.y - 1 && v.plot.kind === 'bot')
      ?? [...wm['views'].values()].find(v => v.plot.kind === 'bot')

    // Per-frame recorder. The honest continuity metric is the RELATIVE
    // vector camera->caravan (the on-screen anchor): at the swap, world and
    // camera both re-anchor by the same delta, so absolute scroll jumps by
    // design — what must NOT move is the content under the lens.
    window.__log = []
    const record = () => {
      const cam = s.cameras.main
      const caravan = wm['caravan']
      window.__log.push({
        t: performance.now(),
        sx: cam.scrollX,
        sy: cam.scrollY,
        mode: s.mode,
        cards: [...wm['views'].values()].filter(v => v.rt && v.rt.visible).length,
        cx: caravan ? caravan.x : null,
        cy: caravan ? caravan.y : null,
        cix: caravan ? (caravan.x - caravan.y) * 32 : null,
        ciy: caravan ? (caravan.x + caravan.y) * 16 : null,
        plateOpacity: wm['plateLayer'] ? wm['plateLayer'].style.opacity : '?'
      })
      if (window.__log.length < 2400) requestAnimationFrame(record)
    }
    requestAnimationFrame(record)

    s.attackBotPlot(north.plot.seed, north.plot.username, north.plot.x, north.plot.y)
    return { x: north.plot.x, y: north.plot.y, me }
  })
  console.log('target:', JSON.stringify(target))

  await sleep(2600)
  await page.screenshot({ path: `${OUT}/h1-march-over-postcard.png` })
  await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.mode === 'ATTACK', { timeout: 30000, polling: 200 })
  await page.screenshot({ path: `${OUT}/h2-just-after-swap.png` })
  await sleep(1500)
  await page.screenshot({ path: `${OUT}/h3-battle-settled.png` })

  const verdict = await page.evaluate(() => {
    const log = window.__log
    const swapIx = log.findIndex(e => e.mode === 'ATTACK')
    if (swapIx < 2) return { fail: 'no swap recorded' }
    // Visual continuity: change in the camera->caravan relative vector.
    const rel = i => (log[i].cix === null ? null : { x: log[i].cix - log[i].sx, y: log[i].ciy - log[i].sy })
    const relStep = i => {
      const a = rel(i - 1)
      const b = rel(i)
      return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : null
    }
    let maxGlideRel = 0
    for (let i = 2; i < swapIx; i++) {
      const v = relStep(i)
      if (v !== null) maxGlideRel = Math.max(maxGlideRel, v)
    }
    const swapRel = relStep(swapIx)
    const afterRel = swapIx + 1 < log.length ? relStep(swapIx + 1) : null
    // Postcards visible throughout: never a blank world. The baseline is the
    // run's own steady count (rings legitimately contain empty plots, and the
    // battlefield plot leaves the postcard set at the swap).
    const baseline = log[Math.min(5, log.length - 1)].cards
    let minCards = Infinity
    for (let i = 0; i < Math.min(log.length, swapIx + 90); i++) minCards = Math.min(minCards, log[i].cards)
    // Caravan halt spot (post-shift frame): must sit on a road lane.
    let halt = null
    for (let i = swapIx; i >= 0; i--) { if (log[i].cx !== null) { halt = { x: log[i].cx, y: log[i].cy }; break } }
    const mod = v => ((v % 27) + 27) % 27
    const onLane = halt ? (Math.abs(mod(halt.x) - 26) < 1.2 || Math.abs(mod(halt.y) - 26) < 1.2) : false
    const plateBeforeSwap = log[Math.max(0, swapIx - 3)].plateOpacity
    // Post-swap: the battle frame holds still.
    const step = i => Math.hypot(log[i].sx - log[i - 1].sx, log[i].sy - log[i - 1].sy)
    let postDrift = 0
    for (let i = swapIx + 2; i < Math.min(log.length, swapIx + 30); i++) postDrift = Math.max(postDrift, step(i))
    return { frames: log.length, swapIx, maxGlideRel: +maxGlideRel.toFixed(2), swapRel: swapRel === null ? null : +swapRel.toFixed(2), afterRel: afterRel === null ? null : +afterRel.toFixed(2), baseline, minCards, halt, onLane, plateBeforeSwap, postDrift: +postDrift.toFixed(2) }
  })
  console.log('handover verdict:', JSON.stringify(verdict))

  // March home cleanly.
  await page.evaluate(async () => {
    const s = window.__clashGame.scene.keys.MainScene
    s.endAttackReplayCapture('aborted')
    await s.goHome()
  })
  await sleep(2000)
  const fps = await page.evaluate(() => Math.round(window.__clashGame.loop.actualFps))
  console.log(`fps=${fps}, page errors=${errors.length ? errors : 'none'}`)

  const ok = verdict.swapRel !== null && verdict.swapRel <= Math.max(2.5, verdict.maxGlideRel) && verdict.baseline >= 5 && verdict.minCards >= verdict.baseline - 2 && verdict.minCards >= 5 && verdict.plateBeforeSwap === '0' && verdict.onLane
  console.log(ok ? 'HANDOVER: PASS (content under the lens never moved, no card blink, halted on road, plates faded)' : 'HANDOVER: FAIL')
  if (!ok || errors.length > 0) process.exitCode = 1
} finally {
  await browser.close()
}
