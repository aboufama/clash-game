import Phaser from 'phaser';
import { TILE_HEIGHT, TILE_WIDTH } from '../utils/IsoUtils';
import { BUILDING_DEFINITIONS, type BuildingType } from '../config/GameDefinitions';

/**
 * SpriteBank — the runtime half of the bake pipeline
 * (docs/AGENTS_SPRITE_PIPELINE.md).
 *
 * Loads the baked atlases + manifests from public/assets/sprites/ and swaps
 * every unit's per-frame vector drawing for baked-frame selection. The
 * integration is a SHADOW SPRITE: each existing carrier Graphics (buildings,
 * troops, wrecks, obstacles, ghosts) keeps its role as the position/depth/
 * lifecycle owner, but stays empty — a managed Image keyed to it shows the
 * baked frame. Nothing else in the scene changes: selection, destruction,
 * depth sorting and battle logic all keep operating on the carrier.
 *
 * Frame selection mirrors the sim exactly:
 *  - aim: continuous sim angle → nearest of the baked angles (CoC snap)
 *  - fire/charge: time − lastFireTime (or chargeStart) → nearest baked age
 *  - troops: state from isMoving/attackAge/drivers; direction octant from
 *    facingAngle; walk phase from the troop's real stride
 *  - ambient idle loops replay at the measured period (global time-synced,
 *    exactly like the old per-frame vector animation)
 *
 * Kill switch: localStorage 'clash.sprites.off' = '1' falls back to vectors.
 */

interface FrameMeta {
    file: string;
    texelW: number;
    texelH: number;
    cellWorldPx: number;
    originX: number;
    originY: number;
    ov?: Record<string, number | boolean>;
    state?: string;
    frame?: number;
    time?: number;
    attackAge?: number;
    isMoving?: boolean;
    slamOffset?: number;
    phalanxSpearOffset?: number;
    mortarRecoil?: number;
    deactivated?: boolean;
}

interface BuildingStateEntry {
    angles: number;
    loopMs?: number;
    frames: FrameMeta[][]; // [angleIdx][frameIdx]
}

interface BuildingLevelEntry {
    ground?: FrameMeta;
    states?: Record<string, BuildingStateEntry>;
    variants?: Record<string, BuildingLevelEntry>;
}

interface BuildingManifest {
    cellWorldPx: number;
    angles: number;
    levels: Record<string, BuildingLevelEntry>;
}

interface TroopDirEntry { dir: number; facing: number; frames: FrameMeta[] }
interface TroopManifest {
    cellWorldPx: number;
    params: {
        stride: number; delay: number; windup: number; strike: number; dirs: number;
        idleLoopMs: number;
        attackDriver?: { key: string; values: number[] };
    };
    levels: Record<string, Record<'P' | 'E', TroopDirEntry[]>>;
}

interface WreckManifest { cellWorldPx: number; levels: Record<string, { ground?: FrameMeta; body?: FrameMeta }> }
interface ObstacleManifest { cellWorldPx: number; buckets: number; loopMs: number | null; variants: Array<{ frames: FrameMeta[] } | null> }

interface UnitRecord {
    kind: string;
    unit: string;
    atlasKey: string;
    manifest: BuildingManifest | TroopManifest | WreckManifest | ObstacleManifest;
}

const fnv = (id: string): number => {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
};

class SpriteBankImpl {
    enabled = true;
    ready = false;
    private units = new Map<string, UnitRecord>();
    /** Carrier graphics → its shadow images (body + optional ground decal). */
    private shadows = new Map<Phaser.GameObjects.Graphics, { body?: Phaser.GameObjects.Image; ground?: Phaser.GameObjects.Image }>();
    private lastSweep = 0;

