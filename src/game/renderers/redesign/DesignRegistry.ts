import type Phaser from 'phaser';
import type { WildernessPlotCtx, WildernessPut } from '../WildernessRenderer';

/**
 * CLEAN-ROOM DESIGN REGISTRY — live, unresolved design rounds.
 * (The cannon round is FINISHED: design B was promoted to canonical and left
 * the registry — see CannonB.ts. The golem round is FINISHED too: design C
 * won and is called directly by TroopRenderer.drawGolem — see GolemC.ts;
 * design B is the authoring base for the NEW 'icegolem' troop. The mortar
 * round ENDED WITH NO WINNER: all three designs were rejected and the
 * original vector art was restored as canonical — mortar no longer routes
 * through this registry.)
 *
 * The deadwood round is FINISHED (2026-07-18): design A "The Wind Road" won
 * the 2-variant wilderness-archetype round and was promoted to canonical —
 * WildernessRenderer's 'deadwood' ARCHETYPES entry calls deadwoodDesignA
 * directly (see ./DeadwoodA.ts); design B was rejected and removed.
 *
 * The faction-barracks round is FINISHED (2026-07-19): the owner approved
 * both clean-room rebuilds — 'Foundry Bastion' (`barracks` A, see
 * ./BarracksA.ts) and 'Athenaeum of War' (`mystic_barracks` A, see
 * ./Mystic_barracksA.ts) — and both were promoted to canonical:
 * FactionBarracksRenderer calls the winners directly, and neither unit
 * routes through this registry anymore.
 *
 * Isolated artist agents fill only the slots requested
 * for a round. An A-first fallback is only a deterministic preview choice,
 * never a winner designation. Rules:
 *  - Each artist inserts EXACTLY ONE import on their pre-seeded
 *    `// IMPORT <unit> <slot>` anchor line below, and replaces EXACTLY ONE
 *    `null` on their `// SLOT <unit> <slot>` anchor line with the imported fn.
 *  - Author designs as `export function` declarations (hoisted — safe if a
 *    design module ends up in an import cycle with a renderer) and keep the
 *    design module free of module-level side effects.
 *  - Do NOT touch any other slot, the types, or `activeDesign`.
 *
 * Slot selection is LIVE: `localStorage['clash.design.<unit>'] = 'A'|'B'|'C'`
 * is re-read on every draw call, so switching designs needs no reload beyond
 * the next redraw. With no (or an empty) selection the unit's JUDGED DEFAULT
 * slot wins (DEFAULT_DESIGN_SLOTS — the provisional judge-panel winners),
 * else the first non-null slot in A→B→C order; with all slots null the
 * caller falls back to its neutral placeholder.
 */

// ===== IMPORT ANCHORS — one import per artist, on your line only =====
// (cannon was PROMOTED: design B won the tournament and is now the canonical
//  implementation, called directly by BuildingRenderer.drawCannon* — see
//  ./CannonB.ts. It no longer routes through this registry.)
// (deadwood was PROMOTED: design A "The Wind Road" won and is called
//  directly by WildernessRenderer's ARCHETYPES entry — see ./DeadwoodA.ts.
//  It no longer routes through this registry.)
// (barracks and mystic_barracks were PROMOTED: designs A won — 'Foundry
//  Bastion' (./BarracksA.ts) and 'Athenaeum of War' (./Mystic_barracksA.ts) —
//  and are called directly by FactionBarracksRenderer.drawFactionBarracks.
//  They no longer route through this registry.)
// ===== PARAMS namespace imports — the per-slot bake-param override channel =====
// (see DesignBakeParams below). The optional `PARAMS` export is read lazily
// off these namespace objects at designBakeParams() call time, so a module
// without the export just resolves to null and an import cycle can never
// TDZ-crash the registry.

/**
 * Building design draw fn — the canonical dedicated-building shape (identical
 * to the BuildingRenderer.draw<Building> statics and the resolved cannon
 * round's drawCannonB). c1..c4 = iso footprint corners (N/E/S/W on screen),
 * center = footprint center; alpha multiplies every fill/stroke; `tint` may
 * be null and may be ignored (the barracks route historically ignores it).
 * Honor the base/elevated split: ground paint goes to
 * `baseGraphics ?? graphics` only when `!skipBase`, and the fn returns right
 * after ground paint when `onlyBase`. All ambient motion is a deterministic
 * function of `time`.
 */
