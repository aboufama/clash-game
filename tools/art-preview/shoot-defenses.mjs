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
// VECTOR=1 → set the SpriteBank kill switch so the live VECTOR art renders
// (authoring iteration); ONLY=<type,type> filters the close-up loop;
// BURST=<n> takes n screenshots per building spaced BURST_MS apart so an
// idle loop's motion is visible across the series.
const VECTOR = process.env.VECTOR === '1'
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(s => s.trim()) : null
const BURST = Math.max(1, Number(process.env.BURST ?? 1))
const BURST_MS = Number(process.env.BURST_MS ?? 350)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  ['ballista', 1, 7, 2, 2, 2],
  ['ballista', 3, 7, 7, 2, 2],
  ['xbow', 1, 2, 12, 2, 2],
  ['xbow', 2, 7, 12, 2, 2],
  ['xbow', 3, 12, 12, 2, 2],
  ['lab', 3, 20, 17, 2, 2],
  ['spike_launcher', 4, 2, 17, 2, 2],
  // Representative mastery looks; shoot-faction-barracks.mjs covers all
  // 27 faction/level combinations, doors, motion, and day/night.
  ['barracks', 9, 7, 17, 2, 2],
  ['mystic_barracks', 9, 2, 21, 2, 2],
  ['dragons_breath', 2, 12, 21, 4, 4],
  ['dragons_breath', 1, 13, 4, 4, 4],
  ['town_hall', 1, 17, 21, 3, 3],
  ['army_camp', 3, 17, 7, 2, 2],
  ['mortar', 2, 2, 2, 2, 2],
  ['mortar', 1, 5, 7, 2, 2],
  ['mortar', 3, 19, 2, 2, 2],
  ['mortar', 4, 12, 7, 2, 2],
  ['ballista', 2, 10, 7, 2, 2],
  ['spike_launcher', 1, 10, 17, 2, 2],
  ['spike_launcher', 2, 10, 21, 2, 2],
  ['spike_launcher', 3, 12, 2, 2, 2],
  ['tesla', 2, 21, 2, 1, 1],
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

// ONE shared art-preview identity for every harness run on this machine:
// resuming a cached token bypasses the guest-creation rate limit (30/hour)
// and stops screenshot/bake runs from littering the world map with junk
// guest villages. Delete the cache file to mint a fresh identity.
const TOKEN_CACHE = new URL('./.shared-device-token.json', import.meta.url).pathname
let cachedToken = null
try { cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null } catch { /* no cache yet */ }
const session = await api('/auth/session', cachedToken ? { token: cachedToken } : {})
if (!session?.token) {
  throw new Error(`auth/session failed: ${JSON.stringify(session)} — if this is the 429 guest limit, wait for the window to roll (≤1h) and re-run; the first success re-seeds ${TOKEN_CACHE}`)
}
const token = session.token
try { writeFileSync(TOKEN_CACHE, JSON.stringify({ token })) } catch { /* non-fatal */ }

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument((tok, vector) => {
    localStorage.setItem('clash.device.token', tok)
    if (vector) localStorage.setItem('clash.sprites.off', '1')
    else localStorage.removeItem('clash.sprites.off')
  }, token, VECTOR)
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message)))
  // domcontentloaded + the scene waitForFunction below: networkidle2 flakes
  // when several harnesses share one dev server and Vite is mid-transform.
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  // Wait until the scene exists and has buildings (dev-server recompiles can be slow)
  await page.waitForFunction(
    () => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 90000, polling: 500 }
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
  await new Promise(r => setTimeout(r, 3000))

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
    if (ONLY && !ONLY.includes(type)) continue
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
    for (let shot = 0; shot < BURST; shot++) {
      if (shot > 0) await new Promise(r => setTimeout(r, BURST_MS))
      await page.screenshot({
        path: `${OUT}${type}-L${level}-${TAG}${BURST > 1 ? `-t${shot}` : ''}.png`,
        clip: { x: 340, y: 150, width: 600, height: 600 }
      })
    }
  }

  // One wide group shot (skipped when ONLY filters the run)
  if (!ONLY) {
    await waitScene()
    await page.evaluate(() => {
      const scene = window.__clashGame.scene.keys.MainScene
      scene.cameras.main.setZoom(1.35)
      scene.cameras.main.centerOn(0, 400)
    })
    await new Promise(r => setTimeout(r, 300))
    await page.screenshot({ path: `${OUT}_group-${TAG}.png` })
  }

  console.log('shots done, page errors:', errors.length ? errors.slice(0, 3) : 'none')
} finally {
  await browser.close()
}
