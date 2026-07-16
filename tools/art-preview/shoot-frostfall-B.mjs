// Clean-room designer B verification harness for the FROSTFALL redesign.
// Own headless page (cribbed from shoot-defenses.mjs): pins design slot B +
// vector rendering, places all 4 levels, shoots idle (day/night), an idle
// burst across the 2000 ms ambient loop, and the staged fire sequence.
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5175'
const OUT = process.env.OUT ?? '/private/tmp/claude-scratch-design-tournament/frostfall-B/work/'
const PHASE = process.env.PHASE ? Number(process.env.PHASE) : null
const TAG = process.env.TAG ?? 'day'
const MODE = process.env.MODE ?? 'levels' // levels | burst | fire
mkdirSync(OUT, { recursive: true })

const SHOWCASE = [
  ['frostfall', 1, 4, 4, 2, 2],
  ['frostfall', 2, 10, 4, 2, 2],
  ['frostfall', 3, 16, 4, 2, 2],
  ['frostfall', 4, 10, 10, 2, 2]
]

async function api(path, body, token) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {})
  })
  return res.json()
}

// ALWAYS resume the shared art-preview identity (guest creation is limited).
const TOKEN_CACHE = new URL('./.shared-device-token.json', import.meta.url).pathname
let cachedToken = null
try { cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null } catch { /* no cache */ }
const session = await api('/auth/session', cachedToken ? { token: cachedToken } : {})
if (!session?.token) throw new Error(`auth/session failed: ${JSON.stringify(session)}`)
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
  await page.evaluateOnNewDocument(tok => {
    localStorage.setItem('clash.device.token', tok)
    localStorage.setItem('clash.sprites.off', '1')     // vector authoring view
    localStorage.setItem('clash.design.frostfall', 'B') // MY slot, explicitly
  }, token)
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForFunction(
    () => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 90000, polling: 500 }
  )
  await page.evaluate(showcase => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.applyWorldToScene({
      id: 'art-preview', ownerId: 'art-preview', username: 'ART PREVIEW',
      buildings: showcase.map(([type, level, gridX, gridY], i) => ({ id: `show_${i}`, type, gridX, gridY, level })),
      obstacles: [],
      resources: { gold: 0, ore: 0, food: 0 },
      lastSaveTime: Date.now()
    })
  }, SHOWCASE)
  await page.waitForFunction(
    n => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length === n,
    { timeout: 45000, polling: 250 }, SHOWCASE.length
  )
  await new Promise(r => setTimeout(r, 2500))

  const waitScene = async () => {
    await page.waitForFunction(
      () => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
      { timeout: 45000, polling: 400 }
    )
    // A dev-server HMR reload (parallel sessions) can reboot the scene into
    // the real village — re-apply the showcase fixture whenever it is gone.
    const ok = await page.evaluate(() =>
      window.__clashGame.scene.keys.MainScene.buildings.filter(b => b.type === 'frostfall').length >= 4)
    if (!ok) {
      await page.evaluate(showcase => {
        const scene = window.__clashGame.scene.keys.MainScene
        scene.applyWorldToScene({
          id: 'art-preview', ownerId: 'art-preview', username: 'ART PREVIEW',
          buildings: showcase.map(([type, level, gridX, gridY], i) => ({ id: `show_${i}`, type, gridX, gridY, level })),
          obstacles: [],
          resources: { gold: 0, ore: 0, food: 0 },
          lastSaveTime: Date.now()
        })
      }, SHOWCASE)
      await page.waitForFunction(
        n => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length === n,
        { timeout: 45000, polling: 250 }, SHOWCASE.length
      )
      await new Promise(r => setTimeout(r, 1500))
      if (PHASE !== null) {
        await page.evaluate(ph => {
          window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(ph)
        }, PHASE)
        await new Promise(r => setTimeout(r, 1500))
      }
    }
  }

  if (PHASE !== null) {
    await waitScene()
    await page.evaluate(ph => {
      window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(ph)
    }, PHASE)
    await new Promise(r => setTimeout(r, 2000))
  }

  const focus = async (gx, gy, w, h) => {
    await waitScene()
    await page.evaluate(({ gx, gy, w, h }) => {
      const scene = window.__clashGame.scene.keys.MainScene
      const cx = gx + w / 2, cy = gy + h / 2
      scene.cameras.main.setZoom(3)
      scene.cameras.main.centerOn((cx - cy) * 32, (cx + cy) * 16 - 14)
    }, { gx, gy, w, h })
    await new Promise(r => setTimeout(r, 300))
  }
  const shoot = name => page.screenshot({
    path: `${OUT}${name}.png`, clip: { x: 340, y: 150, width: 600, height: 600 }
  })

  if (MODE === 'levels') {
    for (const [type, level, gx, gy, w, h] of SHOWCASE) {
      await focus(gx, gy, w, h)
      await shoot(`${type}-L${level}-${TAG}`)
    }
  }

  if (MODE === 'burst') {
    // 8 frames × 250 ms = one full 2000 ms ambient period on the L4 well
    const [, level, gx, gy, w, h] = SHOWCASE[3]
    await focus(gx, gy, w, h)
    for (let i = 0; i < 8; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 250))
      await shoot(`burst-L${level}-${TAG}-t${i}`)
    }
  }

  if (MODE === 'fire') {
    // Stage the prep/launch/settle on the L3 well by pinning lastFireTime.
    // [fireAge ms, projectileActive] — active only during the 4200..4800 flight.
    const STAGES = [
      [300, false], [1500, false], [2400, false], [2900, false],
      [3500, false], [3850, false], [4150, false],
      [4230, true], [4400, true], [4590, true]
    ]
    const idx = Number(process.env.FIRE_LEVEL ?? 3) - 1
    const [, level, gx, gy, w, h] = SHOWCASE[idx]
    await focus(gx, gy, w, h)
    for (const [age, active] of STAGES) {
      await waitScene()
      await page.evaluate(({ age, active, level }) => {
        const scene = window.__clashGame.scene.keys.MainScene
        const b = scene.buildings.find(b => b.type === 'frostfall' && b.level === level)
        if (!b) return
        const now = scene.animClockNow ? scene.animClockNow() : scene.time.now
        b.lastFireTime = now - (age - 260) // compensate the settle delay below
        b.frostfallProjectileActive = active
      }, { age, active, level })
      await new Promise(r => setTimeout(r, 260))
      await shoot(`fire-L${level}-${TAG}-a${String(age).padStart(4, '0')}${active ? '-proj' : ''}`)
    }
    // restore the ready pose
    await page.evaluate(level => {
      const scene = window.__clashGame.scene.keys.MainScene
      const b = scene.buildings.find(b => b.type === 'frostfall' && b.level === level)
      delete b.lastFireTime
      b.frostfallProjectileActive = false
    }, level)
  }

  console.log('done, page errors:', errors.length ? errors.slice(0, 3) : 'none')
} finally {
  await browser.close()
}
