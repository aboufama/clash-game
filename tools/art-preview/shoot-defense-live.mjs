// The full MMO defence loop, end to end, with a smoothness metric:
//   attacker (page B) raids the victim (page A, sitting at home) ->
//   A's siege alarm fires -> A watches the live stream -> troop motion is
//   sampled every 100ms to prove the stream plays without jumps ->
//   the raid ends -> A calms down and receives a shield.
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = new URL('./shots/', import.meta.url).pathname

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
  })
  return res.json()
}

const victim = await api('POST', '/auth/session')
const attacker = await api('POST', '/auth/session')
const vw = victim.world
vw.buildings = [
  { id: 'V1', type: 'town_hall', gridX: 11, gridY: 10, level: 1 },
  { id: 'V2', type: 'cannon', gridX: 9, gridY: 13, level: 2 },
  { id: 'V3', type: 'barracks', gridX: 14, gridY: 12, level: 4 },
  { id: 'V4', type: 'farm', gridX: 8, gridY: 9, level: 1 }
]
await api('POST', '/world/save', { token: victim.token, body: { world: vw, requestId: 'dl-v' } })

// Fresh accounts carry a starter shield; the victim must march once to drop
// it, or the raid below is (correctly!) refused by the shield system.
const lb = await api('GET', '/leaderboard', { token: victim.token })
for (const cand of lb.players ?? []) {
  if (cand.id === victim.player.id || cand.id === attacker.player.id) continue
  const drop = await api('POST', '/attacks/start', { token: victim.token, body: { targetId: cand.id } })
  if (drop.attackId) {
    await api('POST', '/attacks/end', { token: victim.token, body: { attackId: drop.attackId, destruction: 0, goldLooted: 0, status: 'aborted' } })
    console.log('victim shield dropped by marching once')
    break
  }
}

// Two SEPARATE browsers: a background tab's rAF (and with it Phaser's whole
// update loop) freezes, so attacker and defender each need their own window.
const launch = () => puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})
const browserA = await launch()
const browserB = await launch()
const sleep = ms => new Promise(r => setTimeout(r, ms))

const bootPage = async (browser, token, tag = '') => {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => localStorage.setItem('clash.device.token', tok), token)
  page.on('pageerror', e => console.log(tag, 'PAGE ERROR:', String(e.message).slice(0, 200)))
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') console.log(tag, 'console:', m.text().slice(0, 160)) })
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction(() => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0, { timeout: 45000, polling: 500 })
  return page
}

