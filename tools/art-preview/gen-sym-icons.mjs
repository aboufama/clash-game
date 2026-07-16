// Symbol-glyph generator: hand-authored 15×15 pixel grids → baked data-URI
// PNG CSS for src/icons/symbol-icons.css (1 png px per cell, displayed at
// 1.5px cells via background-size + image-rendering: pixelated), plus
// preview renders for visual sign-off before the CSS lands.
//
//   node gen-sym-icons.mjs          → shots/sym-icon-css.txt + shots/sym-icon-preview.png (grid sheet)
//   node gen-sym-icons.mjs --real   → also renders the REAL src/icons/symbol-icons.css:
//                                     shots/sym-real-20px.png (true 20px, NN-upscaled 4× for inspection)
//                                     shots/sym-real-3x.png   (deviceScaleFactor 3)
//
// WHY PNG and not box-shadow: 1.5px box-shadow cells put cell edges on
// fractional device-pixel boundaries depending on where layout happens to
// place the container (and any ancestor filter/transform — e.g. .sym.small's
// scale(0.7) — changes the rounding path). When edges land at .5 device px
// every cell boundary AA-bleeds ~25% background through — the hairline-gap
// bug. Nearest-neighbour sampling of a real image covers every device pixel
// exactly once at ANY sub-pixel offset, under filters and transforms, at
// every DPR. Never go back to box-shadow grids.
import puppeteer from 'puppeteer-core'
import { writeFileSync, readFileSync } from 'node:fs'

const CELL = 1.5

// ---- TROPHY: gold cup, side handles, stem + stepped plinth ----------------
const TROPHY = {
  name: 'trophy',
  pal: {
    W: '#fff2a8', L: '#ffe066', G: '#ffd700', D: '#e6b800',
    B: '#b38f00', K: '#8a6d00', N: '#6e5600'
  },
  grid: [
    '...............',
    '....WLLLLLD....',
    '..DGWLLGGGDGD..',
    '..D.WLLGGGD.D..',
    '...DLLGGGDBD...',
    '.....LGGDB.....',
    '......GDB......',
    '.......D.......',
    '......GDB......',
    '.....BBBBB.....',
    '....KKKKKKK....',
    '...NNNNNNNNN...',
    '...............',
    '...............',
    '...............'
  ]
}

// ---- SHIELD: steel kite shield, dark rim, round gold boss ------------------
const SHIELD = {
  name: 'shield',
  pal: {
    H: '#d3e2f4', L: '#b8cbe4', M: '#8fa8c8', S: '#5a7392', N: '#3c5068',
    Y: '#ffe066', G: '#ffd700', A: '#e6b800'
  },
  grid: [
    '...............',
    '...NLLLLLLLN...',
    '..NHHLLLLLMSN..',
    '..NHLLLLLLMSN..',
    '..NHLLLYLLMSN..',
    '..NLLLYGALMSN..',
    '..NLLLLALLMSN..',
    '...NLLLLLMSN...',
    '...NLLLLLMSN...',
    '....NLLLMSN....',
    '.....NLMSN.....',
    '......NMN......',
    '.......N.......',
    '...............',
    '...............'
  ]
}

// ---- CROSSED SWORDS: steel blades tips-up, gold guards, brown grips --------
const SWORDS = {
  name: 'swords',
  pal: {
    W: '#e8eef6', S: '#c8d4e4', D: '#aab8cc',
    Y: '#ffe066', G: '#ffd700', B: '#b38f00', R: '#8a5a2a'
  },
  grid: [
    '...............',
    '...............',
    '..W.........W..',
    '...S.......S...',
    '....W.....W....',
    '.....S...S.....',
    '......S.S......',
    '.......D.......',
    '....Y.S.S.Y....',
    '.....G...G.....',
    '....R.B.B.R....',
    '...Y.......Y...',
    '...............',
    '...............',
    '...............'
  ]
}

