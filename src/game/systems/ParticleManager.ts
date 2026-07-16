import Phaser from 'phaser';
import { MobileUtils } from '../utils/MobileUtils';
import { registerPixelSurface } from '../renderers/TextureRenderPolicy';

const TRACKER_DEPTH_BAND = 64;
const MIN_TRACKER_DEPTH = 0;
const MAX_TRACKER_DEPTH = 30000;
const DEFAULT_SMOKE_TINTS = [0x444444, 0x666666, 0x333333];
/** Depth-banded emitters idle this long get destroyed — well past the
 *  longest particle lifespan (1.2 s), so nothing alive is ever cut off. */
const EMITTER_IDLE_REAP_MS = 8000;
/** The reap sweep itself piggybacks on emit calls at most this often. */
const EMITTER_REAP_INTERVAL_MS = 2000;

export class ParticleManager {
    private static instance: ParticleManager;
    private scene!: Phaser.Scene;
    private isMobile: boolean = false;
    
    // Emitters are banded per depth (see depthBandOf): a shared emitter's
    // setDepth would retro-depth every particle still alive on it, so two
    // overlapping bursts at different depths used to yank each other's
    // particles. One emitter per 64-depth band keeps live particles put.
    private trackerSmokeEmitters = new Map<number, Phaser.GameObjects.Particles.ParticleEmitter>();
    private trackerSparkEmitters = new Map<number, Phaser.GameObjects.Particles.ParticleEmitter>();
    private burstFireEmitters = new Map<number, Phaser.GameObjects.Particles.ParticleEmitter>();
    private burstDustEmitters = new Map<number, Phaser.GameObjects.Particles.ParticleEmitter>();
    private burstDebrisEmitters = new Map<number, Phaser.GameObjects.Particles.ParticleEmitter>();
    
    // Track trackers (so we don't emit every frame for ambient effects)
    // Key: id (like buildingId), Value: last time emitted
    private trackers: Map<string, number> = new Map();

    // Band emitters are created on demand and a long session can wander
    // across hundreds of depth bands (one emitter per band ever touched,
    // ×5 kinds) — so every access stamps a last-use time and a throttled
    // sweep reaps bands idle past EMITTER_IDLE_REAP_MS.
    private emitterLastUsed = new Map<Phaser.GameObjects.Particles.ParticleEmitter, number>();
    private nextEmitterReapAt = 0;

    private constructor() {
        this.isMobile = MobileUtils.isMobile();
    }

    public static getInstance(): ParticleManager {
        if (!ParticleManager.instance) {
            ParticleManager.instance = new ParticleManager();
        }
        return ParticleManager.instance;
    }

    public init(scene: Phaser.Scene) {
        this.destroyTrackerEmitters();
        this.scene = scene;
        this.trackers.clear();

        // Generate procedural textures so we don't need to load external images
        this.generateTextures();
    }

    private generateTextures() {
        // Canvas textures with integer 2px-block fills — Graphics.fillCircle
        // would re-introduce AA, which NEAREST sampling (registerPixelSurface)
        // turns into fringing. Same 16x16 logical size so emitter scale
        // ranges keep their world size.
        const SIZE = 16;
        const BLOCK = 2;

        if (!this.scene.textures.exists('particle_circle')) {
            const canvas = this.scene.textures.createCanvas('particle_circle', SIZE, SIZE);
            if (canvas) {
                const ctx = canvas.getContext();
                ctx.fillStyle = '#ffffff';
                // Classic 8-block pixel circle: per-row [startBlock, blockWidth].
                const rows: [number, number][] = [
                    [2, 4], [1, 6], [0, 8], [0, 8], [0, 8], [0, 8], [1, 6], [2, 4]
                ];
                rows.forEach(([start, width], by) => {
                    ctx.fillRect(start * BLOCK, by * BLOCK, width * BLOCK, BLOCK);
                });
                canvas.refresh();
                registerPixelSurface(canvas);
            }
        }

        if (!this.scene.textures.exists('particle_square')) {
            const canvas = this.scene.textures.createCanvas('particle_square', SIZE, SIZE);
            if (canvas) {
                const ctx = canvas.getContext();
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, SIZE, SIZE);
                canvas.refresh();
                registerPixelSurface(canvas);
            }
        }

