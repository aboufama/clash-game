import Phaser from 'phaser';
import { MobileUtils } from '../utils/MobileUtils';
import { registerPixelSurface } from '../renderers/TextureRenderPolicy';

const TRACKER_DEPTH_BAND = 64;
const MIN_TRACKER_DEPTH = 0;
const MAX_TRACKER_DEPTH = 30000;
const DEFAULT_SMOKE_TINTS = [0x444444, 0x666666, 0x333333];

export class ParticleManager {
    private static instance: ParticleManager;
    private scene!: Phaser.Scene;
    private isMobile: boolean = false;
    
    // Core emitters
    private smokeEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
    private fireEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
    private sparkEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
    private trackerSmokeEmitters = new Map<number, Phaser.GameObjects.Particles.ParticleEmitter>();
    private trackerSparkEmitters = new Map<number, Phaser.GameObjects.Particles.ParticleEmitter>();
    private dustEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
    private debrisEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
    
    // Track trackers (so we don't emit every frame for ambient effects)
    // Key: id (like buildingId), Value: last time emitted
    private trackers: Map<string, number> = new Map();

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
        this.createEmitters();
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

    private createEmitters() {
        // --- SMOKE EMITTER ---
        this.smokeEmitter = this.scene.add.particles(0, 0, 'particle_circle', {
            emitting: false,
            lifespan: { min: 600, max: 1200 },
            speed: { min: 5, max: 20 },
            angle: { min: 250, max: 290 }, // Upwards
            scale: { start: 0.2, end: 1.5 },
            alpha: { start: 0.6, end: 0 },
            tint: [ 0x444444, 0x666666, 0x333333 ],
            blendMode: 'NORMAL'
        });
        this.smokeEmitter.setDepth(20000); // Standard high depth

        // --- FIRE EMITTER ---
        this.fireEmitter = this.scene.add.particles(0, 0, 'particle_glow', {
            emitting: false,
            lifespan: { min: 300, max: 600 },
            speed: { min: 10, max: 30 },
            angle: { min: 240, max: 300 }, // Upwards
            scale: { start: 0.8, end: 0 },
            alpha: { start: 0.8, end: 0 },
            tint: [ 0xffaa00, 0xff4400, 0xff0000 ],
            blendMode: 'ADD'
        });
        this.fireEmitter.setDepth(20000);

        // --- SPARK EMITTER ---
        this.sparkEmitter = this.scene.add.particles(0, 0, 'particle_circle', {
            emitting: false,
            lifespan: { min: 200, max: 500 },
            speed: { min: 30, max: 100 },
            gravityY: 200,
            scale: { start: 0.2, end: 0 },
            alpha: { start: 1, end: 0 },
            tint: 0xffff00,
            blendMode: 'ADD'
        });
        this.sparkEmitter.setDepth(20001);

        // --- DUST EMITTER ---
        this.dustEmitter = this.scene.add.particles(0, 0, 'particle_circle', {
            emitting: false,
            lifespan: { min: 500, max: 800 },
            speed: { min: 10, max: 40 },
            angle: { min: 0, max: 360 }, // Burst outward
            scale: { start: 0.3, end: 1.2 },
            alpha: { start: 0.5, end: 0 },
            tint: [ 0xaa8866, 0x886644 ], // Dirt colors
            blendMode: 'NORMAL'
        });
        this.dustEmitter.setDepth(20000);
        
        // --- DEBRIS EMITTER (Squares for rubble) ---
        this.debrisEmitter = this.scene.add.particles(0, 0, 'particle_square', {
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
        this.debrisEmitter.setDepth(20000);
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

    private smokeTrackerEmitterAt(depth: number): Phaser.GameObjects.Particles.ParticleEmitter {
        const band = this.depthBandOf(depth);
        const existing = this.trackerSmokeEmitters.get(band);
        if (existing) return existing;

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
        return emitter;
    }

    private sparkTrackerEmitterAt(depth: number): Phaser.GameObjects.Particles.ParticleEmitter {
        const band = this.depthBandOf(depth);
        const existing = this.trackerSparkEmitters.get(band);
        if (existing) return existing;

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
        return emitter;
    }

    public emitSmokeTracker(id: string, x: number, y: number, time: number, depth: number, count: number = 1, intervalMs: number = 150, tint?: number) {
        if (!this.scene || !this.scene.sys || !this.scene.sys.isActive()) return;
        if (this.isMobile && count > 1) count = 1;
        if (this.canEmit(id + '_smoke', time, intervalMs)) {
            const emitter = this.smokeTrackerEmitterAt(depth);
            emitter.particleTint = tint ?? DEFAULT_SMOKE_TINTS;
            emitter.emitParticleAt(x, y, count);
        }
    }

    public emitSparkTracker(id: string, x: number, y: number, time: number, depth: number, count: number = 1, intervalMs: number = 300) {
        if (!this.scene || !this.scene.sys || !this.scene.sys.isActive()) return;
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
        this.fireEmitter.setDepth(depth);
        this.fireEmitter.emitParticleAt(x, y, this.isMobile ? 5 : 12);
        
        this.smokeEmitter.setDepth(depth + 1);
        this.smokeEmitter.particleTint = DEFAULT_SMOKE_TINTS;
        this.smokeEmitter.emitParticleAt(x, y, this.isMobile ? 3 : 8);
        
        this.debrisEmitter.setDepth(depth + 2);
        this.debrisEmitter.emitParticleAt(x, y, this.isMobile ? 4 : 10);
    }
    
    public emitHitFlash(x: number, y: number, depth: number) {
        if (!this.scene || !this.scene.sys || !this.scene.sys.isActive()) return;
        this.sparkEmitter.setDepth(depth);
        this.sparkEmitter.emitParticleAt(x, y, this.isMobile ? 3 : 6);
    }

    public emitDustBurst(x: number, y: number, depth: number) {
        if (!this.scene || !this.scene.sys || !this.scene.sys.isActive()) return;
        this.dustEmitter.setDepth(depth);
        this.dustEmitter.emitParticleAt(x, y, this.isMobile ? 5 : 10);
    }
    
    public clearAll() {
        this.trackers.clear();
        this.destroyTrackerEmitters();
    }

    private destroyTrackerEmitters() {
        for (const emitter of this.trackerSmokeEmitters.values()) emitter.destroy();
        for (const emitter of this.trackerSparkEmitters.values()) emitter.destroy();
        this.trackerSmokeEmitters.clear();
        this.trackerSparkEmitters.clear();
    }
}

export const particleManager = ParticleManager.getInstance();
