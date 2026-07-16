// UI-icon generator: hand-authored pixel grids → baked data-URI PNG CSS for
// src/icons/ui-icons.css (1 png px per cell, displayed at 1.5px cells via
// background-size + image-rendering: pixelated) + a preview sheet for visual
// sign-off before the CSS lands. Same workflow as gen-icons.mjs.
//
//   node tools/art-preview/gen-ui-icons.mjs
//     → tools/art-preview/shots/ui-icon-css.txt   (the ::before blocks)
//     → tools/art-preview/shots/ui-icon-preview.png (LOOK at this)
//
// WHY PNG and not box-shadow: 1.5px box-shadow cells put cell edges on
// fractional device-pixel boundaries depending on where layout happens to
// place the container (and any ancestor filter — e.g. .btn-icon's
// drop-shadow — changes the rounding path). When edges land at .5 device px
// every cell boundary AA-bleeds ~25% background through — the hairline-gap
// bug. Nearest-neighbour sampling of a real image covers every device pixel
// exactly once at ANY sub-pixel offset, under filters and transforms, at
// every DPR. Never go back to box-shadow grids.
//
// Grid rules: rectangular, odd width/height; '.'/' ' = empty.
// `currentColor: true` bakes the PNG as a mask + `background: currentColor`
// so the glyph rides the button's text colour (info-i).
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'

const CELL = 1.5

// ---- MOVE: four-way arrow cross, white with #ddd bevel flanks ----
const MOVE = {
  name: 'move-icon',
  pal: { W: '#ffffff', D: '#dddddd' },
  grid: [
    '......W......',
    '.....WWW.....',
    '....DWWWD....',
    '......W......',
    '..D...W...D..',
    '.DW...W...WD.',
    'WWWWWWWWWWWWW',
    '.DW...W...WD.',
    '..D...W...D..',
    '......W......',
    '....DWWWD....',
    '.....WWW.....',
    '......W......'
  ]
}

// ---- INFO: pixel lowercase 'i' — colourless shadows ride currentColor ----
const INFO = {
  name: 'info-i-icon',
  currentColor: true,
  pal: { X: null },
  grid: [
    '...XX....',
    '...XX....',
    '.........',
    '..XXX....',
    '...XX....',
    '...XX....',
    '...XX....',
    '...XX....',
    '..XXXXX..'
  ]
}

// ---- DELETE: bold white X, shaded lower edges ----
const DELETE = {
  name: 'delete-icon',
  pal: { W: '#ffffff', D: '#d8d8d8' },
  grid: [
    '...........',
    '.WW.....WW.',
    '.WWW...WWW.',
    '..WWW.WWW..',
    '...WWWWW...',
    '....WWW....',
    '...WWWWW...',
    '..WWW.WWW..',
    '.WWW...WWW.',
    '.WD.....DW.',
    '...........'
  ]
}

// ---- UPGRADE: chunky up arrow, white with #ddd shading ----
const UPGRADE = {
  name: 'upgrade-icon',
  pal: { W: '#ffffff', D: '#dddddd' },
  grid: [
    '.....W.....',
    '....WWW....',
    '...WWWWW...',
    '..WWWWWWW..',
    '.DWWWWWWWD.',
    '....WWD....',
    '....WWD....',
    '....WWD....',
    '....WWD....',
    '....DDD....',
    '...........'
  ]
}

// ---- SETTINGS: 8-tooth gear, two greys + outline, dark centre hole ----
const SETTINGS = {
  name: 'settings-icon',
  pal: { L: '#b9bdc4', G: '#8f939b', D: '#666b73', K: '#26282c', O: '#3b3e44' },
  grid: [
    '......OOOOO......',
    '......OLLLO......',
    '..OOOOOLLGOOOOO..',
    '..OLLOLLGGGOGGO..',
    '..OLLLLGGGGGGGO..',
    '..OOLLGGGGGGGOO..',
    'OOOLLGGKKKGGGGOOO',
    'OLLLGGKKKKKGGGGDO',
    'OLLGGGKKKKKGGGDDO',
    'OLGGGGKKKKKGGDDDO',
    'OOOGGGGKKKGGDDOOO',
    '..OOGGGGGGGDDOO..',
    '..OGGGGGGGDDDDO..',
    '..OGGOGGGDDODDO..',
    '..OOOOOGDDOOOOO..',
    '......ODDDO......',
    '......OOOOO......'
  ]
}

