import Phaser from 'phaser';
import { BUILDING_DEFINITIONS, type BuildingType } from '../config/GameDefinitions';
import type { PlacedBuilding } from '../types/GameTypes';
import { IsoUtils } from '../utils/IsoUtils';
import { pixelEllipse, pixelRect } from '../render/PixelDraw';

/**
 * Day/night cycle — the village's mood lighting.
 *
 * One full day lasts DAY_LENGTH_MS of real time, anchored to the wall clock so
 * it keeps turning between sessions. Two layers:
 *
 *   1. A MULTIPLY color grade over the whole scene (golden hour, blazing
 *      sunset, violet dusk, deep night, rose dawn). It is drawn in WORLD
 *      space, stretched over the camera's worldView every frame — camera zoom
 *      and pans can never shrink it or slide it around. No moon, no stars,
 *      no horizon bands: we are looking straight down at the ground, so the
 *      only sky we ever see is the light it throws on the village.
 *
 *   2. Dynamic building light rigs. Every lit building gets a small rig of
 *      additive sprites: a squashed pool hugging the iso ground, a hot core
 *      at the actual emitter (hearth, door, crystal, coil...), and for the
 *      big sources a vertical volumetric shaft. Each rig animates by source
 *      kind — fire flickers on stacked sine harmonics and physically wobbles,
 *      energy breathes and crossfades between two hues (tesla surges),
 *      molten pulses slow and deep, lamps just tremble slightly. All motion
 *      is a deterministic function of time (house rule: no per-frame random).
 *
 * Active in HOME only — raids and replays fade back to clean daylight so
 * combat stays readable. `setPhaseOverride` pins the clock for screenshots,
 * tests and debugging.
 */

const DAY_LENGTH_MS = 8 * 60_000;

/** Color-grade keyframes across the day (t, multiply tint, strength). */
const GRADE_KEYFRAMES: Array<{ t: number; color: number; alpha: number }> = [
    { t: 0.0, color: 0xffffff, alpha: 0 },
    { t: 0.5, color: 0xffffff, alpha: 0 },
    { t: 0.56, color: 0xffd9a8, alpha: 0.18 }, // golden hour
    { t: 0.62, color: 0xe8875a, alpha: 0.32 }, // blazing sunset
    { t: 0.68, color: 0x5a5c9e, alpha: 0.52 }, // violet dusk
    { t: 0.74, color: 0x2c3a6e, alpha: 0.62 }, // night falls
    { t: 0.86, color: 0x2c3a6e, alpha: 0.62 }, // deep night holds
    { t: 0.92, color: 0x86587e, alpha: 0.42 }, // pre-dawn plum
    { t: 0.96, color: 0xffc9b0, alpha: 0.16 }, // rose dawn
    { t: 1.0, color: 0xffffff, alpha: 0 }
];

type LightKind = 'fire' | 'energy' | 'molten' | 'lamp';

interface LightDef {
    kind: LightKind;
    /** Pool + shaft tint. */
    tint: number;
    /** Hot core tint (defaults to tint). */
    hot?: number;
    /** Second hue for energy crossfade. */
    tint2?: number;
    /** Ground pool radius in px. */
    radius: number;
    /** Emitter offset from the building's center, screen px. */
    ox: number;
    oy: number;
    /** Emitter height above the ground, px. */
    h: number;
    /** Volumetric shaft height in px (omit for none). */
    shaft?: number;
    /** Occasional bright surges (tesla). */
    surge?: boolean;
    /** The drawn source (fire pit, lantern...) only exists from this level. */
    minLevel?: number;
}

/** Buildings that emit light after dark, and how their light behaves. */
const LIGHT_SOURCES: Partial<Record<BuildingType, LightDef>> = {
    // Fire: hearths, torches and camp flames — warm, restless.
    town_hall: { kind: 'fire', tint: 0xff9028, hot: 0xffc46a, radius: 130, ox: -30, oy: 15, h: 10, shaft: 26 },
    barracks: { kind: 'fire', tint: 0xff8c2e, hot: 0xffbe5e, radius: 105, ox: 24, oy: 10, h: 5, shaft: 26 },
    army_camp: { kind: 'fire', tint: 0xff8324, hot: 0xffc06a, radius: 125, ox: 0, oy: 8, h: 6, shaft: 34 },
    // Energy: arcane and electric glow — smooth breathing, two-tone.
    lab: { kind: 'energy', tint: 0x7fe7c9, tint2: 0x9a7cff, radius: 100, ox: -2, oy: -30, h: 0, shaft: 20 },
    mystic_barracks: { kind: 'energy', tint: 0x83ddff, tint2: 0x9d8bdd, radius: 112, ox: 0, oy: -45, h: 0, shaft: 28 },
    prism: { kind: 'energy', tint: 0x9a6cff, tint2: 0x6ce4ff, radius: 130, ox: 0, oy: -38, h: 0, shaft: 40 },
    tesla: { kind: 'energy', tint: 0x7fd4ff, tint2: 0xd8f2ff, radius: 90, ox: 0, oy: -26, h: 0, shaft: 30, surge: true },
    // Molten: the dragon's furnace — deep, slow, alive.
    dragons_breath: { kind: 'molten', tint: 0xff4a1e, hot: 0xff9a4e, radius: 165, ox: 0, oy: -4, h: 6, shaft: 24 },
    // Lamps: small steady work lights.
    mine: { kind: 'lamp', tint: 0xffd76a, radius: 70, ox: 7, oy: -8, h: 4, minLevel: 3 },
    storage: { kind: 'lamp', tint: 0xffc36a, radius: 78, ox: -23, oy: 12, h: 8 },
    // The watch brazier burns on the lookout deck all night.
    watchtower: { kind: 'fire', tint: 0xff9a3a, hot: 0xffc36a, radius: 95, ox: -8, oy: -52, h: 0, shaft: 16 },
    // Music never sleeps: the violet glass panel on the SW face hums.
    jukebox: { kind: 'energy', tint: 0xc98aff, tint2: 0xff9ad8, radius: 85, ox: -9, oy: 5, h: 8, shaft: 18 }
};