    /** Kick off loading; call from scene create(). Safe to call once. */
    init(scene: Phaser.Scene) {
        try {
            if (localStorage.getItem('clash.sprites.off') === '1') { this.enabled = false; return; }
        } catch { /* storage unavailable → stay enabled */ }
        if (this.ready || this.units.size > 0) return;
        fetch('/assets/sprites/index.json')
            .then(r => (r.ok ? r.json() : null))
            .then(async (index: { units: Array<{ kind: string; unit: string; atlas: string; frames: string; manifest: string }> } | null) => {
                if (!index || !scene.scene.isActive()) { this.enabled = false; return; }
                for (const u of index.units) {
                    const atlasKey = `bank:${u.kind}:${u.unit}`;
                    scene.load.atlas(atlasKey, `/assets/sprites/${u.atlas}`, `/assets/sprites/${u.frames}`);
                    scene.load.json(`${atlasKey}:man`, `/assets/sprites/${u.manifest}`);
                }
                scene.load.once(Phaser.Loader.Events.COMPLETE, () => {
                    for (const u of index.units) {
                        const atlasKey = `bank:${u.kind}:${u.unit}`;
                        const manifest = scene.cache.json.get(`${atlasKey}:man`);
                        if (!manifest || !scene.textures.exists(atlasKey)) continue;
                        this.units.set(`${u.kind}:${u.unit}`, { kind: u.kind, unit: u.unit, atlasKey, manifest });
                    }
                    this.ready = this.units.size > 0;
                    console.info(`SpriteBank: ${this.units.size} unit atlases live`);
                });
                scene.load.start();
            })
            .catch(() => { this.enabled = false; });
    }

    private unitOf(kind: string, unit: string): UnitRecord | null {
        return this.units.get(`${kind}:${unit}`) ?? null;
    }

    backed(kind: string, unit: string): boolean {
        return this.enabled && this.ready && this.units.has(`${kind}:${unit}`);
    }

    // ------------------------------------------------------------ shadows --

    private shadowFor(scene: Phaser.Scene, carrier: Phaser.GameObjects.Graphics, atlasKey: string, slot: 'body' | 'ground'): Phaser.GameObjects.Image {
        let rec = this.shadows.get(carrier);
        if (!rec) { rec = {}; this.shadows.set(carrier, rec); }
        let img = rec[slot];
        if (!img || !img.scene) {
            img = scene.add.image(0, 0, atlasKey);
            rec[slot] = img;
        }
        return img;
    }

    /** Remove shadows whose carrier died. Call ~1 Hz from the scene update. */
    sweep(time: number) {
        if (time - this.lastSweep < 1000) return;
        this.lastSweep = time;
        for (const [carrier, rec] of this.shadows) {
            if (!carrier.scene || !carrier.active) {
                rec.body?.destroy();
                rec.ground?.destroy();
                this.shadows.delete(carrier);
            }
        }
    }

    /** Hide + drop the shadows for a carrier (when falling back to vector). */
    release(carrier: Phaser.GameObjects.Graphics) {
        const rec = this.shadows.get(carrier);
        if (rec) {
            rec.body?.destroy();
            rec.ground?.destroy();
            this.shadows.delete(carrier);
        }
    }

    private stamp(
        scene: Phaser.Scene,
        carrier: Phaser.GameObjects.Graphics,
        atlasKey: string,
        meta: FrameMeta,
        x: number,
        y: number,
        opts: { alpha?: number; tint?: number | null; depth?: number; slot?: 'body' | 'ground' } = {}
    ) {
        const img = this.shadowFor(scene, carrier, atlasKey, opts.slot ?? 'body');
        if (img.texture.key !== atlasKey) img.setTexture(atlasKey, meta.file);
        else if (img.frame.name !== meta.file) img.setFrame(meta.file);
        img.setPosition(x, y)
            .setOrigin(meta.originX, meta.originY)
            .setScale(meta.cellWorldPx)
            .setDepth(opts.depth ?? carrier.depth)
            .setAlpha((opts.alpha ?? 1) * carrier.alpha)
            .setVisible(carrier.visible);
        if (opts.tint != null) img.setTint(opts.tint);
        else img.clearTint();
        return img;
    }

    // ---------------------------------------------------------- buildings --

