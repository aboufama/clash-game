// Generates shop portraits from each building's actual committed Level-1
// bake. Ground and elevated frames are aligned by their common world anchor,
// then fitted with nearest-neighbour sampling into a compact UI portrait.
//
// Usage: node tools/art-preview/gen-building-sprite-icons.mjs
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
const BUILDING_ROOT = join(REPO, 'public', 'assets', 'sprites', 'buildings')
const OUT = join(REPO, 'public', 'assets', 'icons', 'buildings')
const PREVIEW = join(HERE, 'shots', 'building-sprite-icon-preview.png')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

if (!existsSync(BUILDING_ROOT)) throw new Error(`missing building sprite root: ${BUILDING_ROOT}`)
mkdirSync(OUT, { recursive: true })
mkdirSync(dirname(PREVIEW), { recursive: true })
for (const file of readdirSync(OUT)) {
  if (file.endsWith('.png')) rmSync(join(OUT, file))
}

const units = readdirSync(BUILDING_ROOT)
  .filter(unit => {
    const dir = join(BUILDING_ROOT, unit)
    return statSync(dir).isDirectory() && existsSync(join(dir, 'manifest.json'))
  })
  .sort((a, b) => a.localeCompare(b))

if (units.length !== 19) {
  throw new Error(`expected 19 building manifests, found ${units.length}`)
}

const frameData = (dir, frame) => ({
  data: `data:image/png;base64,${readFileSync(join(dir, frame.file)).toString('base64')}`,
  originX: frame.originX,
  originY: frame.originY
})

const sources = units.map(unit => {
  const dir = join(BUILDING_ROOT, unit)
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const level = manifest.levels?.['1']
  if (!level) throw new Error(`${unit} has no Level-1 bake`)

  // A joined corner communicates the wall system better than an isolated post.
  const presentation = level.variants
    ? (level.variants.mES ?? level.variants.mSE ?? level.variants.m0 ?? Object.values(level.variants)[0])
    : level
  const idle = presentation.states?.idle
  const directions = idle?.frames
  if (!Array.isArray(directions) || directions.length === 0) {
    throw new Error(`${unit} has no Level-1 idle frame`)
  }

  // Placement defaults rotating defenses to π/4. Static buildings expose one
  // direction and naturally use it.
  const directionIndex = directions.length > 1 ? Math.round(directions.length / 8) % directions.length : 0
  const body = directions[directionIndex]?.[0]
  if (!body?.file) throw new Error(`${unit} has no Level-1 presentation frame`)

  return {
    unit,
    body: frameData(dir, body),
    ground: presentation.ground?.file ? frameData(dir, presentation.ground) : null
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
      const bodyImage = await load(source.body.data)
      const groundImage = source.ground ? await load(source.ground.data) : null
      const layers = [
        ...(groundImage ? [{ image: groundImage, frame: source.ground }] : []),
        { image: bodyImage, frame: source.body }
      ].map(layer => ({
        ...layer,
        left: -layer.frame.originX * layer.image.width,
        top: -layer.frame.originY * layer.image.height
      }))

      const left = Math.min(...layers.map(layer => layer.left))
      const top = Math.min(...layers.map(layer => layer.top))
      const right = Math.max(...layers.map(layer => layer.left + layer.image.width))
      const bottom = Math.max(...layers.map(layer => layer.top + layer.image.height))
      const sourceWidth = right - left
      const sourceHeight = bottom - top
      const fit = Math.min(58 / sourceWidth, 58 / sourceHeight)
      const scale = fit >= 1 ? Math.max(1, Math.floor(fit)) : fit

      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 64
      const context = canvas.getContext('2d')
      context.imageSmoothingEnabled = false
      const fittedWidth = sourceWidth * scale
      const fittedHeight = sourceHeight * scale
      const offsetX = (64 - fittedWidth) / 2 - left * scale
      const offsetY = (64 - fittedHeight) / 2 - top * scale
      for (const layer of layers) {
        context.drawImage(
          layer.image,
          Math.round(offsetX + layer.left * scale),
          Math.round(offsetY + layer.top * scale),
          Math.max(1, Math.round(layer.image.width * scale)),
          Math.max(1, Math.round(layer.image.height * scale))
        )
      }
      results.push({ unit: source.unit, png: canvas.toDataURL('image/png') })
    }
    return results
  }, sources)

  for (const result of rendered) {
    writeFileSync(join(OUT, `${result.unit}.png`), Buffer.from(result.png.split(',')[1], 'base64'))
  }

  const previewData = await page.evaluate(async rendered => {
    const columns = 5
    const cellWidth = 156
    const cellHeight = 104
    const rows = Math.ceil(rendered.length / columns)
    const canvas = document.createElement('canvas')
    canvas.width = columns * cellWidth
    canvas.height = Math.max(1, rows * cellHeight)
    const context = canvas.getContext('2d')
    context.fillStyle = '#17110c'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.imageSmoothingEnabled = false
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.font = '11px monospace'
    for (let index = 0; index < rendered.length; index++) {
      const item = rendered[index]
      const image = await loadImage(item.png)
      const column = index % columns
      const row = Math.floor(index / columns)
      const x = column * cellWidth
      const y = row * cellHeight
      context.fillStyle = index % 2 === 0 ? '#30251b' : '#292016'
      context.fillRect(x + 3, y + 3, cellWidth - 6, cellHeight - 6)
      context.drawImage(image, x + (cellWidth - 64) / 2, y + 7, 64, 64)
      context.fillStyle = '#f1dfb7'
      context.fillText(item.unit, x + cellWidth / 2, y + 84)
    }
    return canvas.toDataURL('image/png')

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = reject
        image.src = src
      })
    }
  }, rendered)
  writeFileSync(PREVIEW, Buffer.from(previewData.split(',')[1], 'base64'))
  console.log(`generated ${rendered.length} exact Level-1 building portraits in ${OUT}`)
  console.log(`preview: ${PREVIEW}`)
} finally {
  await browser.close()
}