// ---- BUILD: hammer — iron head w/ glint, wooden handle w/ leather bands ----
// Head horizontal, handle STRAIGHT DOWN from its centre — perpendicular,
// no gaps (the old diagonal handle met the head at an angle; owner call).
const BUILD = {
  name: 'build-icon',
  pal: {
    O: '#2e2a26',
    W: '#eef3f7', F: '#cdd4da', I: '#99a1a9', i: '#6f767e', d: '#565c63',
    H: '#92602f', h: '#6b431f', g: '#4a2c12'
  },
  grid: [
    '.....................',
    '...OOOOOOOOOOOOOOO...',
    '..OWWWWFFFFFFFFFFFO..',
    '..OWIIIIIIIIIIIIFFO..',
    '..OIIIIIIIIIIIIIFFO..',
    '..OIIIIIIIIIIIIIFFO..',
    '..OiiIIIIIIIIIIiFFO..',
    '..OiiiiiiiiiiiiiddO..',
    '..OdddddddddddddddO..',
    '..OOOOOOOHHhOOOOOOO..',
    '........OHHhO........',
    '........OHHhO........',
    '........OgggO........',
    '........OHHhO........',
    '........OHHhO........',
    '........OHHhO........',
    '........OgggO........',
    '........OHHhO........',
    '........OhhhO........',
    '.........OOO.........',
    '.....................'
  ]
}

// ---- RAID: upward sword — edge highlight, dark fuller, gold guard ----
const RAID = {
  name: 'raid-icon',
  pal: {
    W: '#ffffff', E: '#f4f6f8', B: '#d3d8dd', b: '#c2c7cd', F: '#969ca4', s: '#9aa0a8',
    L: '#FFEC8B', G: '#FFD700', D: '#DAA520', K: '#8B6914',
    p: '#7D4C3A', P: '#5D4037', q: '#3f2a20'
  },
  grid: [
    '.........W.........',
    '........EWs........',
    '........EWs........',
    '.......EBBbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBFbs.......',
    '.......EBBbs.......',
    '.......EBBbs.......',
    '..DGGGLLGGGGGGDK...',
    '..KDDDDDDDDDDDKK...',
    '..KK....PpP...KK...',
    '........PpP........',
    '........pPq........',
    '........PpP........',
    '........pPq........',
    '........PpP........',
    '........KDK........',
    '.......KDGLDK......',
    '........KDK........'
  ]
}

// ---- MAP: folded tri-panel parchment — route dots, red X, forest, lake ----
const MAP = {
  name: 'map-icon',
  pal: {
    O: '#6b5738', P: '#ecd9a8', p: '#d6c28f', c: '#b7a274',
    R: '#c0392b', g: '#5f8f49', G: '#4f7a3d', B: '#6fa3b8', b: '#5b8fa8'
  },
  grid: [
    'OOOOO.....OOOOO',
    'OPPPcOOOOOcPPPO',
    'OggPcpppppcRPRO',
    'OGggcpppppcPRPO',
    'OPGPcppppRcRPRO',
    'OPPPcppRppcPPPO',
    'OPPPcRppppcPPPO',
    'OPPRcpBBbpcPPPO',
    'ORPPcppbppcPPPO',
    'OOOOOpppppOOOOO',
    '.....OOOOO.....'
  ]
}

