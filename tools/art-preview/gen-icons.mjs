// Resource-icon generator: hand-authored 15×15 pixel grids → baked data-URI
// PNG CSS (1 png px per cell, displayed at 1.5px cells via background-size +
// image-rendering: pixelated) + a big preview sheet for visual sign-off
// before the CSS lands.
//
// WHY PNG and not box-shadow: 1.5px box-shadow cells put cell edges on
// fractional device-pixel boundaries depending on where layout happens to
// place the container (and any ancestor filter changes the rounding path).
// When edges land at .5 device px every cell boundary AA-bleeds ~25%
// background through — the hairline-gap bug. Nearest-neighbour sampling of
// a real image covers every device pixel exactly once at ANY sub-pixel
// offset, under filters and transforms, at every DPR. Never go back to
// box-shadow grids.
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'

const CELL = 1.5

// ---- GOLD: round coin — reeded dark rim, stamped inner ring, mint mark ----
const GOLD = {
  name: 'gold',
  pal: {
    O: '#7A5410', // rim
    D: '#B8860B', // deep gold shade
    R: '#C9930A', // stamped ring line
    G: '#FFD700', // face
    L: '#FFE566', // light face
    W: '#FFF6C9'  // glint
  },
  grid: [
    '.....OOOOO.....',
    '...OOOWLLOOO...',
    '..OOWWLLGGGOO..',
    '.OOWWRRRRRGGOO.',
    '.OWWRRGGGRRGGO.',
    'OOWRRGGGGGRRGOO',
    'OWLRGGGDGGGRGDO',
    'OLLRGGDLDGGRDDO',
    'OLGRGGGDGGGRDDO',
    'OOGRRGGGGGRRDOO',
    '.OGGRRGGGRRDDO.',
    '.OOGGRRRRRDDOO.',
    '..OOGGGDDDDOO..',
    '...OOODDDOOO...',
    '.....OOOOO.....'
  ]
}

// ---- ORE: dark-outlined boulder, lit top facet, three glowing nuggets ----
const ORE = {
  name: 'ore',
  pal: {
    X: '#1a1c20', A: '#b6bcc8', B: '#9aa0ac', C: '#848a96', M: '#6b6e78',
    E: '#5e616b', F: '#52555e', H: '#484b53', I: '#3e4148',
    g: '#ffd84a', h: '#ffed9a', e: '#e8b62e', s: '#14161a'
  },
  grid: [
    '.....XXXXXX....',
    '...XXABBBBAX...',
    '..XABBBBABBAX..',
    '.XABehBBBBBBAX.',
    '.XBeggeBCCCCBX.',
    'XABeggeCCMCCCX.',
    'XBCCeeCCMMMMCX.',
    'XCCMMMMMghMMEX.',
    'XCMMMMMeggeMEX.',
    'XEMMEEEEeeEFFX.',
    'XEEEghEEFFFFHX.',
    '.XFFegeFHHHHX..',
    '.XHFFFHHIIIHX..',
    '..XXHHIIIXXX...',
    '...ssssssss....'
  ]
}

// ---- POP: villager bust — hair, face + eyes, neck, tunic shoulders ----
const POP = {
  name: 'pop',
  pal: {
    D: '#3b2a1a', H: '#4e3823', h: '#5c422a',
    S: '#deb887', T: '#ecd0a4', K: '#c9975e', Y: '#2a2018', N: '#b8683c',
    U: '#8d6e4a', V: '#9d7e56', Z: '#6b5138', z: '#5c4530'
  },
  grid: [
    '....DDDDDDD....',
    '...DHHhhhHHD...',
    '..DHhhhhhhhHD..',
    '..DHhSTTTShHD..',
    '..DSTTTTTTTSD..',
    '..DSTYSTSYTSD..',
    '..DSTTTTTTTSD..',
    '..DSSTTKKTSSD..',
    '...DSSKNKSSD...',
    '....DNNNNND....',
    '..ZZUUUUUUUZZ..',
    '.ZUUVVVVVVVUUZ.',
    '.ZUVVVVVVVVVUZ.',
    '.zZZZZZZZZZZZz.',
    '...............'
  ]
}

