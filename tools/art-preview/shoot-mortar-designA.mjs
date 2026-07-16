// Capture harness for the MORTAR clean-room design slot A ("Bell Bombard").
// Boots the live dev server headless with sprites OFF and design slot A
// forced, builds a 4-level mortar showcase, and captures: per-level day,
// night, idle-motion bursts, aim angles, and the fire sequence.
// Output goes to the session scratchpad (NOT tools/art-preview/shots).
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5175'
const OUT = process.env.OUT ?? '/private/tmp/claude-502/-Users-andreboufama-Documents-MISC-clash-game/f13e406c-e748-4400-8c7a-619d26e0c829/scratchpad/tournament/mortar-A/raw/'
mkdirSync(OUT, { recursive: true })

// [type, level, gridX, gridY]
const SHOWCASE = [
  ['mortar', 1, 8, 8],
  ['mortar', 2, 14, 8],
  ['mortar', 3, 8, 14],
  ['mortar', 4, 14, 14],
]

async function api(path, body, token) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {})
  })
  return res.json()
}

// Resume the ONE shared art-preview identity (never mint new guests).
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
    localStorage.setItem('clash.sprites.off', '1')   // live vector authoring path
    localStorage.setItem('clash.design.mortar', 'A') // MY design slot
  }, token)
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForFunction(
    () => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 90000, polling: 500 }
  )
  const applyFixture = async () => {
    const types = await page.evaluate(showcase => {
      const scene = window.__clashGame.scene.keys.MainScene
      const current = scene.buildings.map(b => b.type).join(',')
      if (current !== showcase.map(s => s[0]).join(',')) {
        scene.applyWorldToScene({
          id: 'art-preview', ownerId: 'art-preview', username: 'ART PREVIEW',
          buildings: showcase.map(([type, level, gridX, gridY], i) => ({ id: `show_${i}`, type, gridX, gridY, level })),
          obstacles: [],
          resources: { gold: 0, ore: 0, food: 0 },
          lastSaveTime: Date.now()
        })
      }
      return scene.buildings.map(b => `${b.type}L${b.level}@${b.gridX},${b.gridY}`).join(' ')
    }, SHOWCASE)
    return types
  }
  await applyFixture()
  await new Promise(r => setTimeout(r, 2500))
  console.log('fixture:', await applyFixture())

  const focus = (gx, gy, zoom = 3) => page.evaluate(({ gx, gy, zoom }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const cx = gx + 1, cy = gy + 1 // 2x2 center
    scene.cameras.main.setZoom(zoom)
    scene.cameras.main.centerOn((cx - cy) * 32, (cx + cy) * 16 - 14)
  }, { gx, gy, zoom })

  let currentAim = 0.55
  const setAim = async angle => {
    currentAim = angle
    await page.evaluate(a => {
      const scene = window.__clashGame.scene.keys.MainScene
      for (const b of scene.buildings) if (b.type === 'mortar') b.ballistaAngle = a
    }, angle)
  }

  const setPhase = ph => page.evaluate(p => {
    window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(p)
  }, ph)

  const rawShot = name => page.screenshot({ path: `${OUT}${name}.png`, clip: { x: 340, y: 150, width: 600, height: 600 } })
  const shot = async name => {
    await applyFixture()
    await page.evaluate(a => {
      const scene = window.__clashGame.scene.keys.MainScene
      for (const b of scene.buildings) if (b.type === 'mortar') b.ballistaAngle = a
    }, currentAim)
    await rawShot(name)
  }

  // ---- DAY, per level, aim SE ----
  await setPhase(0.3)
  await new Promise(r => setTimeout(r, 1200))
  await setAim(0.55)
  await new Promise(r => setTimeout(r, 200))
  for (const [type, level, gx, gy] of SHOWCASE) {
    await focus(gx, gy)
    await new Promise(r => setTimeout(r, 250))
    await shot(`day-L${level}`)
  }

  // ---- Group shot (all four levels) ----
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.cameras.main.setZoom(1.9)
    scene.cameras.main.centerOn(0, 23 * 16 + 16)
  })
  await new Promise(r => setTimeout(r, 250))
  await page.screenshot({ path: `${OUT}group-day.png`, clip: { x: 190, y: 80, width: 900, height: 740 } })

  // ---- Idle motion burst: L4, 8 frames x 250 ms (one 2000 ms loop) ----
  await focus(14, 14, 3.6)
  await new Promise(r => setTimeout(r, 250))
  for (let i = 0; i < 8; i++) {
    await shot(`idle-L4-t${i}`)
    await new Promise(r => setTimeout(r, 250))
  }

  // ---- Aim angles on L4 (incl. sin<0 up-screen) ----
  for (const [tag, a] of [['e', 0.06], ['se', 0.9], ['s', 1.55], ['w', Math.PI + 0.15], ['nw', -2.35], ['n', -1.5]]) {
    await setAim(a)
    await new Promise(r => setTimeout(r, 200))
    await shot(`aim-${tag}-L4`)
  }

  // ---- Fire sequence on L4 (age pinned relative to scene clock) ----
  await setAim(0.55)
  const fireShot = async (name, ageMs) => {
    await applyFixture()
    await page.evaluate(({ off, aim }) => {
      const scene = window.__clashGame.scene.keys.MainScene
      for (const b of scene.buildings) if (b.type === 'mortar') {
        b.ballistaAngle = aim
        if (b.level === 4) b.lastFireTime = scene.time.now - off
      }
    }, { off: ageMs, aim: currentAim })
    await rawShot(name)
    await page.evaluate(() => {
      const scene = window.__clashGame.scene.keys.MainScene
      for (const b of scene.buildings) if (b.type === 'mortar') b.lastFireTime = undefined
    })
    await new Promise(r => setTimeout(r, 120))
  }
  // flash trick: lastFireTime slightly in the future -> age clamps to 0
  await fireShot('fire-1-flash', -140)
  await fireShot('fire-2-recoil', 60)
  await fireShot('fire-3-spring', 200)
  await fireShot('fire-4-glow', 400)
  await fireShot('fire-5-reload-a', 1000)
  await fireShot('fire-6-reload-b', 1150)
  await fireShot('fire-7-seat', 1400)

  // ---- NIGHT ----
  await setPhase(0.8)
  await new Promise(r => setTimeout(r, 1800))
  await focus(14, 14, 3.4)
  await new Promise(r => setTimeout(r, 250))
  await shot('night-L4')
  await focus(8, 8, 3.4)
  await new Promise(r => setTimeout(r, 250))
  await shot('night-L1')

  console.log('done, page errors:', errors.length ? errors.slice(0, 3) : 'none')
} finally {
  await browser.close()
}