    private buildingEntry(type: string, level: number, wallTag?: string): { entry: BuildingLevelEntry; atlasKey: string; man: BuildingManifest } | null {
        const rec = this.unitOf('buildings', type);
        if (!rec) return null;
        const man = rec.manifest as BuildingManifest;
        const levels = Object.keys(man.levels).map(Number);
        const lv = man.levels[level] ? level : Math.max(...levels.filter(l => l <= level), Math.min(...levels));
        let entry = man.levels[lv];
        if (!entry) return null;
        if (entry.variants) {
            entry = entry.variants[wallTag ?? 'm0'] ?? entry.variants.m0;
            if (!entry) return null;
        }
        return { entry, atlasKey: rec.atlasKey, man };
    }

    /** The wall variant tag for a neighbor topology (+ gate). */
    wallTag(n: { nN: boolean; nE: boolean; nS: boolean; nW: boolean }, isGate: boolean): string {
        const base = `m${['N', 'E', 'S', 'W'].filter((_, i) => [n.nN, n.nE, n.nS, n.nW][i]).join('') || '0'}`;
        if (isGate && base === 'mNS') return 'mNS_gate';
        if (isGate && base === 'mEW') return 'mEW_gate';
        return base;
    }

    /** Pick the frame for a building's CURRENT state. */
    pickBuildingFrame(
        type: string,
        level: number,
        building: {
            ballistaAngle?: number; lastFireTime?: number;
            teslaCharging?: boolean; teslaChargeStart?: number; teslaCharged?: boolean;
            fillLevel?: number; doorOpen?: number;
        } | undefined,
        time: number,
        opts: { wallTag?: string; jukeboxPlaying?: boolean } = {}
    ): { meta: FrameMeta; atlasKey: string; ground?: FrameMeta } | null {
        const found = this.buildingEntry(type, level, opts.wallTag);
        if (!found?.entry.states?.idle) return null;
        const { entry, atlasKey } = found;
        const st = entry.states as Record<string, BuildingStateEntry>;
        const nAngles = st.idle.angles;
        const angle = building?.ballistaAngle ?? 0;
        const TAU = Math.PI * 2;
        const aIdx = nAngles > 1 ? ((Math.round(((angle % TAU) + TAU) % TAU / (TAU / nAngles)) % nAngles) + nAngles) % nAngles : 0;

        const nearest = (frames: FrameMeta[], key: string, value: number): FrameMeta => {
            let best = frames[0], bestD = Infinity;
            for (const f of frames) {
                const v = Number(f.ov?.[key] ?? 0);
                const d = Math.abs(v - value);
                if (d < bestD) { bestD = d; best = f; }
            }
            return best;
        };

        // Fire animation window (recoil/tension/reload) — time since the shot.
        if (st.fire && building?.lastFireTime) {
            const el = time - building.lastFireTime;
            const frames = st.fire.frames[Math.min(aIdx, st.fire.frames.length - 1)];
            const maxAge = Number(frames[frames.length - 1]?.ov?.fireAge ?? 0) + 180;
            if (el >= 0 && el < maxAge) {
                return { meta: nearest(frames, 'fireAge', el), atlasKey, ground: entry.ground };
            }
        }
        // Tesla charge cycle.
        if (st.charge && building?.teslaCharging) {
            const el = time - (building.teslaChargeStart ?? time);
            return { meta: nearest(st.charge.frames[0], 'chargeAge', el), atlasKey, ground: entry.ground };
        }
        if (st.charged && building?.teslaCharged) {
            return { meta: st.charged.frames[0][0], atlasKey, ground: entry.ground };
        }
        // Producer fill stages (idle bakes full).
        if (st.fill && building && (building.fillLevel ?? 1) < 0.84) {
            return { meta: nearest(st.fill.frames[0], 'fillLevel', building.fillLevel ?? 1), atlasKey, ground: entry.ground };
        }
        // Door swing.
        if (st.door && building && (building.doorOpen ?? 0) > 0.05) {
            return { meta: nearest(st.door.frames[0], 'doorOpen', building.doorOpen ?? 0), atlasKey, ground: entry.ground };
        }
        // Jukebox playing loop.
        if (st.playing && opts.jukeboxPlaying) {
            const frames = st.playing.frames[0];
            return { meta: frames[Math.floor(time / 400) % frames.length], atlasKey, ground: entry.ground };
        }
        // Ambient idle (loops at the measured period; global-time-synced like
        // the old vector animation).
        const idle = st.idle.frames[aIdx] ?? st.idle.frames[0];
        if (st.idle.loopMs && idle.length > 1) {
            const k = Math.floor(((time % st.idle.loopMs) / st.idle.loopMs) * idle.length) % idle.length;
            return { meta: idle[k], atlasKey, ground: entry.ground };
        }
        return { meta: idle[0], atlasKey, ground: entry.ground };
    }