// ---- HOME: cottage — red roof + ridge highlight, stone wall, door, window ----
const HOME = {
  name: 'home-icon',
  pal: {
    O: '#4a2b1c', h: '#f08a70', R: '#d9503c', r: '#b03a2a',
    C: '#9a9a9a', c: '#767676',
    W: '#ddcdb8', w: '#bda88e',
    d: '#5e3212', D: '#8a5024', k: '#e8c060',
    Y: '#ffe4a8', y: '#eec070',
    F: '#8a8474', f: '#6b6656'
  },
  grid: [
    '......OhO......',
    '.....OhRROCC...',
    '....OhRRRrCc...',
    '...ORRRRRrCc...',
    '..ORRRRRRrrrO..',
    '.ORRRRRRRRrrrO.',
    'ORRRRRRRRRRrrrO',
    '..OwwwwwwwwwO..',
    '..OWWWWWWWWwO..',
    '..OWYyWdddWwO..',
    '..OWYyWdDdWwO..',
    '..OWWWWdDkWwO..',
    '..OwwwwdDdwwO..',
    '.FFFFFFFFFFFFf.',
    '...............'
  ]
}

// ---- PRACTICE: bullseye — white/red/white rings + red bull, outlined ----
const PRACTICE = {
  name: 'practice-icon',
  pal: {
    O: '#2c2c2c', W: '#f2f2f2', w: '#cfcfcf',
    R: '#d42618', r: '#9c1a0e', B: '#ff3b28'
  },
  grid: [
    '........OOOOOOO........',
    '.....OOOOWWWWWOOOO.....',
    '....OOWWWWWWWWWWWOO....',
    '...OOWWWWWWWWWWWWWOO...',
    '..OOWWWWRRRRRRRWWWWOO..',
    '.OOWWWWRRRRRRRRRWWWWOO.',
    '.OWWWWRRRRRRRRRRRWWWWO.',
    '.OWWWRRRRWWWWWRRRRWWWO.',
    'OOWWRRRRWWWWWWWRRRRWWOO',
    'OWWWRRRWWWBBBWWWRRRWwwO',
    'OWWWRRRWWBBBBBWWRRRwwwO',
    'OWWWRRRWWBBBBBWWRRrwwwO',
    'OWWWRRRWWBBBBBWWRrrwwwO',
    'OWWWRRRWWWBBBWWWrrrwwwO',
    'OOWWRRRRWWWWWWWrrrrwwOO',
    '.OWWWRRRRWWWWWrrrrwwwO.',
    '.OWWWWRRRRRRRrrrrwwwwO.',
    '.OOWWWWRRRRRrrrrwwwwOO.',
    '..OOWWWWRRRrrrrwwwwOO..',
    '...OOWWWWWwwwwwwwwOO...',
    '....OOWWWwwwwwwwwOO....',
    '.....OOOOwwwwwOOOO.....',
    '........OOOOOOO........'
  ]
}

// ---- FINDMATCH: magnifying glass — metal ring, glass glint, wood handle ----
const FINDMATCH = {
  name: 'findmatch-icon',
  pal: {
    O: '#2a2d31', h: '#aeb4bc', M: '#7c828a', m: '#565c64',
    x: '#eef8ff', a: '#bfe2f4', b: '#8cc4e2', c: '#5f9ec2',
    p: '#7a5236', q: '#4e3320'
  },
  grid: [
    '.........................',
    '.......OOOOOOO...........',
    '.....OOOhhhhhOOO.........',
    '....OOhhhhhhhMMOO........',
    '...OOhhhhxxxMMMMOO.......',
    '..OOhhhaxxxaaaMMMOO......',
    '..OhhhaxxxaaaabMMMO......',
    '.OOhhaxxxaaaabbbMMOO.....',
    '.OhhhxxxaaaabbbbMmmO.....',
    '.OhhxxxaaaabbbbbcmmO.....',
    '.OhhxxaaaabbbbbccmmO.....',
    '.OhhxaaaabbbbbcccmmO.....',
    '.OhhMaaabbbbbcccmmmO.....',
    '.OOMMaabbbbbccccmmOO.....',
    '..OMMMbbbbbccccmmmO......',
    '..OOMMMbbbccccmmmOO......',
    '...OOMMMMcccmmmmpqOO.....',
    '....OOMMmmmmmmmOppqOO....',
    '.....OOOmmmmmOOOOppqOO...',
    '.......OOOOOOO..OOppqOO..',
    '.................OOppqOO.',
    '..................OOppqOO',
    '...................OOppqO',
    '....................OOpOO',
    '.....................OOO.'
  ]
}

