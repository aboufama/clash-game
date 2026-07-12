// Global-map verification: real player neighbours + deterministic bots tiling
// around the home village, tap panel, live-battle indicator, and an fps check.
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = new URL('./shots/', import.meta.url).pathname

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
  })
  return res.json()
}

// --- The cast: me + two real neighbours ---
const me = await api('POST', '/auth/session')
const nb1 = await api('POST', '/auth/session')
const nb2 = await api('POST', '/auth/session')
console.log('me @', me.player.plotX, me.player.plotY)

// Eyes first: sight is earned — without a watchtower the map shows nothing.
await api('POST', '/resources/apply', { token: me.token, body: { delta: 5000, reason: 'debug_grant', requestId: 'wm-fund-g' } })
await api('POST', '/resources/apply', { token: me.token, body: { delta: 125, resource: 'ore', reason: 'debug_grant', requestId: 'wm-fund-o' } })
const myWorld = me.world
myWorld.buildings.push(
  { id: 'W_eyes', type: 'watchtower', gridX: 2, gridY: 2, level: 1 },
  { id: 'W_farm', type: 'farm', gridX: 15, gridY: 11, level: 1 },
  { id: 'W_mine', type: 'mine', gridX: 8, gridY: 15, level: 1 }
)
const meSave = await api('POST', '/world/save', { token: me.token, body: { world: myWorld, requestId: 'wm-me' } })
if (!meSave.world) console.log('me save refused:', meSave.error)

// Move the two real players onto plots adjacent to mine, with distinct bases.
const homeX = me.player.plotX
const homeY = me.player.plotY
const ring = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
let ringAt = 0
for (const [i, acct] of [nb1, nb2].entries()) {
  let moved = null
  while (ringAt < ring.length) {
    const [dx, dy] = ring[ringAt++]
    moved = await api('POST', '/map/relocate', { token: acct.token, body: { x: homeX + dx, y: homeY + dy } })
    if (moved.me) break
  }
  console.log(`neighbour ${i + 1} relocate ->`, JSON.stringify(moved?.me ?? moved))
  const w = acct.world
  w.buildings = [
    { id: `N${i}a`, type: 'town_hall', gridX: 10 + i * 2, gridY: 10, level: 1 },
    { id: `N${i}b`, type: i === 0 ? 'prism' : 'dragons_breath', gridX: 8, gridY: 14, level: i === 0 ? 4 : 2 },
    { id: `N${i}c`, type: 'xbow', gridX: 15, gridY: 13, level: 3 },
    { id: `N${i}d`, type: 'wall', gridX: 12, gridY: 15, level: 4 },
    { id: `N${i}e`, type: 'wall', gridX: 13, gridY: 15, level: 4 },
    { id: `N${i}f`, type: 'wall', gridX: 14, gridY: 15, level: 4 }
  ]
  await api('POST', '/world/save', { token: acct.token, body: { world: w, requestId: `wm-n${i}` } })
}

// One neighbour attacks the other: a live battle for the map to flag.
// nb1 marches once (matchmake finds an unshielded victim) to drop its shield.
const mm = await api('POST', '/attacks/matchmake', { token: nb1.token })
if (mm.attackId) {
  await api('POST', '/attacks/end', { token: nb1.token, body: { attackId: mm.attackId, destruction: 0, goldLooted: 0, status: 'aborted' } })
  console.log('nb1 shield dropped via matchmake march')
} else {
  console.log('matchmake found no open victim:', JSON.stringify(mm).slice(0, 120))
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => localStorage.setItem('clash.device.token', tok), me.token)
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(1500)

  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.35)
  })

  // Wait for the neighbourhood to arrive and render.
  await page.waitForFunction(() => {
    const s = window.__clashGame.scene.keys.MainScene
    return s.worldMap && s.worldMap.views && s.worldMap.views.size >= 8
  }, { timeout: 30000, polling: 500 })
  await sleep(2500)

  // Wide shot: home village live in the middle, neighbours tiled around it.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(0.52)
    const c = { x: (12.5 - 12.5) * 32, y: (12.5 + 12.5) * 16 }
    s.cameras.main.centerOn(c.x, c.y)
  })
  await sleep(600)
  await page.screenshot({ path: `${OUT}world-map.png` })

  const fps = await page.evaluate(() => Math.round(window.__clashGame.loop.actualFps))
  console.log('fps with full 3x3 neighbourhood:', fps)

  // Tap a bot neighbour: the action panel.
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    let target = null
    for (const v of s.worldMap.views.values()) {
      if (v.plot.kind === 'bot') { target = v; break }
    }
    if (target) {
      const dx = target.plot.x - s.worldMap.myPlot.x
      const dy = target.plot.y - s.worldMap.myPlot.y
      s.worldMap.handleTap(dx * 27 + 12, dy * 27 + 12)
      const iso = { x: (dx * 27 + 12 - dy * 27 - 12) * 32, y: (dx * 27 + 12 + dy * 27 + 12) * 16 }
      s.cameras.main.setZoom(1.1)
      s.cameras.main.centerOn(iso.x, iso.y - 40)
    }
  })
  await sleep(500)
  await page.screenshot({ path: `${OUT}world-panel.png` })

  // The live battle: started just-in-time (frameless attacks expire fast),
  // then a forced map refresh picks up the flag.
  const atk = await api('POST', '/attacks/start', { token: nb2.token, body: { targetId: nb1.player.id } })
  console.log('live battle:', atk.attackId ? 'started' : JSON.stringify(atk))
  for (let i = 0; i < 5; i++) {
    await page.evaluate(async () => {
      const s = window.__clashGame.scene.keys.MainScene
      await s.worldMap.refresh()
    })
    await sleep(900)
    const hot = await page.evaluate(() => {
      const s = window.__clashGame.scene.keys.MainScene
      for (const v of s.worldMap.views.values()) if (v.plot.underAttack) return true
      return false
    })
    if (hot) break
  }

  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.worldMap.closePanel()
    let target = null
    for (const v of s.worldMap.views.values()) {
      if (v.plot.underAttack) { target = v; break }
    }
    if (target) {
      const dx = target.plot.x - s.worldMap.myPlot.x
      const dy = target.plot.y - s.worldMap.myPlot.y
      const iso = { x: (dx * 27 + 12 - dy * 27 - 12) * 32, y: (dx * 27 + 12 + dy * 27 + 12) * 16 }
      s.cameras.main.setZoom(1.0)
      s.cameras.main.centerOn(iso.x, iso.y - 30)
    }
  })
  await sleep(500)
  await page.screenshot({ path: `${OUT}world-battle.png` })

  const flagged = await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    for (const v of s.worldMap.views.values()) if (v.plot.underAttack && v.battle) return true
    return false
  })
  console.log('battle indicator rendered:', flagged)
  console.log('world shots done, page errors:', errors.length ? errors.slice(0, 4) : 'none')
} finally {
  await browser.close()
}
