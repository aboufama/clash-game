import type Phaser from 'phaser';

/**
 * CLEAN-ROOM DESIGN REGISTRY — the frostfall redesign round (in progress).
 * (The cannon round is FINISHED: design B was promoted to canonical and left
 * the registry — see CannonB.ts. The golem round is FINISHED too: design C
 * won and is called directly by TroopRenderer.drawGolem — see GolemC.ts;
 * design B is the authoring base for the NEW 'icegolem' troop. The mortar
 * round ENDED WITH NO WINNER: all three designs were rejected and the
 * original vector art was restored as canonical — mortar no longer routes
 * through this registry.)
 *
 * Three isolated artist agents fill one slot each per unit (A/B/C). Rules:
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
import { drawFrostfallA } from './FrostfallA'; // IMPORT frostfall A
import { drawFrostfallB } from './FrostfallB'; // IMPORT frostfall B
import { drawFrostfallC } from './FrostfallC'; // IMPORT frostfall C
import { drawGoblinplundererA } from './GoblinplundererA'; // IMPORT goblinplunderer A
import { drawGoblinplundererB } from './GoblinplundererB'; // IMPORT goblinplunderer B
import { drawGoblinplundererC } from './GoblinplundererC'; // IMPORT goblinplunderer C
import { drawClockworkbeetleA } from './ClockworkbeetleA'; // IMPORT clockworkbeetle A
import { drawClockworkbeetleB } from './ClockworkbeetleB'; // IMPORT clockworkbeetle B
import { drawClockworkbeetleC } from './ClockworkbeetleC'; // IMPORT clockworkbeetle C
import { drawPhysicianscartA } from './PhysicianscartA'; // IMPORT physicianscart A
import { drawPhysicianscartB } from './PhysicianscartB'; // IMPORT physicianscart B
import { drawPhysicianscartC } from './PhysicianscartC'; // IMPORT physicianscart C
import { drawQuartermasterA } from './QuartermasterA'; // IMPORT quartermaster A
import { drawQuartermasterB } from './QuartermasterB'; // IMPORT quartermaster B
import { drawQuartermasterC } from './QuartermasterC'; // IMPORT quartermaster C
import { drawSiegetowerA } from './SiegetowerA'; // IMPORT siegetower A
import { drawSiegetowerB } from './SiegetowerB'; // IMPORT siegetower B
import { drawSiegetowerC } from './SiegetowerC'; // IMPORT siegetower C
import { drawNecromancerA } from './NecromancerA'; // IMPORT necromancer A
import { drawNecromancerB } from './NecromancerB'; // IMPORT necromancer B
import { drawNecromancerC } from './NecromancerC'; // IMPORT necromancer C
import { drawTrebuchetA } from './TrebuchetA'; // IMPORT trebuchet A
import { drawTrebuchetB } from './TrebuchetB'; // IMPORT trebuchet B
import { drawTrebuchetC } from './TrebuchetC'; // IMPORT trebuchet C
import { drawWarelephantA } from './WarelephantA'; // IMPORT warelephant A
import { drawWarelephantB } from './WarelephantB'; // IMPORT warelephant B
import { drawWarelephantC } from './WarelephantC'; // IMPORT warelephant C
import { drawOrnithopterA } from './OrnithopterA'; // IMPORT ornithopter A
import { drawOrnithopterB } from './OrnithopterB'; // IMPORT ornithopter B
import { drawOrnithopterC } from './OrnithopterC'; // IMPORT ornithopter C
import { drawSkeletonA } from './NecromancerA'; // IMPORT skeleton A
import { drawSkeletonB } from './NecromancerB'; // IMPORT skeleton B
import { drawSkeletonC } from './NecromancerC'; // IMPORT skeleton C

// ===== PARAMS namespace imports — the per-slot bake-param override channel =====
// (see DesignBakeParams below). The optional `PARAMS` export is read lazily
// off these namespace objects at designBakeParams() call time, so a module
// without the export just resolves to null and an import cycle can never
// TDZ-crash the registry. Frostfall is a building (no TROOP_PARAMS row) and
// has no entry here.
import * as GoblinplundererAMod from './GoblinplundererA';
import * as GoblinplundererBMod from './GoblinplundererB';
import * as GoblinplundererCMod from './GoblinplundererC';
import * as ClockworkbeetleAMod from './ClockworkbeetleA';
import * as ClockworkbeetleBMod from './ClockworkbeetleB';
import * as ClockworkbeetleCMod from './ClockworkbeetleC';
import * as PhysicianscartAMod from './PhysicianscartA';
import * as PhysicianscartBMod from './PhysicianscartB';
import * as PhysicianscartCMod from './PhysicianscartC';
import * as QuartermasterAMod from './QuartermasterA';
import * as QuartermasterBMod from './QuartermasterB';
import * as QuartermasterCMod from './QuartermasterC';
import * as SiegetowerAMod from './SiegetowerA';
import * as SiegetowerBMod from './SiegetowerB';
import * as SiegetowerCMod from './SiegetowerC';
import * as NecromancerAMod from './NecromancerA';
import * as NecromancerBMod from './NecromancerB';
import * as NecromancerCMod from './NecromancerC';
import * as TrebuchetAMod from './TrebuchetA';
import * as TrebuchetBMod from './TrebuchetB';
import * as TrebuchetCMod from './TrebuchetC';
import * as WarelephantAMod from './WarelephantA';
import * as WarelephantBMod from './WarelephantB';
import * as WarelephantCMod from './WarelephantC';
import * as OrnithopterAMod from './OrnithopterA';
import * as OrnithopterBMod from './OrnithopterB';
import * as OrnithopterCMod from './OrnithopterC';

/**
 * Building design draw fn — the canonical dedicated-building shape (identical
 * to `BuildingRenderer.drawCannon*` and `drawFrostfall`).
 * c1..c4 = iso footprint corners (N/E/S/W), center = footprint center.
 * Honor the base/elevated split: ground paint goes to `baseGraphics || graphics`
 * when `!skipBase`; return after ground paint when `onlyBase`.
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
    building: any,
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

export type DesignUnit =
    | 'frostfall'
    | 'goblinplunderer'
    | 'clockworkbeetle'
    | 'physicianscart'
    | 'quartermaster'
    | 'siegetower'
    | 'necromancer'
    | 'trebuchet'
    | 'warelephant'
    | 'ornithopter'
    | 'skeleton';
export type DesignSlotId = 'A' | 'B' | 'C';

export interface DesignSlots {
    frostfall: Record<DesignSlotId, BuildingDesignFn | null>;
    goblinplunderer: Record<DesignSlotId, TroopDesignFn | null>;
    clockworkbeetle: Record<DesignSlotId, TroopDesignFn | null>;
    physicianscart: Record<DesignSlotId, TroopDesignFn | null>;
    quartermaster: Record<DesignSlotId, TroopDesignFn | null>;
    siegetower: Record<DesignSlotId, TroopDesignFn | null>;
    necromancer: Record<DesignSlotId, TroopDesignFn | null>;
    trebuchet: Record<DesignSlotId, TroopDesignFn | null>;
    warelephant: Record<DesignSlotId, TroopDesignFn | null>;
    ornithopter: Record<DesignSlotId, TroopDesignFn | null>;
    skeleton: Record<DesignSlotId, TroopDesignFn | null>;
}

export const DESIGN_SLOTS: DesignSlots = {
    frostfall: {
        A: drawFrostfallA, // SLOT frostfall A
        B: drawFrostfallB, // SLOT frostfall B
        C: drawFrostfallC, // SLOT frostfall C
    },
    goblinplunderer: {
        A: drawGoblinplundererA, // SLOT goblinplunderer A
        B: drawGoblinplundererB, // SLOT goblinplunderer B
        C: drawGoblinplundererC, // SLOT goblinplunderer C
    },
    clockworkbeetle: {
        A: drawClockworkbeetleA, // SLOT clockworkbeetle A
        B: drawClockworkbeetleB, // SLOT clockworkbeetle B
        C: drawClockworkbeetleC, // SLOT clockworkbeetle C
    },
    physicianscart: {
        A: drawPhysicianscartA, // SLOT physicianscart A
        B: drawPhysicianscartB, // SLOT physicianscart B
        C: drawPhysicianscartC, // SLOT physicianscart C
    },
    quartermaster: {
        A: drawQuartermasterA, // SLOT quartermaster A
        B: drawQuartermasterB, // SLOT quartermaster B
        C: drawQuartermasterC, // SLOT quartermaster C
    },
    siegetower: {
        A: drawSiegetowerA, // SLOT siegetower A
        B: drawSiegetowerB, // SLOT siegetower B
        C: drawSiegetowerC, // SLOT siegetower C
    },
    necromancer: {
        A: drawNecromancerA, // SLOT necromancer A
        B: drawNecromancerB, // SLOT necromancer B
        C: drawNecromancerC, // SLOT necromancer C
    },
    trebuchet: {
        A: drawTrebuchetA, // SLOT trebuchet A
        B: drawTrebuchetB, // SLOT trebuchet B
        C: drawTrebuchetC, // SLOT trebuchet C
    },
    warelephant: {
        A: drawWarelephantA, // SLOT warelephant A
        B: drawWarelephantB, // SLOT warelephant B
        C: drawWarelephantC, // SLOT warelephant C
    },
    ornithopter: {
        A: drawOrnithopterA, // SLOT ornithopter A
        B: drawOrnithopterB, // SLOT ornithopter B
        C: drawOrnithopterC, // SLOT ornithopter C
    },
    // Skeleton slots are filled by the NECROMANCER designers — each slot's
    // skeleton ships in the same design file as its summoner so the pair
    // always matches visually.
    skeleton: {
        A: drawSkeletonA, // SLOT skeleton A
        B: drawSkeletonB, // SLOT skeleton B
        C: drawSkeletonC, // SLOT skeleton C
    },
};

// ===================== judged default slots =====================

/**
 * DEFAULT_DESIGN_SLOTS — the provisional Design Lab DEFAULTS set by the
 * judge panel (2026-07). When `localStorage['clash.design.<unit>']` is unset
 * (or names an unfilled slot), the unit's judged winner below is the live
 * design; units without an entry keep the first-non-null A→B→C fallback.
 * Every slot stays switchable in the Design Lab — this map only changes the
 * DEFAULT, never the stored selection. Skeleton follows its summoner
 * (necromancer) so the pair always matches visually. The SpriteBank variant
 * resolver consults this same map (defaultDesignSlot) so the baked and
 * vector paths can never disagree about the default.
 */