// ---- TROPHY: gold cup — specular bowl, side handles, stem, plinth ----
const TROPHY = {
  name: 'trophy-icon',
  pal: {
    O: '#4a3608', W: '#FFF8DC', L: '#FFEC8B', G: '#FFD700',
    D: '#DAA520', B: '#B8860B', K: '#8B6914'
  },
  grid: [
    '...OOOOOOOOO...',
    '..OGLLGGGGGDO..',
    '.BBOGLWGGGDOKK.',
    '.B.OGLGGGGDO.K.',
    '.B.OGGGGDDDO.K.',
    '.BB.OGGGDDO.KK.',
    '.....OGGDO.....',
    '.....OGDO......',
    '.....OGDO......',
    '....OGGDDO.....',
    '..OBGGGGDDDKO..',
    '..OOOOOOOOOOO..',
    '...............'
  ]
}

// ---- BELL: gold bell — nub, lit dome, flare, dark mouth, clapper ----
const BELL = {
  name: 'bell-icon',
  pal: {
    O: '#4a3608', W: '#FFF8DC', L: '#FFEC8B', G: '#FFD700',
    D: '#DAA520', B: '#B8860B', K: '#8B6914', C: '#6B4E0A'
  },
  grid: [
    '.....OOO.....',
    '.....OBO.....',
    '....OGLGO....',
    '...OGLLGDO...',
    '..OGLLGGDDO..',
    '..OGLGGGDDO..',
    '.OBGGGGDDDKO.',
    '.OBGGGGDDDKO.',
    'OBBGGGGGDDKKO',
    'OKKKKKKKKKKKO',
    '.OOOOOOOOOOO.',
    '.....OCO.....',
    '.....OOO.....',
    '.............',
    '.............'
  ]
}

// ---- EYE: almond eye — pointed tips, blue iris 3x3, pupil = centre bg ----
const EYE = {
  name: 'eye-icon',
  pal: {
    O: '#1a1a1a', S: '#f5f5f5', s: '#d8dee2',
    H: '#aaddff', I: '#5599ee', i: '#4488dd',
    M: '#3377cc', u: '#2255aa', v: '#1e4499', P: '#0a0a0a'
  },
  grid: [
    '....OOOOOOO....',
    '..OOSSSSSSSOO..',
    '.OSSSSHIiSSSSO.',
    'OSSSSSMPMSSSSSO',
    '.OsSSSuuvSSSsO.',
    '..OOsssssssOO..',
    '....OOOOOOO....'
  ]
}

// ---- SWORD: compact upright sword — bright blade, gold guard, pommel ----
const SWORD = {
  name: 'sword-icon',
  pal: {
    W: '#ffffff', e: '#c6cacc', c: '#eef0f2', s: '#8f9296',
    L: '#FFEC8B', G: '#FFD700', D: '#DAA520', K: '#8B6914',
    g: '#7D4C3A', h: '#5D3420', B: '#B8860B'
  },
  grid: [
    '......W......',
    '.....ecs.....',
    '.....ecs.....',
    '.....ecs.....',
    '.....ecs.....',
    '.....ecs.....',
    '.KDGGLGGGDDK.',
    '.....hgh.....',
    '.....ghg.....',
    '.....hgh.....',
    '....BDLDB....',
    '.............',
    '.............'
  ]
}

