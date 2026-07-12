import Phaser from 'phaser';
import { MobileUtils } from '../utils/MobileUtils';
import { applyPixelSnap } from '../render/PixelSnap';

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
        if (!this.scene.textures.exists('particle_circle')) {
            const g = this.scene.add.graphics();
            g.fillStyle(0xffffff, 1);
            g.fillCircle(8, 8, 8);
            g.generateTexture('particle_circle', 16, 16);
            g.destroy();
        }

        if (!this.scene.textures.exists('particle_square')) {
            const g = this.scene.add.graphics();
            g.fillStyle(0xffffff, 1);
            g.fillRect(0, 0, 16, 16);
            g.generateTexture('particle_square', 16, 16);
            g.destroy();
        }
        
        if (!this.scene.textures.exists('particle_glow')) {
             const g = this.scene.add.graphics();
             // Simple radial gradient for glow
             for(let r=8; r>0; r--) {
                 g.fillStyle(0xffffff, r/8);
                 g.fillCircle(8, 8, r);
             }
             g.generateTexture('particle_glow', 16, 16);
             g.destroy();
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

        // Every particle system is per-frame dynamic FX — the pixel-snap
        // layer pass keeps smoke, fire, sparks, dust and debris in the
        // baked pixel world (one pass per emitter, five total).
        for (const emitter of [this.smokeEmitter, this.fireEmitter, this.sparkEmitter, this.dustEmitter, this.debrisEmitter]) {
            if (emitter) applyPixelSnap(this.scene, emitter);
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
        applyPixelSnap(this.scene, emitter);
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
