// Deterministic browser regression for combat navigation. It creates isolated
// battle layouts inside a disposable page and exercises the real MainScene
// target, attack, destruction, movement, rendering, and collision loops.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8788'
const OUT = (process.env.OUT ?? '/tmp/clash-pathing-verify').replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

let token = null
let browser = null
let primaryError = null
try {
  const response = await fetch(`${BASE}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  const session = await response.json()
  if (!session.token) throw new Error(`session failed: ${JSON.stringify(session)}`)
  token = session.token

  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(value => localStorage.setItem('clash.device.token', value), token)
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 45_000 })
  await page.waitForFunction(
    () => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 45_000, polling: 300 }
  )

  const installScenario = (troopType = 'warrior', x = 4.5, y = 11.5) => page.evaluate(({ troopType, x, y }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene['clearScene']()
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.villageLife.clear()

    const add = (id, type, gridX, gridY) => scene['instantiateBuilding']({ id, type, gridX, gridY, level: 1 }, 'ENEMY')
    add('inside', 'town_hall', 10, 10)
    for (let wallX = 8; wallX <= 14; wallX++) {
      add(`wall-n-${wallX}`, 'wall', wallX, 8)
      add(`wall-s-${wallX}`, 'wall', wallX, 14)
    }
    for (let wallY = 9; wallY < 14; wallY++) {
      add(`wall-w-${wallY}`, 'wall', 8, wallY)
      add(`wall-e-${wallY}`, 'wall', 14, wallY)
    }
    scene.initialEnemyBuildings = 1
    scene.spawnTroop(x, y, troopType, 'PLAYER')
    const unit = scene.troops.at(-1)
    unit.id = `${troopType}-fixed`
    unit.speedMult = 1
    unit.retargetPauseUntil = 0
    unit.nextPathTime = 0

    scene.cameras.main.setZoom(1.35)
    scene.cameras.main.centerOn((9 - 11) * 32, (9 + 11) * 16)

    window.__pathingMonitorGeneration = (window.__pathingMonitorGeneration ?? 0) + 1
    const monitorGeneration = window.__pathingMonitorGeneration
    window.__pathingViolations = []
    window.__pathingPrevious = new Map()
    const monitor = () => {
      if (monitorGeneration !== window.__pathingMonitorGeneration) return
      const liveScene = window.__clashGame.scene.keys.MainScene
      for (const troop of liveScene.troops.filter(item => item.health > 0)) {
        const previous = window.__pathingPrevious.get(troop.id) ?? { x: troop.gridX, y: troop.gridY }
        const distance = Math.hypot(troop.gridX - previous.x, troop.gridY - previous.y)
        const samples = Math.max(1, Math.ceil(distance / 0.04))
        for (let sample = 1; sample <= samples; sample++) {
          const t = sample / samples
          const px = previous.x + (troop.gridX - previous.x) * t
          const py = previous.y + (troop.gridY - previous.y) * t
          for (const structure of liveScene.buildings.filter(item => item.health > 0)) {
            // Definitions are not public; all structures in this scenario are
            // one-cell walls except the known 3x3 Town Hall.
            const width = structure.type === 'town_hall' ? 3 : 1
            const height = structure.type === 'town_hall' ? 3 : 1
            if (px > structure.gridX + 0.001 && px < structure.gridX + width - 0.001
              && py > structure.gridY + 0.001 && py < structure.gridY + height - 0.001) {
              if (window.__pathingViolations.length < 20) {
                window.__pathingViolations.push({ troop: troop.id, structure: structure.id, px, py })
              }
            }
          }
        }
        window.__pathingPrevious.set(troop.id, { x: troop.gridX, y: troop.gridY })
      }
      requestAnimationFrame(monitor)
    }
    requestAnimationFrame(monitor)
    return { troopId: unit.id }
  }, { troopType, x, y })

  await installScenario()
  await sleep(1200)
  console.log('closed-loop state:', await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const troop = scene.troops.find(item => item.id === 'warrior-fixed')
    return troop ? {
      at: [troop.gridX, troop.gridY],
      target: troop.target?.id,
      strategic: troop.strategicTarget?.id,
      blocker: troop.navigationPlan?.blockerId,
      path: troop.path,
      pause: troop.retargetPauseUntil,
      now: scene.time.now
    } : null
  }))
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const troop = scene.troops.find(item => item.id === 'warrior-fixed')
    return troop?.navigationPlan?.blockerId && troop.target?.type === 'wall'
      && scene['getTargetEdgeDistance'](troop, troop.target) <= 0.61
  }, { timeout: 12_000, polling: 50 })

  const staleWallSetup = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const troop = scene.troops.find(item => item.id === 'warrior-fixed')
    const wall = troop.target
    scene['instantiateBuilding']({ id: 'fallback', type: 'storage', gridX: 3, gridY: 19, level: 1 }, 'ENEMY')
    const inside = scene.buildings.find(item => item.id === 'inside')
    scene['destroyBuilding'](inside)
    return { wallId: wall.id, wallHealth: wall.health }
  })
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const troop = scene.troops.find(item => item.id === 'warrior-fixed')
    return troop?.strategicTarget?.id === 'fallback' && troop.target?.id === 'fallback'
  }, { timeout: 1500, polling: 25 })
  await sleep(900)
  const staleWallResult = await page.evaluate(wallId => {
    const scene = window.__clashGame.scene.keys.MainScene
    return {
      wallHealth: scene.buildings.find(item => item.id === wallId)?.health,
      violations: window.__pathingViolations,
      strategic: scene.troops.find(item => item.id === 'warrior-fixed')?.strategicTarget?.id
    }
  }, staleWallSetup.wallId)
  assert(staleWallResult.wallHealth === staleWallSetup.wallHealth, 'troop kept damaging an obsolete wall')
  assert(staleWallResult.strategic === 'fallback', 'troop forgot to reacquire after objective destruction')
  assert(staleWallResult.violations.length === 0, `collision violations: ${JSON.stringify(staleWallResult.violations)}`)

  await installScenario()
  await page.waitForFunction(() => {
    const troop = window.__clashGame.scene.keys.MainScene.troops.find(item => item.id === 'warrior-fixed')
    return troop?.navigationPlan?.blockerId && troop.target?.type === 'wall'
  }, { timeout: 8000, polling: 50 })
  const breachId = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const troop = scene.troops.find(item => item.id === 'warrior-fixed')
    const wall = scene.buildings.find(item => item.id === troop.navigationPlan.blockerId)
    const id = wall.id
    scene['destroyBuilding'](wall)
    return id
  })
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const troop = scene.troops.find(item => item.id === 'warrior-fixed')
    return troop?.strategicTarget?.id === 'inside'
      && troop.navigationPlan?.blockerId === undefined
      && troop.target?.id === 'inside'
  }, { timeout: 1500, polling: 25 })
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const inside = scene.buildings.find(item => item.id === 'inside')
    return inside && inside.health < inside.maxHealth
  }, { timeout: 7000, polling: 50 })
  const breachResult = await page.evaluate(openedId => {
    const scene = window.__clashGame.scene.keys.MainScene
    return {
      openedStillGone: !scene.buildings.some(item => item.id === openedId),
      blocker: scene.troops.find(item => item.id === 'warrior-fixed')?.navigationPlan?.blockerId,
      violations: window.__pathingViolations
    }
  }, breachId)
  assert(breachResult.openedStillGone, 'destroyed breach reappeared')
  assert(breachResult.blocker === undefined, 'troop chose an unnecessary second wall after a gap opened')
  assert(breachResult.violations.length === 0, `gap scenario collision violations: ${JSON.stringify(breachResult.violations)}`)
  await page.screenshot({ path: `${OUT}/pathing-through-breach.png` })

  await installScenario('archer', 7.4, 11.5)
  const wallHealthBefore = await page.evaluate(() => window.__clashGame.scene.keys.MainScene.buildings
    .filter(item => item.type === 'wall').reduce((sum, item) => sum + item.health, 0))
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const inside = scene.buildings.find(item => item.id === 'inside')
    return inside && inside.health < inside.maxHealth
  }, { timeout: 6000, polling: 50 })
  const ranged = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const archer = scene.troops.find(item => item.id === 'archer-fixed')
    return {
      blocker: archer.navigationPlan?.blockerId,
      target: archer.target?.id,
      wallHealth: scene.buildings.filter(item => item.type === 'wall').reduce((sum, item) => sum + item.health, 0),
      violations: window.__pathingViolations
    }
  })
  assert(ranged.blocker === undefined && ranged.target === 'inside', 'ranged troop attacked a wall despite a legal shot')
  assert(ranged.wallHealth === wallHealthBefore, 'ranged troop damaged a wall unnecessarily')
  assert(ranged.violations.length === 0, `ranged collision violations: ${JSON.stringify(ranged.violations)}`)
  await page.screenshot({ path: `${OUT}/pathing-ranged-over-wall.png` })

  await installScenario('ram')
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const ram = scene.troops.find(item => item.id === 'ram-fixed')
    return ram?.strategicTarget?.id === 'inside'
      && ram.navigationPlan?.blockerId
      && ram.target?.type === 'wall'
  }, { timeout: 8000, polling: 50 })
  const ramWall = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const ram = scene.troops.find(item => item.id === 'ram-fixed')
    return { id: ram.navigationPlan.blockerId, health: ram.target.health }
  })
  await page.waitForFunction(({ id, health }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const wall = scene.buildings.find(item => item.id === id)
    return !wall || wall.health < health
  }, { timeout: 9000, polling: 50 }, ramWall)
  await page.evaluate(id => {
    const scene = window.__clashGame.scene.keys.MainScene
    const wall = scene.buildings.find(item => item.id === id)
    if (wall) scene['destroyBuilding'](wall)
  }, ramWall.id)
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const ram = scene.troops.find(item => item.id === 'ram-fixed')
    return ram?.strategicTarget?.id === 'inside' && ram.target?.id === 'inside'
  }, { timeout: 8000, polling: 50 })
  const ramResult = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const ram = scene.troops.find(item => item.id === 'ram-fixed')
    return {
      strategic: ram?.strategicTarget?.id,
      target: ram?.target?.type,
      violations: window.__pathingViolations
    }
  })
  assert(ramResult.strategic === 'inside', 'ram replaced its Town Hall objective with a wall')
  assert(ramResult.violations.length === 0, `ram collision violations: ${JSON.stringify(ramResult.violations)}`)

  await installScenario('wallbreaker')
  await page.waitForFunction(() => {
    const troop = window.__clashGame.scene.keys.MainScene.troops.find(item => item.id === 'wallbreaker-fixed')
    return troop?.strategicTarget?.type === 'wall' && troop.target?.type === 'wall'
  }, { timeout: 5000, polling: 50 })
  const wallbreakerTarget = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const unit = scene.troops.find(item => item.id === 'wallbreaker-fixed')
    return { id: unit.target.id, health: unit.target.health }
  })
  await page.waitForFunction(id => {
    const scene = window.__clashGame.scene.keys.MainScene
    return !scene.troops.some(item => item.id === 'wallbreaker-fixed')
      && (!scene.buildings.some(item => item.id === id)
        || scene.buildings.find(item => item.id === id).health < scene.buildings.find(item => item.id === id).maxHealth)
  }, { timeout: 6000, polling: 50 }, wallbreakerTarget.id)
  const wallbreakerResult = await page.evaluate(id => {
    const scene = window.__clashGame.scene.keys.MainScene
    return {
      targetSurvivedAt: scene.buildings.find(item => item.id === id)?.health ?? 0,
      violations: window.__pathingViolations
    }
  }, wallbreakerTarget.id)
  assert(wallbreakerResult.targetSurvivedAt < wallbreakerTarget.health,
    'wall breaker self-destructed without damaging its selected wall')
  assert(wallbreakerResult.violations.length === 0,
    `wall breaker collision violations: ${JSON.stringify(wallbreakerResult.violations)}`)

  const cohortBefore = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene['clearScene']()
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.villageLife.clear()
    const add = (id, type, gridX, gridY) => scene['instantiateBuilding']({ id, type, gridX, gridY, level: 1 }, 'ENEMY')
    add('inside', 'town_hall', 10, 10)
    for (let wallX = 8; wallX <= 14; wallX++) {
      add(`wall-n-${wallX}`, 'wall', wallX, 8)
      add(`wall-s-${wallX}`, 'wall', wallX, 14)
    }
    for (let wallY = 9; wallY < 14; wallY++) {
      add(`wall-w-${wallY}`, 'wall', 8, wallY)
      add(`wall-e-${wallY}`, 'wall', 14, wallY)
    }
    for (let index = 0; index < 24; index++) {
      scene.spawnTroop(3.8 + (index % 4) * 0.28, 9.2 + Math.floor(index / 4) * 0.72, 'warrior', 'PLAYER')
      const unit = scene.troops.at(-1)
      unit.id = `cohort-${String(index).padStart(2, '0')}`
      unit.speedMult = 1
      unit.retargetPauseUntil = 0
      unit.nextPathTime = 0
      unit.navigationPlan = undefined
    }
    return scene.troops.length
  })
  assert(cohortBefore === 24, 'cohort scenario did not deploy all troops')
  await sleep(800)
  const cohortPlan = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const counts = {}
    for (const troop of scene.troops) {
      const blocker = troop.navigationPlan?.blockerId
      if (blocker) counts[blocker] = (counts[blocker] ?? 0) + 1
    }
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1])
    return {
      blockers: ranked,
      strategic: [...new Set(scene.troops.map(troop => troop.strategicTarget?.id))]
    }
  })
  assert(cohortPlan.strategic.length === 1 && cohortPlan.strategic[0] === 'inside', 'cohort target intent thrashed')
  assert(cohortPlan.blockers.length <= 3, `cohort scattered across irrelevant walls: ${JSON.stringify(cohortPlan.blockers)}`)
  const popularBreach = cohortPlan.blockers[0]?.[0]
  assert(popularBreach, 'cohort did not select a breach')
  await page.evaluate(wallId => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene['destroyBuilding'](scene.buildings.find(item => item.id === wallId))
  }, popularBreach)
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const live = scene.troops.filter(item => item.health > 0)
    return live.length > 0
      && live.filter(item => item.strategicTarget?.id === 'inside' && item.navigationPlan?.blockerId === undefined).length >= Math.ceil(live.length * 0.9)
  }, { timeout: 1800, polling: 25 })
  const cohortAfter = await page.evaluate(() => ({
    live: window.__clashGame.scene.keys.MainScene.troops.filter(item => item.health > 0).length,
    fps: Math.round(window.__clashGame.loop.actualFps)
  }))
  assert(cohortAfter.fps > 15, `cohort navigation stalled the game loop (${cohortAfter.fps} fps)`)

  assert(errors.length === 0, `browser errors: ${errors.join(' | ')}`)
  console.log('browser pathing regressions passed', {
    staleWallResult, breachResult, ranged, ramResult, wallbreakerResult, cohortPlan, cohortAfter, out: OUT
  })
} catch (error) {
  primaryError = error
  throw error
} finally {
  let cleanupError = null
  try {
    await browser?.close()
  } catch (error) {
    cleanupError = error
  }
  if (token) {
    try {
      const logout = await fetch(`${BASE}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}'
      })
      if (!logout.ok) throw new Error(`verification guest cleanup failed (${logout.status})`)
    } catch (error) {
      cleanupError ??= error
    }
  }
  if (cleanupError) {
    if (primaryError) console.error('pathing verification cleanup also failed:', cleanupError)
    else throw cleanupError
  }
}