try {
  const pageA = await bootPage(browserA, victim.token, '[A]')   // the defender, at home
  const pageB = await bootPage(browserB, attacker.token, '[B]') // the raider
  await sleep(1500)

  // B marches on A and deploys a squad.
  await pageB.evaluate((targetId, targetName) => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.35)
    window.gameManagerRef = s
    const gm = Object.getOwnPropertyNames(window)
    void gm
    // route through the same facade the UI uses
    const anyWin = window
    anyWin.__clashGame.scene.keys.MainScene && (void 0)
    // gameManager singleton is module-scoped; the scene commands are registered on it.
    // Reach it via the scene's registered command instead:
    s.villageLife // touch
    return void (window.__attack = { targetId, targetName })
  }, victim.player.id, victim.player.username)
  await pageB.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    // The scene registered its commands on the gameManager singleton; the
    // command lambdas are closures — call the public scene path directly.
    const cmds = s
    void cmds
  })
  // Simplest reliable route: the gameManager module is reachable through the scene's own reference chain.
  await pageB.evaluate(({ targetId, targetName }) => {
    const s = window.__clashGame.scene.keys.MainScene
    // MainScene imports the gameManager singleton; grab it off any registered callback's closure is
    // not possible — but the scene exposes the same flow publicly for the world map's Attack button:
    // player attacks route through gameManager.startAttackOnUser, which the scene registered.
    // We invoke the underlying scene command the same way GameManager does.
    return new Promise(resolve => {
      const tryStart = () => {
        const wm = s.worldMap
        void wm
        // The command registry lives in the GameManager singleton; simplest access:
        // the scene's showCloudTransition + generateEnemyVillageFromUser are the internals of startAttackOnUser.
        s.showCloudTransition(async () => {
          await s.beginAttackSession(false)
          const okLoad = await s.generateEnemyVillageFromUser(targetId, targetName, true)
          if (!okLoad) console.warn('target base failed to load')
          s.centerCamera()
          s.resetBattleStats()
          resolve(true)
        })
      }
      tryStart()
    })
  }, { targetId: victim.player.id, targetName: victim.player.username })
  await sleep(3500)
  await pageB.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    // Deploy a raiding party along the southern edge.
    s.spawnTroop(11, 20, 'warrior', 'PLAYER')
    s.spawnTroop(12, 20, 'warrior', 'PLAYER')
    s.spawnTroop(10, 20, 'archer', 'PLAYER')
    s.spawnTroop(13, 20, 'golem', 'PLAYER')
  })
  console.log('attack deployed')

  // Confirm the server actually registered the raid before waiting on the alarm.
  let registered = false
  for (let i = 0; i < 10; i++) {
    const check = await api('GET', '/map?r=0', { token: victim.token })
    if (check.plots?.[0]?.underAttack) { registered = true; break }
    await sleep(1000)
  }
  console.log('server sees the raid:', registered)
  if (!registered) throw new Error('attack was never registered server-side — page B flow failed')

  // A's siege alarm should fire on the fast home poll.
  await pageA.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.dayNight.setPhaseOverride(0.35)
    s.worldMap.nextHomePollAt = 0
  })
  await pageA.waitForFunction(() => {
    const s = window.__clashGame.scene.keys.MainScene
    return Boolean(s.worldMap?.alarm)
  }, { timeout: 20000, polling: 400 })
  console.log('siege alarm raised on the defender screen')
  await sleep(600)
  await pageA.screenshot({ path: `${OUT}defense-alarm.png` })

  // A watches the live defence.
  const attackId = await pageA.evaluate(() => window.__clashGame.scene.keys.MainScene.worldMap.homeAttackId)
  await pageA.evaluate((id) => {
    const s = window.__clashGame.scene.keys.MainScene
    return s.startReplayWatch(id, 'live')
  }, attackId)
  await sleep(2500)

  // Smoothness metric: follow ONE troop (by id) every 100ms while it lives.
  // Moving steps only — a troop pausing to swing is legitimate stillness.
  const metric = await pageA.evaluate(async () => {
    const s = window.__clashGame.scene.keys.MainScene
    const pick = s.troops.find(tr => tr.health > 0 && tr.type === 'golem') ?? s.troops.find(tr => tr.health > 0)
    if (!pick) return null
    const id = pick.id
    const samples = []
    for (let i = 0; i < 60; i++) {
      const t = s.troops.find(tr => tr.id === id && tr.health > 0)
      if (!t) break
      samples.push({ x: t.gameObject.x, y: t.gameObject.y })
      await new Promise(r => setTimeout(r, 100))
    }
    const steps = []
    for (let i = 1; i < samples.length; i++) {
      steps.push(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y))
    }
    const movingSteps = steps.filter(d => d > 0.5)
    if (movingSteps.length === 0) return { samples: samples.length, moving: 0 }
    const sorted = [...movingSteps].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const max = Math.max(...movingSteps)
    return { samples: samples.length, moving: movingSteps.length, medianStep: Number(median.toFixed(2)), maxStep: Number(max.toFixed(2)) }
  })
  console.log('stream smoothness:', JSON.stringify(metric))
  if (!metric || metric.maxStep === undefined) {
    console.log('!! STREAM FAILURE — no troops were ever sampled (playback did not run)')
  } else if (metric.maxStep > Math.max(12, metric.medianStep * 4)) {
    console.log('!! JUMP DETECTED — maxStep is', metric.maxStep, 'vs median', metric.medianStep)
  } else {
    console.log('stream is smooth (max step within tolerance of median)')
  }
  await pageA.screenshot({ path: `${OUT}defense-live.png` })

  // The raid ends; the defender calms and gains a shield.
  await pageB.evaluate(() => {
    const s = window.__clashGame.scene.keys.MainScene
    s.endAttackReplayCapture('finished')
  })
  await sleep(3000)
  const prof = await api('POST', '/auth/session', { body: { token: victim.token } })
  console.log('defender shield after raid:', prof.player.shieldUntil > Date.now() ? 'ACTIVE' : 'missing', '(until', new Date(prof.player.shieldUntil).toLocaleTimeString() + ')')
  console.log('defense-live run complete')
} finally {
  await browserA.close()
  await browserB.close()
}
