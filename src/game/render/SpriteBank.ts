import Phaser from 'phaser';
import { TILE_HEIGHT, TILE_WIDTH } from '../utils/IsoUtils';
import { BUILDING_DEFINITIONS, type BuildingType } from '../config/GameDefinitions';
import { registerPixelSurface } from '../renderers/TextureRenderPolicy';
import { ObstacleRenderer } from '../renderers/ObstacleRenderer';

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
 *  - ambient idle loops replay at the measured period, de-phased per entity
 *    by a stable id hash (deterministic in time, never in lockstep)
 *
 * Shadows are RECONCILED each frame: SpriteBank.update() (end of the scene
 * update, every mode) re-copies position/depth/alpha/visibility/scale from
 * every live carrier through the binding its last stamp recorded — carriers
 * that move, fade, hide or tween between stamps keep their sprite honest.
 *
 * Atlas sampling is governed by TextureRenderPolicy's PixelMode: every
 * 'bank:*' texture is registered as a pixel surface (NEAREST outside legacy).
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
interface ObstacleManifest {
    cellWorldPx: number;
    buckets: number;
    /** grass_patch only: 'look' = variants indexed by
     *  ObstacleRenderer.grassLookOf(id).variant, NOT hash % buckets —
     *  gameplay keys off the look, so the sprite must match it exactly. */
    axis?: 'look';
    loopMs: number | null;
    variants: Array<{ frames: FrameMeta[] } | null>;
    /** grass_patch only: explicit easter-egg variants keyed '0'..'3'. */
    eggs?: Record<string, { frames: FrameMeta[] }>;
}

/** Figures (villagers/animals/world figures/projectiles): identity variants
 *  keyed by string, each with named states of phase-sampled frames. */
interface FigureStateEntry { loopMs: number | null; frames: FrameMeta[] }
interface FigureManifest {
    cellWorldPx: number;
    unit: string;
    variants: Record<string, { states: Record<string, FigureStateEntry> }>;
}

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

/** Missing-bake fallbacks warn once per unit/variant/state (dev only). */
const warnedFigureStates = new Set<string>();

/** Everything update() needs to re-derive a shadow's render state from its
 *  carrier between stamps — stamp() records it, update() replays it. */
interface ShadowBinding {
    /** Stamp anchor relative to the carrier (0 for carriers that own position). */
    dx: number;
    dy: number;
    /** Figure stamps: snap (carrier + offset) to this texel grid. Presence also
     *  selects figure semantics — fixed bake scale, no carrier-flip fold-in
     *  (figures bake at final world scale; the carrier's own scale/mirror
     *  belongs to its vector overlays and fallback art). */
    snapCell?: number;
    /** carrier.depth − stamped depth at stamp time (stays valid when stale). */
    depthBias: number;
    alphaMul: number;
    scaleMul: number;
    cellWorldPx: number;
    flipX: boolean;
    originX: number;
    originY: number;
}

interface ShadowRec {
    body?: Phaser.GameObjects.Image;
    ground?: Phaser.GameObjects.Image;
    bodyBind?: ShadowBinding;
    groundBind?: ShadowBinding;
    /** Carrier-level status tint (chill etc.) — Graphics has no setTint, so
     *  effects plumb theirs through setCarrierTint; sticky across stamps. */
    tint?: number | null;
}

class SpriteBankImpl {
    enabled = true;
    ready = false;
    private units = new Map<string, UnitRecord>();
    /** Design-variant slots present in the bank: 'kind:unit' → slots (sorted).
     *  Populated from '@'-tagged atlas dirs ('cannon@A') at load time. */
    private variantSlots = new Map<string, string[]>();
    /** Carrier graphics → its shadow images (body + optional ground decal). */
    private shadows = new Map<Phaser.GameObjects.Graphics, ShadowRec>();
    /** Carriers that already have a DESTROY→release hook. release() drops the
     *  shadow rec but NOT the hook (once-listeners persist until the carrier
     *  dies), so re-hooking on every fallback→re-sync cycle would accumulate
     *  one closure per cycle on long-lived carriers. */
    private hooked = new WeakSet<Phaser.GameObjects.Graphics>();
    private lastSweep = 0;

