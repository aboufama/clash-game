// Packs each baked unit's individual frame PNGs into one atlas PNG + Phaser
// atlas JSON (hash format, frame name = file name), and writes a top-level
// index at public/assets/sprites/index.json enumerating every atlas. Run
// after bake-sprites.mjs. No game server needed — packing runs in a blank
// headless page (canvas does the compositing).
import puppeteer from 'puppeteer-core'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = process.env.OUT ?? join(REPO, 'public', 'assets', 'sprites')

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox']
})
try {
  const page = await browser.newPage()
  await page.goto('data:text/html,<html></html>')

  const index = { cellWorldPx: null, units: [] }
  for (const kind of ['buildings', 'troops', 'wrecks', 'obstacles']) {
    const kindDir = join(ROOT, kind)
    if (!existsSync(kindDir)) continue
    for (const unit of readdirSync(kindDir)) {
      const dir = join(kindDir, unit)
      if (!statSync(dir).isDirectory()) continue
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
      index.cellWorldPx = index.cellWorldPx ?? manifest.cellWorldPx
      const files = readdirSync(dir).filter(f => f.endsWith('.png') && !f.startsWith('atlas'))
      const frames = files.map(f => ({
        name: f,
        data: 'data:image/png;base64,' + readFileSync(join(dir, f)).toString('base64')
      }))
      const packed = await page.evaluate(async (frames) => {
        const imgs = []
        for (const f of frames) {
          const img = new Image()
          await new Promise(res => { img.onload = res; img.src = f.data })
          imgs.push({ name: f.name, img })
        }
        // Shelf packing, tallest-first, 1px gutters against bleed.
        imgs.sort((a, b) => b.img.height - a.img.height)
        const MAXW = 2048
        let x = 0, y = 0, shelf = 0, atlasW = 0
        const places = []
        for (const it of imgs) {
          const w = it.img.width + 2, h = it.img.height + 2
          if (x + w > MAXW) { y += shelf; x = 0; shelf = 0 }
          places.push({ name: it.name, x: x + 1, y: y + 1, w: it.img.width, h: it.img.height, img: it.img })
          x += w; shelf = Math.max(shelf, h); atlasW = Math.max(atlasW, x)
        }
        const atlasH = y + shelf
        const cv = document.createElement('canvas')
        cv.width = Math.max(1, atlasW); cv.height = Math.max(1, atlasH)
        const ctx = cv.getContext('2d')
        for (const p of places) ctx.drawImage(p.img, p.x, p.y)
        const json = { frames: {}, meta: { app: 'clash-bake', size: { w: cv.width, h: cv.height }, scale: 1 } }
        for (const p of places) {
          json.frames[p.name] = {
            frame: { x: p.x, y: p.y, w: p.w, h: p.h },
            rotated: false, trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: p.w, h: p.h },
            sourceSize: { w: p.w, h: p.h }
          }
        }
        return { png: cv.toDataURL('image/png'), json, w: cv.width, h: cv.height }
      }, frames)
      writeFileSync(join(dir, 'atlas.png'), Buffer.from(packed.png.split(',')[1], 'base64'))
      writeFileSync(join(dir, 'atlas.json'), JSON.stringify(packed.json))
      index.units.push({ kind, unit, atlas: `${kind}/${unit}/atlas.png`, frames: `${kind}/${unit}/atlas.json`, manifest: `${kind}/${unit}/manifest.json` })
      console.log(`packed ${kind}/${unit}: ${files.length} frames → ${packed.w}x${packed.h}`)
    }
  }
  writeFileSync(join(ROOT, 'index.json'), JSON.stringify(index, null, 2))
  console.log(`index: ${index.units.length} atlases`)
} finally {
  await browser.close()
}
