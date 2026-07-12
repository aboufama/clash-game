// Village-life verification: forces each micro-story on camera and screenshots it.
// Needs `npm run dev` on :5173. Shots land in ./shots/life-*.png
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = new URL('./shots/', import.meta.url).pathname

const session = await (await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const token = session.token
const world = session.world
// A cozy test hamlet: hall, houses, farm, mine, storage, jukebox — life needs places to live.
world.buildings = [
  { id: 'L1', type: 'town_hall', gridX: 11, gridY: 10, level: 1 },
  { id: 'L2', type: 'barracks', gridX: 7, gridY: 11, level: 5 },
  { id: 'L3', type: 'farm', gridX: 15, gridY: 11, level: 2 },
  { id: 'L4', type: 'mine', gridX: 8, gridY: 15, level: 3 },
  { id: 'L5', type: 'storage', gridX: 15, gridY: 15, level: 2 },
  { id: 'L6', type: 'jukebox', gridX: 12, gridY: 15, level: 1 },
  { id: 'L7', type: 'army_camp', gridX: 11, gridY: 18, level: 2 }
]
await fetch(`${BASE}/api/world/save`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ world, requestId: 'life-showcase' })
})

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => localStorage.setItem('clash.device.token', tok), token)
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(2000)

  const on = (fn, arg) => page.evaluate(fn, arg)

  // ---------- DAY ----------
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.35)
    s.cameras.main.setZoom(1.8)
    s.cameras.main.centerOn(32, 420)
  })
  await sleep(1200)

  // 1. Worn paths: paint a well-trodden route between hall, mine and storehouse.
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const vl = s.villageLife
    const m = s.mapSize
    const stamp = (x, y, h) => { vl.pathHeat[y * m + x] = h }
    for (let x = 9; x <= 16; x++) stamp(x, 13, x % 2 ? 0.85 : 0.7)   // main street
    for (let y = 13; y <= 17; y++) stamp(9, y, 0.6)                   // fork to the mine
    for (let y = 11; y <= 13; y++) stamp(12, y, 0.45)                 // to the hall door
    for (let y = 13; y <= 16; y++) stamp(16, y, 0.35)                 // to the storehouse
    vl.pathsDirty = true
    vl.nextPathRedrawAt = 0
  })
  await sleep(700)
  await page.screenshot({ path: `${OUT}life-paths.png` })

  // 2. Cloud shade: park one cloud right over the village.
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const vl = s.villageLife
    if (vl.clouds.length) {
      vl.clouds[0].x = 11
      vl.clouds[0].y = 11
      vl.clouds[0].scale = 4.2
    }
  })
  await sleep(400)
  await page.screenshot({ path: `${OUT}life-clouds.png` })

  // 3. A chance encounter: stand two villagers together and let the scan find them.
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const vl = s.villageLife
    const folk = vl.entities.filter(e => e.kind === 'villager' && !e.child && e.state !== 'inside')
    if (folk.length >= 2) {
      const [a, b] = folk
      a.x = 12.2; a.y = 13.4; a.state = 'idle'; a.path = null; a.workUntil = undefined; a.chatCooldownUntil = 0
      b.x = 13.0; b.y = 13.6; b.state = 'idle'; b.path = null; b.workUntil = undefined; b.chatCooldownUntil = 0
      a.stateUntil = b.stateUntil = s.time.now + 20000
      vl.placeGfx(a)
      vl.placeGfx(b)
      vl.nextChatScanAt = 0
    }
    s.cameras.main.setZoom(3.2)
    const iso = { x: (12.6 - 13.5) * 32, y: (12.6 + 13.5) * 16 }
    s.cameras.main.centerOn(iso.x, iso.y - 8)
  })
  await sleep(2600)
  await page.screenshot({ path: `${OUT}life-chat.png` })

  // 4. The merchant arrives in person (and shoppers drift over).
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.villageLife.nextMerchantAt = 1
    s.cameras.main.setZoom(2.0)
    const iso = { x: (13 - 13) * 32, y: (13 + 13) * 16 }
    s.cameras.main.centerOn(iso.x, iso.y)
  })
  await sleep(16000)
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const m = s.villageLife.merchant
    if (m) {
      const iso = { x: (m.x - m.y) * 32, y: (m.x + m.y) * 16 }
      s.cameras.main.centerOn(iso.x, iso.y - 10)
    }
  })
  await sleep(400)
  await page.screenshot({ path: `${OUT}life-merchant.png` })

  // ---------- NIGHT ----------
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.8)
  })
  await sleep(3000)

  // 5. Festival at the jukebox (forced roll) + fireflies + moths.
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const vl = s.villageLife
    const dancers = vl.entities.filter(e => e.kind === 'villager' && !e.child && e.state !== 'gone')
    for (const d of dancers.slice(0, 4)) {
      if (d.state === 'inside') { d.state = 'idle'; d.hiddenUntil = 0; d.gfx.setVisible(true); d.gfx.setAlpha(1) }
      d.sleeping = false
    }
    const rnd = Math.random
    Math.random = () => 0.01 // force the festival roll
    vl.festivalOn = false
    vl.maybeStartFestival(s.time.now, dancers)
    Math.random = rnd
    const iso = { x: (13.5 - 16.5) * 32, y: (13.5 + 16.5) * 16 }
    s.cameras.main.setZoom(2.6)
    s.cameras.main.centerOn(iso.x, iso.y - 10)
  })
  await sleep(7000)
  await page.screenshot({ path: `${OUT}life-festival.png` })

  // 6. The storehouse thief creeps in; camera follows him.
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.villageLife.nextThiefAt = s.time.now + 100
  })
  await sleep(9000)
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const t = s.villageLife.thief
    if (t) {
      const iso = { x: (t.x - t.y) * 32, y: (t.x + t.y) * 16 }
      s.cameras.main.setZoom(3.0)
      s.cameras.main.centerOn(iso.x, iso.y)
    }
  })
  await sleep(400)
  await page.screenshot({ path: `${OUT}life-thief.png` })

  // 7. Dawn: the elder feeds the chickens.
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.35)
  })
  await sleep(2500)
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.villageLife.feedPlan = { at: s.time.now + 300, stage: 'wait' }
  })
  await sleep(16000)
  await on(() => {
    const s = window.__clashGame.scene.keys.MainScene
    const spot = s.villageLife.feedSpot ?? (() => {
      const elderId = s.villageLife.feedPlan?.elderId
      const elder = s.villageLife.entities.find(e => e.id === elderId)
      return elder ? { x: elder.x, y: elder.y } : null
    })()
    if (spot) {
      const iso = { x: (spot.x - spot.y) * 32, y: (spot.x + spot.y) * 16 }
      s.cameras.main.setZoom(3.0)
      s.cameras.main.centerOn(iso.x, iso.y - 6)
    }
  })
  await sleep(400)
  await page.screenshot({ path: `${OUT}life-feeding.png` })

  console.log('life shots done, page errors:', errors.length ? errors.slice(0, 4) : 'none')
} finally {
  await browser.close()
}
