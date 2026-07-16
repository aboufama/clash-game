// FINAL VISUAL SIGN-OFF harness for the five unreviewed tournament slots:
//   clockworkbeetle A, necromancer A (+ skeleton A), quartermaster A,
//   physicianscart C, trebuchet C.
// Montage phase: pinned-time frame series through window.__clashBake
// (exact phases, nearest-upscaled). Scene phase: level rows day + night.
// Shared identity only; designs selected pre-boot; sprites.off pre-boot.
//
//   BASE=http://127.0.0.1:5175 OUT=<dir> node shoot-signoff-five.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5175'
const OUT = (process.env.OUT ?? new URL('./shots/signoff-five', import.meta.url).pathname).replace(/\/$/, '')
for (const d of ['clockworkbeetle', 'necromancer', 'skeleton', 'quartermaster', 'physicianscart', 'trebuchet', 'scene']) {
  mkdirSync(`${OUT}/${d}`, { recursive: true })
}

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
    localStorage.setItem('clash.design.clockworkbeetle', 'A')
    localStorage.setItem('clash.design.necromancer', 'A')
    localStorage.setItem('clash.design.skeleton', 'A')
    localStorage.setItem('clash.design.quartermaster', 'A')
    localStorage.setItem('clash.design.physicianscart', 'C')
    localStorage.setItem('clash.design.trebuchet', 'C')
  }, token)
  page.on('pageerror', e => console.log('PAGE ERROR:', String(e.message).slice(0, 240)))

  const boot = async () => {
    await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 60000, polling: 500 })
    await sleep(2500)
  }
  await boot()

  // ---------------- montage: per-job {level, owner, facing, isMoving, time,
  // attackAge, attackDelay} with per-call bounds + scale --------------------
  const montage = (type, jobs, bounds, scale, defaults = {}) => page.evaluate(
    async ({ type, jobs, bounds, scale, defaults }) => {
      const B = window.__clashBake
      const scene = B.scene
      const [minX, maxX, minY, maxY] = bounds
      const W = maxX - minX, H = maxY - minY
      const rt = scene.make.renderTexture({ x: 0, y: 0, width: W, height: H }, false)
      const cells = []
      for (const raw of jobs) {
        const f = { ...defaults, ...raw }
        const g = scene.make.graphics({ x: 0, y: 0 }, false)
        B.TroopRenderer.drawTroopVisual(
          g, type, f.owner ?? 'PLAYER', f.facing ?? 0.45, !!f.isMoving, 0, 0, false, 0,
          f.level ?? 2, f.time ?? 1000, f.attackAge ?? -1, f.attackDelay ?? 0)
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
    }, { type, jobs, bounds, scale, defaults })

  const dirs8 = Array.from({ length: 8 }, (_, d) => (d / 8) * Math.PI * 2)
  const span = (t0, t1, n) => Array.from({ length: n + 1 }, (_, k) => Math.round(t0 + (k * (t1 - t0)) / n))
  const LVLS = [
    { level: 1, owner: 'PLAYER' }, { level: 2, owner: 'PLAYER' }, { level: 3, owner: 'PLAYER' },
    { level: 1, owner: 'ENEMY' }, { level: 2, owner: 'ENEMY' }, { level: 3, owner: 'ENEMY' }
  ]

  // ======================= CLOCKWORK BEETLE — A =======================
  {
    const B = [-16, 16, -22, 14], D = `${OUT}/clockworkbeetle`
    write64(`${D}/levels-idle.png`, await montage('clockworkbeetle', LVLS.map(j => ({ ...j, time: 1125 })), B, 7))
    write64(`${D}/idle-1000ms.png`, await montage('clockworkbeetle', span(1000, 2000, 8).map(time => ({ time })), B, 7, { level: 3 }))
    write64(`${D}/walk-240ms.png`, await montage('clockworkbeetle', span(0, 240, 6).map(time => ({ time, isMoving: true })), B, 7, { level: 3 }))
    write64(`${D}/attack-arm-flash.png`, await montage('clockworkbeetle',
      [50, 160, 275, 390, 478, 497, /*post-tick flash*/ 15, 60, 110].map(attackAge => ({ attackAge, attackDelay: 500 })), B, 7, { level: 2, time: 1000 }))
    write64(`${D}/headings-idle.png`, await montage('clockworkbeetle', dirs8.map(facing => ({ facing, time: 1125 })), B, 7, { level: 3 }))
    write64(`${D}/headings-walk.png`, await montage('clockworkbeetle', dirs8.map(facing => ({ facing, time: 60, isMoving: true })), B, 7, { level: 3 }))
    write64(`${D}/closeup.png`, await montage('clockworkbeetle', [
      { level: 1, time: 1125 }, { level: 3, time: 1125 }, { level: 3, time: 60, isMoving: true },
      { level: 3, time: 1000, attackAge: 478, attackDelay: 500 }, { level: 3, time: 1000, attackAge: 15, attackDelay: 500 }
    ], B, 12))
  }
  console.log('beetle montages done')

  // ======================= NECROMANCER — A =======================
  {
    const B = [-28, 28, -34, 14], D = `${OUT}/necromancer`
    write64(`${D}/levels-idle.png`, await montage('necromancer', LVLS.map(j => ({ ...j, time: 1500 })), B, 5))
    write64(`${D}/idle-2000ms.png`, await montage('necromancer', span(1000, 3000, 8).map(time => ({ time })), B, 5, { level: 3 }))
    write64(`${D}/walk-480ms.png`, await montage('necromancer', span(0, 480, 6).map(time => ({ time, isMoving: true })), B, 5, { level: 3 }))
    write64(`${D}/attack-1600ms.png`, await montage('necromancer',
      [900, 1130, 1360, 1550, 1595, /*strike*/ 40, 150, 300, 500].map(attackAge => ({ attackAge, attackDelay: 1600 })), B, 5, { level: 3, time: 1000 }))
    write64(`${D}/headings-idle.png`, await montage('necromancer', [0, Math.PI / 2, Math.PI, -Math.PI / 2].map(facing => ({ facing, time: 1500 })), B, 5, { level: 2 }))
    write64(`${D}/closeup.png`, await montage('necromancer', [
      { level: 1, time: 1500 }, { level: 3, time: 1500 }, { level: 3, time: 120, isMoving: true },
      { level: 3, time: 1000, attackAge: 1550, attackDelay: 1600 }, { level: 3, time: 1000, attackAge: 60, attackDelay: 1600 }
    ], B, 9))
  }
  console.log('necromancer montages done')

  // ======================= SKELETON — A =======================
  {
    const B = [-16, 16, -22, 14], D = `${OUT}/skeleton`
    write64(`${D}/levels-idle.png`, await montage('skeleton', LVLS.map(j => ({ ...j, time: 1250 })), B, 7))
    write64(`${D}/idle-1000ms.png`, await montage('skeleton', span(1000, 2000, 8).map(time => ({ time })), B, 7, { level: 2 }))
    write64(`${D}/walk-300ms.png`, await montage('skeleton', span(0, 300, 6).map(time => ({ time, isMoving: true })), B, 7, { level: 2 }))
    write64(`${D}/attack-900ms.png`, await montage('skeleton',
      [640, 725, 810, 880, 895, /*strike*/ 10, 60, 120, /*recover*/ 250, 400].map(attackAge => ({ attackAge, attackDelay: 900 })), B, 7, { level: 2, time: 1000 }))
    write64(`${D}/headings-idle.png`, await montage('skeleton', dirs8.map(facing => ({ facing, time: 1250 })), B, 7, { level: 1 }))
    write64(`${D}/headings-walk.png`, await montage('skeleton', dirs8.map(facing => ({ facing, time: 75, isMoving: true })), B, 7, { level: 1 }))
    write64(`${D}/headings-strike.png`, await montage('skeleton', dirs8.map(facing => ({ facing, attackAge: 30, attackDelay: 900, time: 1000 })), B, 7, { level: 2 }))
    write64(`${D}/closeup.png`, await montage('skeleton', [
      { level: 1, time: 1250 }, { level: 3, time: 1250 }, { level: 3, time: 75, isMoving: true },
      { level: 3, time: 1000, attackAge: 880, attackDelay: 900 }, { level: 3, time: 1000, attackAge: 30, attackDelay: 900 }
    ], B, 12))
  }
  console.log('skeleton montages done')

  // ======================= QUARTERMASTER — A =======================
  {
    const B = [-20, 20, -30, 14], D = `${OUT}/quartermaster`
    write64(`${D}/levels-idle.png`, await montage('quartermaster', LVLS.map(j => ({ ...j, time: 250 })), B, 6))
    write64(`${D}/idle-2000ms-beats.png`, await montage('quartermaster',
      [0, 65, 130, 250, 375, 500, 565, 750, 1000, 1250, 1500, 1750, 2000].map(time => ({ time })), B, 6, { level: 3 }))
    write64(`${D}/walk-450ms.png`, await montage('quartermaster', span(0, 450, 6).map(time => ({ time, isMoving: true })), B, 6, { level: 3 }))
    write64(`${D}/walk-lean-facings.png`, await montage('quartermaster',
      [0, Math.PI / 2, Math.PI, -Math.PI / 2].map(facing => ({ facing, time: 112, isMoving: true })), B, 6, { level: 2 }))
    write64(`${D}/closeup.png`, await montage('quartermaster', [
      { level: 1, time: 250 }, { level: 2, time: 250 }, { level: 3, time: 250 },
      { level: 3, time: 30 }, { level: 3, time: 530 }
    ], B, 10))
  }
  console.log('quartermaster montages done')

  // ======================= PHYSICIAN'S CART — C =======================
  {
    const B = [-30, 30, -32, 16], D = `${OUT}/physicianscart`
    write64(`${D}/levels-idle.png`, await montage('physicianscart', LVLS.map(j => ({ ...j, time: 1500 })), B, 5))
    write64(`${D}/idle-2000ms.png`, await montage('physicianscart', span(1000, 3000, 8).map(time => ({ time })), B, 5, { level: 3 }))
    write64(`${D}/walk-500ms.png`, await montage('physicianscart', span(0, 500, 6).map(time => ({ time, isMoving: true })), B, 5, { level: 3 }))
    write64(`${D}/attack-pump-flask.png`, await montage('physicianscart',
      [4600, 4880, 5160, 5440, 5720, 5950, /*strike*/ 30, 130, 300, /*settle*/ 700, 950].map(attackAge => ({ attackAge, attackDelay: 6000 })), B, 5, { level: 2, time: 1000 }))
    write64(`${D}/headings-idle.png`, await montage('physicianscart', dirs8.map(facing => ({ facing, time: 1500 })), B, 4))
    write64(`${D}/headings-walk.png`, await montage('physicianscart', dirs8.map(facing => ({ facing, time: 125, isMoving: true })), B, 4))
    write64(`${D}/closeup.png`, await montage('physicianscart', [
      { level: 1, time: 1500 }, { level: 3, time: 1500 },
      { level: 3, time: 1000, attackAge: 5950, attackDelay: 6000 }, { level: 3, time: 1000, attackAge: 130, attackDelay: 6000 }
    ], B, 8))
  }
  console.log('physicianscart montages done')

  // ======================= TREBUCHET — C =======================
  {
    const B = [-48, 48, -55, 18], D = `${OUT}/trebuchet`
    write64(`${D}/levels-idle.png`, await montage('trebuchet', LVLS.map(j => ({ ...j, time: 1500 })), B, 3.5))
    write64(`${D}/idle-2000ms.png`, await montage('trebuchet', span(1000, 3000, 8).map(time => ({ time })), B, 3.5, { level: 3 }))
    write64(`${D}/walk-600ms.png`, await montage('trebuchet', span(0, 600, 6).map(time => ({ time, isMoving: true })), B, 3.5, { level: 3 }))
    write64(`${D}/attack-cock.png`, await montage('trebuchet',
      [1400, 1850, 2300, 2750, 3200, 3560, 3820, 3980].map(attackAge => ({ attackAge, attackDelay: 4000 })), B, 3.5, { level: 2, time: 1000 }))
    write64(`${D}/attack-release.png`, await montage('trebuchet',
      [40, 100, 170, 300, 500, 800, 1100].map(attackAge => ({ attackAge, attackDelay: 4000 })), B, 3.5, { level: 2, time: 1000 }))
    write64(`${D}/headings-idle.png`, await montage('trebuchet', dirs8.map(facing => ({ facing, time: 1500 })), B, 3, { level: 2 }))
    write64(`${D}/headings-cocked.png`, await montage('trebuchet', dirs8.map(facing => ({ facing, attackAge: 3700, attackDelay: 4000, time: 1000 })), B, 3, { level: 2 }))
    write64(`${D}/closeup.png`, await montage('trebuchet', [
      { level: 1, time: 1500 }, { level: 3, time: 1500 },
      { level: 3, time: 1000, attackAge: 3700, attackDelay: 4000 }, { level: 3, time: 1000, attackAge: 100, attackDelay: 4000 }
    ], B, 6))
  }
  console.log('trebuchet montages done')

  // ============================== SCENE PHASE ==============================
  // Fresh boot dodges any parallel-session HMR reload mid-run.
  await boot()
  await page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.32)
    s.weather?.setWeatherOverride?.(0)
    const cast = [
      ['clockworkbeetle', 6, 13.5, 'PLAYER', 1], ['clockworkbeetle', 7.5, 13.5, 'PLAYER', 2], ['clockworkbeetle', 9, 13.5, 'PLAYER', 3],
      ['clockworkbeetle', 6.7, 15, 'ENEMY', 2],
      ['skeleton', 11.5, 13.5, 'PLAYER', 1], ['skeleton', 12.7, 13.5, 'PLAYER', 2], ['skeleton', 13.9, 13.5, 'PLAYER', 3],
      ['skeleton', 12.7, 15, 'ENEMY', 2],
      ['necromancer', 16.5, 13.5, 'PLAYER', 1], ['necromancer', 18.2, 13.5, 'PLAYER', 2], ['necromancer', 19.9, 13.5, 'PLAYER', 3],
      ['necromancer', 17.3, 15.6, 'ENEMY', 2], ['warrior', 21.2, 13.5, 'PLAYER', 1],
      ['quartermaster', 6, 18, 'PLAYER', 1], ['quartermaster', 8, 18, 'PLAYER', 2], ['quartermaster', 10, 18, 'PLAYER', 3],
      ['quartermaster', 8, 19.8, 'ENEMY', 2], ['warrior', 11.8, 18, 'PLAYER', 1],
      ['physicianscart', 13.5, 18, 'PLAYER', 1], ['physicianscart', 16.5, 18, 'PLAYER', 2], ['physicianscart', 19.5, 18, 'PLAYER', 3],
      ['physicianscart', 16.5, 20.6, 'ENEMY', 2],
      ['trebuchet', 7, 22.5, 'PLAYER', 1], ['trebuchet', 11.5, 22.5, 'PLAYER', 2], ['trebuchet', 16, 22.5, 'PLAYER', 3],
      ['trebuchet', 11.5, 25.5, 'ENEMY', 2], ['warrior', 19, 22.5, 'PLAYER', 1]
    ]
    for (const [type, x, y, owner, lvl] of cast) s.spawnTroop(x, y, type, owner, lvl)
    for (const t of s.troops) { t.target = null; t.path = undefined; t.facingAngle = 0.45 }
  })
  await sleep(900)
  const cam = (x, y, zoom, dy = 0) => page.evaluate(({ x, y, zoom, dy }) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.cameras.main.setZoom(zoom)
    s.cameras.main.centerOn((x - y) * 32, (x + y) * 16 + dy)
  }, { x, y, zoom, dy })
  const shot = (name, clip = { x: 290, y: 200, width: 700, height: 500 }) =>
    page.screenshot({ path: `${OUT}/scene/${name}.png`, clip })
  const pause = () => page.evaluate(() => window.__clashGame.scene.pause('MainScene'))
  const resume = () => page.evaluate(() => window.__clashGame.scene.resume('MainScene'))
  const poseAll = () => page.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    for (const t of s.troops) {
      t.lastAttackTime = -1e7
      s.redrawTroopWithMovement(t, false)
    }
  })

  const rows = [
    ['beetle-row', 7.3, 14.2, 4.2, -4],
    ['skeleton-row', 12.6, 14.2, 4.2, -4],
    ['necro-row', 18.4, 14.4, 3.4, -6],
    ['quartermaster-row', 8.4, 18.8, 3.6, -6],
    ['cart-row', 16.5, 19.2, 2.6, -6],
    ['trebuchet-row', 11.8, 23.8, 2.0, -10]
  ]
  const shootRows = async tag => {
    await pause()
    await poseAll()
    for (const [name, x, y, z, dy] of rows) {
      await cam(x, y, z, dy)
      await shot(`${name}-${tag}`)
    }
    await resume()
  }
  await shootRows('day')
  await page.evaluate(() => { window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.8) })
  await sleep(2200)
  await shootRows('night')
  await page.evaluate(() => { window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(0.32) })

  console.log('signoff shots →', OUT)
} finally {
  await browser.close()
}