    /** Shadow-stamp a building body; returns false → caller draws vector. */
    syncBuilding(
        scene: Phaser.Scene,
        carrier: Phaser.GameObjects.Graphics,
        gridX: number,
        gridY: number,
        type: string,
        level: number,
        alpha: number,
        tint: number | null,
        building: Parameters<SpriteBankImpl['pickBuildingFrame']>[2],
        time: number,
        opts: { wallTag?: string; jukeboxPlaying?: boolean } = {}
    ): boolean {
        if (!this.backed('buildings', type)) return false;
        const pick = this.pickBuildingFrame(type, level, building, time, opts);
        if (!pick) return false;
        const def = BUILDING_DEFINITIONS[type as BuildingType];
        const cx = (gridX + (def?.width ?? 1) / 2 - (gridY + (def?.height ?? 1) / 2)) * (TILE_WIDTH / 2);
        const cy = (gridX + (def?.width ?? 1) / 2 + (gridY + (def?.height ?? 1) / 2)) * (TILE_HEIGHT / 2);
        this.stamp(scene, carrier, pick.atlasKey, pick.meta, cx, cy, { alpha, tint });
        // Walls never go through the ground bake (fully dynamic), so their
        // baked ground decal rides along as a second shadow just underneath.
        if (type === 'wall' && pick.ground) {
            this.stamp(scene, carrier, pick.atlasKey, pick.ground, cx, cy, { alpha, tint, depth: carrier.depth - 0.1, slot: 'ground' });
        }
        return true;
    }

    /** The building's baked ground decal (for the ground RT bake). */
    buildingGround(type: string, level: number, wallTag?: string): { atlasKey: string; meta: FrameMeta } | null {
        if (!this.backed('buildings', type)) return null;
        const found = this.buildingEntry(type, level, wallTag);
        if (!found?.entry.ground) return null;
        return { atlasKey: found.atlasKey, meta: found.entry.ground };
    }

    // ------------------------------------------------------------- troops --

    /** Frame selection for any troop-shaped thing (live troop, camp figure,
     * replay spawn) — state from drivers/attackAge/motion, direction octant,
     * stride-true walk phase, exact-loop idle breath. */
    pickTroopFrame(
        type: string,
        owner: 'PLAYER' | 'ENEMY',
        level: number,
        facingAngle: number,
        isMoving: boolean,
        attackAge: number,
        time: number,
        drivers: { attackDelay?: number; slamOffset?: number; phalanxSpearOffset?: number } = {}
    ): { meta: FrameMeta; atlasKey: string } | null {
        if (!this.backed('troops', type)) return null;
        const rec = this.unitOf('troops', type)!;
        const man = rec.manifest as TroopManifest;
        const levels = Object.keys(man.levels).map(Number);
        const lv = man.levels[level] ? level : Math.min(Math.max(...levels), Math.max(1, level));
        const ownerTag = owner === 'PLAYER' ? 'P' : 'E';
        const dirs = man.levels[lv]?.[ownerTag];
        if (!dirs) return null;
        const TAU = Math.PI * 2;
        const facing = ((facingAngle % TAU) + TAU) % TAU;
        const dIdx = man.params.dirs > 1 ? Math.round(facing / (TAU / man.params.dirs)) % man.params.dirs : 0;
        const frames = dirs[dIdx]?.frames ?? dirs[0].frames;
        const by = (state: string) => frames.filter(f => f.state === state);

        let meta: FrameMeta | undefined;
        const driver = man.params.attackDriver;
        if (driver) {
            const value = Number((drivers as Record<string, unknown>)[driver.key] ?? 0);
            if (value > 0.03) {
                const atk = by('attack');
                let best = atk[0], bestD = Infinity;
                for (const f of atk) {
                    const v = Number((f as unknown as Record<string, unknown>)[driver.key] ?? 0);
                    const d = Math.abs(v - value);
                    if (d < bestD) { bestD = d; best = f; }
                }
                meta = best;
            }
        }
        if (!meta && attackAge >= 0 && man.params.delay > 0) {
            const delay = drivers.attackDelay || man.params.delay;
            let age = attackAge;
            if (age > delay + 600) age = time % delay; // replay free-run, mirrors attackAnim
            const inWindup = delay - age <= man.params.windup + 60;
            const inStrike = age <= (man.params.strike || 60) + 120;
            if (inWindup || inStrike) {
                const atk = by('attack');
                if (atk.length) {
                    let best = atk[0], bestD = Infinity;
                    for (const f of atk) {
                        const d = Math.abs((f.attackAge ?? 0) - age);
                        if (d < bestD) { bestD = d; best = f; }
                    }
                    meta = best;
                }
            }
        }
        if (!meta && isMoving) {
            const walk = by('walk');
            if (walk.length) meta = walk[Math.floor(((time % man.params.stride) / man.params.stride) * walk.length) % walk.length];
        }
        if (!meta) {
            const idle = by('idle');
            if (!idle.length) return null;
            const loop = man.params.idleLoopMs || 4021;
            meta = idle[Math.floor(((time % loop) / loop) * idle.length) % idle.length];
        }
        return { meta, atlasKey: rec.atlasKey };
    }