// ---- KEEP: banner, battlements, arrow-slit, arched door, stepped base ------
const CASTLE = {
  name: 'castle',
  pal: {
    P: '#d8563c', Q: '#e87a5c', o: '#8a6a42',
    L: '#b8bfca', M: '#9aa2ae', D: '#848c98', N: '#6c7480', E: '#5a616c',
    K: '#4a3828', J: '#38291c'
  },
  grid: [
    '.......PQ......',
    '.......o.......',
    '..LL..LLL..LL..',
    '..LLMMLLLMMLL..',
    '...NMLMLMLMN...',
    '...NLMLKLMLN...',
    '...NMLMKMLMN...',
    '...NLMLKLMLN...',
    '...NMLMLMLMN...',
    '..DMLMLKLMLMD..',
    '.DDMLMKKKMLMDD.',
    '.NDDMLKJKLMDDN.',
    '.EEEEEEJEEEEEE.',
    '...............',
    '...............'
  ]
}

// ---- TENT: canvas wedge, red pennant, dark arched door ---------------------
const TENT = {
  name: 'tent',
  pal: {
    P: '#d8563c', T: '#d9c7a4', C: '#c9b593', B: '#b9a27c',
    A: '#a08a64', Z: '#8a744e', K: '#4a3828', J: '#38291c'
  },
  grid: [
    '...............',
    '.......P.......',
    '.......C.......',
    '......TCB......',
    '.....TTCBB.....',
    '....TTCCBBA....',
    '...TTTCCBBBA...',
    '..TTTCCCBBBAA..',
    '..TTTCCKCBBAA..',
    '.ZTTTCCKCBBBAZ.',
    '.ZTTCCKKKBBBAZ.',
    '.ZZTCCKJKBBAZZ.',
    '...............',
    '...............',
    '...............'
  ]
}

// ---- EYE: almond with pointed tips, 3-wide blue iris, 2-tall pupil, glint --
const EYE = {
  name: 'eye',
  pal: {
    O: '#8a877c', W: '#f4f0e4', E: '#e8e4d8',
    i: '#6aa0dc', I: '#3a76b8', d: '#2a5688', P: '#1c2838'
  },
  grid: [
    '...............',
    '...............',
    '...............',
    '...............',
    '.....OOOOO.....',
    '...OOWiiiWOO...',
    '..OWWWIPIWWWO..',
    '.OEWWWIPIWWWEO.',
    '..OEWWdddWWEO..',
    '...OOEEEEEOO...',
    '.....OOOOO.....',
    '...............',
    '...............',
    '...............',
    '...............'
  ]
}

// ---- WATCH: stone watchtower — crown of merlons, overhung platform,
//      lit gold window, door slit, flared base ------------------------------
const WATCH = {
  name: 'watch',
  pal: {
    L: '#b8bfca', M: '#9aa2ae', D: '#848c98', N: '#6c7480', E: '#5a616c',
    Y: '#ffe066', G: '#ffd700', K: '#4a3828'
  },
  grid: [
    '...LL..L..LL...',
    '...LLLLLLMMM...',
    '....NNNNNNN....',
    '.....LMMMD.....',
    '.....LMYMD.....',
    '.....LMGMD.....',
    '.....LLMMD.....',
    '.....LMMMD.....',
    '.....LMKMD.....',
    '.....LMKMD.....',
    '....DMLKLMD....',
    '...ENNNNNNNE...',
    '...............',
    '...............',
    '...............'
  ]
}