// ---- TEST: scarecrow dummy — burlap head, crossbar, tunic, grass ----
const TEST = {
  name: 'test-icon',
  pal: {
    O: '#3a2a14', t: '#DBC4A0', b: '#D2B48C', d: '#C8A878', E: '#241505',
    p: '#a05c22', P: '#8B4513', D: '#5B2400',
    h: '#9a6a30', H: '#7B4420', K: '#5B2400',
    A: '#B0623D', a: '#A0522D', s: '#7e3a1c',
    G: '#5a8a4a', g: '#4a7a3a'
  },
  grid: [
    '.......OOOOO.......',
    '......OtbbbdO......',
    '.....OtbbbbddO.....',
    '.....ObEbbEddO.....',
    '.....ObbbbbddO.....',
    '......ObbbddO......',
    '.......OOOOO.......',
    '.......OpPDO.......',
    '.OOOOOOOpPDOOOOOOO.',
    'OhhhhhhhpPDHHHHHHHO',
    'OHHHHHHHpPDKKKKKKKO',
    '.OOOOOOOpPDOOOOOOO.',
    '...OAAAAAaaaaaaO...',
    '....OAAAAaaaaaO....',
    '....OAAAAaaaasO....',
    '.....OAAAaaasO.....',
    '.....OAAaaassO.....',
    '......OOpPDOO......',
    '.......OpPDO.......',
    '.......OpPDO.......',
    '.......OpPDO.......',
    '.......OpPDO.......',
    '.......OpPDO.......',
    '.......OpPDO.......',
    '.......OpPDO.......',
    '.......OpPDO.......',
    '...gG..OpPDO..Gg...',
    '..gGGggOpPDOggGGg..',
    '.gggggGGgggGGggggg.',
    '...................',
    '...................'
  ]
}

// ---- WATCHTOWER: pennant, canopy, deck + watchman, shaft, stone foot ----
// Art occupies y -21..0 (above the anchor) to match the old glyph's placement.
const WATCHTOWER = {
  name: 'watchtower-icon',
  pal: {
    p: '#5c4326', R: '#d8563c',
    A: '#a64a38', B: '#8a3d2f', E: '#6e2f24',
    V: '#4a4258', T: '#d9b38c',
    D: '#c9b593', d: '#a08a64',
    S: '#8a6a42', s: '#6e5335',
    L: '#b0a892', M: '#8a8272', m: '#6e6658'
  },
  grid: [
    '......pRRR...',
    '......pRR....',
    '......p......',
    '....AAAAA....',
    '...AAAABBB...',
    '..EEEEEEEEE..',
    '...p.VTV.p...',
    '..dDDDDDDDd..',
    '....SSSSs....',
    '....SsSSs....',
    '....SSsSs....',
    '....SsSSs....',
    '....SSSSs....',
    '...LLLLLMM...',
    '..MLLLLMMdd..',
    '.............',
    '.............',
    '.............',
    '.............',
    '.............',
    '.............',
    '.............',
    '.............',
    '.............',
    '.............',
    '.............',
    '.............',
    '.............',
    '.............'
  ]
}

const ICONS = [
  MOVE, INFO, DELETE, UPGRADE, SETTINGS, BUILD, RAID, MAP, HOME,
  PRACTICE, FINDMATCH, TROPHY, BELL, EYE, SWORD, TEST, WATCHTOWER
]

for (const icon of ICONS) {
  const gw = icon.grid[0].length
  const gh = icon.grid.length
  if (gh % 2 === 0 || gw % 2 === 0) throw new Error(`${icon.name}: grid must be odd-sized (${gw}x${gh})`)
  for (const [i, row] of icon.grid.entries()) {
    if (row.length !== gw) throw new Error(`${icon.name}: row ${i} is ${row.length} wide, expected ${gw}`)
    for (const ch of row) {
      if (ch !== '.' && ch !== ' ' && !(ch in icon.pal)) throw new Error(`${icon.name}: no palette entry '${ch}'`)
    }
  }
}