export type BuildingDesignFn = (
    graphics: Phaser.GameObjects.Graphics,
    c1: Phaser.Math.Vector2,
    c2: Phaser.Math.Vector2,
    c3: Phaser.Math.Vector2,
    c4: Phaser.Math.Vector2,
    center: Phaser.Math.Vector2,
    alpha: number,
    tint: number | null,
    building: { level?: number; doorOpen?: number } | undefined,
    baseGraphics: Phaser.GameObjects.Graphics | undefined,
    skipBase: boolean,
    onlyBase: boolean,
    time: number
) => void;

/**
 * Troop design draw fn — the tournament shape for troop units. Mirrors
 * TroopRenderer's parametric contract: the shared hRig/attackAnim grammar
 * drives all motion from `time` (deterministic — pinning time pins the pose),
 * `attackAge`/`attackDelay` lock windup/strike to the damage tick, and
 * `facingAngle` (radians) aims the weapon (golem-class units may ignore it
 * and read carrier-level facing — the IceGolem.readFacing precedent).
 * `driver` carries the unit's bespoke tweened driver (slamOffset /
 * spearOffset / parked01...) and is 0 when unused.
 */
export type TroopDesignFn = (
    graphics: Phaser.GameObjects.Graphics,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number,
    troopLevel: number,
    time: number,
    attackAge: number,
    attackDelay: number,
    driver: number
) => void;

/** Terminal-art companion for designs whose death is itself part of the
 * tournament. Phase 0 is the intact selected body; phase 1 is a persistent,
 * low remnant. It is deterministic and presentation-only. */
export type TroopDeathDesignFn = (
    graphics: Phaser.GameObjects.Graphics,
    isPlayer: boolean,
    troopLevel: number,
    facingAngle: number,
    phase: number
) => void;

/**
 * Wilderness-archetype design draw fn — the tournament shape for wilderness
 * biome units (the deadwood round). It is EXACTLY an archetype `place` fn
 * from WildernessRenderer: compose the plot by registering standing elements
 * through `put(tx, ty, draw)` (tile coords 0..25, clamped to 1.5..23.5;
 * everything queued through `put` is painter-sorted far-to-near by tx+ty
 * before painting) and paint broad ground washes directly on `ctx.g` (they
 * render before the sorted elements). STRICTLY deterministic: seeded rng only
 * (ctx.rng / featureRng(ctx, tag)) — the result rasterizes ONCE into a
 * postcard RenderTexture and must be byte-identical on every client. There is
 * no `time` parameter: postcards are static; living motion comes from pushing
 * `ctx.life` anchors (and `pool(...)`'s fish/frog anchors), which the
 * postcard-life systems animate.
 */
export type WildernessDesignFn = (ctx: WildernessPlotCtx, put: WildernessPut) => void;

export type DesignSlotId = 'A' | 'B' | 'C';

/** Extend this interface when a new unresolved tournament begins. */
export interface DesignSlots {}
export type DesignUnit = keyof DesignSlots;

export const DESIGN_SLOTS: DesignSlots = {
};

/** Death slots are separate so ordinary troop designs cannot accidentally
 * claim terminal art. No current unit has tournament-specific death art. */
export const DESIGN_DEATH_SLOTS: Partial<Record<string, Partial<Record<DesignSlotId, TroopDeathDesignFn | null>>>> = {};

// ===================== judged default slots =====================

/**
 * DEFAULT_DESIGN_SLOTS — the provisional Design Lab DEFAULTS set by the
 * judge panel (2026-07). When `localStorage['clash.design.<unit>']` is unset
 * (or names an unfilled slot), the unit's judged winner below is the live
 * design; units without an entry keep the first-non-null A→B→C fallback.
 * Every surviving slot stays switchable in the Design Lab — this map only
 * changes the DEFAULT, never the stored selection. The SpriteBank variant
 * resolver consults this same map (defaultDesignSlot) so the baked and vector
 * paths can never disagree about the default.
 */
export const DEFAULT_DESIGN_SLOTS: Partial<Record<DesignUnit, DesignSlotId>> = {
};

/** The judged default slot for a unit (string-keyed for SpriteBank, whose
 *  units are plain atlas names), or null when no panel verdict exists. */
export function defaultDesignSlot(unit: string): DesignSlotId | null {
    return (DEFAULT_DESIGN_SLOTS as Partial<Record<string, DesignSlotId>>)[unit] ?? null;
}

// ===================== per-slot bake-param overrides =====================