        if (!this.scene.textures.exists('particle_glow')) {
            const canvas = this.scene.textures.createCanvas('particle_glow', SIZE, SIZE);
            if (canvas) {
                const ctx = canvas.getContext();
                // Stepped rings, checkerboard-dithered between discrete alpha
                // levels (1 / 0.5 / 0) — a smooth gradient would read as mush
                // under NEAREST. Still glows under ADD blend.
                const blocks = SIZE / BLOCK;
                const center = (blocks - 1) / 2;
                for (let by = 0; by < blocks; by++) {
                    for (let bx = 0; bx < blocks; bx++) {
                        const d = Math.hypot(bx - center, by - center);
                        const checker = (bx + by) % 2 === 0;
                        let alpha = 0;
                        if (d <= 1.75) alpha = 1;                       // solid core
                        else if (d <= 2.75) alpha = checker ? 1 : 0.5;  // full/half dither
                        else if (d <= 3.75) alpha = checker ? 0.5 : 0;  // half/off dither
                        if (alpha > 0) {
                            ctx.fillStyle = `rgba(255,255,255,${alpha})`;
                            ctx.fillRect(bx * BLOCK, by * BLOCK, BLOCK, BLOCK);
                        }
                    }
                }
                canvas.refresh();
                registerPixelSurface(canvas);
            }
        }
    }

    // =========================================================================
    // AMBIENT TRACKERS (For continuous effects tracked by time)
    // =========================================================================
    
    private canEmit(id: string, time: number, intervalMs: number): boolean {
        if (!this.trackers.has(id)) {
            this.trackers.set(id, time);
            return true;
        }
        const last = this.trackers.get(id)!;
        if (time - last > intervalMs) {
            this.trackers.set(id, time);
            return true;
        }
        return false;
    }

    private depthBandOf(depth: number): number {
        const safeDepth = Number.isFinite(depth) ? depth : 20000;
        const bounded = Math.max(MIN_TRACKER_DEPTH, Math.min(MAX_TRACKER_DEPTH, safeDepth));
        return Math.round(bounded / TRACKER_DEPTH_BAND) * TRACKER_DEPTH_BAND;
    }

    /** Stamp last-use on every fetch so the reaper only takes idle bands. */
    private touchEmitter(emitter: Phaser.GameObjects.Particles.ParticleEmitter): Phaser.GameObjects.Particles.ParticleEmitter {
        this.emitterLastUsed.set(emitter, this.scene.time.now);
        return emitter;
    }

    /** Destroy band emitters idle past the reap window. Throttled; called
     *  from the public emit paths, so it runs whenever particles are in use
     *  and the population tracks the bands actually being hit. */
    private reapIdleEmitters() {
        const now = this.scene.time.now;
        if (now < this.nextEmitterReapAt) return;
        this.nextEmitterReapAt = now + EMITTER_REAP_INTERVAL_MS;
        const bandMaps = [
            this.trackerSmokeEmitters,
            this.trackerSparkEmitters,
            this.burstFireEmitters,
            this.burstDustEmitters,
            this.burstDebrisEmitters
        ];
        for (const bandMap of bandMaps) {
            for (const [band, emitter] of bandMap) {
                const last = this.emitterLastUsed.get(emitter) ?? 0;
                if (now - last < EMITTER_IDLE_REAP_MS) continue;
                this.emitterLastUsed.delete(emitter);
                emitter.destroy();
                bandMap.delete(band);
            }
        }
    }

    private smokeTrackerEmitterAt(depth: number): Phaser.GameObjects.Particles.ParticleEmitter {
        const band = this.depthBandOf(depth);
        const existing = this.trackerSmokeEmitters.get(band);
        if (existing) return this.touchEmitter(existing);

        const emitter = this.scene.add.particles(0, 0, 'particle_circle', {
            emitting: false,
            lifespan: { min: 600, max: 1200 },
            speed: { min: 5, max: 20 },
            angle: { min: 250, max: 290 },
            scale: { start: 0.2, end: 1.5 },
            alpha: { start: 0.6, end: 0 },
            tint: DEFAULT_SMOKE_TINTS,
            blendMode: 'NORMAL'
        });
        emitter.setDepth(band);
        this.trackerSmokeEmitters.set(band, emitter);
        return this.touchEmitter(emitter);
    }

    private sparkTrackerEmitterAt(depth: number): Phaser.GameObjects.Particles.ParticleEmitter {
        const band = this.depthBandOf(depth);
        const existing = this.trackerSparkEmitters.get(band);
        if (existing) return this.touchEmitter(existing);

        const emitter = this.scene.add.particles(0, 0, 'particle_circle', {
            emitting: false,
            lifespan: { min: 200, max: 500 },
            speed: { min: 30, max: 100 },
            gravityY: 200,
            scale: { start: 0.2, end: 0 },
            alpha: { start: 1, end: 0 },
            tint: 0xffff00,
            blendMode: 'ADD'
        });
        emitter.setDepth(band);
        this.trackerSparkEmitters.set(band, emitter);
        return this.touchEmitter(emitter);
    }

    private fireEmitterAt(depth: number): Phaser.GameObjects.Particles.ParticleEmitter {
        const band = this.depthBandOf(depth);
        const existing = this.burstFireEmitters.get(band);
        if (existing) return this.touchEmitter(existing);

        const emitter = this.scene.add.particles(0, 0, 'particle_glow', {
            emitting: false,
            lifespan: { min: 300, max: 600 },
            speed: { min: 10, max: 30 },
            angle: { min: 240, max: 300 }, // Upwards
            scale: { start: 0.8, end: 0 },
            alpha: { start: 0.8, end: 0 },
            tint: [ 0xffaa00, 0xff4400, 0xff0000 ],
            blendMode: 'ADD'
        });
        emitter.setDepth(band);
        this.burstFireEmitters.set(band, emitter);
        return this.touchEmitter(emitter);
    }

    private dustEmitterAt(depth: number): Phaser.GameObjects.Particles.ParticleEmitter {
        const band = this.depthBandOf(depth);
        const existing = this.burstDustEmitters.get(band);
        if (existing) return this.touchEmitter(existing);

        const emitter = this.scene.add.particles(0, 0, 'particle_circle', {
            emitting: false,
            lifespan: { min: 500, max: 800 },
            speed: { min: 10, max: 40 },
            angle: { min: 0, max: 360 }, // Burst outward
            scale: { start: 0.3, end: 1.2 },
            alpha: { start: 0.5, end: 0 },
            tint: [ 0xaa8866, 0x886644 ], // Dirt colors
            blendMode: 'NORMAL'
        });
        emitter.setDepth(band);
        this.burstDustEmitters.set(band, emitter);
        return this.touchEmitter(emitter);
    }

    private debrisEmitterAt(depth: number): Phaser.GameObjects.Particles.ParticleEmitter {
        const band = this.depthBandOf(depth);
        const existing = this.burstDebrisEmitters.get(band);
        if (existing) return this.touchEmitter(existing);

        const emitter = this.scene.add.particles(0, 0, 'particle_square', {
            emitting: false,
            lifespan: { min: 400, max: 700 },
            speed: { min: 40, max: 120 },
            angle: { min: 180, max: 360 }, // Upward burst
            gravityY: 300,
            scale: { start: 0.4, end: 0.1 },
            alpha: { start: 1, end: 0 },
            rotate: { start: 0, end: 360 },
            tint: [ 0x666666, 0x888888, 0x444444 ],
            blendMode: 'NORMAL'
        });
        emitter.setDepth(band);
        this.burstDebrisEmitters.set(band, emitter);
        return this.touchEmitter(emitter);
    }

    public emitSmokeTracker(id: string, x: number, y: number, time: number, depth: number, count: number = 1, intervalMs: number = 150, tint?: number) {
        if (!this.scene || !this.scene.sys || !this.scene.sys.isActive()) return;
        this.reapIdleEmitters();
        if (this.isMobile && count > 1) count = 1;
        if (this.canEmit(id + '_smoke', time, intervalMs)) {
            const emitter = this.smokeTrackerEmitterAt(depth);
            emitter.particleTint = tint ?? DEFAULT_SMOKE_TINTS;
            emitter.emitParticleAt(x, y, count);
        }
    }

    public emitSparkTracker(id: string, x: number, y: number, time: number, depth: number, count: number = 1, intervalMs: number = 300) {
        if (!this.scene || !this.scene.sys || !this.scene.sys.isActive()) return;
        this.reapIdleEmitters();
        if (this.isMobile && count > 1) count = 1;
        if (this.canEmit(id + '_spark', time, intervalMs)) {
            this.sparkTrackerEmitterAt(depth).emitParticleAt(x, y, count);
        }
    }

    // =========================================================================
    // INSTANT BURSTS (For one-off events)
    // =========================================================================

    public emitExplosion(x: number, y: number, depth: number) {
        if (!this.scene || !this.scene.sys || !this.scene.sys.isActive()) return;
        this.reapIdleEmitters();
        this.fireEmitterAt(depth).emitParticleAt(x, y, this.isMobile ? 5 : 12);

        const smoke = this.smokeTrackerEmitterAt(depth + 1);
        smoke.particleTint = DEFAULT_SMOKE_TINTS;
        smoke.emitParticleAt(x, y, this.isMobile ? 3 : 8);

        this.debrisEmitterAt(depth + 2).emitParticleAt(x, y, this.isMobile ? 4 : 10);
    }

    public emitHitFlash(x: number, y: number, depth: number) {
        if (!this.scene || !this.scene.sys || !this.scene.sys.isActive()) return;
        this.reapIdleEmitters();
        this.sparkTrackerEmitterAt(depth).emitParticleAt(x, y, this.isMobile ? 3 : 6);
    }

    public emitDustBurst(x: number, y: number, depth: number) {
        if (!this.scene || !this.scene.sys || !this.scene.sys.isActive()) return;
        this.reapIdleEmitters();
        this.dustEmitterAt(depth).emitParticleAt(x, y, this.isMobile ? 5 : 10);
    }

    public clearAll() {
        this.trackers.clear();
        this.destroyTrackerEmitters();
    }

    private destroyTrackerEmitters() {
        for (const emitter of this.trackerSmokeEmitters.values()) emitter.destroy();
        for (const emitter of this.trackerSparkEmitters.values()) emitter.destroy();
        for (const emitter of this.burstFireEmitters.values()) emitter.destroy();
        for (const emitter of this.burstDustEmitters.values()) emitter.destroy();
        for (const emitter of this.burstDebrisEmitters.values()) emitter.destroy();
        this.trackerSmokeEmitters.clear();
        this.trackerSparkEmitters.clear();
        this.burstFireEmitters.clear();
        this.burstDustEmitters.clear();
        this.burstDebrisEmitters.clear();
        this.emitterLastUsed.clear();
        this.nextEmitterReapAt = 0;
    }
}

export const particleManager = ParticleManager.getInstance();