export const DEFAULT_DESIGN_SLOTS: Partial<Record<DesignUnit, DesignSlotId>> = {
    goblinplunderer: 'B',
    clockworkbeetle: 'B',
    physicianscart: 'B',
    quartermaster: 'C',
    siegetower: 'C',
    necromancer: 'A',
    trebuchet: 'B',
    warelephant: 'C',
    ornithopter: 'C',
    skeleton: 'A', // ships with necromancer A — pair must match
};

/** The judged default slot for a unit (string-keyed for SpriteBank, whose
 *  units are plain atlas names), or null when no panel verdict exists. */
export function defaultDesignSlot(unit: string): DesignSlotId | null {
    return DEFAULT_DESIGN_SLOTS[unit as DesignUnit] ?? null;
}

// ===================== per-slot bake-param overrides =====================

/**
 * DesignBakeParams — a design slot's authored sampling periods (ms). A design
 * file may export a module-level `PARAMS` constant keyed by unit:
 *
 *     export const PARAMS: DesignParamsExport = {
 *         clockworkbeetle: { windup: 500, idleMs: 2000 },
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

/** The shape of a design file's `PARAMS` export — keyed by unit so paired
 *  units authored in one file (necromancer + skeleton) each carry their own
 *  overrides. */
export type DesignParamsExport = Partial<Record<DesignUnit, DesignBakeParams>>;