// ---- FOOD: drumstick — the universal "food" glyph (wheat read as decor,
// and food won't always be wheat). REDONE 2026-07: one BIG round meat mass
// (9 cells wide, NW highlight) tapering to a short thick bone at the
// lower-left, ending in the classic double knob. Bold silhouette first —
// it must read as food at 16-24px. ----
const FOOD = {
  name: 'food',
  pal: {
    X: '#7a3f1e', // meat outline
    M: '#c96a3a', // meat
    L: '#e08a52', // meat light
    H: '#f2b48a', // meat highlight
    m: '#a85428', // meat shade
    x: '#9a8a6a', // bone outline
    b: '#e8dcc4', // bone
    B: '#f6efdf', // bone light
    s: '#c4b696'  // bone shade
  },
  grid: [
    '......XXXXXX...',
    '....XXMMMMMMX..',
    '...XMMLLLLLMMX.',
    '..XMLLHHHLLLMX.',
    '..XMLHHHHHLLMX.',
    '..XMLHHHHHLLMX.',
    '..XMLLHHHHLLMX.',
    '..XMMLLLLLMMMX.',
    '..XmMLLLLMMMX..',
    '...XmMLLMMMX...',
    '....XmMMmX.....',
    '....xBbx.......',
    '...xBbx........',
    '.xBBbbbx.......',
    'xBbxxbbx.......'
  ]
}

const ICONS = [GOLD, ORE, POP, FOOD]

for (const icon of ICONS) {
  for (const [i, row] of icon.grid.entries()) {
    if (row.length !== icon.grid[0].length) throw new Error(`${icon.name}: row ${i} is ${row.length} wide, expected ${icon.grid[0].length}`)
    for (const ch of row) {
      if (ch !== '.' && ch !== ' ' && !(ch in icon.pal)) throw new Error(`${icon.name}: no palette entry '${ch}'`)
    }
  }
}

// One baked PNG per icon (1 png px per grid cell), shown at CELL px per cell
// via background-size + image-rendering: pixelated. See header for why.
function toCss(icon, dataUri) {
  const gw = icon.grid[0].length
  const gh = icon.grid.length
  return `.${icon.name}-icon::before {\n    content: '';\n    position: absolute;\n    width: ${gw * CELL}px;\n    height: ${gh * CELL}px;\n    top: 50%;\n    left: 50%;\n    transform: translate(-50%, -50%);\n    image-rendering: pixelated;\n    background: url('${dataUri}') 0 0 / 100% 100% no-repeat;\n}`
}

// ---- render data URIs + preview sheet ----
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox']
})
try {
  const page = await browser.newPage()
  await page.goto('data:text/html,<html></html>')

  // ---- bake each grid to a 1px-per-cell PNG data URI, emit CSS ----
  const uris = await page.evaluate((icons) => {
    return icons.map((icon) => {
      const cv = document.createElement('canvas')
      cv.width = icon.grid[0].length
      cv.height = icon.grid.length
      const ctx = cv.getContext('2d')
      icon.grid.forEach((row, y) => {
        ;[...row].forEach((ch, x) => {
          if (ch === '.' || ch === ' ') return
          ctx.fillStyle = icon.pal[ch]
          ctx.fillRect(x, y, 1, 1)
        })
      })
      return cv.toDataURL('image/png')
    })
  }, ICONS)
  let css = ''
  ICONS.forEach((icon, i) => {
    css += `/* ${icon.name} — ${icon.grid[0].length}×${icon.grid.length} @ ${CELL}px cells, baked PNG */\n${toCss(icon, uris[i])}\n\n`
  })
  writeFileSync(new URL('./shots/icon-css.txt', import.meta.url), css)

  const png = await page.evaluate((icons) => {
    const SCALE = 14
    const cv = document.createElement('canvas')
    cv.width = icons.length * 16 * SCALE
    cv.height = 16 * SCALE
    const ctx = cv.getContext('2d')
    ctx.fillStyle = '#3a4150'
    ctx.fillRect(0, 0, cv.width, cv.height)
    icons.forEach((icon, k) => {
      icon.grid.forEach((row, y) => {
        ;[...row].forEach((ch, x) => {
          if (ch === '.' || ch === ' ') return
          ctx.fillStyle = icon.pal[ch]
          ctx.fillRect((k * 16 + x + 0.5) * SCALE, (y + 0.5) * SCALE, SCALE, SCALE)
        })
      })
    })
    return cv.toDataURL('image/png')
  }, ICONS)
  writeFileSync(new URL('./shots/icon-preview.png', import.meta.url), Buffer.from(png.split(',')[1], 'base64'))
  console.log('preview + css written')
} finally {
  await browser.close()
}
