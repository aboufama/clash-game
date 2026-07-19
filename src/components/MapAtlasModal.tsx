import { useEffect, useMemo, useRef, useState } from 'react';
import { Backend } from '../game/backend/GameBackend';
import { soundSystem } from '../game/systems/SoundSystem';
import {
  HYDROLOGY_PLOT_PITCH,
  queryWorldHydrology,
  type GreatLakeFeature
} from '../game/config/WorldHydrology';
import { buildVariableWidthRibbon } from '../game/renderers/WorldHydrologyRenderer';
import { WildernessRenderer } from '../game/renderers/WildernessRenderer';

interface AtlasPlayer {
  x: number;
  y: number;
  username: string;
  trophies: number;
  shielded: boolean;
  underAttack: boolean;
  me: boolean;
  online: boolean;
}

interface AtlasData {
  me: { x: number; y: number };
  players: AtlasPlayer[];
  /** Live raids: attacker plot -> victim plot. */
  battles?: Array<{ ax: number; ay: number; vx: number; vy: number }>;
  window: { minX: number; maxX: number; minY: number; maxY: number };
  truncated: boolean;
}

/**
 * A regional atlas around the signed-in village. Drawn on a
 * low-res canvas scaled up with crisp pixels — a castle glyph per settled
 * plot, gold for you, a red battle mark where a raid is live, a shield ring
 * on protected villages. Hovering a castle names its chief.
 */

/** Tiny cartographic stamps for the wild-plot natures — same classification
 * the world map's postcards use, inked in a parchment-map vocabulary. */
function drawNatureGlyph(ctx: CanvasRenderingContext2D, key: string, x: number, y: number, h: number) {
  const tree = (tx: number, ty: number, tone: string) => {
    ctx.fillStyle = tone;
    ctx.fillRect(tx + 1, ty, 1, 1);
    ctx.fillRect(tx, ty + 1, 3, 2);
    ctx.fillStyle = '#5c4430';
    ctx.fillRect(tx + 1, ty + 3, 1, 1);
  };
  const caret = (tx: number, ty: number, tone: string) => {
    ctx.fillStyle = tone;
    ctx.fillRect(tx + 1, ty, 1, 1);
    ctx.fillRect(tx, ty + 1, 1, 1);
    ctx.fillRect(tx + 2, ty + 1, 1, 1);
  };
  if (key === 'pines' || key === 'grove' || key === 'thicket' || key === 'glade' || key === 'deadwood') {
    const tones = key === 'pines' ? ['#39603d', '#2f5334']
      : key === 'deadwood' ? ['#6b5b45', '#5c4d3a']
      : ['#4c7442', '#3f6538'];
    tree(x, y + 2, tones[0]);
    tree(x + 4, y, tones[1]);
    if (key !== 'glade' && h % 2 === 0) tree(x + 2, y + 5, tones[(h >> 4) % 2]);
  } else if (key === 'crags' || key === 'standing-stones' || key === 'boulder-lone-tree') {
    caret(x, y + 1, '#7d7d72');
    caret(x + 4, y + 3, '#8d8d80');
    if (key === 'boulder-lone-tree') tree(x + 4, y - 1, '#4c7442');
  } else if (key === 'marsh') {
    ctx.fillStyle = '#5f8f7a';
    ctx.fillRect(x, y + 2, 3, 1);
    ctx.fillRect(x + 4, y + 4, 3, 1);
    ctx.fillRect(x + 2, y + 6, 2, 1);
  } else if (key === 'lake') {
    ctx.fillStyle = '#7fb2b7';
    ctx.fillRect(x, y + 2, 5, 3);
    ctx.fillRect(x + 1, y + 1, 3, 5);
    ctx.fillStyle = '#5f9aa8';
    ctx.fillRect(x + 1, y + 2, 3, 2);
  } else if (key === 'river') {
    ctx.fillStyle = '#7fb2b7';
    ctx.fillRect(x, y + 4, 2, 1);
    ctx.fillRect(x + 1, y + 3, 2, 1);
    ctx.fillRect(x + 2, y + 2, 2, 1);
    ctx.fillRect(x + 3, y + 1, 2, 1);
  } else if (h % 3 === 0) {
    // Open meadow: a couple of pale grass ticks, mostly left as parchment.
    ctx.fillStyle = '#a8a86b';
    ctx.fillRect(x + 1, y + 3, 1, 1);
    ctx.fillRect(x + 5, y + 5, 1, 1);
  }
}