    /** Kick off loading; call from scene create(). Safe to call once. */
    init(scene: Phaser.Scene) {
        try {
            if (localStorage.getItem('clash.sprites.off') === '1') { this.enabled = false; return; }
        } catch { /* storage unavailable → stay enabled */ }
        if (this.ready || this.units.size > 0) {
            // Dev-HMR hazard: a hot update that re-creates the Phaser game
            // hands us a FRESH TextureManager while this module singleton
            // still says ready — stale atlas keys would stamp __MISSING
            // green boxes over every unit (worse than the vector fallback).
            // Detect the empty manager and reload the bank into it; the
            // 'spritebank:ready' emit below re-busts the scene's draw caches.
            const stale = [...this.units.values()].some(u => !scene.textures.exists(u.atlasKey));
            if (!stale) return;
            this.ready = false;
            this.units.clear();
            this.variantSlots.clear();
            this.shadows.clear();
        }
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
                        // Baked atlases must follow the active PixelMode (NEAREST outside legacy).
                        registerPixelSurface(scene.textures.get(atlasKey));
                        this.units.set(`${u.kind}:${u.unit}`, { kind: u.kind, unit: u.unit, atlasKey, manifest });
                        // Design-variant bakes live in '@'-tagged sibling dirs
                        // ('cannon@A') and load as ordinary units; record the
                        // slot so resolveVariantUnit can route the plain name.
                        const at = u.unit.indexOf('@');
                        if (at > 0) {
                            const key = `${u.kind}:${u.unit.slice(0, at)}`;
                            const slots = this.variantSlots.get(key) ?? [];
                            slots.push(u.unit.slice(at + 1));
                            this.variantSlots.set(key, slots.sort());
                        }
                    }
                    this.ready = this.units.size > 0;
                    console.info(`SpriteBank: ${this.units.size} unit atlases live`);
                    // Anything painted before this moment fell back to vector.
                    // Most surfaces repaint themselves every few frames, but
                    // one-shot art (walls!) never would — announce readiness
                    // so the scene can force one full repaint.
                    if (this.ready) scene.events.emit('spritebank:ready');
                });
                scene.load.start();
            })
            .catch(() => { this.enabled = false; });
    }

    /**
     * Design-variant resolution — the ONE place a plain unit name becomes its
     * '@slot'-tagged bake. When variant atlases exist for `kind:unit` (baked
     * into sibling '<unit>@<slot>' dirs), the plain name transparently means
     * the ACTIVE variant: localStorage['clash.design.<unit>'] when that slot
     * is baked, else 'A', else the first baked slot. The key is re-read per
     * call — the exact semantics of the vector path's DesignRegistry, so the
     * baked and fallback art always agree (and a console localStorage poke
     * takes effect on the next stamp). Units with no variant bakes (wrecks,
     * figures, every non-tournament unit) resolve to themselves.
     */
    resolveVariantUnit(kind: string, unit: string): string {
        if (unit.indexOf('@') >= 0) return unit; // already slot-qualified
        const slots = this.variantSlots.get(`${kind}:${unit}`);
        if (!slots || slots.length === 0) return unit;
        let picked: string | null = null;
        try {
            if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
                const v = window.localStorage.getItem(`clash.design.${unit}`);
                if (v && slots.includes(v)) picked = v;
            }
        } catch {
            // Storage unavailable — fall through to the default slot.
        }
        return `${unit}@${picked ?? (slots.includes('A') ? 'A' : slots[0])}`;
    }

    /** EVERY unit lookup routes through the variant resolver (unitOf + backed
     *  are the only two doors into this.units), so buildings, troops, wrecks,
     *  figures and obstacles all pick up '@slot' bakes automatically. */
    private unitOf(kind: string, unit: string): UnitRecord | null {
        return this.units.get(`${kind}:${this.resolveVariantUnit(kind, unit)}`) ?? null;
    }

    backed(kind: string, unit: string): boolean {
        return this.enabled && this.ready && this.units.has(`${kind}:${this.resolveVariantUnit(kind, unit)}`);
    }

    // ------------------------------------------------------------ shadows --

    private shadowFor(scene: Phaser.Scene, carrier: Phaser.GameObjects.Graphics, atlasKey: string, slot: 'body' | 'ground'): Phaser.GameObjects.Image {
        let rec = this.shadows.get(carrier);
        if (!rec) {
            rec = {};
            this.shadows.set(carrier, rec);
            // Transients (projectiles) die between 1 Hz sweeps — release with
            // the carrier so no stamped frame outlives its owner. Hook at most
            // once per carrier: release() (vector fallback) deletes the rec
            // but the once-listener stays armed, so re-hooking here on every
            // fallback→re-sync cycle would pile up duplicate closures.
            if (!this.hooked.has(carrier)) {
                this.hooked.add(carrier);
                carrier.once(Phaser.GameObjects.Events.DESTROY, () => this.release(carrier));
            }
        }
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
        opts: { alpha?: number; tint?: number | null; depth?: number; slot?: 'body' | 'ground'; scaleMul?: number; flipX?: boolean; snapCell?: number } = {}
    ) {
        const slot = opts.slot ?? 'body';
        const img = this.shadowFor(scene, carrier, atlasKey, slot);
        if (img.texture.key !== atlasKey) img.setTexture(atlasKey, meta.file);
        else if (img.frame.name !== meta.file) img.setFrame(meta.file);
        // Record the carrier-relative render state so update() can reconcile
        // the shadow every frame between stamps (tweens, hiding, movement).
        const rec = this.shadows.get(carrier)!;
        const bind: ShadowBinding = {
            dx: x - carrier.x,
            dy: y - carrier.y,
            snapCell: opts.snapCell,
            depthBias: opts.depth !== undefined ? carrier.depth - opts.depth : 0,
            alphaMul: opts.alpha ?? 1,
            scaleMul: opts.scaleMul ?? 1,
            cellWorldPx: meta.cellWorldPx,
            flipX: opts.flipX ?? false,
            originX: meta.originX,
            originY: meta.originY
        };
        rec[slot === 'body' ? 'bodyBind' : 'groundBind'] = bind;
        // Status tint (chill) is carrier-level and sticky; a per-stamp tint wins.
        const tint = opts.tint ?? (slot === 'body' ? rec.tint : null) ?? null;
        if (tint != null) img.setTint(tint);
        else img.clearTint();
        this.apply(carrier, img, bind);
        return img;
    }

    /** Copy the carrier's live render state onto a shadow through its binding.
     *  stamp() and update() share this, so a reconciled frame is identical to
     *  a freshly stamped one. */
    private apply(carrier: Phaser.GameObjects.Graphics, img: Phaser.GameObjects.Image, bind: ShadowBinding) {
        let x = carrier.x + bind.dx;
        let y = carrier.y + bind.dy;
        if (bind.snapCell) {
            // Figures: texel-grid snap + fixed bake scale — they bake at final
            // world scale, and the carrier's own scale/mirror belongs to its
            // vector overlays (chat bubbles) and fallback art.
            x = Math.round(x / bind.snapCell) * bind.snapCell;
            y = Math.round(y / bind.snapCell) * bind.snapCell;
            img.setScale(bind.cellWorldPx * bind.scaleMul);
        } else {
            // Everything else rides the carrier's scale so spawn bounces
            // and squish tweens survive on the baked path.
            // The SIGN stays out of flipX: multi-dir bakes carry facing in the
            // frame itself, and every flip request arrives already resolved.
            img.setScale(
                bind.cellWorldPx * bind.scaleMul * Math.abs(carrier.scaleX),
                bind.cellWorldPx * bind.scaleMul * Math.abs(carrier.scaleY)
            );
        }
        // Frames crop tight per frame, so a mirror without an origin
        // reflection lands up to half a frame wide of its anchor (shepherd
        // drifts −9.7..−13.8 px across the gait) — reflect the origin so the
        // flip pivots on the baked anchor.
        img.setOrigin(bind.flipX ? 1 - bind.originX : bind.originX, bind.originY);
        if (img.flipX !== bind.flipX) img.setFlipX(bind.flipX);
        // Guard depth: Phaser's depth setter queues a full display-list sort
        // on EVERY write, and this runs per shadow per frame — unguarded it
        // forces a whole-scene re-sort even on frames where nothing moved.
        const depth = carrier.depth - bind.depthBias;
        if (img.depth !== depth) img.setDepth(depth);
        img.setPosition(x, y)
            .setAlpha(bind.alphaMul * carrier.alpha)
            .setVisible(carrier.visible);
        // Blend rides along (the dragon shadow is a MULTIPLY pass, e.g.).
        if (img.blendMode !== carrier.blendMode) img.setBlendMode(carrier.blendMode);
    }

    /** Per-frame carrier→shadow reconciliation (+ the 1 Hz reap): copies
     *  position, depth, alpha, visibility and scale from every live carrier.
     *  Call once at the END of the scene update in every mode — nothing else
     *  propagates carrier changes (hide-inside fades, night hiding, move-carry
     *  hiding, off-screen walking) to the baked sprite between stamps. */
    update(time: number) {
        for (const [carrier, rec] of this.shadows) {
            if (!carrier.scene || !carrier.active) continue; // reaped by sweep below
            if (rec.body?.scene && rec.bodyBind) this.apply(carrier, rec.body, rec.bodyBind);
            if (rec.ground?.scene && rec.groundBind) this.apply(carrier, rec.ground, rec.groundBind);
        }
        this.sweep(time);
    }

    /** Status tint for a carrier's body shadow (chill etc.) — Graphics has no
     *  tint of its own, so effects plumb theirs through here. Sticky across
     *  re-stamps until cleared with null. */
    setCarrierTint(carrier: Phaser.GameObjects.Graphics, tint: number | null) {
        const rec = this.shadows.get(carrier);
        if (!rec) return;
        rec.tint = tint;
        if (rec.body?.scene) {
            if (tint != null) rec.body.setTint(tint);
            else rec.body.clearTint();
        }
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

    /** The wall variant tag for a neighbor topology. */
    wallTag(n: { nN: boolean; nE: boolean; nS: boolean; nW: boolean }): string {
        return `m${['N', 'E', 'S', 'W'].filter((_, i) => [n.nN, n.nE, n.nS, n.nW][i]).join('') || '0'}`;
    }

    /** Pick the frame for a building's CURRENT state. */
    pickBuildingFrame(
        type: string,
        level: number,
        building: {
            id?: string;
            ballistaAngle?: number; lastFireTime?: number;
            teslaCharging?: boolean; teslaChargeStart?: number; teslaCharged?: boolean;
            frostfallProjectileActive?: boolean;
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
        const angleIdx = (n: number) => n > 1 ? ((Math.round(((angle % TAU) + TAU) % TAU / (TAU / n)) % n) + n) % n : 0;
        const aIdx = angleIdx(nAngles);

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
            // A state can bake fewer angles than idle — re-quantize the aim to
            // its own count (a clamp collapsed every aim to the last angle).
            let frames = st.fire.frames[angleIdx(st.fire.angles || st.fire.frames.length)] ?? st.fire.frames[0];
            // Launch axis (frostfall): prep/abort and launch-FX frames overlap
            // in fireAge, disambiguated by the baked projectileActive flag —
            // restrict to the branch matching the sim so nearest-age never
            // mixes a geyser burst into an abort sink (or vice versa).
            if (frames.some(f => f.ov?.projectileActive !== undefined)) {
                const want = building.frostfallProjectileActive === true;
                const branch = frames.filter(f => (f.ov?.projectileActive === true) === want);
                if (branch.length > 0) frames = branch;
            }
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
        // Ambient idle (loops at the measured period), de-phased per building
        // by a stable id hash — a row of watchtowers must not scan in lockstep,
        // yet each one stays a deterministic function of time.
        const idle = st.idle.frames[aIdx] ?? st.idle.frames[0];
        if (st.idle.loopMs && idle.length > 1) {
            const tOff = building?.id ? fnv(building.id) : 0;
            const k = Math.floor((((time + tOff) % st.idle.loopMs) / st.idle.loopMs) * idle.length) % idle.length;
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
        // A hair below the carrier: overlays drawn INTO the carrier (patina)
        // must win the equal-depth tie the later-created image would take.
        this.stamp(scene, carrier, pick.atlasKey, pick.meta, cx, cy, { alpha, tint, depth: carrier.depth - 0.05 });
        // Walls never go through the ground bake (fully dynamic), so their
        // baked ground decal rides along as a second shadow just underneath.
        if (type === 'wall' && pick.ground) {
            this.stamp(scene, carrier, pick.atlasKey, pick.ground, cx, cy, { alpha, tint, depth: carrier.depth - 0.1, slot: 'ground' });
        }
        return true;
    }

    /** World px from the building's iso-center stamp anchor UP to the baked
     *  body's top edge, measured on the FIRST idle frame so it stays stable
     *  across the ambient loop. Health bars anchor on this instead of a blind
     *  height guess — squat sprites (walls, storages) sit far below the old
     *  formula, which left their bars floating over the tile behind them.
     *  null → not sprite-backed (caller falls back to the formula). */
    buildingTopOffset(type: string, level: number, wallTag?: string): number | null {
        if (!this.backed('buildings', type)) return null;
        const found = this.buildingEntry(type, level, wallTag);
        const idle = found?.entry.states?.idle?.frames[0]?.[0];
        if (!idle) return null;
        return idle.originY * idle.texelH * idle.cellWorldPx;
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
        drivers: { attackDelay?: number; slamOffset?: number; phalanxSpearOffset?: number; phaseId?: string; pose?: string } = {}
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
        // Stable per-entity clock offset — same-type troops must not stride,
        // breathe or free-run attacks in lockstep (deterministic, never random).
        const tOff = drivers.phaseId ? fnv(drivers.phaseId) : 0;

        // Explicit named pose (e.g. the da-vinci tank's baked 'deactivated'
        // husk): a timeless state outside the walk/attack/idle drivers.
        if (drivers.pose) {
            const posed = by(drivers.pose);
            if (!posed.length) return null;
            return { meta: posed[0], atlasKey: rec.atlasKey };
        }

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
            if (age > delay + 600) age = (time + tOff) % delay; // replay free-run, mirrors attackAnim
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
            if (walk.length) meta = walk[Math.floor((((time + tOff) % man.params.stride) / man.params.stride) * walk.length) % walk.length];
        }
        if (!meta) {
            const idle = by('idle');
            if (!idle.length) return null;
            const loop = man.params.idleLoopMs || 4021;
            meta = idle[Math.floor((((time + tOff) % loop) / loop) * idle.length) % idle.length];
        }
        return { meta, atlasKey: rec.atlasKey };
    }

    /** Shadow-stamp a troop; returns false → caller draws vector. */
    syncTroop(
        scene: Phaser.Scene,
        troop: {
            id?: string;
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
            { attackDelay: troop.attackDelay, slamOffset: troop.slamOffset, phalanxSpearOffset: troop.phalanxSpearOffset, phaseId: troop.id }
        );
        if (!pick) return false;
        this.stamp(scene, troop.gameObject, pick.atlasKey, pick.meta, troop.gameObject.x, troop.gameObject.y, {});
        return true;
    }

    /** Stamp a named troop pose (e.g. the da-vinci tank's baked 'deactivated'
     *  husk) on a loose carrier; returns false → caller draws vector. The
     *  carrier keeps position/depth/alpha, so fade-out tweens ride along. */
    syncTroopPose(
        scene: Phaser.Scene,
        carrier: Phaser.GameObjects.Graphics,
        type: string,
        owner: 'PLAYER' | 'ENEMY',
        level: number,
        facingAngle: number,
        pose: string
    ): boolean {
        const pick = this.pickTroopFrame(type, owner, level, facingAngle, false, -1, 0, { pose });
        if (!pick) return false;
        this.stamp(scene, carrier, pick.atlasKey, pick.meta, carrier.x, carrier.y, {});
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
        // Multi-direction manifests carry facing in the frame itself (the
        // facingAngle already picked a west-facing frame); mirroring it again
        // would moonwalk the figure east. flipX only mirrors 1-dir bakes, and
        // rides the stamp so the flip pivots on the baked anchor and survives
        // per-frame reconciliation.
        const dirs = (this.unitOf('troops', type)!.manifest as TroopManifest).params.dirs;
        this.stamp(scene, carrier, pick.atlasKey, pick.meta, carrier.x, carrier.y, { flipX: dirs > 1 ? false : flipX });
        return true;
    }

    // ------------------------------------------------------------ figures --

    /** Frame pick for a baked figure (villager/animal/world figure/projectile).
     *  `phase` is the caller's own 0..1 animation phase — computed with the
     *  exact formula the vector draw used, so sprite and vector stay in step. */
    pickFigureFrame(
        kind: string,
        unit: string,
        variant: string,
        state: string,
        phase: number
    ): { meta: FrameMeta; atlasKey: string } | null {
        if (!this.backed(kind, unit)) return null;
        const rec = this.unitOf(kind, unit)!;
        const man = rec.manifest as unknown as FigureManifest;
        const v = man.variants?.[variant];
        if (!v) return null;
        let st = v.states[state];
        if (!st && state !== 'idle') {
            // Un-baked carry/walk cycles degrade to the plain gait before
            // idle — a hauler must not glide across the village in an idle
            // pose. The proper cure is a re-bake; warn once so it happens.
            if (state.includes('walk')) st = v.states.walk;
            if (!st) st = v.states.idle;
            if (import.meta.env.DEV) {
                const key = `${kind}:${unit}:${variant}:${state}`;
                if (!warnedFigureStates.has(key)) {
                    warnedFigureStates.add(key);
                    console.warn(`SpriteBank: no baked state '${state}' for ${kind}/${unit}/${variant} — falling back (re-bake to cure)`);
                }
            }
        }
        if (!st || st.frames.length === 0) return null;
        const p = ((phase % 1) + 1) % 1;
        const meta = st.frames[Math.floor(p * st.frames.length) % st.frames.length];
        return { meta, atlasKey: rec.atlasKey };
    }

    /** Whether a baked figure variant actually contains this state — call
     *  sites pick an honest nearby state (e.g. plain 'walk' for a carry cycle
     *  the role never baked) instead of silently falling back to idle. */
    hasFigureState(kind: string, unit: string, variant: string, state: string): boolean {
        if (!this.backed(kind, unit)) return false;
        const man = this.unitOf(kind, unit)!.manifest as unknown as FigureManifest;
        const st = man.variants?.[variant]?.states?.[state];
        return Boolean(st && st.frames.length > 0);
    }

    /** Shadow-stamp a figure; returns false → caller draws vector. The carrier
     *  owns position/depth/alpha/visibility (translucent silhouettes like the
     *  owl/dragon bake opaque and get their alpha back from the carrier). */
    syncFigure(
        scene: Phaser.Scene,
        carrier: Phaser.GameObjects.Graphics,
        unit: string,
        variant: string,
        state: string,
        phase: number,
        flipX = false,
        opts: { kind?: string; depthBias?: number; at?: { x: number; y: number }; scaleMul?: number } = {}
    ): boolean {
        const pick = this.pickFigureFrame(opts.kind ?? 'villagers', unit, variant, state, phase);
        if (!pick) return false;
        // depthBias sinks the sprite a hair below its carrier so overlays the
        // carrier still draws (chat bubbles) stay on top at equal depth. `at`
        // overrides position for carriers that draw in absolute coords.
        // Figure stamps SNAP to the texel grid (via the stored snapCell, so
        // reconciliation keeps snapping between stamps): figures step
        // cell-by-cell instead of gliding at sub-cell offsets — deliberately
        // a touch jagged, like everything else in the baked world.
        const cell = pick.meta.cellWorldPx || 1.35;
        this.stamp(scene, carrier, pick.atlasKey, pick.meta, opts.at?.x ?? carrier.x, opts.at?.y ?? carrier.y, {
            ...(opts.depthBias ? { depth: carrier.depth - opts.depthBias } : {}),
            ...(opts.scaleMul != null ? { scaleMul: opts.scaleMul } : {}),
            flipX,
            snapCell: cell
        });
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

    /** Baked-frame selection for an obstacle, shared by the live shadow-sprite
     *  path (syncObstacle) and static consumers that rasterize the frame
     *  themselves (the neighbour-postcard bake in WorldMapSystem, which must
     *  stamp CHUNKY baked trees into its RT instead of AA vector draws).
     *  Returns null when the type has no bake (or a rare un-baked egg look),
     *  in which case callers fall back to the vector renderer. */
    pickObstacleFrame(
        type: string,
        id: string | undefined,
        gridX: number,
        gridY: number,
        time: number
    ): { atlasKey: string; meta: FrameMeta } | null {
        if (!this.backed('obstacles', type)) return null;
        const rec = this.unitOf('obstacles', type)!;
        const man = rec.manifest as ObstacleManifest;
        const hash = fnv(id ?? `${gridX},${gridY}`);
        // Gameplay keys a grass patch's WHOLE look — egg and regular variant
        // alike — off the full id hash (ObstacleRenderer.grassLookOf), so the
        // sprite must be picked on that same axis: eggs first (baked as
        // explicit variants), then the 'look'-axis variant. A raw hash-bucket
        // pick disagreed — two ids in one bucket can carry different %12
        // looks, so a 'mushrooms' patch could render as tulips and mushroom
        // picking looked broken.
        const look = type === 'grass_patch' ? ObstacleRenderer.grassLookOf(id) : null;
        if (look?.egg != null && !man.eggs?.[look.egg]?.frames.length) {
            // Rare find with no baked egg variant (older bake): let the vector
            // path draw it — gameplay keys off grassLookOf, so painting a
            // regular look here would hide an egg the game still honors.
            return null;
        }
        const variant = (look?.egg != null ? man.eggs?.[look.egg] : undefined)
            ?? (look && man.axis === 'look' ? man.variants[look.variant] : undefined)
            ?? (man.axis === 'look' ? undefined : man.variants[hash % man.buckets])
            ?? man.variants.find(Boolean);
        if (!variant?.frames.length) return null;
        let meta = variant.frames[0];
        if (man.loopMs && variant.frames.length > 1) {
            // Per-instance ms phase offset (the same id-hash desync the
            // vector renderer applies) so same-bucket obstacles sway apart.
            const t = time + hash % man.loopMs;
            meta = variant.frames[Math.floor(((t % man.loopMs) / man.loopMs) * variant.frames.length) % variant.frames.length];
        }
        return { atlasKey: rec.atlasKey, meta };
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
        const pick = this.pickObstacleFrame(type, id, gridX, gridY, time);
        if (!pick) return false;
        const cx = (gridX + 0.5 - (gridY + 0.5)) * (TILE_WIDTH / 2);
        const cy = (gridX + 0.5 + (gridY + 0.5)) * (TILE_HEIGHT / 2);
        this.stamp(scene, carrier, pick.atlasKey, pick.meta, cx, cy, {});
        return true;
    }

    // ------------------------------------------------------- RT quantizer --

    /** Writers call this the moment they draw into an already-quantized RT:
     *  any in-flight snapshot callback then discards itself instead of
     *  restoring pre-write pixels over the new content, and the next
     *  quantize pass isn't deduped away by a matching epoch. */
    invalidateQuantize(rt: Phaser.GameObjects.RenderTexture) {
        delete (rt as unknown as Record<string, number | undefined>).__pixelBaked;
    }

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
        // Quantize a FULL-RT capture and write it back in place. Runs after
        // capture so the guards below can discard a pass that went stale
        // while in flight.
        const apply = (src: ImageData) => {
            if (!rt.scene) return;
            // A write landed (invalidateQuantize) or a newer pass started
            // while this capture was in flight — writing the stale capture
            // back would clobber that content. Discard; the bumped epoch has
            // a fresh pass queued.
            if (record[stampKey] !== epoch) return;
            const W = src.width, H = src.height;
            const cv = document.createElement('canvas');
            cv.width = W; cv.height = H;
            const ctx = cv.getContext('2d', { willReadFrequently: true });
            if (!ctx) return;
            const out = ctx.createImageData(W, H);
            // The RT is world-resolution; write each cell's CENTER sample to
            // every pixel of the cell (the removed shader's exact output),
            // grid anchored at the RT's own origin.
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
            // A full capture replaces the RT wholesale. A short capture (belt
            // and braces — both capture paths below are full-size) paints
            // over only the region it covered instead of ERASING the rest.
            if (W >= dt.width && H >= dt.height) rt.clear();
            const tmp = scene.make.image({ key }, false).setOrigin(0, 0);
            rt.draw(tmp, 0, 0);
            tmp.destroy();
            scene.textures.remove(key);
        };
        // Runtime is a DynamicTexture (the TS defs still say
        // CanvasTexture | Texture): renderTarget is set exactly in WebGL
        // mode, canvas/context exactly in Canvas mode.
        const dt = rt.texture as unknown as {
            width: number; height: number;
            renderTarget: object | null;
            canvas: HTMLCanvasElement | null;
            context: CanvasRenderingContext2D | null;
        };
        if (!dt.renderTarget && dt.canvas && dt.context) {
            // CANVAS renderer: Phaser clamps EVERY snapshot's width/height to
            // the GAME canvas (CanvasRenderer.snapshotArea does
            // Math.min(w, gameCanvas.width)), so on a window smaller than the
            // RT the capture came back cropped and the redraw erased all
            // paint beyond the window — the sharp-cornered wilderness wedge
            // and the ground-bake seams at canvas dimensions. The
            // DynamicTexture's backing canvas already holds every pixel:
            // read it whole — synchronously, matching snapshot's
            // capture-at-call timing — and apply on a microtask to keep the
            // async contract callers rely on.
            const src = dt.context.getImageData(0, 0, dt.canvas.width, dt.canvas.height);
            queueMicrotask(() => apply(src));
            return;
        }
        // WEBGL renderer: rt.snapshot reads the RT's OWN framebuffer and
        // clamps only to the RT's own dimensions
        // (WebGLRenderer.snapshotFramebuffer) — full coverage at any window
        // size. Do NOT tile via snapshotArea instead: partial framebuffer
        // grabs mis-address rows (verified live against Phaser 3.90).
        rt.snapshot((img) => {
            if (!rt.scene || !(img instanceof HTMLImageElement)) return;
            if (record[stampKey] !== epoch) return;
            const cap = document.createElement('canvas');
            cap.width = img.width; cap.height = img.height;
            const cctx = cap.getContext('2d', { willReadFrequently: true });
            if (!cctx) return;
            cctx.drawImage(img, 0, 0);
            apply(cctx.getImageData(0, 0, img.width, img.height));
        });
    }

    /**
     * Point-sample a (super-sampled) source RT down into a low-resolution RT:
     * ONE pure center sample per destination texel, alpha-snapped — the bake
     * harness's exact math (`sx = floor((i + 0.5) * srcW / dstW)`). This is
     * how a vector postcard earns REAL pixel-art texels: relying on the
     * renderer to scale the source down (even with a NEAREST filter request)
     * leaves the Canvas renderer free to area-average, which preserves every
     * AA gradient as soft multi-step ramps inside the texels. The source is
     * destroyed after capture. Same dual capture paths as the quantizer.
     */
    pointSampleRenderTexture(
        scene: Phaser.Scene,
        src: Phaser.GameObjects.RenderTexture,
        dst: Phaser.GameObjects.RenderTexture
    ): void {
        const apply = (cap: ImageData) => {
            if (!dst.scene) return;
            const W = cap.width, H = cap.height;
            const W2 = Math.max(1, Math.floor(dst.width));
            const H2 = Math.max(1, Math.floor(dst.height));
            const cv = document.createElement('canvas');
            cv.width = W2; cv.height = H2;
            const ctx = cv.getContext('2d', { willReadFrequently: true });
            if (!ctx) return;
            const out = ctx.createImageData(W2, H2);
            const cellX = W / W2;
            const cellY = H / H2;
            for (let j = 0; j < H2; j++) {
                const sy = Math.min(H - 1, Math.floor((j + 0.5) * cellY));
                for (let i = 0; i < W2; i++) {
                    const sx = Math.min(W - 1, Math.floor((i + 0.5) * cellX));
                    const s = (sy * W + sx) * 4;
                    const d = (j * W2 + i) * 4;
                    out.data[d] = cap.data[s];
                    out.data[d + 1] = cap.data[s + 1];
                    out.data[d + 2] = cap.data[s + 2];
                    // Alpha snap keeps the parcel silhouette hard (no halo).
                    out.data[d + 3] = cap.data[s + 3] < 128 ? 0 : 255;
                }
            }
            ctx.putImageData(out, 0, 0);
            const key = `bank:lod:${Date.now()}:${Math.random()}`;
            scene.textures.addCanvas(key, cv);
            dst.clear();
            const tmp = scene.make.image({ key }, false).setOrigin(0, 0);
            dst.draw(tmp, 0, 0);
            tmp.destroy();
            scene.textures.remove(key);
        };
        const sdt = src.texture as unknown as {
            renderTarget: object | null;
            canvas: HTMLCanvasElement | null;
            context: CanvasRenderingContext2D | null;
        };
        if (!sdt.renderTarget && sdt.canvas && sdt.context) {
            // CANVAS renderer: read the backing canvas whole (see the
            // quantizer's note on Phaser's snapshot clamping).
            const cap = sdt.context.getImageData(0, 0, sdt.canvas.width, sdt.canvas.height);
            src.destroy();
            queueMicrotask(() => apply(cap));
            return;
        }
        // WEBGL renderer: capture the source's own framebuffer, then drop it.
        src.snapshot((img) => {
            if (!(img instanceof HTMLImageElement)) { src.destroy(); return; }
            const cap = document.createElement('canvas');
            cap.width = img.width; cap.height = img.height;
            const cctx = cap.getContext('2d', { willReadFrequently: true });
            if (!cctx) { src.destroy(); return; }
            cctx.drawImage(img, 0, 0);
            const data = cctx.getImageData(0, 0, img.width, img.height);
            src.destroy();
            apply(data);
        });
    }
}

export const SpriteBank = new SpriteBankImpl();
