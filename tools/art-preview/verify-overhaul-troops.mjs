// Deterministic browser regression for the troop-overhaul motion fixes.
//
// The fixture is installed directly into the already-booted MainScene: it
// never saves a world, trains an army, starts an authoritative attack, or
// mints an account. Authentication uses the one shared art-preview device
// token and fails closed when that token is absent or no longer valid.
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const rawBase = process.env.BASE ?? 'http://127.0.0.1:5174'
const BASE = (/^https?:\/\//.test(rawBase) ? rawBase : `http://${rawBase}`).replace(/\/$/, '')
const OUT = (process.env.OUT ?? '/tmp/clash-overhaul-troops-verify').replace(/\/$/, '')
const TOKEN_CACHE = new URL('./.shared-device-token.json', import.meta.url)
mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

let token = null
try {
  token = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null
} catch {
  // Fail below with one actionable message. Never fall back to auth/session
  // without a token: that endpoint would mint a new guest identity.
}
assert(token, `missing shared device token at ${TOKEN_CACHE.pathname}`)

// Read-only validation. A bad bearer gets a 401; unlike POST /auth/session
// with an invalid token this can never create a replacement guest.
const authProbe = await fetch(`${BASE}/api/world`, {
  headers: { Authorization: `Bearer ${token}` }
})
assert(authProbe.ok, `shared device token rejected by ${BASE} (${authProbe.status}); refusing to mint a guest`)

let browser = null
try {
  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(value => {
    localStorage.setItem('clash.device.token', value)
    localStorage.removeItem('clash.sprites.off')
  }, token)

  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForFunction(
    () => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 90_000, polling: 300 }
  )
  // The test is specifically about baked frames. Do not silently exercise
  // the vector fallback while the asynchronous atlas bank is still loading.
  await page.waitForFunction(() => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    return scene?.children?.list?.some(child =>
      child?.type === 'Image' && String(child.texture?.key ?? '').startsWith('bank:buildings:'))
  }, { timeout: 45_000, polling: 100 })

  const installMotionScenario = type => page.evaluate(troopType => {
    const scene = window.__clashGame.scene.keys.MainScene
    window.__overhaulMonitorGeneration = (window.__overhaulMonitorGeneration ?? 0) + 1
    const generation = window.__overhaulMonitorGeneration

    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene['clearScene']()
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene.villageLife.clear()
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)

    scene['instantiateBuilding']({
      id: 'motion-storage', type: 'storage', gridX: 13, gridY: 10, level: 1
    }, 'ENEMY')
    scene.initialEnemyBuildings = 1
    scene.spawnTroop(4.5, 11, troopType, 'PLAYER', 1)
    const unit = scene.troops.at(-1)
    unit.id = `${troopType}-motion-fixed`
    unit.speedMult = 1
    unit.retargetPauseUntil = 0
    unit.nextPathTime = 0
    unit.navigationPlan = undefined

    scene.cameras.main.setZoom(1.75)
    scene.cameras.main.centerOn((9 - 11) * 32, (9 + 11) * 16 - 8)

    const trace = window.__overhaulMotionTrace = {
      type: troopType,
      id: unit.id,
      startedAt: scene.time.now,
      startX: unit.gridX,
      startY: unit.gridY,
      samples: []
    }
    let previousX = unit.gridX
    let previousY = unit.gridY
    const sample = () => {
      if (generation !== window.__overhaulMonitorGeneration) return
      const liveScene = window.__clashGame.scene.keys.MainScene
      const live = liveScene.troops.find(candidate => candidate.id === trace.id)
      if (!live || liveScene.time.now - trace.startedAt > 940) return
      const shadows = liveScene.children.list.filter(child =>
        child?.active
        && child?.type === 'Image'
        && String(child.texture?.key ?? '').startsWith(`bank:troops:${troopType}`)
      )
      const shadow = shadows.sort((left, right) => {
        const ld = Math.hypot((left.x ?? 0) - live.gameObject.x, (left.y ?? 0) - live.gameObject.y)
        const rd = Math.hypot((right.x ?? 0) - live.gameObject.x, (right.y ?? 0) - live.gameObject.y)
        return ld - rd
      })[0]
      const step = Math.hypot(live.gridX - previousX, live.gridY - previousY)
      trace.samples.push({
        t: liveScene.time.now - trace.startedAt,
        x: live.gridX,
        y: live.gridY,
        step,
        frame: shadow ? String(shadow.frame?.name ?? '') : '',
        atlas: shadow ? String(shadow.texture?.key ?? '') : ''
      })
      previousX = live.gridX
      previousY = live.gridY
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    return { id: unit.id, startedAt: trace.startedAt }
  }, type)

  const verifyOpeningMotion = async type => {
    await installMotionScenario(type)
    await sleep(1_020)
    const trace = await page.evaluate(() => window.__overhaulMotionTrace)
    assert(trace?.samples?.length > 8, `${type}: opening motion monitor collected too few frames`)
    const final = trace.samples.at(-1)
    const distance = Math.hypot(final.x - trace.startX, final.y - trace.startY)
    const moving = trace.samples.filter(sample => sample.t >= 45 && sample.t <= 920 && sample.step > 0.0005)
    const missingBaked = moving.filter(sample => !sample.frame || !sample.atlas)
    const nonWalk = moving.filter(sample => !sample.frame.includes('_walk'))
    const walkFrames = [...new Set(moving.map(sample => sample.frame).filter(frame => frame.includes('_walk')))]
    assert(distance > 0.5, `${type}: moved only ${distance.toFixed(3)} tiles during its opening 900 ms`)
    assert(moving.length > 5, `${type}: had too few moving samples during its opening 900 ms`)
    assert(missingBaked.length === 0, `${type}: moved without a baked SpriteBank shadow frame`)
    assert(nonWalk.length === 0,
      `${type}: moved while showing a non-walk frame: ${JSON.stringify([...new Set(nonWalk.map(sample => sample.frame))])}`)
    assert(walkFrames.length >= 2,
      `${type}: opening movement stayed on one baked walk frame (${JSON.stringify(walkFrames)})`)
    return {
      distance: Number(distance.toFixed(3)),
      movingSamples: moving.length,
      walkFrames
    }
  }

  const goblinMotion = await verifyOpeningMotion('goblinplunderer')
  const beetleMotion = await verifyOpeningMotion('clockworkbeetle')

  const latchSetup = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    window.__overhaulMonitorGeneration = (window.__overhaulMonitorGeneration ?? 0) + 1
    const generation = window.__overhaulMonitorGeneration

    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene['clearScene']()
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene.villageLife.clear()
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)

    scene['instantiateBuilding']({
      id: 'beetle-target', type: 'storage', gridX: 10, gridY: 10, level: 1
    }, 'ENEMY')
    const target = scene.buildings.find(building => building.id === 'beetle-target')
    scene.initialEnemyBuildings = 1
    scene.spawnTroop(7.5, 11, 'clockworkbeetle', 'PLAYER', 1)
    const unit = scene.troops.at(-1)
    unit.id = 'clockworkbeetle-latch-fixed'
    unit.speedMult = 1
    unit.retargetPauseUntil = 0
    unit.nextPathTime = 0
    unit.navigationPlan = undefined

    scene.cameras.main.setZoom(3)
    scene.cameras.main.centerOn((11 - 11) * 32, (11 + 11) * 16 - 14)

    const trace = window.__overhaulBeetleTrace = {
      id: unit.id,
      targetId: target.id,
      targetHealthBefore: target.health,
      latch: null,
      lastAliveAt: null,
      disappearedAt: null,
      targetHealthAfter: null,
      minVisualOffsetY: 0
    }
    const monitor = () => {
      if (generation !== window.__overhaulMonitorGeneration) return
      const liveScene = window.__clashGame.scene.keys.MainScene
      const live = liveScene.troops.find(candidate => candidate.id === trace.id)
      const liveTarget = liveScene.buildings.find(building => building.id === trace.targetId)
      if (live) {
        trace.lastAliveAt = liveScene.time.now
        trace.minVisualOffsetY = Math.min(trace.minVisualOffsetY, live.visualOffsetY ?? 0)
        if (live.beetleLatch && !trace.latch) trace.latch = { ...live.beetleLatch }
      } else if (trace.latch && trace.disappearedAt === null) {
        trace.disappearedAt = liveScene.time.now
        trace.targetHealthAfter = liveTarget?.health ?? 0
      }
      if (trace.disappearedAt === null) requestAnimationFrame(monitor)
    }
    requestAnimationFrame(monitor)
    return { id: unit.id, targetId: target.id, targetHealth: target.health }
  })

  await page.waitForFunction(() => window.__overhaulBeetleTrace?.latch,
    { timeout: 8_000, polling: 20 })
  const latchTimes = await page.evaluate(() => window.__overhaulBeetleTrace.latch)
  assert(Math.abs((latchTimes.landedAt - latchTimes.startedAt) - 220) < 0.01,
    `clockworkbeetle: leap duration was ${latchTimes.landedAt - latchTimes.startedAt} ms, expected 220`)
  assert(Math.abs((latchTimes.detonateAt - latchTimes.landedAt) - 125) < 0.01,
    `clockworkbeetle: attached fuse was ${latchTimes.detonateAt - latchTimes.landedAt} ms, expected 125`)

  // Freeze the scene inside the short latch window so visual QA sees the
  // actual baked carrier pose without lengthening production timing.
  await page.waitForFunction(landedAt => {
    const scene = window.__clashGame.scene.keys.MainScene
    const unit = scene.troops.find(troop => troop.id === 'clockworkbeetle-latch-fixed')
    if (scene.time.now >= landedAt + 25 && unit?.health > 0) {
      scene.scene.pause()
      return true
    }
    return false
  }, { timeout: 4_000, polling: 2 }, latchTimes.landedAt)
  const midLatch = await page.evaluate(({ id, targetId }) => {
    const scene = window.__clashGame.scene.keys.MainScene
    const unit = scene.troops.find(troop => troop.id === id)
    const target = scene.buildings.find(building => building.id === targetId)
    const nearestShadow = carrier => scene.children.list
      .filter(child => child?.active
        && child?.type === 'Image'
        && String(child.texture?.key ?? '') === 'bank:troops:clockworkbeetle')
      .sort((left, right) => {
        const ld = Math.hypot((left.x ?? 0) - carrier.x, (left.y ?? 0) - carrier.y)
        const rd = Math.hypot((right.x ?? 0) - carrier.x, (right.y ?? 0) - carrier.y)
        return ld - rd
      })[0]
    const shadow = nearestShadow(unit.gameObject)
    const replay = scene['createReplayTroop']({
      id: 'clockworkbeetle-replay-latch-fixed',
      type: 'clockworkbeetle', level: 1, owner: 'PLAYER',
      gridX: 3, gridY: 3, visualOffsetY: unit.visualOffsetY,
      health: 1, maxHealth: 1, facingAngle: unit.facingAngle,
      hasTakenDamage: false
    })
    const replayShadow = replay ? nearestShadow(replay.gameObject) : null
    const result = {
      now: scene.time.now,
      alive: !!unit && unit.health > 0,
      x: unit?.gridX,
      y: unit?.gridY,
      visualOffsetY: unit?.visualOffsetY,
      carrierRotation: unit?.gameObject.rotation,
      shadowRotation: shadow?.rotation,
      replayCarrierRotation: replay?.gameObject.rotation,
      replayShadowRotation: replayShadow?.rotation,
      landX: unit?.beetleLatch?.landX,
      landY: unit?.beetleLatch?.landY,
      targetHealth: target?.health
    }
    replay?.gameObject.destroy()
    replay?.healthBar.destroy()
    return result
  }, latchSetup)
  assert(midLatch.alive, 'clockworkbeetle: died before its snap-fuse expired')
  assert((midLatch.visualOffsetY ?? 0) < -1,
    `clockworkbeetle: landed without a negative visualOffsetY (${midLatch.visualOffsetY})`)
  assert(Math.hypot(midLatch.x - midLatch.landX, midLatch.y - midLatch.landY) < 0.001,
    'clockworkbeetle: did not finish its 220 ms leap on the target anchor')
  assert(midLatch.carrierRotation < -0.15 && midLatch.carrierRotation > -0.20,
    `clockworkbeetle: latched carrier tilt was ${midLatch.carrierRotation}, expected about -10 degrees`)
  assert(Math.abs(midLatch.shadowRotation - midLatch.carrierRotation) < 0.001,
    `clockworkbeetle: baked shadow tilt ${midLatch.shadowRotation} diverged from carrier ${midLatch.carrierRotation}`)
  assert(Math.abs(midLatch.replayCarrierRotation - midLatch.carrierRotation) < 0.001
      && Math.abs(midLatch.replayShadowRotation - midLatch.carrierRotation) < 0.001,
    `clockworkbeetle: replay tilt diverged (carrier ${midLatch.replayCarrierRotation}, shadow ${midLatch.replayShadowRotation})`)
  assert(midLatch.targetHealth === latchSetup.targetHealth,
    'clockworkbeetle: damaged its target before the attached fuse expired')
  const latchShot = `${OUT}/clockworkbeetle-quick-latch.png`
  await page.screenshot({ path: latchShot })
  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.scene.resume())
  await page.waitForFunction(() => window.__overhaulBeetleTrace?.disappearedAt !== null,
    { timeout: 3_000, polling: 10 })
  const beetleLatch = await page.evaluate(() => window.__overhaulBeetleTrace)
  assert(beetleLatch.lastAliveAt >= latchTimes.detonateAt - 35,
    `clockworkbeetle: vanished too early, last alive ${beetleLatch.lastAliveAt - latchTimes.landedAt} ms after landing`)
  assert(beetleLatch.disappearedAt >= latchTimes.detonateAt,
    `clockworkbeetle: disappeared ${latchTimes.detonateAt - beetleLatch.disappearedAt} ms before detonation`)
  assert(beetleLatch.disappearedAt <= latchTimes.detonateAt + 100,
    `clockworkbeetle: disappeared ${beetleLatch.disappearedAt - latchTimes.detonateAt} ms after its fuse`)
  assert(beetleLatch.targetHealthAfter < beetleLatch.targetHealthBefore,
    'clockworkbeetle: disappeared without damaging its latched target')

  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    window.__overhaulMonitorGeneration = (window.__overhaulMonitorGeneration ?? 0) + 1
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene['clearScene']()
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene.villageLife.clear()
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)

    scene['instantiateBuilding']({
      id: 'siege-objective', type: 'town_hall', gridX: 10, gridY: 10, level: 1
    }, 'ENEMY')
    scene['instantiateBuilding']({
      id: 'siege-first-wall', type: 'wall', gridX: 8, gridY: 11, level: 1
    }, 'ENEMY')
    scene.initialEnemyBuildings = 1
    scene.spawnTroop(4.5, 11.5, 'siegetower', 'PLAYER', 1)
    const tower = scene.troops.at(-1)
    tower.id = 'siegetower-park-fixed'
    tower.speedMult = 1
    tower.retargetPauseUntil = 0
    tower.nextPathTime = 0
    tower.navigationPlan = undefined

    scene.cameras.main.setZoom(2.65)
    scene.cameras.main.centerOn((8 - 11.5) * 32, (8 + 11.5) * 16 - 12)
  })
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const tower = scene.troops.find(troop => troop.id === 'siegetower-park-fixed')
    return tower?.parkedWallId === 'siege-first-wall' && (tower.parked01 ?? 0) >= 0.999
  }, { timeout: 10_000, polling: 20 })
  const siegeTower = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const tower = scene.troops.find(troop => troop.id === 'siegetower-park-fixed')
    const wall = scene.buildings.find(building => building.id === 'siege-first-wall')
    const towerPos = { x: (tower.gridX - tower.gridY) * 32, y: (tower.gridX + tower.gridY) * 16 }
    const wallPos = { x: ((wall.gridX + 0.5) - (wall.gridY + 0.5)) * 32,
      y: ((wall.gridX + 0.5) + (wall.gridY + 0.5)) * 16 }
    const expectedFacing = Math.atan2(wallPos.y - towerPos.y, wallPos.x - towerPos.x)
    const angleError = Math.atan2(
      Math.sin((tower?.facingAngle ?? 0) - expectedFacing),
      Math.cos((tower?.facingAngle ?? 0) - expectedFacing)
    )
    const shadow = scene.children.list
      .filter(child => child?.active && child?.type === 'Image'
        && String(child.texture?.key ?? '') === 'bank:troops:siegetower')
      .sort((left, right) => {
        const ld = Math.hypot((left.x ?? 0) - tower.gameObject.x, (left.y ?? 0) - tower.gameObject.y)
        const rd = Math.hypot((right.x ?? 0) - tower.gameObject.x, (right.y ?? 0) - tower.gameObject.y)
        return ld - rd
      })[0]
    return {
      gap: scene['getTargetEdgeDistance'](tower, wall),
      parkedWallId: tower?.parkedWallId,
      parked01: tower?.parked01,
      wallHealth: wall?.health,
      facingAngle: tower?.facingAngle,
      expectedFacing,
      angleError,
      frame: String(shadow?.frame?.name ?? '')
    }
  })
  assert(siegeTower.parkedWallId === 'siege-first-wall',
    `siegetower: parked at ${siegeTower.parkedWallId ?? 'nothing'}, not its first wall`)
  assert(siegeTower.gap <= 0.285,
    `siegetower: parked ${siegeTower.gap.toFixed(4)} tiles from the wall (expected <= 0.285)`)
  assert(Math.abs(siegeTower.angleError) < 0.001,
    `siegetower: parked facing ${siegeTower.facingAngle}, expected wall-center angle ${siegeTower.expectedFacing}`)
  assert(siegeTower.frame.includes('_deactivated'),
    `siegetower: parked without its baked deployed pose (${siegeTower.frame})`)
  const siegeShot = `${OUT}/siegetower-tight-wall-park.png`
  await page.screenshot({ path: siegeShot })

  // A literal screen-down park is the directional regression that caught the
  // old grid-angle bug: equal +gridX/+gridY projects to +screenY (d2). Sample
  // the whole ramp descent as well as its terminal pose: the baked path used
  // to jump straight from rolling to deployed halfway through this tween.
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    window.__overhaulMonitorGeneration = (window.__overhaulMonitorGeneration ?? 0) + 1
    const generation = window.__overhaulMonitorGeneration
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene['clearScene']()
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene.villageLife.clear()
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)

    scene['instantiateBuilding']({
      id: 'siege-down-wall', type: 'wall', gridX: 8, gridY: 8, level: 4
    }, 'ENEMY')
    scene.spawnTroop(7.86, 7.86, 'siegetower', 'PLAYER', 3)
    const tower = scene.troops.at(-1)
    tower.id = 'siegetower-down-fixed'
    // spawnTroop legally projects a large unit away from adjacent geometry;
    // this direct parking fixture needs the exact diagonal anchor so the
    // heading assertion isolates grid->screen orientation (the preceding
    // scenario already exercises collision-safe live movement).
    tower.gridX = 7.86
    tower.gridY = 7.86
    tower.gameObject.setPosition(0, (7.86 + 7.86) * 16)
    tower.target = scene.buildings.find(building => building.id === 'siege-down-wall')
    tower.strategicTarget = tower.target
    scene['parkSiegeTower'](tower, scene.time.now)
    scene.cameras.main.setZoom(3.4)
    scene.cameras.main.centerOn(0, 246)

    const trace = window.__overhaulSiegeDownTrace = { id: tower.id, samples: [] }
    const sample = () => {
      if (generation !== window.__overhaulMonitorGeneration) return
      const liveScene = window.__clashGame.scene.keys.MainScene
      const live = liveScene.troops.find(troop => troop.id === trace.id)
      if (!live) return
      const shadow = liveScene.children.list
        .filter(child => child?.active && child?.type === 'Image'
          && String(child.texture?.key ?? '') === 'bank:troops:siegetower')
        .sort((left, right) => {
          const ld = Math.hypot((left.x ?? 0) - live.gameObject.x, (left.y ?? 0) - live.gameObject.y)
          const rd = Math.hypot((right.x ?? 0) - live.gameObject.x, (right.y ?? 0) - live.gameObject.y)
          return ld - rd
        })[0]
      trace.samples.push({
        parked01: live.parked01 ?? 0,
        frame: String(shadow?.frame?.name ?? '')
      })
      if ((live.parked01 ?? 0) < 0.999) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const tower = scene.troops.find(troop => troop.id === 'siegetower-down-fixed')
    return (tower?.parked01 ?? 0) >= 0.45 && (tower?.parked01 ?? 0) <= 0.85
  }, { timeout: 3_000, polling: 10 })
  const siegeDownDeploy = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.scene.pause()
    const tower = scene.troops.find(troop => troop.id === 'siegetower-down-fixed')
    scene['redrawTroopWithMovement'](tower, false)
    const shadow = scene.children.list
      .filter(child => child?.active && child?.type === 'Image'
        && String(child.texture?.key ?? '') === 'bank:troops:siegetower')
      .sort((left, right) => {
        const ld = Math.hypot((left.x ?? 0) - tower.gameObject.x, (left.y ?? 0) - tower.gameObject.y)
        const rd = Math.hypot((right.x ?? 0) - tower.gameObject.x, (right.y ?? 0) - tower.gameObject.y)
        return ld - rd
      })[0]
    return {
      parked01: tower.parked01 ?? 0,
      facingAngle: tower.facingAngle,
      frame: String(shadow?.frame?.name ?? '')
    }
  })
  assert(Math.abs(siegeDownDeploy.facingAngle - Math.PI / 2) < 0.001,
    `siegetower: screen-down deployment turned away mid-animation (${siegeDownDeploy.facingAngle})`)
  assert(siegeDownDeploy.frame.includes('_d2_attack'),
    `siegetower: screen-down deployment did not use its baked attack sequence (${siegeDownDeploy.frame})`)
  const siegeDownDeployShot = `${OUT}/siegetower-down-wall-deploy.png`
  await page.screenshot({ path: siegeDownDeployShot })
  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.scene.resume())
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const tower = scene.troops.find(troop => troop.id === 'siegetower-down-fixed')
    return (tower?.parked01 ?? 0) >= 0.999
  }, { timeout: 3_000, polling: 10 })
  const siegeDown = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const tower = scene.troops.find(troop => troop.id === 'siegetower-down-fixed')
    const wall = scene.buildings.find(building => building.id === 'siege-down-wall')
    scene['redrawTroopWithMovement'](tower, false)
    const shadow = scene.children.list
      .filter(child => child?.active && child?.type === 'Image'
        && String(child.texture?.key ?? '') === 'bank:troops:siegetower')
      .sort((left, right) => {
        const ld = Math.hypot((left.x ?? 0) - tower.gameObject.x, (left.y ?? 0) - tower.gameObject.y)
        const rd = Math.hypot((right.x ?? 0) - tower.gameObject.x, (right.y ?? 0) - tower.gameObject.y)
        return ld - rd
      })[0]
    const deployFrames = [...new Set((window.__overhaulSiegeDownTrace?.samples ?? [])
      .filter(sample => sample.parked01 > 0.03 && sample.parked01 < 0.999)
      .map(sample => sample.frame))]
    return {
      gap: scene['getTargetEdgeDistance'](tower, wall),
      facingAngle: tower.facingAngle,
      frame: String(shadow?.frame?.name ?? ''),
      deployFrames
    }
  })
  assert(Math.abs(siegeDown.facingAngle - Math.PI / 2) < 0.001,
    `siegetower: diagonal grid approach resolved to ${siegeDown.facingAngle}, not screen-down PI/2`)
  assert(siegeDown.frame.includes('_d2_deactivated'),
    `siegetower: screen-down park selected the wrong baked direction (${siegeDown.frame})`)
  assert(siegeDown.deployFrames.length >= 6,
    `siegetower: screen-down deployment used only ${siegeDown.deployFrames.length} baked poses (${JSON.stringify(siegeDown.deployFrames)})`)
  assert(siegeDown.deployFrames.every(frame => frame.includes('_d2_attack')),
    `siegetower: screen-down deployment escaped its d2 atlas sequence (${JSON.stringify(siegeDown.deployFrames)})`)
  const siegeDownShot = `${OUT}/siegetower-down-wall-park.png`
  await page.screenshot({ path: siegeDownShot })

  // Live mechanic regression: the route opens only after the deploy tongue
  // lands, drops the old target lock, chooses the nearer building through the
  // breach, and gives the crossing troop the established quick wall-hop.
  const rampSetup = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    window.__overhaulMonitorGeneration = (window.__overhaulMonitorGeneration ?? 0) + 1
    const generation = window.__overhaulMonitorGeneration
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene['clearScene']()
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene.villageLife.clear()
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)

    scene['instantiateBuilding']({
      id: 'ramp-near-inside', type: 'storage', gridX: 9, gridY: 9, level: 1
    }, 'ENEMY')
    scene['instantiateBuilding']({
      id: 'ramp-old-outside', type: 'storage', gridX: 2, gridY: 3, level: 1
    }, 'ENEMY')
    for (let x = 8; x <= 14; x++) {
      scene['instantiateBuilding']({ id: `ramp-wall-n-${x}`, type: 'wall', gridX: x, gridY: 8, level: 1 }, 'ENEMY')
      scene['instantiateBuilding']({ id: `ramp-wall-s-${x}`, type: 'wall', gridX: x, gridY: 14, level: 1 }, 'ENEMY')
    }
    for (let y = 9; y < 14; y++) {
      scene['instantiateBuilding']({ id: `ramp-wall-w-${y}`, type: 'wall', gridX: 8, gridY: y, level: 1 }, 'ENEMY')
      scene['instantiateBuilding']({ id: `ramp-wall-e-${y}`, type: 'wall', gridX: 14, gridY: y, level: 1 }, 'ENEMY')
    }
    scene.initialEnemyBuildings = scene.buildings.length

    scene.spawnTroop(4.5, 11.5, 'warrior', 'PLAYER', 1)
    const rider = scene.troops.at(-1)
    rider.id = 'siege-ramp-rider-fixed'
    rider.speedMult = 0
    rider.retargetPauseUntil = 0
    rider.nextPathTime = 0
    rider.navigationPlan = undefined
    scene['acquireTroopNavigation'](rider, scene.time.now)

    scene.spawnTroop(7.72, 11.5, 'siegetower', 'PLAYER', 1)
    const tower = scene.troops.at(-1)
    tower.id = 'siege-ramp-tower-fixed'
    tower.gridX = 7.72
    tower.gridY = 11.5
    const towerPos = { x: (tower.gridX - tower.gridY) * 32, y: (tower.gridX + tower.gridY) * 16 }
    tower.gameObject.setPosition(towerPos.x, towerPos.y)
    tower.target = scene.buildings.find(building => building.id === 'ramp-wall-w-11')
    tower.strategicTarget = tower.target
    scene['parkSiegeTower'](tower, scene.time.now)

    scene.cameras.main.setZoom(2.8)
    scene.cameras.main.centerOn(-64, 316)

    const trace = window.__overhaulRampTrace = {
      riderId: rider.id,
      towerId: tower.id,
      wallId: 'ramp-wall-w-11',
      initialTargetId: rider.strategicTarget?.id ?? null,
      prematureOpen: false,
      openedAt: null,
      parked01AtOpen: null,
      retargetedAt: null,
      minVisualOffsetY: 0,
      maxStep: 0,
      maxX: rider.gridX,
      previousX: rider.gridX,
      previousY: rider.gridY
    }
    const monitor = () => {
      if (generation !== window.__overhaulMonitorGeneration) return
      const liveScene = window.__clashGame.scene.keys.MainScene
      const liveRider = liveScene.troops.find(troop => troop.id === trace.riderId)
      const liveTower = liveScene.troops.find(troop => troop.id === trace.towerId)
      const isOpen = liveScene['rampedWallsByOwner'].PLAYER.has(trace.wallId)
      if (isOpen && (liveTower?.parked01 ?? 0) < 0.999) trace.prematureOpen = true
      if (isOpen && trace.openedAt === null) {
        trace.openedAt = liveScene.time.now
        trace.parked01AtOpen = liveTower?.parked01 ?? null
      }
      if (liveRider) {
        if (liveRider.strategicTarget?.id === 'ramp-near-inside' && trace.retargetedAt === null) {
          trace.retargetedAt = liveScene.time.now
        }
        trace.minVisualOffsetY = Math.min(trace.minVisualOffsetY, liveRider.visualOffsetY ?? 0)
        const step = Math.hypot(liveRider.gridX - trace.previousX, liveRider.gridY - trace.previousY)
        trace.maxStep = Math.max(trace.maxStep, step)
        trace.maxX = Math.max(trace.maxX, liveRider.gridX)
        trace.previousX = liveRider.gridX
        trace.previousY = liveRider.gridY
      }
      requestAnimationFrame(monitor)
    }
    requestAnimationFrame(monitor)
    return {
      initialTargetId: trace.initialTargetId,
      rampOpenAtStart: scene['rampedWallsByOwner'].PLAYER.has(trace.wallId)
    }
  })
  assert(rampSetup.initialTargetId === 'ramp-old-outside',
    `siegetower ramp: closed setup selected ${rampSetup.initialTargetId}, not the outside target`)
  assert(!rampSetup.rampOpenAtStart,
    'siegetower ramp: route opened at deployment start instead of completion')
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const rider = scene.troops.find(troop => troop.id === 'siege-ramp-rider-fixed')
    if (window.__overhaulRampTrace?.openedAt !== null
        && rider?.strategicTarget?.id === 'ramp-near-inside') {
      rider.speedMult = 1
      return true
    }
    return false
  }, { timeout: 5_000, polling: 5 })
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const rider = scene.troops.find(troop => troop.id === 'siege-ramp-rider-fixed')
    if ((rider?.visualOffsetY ?? 0) < -4) {
      scene.scene.pause()
      return true
    }
    return false
  }, { timeout: 6_000, polling: 2 })
  const rampHop = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const rider = scene.troops.find(troop => troop.id === 'siege-ramp-rider-fixed')
    const tower = scene.troops.find(troop => troop.id === 'siege-ramp-tower-fixed')
    const wall = scene.buildings.find(building => building.id === 'ramp-wall-w-11')
    const shadow = scene.children.list
      .filter(child => child?.active && child?.type === 'Image'
        && String(child.texture?.key ?? '') === 'bank:troops:warrior')
      .sort((left, right) => {
        const ld = Math.hypot((left.x ?? 0) - rider.gameObject.x, (left.y ?? 0) - rider.gameObject.y)
        const rd = Math.hypot((right.x ?? 0) - rider.gameObject.x, (right.y ?? 0) - rider.gameObject.y)
        return ld - rd
      })[0]
    const groundY = (rider.gridX + rider.gridY) * 16
    return {
      targetId: rider.strategicTarget?.id,
      x: rider.gridX,
      y: rider.gridY,
      wallDistance: Math.hypot(rider.gridX - (wall.gridX + 0.5), rider.gridY - (wall.gridY + 0.5)),
      visualOffsetY: rider.visualOffsetY ?? 0,
      carrierLift: groundY - rider.gameObject.y,
      riderDepth: rider.gameObject.depth,
      towerDepth: tower.gameObject.depth,
      frame: String(shadow?.frame?.name ?? ''),
      rampUsers: scene['rampUsersByOwner'].PLAYER.get(wall.id)?.size ?? 0,
      wallHealth: wall.health
    }
  })
  assert(rampHop.targetId === 'ramp-near-inside',
    `siegetower ramp: rider kept ${rampHop.targetId} while crossing`)
  assert(rampHop.visualOffsetY < -4 && rampHop.carrierLift > 4,
    `siegetower ramp: rider crossed without a visible hop (${JSON.stringify(rampHop)})`)
  assert(rampHop.wallDistance < 0.55,
    `siegetower ramp: hop fired away from the ramp wall (${rampHop.wallDistance})`)
  assert(rampHop.riderDepth > rampHop.towerDepth,
    `siegetower ramp: hopping rider depth ${rampHop.riderDepth} did not clear tower ${rampHop.towerDepth}`)
  assert(rampHop.frame.includes('_walk'),
    `siegetower ramp: hop did not retain a baked walk pose (${rampHop.frame})`)
  assert(rampHop.rampUsers === 1, `siegetower ramp: expected one live contributor, got ${rampHop.rampUsers}`)
  const rampHopShot = `${OUT}/siegetower-rider-hop.png`
  await page.screenshot({ path: rampHopShot })
  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.scene.resume())
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const rider = scene.troops.find(troop => troop.id === 'siege-ramp-rider-fixed')
    return rider?.gridX > 9 && Math.abs(rider.visualOffsetY ?? 0) < 0.01
  }, { timeout: 6_000, polling: 10 })
  const rampTrace = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const wall = scene.buildings.find(building => building.id === 'ramp-wall-w-11')
    return { ...window.__overhaulRampTrace, wallHealth: wall?.health ?? 0 }
  })
  assert(!rampTrace.prematureOpen && rampTrace.parked01AtOpen >= 0.999,
    `siegetower ramp: opened before deploy completion (${JSON.stringify(rampTrace)})`)
  assert(rampTrace.retargetedAt !== null && rampTrace.retargetedAt >= rampTrace.openedAt,
    'siegetower ramp: did not make a fresh target choice when the route opened')
  assert(rampTrace.minVisualOffsetY < -4 && rampTrace.maxX > 9,
    `siegetower ramp: rider did not complete the hop (${JSON.stringify(rampTrace)})`)
  assert(rampTrace.maxStep > 0.08,
    `siegetower ramp: crossing never received the quick speed burst (${rampTrace.maxStep})`)
  assert(rampTrace.wallHealth === rampHop.wallHealth,
    'siegetower ramp: covered wall was attacked instead of treated as absent')

  // Ornithopter A: its 1.2x multiplier is presentation-only, but it must be
  // identical on the live SpriteBank path and the loose/replay path. Park the
  // craft over the middle of an L4 straight run and sample the actual IDLE
  // clock: this specifically prevents the craft from regressing to a static
  // silhouette that only bobs in the air.
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    window.__overhaulMonitorGeneration = (window.__overhaulMonitorGeneration ?? 0) + 1
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene['clearScene']()
    scene.mode = 'HOME'
    scene.isScouting = true
    scene.villageLife.clear()
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)

    for (let x = 9; x <= 11; x++) {
      scene['instantiateBuilding']({
        id: `ornithopter-wall-${x}`, type: 'wall', gridX: x, gridY: 10, level: 4
      }, 'ENEMY')
    }
    scene.spawnTroop(8, 8, 'ornithopter', 'PLAYER', 3)
    scene.troops.at(-1).id = 'ornithopter-clearance-fixed'
  })
  // Let the ordinary 200 ms deploy bounce finish so carrier scale cannot
  // contaminate the authored 1.2x presentation measurement.
  await sleep(260)
  const ornithopter = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const unit = scene.troops.find(troop => troop.id === 'ornithopter-clearance-fixed')
    unit.gridX = 10
    unit.gridY = 10
    unit.facingAngle = Math.PI / 4
    unit.path = undefined
    unit.target = null
    unit.visualOffsetY = 0
    const pos = { x: 0, y: 320 }
    unit.gameObject.setPosition(pos.x, pos.y)
    unit.gameObject.setScale(1)
    unit.gameObject.setDepth(99_999)
    scene['redrawTroopWithMovement'](unit, false)

    const nearestShadow = carrier => scene.children.list
      .filter(child => child?.active
        && child?.type === 'Image'
        && String(child.texture?.key ?? '') === 'bank:troops:ornithopter')
      .sort((left, right) => {
        const ld = Math.hypot((left.x ?? 0) - carrier.x, (left.y ?? 0) - carrier.y)
        const rd = Math.hypot((right.x ?? 0) - carrier.x, (right.y ?? 0) - carrier.y)
        return ld - rd
      })[0]
    const liveShadow = nearestShadow(unit.gameObject)

    // createReplayTroop is a local presentation constructor. Calling it here
    // exercises the same syncLooseTroop stamp used by replay frames (and camp
    // figures) without inserting the figure into the battle or backend.
    const replay = scene['createReplayTroop']({
      id: 'ornithopter-replay-scale-fixed',
      type: 'ornithopter', level: 3, owner: 'PLAYER',
      gridX: 12, gridY: 12, health: 1, maxHealth: 1,
      facingAngle: Math.PI / 4, hasTakenDamage: false
    })
    const replayShadow = replay ? nearestShadow(replay.gameObject) : null
    const result = {
      gridX: unit.gridX,
      gridY: unit.gridY,
      visualOffsetY: unit.visualOffsetY,
      carrierScale: unit.gameObject.scaleX,
      liveAtlas: String(liveShadow?.texture?.key ?? ''),
      liveFrame: String(liveShadow?.frame?.name ?? ''),
      liveScale: liveShadow?.scaleX,
      replayAtlas: String(replayShadow?.texture?.key ?? ''),
      replayFrame: String(replayShadow?.frame?.name ?? ''),
      replayScale: replayShadow?.scaleX,
    }
    replay?.gameObject.destroy()
    replay?.healthBar.destroy()

    scene.cameras.main.setZoom(4)
    scene.cameras.main.centerOn(0, 310)
    return result
  })
  const bakedWorldScale = 1.35 * 1.2
  assert(ornithopter.gridX === 10 && ornithopter.gridY === 10 && ornithopter.visualOffsetY === 0,
    'ornithopter: presentation tuning changed its combat-grid position')
  assert(ornithopter.carrierScale === 1,
    `ornithopter: deploy carrier did not settle at gameplay scale 1 (${ornithopter.carrierScale})`)
  assert(ornithopter.liveAtlas === 'bank:troops:ornithopter'
      && ornithopter.liveFrame.includes('_d1_idle'),
    `ornithopter: live path missed promoted baked A idle art (${ornithopter.liveAtlas}/${ornithopter.liveFrame})`)
  assert(Math.abs(ornithopter.liveScale - bakedWorldScale) < 0.0001,
    `ornithopter: live baked scale ${ornithopter.liveScale}, expected ${bakedWorldScale}`)
  assert(ornithopter.replayAtlas === 'bank:troops:ornithopter',
    `ornithopter: replay/loose path missed promoted baked A art (${ornithopter.replayAtlas})`)
  assert(Math.abs(ornithopter.replayScale - bakedWorldScale) < 0.0001,
    `ornithopter: replay/loose baked scale ${ornithopter.replayScale}, expected ${bakedWorldScale}`)
  const ornithopterFrames = []
  const ornithopterShot = `${OUT}/ornithopter-a-idle-flap-a.png`
  const ornithopterShotB = `${OUT}/ornithopter-a-idle-flap-b.png`
  for (let sample = 0; sample < 13; sample++) {
    const frame = await page.evaluate(() => {
      const scene = window.__clashGame.scene.keys.MainScene
      const unit = scene.troops.find(troop => troop.id === 'ornithopter-clearance-fixed')
      scene['redrawTroopWithMovement'](unit, false)
      const shadow = scene.children.list
        .filter(child => child?.active && child?.type === 'Image'
          && String(child.texture?.key ?? '') === 'bank:troops:ornithopter')
        .sort((left, right) => {
          const ld = Math.hypot((left.x ?? 0) - unit.gameObject.x, (left.y ?? 0) - unit.gameObject.y)
          const rd = Math.hypot((right.x ?? 0) - unit.gameObject.x, (right.y ?? 0) - unit.gameObject.y)
          return ld - rd
        })[0]
      return String(shadow?.frame?.name ?? '')
    })
    ornithopterFrames.push(frame)
    if (sample === 2) await page.screenshot({ path: ornithopterShot })
    if (sample === 8) await page.screenshot({ path: ornithopterShotB })
    await sleep(90)
  }
  const ornithopterIdleFrames = [...new Set(ornithopterFrames)]
  assert(ornithopterFrames.every(frame => frame.includes('_d1_idle')),
    `ornithopter: idle sampling escaped the idle atlas (${JSON.stringify(ornithopterFrames)})`)
  assert(ornithopterIdleFrames.length >= 4,
    `ornithopter: idle wing cycle used only ${ornithopterIdleFrames.length} baked frames (${JSON.stringify(ornithopterIdleFrames)})`)

  // Army Camp figures normally stamp one idle pose and sleep until they turn
  // or shift stations. An airborne Ornithopter is the exception: exercise the
  // real VillageLifeSystem camp path and prove its wing loop keeps repainting.
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene['clearScene']()
    scene.mode = 'HOME'
    scene.isScouting = true
    scene.villageLife.clear()
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)
    scene['instantiateBuilding']({
      id: 'ornithopter-camp', type: 'army_camp', gridX: 10, gridY: 10, level: 4
    }, 'PLAYER')
    const camp = scene.buildings.find(building => building.id === 'ornithopter-camp')
    scene.villageLife['spawnCampFigure']('ornithopter', [camp], undefined, scene.time.now, true)
    const figure = scene.villageLife.campFigures.find(item => item.type === 'ornithopter')
    figure.idleUntil = Number.POSITIVE_INFINITY
    scene.cameras.main.setZoom(4)
    scene.cameras.main.centerOn(0, 355)
  })
  const ornithopterCampFrames = []
  const ornithopterCampShot = `${OUT}/ornithopter-army-camp-idle-a.png`
  const ornithopterCampShotB = `${OUT}/ornithopter-army-camp-idle-b.png`
  for (let sample = 0; sample < 13; sample++) {
    const frame = await page.evaluate(() => {
      const scene = window.__clashGame.scene.keys.MainScene
      const figure = scene.villageLife.campFigures.find(item => item.type === 'ornithopter')
      const shadow = scene.children.list
        .filter(child => child?.active && child?.type === 'Image'
          && String(child.texture?.key ?? '') === 'bank:troops:ornithopter')
        .sort((left, right) => {
          const ld = Math.hypot((left.x ?? 0) - figure.gfx.x, (left.y ?? 0) - figure.gfx.y)
          const rd = Math.hypot((right.x ?? 0) - figure.gfx.x, (right.y ?? 0) - figure.gfx.y)
          return ld - rd
        })[0]
      return String(shadow?.frame?.name ?? '')
    })
    ornithopterCampFrames.push(frame)
    if (sample === 2) await page.screenshot({ path: ornithopterCampShot })
    if (sample === 8) await page.screenshot({ path: ornithopterCampShotB })
    await sleep(90)
  }
  const ornithopterCampIdleFrames = [...new Set(ornithopterCampFrames)]
  assert(ornithopterCampFrames.every(frame => frame.includes('_d0_idle')),
    `ornithopter: Army Camp sampling escaped the idle atlas (${JSON.stringify(ornithopterCampFrames)})`)
  assert(ornithopterCampIdleFrames.length >= 4,
    `ornithopter: Army Camp wing cycle froze on ${ornithopterCampIdleFrames.length} frame(s) (${JSON.stringify(ornithopterCampIdleFrames)})`)
  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.scene.pause())

  // Da Vinci Tank: a shot keeps its current direction bucket while an
  // explicit normalized driver walks the six in-between cannon-ring poses,
  // then commits the next 45-degree idle bucket without a visual seam.
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    scene.scene.resume()
    window.__overhaulMonitorGeneration = (window.__overhaulMonitorGeneration ?? 0) + 1
    const generation = window.__overhaulMonitorGeneration
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene['clearScene']()
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene.villageLife.clear()
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)

    scene['instantiateBuilding']({
      id: 'davinci-target', type: 'cannon', gridX: 10, gridY: 10, level: 1
    }, 'ENEMY')
    const target = scene.buildings.find(building => building.id === 'davinci-target')
    scene.initialEnemyBuildings = 1
    scene.spawnTroop(7.5, 10.5, 'davincitank', 'PLAYER', 1)
    const unit = scene.troops.at(-1)
    unit.id = 'davincitank-spin-fixed'
    unit.facingAngle = 0
    unit.target = target
    unit.strategicTarget = target
    unit.path = undefined
    unit.navigationPlan = undefined
    unit.retargetPauseUntil = 0
    unit.nextPathTime = scene.time.now + 10_000
    unit.lastAttackTime = scene.time.now - unit.attackDelay - 2
    unit.attackClockActive = false

    scene.cameras.main.setZoom(3.2)
    scene.cameras.main.centerOn(-42, 310)

    const trace = window.__overhaulTankTrace = {
      id: unit.id,
      startedAt: scene.time.now,
      baseAngle: unit.facingAngle,
      sawSpin: false,
      completed: false,
      samples: []
    }
    const monitor = () => {
      if (generation !== window.__overhaulMonitorGeneration || trace.completed) return
      const liveScene = window.__clashGame.scene.keys.MainScene
      const live = liveScene.troops.find(troop => troop.id === trace.id)
      if (!live) return
      const shadow = liveScene.children.list
        .filter(child => child?.active && child?.type === 'Image'
          && String(child.texture?.key ?? '') === 'bank:troops:davincitank')
        .sort((left, right) => {
          const ld = Math.hypot((left.x ?? 0) - live.gameObject.x, (left.y ?? 0) - live.gameObject.y)
          const rd = Math.hypot((right.x ?? 0) - live.gameObject.x, (right.y ?? 0) - live.gameObject.y)
          return ld - rd
        })[0]
      const spin = live.tankSpin01 ?? 0
      const angle = live.facingAngle ?? 0
      const frame = String(shadow?.frame?.name ?? '')
      trace.samples.push({ t: liveScene.time.now - trace.startedAt, spin, angle, frame })
      if (spin > 0.03) trace.sawSpin = true
      const angleStep = Math.atan2(
        Math.sin(angle - trace.baseAngle),
        Math.cos(angle - trace.baseAngle)
      )
      if (trace.sawSpin && spin <= 0.001 && Math.abs(angleStep - Math.PI / 4) < 0.01) {
        trace.completed = true
        trace.finalAngle = angle
        trace.finalSpin = spin
        trace.finalFrame = frame
        return
      }
      if (liveScene.time.now - trace.startedAt < 1_200) requestAnimationFrame(monitor)
    }
    requestAnimationFrame(monitor)
  })
  await page.waitForFunction(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const unit = scene.troops.find(troop => troop.id === 'davincitank-spin-fixed')
    const spin = unit?.tankSpin01 ?? 0
    if (spin > 0.3 && spin < 0.95) {
      scene.scene.pause()
      return true
    }
    return false
  }, { timeout: 5_000, polling: 2 })
  const tankMidSpin = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const unit = scene.troops.find(troop => troop.id === 'davincitank-spin-fixed')
    const shadow = scene.children.list
      .filter(child => child?.active && child?.type === 'Image'
        && String(child.texture?.key ?? '') === 'bank:troops:davincitank')
      .sort((left, right) => {
        const ld = Math.hypot((left.x ?? 0) - unit.gameObject.x, (left.y ?? 0) - unit.gameObject.y)
        const rd = Math.hypot((right.x ?? 0) - unit.gameObject.x, (right.y ?? 0) - unit.gameObject.y)
        return ld - rd
      })[0]
    return {
      spin: unit?.tankSpin01,
      facingAngle: unit?.facingAngle,
      frame: String(shadow?.frame?.name ?? '')
    }
  })
  assert(tankMidSpin.frame.includes('_d0_attack'),
    `davincitank: mid-spin missed its baked attack sequence (${tankMidSpin.frame})`)
  const tankShot = `${OUT}/davincitank-live-spin.png`
  await page.screenshot({ path: tankShot })
  await page.evaluate(() => window.__clashGame.scene.keys.MainScene.scene.resume())
  await page.waitForFunction(() => window.__overhaulTankTrace?.completed,
    { timeout: 3_000, polling: 5 })
  const tankLive = await page.evaluate(() => window.__overhaulTankTrace)
  const tankAttackSamples = tankLive.samples.filter(sample => sample.spin > 0.03)
  const tankAttackFrames = [...new Set(tankAttackSamples.map(sample => sample.frame))]
  const tankAngleStep = Math.atan2(
    Math.sin(tankLive.finalAngle - tankLive.baseAngle),
    Math.cos(tankLive.finalAngle - tankLive.baseAngle)
  )
  assert(tankAttackSamples.length >= 4,
    `davincitank: live spin produced only ${tankAttackSamples.length} driven samples`)
  assert(tankAttackSamples.every(sample => sample.frame.includes('_d0_attack')),
    `davincitank: live spin escaped its attack atlas (${JSON.stringify(tankAttackFrames)})`)
  assert(tankAttackFrames.length >= 4,
    `davincitank: live spin used only ${tankAttackFrames.length} baked poses (${JSON.stringify(tankAttackFrames)})`)
  assert(Math.abs(tankAngleStep - Math.PI / 4) < 0.01 && tankLive.finalSpin === 0,
    `davincitank: final turn was ${tankAngleStep} radians with driver ${tankLive.finalSpin}`)
  assert(tankLive.finalFrame.includes('_d1_idle'),
    `davincitank: attack endpoint did not release seamlessly to next idle (${tankLive.finalFrame})`)

  // Replay snapshots are intentionally coarse. Reconstruct the same 200 ms
  // driver from a two-bay endpoint change (the post-90s 2-second stream
  // cadence can span two shots) and verify both turns use the attack atlas
  // before landing on the final idle direction.
  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    window.__overhaulMonitorGeneration = (window.__overhaulMonitorGeneration ?? 0) + 1
    scene.mode = 'ATTACK'
    scene.isScouting = true
    scene.raidEndScheduled = true
    scene.currentEnemyWorld = null
    scene['clearScene']()
    scene.mode = 'REPLAY'
    scene.villageLife.clear()
    scene.dayNight.setPhaseOverride(0.3)
    scene.weather?.setWeatherOverride?.(0)
    const initial = {
      id: 'davincitank-replay-spin-fixed', type: 'davincitank', level: 1,
      owner: 'PLAYER', gridX: 10, gridY: 10, health: 100, maxHealth: 100,
      facingAngle: 0, hasTakenDamage: false
    }
    const troop = scene['createReplayTroop'](initial)
    scene.troops = [troop]
    const pending = {
      t: 2000, destruction: 0, goldLooted: 0, oreLooted: 0, foodLooted: 0,
      buildings: [],
      troops: [{ ...initial, facingAngle: Math.PI / 2 }]
    }
    scene['replayWatchState'] = {
      attackId: 'davinci-replay-fixture', mode: 'replay', renderClockT: 0,
      clockStarted: true, nextFrameIndex: 0, lastAppliedFrameT: 0,
      lastFetchedFrameT: 2000, status: 'finished', pollInFlight: false,
      frames: [pending]
    }
    scene.cameras.main.setZoom(4)
    scene.cameras.main.centerOn(0, 308)
    scene.scene.pause()
    window.__overhaulTankReplayPending = pending
  })
  const tankReplaySamples = []
  let tankReplayShot = null
  for (const renderT of [1620, 1680, 1740, 1780, 1820, 1880, 1940, 1980]) {
    const sample = await page.evaluate(t => {
      const scene = window.__clashGame.scene.keys.MainScene
      scene['replayWatchState'].renderClockT = t
      scene['updateReplayTroopSmoothing'](16)
      const unit = scene.troops.find(troop => troop.id === 'davincitank-replay-spin-fixed')
      const shadow = scene.children.list
        .filter(child => child?.active && child?.type === 'Image'
          && String(child.texture?.key ?? '') === 'bank:troops:davincitank')
        .sort((left, right) => {
          const ld = Math.hypot((left.x ?? 0) - unit.gameObject.x, (left.y ?? 0) - unit.gameObject.y)
          const rd = Math.hypot((right.x ?? 0) - unit.gameObject.x, (right.y ?? 0) - unit.gameObject.y)
          return ld - rd
        })[0]
      return { spin: unit.tankSpin01 ?? 0, frame: String(shadow?.frame?.name ?? '') }
    }, renderT)
    tankReplaySamples.push(sample)
    if (renderT === 1820) {
      tankReplayShot = `${OUT}/davincitank-replay-spin.png`
      await page.screenshot({ path: tankReplayShot })
    }
  }
  const tankReplayFrames = [...new Set(tankReplaySamples.map(sample => sample.frame))]
  assert(tankReplaySamples.every(sample => /_d[01]_attack/.test(sample.frame)),
    `davincitank: replay spin escaped its attack atlas (${JSON.stringify(tankReplayFrames)})`)
  assert(tankReplayFrames.some(frame => frame.includes('_d0_attack'))
      && tankReplayFrames.some(frame => frame.includes('_d1_attack')),
    `davincitank: replay did not chain both bay turns (${JSON.stringify(tankReplayFrames)})`)
  assert(tankReplayFrames.length >= 6,
    `davincitank: replay spin used only ${tankReplayFrames.length} poses (${JSON.stringify(tankReplayFrames)})`)
  const tankReplayFinal = await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const pending = window.__overhaulTankReplayPending
    scene['replayWatchState'].nextFrameIndex = 1
    scene['applyReplayFrame'](pending)
    const unit = scene.troops.find(troop => troop.id === 'davincitank-replay-spin-fixed')
    scene['redrawTroopWithMovement'](unit, false)
    const shadow = scene.children.list
      .filter(child => child?.active && child?.type === 'Image'
        && String(child.texture?.key ?? '') === 'bank:troops:davincitank')
      .sort((left, right) => {
        const ld = Math.hypot((left.x ?? 0) - unit.gameObject.x, (left.y ?? 0) - unit.gameObject.y)
        const rd = Math.hypot((right.x ?? 0) - unit.gameObject.x, (right.y ?? 0) - unit.gameObject.y)
        return ld - rd
      })[0]
    return {
      spin: unit.tankSpin01 ?? 0,
      facingAngle: unit.facingAngle,
      frame: String(shadow?.frame?.name ?? '')
    }
  })
  assert(tankReplayFinal.spin === 0 && Math.abs(tankReplayFinal.facingAngle - Math.PI / 2) < 0.001,
    `davincitank: replay endpoint was angle ${tankReplayFinal.facingAngle}, driver ${tankReplayFinal.spin}`)
  assert(tankReplayFinal.frame.includes('_d2_idle'),
    `davincitank: replay endpoint did not land on next idle (${tankReplayFinal.frame})`)

  assert(pageErrors.length === 0, `browser page errors: ${pageErrors.join(' | ')}`)
  console.log('overhaul troop browser regressions passed', {
    goblinMotion,
    beetleMotion,
    beetleLatch: {
      leapMs: latchTimes.landedAt - latchTimes.startedAt,
      fuseMs: latchTimes.detonateAt - latchTimes.landedAt,
      lastAliveAfterLandingMs: beetleLatch.lastAliveAt - latchTimes.landedAt,
      disappearedAfterDetonateMs: beetleLatch.disappearedAt - latchTimes.detonateAt,
      targetDamage: beetleLatch.targetHealthBefore - beetleLatch.targetHealthAfter,
      minVisualOffsetY: beetleLatch.minVisualOffsetY,
      latchRotationDegrees: Number((midLatch.carrierRotation * 180 / Math.PI).toFixed(2))
    },
    siegeTower,
    siegeDownDeploy,
    siegeDown,
    siegeRamp: { hop: rampHop, trace: rampTrace },
    ornithopter: {
      ...ornithopter,
      idleFrames: ornithopterIdleFrames,
      campIdleFrames: ornithopterCampIdleFrames
    },
    davincitank: {
      midSpin: tankMidSpin,
      liveAttackFrames: tankAttackFrames,
      finalFrame: tankLive.finalFrame,
      replayAttackFrames: tankReplayFrames,
      replayFinal: tankReplayFinal
    },
    screenshots: {
      latch: latchShot,
      siege: siegeShot,
      siegeDown: [siegeDownDeployShot, siegeDownShot],
      siegeRamp: rampHopShot,
      ornithopter: [ornithopterShot, ornithopterShotB],
      ornithopterCamp: [ornithopterCampShot, ornithopterCampShotB],
      davincitank: [tankShot, tankReplayShot]
    }
  })
} finally {
  await browser?.close()
}
