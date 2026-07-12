// Spawns a few easter-egg dragon shadows and screenshots them mid-flight.
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const OUT = new URL('./shots/', import.meta.url).pathname

const session = await (await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--window-size=1280,900']
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluateOnNewDocument(tok => localStorage.setItem('clash.device.token', tok), session.token)
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message)))
  await page.goto(`${BASE}/game`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction(
    () => window.__clashGame?.scene?.keys?.MainScene?.buildings?.length > 0,
    { timeout: 45000, polling: 500 }
  )
  await new Promise(r => setTimeout(r, 1500))

  await page.evaluate(() => {
    const scene = window.__clashGame.scene.keys.MainScene
    const th = scene.buildings.find(b => b.type === 'town_hall')
    const cx = th.gridX + 1.5
    const cy = th.gridY + 1.5
    const iso = { x: (cx - cy) * 32, y: (cx + cy) * 16 }
    scene.cameras.main.setZoom(2.2)
    scene.cameras.main.centerOn(iso.x, iso.y - 10)
    scene.villageLife.spawnDragonShadow()
    // Steer the dragon dead across the town hall
    const drake = scene.villageLife.entities.find(e => e.kind === 'bird' && e.birdType === 3)
    drake.x = th.gridX - 7
    drake.y = th.gridY + 1.5
    drake.birdVX = 0.0035
    drake.birdVY = 0
  })

  await new Promise(r => setTimeout(r, 1400))
  await page.screenshot({ path: `${OUT}dragon-flight-a.png` })
  await new Promise(r => setTimeout(r, 800))
  await page.screenshot({ path: `${OUT}dragon-flight-b.png` })
  await new Promise(r => setTimeout(r, 900))
  await page.screenshot({ path: `${OUT}dragon-flight-c.png` })

  console.log('dragon shots done, page errors:', errors.length ? errors.slice(0, 3) : 'none')
} finally {
  await browser.close()
}
