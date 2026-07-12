// Screenshot harness for the defense redesign: builds a showcase world via the
// API, boots the game headless, and captures close-ups of every level of the
// cannon, ballista and x-bow (plus reference buildings) at controlled angles.
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = new URL('./shots/', import.meta.url).pathname
const ANGLE = Number(process.env.ANGLE ?? 0.55) // aim angle for the beauty pass
const TENSION = Number(process.env.TENSION ?? 0)
const RECOIL = Number(process.env.RECOIL ?? 0)
const TAG = process.env.TAG ?? 'se'
const PHASE = process.env.PHASE ? Number(process.env.PHASE) : null

import { mkdirSync } from 'node:fs'
mkdirSync(OUT, { recursive: true })

// Showcase layout: [type, level, gridX, gridY, w, h]
const SHOWCASE = [
  ['cannon', 1, 5, 2, 1, 1],
  ['cannon', 2, 6, 2, 1, 1],
  ['cannon', 3, 10, 2, 1, 1],
  ['cannon', 4, 14, 2, 1, 1],
  ['prism', 1, 18, 2, 1, 1],
  ['prism', 2, 22, 2, 1, 1],
  ['prism', 3, 18, 6, 1, 1],
  ['prism', 4, 22, 6, 1, 1],
  ['frostfall', 4, 2, 7, 2, 2],
  ['ballista', 1, 7, 2, 2, 2],
  ['ballista', 3, 7, 7, 2, 2],
  ['xbow', 1, 2, 12, 2, 2],
  ['xbow', 2, 7, 12, 2, 2],
  ['xbow', 3, 12, 12, 2, 2],
  ['lab', 3, 20, 17, 2, 2],
  ['spike_launcher', 4, 2, 17, 2, 2],
  ['barracks', 5, 7, 17, 2, 2],
  ['barracks', 8, 12, 17, 2, 2],
  ['barracks', 11, 2, 21, 2, 2],
  ['barracks', 13, 7, 21, 2, 2],
  ['dragons_breath', 2, 12, 21, 4, 4],
  ['town_hall', 1, 17, 21, 3, 3],
  ['army_camp', 3, 17, 7, 2, 2],
  ['mortar', 2, 2, 2, 2, 2],
  ['tesla', 2, 21, 2, 1, 1],
  ['frostfall', 2, 2, 7, 2, 2],
  ['mine', 3, 17, 12, 2, 2],
  ['farm', 2, 21, 12, 3, 2],
  ['storage', 1, 15, 16, 2, 2],
  ['storage', 3, 23, 17, 2, 2],
  ['jukebox', 1, 21, 21, 1, 1]
]

async function api(path, body, token) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {})
  })
  return res.json()
}

const session = await api('/auth/session')
const token = session.token

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => {
    localStorage.setItem('clash.device.token', tok)
  }, token)
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 30000 })
  // Wait until the scene exists and has buildings (dev-server recompiles can be slow)
  await page.waitForFunction(
    () => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 45000, polling: 500 }
  )
  // Preview layouts deliberately exceed normal progression/count rules. Put
  // the fixture into the already-booted scene instead of asking production
  // village authority to accept an impossible save.
  await page.evaluate(showcase => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.applyWorldToScene({
      id: 'art-preview',
      ownerId: 'art-preview',
      username: 'ART PREVIEW',
      buildings: showcase.map(([type, level, gridX, gridY], i) => ({
        id: `show_${i}`, type, gridX, gridY, level
      })),
      obstacles: [],
      resources: { gold: 0, ore: 0, food: 0 },
      lastSaveTime: Date.now()
    })
  }, SHOWCASE)
  await page.waitForFunction(
    expected => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length === expected,
    { timeout: 45000, polling: 250 },
    SHOWCASE.length
  )
  await new Promise(r => setTimeout(r, 1500))

  // Pin the day/night clock if requested (e.g. PHASE=0.8 for deep night)
  if (PHASE !== null) {
    await page.evaluate(ph => {
      window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(ph)
    }, PHASE)
    await new Promise(r => setTimeout(r, 2000)) // let the light rigs sync
  }

  // Freeze aim + animation state on every rotating defense
  await page.evaluate(({ angle, tension, recoil }) => {
    const container = document.querySelector('#game-container canvas')
    const game = window.__clashGame
    const scene = game?.scene?.keys?.MainScene
    if (!scene) return 'no scene'
    for (const b of scene.buildings) {
      if (['cannon', 'ballista', 'xbow', 'spike_launcher'].includes(b.type)) {
        b.ballistaAngle = angle
        b.ballistaTargetAngle = undefined
        b.idleTargetAngle = angle
        b.idleSwiveTime = 0
        b.ballistaStringTension = tension
        b.ballistaBoltLoaded = true
        b.cannonRecoilOffset = recoil
      }
    }
    return 'ok'
  }, { angle: ANGLE, tension: TENSION, recoil: RECOIL })

  await new Promise(r => setTimeout(r, 400))

  const waitScene = () => page.waitForFunction(
    () => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 45000, polling: 400 }
  )

  // Close-up of each showcase building
  for (const [type, level, gx, gy, w, h] of SHOWCASE) {
    await waitScene()
    await page.evaluate(({ gx, gy, w, h, angle, tension, recoil }) => {
      const game = window.__clashGame
      const scene = game.scene.keys.MainScene
      const cx = gx + w / 2
      const cy = gy + h / 2
      const isoX = (cx - cy) * 32
      const isoY = (cx + cy) * 16
      scene.cameras.main.setZoom(w >= 4 ? 1.7 : w >= 3 ? 2.1 : w >= 2 ? 3 : 4)
      scene.cameras.main.centerOn(isoX, isoY - 14)
      // re-pin state in case the update loop drifted it
      for (const b of scene.buildings) {
        if (['cannon', 'ballista', 'xbow', 'spike_launcher'].includes(b.type)) {
          b.ballistaAngle = angle
          b.idleTargetAngle = angle
          b.ballistaTargetAngle = undefined
          b.ballistaStringTension = tension
          b.cannonRecoilOffset = recoil
        }
      }
    }, { gx, gy, w, h, angle: ANGLE, tension: TENSION, recoil: RECOIL })
    await new Promise(r => setTimeout(r, 300))
    await page.screenshot({
      path: `${OUT}${type}-L${level}-${TAG}.png`,
      clip: { x: 340, y: 150, width: 600, height: 600 }
    })
  }

  // One wide group shot
  await waitScene()
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.cameras.main.setZoom(1.35)
    scene.cameras.main.centerOn(0, 400)
  })
  await new Promise(r => setTimeout(r, 300))
  await page.screenshot({ path: `${OUT}_group-${TAG}.png` })

  console.log('shots done, page errors:', errors.length ? errors.slice(0, 3) : 'none')
} finally {
  await browser.close()
}
