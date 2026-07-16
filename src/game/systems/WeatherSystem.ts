import Phaser from 'phaser';
import { BUILDING_DEFINITIONS, type BuildingType } from '../config/GameDefinitions';
import { hashString } from '../config/Economy';
import { DayNightSystem } from './DayNightSystem';
import { WIND_DIR, setWindBoost, windAtScreen } from './Wind';
import { soundSystem } from './SoundSystem';
import { toLogicalZoom } from '../utils/DisplayResolution';
import { IsoUtils } from '../utils/IsoUtils';
import { PIXEL_CELL, pixelBlob, pixelEllipse, pixelLine, pixelRect } from '../render/PixelDraw';
import { registerPixelSurface } from '../renderers/TextureRenderPolicy';

/**
 * Global weather: a pure function of the shared world clock, so every player
 * on the map stands under the same sky at the same moment — rain in one
 * village is rain in all of them, with zero server state and zero sync
 * traffic (the same trick as the global day/night sun).
 *
 * Rain arrives as showers a few minutes long: the light dims, wind gusts
 * harder, slanted streaks fall wind-aligned, drops splash on the tiles,
 * hearth fires dim under the wet, villagers head indoors — and when it
 * passes, the ground glints for a while where the water sits.
 */

const SLOT_MS = 20 * 60_000; // one weather roll every 20 minutes
const RAIN_CHANCE = 22; // % of slots
const RAMP_MS = 75_000; // ease in/out at slot edges

/** Rain-streak texture height: one canvas px per pixel cell, staircase line. */
const STREAK_CELLS = 20;
/** Baked |dx/dy| slant variants; each frame picks the nearest to the wind's
 *  actual slant (flipping X for leftward wind), so every streak on screen
 *  shares ONE texture and the whole pass renders as a single quad batch. */
const STREAK_SLANTS = [0, 0.15, 0.3, 0.45, 0.6] as const;

/** Rain intensity 0..1 for a given world-clock time. Pure and global. */
export function weatherAt(worldMs: number): number {
    const slot = Math.floor(worldMs / SLOT_MS);
    const roll = (index: number) => hashString(`weather:${index}`) % 100;
    if (roll(slot) >= RAIN_CHANCE) return 0;
    // This slot rains; strength is its own deterministic roll.
    const strength = 0.55 + ((hashString(`storm:${slot}`) % 100) / 100) * 0.45;
    const into = worldMs - slot * SLOT_MS;
    const left = SLOT_MS - into;
    // Ramp at the edges — unless the neighbouring slot also rains (merged shower).
    let envelope = 1;
    if (into < RAMP_MS && roll(slot - 1) >= RAIN_CHANCE) envelope = into / RAMP_MS;
    if (left < RAMP_MS && roll(slot + 1) >= RAIN_CHANCE) envelope = Math.min(envelope, left / RAMP_MS);
    return strength * envelope;
}

/** What a raindrop lands on. 'blocked' = a standing building's footprint. */
export type RainSurface = 'water' | 'bank' | 'grass' | 'blocked';

interface WeatherHost extends Phaser.Scene {
    mode: string;
    mapSize: number;
    /** Neighbour raid fought in place: the rain does not stop for you. */
    battleInPlace?: boolean;
    /** Standing structures — puddles never pool under a building. */
    buildings?: Array<{ gridX: number; gridY: number; health: number; type: string }>;
    /** Ground classifier — splashes read differently on a lake than a lawn. */
    rainSurfaceAt?: (gx: number, gy: number) => RainSurface;
}

interface Splash {
    gx: number;
    gy: number;
    bornAt: number;
    kind: Exclude<RainSurface, 'blocked'>;
    /** Lifetime ms; water ripples outlive a grass tick. */
    life: number;
}

/** Stroked-ellipse ring as whole pixel cells: the perimeter sampled at 24
 *  angle steps, one cell per step, every duplicate cell merged — at small
 *  radii non-adjacent samples revisit a cell, and stamping it twice at
 *  alpha < 1 stacks into dark blotches. */
