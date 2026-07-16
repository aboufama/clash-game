// Game-icon generator: troop/building/obstacle icons for the training modal,
// build shop, army bar and info panel. The art is the hand-authored 2px-cell
// pixel lists ported VERBATIM from the old box-shadow CSS (see
// game-icon-data.mjs — comments intact, that file is the authoring source).
// This script bakes each list into a data-URI PNG (1 png px per CSS px, so
// half-cell nudges and rgba() translucency survive exactly) and emits the CSS
// for src/icons/accurate-icons.css.
//
// WHY PNG and not box-shadow: box-shadow cells put cell edges on fractional
// device-pixel boundaries depending on where layout happens to place the
// container (and any ancestor filter/transform changes the rounding path).
// When edges land at .5 device px every cell boundary AA-bleeds ~25%
// background through — the hairline-gap bug. Nearest-neighbour sampling of a
// real image covers every device pixel exactly once at ANY sub-pixel offset,
// under filters and transforms, at every DPR. Never go back to box-shadow
// grids.
//
// ANCHOR CONTRACT: the old construction was a 2×2 element at top/left 50% +
// translate(-50%,-50%) whose shadows hung off it asymmetrically. Consumers
// re-anchor that pivot (`.troop-grid-item .icon.large::before { top: 35% }`,
// `.bb-header .bb-icon::before { transform: ... scale(0.6) }`), so the baked
// canvas is PADDED so the old element's centre is the PNG centre — the same
// top/left/translate(-50%,-50%) rule then lands every pixel exactly where the
// box-shadow version did, and every consumer override keeps working.
//
// Usage: node gen-game-icons.mjs
//   → writes shots/game-icon-css.txt (spliced into accurate-icons.css)
//   → writes shots/game-icon-preview.png (LOOK at it before splicing)
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { ICONS } from './game-icon-data.mjs'

// ---- parse one pixel list: top-level-comma-split, strip comments ----
function parsePx(px, selector) {
  const clean = px.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const entries = []
  let depth = 0
  let cur = ''
  for (const ch of clean + ',') {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      const e = cur.trim()
      cur = ''
      if (!e) continue
      const m = e.match(/^(-?\d+(?:\.\d+)?)(?:px)?\s+(-?\d+(?:\.\d+)?)(?:px)?\s+(#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b|rgba?\([^)]*\))$/)
      if (!m) throw new Error(`${selector}: cannot parse pixel entry ${JSON.stringify(e)}`)
      entries.push({ x: parseFloat(m[1]), y: parseFloat(m[2]), rgba: toRgba(m[3], selector) })
      continue
    }
    cur += ch
  }
  return entries
}

function toRgba(c, selector) {
  if (c[0] === '#') {
    const h = c.length === 4 ? [...c.slice(1)].map(x => x + x).join('') : c.slice(1)
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]
  }
  const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/)
  if (!m) throw new Error(`${selector}: cannot parse colour ${c}`)
  return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]]
}

// ---- minimal RGBA PNG encoder (filter 0, straight alpha) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function encodePng(w, h, rgba /* Float64Array, straight alpha 0..1, len w*h*4 */) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4)
    raw[row] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const o = row + 1 + x * 4
      raw[o] = Math.round(rgba[i])
      raw[o + 1] = Math.round(rgba[i + 1])
      raw[o + 2] = Math.round(rgba[i + 2])
      raw[o + 3] = Math.round(rgba[i + 3] * 255)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---- bake one icon ----
