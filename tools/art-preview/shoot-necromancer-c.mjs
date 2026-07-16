// Designer-C verification harness for the NECROMANCER + SKELETON pair
// (clean-room design tournament — slot C, "The Gravedigger" / "The Exhumed").
//
// Two capture modes in one run:
//  1. RT montages via __clashBake: pinned-time frame series (idle loop, walk
//     stride, attack ritual, skeleton headings), nearest-upscaled 5x.
//  2. In-scene shots: level row, enemy palette, day + night, posed ritual.
//
// Uses the ONE shared harness identity (.shared-device-token.json) — never
// mints guests. Designs are selected pre-boot via localStorage.
//
//   BASE=http://127.0.0.1:5175 OUT=<dir> node shoot-necromancer-c.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5175'
const OUT = (process.env.OUT ?? new URL('./shots/necromancer-c', import.meta.url).pathname).replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

const token = JSON.parse(readFileSync(new URL('./.shared-device-token.json', import.meta.url), 'utf8')).token
const write64 = (path, dataURL) => writeFileSync(path, Buffer.from(dataURL.split(',')[1], 'base64'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

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
    localStorage.setItem('clash.sprites.off', '1')
    localStorage.setItem('clash.design.necromancer', 'C')
    localStorage.setItem('clash.design.skeleton', 'C')
  }, token)
  page.on('pageerror', e => console.log('PAGE ERROR:', String(e.message).slice(0, 200)))
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(2500)

  // ---------------- RT montages (pinned time — exact poses) ----------------
  const montage = (type, level, owner, jobs, scale = 5) => page.evaluate(
    async ({ type, level, owner, jobs, scale }) => {
      const B = window.__clashBake
      const scene = B.scene
      const minX = -32, maxX = 32, minY = -38, maxY = 20
      const W = maxX - minX, H = maxY - minY
      const rt = scene.make.renderTexture({ x: 0, y: 0, width: W, height: H }, false)
      const cells = []
      for (const f of jobs) {
        const g = scene.make.graphics({ x: 0, y: 0 }, false)
        B.TroopRenderer.drawTroopVisual(
          g, type, owner, f.facing ?? 0.45, !!f.isMoving, 0, 0, false, 0,
          level, f.time ?? 1000, f.attackAge ?? -1, f.attackDelay ?? 0)
        rt.clear(); rt.draw(g, -minX, -minY)
        const dataURL = await new Promise(res => rt.snapshot(img => res(img.src)))
        g.destroy()
        const img = new Image()
        await new Promise(r => { img.onload = r; img.src = dataURL })
        cells.push(img)
      }
      rt.destroy()
      const cv = document.createElement('canvas')
      cv.width = W * scale * jobs.length; cv.height = H * scale
      const ctx = cv.getContext('2d')
      ctx.imageSmoothingEnabled = false
      ctx.fillStyle = '#2c3d26'
      ctx.fillRect(0, 0, cv.width, cv.height)
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'
      cells.forEach((img, i) => {
        ctx.drawImage(img, i * W * scale, 0, W * scale, H * scale)
        ctx.strokeRect(i * W * scale + 0.5, 0.5, W * scale - 1, H * scale - 1)
      })
      return cv.toDataURL('image/png')
    }, { type, level, owner, jobs, scale })

  const idleJobs = n => Array.from({ length: n }, (_, k) => ({ time: 1000 + Math.round(k * 2000 / n) }))
  const walkJobs = (n, stride) => Array.from({ length: n }, (_, k) => ({ time: Math.round(k * stride / n), isMoving: true }))
  const atkJobs = (delay, windup, strike) => [
    ...[0, 0.4, 0.7, 0.95].map(w => ({ attackAge: Math.round(delay - windup * (1 - w)), attackDelay: delay })),
    ...[0.85, 0.5, 0.15].map(s => ({ attackAge: Math.round(strike * (1 - s)), attackDelay: delay }))
  ]

  // Necromancer: idle loop / walk stride / ritual attack, per level + enemy
  for (const lvl of [1, 2, 3]) {
    write64(`${OUT}/necroC-L${lvl}-idle.png`, await montage('necromancer', lvl, 'PLAYER', idleJobs(8)))
    write64(`${OUT}/necroC-L${lvl}-walk.png`, await montage('necromancer', lvl, 'PLAYER', walkJobs(6, 480)))
    write64(`${OUT}/necroC-L${lvl}-attack.png`, await montage('necromancer', lvl, 'PLAYER', atkJobs(1600, 700, 400)))
  }
  write64(`${OUT}/necroC-L2-enemy-idle.png`, await montage('necromancer', 2, 'ENEMY', idleJobs(4)))

  // Skeleton: idle / walk / attack at the canonical facing, then 8 headings
  for (const lvl of [1, 2, 3]) {
    write64(`${OUT}/skelC-L${lvl}-idle.png`, await montage('skeleton', lvl, 'PLAYER', idleJobs(8)))
    write64(`${OUT}/skelC-L${lvl}-walk.png`, await montage('skeleton', lvl, 'PLAYER', walkJobs(6, 300)))
    write64(`${OUT}/skelC-L${lvl}-attack.png`, await montage('skeleton', lvl, 'PLAYER', atkJobs(900, 260, 150)))
  }
  write64(`${OUT}/skelC-L1-enemy-idle.png`, await montage('skeleton', 1, 'ENEMY', idleJobs(4)))
  const dirs8 = Array.from({ length: 8 }, (_, d) => (d / 8) * Math.PI * 2)
  write64(`${OUT}/skelC-dirs-idle.png`, await montage('skeleton', 1, 'PLAYER', dirs8.map(f => ({ facing: f }))))
  write64(`${OUT}/skelC-dirs-walk.png`, await montage('skeleton', 1, 'PLAYER', dirs8.map(f => ({ facing: f, isMoving: true, time: 100 }))))
  write64(`${OUT}/skelC-dirs-strike.png`, await montage('skeleton', 1, 'PLAYER', dirs8.map(f => ({ facing: f, attackAge: 30, attackDelay: 900 }))))
  write64(`${OUT}/skelC-dirs-windup.png`, await montage('skeleton', 1, 'PLAYER', dirs8.map(f => ({ facing: f, attackAge: 860, attackDelay: 900 }))))

  // close-ups (scale 9): key poses for detail review
  write64(`${OUT}/necroC-L3-closeup.png`, await montage('necromancer', 3, 'PLAYER', [
    { time: 1500 }, { time: 2000 }, { isMoving: true, time: 120 },
    { attackAge: 1390, attackDelay: 1600 }, { attackAge: 1565, attackDelay: 1600 }, { attackAge: 60, attackDelay: 1600 }, { attackAge: 240, attackDelay: 1600 }
  ], 9))
  write64(`${OUT}/necroC-L1-closeup.png`, await montage('necromancer', 1, 'PLAYER', [
    { time: 1500 }, { isMoving: true, time: 120 }, { attackAge: 1565, attackDelay: 1600 }, { attackAge: 60, attackDelay: 1600 }
  ], 9))
  write64(`${OUT}/skelC-L1-closeup.png`, await montage('skeleton', 1, 'PLAYER', [
    { time: 1500 }, { time: 2000 }, { isMoving: true, time: 75 },
    { attackAge: 850, attackDelay: 900 }, { attackAge: 25, attackDelay: 900 }, { attackAge: 100, attackDelay: 900 }
  ], 9))
  write64(`${OUT}/skelC-L3-closeup.png`, await montage('skeleton', 3, 'PLAYER', [
    { time: 1500 }, { isMoving: true, time: 75 }, { attackAge: 850, attackDelay: 900 }, { attackAge: 25, attackDelay: 900 }
  ], 9))

  // ---------------- in-scene shots (context, lighting, scale) ----------------
  // Fresh boot first: parallel sessions HMR-reload the page mid-run; a clean
  // goto + readiness wait right before the scene phase dodges the stale state.
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(2500)
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather?.setWeatherOverride?.(0)
    const cast = [
      ['necromancer', 9.6, 15, 'PLAYER', 1], ['necromancer', 11.2, 15, 'PLAYER', 2], ['necromancer', 12.8, 15, 'PLAYER', 3],
      ['skeleton', 9.4, 17.4, 'PLAYER', 1], ['skeleton', 10.6, 17.4, 'PLAYER', 2], ['skeleton', 11.8, 17.4, 'PLAYER', 3],
      ['warrior', 14.2, 15, 'PLAYER', 1], // scale reference
      ['necromancer', 9.5, 20, 'ENEMY', 2], ['skeleton', 11, 20.2, 'ENEMY', 2]
    ]
    for (const [type, x, y, owner, lvl] of cast) s.spawnTroop(x, y, type, owner, lvl)
    for (const t of s.troops) { t.target = null; t.path = undefined; t.facingAngle = 0.45 }
    window.__T = (type, idx = 0) => s.troops.filter(t => t.type === type)[idx]
  })
  await sleep(900)
  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const shot = name => page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 340, y: 150, width: 600, height: 600 } })
  const pause = () => page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  const resume = () => page.evaluate(() => window.__clashGame.scene.resume('MainScene'))

  await pause()
  const poseAll = mode => page.evaluate((mode) => {
    const s = window.__clashGame.scene.keys.MainScene
    for (const t of s.troops) {
      t.lastAttackTime = -1e7
      s.redrawTroopWithMovement(t, mode === 'walk')
    }
  }, mode)
  const setPose = (type, ms, idx = 0, ang = 0.45) => page.evaluate(({ type, ms, idx, ang }) => {
    const s = window.__clashGame.scene.keys.MainScene
    const t = window.__T(type, idx)
    if (!t) return `missing ${type}`
    t.facingAngle = ang
    const D = t.attackDelay || 1000
    t.lastAttackTime = ms < 0 ? s.time.now - (D + ms) : s.time.now - ms
    s.redrawTroopWithMovement(t, false)
    return 'ok'
  }, { type, ms, idx, ang })

  await poseAll('idle')
  await cam(11.2, 15.2, 3.1, -8); await shot('scene-necro-levels-day')
  await cam(10.6, 17.5, 4.2, -6); await shot('scene-skel-levels-day')
  await cam(10.2, 20.1, 3.4, -8); await shot('scene-enemy-pair-day')
  await cam(13.5, 15, 4.4, -8); await shot('scene-necro-vs-warrior-scale')

  // ritual poses in scene
  console.log(await setPose('necromancer', -80, 1))   // deep windup (w≈0.89)
  console.log(await setPose('necromancer', 60, 2))    // slam strike (s=0.85)
  await cam(12, 15.2, 3.6, -10); await shot('scene-necro-windup-and-slam')
  console.log(await setPose('skeleton', 25, 1, 0.45)) // skeleton strike
  await cam(10.6, 17.5, 4.2, -6); await shot('scene-skel-strike')

  // night pass
  await resume()
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.8)
  })
  await sleep(700)
  await pause()
  await poseAll('idle')
  await cam(11.2, 15.2, 3.1, -8); await shot('scene-necro-levels-night')
  await cam(10.6, 17.5, 4.2, -6); await shot('scene-skel-levels-night')
  await resume()

  console.log('necromancer-C shots →', OUT)
} finally {
  await browser.close()
}