// 7x7 keep glyph: battlements, body, door. 1 = wall, 2 = door, 0 = air.
const KEEP = [
  [1, 1, 0, 1, 0, 1, 1],
  [1, 1, 1, 1, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 2, 1, 1, 0],
  [0, 1, 1, 2, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 1]
];

const CELL = 14;   // logical pixels per plot cell (7px glyph + breathing room)
const SCALE = 2;   // screen pixels per logical pixel
const MAX_COLS = 48;
const MAX_ROWS = 34;

// ---- the charting reveal ----
// While the chart loads (and briefly after it lands) the atlas is covered by
// fog-of-war tiles in the pxf panel's wood tones, melting outward from the
// player's own keep in diamond (Manhattan) rings. Deterministic f(time): one
// clock per open, per-cell stagger from the cell hash — never Math.random.
const REVEAL_STAGGER = 2;           // extra per-cell delay in rings, from the cell hash
const REVEAL_PLACEHOLDER_MS = 700;  // dataless sweep reaches the hold line in this long
const REVEAL_HOLD = 0.55;           // the dataless sweep parks here and pulses
const REVEAL_COMPLETE_MS = 900;     // hold line -> fully charted once data lands
const REVEAL_COLS = 21;             // placeholder grid, before the first chart arrives
const REVEAL_ROWS = 15;
const FOG_BASE = '#372718';
const FOG_DOT = '#41301d';
const FOG_EDGE = '#2b1e12';
const FRONTIER_TINT = 'rgba(217,179,72,0.30)';

const cellHash = (cx: number, cy: number) => (((cx * 73856093) ^ (cy * 19349663)) >>> 0);

/** One unexplored tile: opaque panel-wood weave with a hard 1px seam. */
function paintFogCell(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  const x = cx * CELL;
  const y = cy * CELL;
  ctx.fillStyle = FOG_BASE;
  ctx.fillRect(x, y, CELL, CELL);
  const h = cellHash(cx, cy);
  ctx.fillStyle = FOG_DOT;
  ctx.fillRect(x + 2 + (h % 5), y + 2 + ((h >> 3) % 5), 2, 2);
  ctx.fillRect(x + 6 + ((h >> 6) % 5), y + 6 + ((h >> 9) % 5), 2, 2);
  ctx.fillStyle = FOG_EDGE;
  ctx.fillRect(x, y + CELL - 1, CELL, 1);
  ctx.fillRect(x + CELL - 1, y, 1, CELL);
}

function drawKeepGlyph(ctx: CanvasRenderingContext2D, px: number, py: number, wall: string, dark: string) {
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 7; gx++) {
      const cell = KEEP[gy][gx];
      if (!cell) continue;
      ctx.fillStyle = cell === 2 ? dark : wall;
      ctx.fillRect(px + gx, py + gy, 1, 1);
    }
  }
}

