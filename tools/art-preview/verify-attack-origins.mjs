// Focused runtime sign-off for the attack-origin fixes:
//   BASE=http://127.0.0.1:8788 node verify-attack-origins.mjs
// Produces Ballista wind/release/reload, Necromancer orb-flight, and
// Da Vinci live-shot screenshots from the real production game surface.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8788'
const OUT = (process.env.OUT ?? new URL('./shots/attack-origins', import.meta.url).pathname).replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

const session = await (await fetch(`${BASE}/api/auth/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
})).json()
const world = session.world
world.buildings = [
  { id: 'origin-th', type: 'town_hall', gridX: 12, gridY: 11, level: 3 },
  { id: 'origin-ballista', type: 'ballista', gridX: 8, gridY: 10, level: 3 },
  { id: 'origin-storage', type: 'storage', gridX: 15, gridY: 12, level: 3 }
]
const saveResponse = await fetch(`${BASE}/api/world/save`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
  body: JSON.stringify({ world, requestId: `attack-origin-${Date.now()}` })
})
const saveResult = await saveResponse.json()
if (!saveResponse.ok) throw new Error(`world seed failed: ${JSON.stringify(saveResult)}`)

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(token => localStorage.setItem('clash.device.token', token), session.token)
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message).slice(0, 240)))
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') console.log(`PAGE ${message.type()}:`, message.text().slice(0, 240))
  })
  console.log('booting production game')
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  console.log('page loaded; waiting for MainScene')
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length >= 3, {
    timeout: 120000, polling: 400
  })
  console.log('MainScene ready')
  await sleep(4500)

  const cameraOn = (gx, gy, zoom = 4) => page.evaluate(({ gx, gy, zoom }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.cameras.main.setZoom(zoom)
    scene.cameras.main.centerOn((gx - gy) * 32, (gx + gy) * 16 - 8)
  }, { gx, gy, zoom })
  const shot = name => page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: { x: 260, y: 110, width: 760, height: 680 }
  })

  // Ballista: drive the real shot method and sample every meaningful pose.
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.dayNight.setPhaseOverride(0.32)
    scene.weather.setWeatherOverride(0)
    scene.villageLife.clear()
    scene.spawnTroop(13, 10, 'warrior', 'ENEMY', 1)
    const dummy = scene.troops.find(troop => troop.type === 'warrior' && troop.owner === 'ENEMY')
    const ballista = scene.buildings.find(building => building.type === 'ballista')
    if (!ballista) throw new Error(`seeded ballista missing: ${scene.buildings.map(building => building.type).join(',')}`)
    dummy.health = dummy.maxHealth = 100000
    dummy.target = null
    ballista.ballistaAngle = 0
    ballista.ballistaTargetAngle = undefined
    scene.shootBallistaAt(ballista, dummy)
    ballista.lastFireTime = scene.time.now
  })
  await cameraOn(9, 10, 4.5)
  await sleep(240)
  await shot('ballista-1-windup')
  await sleep(210)
  await shot('ballista-2-release')
  await sleep(310)
  await shot('ballista-3-empty-hold')
  await sleep(1050)
  await shot('ballista-4-reloaded')

  const ballistaState = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const ballista = scene.buildings.find(building => building.type === 'ballista')
    return { loaded: ballista.ballistaBoltLoaded, tension: ballista.ballistaStringTension }
  })
  if (!ballistaState.loaded || Math.abs(ballistaState.tension ?? 0) > 0.01) {
    throw new Error(`ballista did not reach loaded rest: ${JSON.stringify(ballistaState)}`)
  }

  // Necromancer: direct presentation call keeps the shot isolated from the
  // combat scheduler while exercising the exact runtime method.
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.spawnTroop(11, 16, 'necromancer', 'PLAYER', 3)
    const necromancer = scene.troops.find(troop => troop.type === 'necromancer' && troop.owner === 'PLAYER')
    const target = scene.buildings.find(building => building.type === 'town_hall')
    necromancer.target = null
    scene.showNecromancerOrb(necromancer, target, 0)
  })
  await cameraOn(12.25, 14.25, 3.2)
  await sleep(190)
  await shot('necromancer-1-orb-flight')
  await page.evaluate(() => new Promise(resolve => {
    const scene = window.__clashGame.scene.keys.MainScene
    const necromancer = scene.troops.find(troop => troop.type === 'necromancer' && troop.owner === 'PLAYER')
    const target = scene.buildings.find(building => building.type === 'town_hall')
    scene.showNecromancerOrb(necromancer, target, 0)
    setTimeout(() => {
      window.__clashGame.scene.pause('MainScene')
      resolve()
    }, 430)
  }))
  await shot('necromancer-2-orb-impact')
  await page.evaluate(() => window.__clashGame.scene.resume('MainScene'))

  // Da Vinci: use the normal practice-raid scheduler so cannon selection,
  // baked attack frames, muzzle FX, projectile, and impact all run together.
  await page.evaluate(() => window.__clashGM.startPracticeAttack())
  await page.waitForFunction(() => window.__clashGame.scene.keys.MainScene.mode === 'ATTACK', {
    timeout: 30000, polling: 250
  })
  await sleep(1800)
  const tankSetup = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const target = scene.buildings.find(building => building.type === 'ballista')
      ?? scene.buildings.find(building => building.type === 'town_hall')
    target.health = target.maxHealth = 100000
    scene.spawnTroop(target.gridX - 3.1, target.gridY + 1.6, 'davincitank', 'PLAYER', 3)
    const tank = scene.troops.find(troop => troop.type === 'davincitank')
    tank.health = tank.maxHealth = 100000
    tank.target = target
    tank.strategicTarget = target
    tank.path = undefined
    return { tankId: tank.id, gx: (tank.gridX + target.gridX) / 2, gy: (tank.gridY + target.gridY) / 2 }
  })
  await cameraOn(tankSetup.gx, tankSetup.gy, 4.4)
  const tankResult = await page.evaluate(tankId => new Promise(resolve => {
    const scene = window.__clashGame.scene.keys.MainScene
    const tank = scene.troops.find(troop => troop.id === tankId)
    const startedAt = scene.time.now
    const poll = () => {
      if (!tank?.gameObject?.active) return resolve('tank-lost')
      if ((tank.lastAttackTime ?? 0) > startedAt) {
        setTimeout(() => {
          window.__clashGame.scene.pause('MainScene')
          resolve('shot')
        }, 55)
        return
      }
      if (scene.time.now - startedAt > 12000) return resolve('timeout')
      setTimeout(poll, 8)
    }
    poll()
  }), tankSetup.tankId)
  if (tankResult !== 'shot') throw new Error(`Da Vinci live shot failed: ${tankResult}`)
  await shot('davinci-live-cannon-origin')
  await page.evaluate(() => window.__clashGame.scene.resume('MainScene'))

  if (errors.length > 0) throw new Error(`page errors: ${JSON.stringify(errors)}`)
  console.log(`attack-origin sign-off complete -> ${OUT}`)
} finally {
  await browser.close()
}