function pixelRing(g: Phaser.GameObjects.Graphics, cx: number, cy: number, rx: number, ry: number, color: number, alpha: number) {
    if (rx <= 0 || ry <= 0) return;
    const STEPS = 24;
    const seen = new Set<string>();
    for (let k = 0; k < STEPS; k++) {
        const a = (k / STEPS) * Math.PI * 2;
        const ix = Math.floor((cx + Math.cos(a) * rx) / PIXEL_CELL);
        const iy = Math.floor((cy + Math.sin(a) * ry) / PIXEL_CELL);
        const key = `${ix},${iy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pixelRect(g, ix * PIXEL_CELL, iy * PIXEL_CELL, PIXEL_CELL, PIXEL_CELL, color, alpha);
    }
}

/** A sub-cell droplet: exactly one pixel cell at the point. */
function pixelDot(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number, alpha: number) {
    const x0 = Math.floor(x / PIXEL_CELL) * PIXEL_CELL;
    const y0 = Math.floor(y / PIXEL_CELL) * PIXEL_CELL;
    pixelRect(g, x0, y0, PIXEL_CELL, PIXEL_CELL, color, alpha);
}

export class WeatherSystem {
    private readonly scene: WeatherHost;
    /** Screen-space rain pass, drawn over the world (and over the night grade). */
    private readonly rainGfx: Phaser.GameObjects.Graphics;
    /** Ground pass: splash rings and after-rain puddle glints (under buildings' tops). */
    private readonly groundGfx: Phaser.GameObjects.Graphics;
    /** Splashes beyond the live plot. Neighbour postcards render at depths up
     * to ~26k, so depth-6 marks would vanish behind them; this layer sits
     * above every postcard and below the fog cloud bank (28_500). */
    private readonly farGroundGfx: Phaser.GameObjects.Graphics;
    private intensity = 0;
    private shownIntensity = 0;
    private override: number | null = null;
    private splashes: Splash[] = [];
    private lastSplashSlot = -1;
    /** How wet the ground is (rises in rain, dries slowly after). */
    private wetness = 0;
    private raining = false;
    private listeners: Array<(raining: boolean, intensity: number) => void> = [];
    private lastUpdateAt = 0;
    /** Pooled streak sprites: the rain pass stamps a baked staircase texture
     *  per drop instead of walking a pixelLine — the Graphics version
     *  re-recorded ~17k–37k fillRect commands EVERY frame zoomed out. */
    private streakPool: Phaser.GameObjects.Image[] = [];
    private streakVisible = 0;

    constructor(scene: WeatherHost) {
        this.scene = scene;
        this.rainGfx = scene.add.graphics().setDepth(30006);
        this.groundGfx = scene.add.graphics().setDepth(6);
        this.farGroundGfx = scene.add.graphics().setDepth(27_600);
        // Rain streaks, splashes and puddle glints draw through PixelDraw —
        // runtime weather FX built from whole cells on the sprite grid.
    }

    /** Pin the weather for screenshots/tests; null resumes the world clock. */
    setWeatherOverride(intensity: number | null) {
        this.override = intensity;
    }

    onRainChange(listener: (raining: boolean, intensity: number) => void) {
        this.listeners.push(listener);
    }

    isRaining(): boolean {
        return this.raining;
    }

    /** Smooth visible intensity; use this for systems that support partial rain. */
    rainFactor(): number {
        return this.shownIntensity;
    }

    /** Bake the streak slant variants once: 1-canvas-px-per-cell staircase
     *  lines, NEAREST-sampled (registerPixelSurface) so scaling them up to
     *  screen thickness keeps whole chunky cells. */
    private ensureStreakTextures() {
        for (let idx = 0; idx < STREAK_SLANTS.length; idx++) {
            const key = `rain_streak_${idx}`;
            if (this.scene.textures.exists(key)) continue;
            const r = STREAK_SLANTS[idx];
            const w = Math.ceil(r * (STREAK_CELLS - 1)) + 1;
            const canvas = this.scene.textures.createCanvas(key, w, STREAK_CELLS);
            if (!canvas) continue;
            const ctx = canvas.getContext();
            ctx.fillStyle = '#cfe2f2';
            for (let row = 0; row < STREAK_CELLS; row++) {
                ctx.fillRect(Math.min(w - 1, Math.round(r * row)), row, 1, 1);
            }
            canvas.refresh();
            registerPixelSurface(canvas);
        }
    }

    /** Pool accessor; streaks sit just over the storm veil (rainGfx, 30006). */
    private streakAt(i: number): Phaser.GameObjects.Image {
        let img = this.streakPool[i];
        if (!img) {
            img = this.scene.add.image(0, 0, 'rain_streak_0')
                .setOrigin(0, 0)
                .setDepth(30_006.5)
                .setVisible(false);
            this.streakPool[i] = img;
        }
        return img;
    }

    /** Hide pool entries from `from` up (the pool never shrinks mid-shower). */
    private hideStreaks(from: number) {
        for (let i = from; i < this.streakVisible; i++) this.streakPool[i].setVisible(false);
        this.streakVisible = from;
    }

    update(time: number) {
        const worldNow = Date.now() + DayNightSystem.serverOffsetMs;
        const delta = this.lastUpdateAt === 0 ? 16.667 : Math.min(250, Math.max(0, time - this.lastUpdateAt));
        this.lastUpdateAt = time;
        const frameUnits = delta / 16.667;
        this.intensity = this.override ?? weatherAt(worldNow);
        // Cloud-transition battles keep clear skies for readability; a raid
        // fought IN PLACE inherits whatever weather the world is having.
        const target = this.scene.mode === 'HOME' || this.scene.battleInPlace ? this.intensity : 0;
        const blend = 1 - Math.pow(1 - 0.03, frameUnits);
        this.shownIntensity += (target - this.shownIntensity) * blend;
        const it = this.shownIntensity;

        // Wetness accumulates while it rains and dries off afterwards.
        this.wetness = Math.min(1, this.wetness + it * 0.004 * frameUnits);
        if (it < 0.05) this.wetness = Math.max(0, this.wetness - 0.0012 * frameUnits);

        // Flip the shared systems when rain starts/stops.
        const nowRaining = it > 0.12;
        if (nowRaining !== this.raining) {
            this.raining = nowRaining;
            for (const listener of this.listeners) {
                try {
                    listener(nowRaining, it);
                } catch (error) {
                    console.warn('weather listener failed:', error);
                }
            }
        }
        setWindBoost(1 + it * 0.9);
        soundSystem.setRainLevel(it);

        this.rainGfx.clear();
        this.groundGfx.clear();
        this.farGroundGfx.clear();
        if (it < 0.02 && this.wetness < 0.02) {
            this.hideStreaks(0);
            return;
        }

        const cam = this.scene.cameras.main;
        // cam.worldView is only recomputed at preRender — one frame stale
        // during zoomTo tweens, which peels the storm veil off the screen
        // edges on a fast zoom-out. Compute the live view instead.
        const wv = new Phaser.Geom.Rectangle(
            cam.scrollX + (cam.width - cam.width / cam.zoom) * 0.5,
            cam.scrollY + (cam.height - cam.height / cam.zoom) * 0.5,
            cam.width / cam.zoom,
            cam.height / cam.zoom
        );

        // --- storm dim: a cool grey-blue multiply veil over the view ---
        if (it > 0.02) {
            this.rainGfx.setBlendMode(Phaser.BlendModes.MULTIPLY);
            this.rainGfx.fillStyle(0x8fa3b8, 0.28 * it);
            this.rainGfx.fillRect(wv.x - 64, wv.y - 64, wv.width + 128, wv.height + 128);
            this.rainGfx.setBlendMode(Phaser.BlendModes.NORMAL);
        }

        // --- rain streaks: wind-aligned, deterministic per (column, sweep) ---
        // Everything about a streak is calibrated in SCREEN pixels and then
        // divided by the camera zoom, and the streak count scales with the
        // visible area — so rain reads identically fully zoomed in or out
        // (fixed world-px streaks turned sparse and thread-thin at low zoom).
        // Each drop stamps a pooled Image of ONE baked staircase texture (the
        // nearest slant variant for this frame's wind): the whole pass is a
        // single quad batch, where per-cell pixelLines re-recorded tens of
        // thousands of fillRect commands every frame at low zoom. The texel
        // size drop/STREAK_CELLS ≈ 1.3–1.8 SCREEN px at any zoom — the
        // zoom-aware thickness the fixed world-cell lines lost.
        if (it > 0.04) {
            this.ensureStreakTextures();
            const invZoom = 1 / Math.max(0.2, toLogicalZoom(cam.zoom));
            const gust = windAtScreen(wv.centerX, wv.centerY, time);
            const slantX = (WIND_DIR.x * 18 + gust * 14) * (0.7 + it * 0.5) * invZoom;
            const drop = (26 + it * 10) * invZoom;
            const areaFactor = (wv.width * wv.height) / (1280 * 900);
            const count = Math.min(700, Math.floor((50 + it * 90) * areaFactor));
            const sweep = time * (0.55 + it * 0.35) * invZoom; // constant screen-space fall speed
            const cycle = wv.height + drop * 3;
            const streakAlpha = 0.16 + it * 0.2;
            // Nearest baked slant to the wind's dx/dy (invZoom cancels out) —
            // deterministic in (time, intensity), like the old line endpoints.
            const ratio = Math.abs(slantX * 0.35) / drop;
            let variant = 0;
            for (let v = 1; v < STREAK_SLANTS.length; v++) {
                if (Math.abs(STREAK_SLANTS[v] - ratio) < Math.abs(STREAK_SLANTS[variant] - ratio)) variant = v;
            }
            const flip = slantX < 0;
            const texKey = `rain_streak_${variant}`;
            const texW = Math.ceil(STREAK_SLANTS[variant] * (STREAK_CELLS - 1)) + 1;
            const scale = drop / STREAK_CELLS; // world px per texel
            for (let i = 0; i < count; i++) {
                const h = hashString(`drop:${i}`);
                const x = wv.x + ((h % 1000) / 1000) * (wv.width + 80) - 40;
                const fall = ((h >>> 10) % 997) / 997 * cycle;
                const y = wv.y + ((fall + sweep) % cycle) - drop * 1.5;
                const img = this.streakAt(i);
                if (img.texture.key !== texKey) img.setTexture(texKey);
                img.setPosition(flip ? x - (texW - 1) * scale : x, y);
                img.setFlipX(flip);
                img.setScale(scale);
                img.setAlpha(streakAlpha);
                img.setVisible(true);
            }
            this.hideStreaks(count);
        } else {
            this.hideStreaks(0);
        }

        // --- splashes: drops land where the player is LOOKING — the lake next
        // door drinks the same rain as the home lawn — and each landing reads
        // as the surface it hits: ripple + plip on open water, a swallowed mud
        // splat on the bank, the familiar dust ring and flicked beads on grass.
        if (it > 0.1) {
            // Ten deterministic opportunity slots per second. Intensity gates
            // each slot, yielding ~11*intensity splashes/s per screen without
            // per-frame randomness or refresh-rate dependence.
            const currentSlot = Math.floor(worldNow / 90);
            // Consume every still-visible opportunity missed by a slow frame.
            // Bounding the catch-up to a splash lifetime avoids doing work for
            // hours spent in a background tab.
            const firstSlot = this.lastSplashSlot < 0
                ? currentSlot
                : Math.max(this.lastSplashSlot + 1, currentSlot - 5);
            // Grid-space bbox of the view; spawn density scales with visible
            // area (like the streak count) so splash coverage reads the same
            // at any zoom.
            const corners = [
                IsoUtils.isoToCart(wv.x, wv.y),
                IsoUtils.isoToCart(wv.right, wv.y),
                IsoUtils.isoToCart(wv.right, wv.bottom),
                IsoUtils.isoToCart(wv.x, wv.bottom)
            ];
            const minGx = Math.min(...corners.map(c => c.x));
            const maxGx = Math.max(...corners.map(c => c.x));
            const minGy = Math.min(...corners.map(c => c.y));
            const maxGy = Math.max(...corners.map(c => c.y));
            const attempts = Math.max(1, Math.min(6, Math.round((wv.width * wv.height) / (1280 * 900) * 1.5)));
            for (let slot = firstSlot; slot <= currentSlot; slot++) {
                for (let k = 0; k < attempts; k++) {
                    const roll = (hashString(`splash:on:${slot}:${k}`) % 1000) / 1000;
                    if (roll >= it) continue;
                    const hx = hashString(`splash:x:${slot}:${k}`);
                    const hy = hashString(`splash:y:${slot}:${k}`);
                    const gx = minGx + (hx / 0x1_0000_0000) * (maxGx - minGx);
                    const gy = minGy + (hy / 0x1_0000_0000) * (maxGy - minGy);
                    // The grid bbox of an iso view is a diamond's bounding
                    // rect — cull the corner samples that fall off screen.
                    const pos = IsoUtils.cartToIso(gx, gy);
                    if (pos.x < wv.x - 24 || pos.x > wv.right + 24 || pos.y < wv.y - 16 || pos.y > wv.bottom + 16) continue;
                    const surface = this.scene.rainSurfaceAt?.(gx, gy) ?? 'grass';
                    if (surface === 'blocked') continue; // roofs shed rain; no ground ring under a building
                    const slotAge = Math.max(0, worldNow - slot * 90);
                    this.splashes.push({
                        gx,
                        gy,
                        bornAt: time - slotAge,
                        kind: surface,
                        life: surface === 'water' ? 860 : surface === 'bank' ? 560 : 460
                    });
                    if (this.splashes.length > 64) this.splashes.shift();
                }
            }
            this.lastSplashSlot = currentSlot;
        }
        for (let i = this.splashes.length - 1; i >= 0; i--) {
            const splash = this.splashes[i];
            const age = (time - splash.bornAt) / splash.life;
            if (age >= 1) {
                this.splashes.splice(i, 1);
                continue;
            }
            const far = splash.gx < 0 || splash.gy < 0
                || splash.gx >= this.scene.mapSize || splash.gy >= this.scene.mapSize;
            this.drawSplash(far ? this.farGroundGfx : this.groundGfx, splash, age);
        }

        // --- wet ground: sparse puddle glints in tile corners, fading as it dries ---
        if (this.wetness > 0.03) {
            const glow = this.wetness * (0.5 + 0.5 * Math.sin(time * 0.0011));
            for (let i = 0; i < 30; i++) {
                const h = hashString(`puddle:${i}`);
                const gx = 1 + (h % 997) / 997 * (this.scene.mapSize - 2);
                const gy = 1 + ((h >>> 11) % 997) / 997 * (this.scene.mapSize - 2);
                const pos = IsoUtils.cartToIso(gx, gy);
                if (pos.x < wv.x - 40 || pos.x > wv.right + 40 || pos.y < wv.y - 40 || pos.y > wv.bottom + 40) continue;
                const w = 5 + (h % 5) * 2;
                pixelEllipse(this.groundGfx, pos.x, pos.y, w * 0.5, w * 0.21, 0xbcd9ee, 0.10 * glow + 0.05 * this.wetness);
            }
        }

        // --- puddles proper: the low hollows of the lawn pool up as the
        // ground soaks, hold a shimmering piece of sky, ripple under the
        // falling rain, and dry back out lowest-last. Every shape is ONE
        // closed wobbled path at uniform alpha (no overlapped ellipses to
        // double-darken), deterministic per (spot, time).
        if (this.wetness > 0.08) {
            const m = this.scene.mapSize;
            // Tiles under standing buildings can't pool.
            const occupied = new Set<number>();
            for (const b of this.scene.buildings ?? []) {
                if (b.health <= 0) continue;
                const info = BUILDING_DEFINITIONS[b.type as BuildingType];
                if (!info) continue;
                for (let dy = 0; dy < info.height; dy++) {
                    for (let dx = 0; dx < info.width; dx++) {
                        occupied.add((b.gridY + dy) * m + b.gridX + dx);
                    }
                }
            }
            // Cell-scanline blob: the hollow keeps an irregular rim, but the
            // rim is whole pixel cells (pixelBlob's per-row wobble).
            const blob = (cx: number, cy: number, w: number, seed: number, color: number, alpha: number) => {
                pixelBlob(this.groundGfx, cx, cy, w, w * 0.42, 0.2, seed % 97, color, alpha);
            };
            const shimmer = 0.5 + 0.5 * Math.sin(time * 0.0011);
            const PUDDLES = 14;
            for (let i = 0; i < PUDDLES; i++) {
                const h = hashString(`pool:${i}`);
                const gx = 1.5 + (h % 997) / 997 * (m - 3);
                const gy = 1.5 + ((h >>> 11) % 997) / 997 * (m - 3);
                // Footprint test the puddle's EXTENT, not just its centre
                // tile: a full pool is ~2×w iso px wide and used to poke out
                // from under building edges. Reach is computed at FULL size
                // (stage 1) so a pool never appears and then vanishes as it
                // grows into a wall. rim = rim blob (w + 2.6) × wobble
                // margin; the grid-space reach of that iso ellipse is the
                // same along both grid axes.
                const wFull = 11 + (h % 7) * 2.6;
                const rimX = (wFull + 2.6) * 1.3;
                const rimY = rimX * 0.42;
                const reach = Math.sqrt((rimX / 64) ** 2 + (rimY / 32) ** 2);
                let underBuilding = false;
                for (let ty = Math.floor(gy - reach); ty <= Math.floor(gy + reach) && !underBuilding; ty++) {
                    for (let tx = Math.floor(gx - reach); tx <= Math.floor(gx + reach); tx++) {
                        if (occupied.has(ty * m + tx)) { underBuilding = true; break; }
                    }
                }
                if (underBuilding) continue;
                // Each hollow fills at its own depth — the lowest pools first
                // and is the last to dry.
                const threshold = (i / PUDDLES) * 0.6;
                const fill = (this.wetness - threshold) / (1 - threshold);
                if (fill <= 0) continue;
                const stage = Math.min(1, fill * 1.5);
                const pos = IsoUtils.cartToIso(gx, gy);
                if (pos.x < wv.x - 60 || pos.x > wv.right + 60 || pos.y < wv.y - 40 || pos.y > wv.bottom + 40) continue;
                const w = wFull * (0.35 + 0.65 * stage);
                // Soaked-earth rim, then the water, then the piece of sky.
                blob(pos.x, pos.y, w + 2.6, h, 0x2a3424, 0.20 * stage);
                blob(pos.x, pos.y, w, h, 0x9fc2dc, (0.30 + 0.10 * shimmer) * stage);
                pixelEllipse(this.groundGfx, pos.x - w * 0.16, pos.y - w * 0.05, w * 0.22, w * 0.065, 0xe8f4ff, (0.10 + 0.15 * shimmer) * stage);
                // While the rain falls, rings ripple across the pool.
                if (it > 0.1) {
                    const beat = 900 + (h % 5) * 260;
                    const rp = ((time + (h % 1000)) % beat) / beat;
                    const rr = 1.5 + rp * w * 0.42;
                    const ox = (((h >>> 7) % 5) - 2) * w * 0.08;
                    const oy = (((h >>> 9) % 3) - 1) * w * 0.05;
                    pixelRing(this.groundGfx, pos.x + ox, pos.y + oy, rr, rr * 0.5, 0xe4f2ff, 0.38 * (1 - rp) * stage);
                }
            }
        }
    }

    /** One landing, drawn for its surface. All geometry iso-squashed 2:1. */
    private drawSplash(g: Phaser.GameObjects.Graphics, splash: Splash, age: number) {
        const pos = IsoUtils.cartToIso(splash.gx, splash.gy);
        if (splash.kind === 'water') {
            // Rain on open water: a ripple pair marching outward and a plip —
            // the droplet crown thrown straight back up off the surface.
            const r1 = 2 + age * 11;
            pixelRing(g, pos.x, pos.y, r1, r1 * 0.5, 0xdff2ff, 0.5 * (1 - age));
            if (age > 0.3) {
                const r2 = 2 + (age - 0.3) * 11;
                pixelRing(g, pos.x, pos.y, r2, r2 * 0.5, 0xbfe2f6, 0.34 * (1 - age));
            }
            if (age < 0.32) {
                const t = age / 0.32;
                const lift = 2 + t * 5.5;
                pixelLine(g, pos.x, pos.y - 1, pos.x, pos.y - lift + 1, 1, 0xdff2ff, 0.4 * (1 - t));
                pixelDot(g, pos.x, pos.y - lift, 0xf2fbff, 0.8 * (1 - t));
            }
        } else if (splash.kind === 'bank') {
            // Damp shore mud swallows the ring: a dark splat, two heavy flecks.
            const w = 3.5 + age * 4;
            pixelEllipse(g, pos.x, pos.y, w, w * 0.5, 0x33281c, 0.22 * (1 - age));
            const t = Math.min(1, age * 1.6);
            const arc = Math.sin(t * Math.PI);
            pixelDot(g, pos.x - 2 - t * 3, pos.y - arc * 3, 0x7a5f41, 0.5 * (1 - t));
            pixelDot(g, pos.x + 1.5 + t * 3.5, pos.y - arc * 2.4, 0x7a5f41, 0.5 * (1 - t));
        } else {
            // Grass: the familiar soft ring plus two beads flicked off blades.
            const r = 1.5 + age * 5;
            pixelRing(g, pos.x, pos.y, r, r * 0.5, 0xd8ecff, 0.35 * (1 - age));
            if (age < 0.55) {
                const t = age / 0.55;
                const arc = Math.sin(t * Math.PI);
                const dx = 1.5 + t * 2.5;
                pixelDot(g, pos.x - dx, pos.y - arc * 3.4, 0xe8f4ff, 0.5 * (1 - t));
                pixelDot(g, pos.x + dx * 0.8, pos.y - arc * 2.6, 0xe8f4ff, 0.5 * (1 - t));
            }
        }
    }

    destroy() {
        this.rainGfx.destroy();
        this.groundGfx.destroy();
        this.farGroundGfx.destroy();
        for (const img of this.streakPool) img.destroy();
        this.streakPool = [];
        this.streakVisible = 0;
        setWindBoost(1);
        soundSystem.setRainLevel(0);
        this.listeners = [];
        this.splashes = [];
    }
}