/** Slot → design module for every registered troop design file. `PARAMS` is
 *  read lazily off the namespace object at call time (cycle-safe; absent
 *  exports resolve to null). Typed `object` because a design module without
 *  the optional PARAMS export has no properties in common with the weak
 *  `{ PARAMS?: … }` type — the export itself is still fully checked at its
 *  declaration site (files annotate it as DesignParamsExport). Skeleton rows
 *  point at the Necromancer modules — each slot's skeleton ships in its
 *  summoner's file. */
const DESIGN_PARAM_MODULES: Partial<Record<DesignUnit, Partial<Record<DesignSlotId, object>>>> = {
    goblinplunderer: { A: GoblinplundererAMod, B: GoblinplundererBMod, C: GoblinplundererCMod },
    clockworkbeetle: { A: ClockworkbeetleAMod, B: ClockworkbeetleBMod, C: ClockworkbeetleCMod },
    physicianscart: { A: PhysicianscartAMod, B: PhysicianscartBMod, C: PhysicianscartCMod },
    quartermaster: { A: QuartermasterAMod, B: QuartermasterBMod, C: QuartermasterCMod },
    siegetower: { A: SiegetowerAMod, B: SiegetowerBMod, C: SiegetowerCMod },
    necromancer: { A: NecromancerAMod, B: NecromancerBMod, C: NecromancerCMod },
    trebuchet: { A: TrebuchetAMod, B: TrebuchetBMod, C: TrebuchetCMod },
    warelephant: { A: WarelephantAMod, B: WarelephantBMod, C: WarelephantCMod },
    ornithopter: { A: OrnithopterAMod, B: OrnithopterBMod, C: OrnithopterCMod },
    skeleton: { A: NecromancerAMod, B: NecromancerBMod, C: NecromancerCMod },
};

