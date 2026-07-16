// One-off review harness: contact sheets for the frostfall@A/@B/@C bakes.
// For each slot: L1..L4 silhouettes (idle0), an idle-motion strip (every 4th
// of the 36-frame loop, L3), and the FULL 15-frame fire cycle (L3), labeled
// with each frame's fireAge/projectileActive ov. Writes shots/frostfall@<slot>_sheet.png
import puppeteer from 'puppeteer-core'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SCALE = 3

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1800,1400']
})
try {
  const page = await browser.newPage()
  for (const slot of ['A', 'B', 'C']) {
    const dir = join(REPO, 'public', 'assets', 'sprites', 'buildings', `frostfall@${slot}`)
    const man = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    const b64 = f => `data:image/png;base64,${readFileSync(join(dir, f)).toString('base64')}`
    const rows = []
    // Row 1: level silhouettes (idle frame 0 of each level)
    rows.push({
      label: `slot ${slot} — L1..L4 silhouette (idle0)`,
      cells: [1, 2, 3, 4].map(lv => ({
        src: b64(man.levels[lv].states.idle.frames[0][0].file), cap: `L${lv}`
      }))
    })
    // Row 2: idle motion, L3, every 4th frame of the 36-frame 2000 ms loop
    const idle = man.levels[3].states.idle.frames[0]
    rows.push({
      label: `slot ${slot} — L3 idle loop (${man.levels[3].states.idle.loopMs} ms, ${idle.length} frames, every 4th)`,
      cells: idle.filter((_, i) => i % 4 === 0).map((f, i) => ({ src: b64(f.file), cap: `i${i * 4}` }))
    })
    // Rows 3-4: the full fire cycle, L3, split prep / launch+settle
    const fire = man.levels[3].states.fire.frames[0]
    const cap = f => `${f.ov.fireAge}ms${f.ov.projectileActive ? ' ✈' : ''}`
    rows.push({
      label: `slot ${slot} — L3 fire cycle 1/2 (prep)`,
      cells: fire.slice(0, 9).map(f => ({ src: b64(f.file), cap: cap(f) }))
    })
    rows.push({
      label: `slot ${slot} — L3 fire cycle 2/2 (launch ✈ / abort+settle)`,
      cells: fire.slice(9).map(f => ({ src: b64(f.file), cap: cap(f) }))
    })
    const html = `<!doctype html><body style="margin:0;background:#31363f;font:11px monospace;color:#dde">
      ${rows.map(r => `<div style="padding:6px 8px 2px">${r.label}</div>
        <div style="display:flex;gap:6px;padding:2px 8px;align-items:flex-end">
          ${r.cells.map(c => `<figure style="margin:0;text-align:center">
            <img src="${c.src}" style="image-rendering:pixelated;width:auto;height:auto;transform-origin:top left" width="0" data-w>
            <figcaption>${c.cap}</figcaption></figure>`).join('')}
        </div>`).join('')}
      <script>
        for (const img of document.querySelectorAll('img')) {
          img.removeAttribute('width');
          img.onload = () => { img.style.width = (img.naturalWidth * ${SCALE}) + 'px' }
          if (img.complete) img.style.width = (img.naturalWidth * ${SCALE}) + 'px'
        }
      </script></body>`
    await page.setViewport({ width: 1800, height: 1400, deviceScaleFactor: 1 })
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    await new Promise(r => setTimeout(r, 300))
    const body = await page.evaluate(() => ({ w: Math.ceil(document.body.scrollWidth), h: Math.ceil(document.body.scrollHeight) }))
    await page.setViewport({ width: Math.min(3000, body.w), height: Math.min(3000, body.h), deviceScaleFactor: 1 })
    const out = join(HERE, 'shots', `frostfall@${slot}_sheet.png`)
    await page.screenshot({ path: out, fullPage: true })
    console.log('wrote', out)
  }
} finally {
  await browser.close()
}
