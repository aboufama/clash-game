// Visual QA for canonical large-troop deaths and candidate-specific Chimera
// deaths/remnants.
// Uses the shared device identity; never mints a guest.
//
//   BASE=http://127.0.0.1:5173 OUT=/tmp/troop-deaths node shoot-troop-deaths.mjs
//   VECTOR=1 ... node shoot-troop-deaths.mjs   # authoring fallback path
//   ONLY=warelephant ... node shoot-troop-deaths.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = (process.env.OUT ?? '/tmp/clash-troop-deaths').replace(/\/$/, '')
const VECTOR = process.env.VECTOR === '1'
const DESIGN = (process.env.DESIGN ?? '').trim()
if (DESIGN && !/^[ABC]$/.test(DESIGN)) throw new Error(`DESIGN must be A, B, or C; got ${DESIGN}`)
const CURATED_TYPES = ['golem', 'icegolem', 'siegetower', 'davincitank', 'trebuchet', 'warelephant']
const requestedTypes = (process.env.ONLY ?? '').split(',').map(type => type.trim()).filter(Boolean)
const TYPES = requestedTypes.length ? requestedTypes : CURATED_TYPES
const unknownTypes = TYPES.filter(type => !CURATED_TYPES.includes(type))
if (unknownTypes.length) throw new Error(`unknown ONLY troop-death type(s): ${unknownTypes.join(', ')}`)
mkdirSync(OUT, { recursive: true })

const tokenFile = new URL('./.shared-device-token.json', import.meta.url).pathname
let cachedToken = null
try { cachedToken = JSON.parse(readFileSync(tokenFile, 'utf8')).token ?? null } catch { /* none */ }
if (!cachedToken) throw new Error('no shared device token — refusing to mint a guest session')
const resumed = await (await fetch(`${BASE}/api/auth/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: cachedToken })
})).json()
if (!resumed?.token) throw new Error(`auth/session resume failed: ${JSON.stringify(resumed)}`)

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(({ token, vector, design, types }) => {
    localStorage.setItem('clash.device.token', token)
    if (vector) localStorage.setItem('clash.sprites.off', '1')
    else localStorage.removeItem('clash.sprites.off')
    if (design) for (const type of types) localStorage.setItem(`clash.design.${type}`, design)
  }, { token: resumed.token, vector: VECTOR, design: DESIGN, types: TYPES })

  const errors = []
  page.on('pageerror', error => errors.push(String(error.message ?? error)))
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 90_000, polling: 500 })
  await sleep(5500)
  if (!VECTOR) {
    const missing = await page.evaluate(types => types.filter(type =>
      !window.__clashBake?.SpriteBank?.backed?.('troop_deaths', type)), TYPES)
    if (missing.length) {
      throw new Error(`baked death QA refused vector fallback; missing troop_deaths atlases: ${missing.join(', ')}`)
    }
    const missingStates = await page.evaluate(types => {
      const bank = window.__clashBake?.SpriteBank
      const missing = []
      for (const type of types) {
        const dirs = type === 'golem' || type === 'icegolem' ? 16 : 8
        const poses = type === 'siegetower' ? ['rolling', 'parked'] : [null]
        for (let level = 1; level <= 3; level++) for (const owner of ['P', 'E']) {
          for (let dir = 0; dir < dirs; dir++) for (const pose of poses) {
            const poseTag = pose ? `_${pose}` : ''
            const variant = `l${level}_${owner}_d${String(dir).padStart(2, '0')}${poseTag}`
            for (const state of ['death', 'remnant']) {
              if (!bank?.hasFigureState?.('troop_deaths', type, variant, state)) {
                missing.push(`${type}:${variant}:${state}`)
              }
            }
          }
        }
      }
      return missing
    }, TYPES)
    if (missingStates.length) {
      throw new Error(`baked death QA refused vector fallback; missing figure states: ${missingStates.slice(0, 12).join(', ')}`)
    }
  }

  const setCamera = () => page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(2.35)
    s.cameras.main.centerOn((12 - 19.5) * 32, (12 + 19.5) * 16 - 18)
  })
  const pause = () => page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  const resume = () => page.evaluate(() => window.__clashGame.scene.resume('MainScene'))
  const shot = (type, terminalPose, phase, tag) => page.screenshot({
    path: `${OUT}/${type}${DESIGN ? `@${DESIGN}` : ''}${terminalPose ? `-${terminalPose}` : ''}-${phase}-${tag}-${VECTOR ? 'vector' : 'baked'}.png`,
    clip: { x: 250, y: 115, width: 780, height: 690 }
  })

  const resetCast = async (type, night, terminalPose) => {
    await resume()
    await page.evaluate(({ type, night, terminalPose }) => {
      const s = window.__clashGame.scene.keys.MainScene
      s.clearBattleFx()
      for (const t of s.troops) {
        t.gameObject?.destroy()
        t.healthBar?.destroy()
      }
      s.troops = []
      s.dayNight.setPhaseOverride(night ? 0.8 : 0.32)
      s.weather.setWeatherOverride(0)
      const cast = [
        [8.5, 19, 'PLAYER', 1, 0.55],
        [12, 19, 'PLAYER', 2, 1.1],
        [15.5, 19, 'PLAYER', 3, 2.5],
        [12, 22, 'ENEMY', 3, 3.8]
      ]
      for (const [x, y, owner, level, facing] of cast) {
        const t = s.spawnTroop(x, y, type, owner, level)
        if (!t) continue
        t.facingAngle = facing
        if (type === 'siegetower') t.parked01 = terminalPose === 'parked' ? 1 : 0
        t.target = null
        t.path = undefined
        s.redrawTroopWithMovement(t, false)
      }
    }, { type, night, terminalPose })
    await setCamera()
    await sleep(night ? 1800 : 650)
    await pause()
  }

  for (const type of TYPES) {
    const terminalPoses = type === 'siegetower' ? ['rolling', 'parked'] : [null]
    for (const terminalPose of terminalPoses) {
      await resetCast(type, false, terminalPose)
      await shot(type, terminalPose, 'day', 'alive')
      await page.evaluate(() => {
        const s = window.__clashGame.scene.keys.MainScene
        for (const t of [...s.troops]) s.destroyTroop(t)
      })
      await shot(type, terminalPose, 'day', 'death-t000')
      const deathSchedule = [[250, 'death-t250'], [350, 'death-t600'], [700, 'remnant']]
      for (const [dt, tag] of deathSchedule) {
        await resume(); await sleep(dt); await pause(); await shot(type, terminalPose, 'day', tag)
      }
      // Prove the terminal art is a battle remnant, not a delayed fade-out.
      await resume(); await sleep(1500); await pause(); await shot(type, terminalPose, 'day', 'remnant-late')

      await resetCast(type, true, terminalPose)
      await page.evaluate(() => {
        const s = window.__clashGame.scene.keys.MainScene
        for (const t of [...s.troops]) s.destroyTroop(t)
      })
      await shot(type, terminalPose, 'night', 'death-t000')
      await resume(); await sleep(600); await pause(); await shot(type, terminalPose, 'night', 'death-t600')
      await resume(); await sleep(700); await pause(); await shot(type, terminalPose, 'night', 'remnant')
    }
  }

  await resume()
  console.log(`troop death shots -> ${OUT}; vector=${VECTOR}; design=${DESIGN || 'default'}; page errors=${errors.length}`)
  if (errors.length) {
    console.error(errors.slice(0, 10).join('\n'))
    process.exitCode = 1
  }
} finally {
  await browser.close()
}