/** The bake-param overrides a design slot authored for a unit, or null when
 *  the slot has none (the bake then uses the unit's TROOP_PARAMS row as-is). */
export function designBakeParams(unit: DesignUnit, slot: DesignSlotId): DesignBakeParams | null {
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
export function activeDesign<U extends DesignUnit>(unit: U): DesignSlots[U][DesignSlotId] {
    // Every DesignSlots entry is a Record<DesignSlotId, Fn | null>; the cast
    // keeps the per-unit fn type (Building vs Troop) on the return value.
    const slots = DESIGN_SLOTS[unit] as Record<DesignSlotId, DesignSlots[U][DesignSlotId]>;
    const picked = readStoredSlot(unit);
    if (picked !== null && slots[picked]) return slots[picked];
    const judged = DEFAULT_DESIGN_SLOTS[unit];
    if (judged && slots[judged]) return slots[judged];
    return slots.A ?? slots.B ?? slots.C;
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
    unit: DesignUnit;
    /** The filled (registered, non-null) slots for this unit, in A→B→C order. */
    slots: DesignSlotId[];
}

/** Every unit with at least one registered design variant — the Design Lab
 *  renders purely from this list, so a future tournament's units appear the
 *  moment their draw fns are registered in DESIGN_SLOTS. */
export function listVariantUnits(): VariantUnitInfo[] {
    return (Object.keys(DESIGN_SLOTS) as DesignUnit[])
        .map(unit => ({
            unit,
            slots: DESIGN_SLOT_IDS.filter(slot => DESIGN_SLOTS[unit][slot] !== null)
        }))
        .filter(info => info.slots.length > 0);
}

/** The raw stored selection ('A'|'B'|'C') or null — no fallback applied. */
function readStoredSlot(unit: DesignUnit): DesignSlotId | null {
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
export function activeSlot(unit: DesignUnit): DesignSlotId {
    const slots = DESIGN_SLOTS[unit];
    const picked = readStoredSlot(unit);
    if (picked !== null && slots[picked]) return picked;
    const judged = DEFAULT_DESIGN_SLOTS[unit];
    if (judged && slots[judged]) return judged;
    return DESIGN_SLOT_IDS.find(slot => slots[slot] !== null) ?? 'A';
}

/** Select a design slot LIVE: persists the choice and announces it via the
 *  DESIGN_CHANGED_EVENT window event so the scene repaints affected units on
 *  the next frame. Safe to call in any environment (storage failures are
 *  swallowed; the event still fires so listeners stay honest). */
export function setActiveSlot(unit: DesignUnit, slot: DesignSlotId): void {
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