    /** Shadow-stamp a troop; returns false → caller draws vector. */
    syncTroop(
        scene: Phaser.Scene,
        troop: {
            type: string; owner: 'PLAYER' | 'ENEMY'; level?: number;
            gameObject: Phaser.GameObjects.Graphics;
            facingAngle?: number; lastAttackTime?: number; attackDelay?: number;
            slamOffset?: number; phalanxSpearOffset?: number;
        },
        isMoving: boolean,
        attackAge: number,
        time: number
    ): boolean {
        const pick = this.pickTroopFrame(
            troop.type, troop.owner, troop.level ?? 1, troop.facingAngle ?? 0,
            isMoving, attackAge, time,
            { attackDelay: troop.attackDelay, slamOffset: troop.slamOffset, phalanxSpearOffset: troop.phalanxSpearOffset }
        );
        if (!pick) return false;
        this.stamp(scene, troop.gameObject, pick.atlasKey, pick.meta, troop.gameObject.x, troop.gameObject.y, {});
        return true;
    }

    /** Troop-sprite sync for loose figures (camp figures, spawn frames) whose
     * carrier graphics owns position/depth but has no Troop struct. */
    syncLooseTroop(
        scene: Phaser.Scene,
        carrier: Phaser.GameObjects.Graphics,
        type: string,
        owner: 'PLAYER' | 'ENEMY',
        level: number,
        facingAngle: number,
        isMoving: boolean,
        time: number,
        flipX = false
    ): boolean {
        const pick = this.pickTroopFrame(type, owner, level, facingAngle, isMoving, -1, time);
        if (!pick) return false;
        const img = this.stamp(scene, carrier, pick.atlasKey, pick.meta, carrier.x, carrier.y, {});
        img.setFlipX(flipX);
        return true;
    }

    // ------------------------------------------------------ wrecks/obstacles --

    syncWreck(
        scene: Phaser.Scene,
        carrier: Phaser.GameObjects.Graphics,
        baseCarrier: Phaser.GameObjects.Graphics | undefined,
        type: string,
        level: number,
        gridX: number,
        gridY: number,
        width: number,
        height: number
    ): boolean {
        if (!this.backed('wrecks', type)) return false;
        const rec = this.unitOf('wrecks', type)!;
        const man = rec.manifest as WreckManifest;
        const entry = man.levels[level] ?? man.levels[1];
        if (!entry?.body) return false;
        const cx = (gridX + width / 2 - (gridY + height / 2)) * (TILE_WIDTH / 2);
        const cy = (gridX + width / 2 + (gridY + height / 2)) * (TILE_HEIGHT / 2);
        this.stamp(scene, carrier, rec.atlasKey, entry.body, cx, cy, {});
        if (entry.ground && baseCarrier) this.stamp(scene, baseCarrier, rec.atlasKey, entry.ground, cx, cy, {});
        return true;
    }