// One baked PNG per icon (1 png px per grid cell), shown at CELL px per cell
// via background-size + image-rendering: pixelated. currentColor icons bake
// the same PNG as a mask instead. See header for why.
function toCss(icon, dataUri) {
  const gw = icon.grid[0].length
  const gh = icon.grid.length
  const paint = icon.currentColor
    ? `background: currentColor;\n    -webkit-mask: url('${dataUri}') 0 0 / 100% 100% no-repeat;\n    mask: url('${dataUri}') 0 0 / 100% 100% no-repeat;`
    : `background: url('${dataUri}') 0 0 / 100% 100% no-repeat;`
  return `.${icon.name}::before {\n    content: '';\n    position: absolute;\n    width: ${gw * CELL}px;\n    height: ${gh * CELL}px;\n    top: 50%;\n    left: 50%;\n    transform: translate(-50%, -50%);\n    image-rendering: pixelated;\n    ${paint}\n}`
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
          // currentColor icons bake an opaque mask; colour comes at use time
          ctx.fillStyle = icon.currentColor ? '#ffffff' : icon.pal[ch]
          ctx.fillRect(x, y, 1, 1)
        })
      })
      return cv.toDataURL('image/png')
    })
  }, ICONS)
  let css = '/* generated by tools/art-preview/gen-ui-icons.mjs */\n\n'
  ICONS.forEach((icon, i) => {
    css += `/* ${icon.name} — ${icon.grid[0].length}x${icon.grid.length} @ ${CELL}px cells, baked PNG */\n${toCss(icon, uris[i])}\n\n`
  })
  writeFileSync(new URL('./shots/ui-icon-css.txt', import.meta.url), css)

  const png = await page.evaluate((icons) => {
    const SCALE = 10
    const COLS = 6
    const PAD = 8
    const LABEL = 22
    const tileW = Math.max(...icons.map(i => i.grid[0].length)) * SCALE + PAD * 2
    const tileH = Math.max(...icons.map(i => i.grid.length)) * SCALE + PAD * 2 + LABEL
    const rows = Math.ceil(icons.length / COLS)
    const cv = document.createElement('canvas')
    cv.width = COLS * tileW
    cv.height = rows * tileH
    const ctx = cv.getContext('2d')
    ctx.fillStyle = '#3a4150'
    ctx.fillRect(0, 0, cv.width, cv.height)
    icons.forEach((icon, k) => {
      const gw = icon.grid[0].length
      const gh = icon.grid.length
      const ox = (k % COLS) * tileW + Math.floor((tileW - gw * SCALE) / 2)
      const oy = Math.floor(k / COLS) * tileH + Math.floor((tileH - LABEL - gh * SCALE) / 2)
      // tile frame
      ctx.strokeStyle = '#2a2f3a'
      ctx.strokeRect((k % COLS) * tileW + 0.5, Math.floor(k / COLS) * tileH + 0.5, tileW - 1, tileH - 1)
      icon.grid.forEach((row, y) => {
        ;[...row].forEach((ch, x) => {
          if (ch === '.' || ch === ' ') return
          ctx.fillStyle = icon.currentColor ? '#f0d264' : icon.pal[ch]
          ctx.fillRect(ox + x * SCALE, oy + y * SCALE, SCALE, SCALE)
        })
      })
      ctx.fillStyle = '#cdd3de'
      ctx.font = '14px monospace'
      ctx.textAlign = 'center'
      ctx.fillText(icon.name, (k % COLS) * tileW + tileW / 2, (Math.floor(k / COLS) + 1) * tileH - 10)
    })
    return cv.toDataURL('image/png')
  }, ICONS)
  writeFileSync(new URL('./shots/ui-icon-preview.png', import.meta.url), Buffer.from(png.split(',')[1], 'base64'))
  console.log('preview + css written')
} finally {
  await browser.close()
}
