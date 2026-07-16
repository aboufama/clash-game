// The zero-error soak: cycles the client through every mode transition and
// stressor — day/night, bot raids with live combat, the merchant, the dragon,
// relocation — while recording EVERY page error. Passes only at zero.
// Also injects a deliberate per-frame throw to prove the update() bulkhead
// keeps the game loop alive through an unknown bug.
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const CYCLES = Number(process.env.SOAK_CYCLES ?? 2)

const session = await (await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => localStorage.setItem('clash.device.token', tok), session.token)
  const errors = []
  page.on('pageerror', e => {
    errors.push(String(e.message).slice(0, 300))
    console.log('PAGE ERROR:', String(e.message).slice(0, 200))
  })
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  await sleep(2000)

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    console.log(`--- soak cycle ${cycle}/${CYCLES} ---`)

    // Day/night flips (lights, festival roll, thief scheduling, villager sleep).
    for (const phase of [0.8, 0.35, 0.8, 0.35]) {
      await page.evaluate(ph => {
        window.__clashGame.scene.keys.MainScene.dayNight.setPhaseOverride(ph)
      }, phase)
      await sleep(1500)
    }

    // Summon the dragon over the village (panic + drape + calm).
    await page.evaluate(() => {
      const s = window.__clashGame.scene.keys.MainScene
      s.villageLife.spawnDragonShadow()
    })
    await sleep(2500)

    // Force the merchant in and out.
    await page.evaluate(() => {
      const s = window.__clashGame.scene.keys.MainScene
      s.villageLife.nextMerchantAt = 1
    })
    await sleep(3000)

    // Raid a bot plot: full combat with every troop archetype, then auto-home.
    await page.evaluate(() => {
      const s = window.__clashGame.scene.keys.MainScene
      s.attackBotPlot(1337 + Math.floor(s.time.now), 'Soakhollow')
    })
    await sleep(3500)
    await page.evaluate(() => {
      const s = window.__clashGame.scene.keys.MainScene
      if (s.mode !== 'ATTACK') return
      s.hasDeployed = true
      s.spawnTroop(12, 22, 'golem', 'PLAYER')
      s.spawnTroop(11, 22, 'warrior', 'PLAYER')
      s.spawnTroop(13, 22, 'archer', 'PLAYER')
      s.spawnTroop(10, 22, 'ram', 'PLAYER')
      s.spawnTroop(14, 22, 'davincitank', 'PLAYER')
      s.spawnTroop(12, 23, 'phalanx', 'PLAYER')
      s.spawnTroop(11, 23, 'wallbreaker', 'PLAYER')
    })
    // Let the battle rage — golem slams, tank volleys, deaths mid-animation.
    await sleep(12000)
    await page.evaluate(async () => {
      const s = window.__clashGame.scene.keys.MainScene
      if (s.mode === 'ATTACK') {
        s.endAttackReplayCapture('aborted')
        await s.goHome()
        const gm = s.villageLife // touch
        void gm
      }
    })
    await sleep(3000)
  }

  // Bulkhead proof: inject a throwing subsystem for ~40 frames; the loop must survive.
  const bulkhead = await page.evaluate(async () => {
    const s = window.__clashGame.scene.keys.MainScene
    const original = s.villageLife.update.bind(s.villageLife)
    let injected = 0
    s.villageLife.update = () => {
      injected += 1
      throw new Error('soak-injected-crash')
    }
    await new Promise(r => setTimeout(r, 700))
    s.villageLife.update = original
    await new Promise(r => setTimeout(r, 700))
    return {
      injected,
      errorsCaught: s.updateErrorCount,
      fpsAlive: window.__clashGame.loop.actualFps > 10,
      timeAdvancing: s.time.now > 0
    }
  })
  console.log('bulkhead:', JSON.stringify(bulkhead))

  const fps = await page.evaluate(() => Math.round(window.__clashGame.loop.actualFps))
  console.log(`soak finished: ${CYCLES} cycles, fps=${fps}, page errors=${errors.length}`)
  if (errors.length > 0) {
    console.log('FAIL — errors:', errors.slice(0, 10))
    process.exitCode = 1
  } else if (!bulkhead.fpsAlive || bulkhead.errorsCaught === 0) {
    console.log('FAIL — bulkhead did not absorb the injected crash')
    process.exitCode = 1
  } else {
    console.log('PASS — zero page errors, bulkhead absorbed', bulkhead.errorsCaught, 'injected crashes with the loop alive')
  }
} finally {
  await browser.close()
}
