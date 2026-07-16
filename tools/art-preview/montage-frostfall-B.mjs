// Compose labeled contact sheets for the frostfall design-B report using
// headless Chrome as the rasterizer (no image libs in this repo).
import puppeteer from 'puppeteer-core'
import { readFileSync, mkdirSync } from 'node:fs'

const WORK = '/private/tmp/claude-scratch-design-tournament/frostfall-B/work/'
const OUT = '/private/tmp/claude-scratch-design-tournament/frostfall-B/'
mkdirSync(OUT, { recursive: true })

const SHEETS = [
  {
    name: 'FINAL-1-levels-day', cols: 4, tile: 320,
    tiles: [1, 2, 3, 4].map(l => [`frostfall-L${l}-day.png`, `L${l} — day idle`])
  },
  {
    name: 'FINAL-2-levels-night', cols: 4, tile: 320,
    tiles: [1, 2, 3, 4].map(l => [`frostfall-L${l}-night.png`, `L${l} — night idle`])
  },
  {
    name: 'FINAL-3-fire-prep-L3-day', cols: 4, tile: 320,
    tiles: [
      ['fire-L3-day-a0300.png', 'awaken · fireAge 300ms'],
      ['fire-L3-day-a1500.png', 'crystallise · 1500ms'],
      ['fire-L3-day-a2900.png', 'crystallise · 2900ms'],
      ['fire-L3-day-a4150.png', 'primed · 4150ms']
    ]
  },
  {
    name: 'FINAL-4-fire-launch-settle-L3-day', cols: 3, tile: 320,
    tiles: [
      ['fire-L3-day-a4230-proj.png', 'launch burst · 4230ms (payload absent)'],
      ['fire-L3-day-a4400-proj.png', 'spray · 4400ms'],
      ['fire-L3-day-a4590-proj.png', 'settle + seed regrow · 4590ms']
    ]
  },
  {
    name: 'FINAL-5-idle-loop-L4-day', cols: 4, tile: 300,
    tiles: [0, 1, 2, 3, 4, 5, 6, 7].map(i => [`burst-L4-day-t${i}.png`, `idle loop +${i * 250}ms / 2000ms`])
  },
  {
    name: 'FINAL-6-night-charge-L4', cols: 2, tile: 480,
    tiles: [
      ['fire-L4-night-a4150.png', 'L4 primed crystal · night'],
      ['fire-L4-night-a4230-proj.png', 'L4 launch burst · night']
    ]
  }
]

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox']
})
try {
  const page = await browser.newPage()
  for (const sheet of SHEETS) {
    const rows = Math.ceil(sheet.tiles.length / sheet.cols)
    const W = sheet.cols * sheet.tile
    const H = rows * (sheet.tile + 26)
    const cells = sheet.tiles.map(([file, label]) => {
      const b64 = readFileSync(WORK + file).toString('base64')
      return `<div class="c" style="width:${sheet.tile}px">
        <img src="data:image/png;base64,${b64}" style="width:${sheet.tile}px;height:${sheet.tile}px;object-fit:cover">
        <div class="l">${label}</div></div>`
    }).join('')
    const html = `<!doctype html><style>
      body{margin:0;background:#101418;font:600 13px/26px -apple-system,sans-serif;color:#cfe4ee}
      .g{display:flex;flex-wrap:wrap;width:${W}px}.c{display:block}.l{text-align:center;height:26px}
      img{display:block;image-rendering:pixelated}
    </style><div class="g">${cells}</div>`
    await page.setViewport({ width: W, height: H })
    await page.setContent(html, { waitUntil: 'load' })
    await new Promise(r => setTimeout(r, 400))
    await page.screenshot({ path: `${OUT}${sheet.name}.png`, clip: { x: 0, y: 0, width: W, height: H } })
    console.log('sheet', sheet.name)
  }
} finally {
  await browser.close()
}