    syncObstacle(
        scene: Phaser.Scene,
        carrier: Phaser.GameObjects.Graphics,
        type: string,
        id: string | undefined,
        gridX: number,
        gridY: number,
        time: number
    ): boolean {
        if (!this.backed('obstacles', type)) return false;
        const rec = this.unitOf('obstacles', type)!;
        const man = rec.manifest as ObstacleManifest;
        const bucket = fnv(id ?? `${gridX},${gridY}`) % man.buckets;
        const variant = man.variants[bucket] ?? man.variants.find(Boolean);
        if (!variant?.frames.length) return false;
        let meta = variant.frames[0];
        if (man.loopMs && variant.frames.length > 1) {
            meta = variant.frames[Math.floor(((time % man.loopMs) / man.loopMs) * variant.frames.length) % variant.frames.length];
        }
        const cx = (gridX + 0.5 - (gridY + 0.5)) * (TILE_WIDTH / 2);
        const cy = (gridX + 0.5 + (gridY + 0.5)) * (TILE_HEIGHT / 2);
        this.stamp(scene, carrier, rec.atlasKey, meta, cx, cy, {});
        return true;
    }

    // ------------------------------------------------------- RT quantizer --

    /**
     * One-time pixel-quantize of a RenderTexture IN PLACE — the treatment for
     * world-glued layers (the ground bake, neighbour postcards): one texel per
     * cell, center-sampled, grid anchored to the RT itself. Zero per-frame
     * cost; the quantized texture pans rigidly with the world.
     */
    quantizeRenderTexture(scene: Phaser.Scene, rt: Phaser.GameObjects.RenderTexture, cell = 1.35, epoch = 0): void {
        const stampKey = `__pixelBaked` as const;
        const record = rt as unknown as Record<string, number | undefined>;
        if (record[stampKey] === epoch) return;
        record[stampKey] = epoch;
        rt.snapshot((img) => {
            if (!rt.scene || !(img instanceof HTMLImageElement)) return;
            const W = img.width, H = img.height;
            const cv = document.createElement('canvas');
            cv.width = W; cv.height = H;
            const ctx = cv.getContext('2d', { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(img, 0, 0);
            const src = ctx.getImageData(0, 0, W, H);
            const out = ctx.createImageData(W, H);
            // The RT is world-resolution; write each cell's CENTER sample to
            // every pixel of the cell (the removed shader's exact output).
            for (let cy = 0; cy < H; cy += cell) {
                const sy = Math.min(H - 1, Math.floor(cy + cell / 2));
                const y0 = Math.floor(cy), y1 = Math.min(H, Math.floor(cy + cell));
                for (let cx = 0; cx < W; cx += cell) {
                    const sx = Math.min(W - 1, Math.floor(cx + cell / 2));
                    const s = (sy * W + sx) * 4;
                    // Alpha snap keeps postcard/parcel edges hard (no halo).
                    const a = src.data[s + 3] < 128 ? 0 : 255;
                    const x0 = Math.floor(cx), x1 = Math.min(W, Math.floor(cx + cell));
                    for (let y = y0; y < y1; y++) {
                        for (let x = x0; x < x1; x++) {
                            const d = (y * W + x) * 4;
                            out.data[d] = src.data[s]; out.data[d + 1] = src.data[s + 1];
                            out.data[d + 2] = src.data[s + 2]; out.data[d + 3] = a;
                        }
                    }
                }
            }
            ctx.putImageData(out, 0, 0);
            const key = `bank:quant:${(rt as unknown as { name?: string }).name ?? 'rt'}:${Date.now()}`;
            scene.textures.addCanvas(key, cv);
            rt.clear();
            const tmp = scene.make.image({ key }, false).setOrigin(0, 0);
            rt.draw(tmp, 0, 0);
            tmp.destroy();
            scene.textures.remove(key);
        });
    }
}

export const SpriteBank = new SpriteBankImpl();