function bake(icon) {
  const selector = icon.classes.join(', ')
  const entries = parsePx(icon.px, selector)
  if (!/^#[0-9a-fA-F]{6}$/.test(icon.base)) throw new Error(`${selector}: base must be 6-digit hex, got ${icon.base}`)

  // px-space bounds relative to the old element CENTRE: a shadow at offset
  // (x,y) paints a 2×2 box spanning [x-1, x+1]; the element itself is [-1, 1].
  let hw = 1
  let hh = 1
  for (const e of entries) {
    hw = Math.max(hw, Math.abs(e.x - 1), Math.abs(e.x + 1))
    hh = Math.max(hh, Math.abs(e.y - 1), Math.abs(e.y + 1))
  }
  hw = Math.ceil(hw)
  hh = Math.ceil(hh)
  const w = 2 * hw
  const h = 2 * hh

  const buf = new Float64Array(w * h * 4)
  const paint = (px, py, [r, g, b, a]) => {
    // source-over a 2×2 box whose top-left is (px, py) in canvas px
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const x = px + dx
        const y = py + dy
        if (x < 0 || y < 0 || x >= w || y >= h) throw new Error(`${selector}: paint out of bounds`)
        const i = (y * w + x) * 4
        const da = buf[i + 3]
        const oa = a + da * (1 - a)
        if (oa > 0) {
          buf[i] = (r * a + buf[i] * da * (1 - a)) / oa
          buf[i + 1] = (g * a + buf[i + 1] * da * (1 - a)) / oa
          buf[i + 2] = (b * a + buf[i + 2] * da * (1 - a)) / oa
        }
        buf[i + 3] = oa
      }
    }
  }
  // CSS box-shadow: FIRST shadow paints on top → paint last→first, source-over
  for (let k = entries.length - 1; k >= 0; k--) {
    paint(hw + entries[k].x - 1, hh + entries[k].y - 1, entries[k].rgba)
  }
  // the element's own background paints ON TOP of all shadows at (0,0)
  paint(hw - 1, hh - 1, toRgba(icon.base, selector))

  const uri = 'data:image/png;base64,' + encodePng(w, h, buf).toString('base64')
  const sel = icon.classes.map(c => `.${c}::before`).join(',\n')
  const css = `${sel} {\n    content: '';\n    position: absolute;\n    width: ${w}px;\n    height: ${h}px;\n    top: 50%;\n    left: 50%;\n    transform: translate(-50%, -50%);\n    image-rendering: pixelated;\n    background: url('${uri}') 0 0 / 100% 100% no-repeat;\n}`
  return { icon, w, h, buf, css }
}

const baked = ICONS.map(bake)

let css = ''
for (const b of baked) css += b.css + '\n\n'
mkdirSync(new URL('./shots/', import.meta.url), { recursive: true })
writeFileSync(new URL('./shots/game-icon-css.txt', import.meta.url), css)

// ---- preview sheet: every icon scaled up on a checker-free dark ground ----
{
  const SCALE = 4
  const COLS = 7
  const cellW = Math.max(...baked.map(b => b.w)) + 6
  const cellH = Math.max(...baked.map(b => b.h)) + 6
  const rows = Math.ceil(baked.length / COLS)
  const W = COLS * cellW * SCALE
  const H = rows * cellH * SCALE
  const sheet = new Float64Array(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    sheet[i * 4] = 58; sheet[i * 4 + 1] = 65; sheet[i * 4 + 2] = 80; sheet[i * 4 + 3] = 1
  }
  baked.forEach((b, k) => {
    const ox = ((k % COLS) * cellW + ((cellW - b.w) >> 1)) * SCALE
    const oy = (Math.floor(k / COLS) * cellH + ((cellH - b.h) >> 1)) * SCALE
    for (let y = 0; y < b.h * SCALE; y++) {
      for (let x = 0; x < b.w * SCALE; x++) {
        const si = ((y / SCALE | 0) * b.w + (x / SCALE | 0)) * 4
        const a = b.buf[si + 3]
        if (a === 0) continue
        const di = ((oy + y) * W + ox + x) * 4
        sheet[di] = b.buf[si] * a + sheet[di] * (1 - a)
        sheet[di + 1] = b.buf[si + 1] * a + sheet[di + 1] * (1 - a)
        sheet[di + 2] = b.buf[si + 2] * a + sheet[di + 2] * (1 - a)
        sheet[di + 3] = 1
      }
    }
  })
  writeFileSync(new URL('./shots/game-icon-preview.png', import.meta.url), encodePng(W, H, sheet))
}

console.log(`baked ${baked.length} icons → shots/game-icon-css.txt + shots/game-icon-preview.png`)
for (const b of baked) console.log(`  ${b.icon.classes.join(', ')}  ${b.w}×${b.h}px`)
