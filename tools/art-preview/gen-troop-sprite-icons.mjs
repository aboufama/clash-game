// Generates every troop UI portrait from the troop's actual committed baked
// idle frame. This deliberately replaces recycled hand-authored CSS aliases:
// if the battlefield silhouette changes, rerunning this script changes the
// icon from the same source artifact. Unresolved @A/@B/@C directories produce
// one portrait per candidate and TroopIcon follows the live Design Lab slot.
//
// Usage: node tools/art-preview/gen-troop-sprite-icons.mjs
import puppeteer from 'puppeteer-core'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const TROOP_ROOT = join(REPO, 'public', 'assets', 'sprites', 'troops')
const OUT = join(REPO, 'public', 'assets', 'icons', 'troops')
const PREVIEW = join(HERE, 'shots', 'troop-sprite-icon-preview.png')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

if (!existsSync(TROOP_ROOT)) throw new Error(`missing troop sprite root: ${TROOP_ROOT}`)
mkdirSync(OUT, { recursive: true })
for (const file of readdirSync(OUT)) {
  if (file.endsWith('.png')) rmSync(join(OUT, file))
}

const units = readdirSync(TROOP_ROOT)
  .filter(unit => {
    const dir = join(TROOP_ROOT, unit)
    return statSync(dir).isDirectory() && existsSync(join(dir, 'manifest.json'))
  })
  .sort((a, b) => a.localeCompare(b))

const sources = units.map(unit => {
  const dir = join(TROOP_ROOT, unit)
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const levels = Object.keys(manifest.levels ?? {}).map(Number).sort((a, b) => a - b)
  const level = levels.at(-1)
  const directions = manifest.levels?.[String(level)]?.P
  if (!Array.isArray(directions) || directions.length === 0) {
    throw new Error(`${unit} has no highest-level PLAYER directions`)
  }
  // Three-quarter heading is consistently more descriptive than a strict
  // profile, while single-direction authoring keeps its only available view.
  const direction = directions.length > 1 ? directions[Math.min(3, directions.length - 1)] : directions[0]
  const frame = direction.frames?.find(candidate => candidate.state === 'idle')
  if (!frame?.file) throw new Error(`${unit} has no idle frame for icon generation`)
  const file = join(dir, frame.file)
  return {
    unit,
    data: `data:image/png;base64,${readFileSync(file).toString('base64')}`
  }
})

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox']
})

try {
  const page = await browser.newPage()
  await page.goto('data:text/html,<html><body></body></html>')
  const rendered = await page.evaluate(async sources => {
    const load = src => new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = reject
      image.src = src
    })
    const results = []
    for (const source of sources) {
      const image = await load(source.data)
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 64
      const context = canvas.getContext('2d')
      context.imageSmoothingEnabled = false
      const fit = Math.min(58 / image.width, 58 / image.height)
      const scale = fit >= 1 ? Math.max(1, Math.floor(fit)) : fit
      const width = Math.max(1, Math.round(image.width * scale))
      const height = Math.max(1, Math.round(image.height * scale))
      const x = Math.round((64 - width) / 2)
      const y = Math.round((64 - height) / 2)
      context.drawImage(image, x, y, width, height)
      results.push({ unit: source.unit, png: canvas.toDataURL('image/png') })
    }
    return results
  }, sources)

  for (const result of rendered) {
    writeFileSync(join(OUT, `${result.unit}.png`), Buffer.from(result.png.split(',')[1], 'base64'))
  }

  const previewData = await page.evaluate(async rendered => {
    const columns = 6
    const cellWidth = 146
    const cellHeight = 102
    const rows = Math.ceil(rendered.length / columns)
    const canvas = document.createElement('canvas')
    canvas.width = columns * cellWidth
    canvas.height = Math.max(1, rows * cellHeight)
    const context = canvas.getContext('2d')
    context.fillStyle = '#242a31'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.imageSmoothingEnabled = false
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.font = '11px monospace'
    for (let index = 0; index < rendered.length; index++) {
      const item = rendered[index]
      const image = new Image()
      await new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = reject
        image.src = item.png
      })
      const column = index % columns
      const row = Math.floor(index / columns)
      const x = column * cellWidth
      const y = row * cellHeight
      context.fillStyle = index % 2 === 0 ? '#303842' : '#2b333c'
      context.fillRect(x + 3, y + 3, cellWidth - 6, cellHeight - 6)
      context.drawImage(image, x + (cellWidth - 64) / 2, y + 7, 64, 64)
      context.fillStyle = '#f1dfb7'
      context.fillText(item.unit, x + cellWidth / 2, y + 82)
    }
    return canvas.toDataURL('image/png')
  }, rendered)
  writeFileSync(PREVIEW, Buffer.from(previewData.split(',')[1], 'base64'))
  console.log(`generated ${rendered.length} exact troop portraits in ${OUT}`)
  console.log(`preview: ${PREVIEW}`)
} finally {
  await browser.close()
}