/**
 * DesignBakeParams — a design slot's authored sampling periods (ms). A design
 * file may export a module-level `PARAMS` constant keyed by unit:
 *
 *     export const PARAMS: DesignParamsExport = {
 *         skeleton: { stride: 300, idleMs: 1000 },
 *     };
 *
 * The bake harness (tools/art-preview/bake-sprites.mjs, `DESIGN=<slot>` runs)
 * reads it through the BakeBridge (`designBakeParams`) and overlays it on the
 * unit's TROOP_PARAMS row for that run, so a slot whose authored math differs
 * from the pinned unit table still gets sampled on ITS exact periods (a
 * mismatched table stride/windup mis-samples the loop — the classic stride
 * bug). The merged values are written into the baked manifest's `params`,
 * which is the ONLY place SpriteBank reads playback periods from — the
 * runtime needs no change. Only list values that DIFFER from the table row.
 */
export interface DesignBakeParams {
    /** Authored walk period (ms) — the draw fn's `time % stride` base. */
    stride?: number;
    /** Attack cycle the bake samples ages against (ms). Keep this equal to
     *  the runtime TroopDefinitions attackDelay: SpriteBank matches baked
     *  attackAge by NEAREST VALUE, so ages baked against a wrong delay pair
     *  runtime windup ages with the wrong frames (necromancer precedent:
     *  ages baked at delay 5000 never match runtime windup ages at 1600). */
    delay?: number;
    /** Windup window before the damage tick (ms). */
    windup?: number;
    /** Post-tick strike/decay window (ms); 0 keeps the suicide-unit
     *  convention (burst read from post-tick ages 1/40 only). */
    strike?: number;
    /** Exact idle-loop period (ms — MUST be a 250 ms multiple whose terms
     *  are exact harmonics). Lands in the manifest as `idleLoopMs`. Without
     *  it the bake samples the default 2π·640 ≈ 4021 ms breath window, which
     *  does NOT close a 2000 ms idle loop. */
    idleMs?: number;
    /** Facing buckets the draw consumes (1 or 8). */
    dirs?: number;
}

/** The shape of a design file's `PARAMS` export, keyed by unit. */
export type DesignParamsExport = Partial<Record<string, DesignBakeParams>>;

/** Slot → design module for every registered troop design file. `PARAMS` is
 *  read lazily off the namespace object at call time (cycle-safe; absent
 *  exports resolve to null). Typed `object` because a design module without
 *  the optional PARAMS export has no properties in common with the weak
 *  `{ PARAMS?: … }` type — the export itself is still fully checked at its
 *  declaration site (files annotate it as DesignParamsExport). */
const DESIGN_PARAM_MODULES: Partial<Record<string, Partial<Record<DesignSlotId, object>>>> = {};

/** Union of every draw-fn shape a tournament round can register. */
export type AnyDesignFn = TroopDesignFn | WildernessDesignFn | BuildingDesignFn;

type RuntimeDesignSlots = Partial<Record<DesignSlotId, AnyDesignFn | null>>;

/** String-safe lookup for SpriteBank/dev-tool callers. Individual rounds may
 * intentionally register fewer than the historical A/B/C superset. */
function designSlotsFor(unit: string): RuntimeDesignSlots | undefined {
    if (!Object.prototype.hasOwnProperty.call(DESIGN_SLOTS, unit)) return undefined;
    // Through-unknown: DesignSlots is a closed per-unit map whose value types
    // are round-specific fn shapes; this helper erases them to the union for
    // string-keyed callers (SpriteBank, dev tools, the Design Lab).
    return (DESIGN_SLOTS as unknown as Partial<Record<string, RuntimeDesignSlots>>)[unit];
}

/** The bake-param overrides a design slot authored for a unit, or null when
 *  the slot has none (the bake then uses the unit's TROOP_PARAMS row as-is). */
export function designBakeParams(unit: string, slot: DesignSlotId): DesignBakeParams | null {
    const mod = DESIGN_PARAM_MODULES[unit]?.[slot] as { PARAMS?: DesignParamsExport } | undefined;
    return mod?.PARAMS?.[unit] ?? null;
}

/**
 * Resolve the live design for a unit. Reads `localStorage['clash.design.<unit>']`
 * on EVERY call ('A'|'B'|'C'); an unset/invalid/empty selection falls back to
 * the unit's judged default slot (DEFAULT_DESIGN_SLOTS) when that slot is
 * filled, else the first non-null slot in A→B→C order. Returns null when no
 * slot is filled. SSR/test safe: any environment without a usable
 * `window.localStorage` just uses the fallback order.
 */
