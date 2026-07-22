// The RETURN benchmark: after an in-place battle, going home must be as
// seamless as arriving — no clouds, no flash. The flag bearer leads the
// remaining troops home; the home frame commits mid-glide. PASS requires:
//   - the swap frame's camera->caravan step is no bigger than the glide's own
//   - postcards never blink out
//   - the camera ends centred on the home village, plates and label restored
//   - a NEW attack launched MID-RETURN force-completes cleanly (interrupt path)
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5199'
const OUT = process.env.OUT ?? '/tmp/verify'
mkdirSync(OUT, { recursive: true })

const session = await (await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const api = async (path, body) => (await fetch(`${BASE}/api${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
  body: body === undefined ? undefined : JSON.stringify(body)
})).json()

// Eyes + an army: watchtower for sight, barracks + trained troops so the
// column and the gate rank are the ACTUAL army.
await api('/resources/apply', { delta: 4000, reason: 'debug_grant', requestId: 'rt-g' })
await api('/resources/apply', { delta: 125, resource: 'ore', reason: 'debug_grant', requestId: 'rt-o' })
{
  const w = (await api('/world')).world
  w.buildings.push(
    { id: 'rt_eyes', type: 'watchtower', gridX: 2, gridY: 2, level: 1 },
    { id: 'rt_barracks', type: 'barracks', gridX: 6, gridY: 2, level: 1 }
  )
  const saved = await api('/world/save', { world: w, requestId: 'rt-save' })
  if (saved.error) { console.log('setup save failed:', saved.error); process.exit(1) }
}
for (let i = 0; i < 10; i++) await api('/army/train', { type: 'warrior', requestId: `rt-w${i}` })
for (let i = 0; i < 4; i++) await api('/army/train', { type: 'archer', requestId: `rt-a${i}` })


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
  await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.worldMap['views'].size >= 8, { timeout: 20000, polling: 400 })

  // ---- OUT: attack a neighbour (the proven leg), then hold at the gate ----
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.3)
    s.weather.setWeatherOverride(0)
    const wm = s.worldMap
    const me = wm['myPlot']
    const north = [...wm['views'].values()].find(v => v.plot.x === me.x && v.plot.y === me.y - 1 && v.plot.kind === 'bot')
      ?? [...wm['views'].values()].find(v => v.plot.kind === 'bot')
    s.attackBotPlot(north.plot.seed, north.plot.username, north.plot.x, north.plot.y)
  })
  await sleep(2400)
  await page.screenshot({ path: `${OUT}/r0-march-out-flag.png` })
  await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.mode === 'ATTACK', { timeout: 30000, polling: 200 })
  await sleep(900)
  const campState = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const c = s.worldMap['caravan']
    return { state: c?.state, hasFlag: Boolean(c?.flag) }
  })
  await page.screenshot({ path: `${OUT}/r1-flag-planted-rank.png` })

  // ---- BACK: the measured return ----
  const setupOk = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    window.__log = []
    const wm = s.worldMap
    const record = () => {
      const cam = s.cameras.main
      const caravan = wm['caravan']
      window.__log.push({
        t: performance.now(),
        sx: cam.scrollX,
        sy: cam.scrollY,
        mode: s.mode,
        ground: s['groundPaletteKey'],
        cards: [...wm['views'].values()].filter(v => v.rt && v.rt.visible).length,
        cix: caravan ? (caravan.x - caravan.y) * 32 : null,
        ciy: caravan ? (caravan.x + caravan.y) * 16 : null,
        homecoming: Boolean(caravan?.homecoming),
        escorts: caravan?.escorts?.length ?? 0,
        focus: Boolean(wm['focusPlot']),
        plateOpacity: wm['plateLayer'] ? wm['plateLayer'].style.opacity : '?'
      })
      if (window.__log.length < 2400) requestAnimationFrame(record)
    }
    requestAnimationFrame(record)
    void s.goHome()
    return { modeNow: s.mode, battleInPlace: s.battleInPlace }
  })
  console.log('return kicked:', JSON.stringify(setupOk))
  await sleep(1700)
  await page.screenshot({ path: `${OUT}/r2-march-home.png` })
  await page.waitForFunction(() => {
    const s = window.__clashGame.scene.keys.MainScene
    return !s.worldMap['focusPlot'] && !s.worldMap['caravan']
  }, { timeout: 25000, polling: 200 })
  await sleep(1200)
  await page.screenshot({ path: `${OUT}/r3-home-again.png` })

  const verdict = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const log = window.__log
    const battleGround = log[0]?.ground
    const swapIx = log.findIndex(e => e.ground !== battleGround)
    const rel = i => (log[i].cix === null ? null : { x: log[i].cix - log[i].sx, y: log[i].ciy - log[i].sy })
    const relStep = i => {
      const a = rel(i - 1); const b = rel(i)
      return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : null
    }
    let maxGlideRel = 0
    for (let i = 2; i < (swapIx > 0 ? swapIx : log.length); i++) {
      const v = relStep(i)
      if (v !== null) maxGlideRel = Math.max(maxGlideRel, v)
    }
    const swapRel = swapIx > 1 ? relStep(swapIx) : null
    const baseline = log[Math.min(5, log.length - 1)].cards
    let minCards = Infinity
    for (const e of log) minCards = Math.min(minCards, e.cards)
    const marching = log.find(e => e.homecoming)
    const cam = s.cameras.main
    const plates = log[log.length - 1].plateOpacity
    return {
      frames: log.length,
      swapIx,
      maxGlideRel: +maxGlideRel.toFixed(2),
      swapRel: swapRel === null ? null : +swapRel.toFixed(2),
      baseline,
      minCards,
      escortsSeen: marching?.escorts ?? 0,
      modeDuringMarch: marching?.mode,
      endCenter: { x: Math.round(cam.worldView.centerX), y: Math.round(cam.worldView.centerY) },
      endGround: s['groundPaletteKey'],
      labelVisible: s.villageBubbles.has('enemy-village-name'),
      platesAtEnd: plates,
      focusAtEnd: Boolean(s.worldMap['focusPlot'])
    }
  })
  console.log('return verdict:', JSON.stringify(verdict))

  // ---- INTERRUPT: attack another neighbour DURING a fresh return march ----
  // Both targets are picked NOW, from the home ring, so the retarget is
  // guaranteed road-reachable mid-return (the battlefield leaves the views).
  const pair = await page.evaluate(() => {
    const wm = window.__clashGame.scene.keys.MainScene.worldMap
    const me = wm['myPlot']
    const near = [...wm['views'].values()].filter(v => v.plot.kind === 'bot'
      && Math.abs(v.plot.x - me.x) <= 1 && Math.abs(v.plot.y - me.y) <= 1)
    if (near.length < 2) return null
    return {
      a: { seed: near[0].plot.seed, name: near[0].plot.username, x: near[0].plot.x, y: near[0].plot.y },
      b: { seed: near[1].plot.seed, name: near[1].plot.username, x: near[1].plot.x, y: near[1].plot.y }
    }
  })
  let secondBattle = null
  if (!pair) {
    console.log('interrupt leg: skipped (fewer than two bots in this ring)')
  } else {
    await page.evaluate(t => {
      window.__clashGame.scene.keys.MainScene.attackBotPlot(t.seed, t.name, t.x, t.y)
    }, pair.a)
    await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.mode === 'ATTACK', { timeout: 30000, polling: 200 })
    await page.evaluate(() => { void window.__clashGame.scene.keys.MainScene.goHome() })
    await sleep(1200) // mid-return
    await page.evaluate(t => {
      window.__clashGame.scene.keys.MainScene.attackBotPlot(t.seed, t.name, t.x, t.y)
    }, pair.b)
    console.log('interrupt retarget:', JSON.stringify(pair.b))
    await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.mode === 'ATTACK', { timeout: 30000, polling: 250 })
    await sleep(800)
    secondBattle = await page.evaluate(() => {
      const s = window.__clashGame.scene.keys.MainScene
      return { mode: s.mode, battleInPlace: s.battleInPlace, cards: [...s.worldMap['views'].values()].filter(v => v.rt && v.rt.visible).length, caravanState: s.worldMap['caravan']?.state }
    })
    console.log('second battle after interrupt:', JSON.stringify(secondBattle))
    await page.screenshot({ path: `${OUT}/r4-interrupt-second-battle.png` })
    await page.evaluate(() => { void window.__clashGame.scene.keys.MainScene.goHome() })
    await page.waitForFunction(() => !window.__clashGame.scene.keys.MainScene.worldMap['focusPlot'] && !window.__clashGame.scene.keys.MainScene.worldMap['caravan'], { timeout: 25000, polling: 250 })
  }

  const fps = await page.evaluate(() => Math.round(window.__clashGame.loop.actualFps))
  console.log(`camp=${JSON.stringify(campState)} fps=${fps}, page errors=${errors.length ? errors : 'none'}`)

  const ok = verdict.swapIx > 2
    && verdict.swapRel !== null && verdict.swapRel <= Math.max(2.5, verdict.maxGlideRel)
    && verdict.minCards >= Math.min(verdict.baseline, 5) - 2 && verdict.minCards >= 4
    && verdict.modeDuringMarch === 'HOME'
    && verdict.escortsSeen >= 10
    && Math.abs(verdict.endCenter.x) <= 2 && Math.abs(verdict.endCenter.y - 400) <= 2
    && verdict.labelVisible && verdict.platesAtEnd === '1' && !verdict.focusAtEnd
    && (secondBattle === null || (secondBattle.mode === 'ATTACK' && secondBattle.battleInPlace && secondBattle.caravanState === 'camp'))
    && errors.length === 0
  console.log(ok ? 'RETURN: PASS (silent mid-glide swap, army marched home, interrupt clean)' : 'RETURN: FAIL')
  if (!ok) process.exitCode = 1
} finally {
  await browser.close()
}