export function MapAtlasModal({ onClose }: { onClose: () => void }) {
  const [atlas, setAtlas] = useState<AtlasData | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [hover, setHover] = useState<AtlasPlayer | null>(null);
  const [revealDone, setRevealDone] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const placeholderRef = useRef<HTMLCanvasElement>(null);
  const revealRef = useRef<HTMLCanvasElement>(null);
  // One reveal clock per open; the overlay resumes from wherever the
  // dataless sweep had reached instead of restarting.
  const revealT0 = useRef<number | null>(null);
  const overlayStart = useRef<{ at: number; from: number } | null>(null);

  // The chart is LIVE: re-fetched every few seconds while open, so battles
  // appear, shields drop and chiefs come online before your eyes.
  useEffect(() => {
    let dead = false;
    const pull = () => void Backend.fetchAtlas().then(a => {
      if (dead) return;
      if (a) {
        setAtlas(a);
        setFetchFailed(false);
      } else {
        setFetchFailed(true);
      }
    }).catch(() => {
      if (!dead) setFetchFailed(true);
    });
    pull();
    const timer = window.setInterval(pull, 5000);
    return () => { dead = true; window.clearInterval(timer); };
  }, []);

  // World-bounds → a bounded bucket grid. World coordinates may be sparse
  // (or hostile), so the canvas must never be sized from their raw span.
  const layout = useMemo(() => {
    // fetchAtlas normalizes the payload, but this render math must never be
    // one protocol drift away from unmounting the app — belt and braces.
    if (!atlas?.me || !Array.isArray(atlas.players)) return null;
    let minX = Number.isFinite(atlas.me.x) ? Math.trunc(atlas.me.x) : 0;
    let maxX = minX;
    let minY = Number.isFinite(atlas.me.y) ? Math.trunc(atlas.me.y) : 0;
    let maxY = minY;
    for (const player of atlas.players) {
      if (!Number.isFinite(player.x) || !Number.isFinite(player.y)) continue;
      const x = Math.trunc(player.x);
      const y = Math.trunc(player.y);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    // Always chart at least the near region: a lone village still gets its
    // surrounding lakes and forests, not a 3x3 postage stamp.
    const meX = Number.isFinite(atlas.me.x) ? Math.trunc(atlas.me.x) : 0;
    const meY = Number.isFinite(atlas.me.y) ? Math.trunc(atlas.me.y) : 0;
    minX = Math.min(minX, meX - 6);
    maxX = Math.max(maxX, meX + 6);
    minY = Math.min(minY, meY - 6);
    maxY = Math.max(maxY, meY + 6);
    const spanX = Math.max(1, maxX - minX + 1);
    const spanY = Math.max(1, maxY - minY + 1);
    const bucket = Math.max(1, Math.ceil(spanX / (MAX_COLS - 2)), Math.ceil(spanY / (MAX_ROWS - 2)));
    const cols = Math.min(MAX_COLS, Math.ceil(spanX / bucket) + 2);
    const rows = Math.min(MAX_ROWS, Math.ceil(spanY / bucket) + 2);
    const project = (x: number, y: number) => ({
      cx: Math.max(1, Math.min(cols - 2, Math.floor((Math.trunc(x) - minX) / bucket) + 1)),
      cy: Math.max(1, Math.min(rows - 2, Math.floor((Math.trunc(y) - minY) / bucket) + 1))
    });
    return { minX, minY, bucket, cols, rows, w: cols * CELL, h: rows * CELL, project };
  }, [atlas]);

  useEffect(() => {
    if (!atlas || !layout) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = layout.w;
    canvas.height = layout.h;

    // Parchment sea + a faint plot grid.
    ctx.fillStyle = '#efe3bb';
    ctx.fillRect(0, 0, layout.w, layout.h);
    ctx.fillStyle = '#e2d3a4';
    for (let cx = 0; cx < layout.cols; cx++) {
      for (let cy = 0; cy < layout.rows; cy++) {
        ctx.fillRect(cx * CELL + CELL - 1, cy * CELL, 1, CELL);
        ctx.fillRect(cx * CELL, cy * CELL + CELL - 1, CELL, 1);
      }
    }
    // ---- terrain: the SAME absolute geometry the world map renders ----
    // Great Lakes and their rivers are vector-filled from the cached world
    // contours, so their atlas shapes match the overworld exactly; wild
    // plots are stamped with their real nature classification.
    const plotMinX = layout.minX - layout.bucket;
    const plotMinY = layout.minY - layout.bucket;
    const plotMaxX = layout.minX + (layout.cols - 1) * layout.bucket;
    const plotMaxY = layout.minY + (layout.rows - 1) * layout.bucket;
    const toAtlasX = (worldTileX: number) => ((worldTileX / HYDROLOGY_PLOT_PITCH - layout.minX) / layout.bucket + 1) * CELL;
    const toAtlasY = (worldTileY: number) => ((worldTileY / HYDROLOGY_PLOT_PITCH - layout.minY) / layout.bucket + 1) * CELL;
    const fillContour = (points: ReadonlyArray<{ x: number; y: number }>, fill: string) => {
      if (points.length < 3) return;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(toAtlasX(points[0].x), toAtlasY(points[0].y));
      for (let index = 1; index < points.length; index++) {
        ctx.lineTo(toAtlasX(points[index].x), toAtlasY(points[index].y));
      }
      ctx.closePath();
      ctx.fill();
    };
    const features = new Map<string, GreatLakeFeature>();
    try {
      const CHUNK = 40; // stays under the hydrology query's macro-cell bound
      for (let qy = plotMinY; qy <= plotMaxY; qy += CHUNK) {
        for (let qx = plotMinX; qx <= plotMaxX; qx += CHUNK) {
          for (const feature of queryWorldHydrology({
            minPlotX: qx,
            minPlotY: qy,
            maxPlotX: Math.min(plotMaxX, qx + CHUNK - 1),
            maxPlotY: Math.min(plotMaxY, qy + CHUNK - 1)
          })) features.set(feature.id, feature);
        }
      }
    } catch { /* hostile coordinates: the atlas still charts the villages */ }
    const riverRibbon = (feature: GreatLakeFeature, extra: number) => {
      const ribbons: Array<Array<{ x: number; y: number }>> = [];
      for (const reach of feature.network.reaches) {
        if (reach.kind === 'lake-passage' || reach.width <= 0 || reach.points.length < 2) continue;
        ribbons.push(buildVariableWidthRibbon(
          reach.points.map(point => ({ x: point.x, y: point.y })),
          reach.points.map(() => reach.width + extra)
        ));
      }
      return ribbons;
    };
    for (const feature of features.values()) {
      if (feature.waterBody) continue;
      for (const ribbon of riverRibbon(feature, 1.1)) fillContour(ribbon, '#a9a67b');
    }
    for (const feature of features.values()) {
      if (feature.waterBody) {
        // The unified border: the atlas charts EXACTLY what the world draws.
        fillContour(feature.waterBody.bank, '#a9a67b');
        fillContour(feature.waterBody.water, '#7fb2b7');
        fillContour(feature.waterBody.mid, '#5f9aa8');
        fillContour(feature.waterBody.deep, '#48839b');
        continue;
      }
      for (const ribbon of riverRibbon(feature, 0)) fillContour(ribbon, '#7fb2b7');
      fillContour(feature.terrain.contours.bank, '#a9a67b');
      fillContour(feature.terrain.contours.water, '#7fb2b7');
      fillContour(feature.terrain.contours.mid, '#5f9aa8');
      fillContour(feature.terrain.contours.deep, '#48839b');
    }

    // One nature stamp per unsettled, dry plot cell.
    const hydrologyPlots = new Set<string>();
    for (const feature of features.values()) {
      for (const plot of feature.protectedPlots) hydrologyPlots.add(`${plot.x},${plot.y}`);
    }
    const settledCells = new Set(atlas.players
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map(p => {
        const cell = layout.project(p.x, p.y);
        return `${cell.cx},${cell.cy}`;
      }));
    for (let cy = 0; cy < layout.rows; cy++) {
      for (let cx = 0; cx < layout.cols; cx++) {
        if (settledCells.has(`${cx},${cy}`)) continue;
        const centerOffset = layout.bucket > 1 ? Math.floor(layout.bucket / 2) : 0;
        const plotX = layout.minX + (cx - 1) * layout.bucket + centerOffset;
        const plotY = layout.minY + (cy - 1) * layout.bucket + centerOffset;
        if (hydrologyPlots.has(`${plotX},${plotY}`)) continue;
        const nature = WildernessRenderer.natureAt(plotX, plotY);
        const h = ((plotX * 73856093) ^ (plotY * 19349663)) >>> 0;
        drawNatureGlyph(ctx, nature.key, cx * CELL + 3 + (h % 3), cy * CELL + 3 + ((h >> 3) % 3), h);
      }
    }

    // The origin cross — the old heart of the world.
    ctx.fillStyle = '#d9c48c';
    if (layout.minX <= 0 && layout.minX + layout.bucket * (layout.cols - 2) >= 0
      && layout.minY <= 0 && layout.minY + layout.bucket * (layout.rows - 2) >= 0) {
      const origin = layout.project(0, 0);
      ctx.fillRect(origin.cx * CELL, 0, 1, layout.h);
      ctx.fillRect(0, origin.cy * CELL, layout.w, 1);
    }

    for (const p of atlas.players) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const cellPos = layout.project(p.x, p.y);
      const px = cellPos.cx * CELL + Math.floor((CELL - 7) / 2);
      const py = cellPos.cy * CELL + Math.floor((CELL - 7) / 2);
      const wall = p.me ? '#d9b348' : p.online ? '#8b6f47' : '#a4906a';
      const dark = p.me ? '#8a6a1e' : '#5c4033';
      drawKeepGlyph(ctx, px, py, wall, dark);
      // Outline pixel shadow under the keep.
      ctx.fillStyle = 'rgba(28,20,16,0.25)';
      ctx.fillRect(px, py + 7, 7, 1);
      if (p.shielded) {
        ctx.fillStyle = '#4a7ab5';
        ctx.fillRect(px + 2, py - 2, 3, 1);
        ctx.fillRect(px + 1, py - 1, 1, 1);
        ctx.fillRect(px + 5, py - 1, 1, 1);
      }
      if (p.underAttack) {
        ctx.fillStyle = '#c22f1f';
        ctx.fillRect(px + 6, py - 2, 2, 2);
        ctx.fillRect(px + 7, py - 3, 2, 2);
      }
    }
  }, [atlas, layout]);

  // The living layer: dashed raid lines, a dot marching each one, and a
  // pulse on every besieged keep. Its own canvas so the base chart stays
  // untouched; time-driven, redrawn each animation frame while open.
  useEffect(() => {
    if (!atlas || !layout) return;
    const canvas = liveRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = layout.w;
    canvas.height = layout.h;
    let raf = 0;
    const centre = (px: number, py: number) => {
      const cellPos = layout.project(px, py);
      return { x: cellPos.cx * CELL + CELL / 2, y: cellPos.cy * CELL + CELL / 2 };
    };
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const t = performance.now();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const battles = atlas.battles ?? [];
      for (const b of battles) {
        const a = centre(b.ax, b.ay);
        const v = centre(b.vx, b.vy);
        // Dashed war-path, drawn in whole pixels.
        const len = Math.hypot(v.x - a.x, v.y - a.y) || 1;
        const steps = Math.floor(len / 3);
        ctx.fillStyle = 'rgba(194,47,31,0.55)';
        for (let s = 0; s < steps; s += 2) {
          const f = s / steps;
          ctx.fillRect(Math.round(a.x + (v.x - a.x) * f), Math.round(a.y + (v.y - a.y) * f), 1, 1);
        }
        // The raider, marching the line.
        const f = (t / 1400) % 1;
        ctx.fillStyle = '#c22f1f';
        ctx.fillRect(Math.round(a.x + (v.x - a.x) * f) - 1, Math.round(a.y + (v.y - a.y) * f) - 1, 2, 2);
        // The besieged keep pulses.
        const on = Math.floor(t / 380) % 2 === 0;
        if (on) {
          ctx.strokeStyle = 'rgba(194,47,31,0.9)';
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(v.x) - 5.5, Math.round(v.y) - 5.5, 11, 11);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [atlas, layout]);

  // The charting reveal, act one: before the first chart lands, a fog of
  // panel-wood tiles melts outward from your keep at the centre of a
  // placeholder grid. The sweep parks at the hold line and pulses its
  // frontier until data arrives (the retry note replaces it on failure).
  useEffect(() => {
    if (layout || fetchFailed || revealDone) return;
    const canvas = placeholderRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = REVEAL_COLS * CELL;
    canvas.height = REVEAL_ROWS * CELL;
    const mcx = Math.floor(REVEAL_COLS / 2);
    const mcy = Math.floor(REVEAL_ROWS / 2);
    const maxRing = mcx + mcy + REVEAL_STAGGER + 1;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      if (revealT0.current === null) revealT0.current = now;
      const fraction = Math.min(REVEAL_HOLD, ((now - revealT0.current) / REVEAL_PLACEHOLDER_MS) * REVEAL_HOLD);
      const ringFloat = fraction * maxRing;
      const pulse = Math.floor(now / 300) % 2 === 0;
      for (let cy = 0; cy < REVEAL_ROWS; cy++) {
        for (let cx = 0; cx < REVEAL_COLS; cx++) {
          const ring = Math.abs(cx - mcx) + Math.abs(cy - mcy) + (cellHash(cx, cy) % (REVEAL_STAGGER + 1));
          if (ring > ringFloat) {
            paintFogCell(ctx, cx, cy);
            continue;
          }
          const x = cx * CELL;
          const y = cy * CELL;
          ctx.fillStyle = '#efe3bb';
          ctx.fillRect(x, y, CELL, CELL);
          ctx.fillStyle = '#e2d3a4';
          ctx.fillRect(x + CELL - 1, y, 1, CELL);
          ctx.fillRect(x, y + CELL - 1, CELL, 1);
          if (ringFloat - ring < 1 && pulse) {
            ctx.fillStyle = FRONTIER_TINT;
            ctx.fillRect(x, y, CELL, CELL);
          }
        }
      }
      // Your keep seeds the chart at the centre of the sweep.
      drawKeepGlyph(
        ctx,
        mcx * CELL + Math.floor((CELL - 7) / 2),
        mcy * CELL + Math.floor((CELL - 7) / 2),
        '#d9b348',
        '#8a6a1e'
      );
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [layout, fetchFailed, revealDone]);

  // Act two: the real chart is underneath and the same sweep finishes across
  // it, re-anchored on YOUR actual plot cell. Fog beyond the frontier hides
  // the atlas until the wave passes; the overlay then unmounts for good —
  // 5-second re-polls never restart the reveal.
  useEffect(() => {
    if (!atlas || !layout || revealDone) return;
    const canvas = revealRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = layout.w;
    canvas.height = layout.h;
    const meCell = layout.project(atlas.me.x, atlas.me.y);
    let maxRing = REVEAL_STAGGER + 1;
    for (const [ccx, ccy] of [[0, 0], [layout.cols - 1, 0], [0, layout.rows - 1], [layout.cols - 1, layout.rows - 1]]) {
      maxRing = Math.max(maxRing, Math.abs(ccx - meCell.cx) + Math.abs(ccy - meCell.cy) + REVEAL_STAGGER + 1);
    }
    let raf = 0;
    const draw = () => {
      const now = performance.now();
      if (revealT0.current === null) revealT0.current = now;
      if (overlayStart.current === null) {
        // Resume from wherever the dataless sweep had reached; never restart.
        const from = Math.min(REVEAL_HOLD, ((now - revealT0.current) / REVEAL_PLACEHOLDER_MS) * REVEAL_HOLD);
        overlayStart.current = { at: now, from };
      }
      const { at, from } = overlayStart.current;
      const fraction = Math.min(1, from + ((now - at) / REVEAL_COMPLETE_MS) * (1 - from));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (fraction >= 1) {
        setRevealDone(true);
        return;
      }
      raf = requestAnimationFrame(draw);
      const ringFloat = fraction * maxRing;
      for (let cy = 0; cy < layout.rows; cy++) {
        for (let cx = 0; cx < layout.cols; cx++) {
          const ring = Math.abs(cx - meCell.cx) + Math.abs(cy - meCell.cy) + (cellHash(cx, cy) % (REVEAL_STAGGER + 1));
          if (ring > ringFloat) {
            paintFogCell(ctx, cx, cy);
          } else if (ringFloat - ring < 1) {
            ctx.fillStyle = FRONTIER_TINT;
            ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
          }
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [atlas, layout, revealDone]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!atlas || !layout) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const lx = (e.clientX - rect.left) / (rect.width / layout.w);
    const ly = (e.clientY - rect.top) / (rect.height / layout.h);
    const cx = Math.floor(lx / CELL);
    const cy = Math.floor(ly / CELL);
    setHover(atlas.players.find(p => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
      const projected = layout.project(p.x, p.y);
      return projected.cx === cx && projected.cy === cy;
    }) ?? null);
  };

  return (
    <div className="modal-overlay" onClick={() => { soundSystem.play('uiClose'); onClose(); }}>
      <div className="atlas-modal" onClick={e => e.stopPropagation()}>
        <div className="atlas-title">
          <span className="sym sym-castle small" />
          <span>WORLD ATLAS</span>
          <span className="atlas-count">
            {atlas
              ? `${atlas.players.length}${atlas.truncated ? '+' : ''} nearby villages`
              : fetchFailed ? 'chart lost — retrying…' : 'charting…'}
          </span>
          <button className="pxf-close" onClick={() => { soundSystem.play('uiClose'); onClose(); }} aria-label="Close">
            <span className="sym sym-close small" />
          </button>
        </div>
        <div className="atlas-chart-wrap">
          {!layout && fetchFailed && (
            <div className="theatre-empty">The atlas could not be charted. It will retry shortly.</div>
          )}
          {!layout && !fetchFailed && (
            <canvas
              ref={placeholderRef}
              className="atlas-chart atlas-reveal-placeholder"
              style={{ width: REVEAL_COLS * CELL * SCALE, height: REVEAL_ROWS * CELL * SCALE }}
            />
          )}
          {layout && (
            <div className="atlas-stack" style={{ width: layout.w * SCALE, height: layout.h * SCALE }}>
              <canvas
                ref={canvasRef}
                className="atlas-chart"
                style={{ width: layout.w * SCALE, height: layout.h * SCALE }}
                onMouseMove={onMove}
                onMouseLeave={() => setHover(null)}
              />
              <canvas
                ref={liveRef}
                className="atlas-chart atlas-live"
                style={{ width: layout.w * SCALE, height: layout.h * SCALE }}
              />
              {!revealDone && (
                <canvas
                  ref={revealRef}
                  className="atlas-chart atlas-reveal"
                  style={{ width: layout.w * SCALE, height: layout.h * SCALE }}
                />
              )}
            </div>
          )}
        </div>
        <div className="atlas-footer">
          {hover ? (
            <span className="atlas-hover">
              {hover.me ? 'YOU — ' : ''}{hover.username}
              <span className="sym sym-trophy small" />{hover.trophies}
              {hover.shielded ? ' · shielded' : ''}
              {hover.underAttack ? ' · UNDER ATTACK' : ''}
            </span>
          ) : (atlas?.battles?.length ?? 0) > 0 ? (
            <span className="atlas-hover">{atlas!.battles!.length} battle{atlas!.battles!.length === 1 ? '' : 's'} raging right now</span>
          ) : (
            <span className="atlas-legend">
              <i className="lg me" /> you
              <i className="lg online" /> chief
              <i className="lg away" /> away
              <i className="lg shield" /> shield
              <i className="lg battle" /> battle
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
