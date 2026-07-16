// Compose the golem-C work shots into curated labeled sheets (headless canvas).
//   IN=<workdir> OUTDIR=<tournamentdir> node compose-golem-c.mjs
import puppeteer from 'puppeteer-core'
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs'

const IN = (process.env.IN ?? '/tmp/golem-c-work').replace(/\/$/, '')
const OUTDIR = (process.env.OUTDIR ?? '/tmp/golem-c-final').replace(/\/$/, '')
mkdirSync(OUTDIR, { recursive: true })

const b64 = f => `data:image/png;base64,${readFileSync(`${IN}/${f}.png`).toString('base64')}`
const cell = (f, label, w) => `<figure style="margin:0"><img src="${b64(f)}" style="width:${w}px;display:block"><figcaption style="font:600 13px monospace;color:#eee;text-align:center;padding:2px 0">${label}</figcaption></figure>`

const sheets = {
  'levels': {
    cols: 3, w: 250,
    cells: [
      ['close-P-L1', 'PLAYER L1 granite'], ['close-P-L2', 'PLAYER L2 iron+horns'], ['close-P-L3', 'PLAYER L3 sandstone+gold'],
      ['close-E-L1', 'ENEMY L1'], ['close-E-L2', 'ENEMY L2'], ['close-E-L3', 'ENEMY L3'],
    ]
  },
  'headings': {
    cols: 4, w: 200,
    cells: Array.from({ length: 16 }, (_, k) => [`heading-${String(k).padStart(2, '0')}`, `${(k * 22.5).toFixed(1)}°`])
  },
  'walk-idle-seq': {
    cols: 6, w: 170,
    cells: [
      ...Array.from({ length: 6 }, (_, f) => [`walk-${f}`, `walk t+${f * 166}ms`]),
      ...Array.from({ length: 5 }, (_, f) => [`idle-${f}`, `idle t+${f * 500}ms`]),
    ]
  },
  'slam-seq': {
    cols: 6, w: 170,
    cells: [
      ['slam-0-stance', 'stance s=0'], ['slam-1-drive', 'drive s=4'], ['slam-2-drive', 'drive s=8'],
      ['slam-3-impact', 'IMPACT s=12'], ['slam-4-settle', 'settle s=7'], ['slam-5-settle', 'settle s=2'],
    ]
  },
  'night': {
    cols: 3, w: 300,
    cells: [['lineup-night', 'night lineup (P azure / E ember)'], ['night-P-L3', 'night P L3'], ['night-slam', 'night slam impact']]
  },
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--no-sandbox']
})
try {
  const page = await browser.newPage()
  for (const [name, { cols, w, cells }] of Object.entries(sheets)) {
    const html = `<body style="margin:0;background:#22262b;display:inline-grid;grid-template-columns:repeat(${cols},auto);gap:6px;padding:8px">${cells.map(([f, l]) => cell(f, l, w)).join('')}</body>`
    await page.setContent(html)
    const body = await page.$('body')
    await body.screenshot({ path: `${OUTDIR}/${name}.png` })
  }
  copyFileSync(`${IN}/lineup-day.png`, `${OUTDIR}/idle-day.png`)
  console.log('composed →', OUTDIR)
} finally {
  await browser.close()
}