// ---- HOME: cottage — red gabled roof, cream walls, lit windows, wood door --
const HOME = {
  name: 'home',
  pal: {
    Q: '#e87a5c', P: '#d8563c', U: '#b03a24',
    W: '#f4ecd8', C: '#e8ddc4', B: '#c8bda4',
    K: '#6a4a2a', J: '#4a3828', Y: '#ffe066'
  },
  grid: [
    '...............',
    '.......Q.......',
    '......QPU......',
    '.....QPPPU.....',
    '....QPPPPPU....',
    '...QPPPPPPPU...',
    '..QPPPPPPPPPU..',
    '...CWWWWWWWC...',
    '...WYYKKKYYW...',
    '...WYYKKKYYW...',
    '...WWWKKKWWW...',
    '...CWWKJKWWC...',
    '...BBBBBBBBB...',
    '...............',
    '...............'
  ]
}

// ---- LOCK: padlock — steel shackle, gold body, dark keyhole ----------------
const LOCK = {
  name: 'lock',
  pal: {
    T: '#d3e2f4', S: '#b8cbe4', N: '#6d87a8',
    W: '#fff2a8', L: '#ffe066', G: '#ffd700', D: '#e6b800', B: '#b38f00',
    K: '#6a4a2a'
  },
  grid: [
    '...............',
    '...............',
    '.....TSSSN.....',
    '....TS...SN....',
    '....T.....N....',
    '..GLLLLLLLLLG..',
    '..LWGGGGGGGDD..',
    '..LGGGKKKGGDD..',
    '..LGGGKKKGGDD..',
    '..LGGGGKGGGDD..',
    '..LGGGGKGGGDD..',
    '..DDGGGGGGGDB..',
    '...BBBBBBBBB...',
    '...............',
    '...............'
  ]
}

// ---- SPEAKER: wooden driver, cream cone, two gold sound arcs ---------------
const SPEAKER = {
  name: 'speaker',
  pal: {
    Z: '#8a744e', A: '#a08a64',
    F: '#f4f0e4', E: '#e8e4d8', C: '#c8c4b8',
    Y: '#ffe066'
  },
  grid: [
    '...............',
    '...............',
    '......E........',
    '.....EF..Y.....',
    '....EFF...Y....',
    '.ZAEFFF.Y..Y...',
    '.ZAFFFF..Y.Y...',
    '.ZAFFFF..Y.Y...',
    '.ZAEEEE..Y.Y...',
    '.ZACEEE.Y..Y...',
    '....CEE...Y....',
    '.....CE..Y.....',
    '......C........',
    '...............',
    '...............'
  ]
}

// ---- SPEAKER OFF: muted grey cone, red X where the arcs were ---------------
const SPEAKER_OFF = {
  name: 'speaker-off',
  pal: {
    z: '#6a5a44', u: '#8a744e',
    c: '#c8c4b8', a: '#a8a498', o: '#8a877c',
    R: '#d84a3c'
  },
  grid: [
    '...............',
    '...............',
    '......a........',
    '.....ac........',
    '....acc........',
    '.zuaccc.R...R..',
    '.zucccc..R.R...',
    '.zucccc...R....',
    '.zuaaaa..R.R...',
    '.zuoaaa.R...R..',
    '....oaa........',
    '.....oa........',
    '......o........',
    '...............',
    '...............'
  ]
}

// ---- HEART: two lobes, NW highlight, shaded SE edge, dark tip --------------
const HEART = {
  name: 'heart',
  pal: {
    P: '#f47a6c', R: '#d84a3c', D: '#b03a2c', K: '#8a2a20'
  },
  grid: [
    '...............',
    '...............',
    '...PPR...RRD...',
    '..PPPRR.RRRDD..',
    '..PPPRRRRRDDD..',
    '..RPPRRRRRDDD..',
    '..RRRRRRRRDDD..',
    '...RRRRRRRDD...',
    '....RRRRRDD....',
    '.....RRRDD.....',
    '......RDK......',
    '.......K.......',
    '...............',
    '...............',
    '...............'
  ]
}