export function activeDesign(unit: string): AnyDesignFn | null;
export function activeDesign(unit: string): AnyDesignFn | null {
    const slots = designSlotsFor(unit);
    if (!slots) return null;
    const picked = readStoredSlot(unit);
    if (picked !== null && slots[picked]) return slots[picked];
    const judged = defaultDesignSlot(unit);
    if (judged && slots[judged]) return slots[judged];
    return slots.A ?? slots.B ?? slots.C ?? null;
}

/** Resolve terminal art with the exact same stored/default/fallback semantics
 * as the living body. A missing death slot returns null so the curated death
 * renderer can choose its non-tournament fallback. */
export function activeDesignDeath(unit: string): TroopDeathDesignFn | null {
    const slots = (DESIGN_DEATH_SLOTS as Partial<Record<string, Partial<Record<DesignSlotId, TroopDeathDesignFn | null>>>>)[unit];
    if (!slots) return null;
    const picked = readStoredSlot(unit);
    if (picked !== null && slots[picked]) return slots[picked] ?? null;
    const judged = defaultDesignSlot(unit);
    if (judged && slots[judged]) return slots[judged] ?? null;
    return slots.A ?? slots.B ?? slots.C ?? null;
}

// ===================== variant-switching service =====================
// The runtime half of the design-tournament infrastructure: the Design Lab
// (Settings), the SpriteBank variant resolver and the vector delegators all
// key off the SAME localStorage key, so baked sprites and the vector fallback
// can never disagree about which design is live.

export const DESIGN_SLOT_IDS: readonly DesignSlotId[] = ['A', 'B', 'C'];

/** The window event dispatched by setActiveSlot. detail: `{ unit }`.
 *  MainScene listens and busts the affected buildings' draw caches (and
 *  re-stamps their ground decals); troops re-pick frames on their next
 *  per-frame draw, so switching is visually instant with no reload. */
export const DESIGN_CHANGED_EVENT = 'clash:design-changed';

export interface VariantUnitInfo {
    unit: string;
    /** The filled (registered, non-null) slots for this unit, in A→B→C order. */
    slots: DesignSlotId[];
}

/** Every unit with at least one registered design variant — the Design Lab
 *  renders purely from this list, so a future tournament's units appear the
 *  moment their draw fns are registered in DESIGN_SLOTS. */
export function listVariantUnits(): VariantUnitInfo[] {
    return Object.keys(DESIGN_SLOTS)
        .map(unit => ({
            unit,
            slots: DESIGN_SLOT_IDS.filter(slot => typeof designSlotsFor(unit)?.[slot] === 'function')
        }))
        .filter(info => info.slots.length > 0);
}

/** The raw stored selection ('A'|'B'|'C') or null — no fallback applied. */
function readStoredSlot(unit: string): DesignSlotId | null {
    try {
        if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
            const v = window.localStorage.getItem(`clash.design.${unit}`);
            if (v === 'A' || v === 'B' || v === 'C') return v;
        }
    } catch {
        // Storage unavailable (SSR, sandboxed iframe, tests) — fall through.
    }
    return null;
}

/** The slot currently live for a unit — the stored selection when it names a
 *  filled slot, else the judged default slot when filled, else the first
 *  filled slot in A→B→C order (mirroring activeDesign's fallback), else 'A'. */
export function activeSlot(unit: string): DesignSlotId {
    const slots = designSlotsFor(unit);
    if (!slots) return 'A';
    const picked = readStoredSlot(unit);
    if (picked !== null && slots[picked]) return picked;
    const judged = defaultDesignSlot(unit);
    if (judged && slots[judged]) return judged;
    return DESIGN_SLOT_IDS.find(slot => typeof slots[slot] === 'function') ?? 'A';
}

/** Select a design slot LIVE: persists the choice and announces it via the
 *  DESIGN_CHANGED_EVENT window event so the scene repaints affected units on
 *  the next frame. Safe to call in any environment (storage failures are
 *  swallowed; the event still fires so listeners stay honest). */
export function setActiveSlot(unit: string, slot: DesignSlotId): void {
    try {
        window.localStorage.setItem(`clash.design.${unit}`, slot);
    } catch {
        // Storage unavailable — the selection won't persist, but the live
        // switch below still happens for this session.
    }
    try {
        window.dispatchEvent(new CustomEvent(DESIGN_CHANGED_EVENT, { detail: { unit } }));
    } catch {
        // No window (tests) — nothing to notify.
    }
}