/** One glow point of a POSTCARD village: world-px emitter + palette, so a
 *  neighbour's night lights render without live rigs. */
export interface PostcardLightAnchor {
    x: number;
    y: number;
    tint: number;
    hot: number;
    radius: number;
}

/** Emitter anchors for a serialized neighbour world, capped for LOD budget. */
export function postcardLightAnchors(
    buildings: ReadonlyArray<{ type?: string; level?: number; gridX?: number; gridY?: number }>,
    offX: number,
    offY: number
): PostcardLightAnchor[] {
    const anchors: PostcardLightAnchor[] = [];
    for (const b of buildings) {
        const def = LIGHT_SOURCES[b.type as BuildingType];
        if (!def || (Number(b.level) || 1) < (def.minLevel ?? 1)) continue;
        const info = BUILDING_DEFINITIONS[b.type as BuildingType];
        if (!info) continue;
        const c = IsoUtils.cartToIso(offX + (b.gridX ?? 0) + info.width / 2, offY + (b.gridY ?? 0) + info.height / 2);
        anchors.push({
            x: c.x + def.ox,
            y: c.y + def.oy,
            tint: def.tint,
            hot: def.hot ?? def.tint2 ?? def.tint,
            radius: def.radius
        });
        if (anchors.length >= 7) break;
    }
    return anchors;
}

interface LightRig {
    def: LightDef;
    /** Live building — rigs track position/liveness every frame. */
    b: PlacedBuilding;
    /** Emitter ground point, world px. */
    sx: number;
    sy: number;
    /** Per-rig phase so no two lights beat in step. */
    phase: number;
    pool: Phaser.GameObjects.Image;
    core: Phaser.GameObjects.Image;
    core2?: Phaser.GameObjects.Image;
    shaft?: Phaser.GameObjects.Image;
}

interface LightHost extends Phaser.Scene {
    buildings: PlacedBuilding[];
    mode: string;
    /** Neighbour raid fought in place: the world (and its light) keeps going. */
    battleInPlace?: boolean;
}

export class DayNightSystem {
    /**
     * Clock skew vs the server (serverNow - Date.now()). The day/night cycle
     * derives from wall time so it is already global; this correction makes
     * every client agree with the SERVER's wall clock to the millisecond —
     * one world, one sun. Set by WorldMapSystem from /api/map responses.
     */
    static serverOffsetMs = 0;

    private readonly scene: LightHost;
    private readonly gradeOverlay: Phaser.GameObjects.Graphics;
    private readonly nightLifeGfx: Phaser.GameObjects.Graphics;
    private festivalSpot: { x: number; y: number } | null = null;
    private readonly rigs = new Map<string, LightRig>();
    /** One faint moonlit halo per building, so everything stays readable at night. */
    private readonly ambientGlows = new Map<string, { img: Phaser.GameObjects.Image; b: PlacedBuilding }>();
    private lanternLights: Phaser.GameObjects.Image[] = [];
    private lanternProvider: (() => Array<{ x: number; y: number }>) | null = null;
    private nextLightSyncAt = 0;
    private lastLightSig = '';
    /** 0 = disabled (battle), 1 = fully active (home). Lerped for smooth transitions. */
    private strength = 0;
    private phaseOverride: number | null = null;
    /** Rain wets the hearths: open flames dim while it pours. */
    private rainFactor = 0;
    /** Ad-hoc light sources (traveller bonfires, forge flares) with a lifespan. */
    private transient = new Map<number, { gx: number; gy: number; radius: number; tint: number; until: number; phase: number; pool: Phaser.GameObjects.Image; core: Phaser.GameObjects.Image }>();
    private nextTransientId = 1;
    /** Discovered-world cart-square (fog inner edge); clamps roaming lights. */
    private sightBound: { min: number; max: number } | null = null;
    private lastUpdateAt = 0;