// ---- SLOT: empty army-housing socket — raised tan frame, sunken dark pit ---
const SLOT = {
  name: 'slot',
  pal: {
    T: '#d9c7a4', C: '#c9b593', A: '#a08a64', Z: '#8a744e', K: '#4e3e2a'
  },
  grid: [
    '...............',
    '...............',
    '...............',
    '...CTTTTTTTC...',
    '...TZZZZZZZA...',
    '...TZKKKKKCA...',
    '...TZKKKKKCA...',
    '...TZKKKKKCA...',
    '...TZKKKKKCA...',
    '...TZKKKKKCA...',
    '...TCCCCCCCA...',
    '...CAAAAAAAC...',
    '...............',
    '...............',
    '...............'
  ]
}

// ---- ARROW: gold right arrow — lit top edge, shaded underside --------------
const ARROW = {
  name: 'arrow',
  pal: {
    Y: '#ffe066', G: '#ffd700', D: '#e6b800'
  },
  grid: [
    '...............',
    '...............',
    '...............',
    '.......Y.......',
    '.......GY......',
    '.......GGY.....',
    '..YYYYYGGGY....',
    '..GGGGGGGGGY...',
    '..DDDDDGGGD....',
    '.......GGD.....',
    '.......GD......',
    '.......D.......',
    '...............',
    '...............',
    '...............'
  ]
}

// ---- CLOSE: chunky terracotta X, lit from the NW ---------------------------
const CLOSE = {
  name: 'close',
  pal: {
    E: '#e8836a', R: '#d95f46', C: '#c14f38', B: '#b04833', N: '#9c3d2c'
  },
  grid: [
    '...............',
    '...............',
    '..ER.......RE..',
    '..RRR.....RRR..',
    '...RRR...RRR...',
    '....RRR.RRR....',
    '.....RRRRR.....',
    '......RRR......',
    '.....CCCCC.....',
    '....CCC.CCC....',
    '...BBB...BBB...',
    '..BBB.....BBB..',
    '..NB.......BN..',
    '...............',
    '...............'
  ]
}

const ICONS = [
  TROPHY, SHIELD, SWORDS, CASTLE, TENT, EYE, WATCH, HOME,
  LOCK, SPEAKER, SPEAKER_OFF, HEART, SLOT, ARROW, CLOSE
]

// ---- validate ---------------------------------------------------------------
for (const icon of ICONS) {
  if (icon.grid.length !== 15) throw new Error(`${icon.name}: ${icon.grid.length} rows (want 15)`)
  for (const [i, row] of icon.grid.entries()) {
    if (row.length !== 15) throw new Error(`${icon.name} r${i}: ${row.length} chars (want 15)`)
    for (const ch of row) {
      if (ch !== '.' && ch !== ' ' && !icon.pal[ch]) throw new Error(`${icon.name}: no palette entry '${ch}'`)
    }
  }
}

