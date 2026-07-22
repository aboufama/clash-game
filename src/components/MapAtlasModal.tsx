import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Backend } from '../game/backend/GameBackend';
import { soundSystem } from '../game/systems/SoundSystem';
import {
  HYDROLOGY_PLOT_PITCH,
  queryWorldHydrology,
  type GreatLakeFeature
} from '../game/config/WorldHydrology';
import { buildVariableWidthRibbon } from '../game/renderers/WorldHydrologyRenderer';
import { WildernessRenderer } from '../game/renderers/WildernessRenderer';
import { weatherAt } from '../game/systems/WeatherSystem';
import { DayNightSystem } from '../game/systems/DayNightSystem';
import { isWildernessPreserveAt } from '../game/config/Economy';

interface AtlasPlayer {
  id: string;
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
  /** The watchtower's default-sight radius in plots (0-2); 0 with no watchtower. */
  sight: number;
  /** The world's coordinate bound: plots span ±worldPlotLimit on both axes. */
  worldPlotLimit: number;
  /** Server-owned generated-land epoch used to label protected coordinates. */
  seedVersion: number;
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
// One cell per plot for the whole ±24 world square (49 + the margin ring);
// bigger spans (legacy outliers) fall back to bucketing.
const MAX_COLS = 51;
const MAX_ROWS = 51;

// ---- the charting reveal ----
// While the chart loads (and briefly after it lands) the atlas is covered by
// fog-of-war tiles in the pxf panel's wood tones, melting outward from the
// player's own keep in diamond (Manhattan) rings. Deterministic f(time): one
// clock per open, per-cell stagger from the cell hash — never Math.random.
const REVEAL_STAGGER = 2;           // extra per-cell delay in rings, from the cell hash
const REVEAL_COMPLETE_MS = 900;     // hold line -> fully charted once data lands
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

// ---- the watchtower sight ring ----
// The atlas charts a wide window, but a chief only sees this much of it
// "for free" (no scouting) — the watchtower's own radius. A thin gold
// outline traces that square around the player's keep, and a small pip
// perched on the keep marks the tower that projects it.
const SIGHT_LINE = '#e0b84a';

function drawSightBoundary(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.fillStyle = SIGHT_LINE;
  ctx.fillRect(x0, y0, x1 - x0, 1);
  ctx.fillRect(x0, y1 - 1, x1 - x0, 1);
  ctx.fillRect(x0, y0, 1, y1 - y0);
  ctx.fillRect(x1 - 1, y0, 1, y1 - y0);
}

/** A tiny flagged mast above the keep glyph, marking the watchtower itself.
 *  Occupies columns px+3..px+5 — clear of the battle badge (px+6..px+8) and
 *  above the shield arc's rows, so all three can coexist on one keep. */
function drawWatchtowerPip(ctx: CanvasRenderingContext2D, px: number, py: number) {
  ctx.fillStyle = '#5c4033';
  ctx.fillRect(px + 3, py - 4, 1, 2);
  ctx.fillStyle = SIGHT_LINE;
  ctx.fillRect(px + 4, py - 5, 2, 1);
  ctx.fillRect(px + 4, py - 4, 1, 1);
}

/** Coarse weather label for the top bar: a pure function of the shared world clock. */
function currentWeatherLabel(): string {
  const worldNow = Date.now() + DayNightSystem.serverOffsetMs;
  const intensity = weatherAt(worldNow);
  if (intensity <= 0) return 'Clear';
  return intensity < 0.75 ? 'Rain' : 'Storm';
}

type HoverInfo =
  | { kind: 'village'; player: AtlasPlayer }
  | { kind: 'cluster'; players: AtlasPlayer[] }
  | { kind: 'plot'; x: number; y: number; label: string };

type AtlasPlotSelection = {
  x: number;
  y: number;
  label: string;
  settleable: boolean;
};

type AtlasPlayerCluster = {
  cx: number;
  cy: number;
  players: AtlasPlayer[];
};

interface MapAtlasModalProps {
  onClose: () => void;
  onViewPlayer: (player: AtlasPlayer, canAttack: boolean) => void;
  onSettlePlot: (x: number, y: number) => Promise<boolean>;
}

export function MapAtlasModal({ onClose, onViewPlayer, onSettlePlot }: MapAtlasModalProps) {
  const [atlas, setAtlas] = useState<AtlasData | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedPlot, setSelectedPlot] = useState<AtlasPlotSelection | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<AtlasPlayerCluster | null>(null);
  const [settlingPlot, setSettlingPlot] = useState(false);
  const [settlementFailed, setSettlementFailed] = useState(false);
  const [keyboardCell, setKeyboardCell] = useState<{ cx: number; cy: number } | null>(null);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState('');
  const [revealDone, setRevealDone] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<HTMLCanvasElement>(null);
  const settleButtonRef = useRef<HTMLButtonElement>(null);
  const clusterFirstButtonRef = useRef<HTMLButtonElement>(null);
  const focusSelectionAfterRender = useRef<'plot' | 'cluster' | null>(null);
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
    // It's a WORLD atlas: always frame the whole ±worldPlotLimit square,
    // grown further only by legacy outlier plots beyond it.
    const worldRadius = Number.isFinite(atlas.worldPlotLimit) && atlas.worldPlotLimit > 0
      ? Math.trunc(atlas.worldPlotLimit)
      : 24;
    minX = Math.min(minX, -worldRadius);
    maxX = Math.max(maxX, worldRadius);
    minY = Math.min(minY, -worldRadius);
    maxY = Math.max(maxY, worldRadius);
    const spanX = Math.max(1, maxX - minX + 1);
    const spanY = Math.max(1, maxY - minY + 1);
    const bucket = Math.max(1, Math.ceil(spanX / (MAX_COLS - 2)), Math.ceil(spanY / (MAX_ROWS - 2)));
    const cols = Math.min(MAX_COLS, Math.ceil(spanX / bucket) + 2);
    const rows = Math.min(MAX_ROWS, Math.ceil(spanY / bucket) + 2);
    const project = (x: number, y: number) => ({
      cx: Math.max(1, Math.min(cols - 2, Math.floor((Math.trunc(x) - minX) / bucket) + 1)),
      cy: Math.max(1, Math.min(rows - 2, Math.floor((Math.trunc(y) - minY) / bucket) + 1))
    });
    return { minX, maxX, minY, maxY, bucket, cols, rows, w: cols * CELL, h: rows * CELL, project };
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
          }, atlas.seedVersion)) features.set(feature.id, feature);
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
        const plotX = Math.max(layout.minX, Math.min(
          layout.maxX,
          layout.minX + (cx - 1) * layout.bucket + centerOffset
        ));
        const plotY = Math.max(layout.minY, Math.min(
          layout.maxY,
          layout.minY + (cy - 1) * layout.bucket + centerOffset
        ));
        if (hydrologyPlots.has(`${plotX},${plotY}`)) continue;
        const nature = WildernessRenderer.natureAt(plotX, plotY, atlas.seedVersion);
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

    // The watchtower's default-sight square, centered on the player's plot.
    if (atlas.sight > 0) {
      const tl = layout.project(atlas.me.x - atlas.sight, atlas.me.y - atlas.sight);
      const br = layout.project(atlas.me.x + atlas.sight, atlas.me.y + atlas.sight);
      drawSightBoundary(ctx, tl.cx * CELL, tl.cy * CELL, (br.cx + 1) * CELL, (br.cy + 1) * CELL);
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
      if (p.me && atlas.sight > 0) drawWatchtowerPip(ctx, px, py);
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

  // Open CENTERED on your keep (owner rule 2026-07-20): the chart can be
  // larger than the viewport and the default (0,0) scroll could start with
  // your village off screen entirely. Scrolling away afterwards is free.
  const centeredRef = useRef(false);
  useEffect(() => {
    if (!atlas || !layout || centeredRef.current) return;
    const wrap = chartWrapRef.current;
    if (!wrap) return;
    const meCell = layout.project(atlas.me.x, atlas.me.y);
    const px = (meCell.cx + 0.5) * CELL * SCALE;
    const py = (meCell.cy + 0.5) * CELL * SCALE;
    wrap.scrollLeft = Math.max(0, px - wrap.clientWidth / 2);
    wrap.scrollTop = Math.max(0, py - wrap.clientHeight / 2);
    centeredRef.current = true;
  }, [atlas, layout]);

  // No loading placeholder (owner fix 2026-07-20): the old small fog canvas
  // that painted before data arrived read as a vestigial double load. The
  // title says "charting…", the wrap stays bare, and the ONLY window that
  // ever mounts is the full-size chart — born fully fogged, then swept open.

  // The reveal: the real chart is underneath and the fog sweep melts across
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
      if (overlayStart.current === null) {
        // The whole sweep runs on the REAL chart, ring zero at your keep —
        // act one holds static fog, so there is no placeholder clock to
        // resume and no mid-sweep re-anchor stutter.
        overlayStart.current = { at: now, from: 0 };
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

  const cellIsInsideChart = (cx: number, cy: number) => Boolean(layout)
    && cx > 0 && cy > 0 && cx < layout!.cols - 1 && cy < layout!.rows - 1;

  const playersAtCell = (cx: number, cy: number): AtlasPlayer[] => {
    if (!atlas || !layout) return [];
    return atlas.players
      .filter(player => {
        if (!Number.isFinite(player.x) || !Number.isFinite(player.y)) return false;
        const projected = layout.project(player.x, player.y);
        return projected.cx === cx && projected.cy === cy;
      })
      .sort((left, right) => (
        left.y - right.y
        || left.x - right.x
        || left.username.localeCompare(right.username)
        || left.id.localeCompare(right.id)
      ));
  };

  /** Resolve a bucket to a real coordinate inside its (possibly partial) edge. */
  const plotAtCell = (cx: number, cy: number): AtlasPlotSelection | null => {
    if (!atlas || !layout || !cellIsInsideChart(cx, cy)) return null;
    const bucketMinX = Math.max(layout.minX, layout.minX + (cx - 1) * layout.bucket);
    const bucketMaxX = Math.min(layout.maxX, bucketMinX + layout.bucket - 1);
    const bucketMinY = Math.max(layout.minY, layout.minY + (cy - 1) * layout.bucket);
    const bucketMaxY = Math.min(layout.maxY, bucketMinY + layout.bucket - 1);
    const x = Math.floor((bucketMinX + bucketMaxX) / 2);
    const y = Math.floor((bucketMinY + bucketMaxY) / 2);
    const nature = WildernessRenderer.natureAt(x, y, atlas.seedVersion);
    return {
      x,
      y,
      label: nature.label,
      settleable: !isWildernessPreserveAt(x, y, atlas.seedVersion)
    };
  };

  const describeCell = (cx: number, cy: number): string => {
    const players = playersAtCell(cx, cy);
    if (players.length === 1) {
      const player = players[0];
      return `${player.me ? 'Your village' : player.username}, plot ${player.x}, ${player.y}. Press Enter to ${player.me ? 'close the Atlas' : 'view'}.`;
    }
    if (players.length > 1) {
      return `${players.length} villages share this chart square. Press Enter to choose a chief.`;
    }
    const plot = plotAtCell(cx, cy);
    if (!plot) return 'Chart margin.';
    return `${plot.label}, plot ${plot.x}, ${plot.y}. Press Enter to select this land.`;
  };

  const viewPlayer = (selected: AtlasPlayer) => {
    if (!atlas) return;
    const village = atlas.players.find(player => player.id && player.id === selected.id) ?? selected;
    setSelectedPlot(null);
    setSelectedCluster(null);
    setSettlementFailed(false);
    if (village.me) {
      soundSystem.play('uiClose');
      onClose();
      return;
    }
    if (!village.id) return; // old/server-drift payload: keep the row read-only
    const withinSight = Math.max(
      Math.abs(village.x - atlas.me.x),
      Math.abs(village.y - atlas.me.y)
    ) <= atlas.sight;
    soundSystem.play('confirm');
    onClose();
    onViewPlayer(village, withinSight && !village.shielded && !village.underAttack);
  };

  const activateCell = (cx: number, cy: number, source: 'pointer' | 'keyboard') => {
    if (!atlas || !layout || settlingPlot || !cellIsInsideChart(cx, cy)) {
      setHover(null);
      return;
    }
    const players = playersAtCell(cx, cy);
    if (players.length === 1) {
      viewPlayer(players[0]);
      return;
    }
    if (players.length > 1) {
      setSelectedPlot(null);
      setSelectedCluster({ cx, cy, players });
      setSettlementFailed(false);
      setKeyboardAnnouncement(`${players.length} villages available. Tab through the chief buttons to choose one.`);
      if (source === 'keyboard') focusSelectionAfterRender.current = 'cluster';
      return;
    }
    const plot = plotAtCell(cx, cy);
    if (!plot) return;
    setSelectedCluster(null);
    setSelectedPlot(plot);
    setSettlementFailed(false);
    setKeyboardAnnouncement(`${plot.label}, plot ${plot.x}, ${plot.y}, selected. ${plot.settleable ? 'The Settle Here button is ready.' : 'This plot is protected.'}`);
    if (source === 'keyboard') focusSelectionAfterRender.current = 'plot';
  };

  useEffect(() => {
    if (!atlas || !layout) return;
    const me = layout.project(atlas.me.x, atlas.me.y);
    setKeyboardCell(current => ({
      cx: Math.max(1, Math.min(layout.cols - 2, current?.cx ?? me.cx)),
      cy: Math.max(1, Math.min(layout.rows - 2, current?.cy ?? me.cy))
    }));
  }, [atlas, layout]);

  useEffect(() => {
    if (focusSelectionAfterRender.current === 'plot' && selectedPlot) {
      settleButtonRef.current?.focus();
      focusSelectionAfterRender.current = null;
    } else if (focusSelectionAfterRender.current === 'cluster' && selectedCluster) {
      clusterFirstButtonRef.current?.focus();
      focusSelectionAfterRender.current = null;
    }
  }, [selectedCluster, selectedPlot]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!atlas || !layout) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const lx = (e.clientX - rect.left) / (rect.width / layout.w);
    const ly = (e.clientY - rect.top) / (rect.height / layout.h);
    const cx = Math.floor(lx / CELL);
    const cy = Math.floor(ly / CELL);
    setHoverPos({ x: e.clientX, y: e.clientY });
    // The outer ring is a reserved margin — layout.project never places a
    // village or resolves a plot there.
    if (!cellIsInsideChart(cx, cy)) {
      setHover(null);
      return;
    }
    const players = playersAtCell(cx, cy);
    if (players.length === 1) {
      setHover({ kind: 'village', player: players[0] });
      return;
    }
    if (players.length > 1) {
      setHover({ kind: 'cluster', players });
      return;
    }
    // Hover speaks only for populated villages (owner rule 2026-07-19);
    // open land identifies its archetype on CLICK via activateCell.
    if (hover?.kind !== 'plot') setHover(null);
  };

  const onChartClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!atlas || !layout || settlingPlot) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const lx = (e.clientX - rect.left) / (rect.width / layout.w);
    const ly = (e.clientY - rect.top) / (rect.height / layout.h);
    const cx = Math.floor(lx / CELL);
    const cy = Math.floor(ly / CELL);
    setHoverPos({ x: e.clientX, y: e.clientY });
    activateCell(cx, cy, 'pointer');
    const players = playersAtCell(cx, cy);
    if (players.length > 1) setHover({ kind: 'cluster', players });
    else if (players.length === 0) {
      const plot = plotAtCell(cx, cy);
      if (plot) setHover({ kind: 'plot', x: plot.x, y: plot.y, label: plot.label });
    }
  };

  const onChartKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!atlas || !layout || settlingPlot) return;
    const me = layout.project(atlas.me.x, atlas.me.y);
    const current = keyboardCell ?? me;
    let next = current;
    if (e.key === 'ArrowLeft') next = { ...current, cx: Math.max(1, current.cx - 1) };
    else if (e.key === 'ArrowRight') next = { ...current, cx: Math.min(layout.cols - 2, current.cx + 1) };
    else if (e.key === 'ArrowUp') next = { ...current, cy: Math.max(1, current.cy - 1) };
    else if (e.key === 'ArrowDown') next = { ...current, cy: Math.min(layout.rows - 2, current.cy + 1) };
    else if (e.key === 'Home') next = me;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateCell(current.cx, current.cy, 'keyboard');
      return;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      soundSystem.play('uiClose');
      onClose();
      return;
    } else return;
    e.preventDefault();
    setKeyboardCell(next);
    setKeyboardAnnouncement(describeCell(next.cx, next.cy));
  };

  const settleSelectedPlot = async () => {
    if (!selectedPlot?.settleable || settlingPlot) return;
    setSettlingPlot(true);
    setSettlementFailed(false);
    try {
      const settled = await onSettlePlot(selectedPlot.x, selectedPlot.y);
      if (settled) onClose();
      else setSettlementFailed(true);
    } finally {
      setSettlingPlot(false);
    }
  };

  // The WHOLE world's plot count: the main server spans ±worldPlotLimit on
  // both axes — (2·24 + 1)² = 2,401 plots at today's single-server bound.
  const totalPlots = atlas ? (2 * atlas.worldPlotLimit + 1) ** 2 : 0;

  return (
    <div className="modal-overlay" onClick={() => {
      if (settlingPlot) return;
      soundSystem.play('uiClose');
      onClose();
    }}>
      <div
        className="atlas-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="atlas-title-label"
        aria-busy={settlingPlot}
        onClick={e => e.stopPropagation()}
      >
        <div className="atlas-title">
          <span className="sym sym-castle small" />
          <span id="atlas-title-label">WORLD ATLAS</span>
          <span className="atlas-stats">
            {atlas ? (
              <>
                <span className="atlas-stat">{atlas.me.x}, {atlas.me.y}</span>
                <span className="atlas-stat">{totalPlots.toLocaleString()} plots</span>
                <span className="atlas-stat">{currentWeatherLabel()}</span>
              </>
            ) : (
              <span className="atlas-stat">{fetchFailed ? 'chart lost — retrying…' : 'charting…'}</span>
            )}
          </span>
          <button
            type="button"
            className="pxf-close"
            disabled={settlingPlot}
            onClick={() => { soundSystem.play('uiClose'); onClose(); }}
            aria-label="Close"
          >
            <span className="sym sym-close small" />
          </button>
        </div>
        <span id="atlas-keyboard-help" className="atlas-sr-only">
          Use the arrow keys to move one chart square, Home to return to your village, Enter or Space to choose, and Escape to close.
        </span>
        <span className="atlas-sr-only" aria-live="polite" aria-atomic="true">{keyboardAnnouncement}</span>
        <div className="atlas-chart-wrap" ref={chartWrapRef}>
          {!layout && fetchFailed && (
            <div className="theatre-empty">The atlas could not be charted. It will retry shortly.</div>
          )}
          {layout && (
            <div className="atlas-stack" style={{ width: layout.w * SCALE, height: layout.h * SCALE }}>
              <canvas
                ref={canvasRef}
                className="atlas-chart"
                style={{ width: layout.w * SCALE, height: layout.h * SCALE }}
                tabIndex={0}
                role="application"
                aria-label="Interactive world Atlas"
                aria-describedby="atlas-keyboard-help"
                aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home Enter Space Escape"
                onMouseMove={onMove}
                onClick={onChartClick}
                onKeyDown={onChartKeyDown}
                onFocus={() => {
                  setKeyboardFocused(true);
                  const cell = keyboardCell ?? layout.project(atlas!.me.x, atlas!.me.y);
                  setKeyboardCell(cell);
                  setKeyboardAnnouncement(describeCell(cell.cx, cell.cy));
                }}
                onBlur={() => setKeyboardFocused(false)}
                onMouseLeave={() => { setHover(null); setHoverPos(null); }}
              >
                Interactive world Atlas. Use the keyboard instructions above or click a chart square.
              </canvas>
              <canvas
                ref={liveRef}
                className="atlas-chart atlas-live"
                style={{ width: layout.w * SCALE, height: layout.h * SCALE }}
                aria-hidden="true"
              />
              {!revealDone && (
                <canvas
                  ref={revealRef}
                  className="atlas-chart atlas-reveal"
                  style={{ width: layout.w * SCALE, height: layout.h * SCALE }}
                  aria-hidden="true"
                />
              )}
              {keyboardFocused && keyboardCell && (
                <div
                  className="atlas-keyboard-cursor"
                  aria-hidden="true"
                  style={{
                    left: keyboardCell.cx * CELL * SCALE,
                    top: keyboardCell.cy * CELL * SCALE,
                    width: CELL * SCALE,
                    height: CELL * SCALE
                  }}
                />
              )}
            </div>
          )}
        </div>
        <div className="atlas-footer">
          {selectedCluster ? (
            <div
              className="atlas-cluster-selection"
              role="group"
              aria-label={`${selectedCluster.players.length} villages in this chart square`}
              data-chart-cell={`${selectedCluster.cx},${selectedCluster.cy}`}
            >
              <span className="atlas-hover">{selectedCluster.players.length} villages here · choose a chief</span>
              <div className="atlas-cluster-actions">
                {selectedCluster.players.map((player, index) => (
                  <button
                    key={player.id || `${player.x},${player.y},${player.username}`}
                    ref={index === 0 ? clusterFirstButtonRef : undefined}
                    type="button"
                    className="atlas-cluster-btn"
                    disabled={!player.id && !player.me}
                    onClick={() => viewPlayer(player)}
                    aria-label={`${player.me ? 'Your village' : `View ${player.username}`} at plot ${player.x}, ${player.y}`}
                  >
                    {player.me ? 'YOU' : player.username} · {player.x},{player.y}
                  </button>
                ))}
              </div>
            </div>
          ) : selectedPlot ? (
            <div className="atlas-plot-selection" data-plot-x={selectedPlot.x} data-plot-y={selectedPlot.y}>
              <span className="atlas-hover">
                {selectedPlot.label} · plot {selectedPlot.x}, {selectedPlot.y}
                {settlementFailed ? ' · claim failed—the land may have changed' : ''}
              </span>
              <button
                ref={settleButtonRef}
                type="button"
                className="atlas-settle-btn"
                disabled={!selectedPlot.settleable || settlingPlot}
                onClick={() => { soundSystem.play('confirm'); void settleSelectedPlot(); }}
              >
                <span className="sym sym-home small" />
                {!selectedPlot.settleable ? 'PROTECTED' : settlingPlot ? 'SETTLING…' : 'SETTLE HERE'}
              </button>
            </div>
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
      {hover && hoverPos && (
        // Same shared pxf tooltip chrome as the raid-menu troop cards —
        // floats above the cursor point with the tail aiming back at it.
        <div
          className="pxf-tooltip atlas-tooltip"
          style={{ left: hoverPos.x, top: hoverPos.y - 6 }}
        >
          {hover.kind === 'village' ? (
            <>
              {hover.player.me ? 'YOU — ' : ''}{hover.player.username}
              <span className="sym sym-trophy small" /> {hover.player.trophies}
              {hover.player.shielded ? ' · shielded' : ''}
              {hover.player.underAttack ? ' · UNDER ATTACK' : ''}
              {!hover.player.me ? ' · click to view' : ''}
            </>
          ) : hover.kind === 'cluster' ? (
            <>{hover.players.length} villages · click to choose a chief</>
          ) : (
            <>{hover.label} · plot {hover.x}, {hover.y} · click to settle</>
          )}
        </div>
      )}
    </div>
  );
}