    constructor(scene: LightHost) {
        this.scene = scene;

        // Soft radial light texture (canvas gradient beats stacked circles).
        if (!scene.textures.exists('dn_light')) {
            const size = 256;
            const canvas = scene.textures.createCanvas('dn_light', size, size);
            if (canvas) {
                const ctx = canvas.getContext();
                const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
                grad.addColorStop(0, 'rgba(255,255,255,0.95)');
                grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
                grad.addColorStop(0.7, 'rgba(255,255,255,0.12)');
                grad.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, size, size);
                canvas.refresh();
            }
        }

        // World-space overlay, restretched over the camera's worldView every
        // frame — immune to zoom and scroll (a scrollFactor(0) rect is NOT:
        // Phaser still applies camera zoom to it, which is exactly the
        // shrinking/sliding filter bug this replaces).
        this.gradeOverlay = scene.add.graphics().setDepth(30000);
        this.gradeOverlay.setBlendMode(Phaser.BlendModes.MULTIPLY);

        // Fireflies, moths and festival glow — redrawn each frame, zero churn.
        this.nightLifeGfx = scene.add.graphics().setDepth(30004);
        this.nightLifeGfx.setBlendMode(Phaser.BlendModes.ADD);
        // Additive night glows render smooth by design.
    }

    /** Pin the day clock to a phase (0..1) for tests/screenshots; null resumes real time. */
    setPhaseOverride(t: number | null) {
        this.phaseOverride = t;
    }

    /**
     * Debug hop to the next time of day: day -> sunset -> night -> dawn -> day.
     * Bound to the N key while the cycle is being tuned.
     */
    advancePhase() {
        const milestones = [0.3, 0.6, 0.8, 0.95];
        const t = this.phase();
        const next = milestones.find(m => m > t + 0.02) ?? milestones[0];
        this.setPhaseOverride(next);
    }

    /** Where the day currently stands, 0..1 (0.5 = late afternoon, ~0.8 = deep night). */
    phase(): number {
        if (this.phaseOverride !== null) return this.phaseOverride;
        const worldNow = Date.now() + DayNightSystem.serverOffsetMs;
        return (worldNow % DAY_LENGTH_MS) / DAY_LENGTH_MS;
    }

    /** 0 by day, ramping through sunset to 1 at night, back to 0 through dawn. */
    nightFactor(): number {
        const t = this.phase();
        if (t < 0.52 || t >= 0.98) return 0;
        if (t < 0.72) return (t - 0.52) / 0.2;
        if (t < 0.9) return 1;
        return 1 - (t - 0.9) / 0.08;
    }

    /** Lantern carriers (the night watch) — positions in grid coords. */
    setLanternProvider(provider: () => Array<{ x: number; y: number }>) {
        this.lanternProvider = provider;
    }

    /** Rain intensity 0..1 — open flames (fire/molten rigs, bonfires) dim in the wet. */
    setRainFactor(v: number) {
        this.rainFactor = Math.max(0, Math.min(1, v));
    }

    /**
     * The discovered world's cart-square bounds (WorldMapSystem's fog inner
     * edge). Transient lights roam the roads right up to the cloud wall; the
     * undiscovered-world clouds always win over light, so pools shrink as
     * their source nears the boundary instead of washing warm light across
     * the night-blue bank (ADD-blend images ignore depth against the fog's
     * higher layers). Null disables the clamp (no world map).
     */
    setSightBound(bound: { min: number; max: number } | null) {
        this.sightBound = bound;
    }

    /**
     * Register a temporary light (a traveller's bonfire, a midnight forge
     * flare). Flickers like a fire rig, lives until `until`, then cleans
     * itself up. Returns an id for early removal.
     */
    addTransientLight(opts: { gx: number; gy: number; radius?: number; tint?: number; until: number }): number {
        const id = this.nextTransientId++;
        const pool = this.scene.add.image(0, 0, 'dn_light');
        pool.setBlendMode(Phaser.BlendModes.ADD);
        pool.setDepth(30002);
        pool.setTint(opts.tint ?? 0xffa14a);
        const core = this.scene.add.image(0, 0, 'dn_light');
        core.setBlendMode(Phaser.BlendModes.ADD);
        core.setDepth(30003);
        core.setTint(opts.tint ?? 0xffc36a);
        this.transient.set(id, {
            gx: opts.gx,
            gy: opts.gy,
            radius: opts.radius ?? 60,
            tint: opts.tint ?? 0xffa14a,
            until: opts.until,
            // Stable phase derived from registration data. Transient light
            // animation is then a pure function of the shared clock.
            phase: (((id * 2.399963 + opts.gx * 0.371 + opts.gy * 0.613 + opts.until * 0.000001) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
            pool,
            core
        });
        return id;
    }

    removeTransientLight(id: number) {
        const light = this.transient.get(id);
        if (!light) return;
        light.pool.destroy();
        light.core.destroy();
        this.transient.delete(id);
    }

    /** Move a transient light (it follows its carrier). */
    moveTransientLight(id: number, gx: number, gy: number) {
        const light = this.transient.get(id);
        if (!light) return;
        light.gx = gx;
        light.gy = gy;
    }

    /**
     * Rebuild the light rigs NOW — called when a base finishes (re)loading so
     * night lights are already burning when the cloud reveal opens, instead
     * of popping in on the next 1.5s sync tick with a strength fade-in.
     */
    resyncLights() {
        this.nextLightSyncAt = 0;
        if (this.scene.mode === 'HOME') this.strength = 1;
        this.syncBuildingLights();
    }

    clearLights() {
        for (const rig of this.rigs.values()) this.destroyRig(rig);
        this.rigs.clear();
        for (const glow of this.ambientGlows.values()) glow.img.destroy();
        this.ambientGlows.clear();
        for (const light of this.lanternLights) light.destroy();
        this.lanternLights = [];
        for (const id of [...this.transient.keys()]) this.removeTransientLight(id);
        this.festivalSpot = null;
        this.nextLightSyncAt = 0;
    }

    update(time: number) {
        // The home village lives through the cycle — and so does a neighbour
        // raid fought in place: marching two lawns over must not change the
        // sky. Only cloud-transition battles (far away) get flat daylight.
        const target = this.scene.mode === 'HOME' || this.scene.battleInPlace ? 1 : 0;
        const delta = this.lastUpdateAt === 0 ? 16.667 : Math.min(250, Math.max(0, time - this.lastUpdateAt));
        this.lastUpdateAt = time;
        const blend = 1 - Math.pow(1 - 0.06, delta / 16.667);
        this.strength += (target - this.strength) * blend;
        if (this.strength < 0.01 && target === 0) {
            this.gradeOverlay.clear();
            this.nightLifeGfx.clear();
            this.setLightsVisible(false);
            return;
        }

        const t = this.phase();
        const nf = this.nightFactor() * this.strength;
        const cam = this.scene.cameras.main;

        // --- 1. Color grade, pinned to whatever the camera can see ---
        const grade = this.sampleGrade(t);
        this.gradeOverlay.clear();
        if (grade.alpha * this.strength > 0.004) {
            // cam.worldView is only recomputed at preRender, so during a
            // zoomTo tween it is one frame stale and the veil peels off the
            // screen edges on a fast zoom-out. Compute the live view instead.
            const vw = cam.width / cam.zoom;
            const vh = cam.height / cam.zoom;
            const vx = cam.scrollX + (cam.width - vw) * 0.5;
            const vy = cam.scrollY + (cam.height - vh) * 0.5;
            this.gradeOverlay.fillStyle(grade.color, grade.alpha * this.strength);
            this.gradeOverlay.fillRect(vx - 64, vy - 64, vw + 128, vh + 128);
        }

        // --- 2. Building light rigs ---
        // A freshly instantiated village (arriving at a raid, coming home)
        // must light up the SAME frame, not on the next 1.5s sync tick —
        // lights popping in after you land reads as broken.
        const lightSig = `${this.scene.buildings.length}:${this.scene.buildings[0]?.id ?? ''}:${this.scene.battleInPlace ? 1 : 0}`;
        if (time >= this.nextLightSyncAt || lightSig !== this.lastLightSig) {
            this.lastLightSig = lightSig;
            this.nextLightSyncAt = time + 1500;
            this.syncBuildingLights();
        }
        const lightsOn = nf > 0.02;
        const T = time * 0.001;
        for (const rig of this.rigs.values()) {
            const { def, phase } = rig;
            const alive = rig.b.health > 0 && !rig.b.isDestroyed;
            const show = lightsOn && alive;
            rig.pool.setVisible(show);
            rig.core.setVisible(show);
            rig.core2?.setVisible(show);
            rig.shaft?.setVisible(show);
            if (!show) continue;
            // Follow the live building every frame (drags must not lag).
            const binfo = BUILDING_DEFINITIONS[rig.b.type as BuildingType];
            const bc = IsoUtils.cartToIso(rig.b.gridX + (binfo?.width ?? 1) / 2, rig.b.gridY + (binfo?.height ?? 1) / 2);
            rig.sx = bc.x + def.ox;
            rig.sy = bc.y + def.oy;
            rig.pool.setPosition(rig.sx, rig.sy + 2);

            let f = 1;      // brightness modulation
            let jx = 0;     // emitter wobble
            let jy = 0;
            let mix = 0;    // energy hue crossfade
            switch (def.kind) {
                case 'fire':
                    // Stacked harmonics: slow breathing + fast flame licks.
                    f = 0.74
                        + 0.16 * Math.sin(T * 11 + phase)
                        + 0.07 * Math.sin(T * 23 + phase * 1.7)
                        + 0.05 * Math.sin(T * 41 + phase * 3);
                    jx = Math.sin(T * 7 + phase) * 1.4;
                    jy = Math.cos(T * 9.3 + phase) * 0.9;
                    break;
                case 'energy': {
                    f = 0.8 + 0.2 * Math.sin(T * 2.4 + phase);
                    mix = 0.5 + 0.5 * Math.sin(T * 1.6 + phase * 2);
                    if (def.surge) f += 0.25 * Math.max(0, Math.sin(T * 5.3 + phase)) ** 8;
                    break;
                }
                case 'molten': {
                    const w = 0.5 + 0.5 * Math.sin(T * 1.8 + phase);
                    f = 0.62 + 0.38 * w * w;
                    break;
                }
                case 'lamp':
                    f = 0.93 + 0.07 * Math.sin(T * 6.5 + phase);
                    break;
            }

            // Rain wets the open flames; enclosed lamps and energy sources shrug it off.
            if (def.kind === 'fire' || def.kind === 'molten') f *= 1 - this.rainFactor * 0.45;

            const breathe = def.kind === 'fire' ? 1 + (f - 0.8) * 0.1 : 1;
            // Ground pool: a wide 2:1 ellipse — light lying on the tilted iso
            // ground must never read as a circle.
            rig.pool.setAlpha(nf * 0.36 * f);
            rig.pool.setScale(def.radius * 2.6 / 256 * breathe, def.radius * 1.3 / 256 * breathe);
            rig.core.setPosition(rig.sx + jx, rig.sy - def.h + jy);
            rig.core.setAlpha(nf * 0.22 * f * (rig.core2 ? 1 - mix * 0.55 : 1));
            if (rig.core2) {
                rig.core2.setPosition(rig.sx + jx, rig.sy - def.h + jy);
                rig.core2.setAlpha(nf * 0.2 * f * mix);
            }
            if (rig.shaft && def.shaft) {
                rig.shaft.setPosition(rig.sx + jx * 0.6, rig.sy - def.h - def.shaft * 0.55);
                rig.shaft.setAlpha(nf * 0.16 * f);
            }
        }

        // Neighbour postcards glow with the same machinery, always.
        for (const rigs of this.postcardRigs.values()) {
            for (const rig of rigs) {
                rig.pool.setVisible(lightsOn);
                rig.core.setVisible(lightsOn);
                rig.core2?.setVisible(lightsOn);
                rig.shaft?.setVisible(lightsOn);
                if (!lightsOn) continue;
                const def = rig.def;
                const { f, jx, jy, mix } = DayNightSystem.flickerOf(def, T, rig.phase, this.rainFactor);
                const breathe = def.kind === 'fire' ? 1 + (f - 0.8) * 0.1 : 1;
                rig.pool.setPosition(rig.sx, rig.sy + 2);
                rig.pool.setAlpha(nf * 0.36 * f);
                rig.pool.setScale(def.radius * 2.6 / 256 * breathe, def.radius * 1.3 / 256 * breathe);
                const coreSquash = def.kind === 'energy' ? 1 : 0.7;
                rig.core.setPosition(rig.sx + jx, rig.sy - def.h + jy);
                rig.core.setScale(def.radius * 0.85 / 256, def.radius * 0.85 / 256 * coreSquash);
                rig.core.setAlpha(nf * 0.22 * f * (rig.core2 ? 1 - mix * 0.55 : 1));
                if (rig.core2) {
                    rig.core2.setPosition(rig.sx + jx, rig.sy - def.h + jy);
                    rig.core2.setScale(def.radius * 0.95 / 256);
                    rig.core2.setAlpha(nf * 0.2 * f * mix);
                }
                if (rig.shaft && def.shaft) {
                    rig.shaft.setPosition(rig.sx + jx * 0.6, rig.sy - def.h - def.shaft * 0.55);
                    rig.shaft.setScale(def.radius * 0.5 / 256, def.shaft * 2.4 / 256);
                    rig.shaft.setAlpha(nf * 0.16 * f);
                }
            }
        }

        // Faint ambient halo on every building — just enough to keep the
        // village readable in the dark.
        for (const glow of this.ambientGlows.values()) {
            const show = lightsOn && glow.b.health > 0 && !glow.b.isDestroyed;
            glow.img.setVisible(show);
            if (!show) continue;
            glow.img.setAlpha(nf * 0.1);
            const ginfo = BUILDING_DEFINITIONS[glow.b.type as BuildingType];
            const gc = IsoUtils.cartToIso(glow.b.gridX + (ginfo?.width ?? 1) / 2, glow.b.gridY + (ginfo?.height ?? 1) / 2);
            glow.img.setPosition(gc.x, gc.y + 1);
        }

        // Hand lanterns bobbing along with the night watch. World-space: depth
        // alone lifts them above the grade, so light beats dark.
        const lanternSpots = lightsOn && this.lanternProvider ? this.lanternProvider() : [];
        while (this.lanternLights.length < lanternSpots.length) {
            const img = this.scene.add.image(0, 0, 'dn_light');
            img.setBlendMode(Phaser.BlendModes.ADD);
            img.setDepth(30003);
            img.setTint(0xffcf7a);
            this.lanternLights.push(img);
        }
        for (let i = 0; i < this.lanternLights.length; i++) {
            const light = this.lanternLights[i];
            const spot = lanternSpots[i];
            if (!spot) {
                light.setVisible(false);
                continue;
            }
            const pos = IsoUtils.cartToIso(spot.x, spot.y);
            light.setPosition(pos.x, pos.y - 6);
            light.setScale(110 / 256, 110 * 0.6 / 256);
            const flicker = 0.78 + 0.13 * Math.sin(T * 12 + i * 2.1) + 0.09 * Math.sin(T * 27 + i * 4.7);
            light.setAlpha(nf * 0.45 * flicker);
            light.setVisible(true);
        }

        // Transient sources: traveller bonfires, forge flares. Fire-flicker,
        // rain-dimmed, self-cleaning on expiry.
        const nowMs = Date.now();
        for (const [id, light] of this.transient) {
            if (nowMs >= light.until) {
                this.removeTransientLight(id);
                continue;
            }
            const show = lightsOn;
            light.pool.setVisible(show);
            light.core.setVisible(show);
            if (!show) continue;
            const pos = IsoUtils.cartToIso(light.gx, light.gy);
            const f = (0.74
                + 0.16 * Math.sin(T * 11 + light.phase)
                + 0.07 * Math.sin(T * 23 + light.phase * 1.7)) * (1 - this.rainFactor * 0.45);
            // Fade in the last few seconds of life (embers dying down).
            const lifeLeft = Math.min(1, (light.until - nowMs) / 6000);
            // The cloud wall always wins over firelight: an edge camp's pool
            // must never brighten the undiscovered-world bank (these ADD
            // images draw above the fog layers by design, for the night
            // grade). Shrink the pool so its reach stays inside the sight
            // square, minus the ~2 tiles the front cloud billows lap inward;
            // dim it in step so a hemmed-in fire reads as embers, not a
            // clipped disc.
            let reach = 1;
            if (this.sightBound) {
                const CLOUD_LAP = 2.0;   // tiles the front puffs overhang inward
                const PX_PER_TILE = 30;  // screen px of pool reach per cart tile toward an edge
                const distTiles = Math.min(
                    light.gx - this.sightBound.min, this.sightBound.max - light.gx,
                    light.gy - this.sightBound.min, this.sightBound.max - light.gy
                ) - CLOUD_LAP;
                reach = Math.max(0, Math.min(1, (distTiles * PX_PER_TILE) / light.radius));
            }
            light.pool.setPosition(pos.x, pos.y + 2);
            light.pool.setAlpha(nf * 0.34 * f * lifeLeft * Math.min(1, reach * 1.4));
            light.pool.setScale(light.radius * reach * 2.6 / 256, light.radius * reach * 1.3 / 256);
            light.core.setPosition(pos.x + Math.sin(T * 7 + light.phase) * 1.2, pos.y - 5);
            light.core.setAlpha(nf * 0.22 * f * lifeLeft * Math.min(1, reach * 2.5));
            light.core.setScale(light.radius * Math.min(1, reach * 1.6) * 0.9 / 256);
        }

        this.drawNightLife(T, nf);
    }

    /** Festival nights: while set, a warm glow bathes the dance ground. */
    setFestivalGlow(spot: { x: number; y: number } | null) {
        this.festivalSpot = spot;
    }

    /**
     * The small night things: fireflies wandering the dark lawn on slow
     * Lissajous paths, moths fluttering around the warm lights, and the
     * festival glow when the village dances. One graphics, redrawn per frame,
     * every motion a deterministic function of time.
     */
    private drawNightLife(T: number, nf: number) {
        const g = this.nightLifeGfx;
        g.clear();
        if (nf < 0.3) return;

        // Fireflies over the grass.
        for (let i = 0; i < 14; i++) {
            const seed = i * 37.7;
            const ax = 3 + ((seed * 7.13) % 19) + Math.sin(T * 0.05 + seed) * 2.2;
            const ay = 3 + ((seed * 3.71) % 19) + Math.cos(T * 0.04 + seed) * 2.2;
            const gx = ax + Math.sin(T * (0.35 + (i % 5) * 0.07) + seed) * 1.6;
            const gy = ay + Math.sin(T * (0.27 + (i % 3) * 0.09) + seed * 2) * 1.3;
            const pulse = Math.max(0, Math.sin(T * (0.55 + (i % 4) * 0.12) + seed * 3));
            const a = nf * pulse * pulse * pulse * 0.85;
            if (a < 0.03) continue;
            const p = IsoUtils.cartToIso(gx, gy);
            const fy = p.y - 6 - Math.sin(T * 0.9 + seed) * 3;
            pixelEllipse(g, p.x, fy, 4.5, 4.5, 0xd8f077, a * 0.28);
            pixelEllipse(g, p.x, fy, 1.4, 1.4, 0xeaffb0, a);
        }

        // Moths drawn to the warm lights.
        for (const rig of this.rigs.values()) {
            if (rig.def.kind !== 'fire' && rig.def.kind !== 'lamp') continue;
            if (!rig.pool.visible) continue;
            const cx = rig.sx;
            const cy = rig.sy - rig.def.h;
            for (let m = 0; m < 2; m++) {
                const ph = rig.phase + m * 2.4;
                const r = 8 + Math.sin(T * 0.31 + ph) * 4;
                const mx = cx + Math.cos(T * (1.7 + m * 0.4) + ph) * r;
                const my = cy + Math.sin(T * (2.3 - m * 0.5) + ph * 1.7) * r * 0.55;
                const flut = 0.55 + Math.abs(Math.sin(T * 26 + ph)) * 0.45;
                pixelRect(g, mx - 1, my - 1, 2, 2, 0xe8e0c8, nf * 0.5 * flut);
            }
        }

        // Festival glow under the jukebox dance.
        if (this.festivalSpot) {
            const p = IsoUtils.cartToIso(this.festivalSpot.x, this.festivalSpot.y);
            const warm = 0.5 + Math.sin(T * 5.3) * 0.08 + Math.sin(T * 12.7) * 0.05;
            pixelEllipse(g, p.x, p.y, 75, 37.5, 0xffc36a, nf * 0.16 * warm);
            pixelEllipse(g, p.x, p.y - 10, 35, 20, 0xffd98a, nf * 0.22 * warm);
        }
    }

    /** One postcard light: a static emitter with the same images/flicker a
     *  live rig gets — a neighbour's hearth glows exactly like yours. */
    private postcardRigs = new Map<string, Array<{
        def: LightDef;
        sx: number;
        sy: number;
        phase: number;
        pool: Phaser.GameObjects.Image;
        core: Phaser.GameObjects.Image;
        core2?: Phaser.GameObjects.Image;
        shaft?: Phaser.GameObjects.Image;
    }>>();

    /** Give a neighbour postcard REAL light rigs from its serialized world —
     *  same textures, same additive blend, same flicker as the home village.
     *  Re-calling with the same key replaces the set. */
    setPostcardLights(
        key: string,
        buildings: ReadonlyArray<{ type?: string; level?: number; gridX?: number; gridY?: number }>,
        offX: number,
        offY: number,
        cap = 10
    ) {
        this.clearPostcardLights(key);
        const rigs: NonNullable<ReturnType<typeof this.postcardRigs.get>> = [];
        for (const b of buildings) {
            const def = LIGHT_SOURCES[b.type as BuildingType];
            if (!def || (Number(b.level) || 1) < (def.minLevel ?? 1)) continue;
            const info = BUILDING_DEFINITIONS[b.type as BuildingType];
            if (!info) continue;
            const c = IsoUtils.cartToIso(offX + (b.gridX ?? 0) + info.width / 2, offY + (b.gridY ?? 0) + info.height / 2);
            rigs.push({
                def,
                sx: c.x + def.ox,
                sy: c.y + def.oy,
                phase: ((b.gridX ?? 0) * 7.3 + (b.gridY ?? 0) * 3.1 + offX) % (Math.PI * 2),
                pool: this.makeImage(def.tint),
                core: this.makeImage(def.hot ?? def.tint),
                core2: def.tint2 !== undefined ? this.makeImage(def.tint2) : undefined,
                shaft: def.shaft ? this.makeImage(def.tint) : undefined
            });
            if (rigs.length >= cap) break;
        }
        if (rigs.length > 0) this.postcardRigs.set(key, rigs);
    }

    clearPostcardLights(key: string) {
        const rigs = this.postcardRigs.get(key);
        if (!rigs) return;
        for (const rig of rigs) {
            rig.pool.destroy();
            rig.core.destroy();
            rig.core2?.destroy();
            rig.shaft?.destroy();
        }
        this.postcardRigs.delete(key);
    }

    /** The one flicker vocabulary, shared by live and postcard rigs. */
    private static flickerOf(def: LightDef, T: number, phase: number, rain: number) {
        let f = 1;
        let jx = 0;
        let jy = 0;
        let mix = 0;
        switch (def.kind) {
            case 'fire':
                f = 0.74
                    + 0.16 * Math.sin(T * 11 + phase)
                    + 0.07 * Math.sin(T * 23 + phase * 1.7)
                    + 0.05 * Math.sin(T * 41 + phase * 3);
                jx = Math.sin(T * 7 + phase) * 1.4;
                jy = Math.cos(T * 9.3 + phase) * 0.9;
                break;
            case 'energy': {
                f = 0.8 + 0.2 * Math.sin(T * 2.4 + phase);
                mix = 0.5 + 0.5 * Math.sin(T * 1.6 + phase * 2);
                if (def.surge) f += 0.25 * Math.max(0, Math.sin(T * 5.3 + phase)) ** 8;
                break;
            }
            case 'molten': {
                const w = 0.5 + 0.5 * Math.sin(T * 1.8 + phase);
                f = 0.62 + 0.38 * w * w;
                break;
            }
            case 'lamp':
                f = 0.93 + 0.07 * Math.sin(T * 6.5 + phase);
                break;
        }
        if (def.kind === 'fire' || def.kind === 'molten') f *= 1 - rain * 0.45;
        return { f, jx, jy, mix };
    }

    private makeImage(tint: number): Phaser.GameObjects.Image {
        const img = this.scene.add.image(0, 0, 'dn_light');
        img.setBlendMode(Phaser.BlendModes.ADD);
        img.setDepth(30003); // above the grade: light defeats the dark
        img.setTint(tint);
        img.setAlpha(0);
        return img;
    }

    private destroyRig(rig: LightRig) {
        rig.pool.destroy();
        rig.core.destroy();
        rig.core2?.destroy();
        rig.shaft?.destroy();
    }

    /** Keep one rig per lit, living building; buildings come and go freely. */
    private syncBuildingLights() {
        const seen = new Set<string>();
        const seenAmbient = new Set<string>();
        const activeOwner = this.scene.battleInPlace ? 'ENEMY' : 'PLAYER';
        for (const b of this.scene.buildings) {
            if (b.health <= 0 || b.isDestroyed || b.owner !== activeOwner) continue;
            const info = BUILDING_DEFINITIONS[b.type as BuildingType];
            // Every building except walls gets the faint halo, sized to its
            // footprint and squashed 2:1 onto the iso ground plane.
            if (b.type !== 'wall' && info) {
                seenAmbient.add(b.id);
                let glow = this.ambientGlows.get(b.id);
                if (!glow) {
                    glow = { img: this.makeImage(0xf0e4c8), b };
                    this.ambientGlows.set(b.id, glow);
                }
                glow.b = b;
                const cx = IsoUtils.cartToIso(b.gridX + info.width / 2, b.gridY + info.height / 2);
                glow.img.setPosition(cx.x, cx.y + 1);
                const spanX = (info.width + info.height) * 32 * 1.25;
                glow.img.setScale(spanX / 256, spanX * 0.5 / 256);
            }
            const def = LIGHT_SOURCES[b.type as BuildingType];
            if (!def || (b.level ?? 1) < (def.minLevel ?? 1)) continue;
            seen.add(b.id);
            let rig = this.rigs.get(b.id);
            if (!rig) {
                rig = {
                    def,
                    b,
                    sx: 0,
                    sy: 0,
                    phase: (b.gridX * 7.3 + b.gridY * 3.1) % (Math.PI * 2),
                    pool: this.makeImage(def.tint),
                    core: this.makeImage(def.hot ?? def.tint),
                    core2: def.tint2 !== undefined ? this.makeImage(def.tint2) : undefined,
                    shaft: def.shaft ? this.makeImage(def.tint) : undefined
                };
                this.rigs.set(b.id, rig);
            }
            rig.b = b;
            const center = IsoUtils.cartToIso(b.gridX + (info?.width ?? 1) / 2, b.gridY + (info?.height ?? 1) / 2);
            rig.sx = center.x + def.ox;
            rig.sy = center.y + def.oy;
            // Pool hugs the iso ground under the emitter.
            rig.pool.setPosition(rig.sx, rig.sy + 2);
            // Emitters in the air (crystal, coil, retort) keep a round halo;
            // hearth-height sources squash toward the ground plane.
            const coreSquash = def.kind === 'energy' ? 1 : 0.7;
            rig.core.setScale(def.radius * 0.85 / 256, def.radius * 0.85 / 256 * coreSquash);
            rig.core2?.setScale(def.radius * 0.95 / 256);
            rig.shaft?.setScale(def.radius * 0.5 / 256, ((def.shaft ?? 0) * 2.4) / 256);
        }
        for (const [id, rig] of this.rigs) {
            if (!seen.has(id)) {
                this.destroyRig(rig);
                this.rigs.delete(id);
            }
        }
        for (const [id, glow] of this.ambientGlows) {
            if (!seenAmbient.has(id)) {
                glow.img.destroy();
                this.ambientGlows.delete(id);
            }
        }
    }

    private setLightsVisible(visible: boolean) {
        for (const glow of this.ambientGlows.values()) glow.img.setVisible(visible);
        for (const rig of this.rigs.values()) {
            rig.pool.setVisible(visible);
            rig.core.setVisible(visible);
            rig.core2?.setVisible(visible);
            rig.shaft?.setVisible(visible);
        }
        for (const light of this.lanternLights) light.setVisible(visible);
        for (const light of this.transient.values()) {
            light.pool.setVisible(visible);
            light.core.setVisible(visible);
        }
    }

    private sampleGrade(t: number): { color: number; alpha: number } {
        const frames = GRADE_KEYFRAMES;
        for (let i = 0; i < frames.length - 1; i++) {
            const a = frames[i];
            const b = frames[i + 1];
            if (t >= a.t && t <= b.t) {
                const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
                const ca = Phaser.Display.Color.ValueToColor(a.color);
                const cb = Phaser.Display.Color.ValueToColor(b.color);
                const mixed = Phaser.Display.Color.Interpolate.ColorWithColor(ca, cb, 100, Math.round(f * 100));
                return {
                    color: Phaser.Display.Color.GetColor(mixed.r, mixed.g, mixed.b),
                    alpha: a.alpha + (b.alpha - a.alpha) * f
                };
            }
        }
        return { color: 0xffffff, alpha: 0 };
    }
}