// One baked PNG per icon (1 png px per grid cell), shown at CELL px per cell
// via background-size + image-rendering: pixelated. See header for why.
function toCss(icon, dataUri) {
  const gw = icon.grid[0].length
  const gh = icon.grid.length
  return `.sym-${icon.name}::before {\n    content: '';\n    position: absolute;\n    width: ${gw * CELL}px;\n    height: ${gh * CELL}px;\n    top: 50%;\n    left: 50%;\n    transform: translate(-50%, -50%);\n    image-rendering: pixelated;\n    background: url('${dataUri}') 0 0 / 100% 100% no-repeat;\n}\n\n`
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox']
})
try {
  const page = await browser.newPage()
  await page.goto('data:text/html,<html></html>')

  // ---- bake each grid to a 1px-per-cell PNG data URI, emit CSS -------------
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
  ICONS.forEach((icon, i) => { css += toCss(icon, uris[i]) })
  writeFileSync(new URL('./shots/sym-icon-css.txt', import.meta.url), css)
  console.log('css written → shots/sym-icon-css.txt')

  // ---- grid preview sheet (author-time iteration) --------------------------
  const png = await page.evaluate((icons) => {
    const SCALE = 13, TILE = 16, PER_ROW = 8, LABEL = 16
    const rows = Math.ceil(icons.length / PER_ROW)
    const cv = document.createElement('canvas')
    cv.width = PER_ROW * (TILE * SCALE + 8) + 8
    cv.height = rows * (TILE * SCALE + LABEL + 10) + 8
    const ctx = cv.getContext('2d')
    ctx.fillStyle = '#2B1F15'
    ctx.fillRect(0, 0, cv.width, cv.height)
    icons.forEach((icon, k) => {
      const ox = 8 + (k % PER_ROW) * (TILE * SCALE + 8)
      const oy = 8 + Math.floor(k / PER_ROW) * (TILE * SCALE + LABEL + 10)
      ctx.fillStyle = '#3a4150'
      ctx.fillRect(ox, oy, TILE * SCALE, TILE * SCALE)
      icon.grid.forEach((row, y) => {
        ;[...row].forEach((ch, x) => {
          if (ch === '.' || ch === ' ') return
          ctx.fillStyle = icon.pal[ch]
          ctx.fillRect(ox + (x + 0.5) * SCALE, oy + (y + 0.5) * SCALE, SCALE, SCALE)
        })
      })
      ctx.fillStyle = '#d8cfc0'
      ctx.font = '12px monospace'
      ctx.fillText(icon.name, ox + 2, oy + TILE * SCALE + 13)
    })
    return cv.toDataURL('image/png')
  }, ICONS)
  writeFileSync(new URL('./shots/sym-icon-preview.png', import.meta.url), Buffer.from(png.split(',')[1], 'base64'))
  console.log('grid sheet → shots/sym-icon-preview.png')

  // ---- standalone render against the REAL stylesheet -----------------------
  if (process.argv.includes('--real')) {
    const realCss = readFileSync(new URL('../../src/icons/symbol-icons.css', import.meta.url), 'utf8')
    const names = ICONS.map((i) => i.name)
    const cells = (cls) => names.map((n) =>
      `<div class="cell"><span class="sym sym-${n}${cls}"></span><label>${n}</label></div>`).join('')
    const html = `<!doctype html><html><head><style>${realCss}
      body { margin:0; background:#2B1F15; font-family:monospace; }
      .strip { display:flex; align-items:flex-start; padding:8px 6px 2px; }
      .strip.alt { background:#1a222e; }
      .cell { width:34px; display:flex; flex-direction:column; align-items:center; gap:4px; }
      .cell label { color:#a99; font-size:7px; }
    </style></head><body>
      <div class="strip" id="s1">${cells('')}</div>
      <div class="strip alt">${cells('')}</div>
      <div class="strip">${cells(' small')}</div>
    </body></html>`
    const realPage = await browser.newPage()
    await realPage.setViewport({ width: 15 * 34 + 20, height: 190, deviceScaleFactor: 1 })
    await realPage.goto(`data:text/html,${encodeURIComponent(html)}`)

    // (a) true-20px shot, then nearest-neighbour ×4 so the 1:1 pixels are inspectable
    const shot1 = await realPage.screenshot({ encoding: 'base64' })
    const up = await realPage.evaluate(async (b64) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + b64
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width * 4
      cv.height = img.height * 4
      const ctx = cv.getContext('2d')
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(img, 0, 0, cv.width, cv.height)
      return cv.toDataURL('image/png')
    }, shot1)
    writeFileSync(new URL('./shots/sym-real-20px.png', import.meta.url), Buffer.from(up.split(',')[1], 'base64'))

    // (b) 3× device-pixel render
    await realPage.setViewport({ width: 15 * 34 + 20, height: 190, deviceScaleFactor: 3 })
    await realPage.screenshot({ path: new URL('./shots/sym-real-3x.png', import.meta.url).pathname })
    console.log('real-css renders → shots/sym-real-20px.png (×4 NN of true 20px), shots/sym-real-3x.png')
  }
} finally {
  await browser.close()
}
