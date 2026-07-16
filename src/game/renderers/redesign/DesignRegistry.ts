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
 * the next redraw. With no (or an empty) selection the first non-null slot
 * wins; with all slots null the caller falls back to its neutral placeholder.
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
// IMPORT clockworkbeetle C
import { drawPhysicianscartA } from './PhysicianscartA'; // IMPORT physicianscart A
import { drawPhysicianscartB } from './PhysicianscartB'; // IMPORT physicianscart B
import { drawPhysicianscartC } from './PhysicianscartC'; // IMPORT physicianscart C
import { drawPavisebearerA } from './PavisebearerA'; // IMPORT pavisebearer A
// IMPORT pavisebearer B
// IMPORT pavisebearer C
import { drawQuartermasterA } from './QuartermasterA'; // IMPORT quartermaster A
import { drawQuartermasterB } from './QuartermasterB'; // IMPORT quartermaster B
// IMPORT quartermaster C
import { drawSiegetowerA } from './SiegetowerA'; // IMPORT siegetower A
import { drawSiegetowerB } from './SiegetowerB'; // IMPORT siegetower B
// IMPORT siegetower C
import { drawNecromancerA } from './NecromancerA'; // IMPORT necromancer A
import { drawNecromancerB } from './NecromancerB'; // IMPORT necromancer B
// IMPORT necromancer C
import { drawTrebuchetA } from './TrebuchetA'; // IMPORT trebuchet A
import { drawTrebuchetB } from './TrebuchetB'; // IMPORT trebuchet B
import { drawTrebuchetC } from './TrebuchetC'; // IMPORT trebuchet C
import { drawHawkeyeassassinA } from './HawkeyeassassinA'; // IMPORT hawkeyeassassin A
// IMPORT hawkeyeassassin B
// IMPORT hawkeyeassassin C
import { drawWarelephantA } from './WarelephantA'; // IMPORT warelephant A
// IMPORT warelephant B
// IMPORT warelephant C
import { drawOrnithopterA } from './OrnithopterA'; // IMPORT ornithopter A
// IMPORT ornithopter B
// IMPORT ornithopter C
import { drawSkeletonA } from './NecromancerA'; // IMPORT skeleton A
import { drawSkeletonB } from './NecromancerB'; // IMPORT skeleton B
// IMPORT skeleton C

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
    | 'pavisebearer'
    | 'quartermaster'
    | 'siegetower'
    | 'necromancer'
    | 'trebuchet'
    | 'hawkeyeassassin'
    | 'warelephant'
    | 'ornithopter'
    | 'skeleton';
export type DesignSlotId = 'A' | 'B' | 'C';

export interface DesignSlots {
    frostfall: Record<DesignSlotId, BuildingDesignFn | null>;
    goblinplunderer: Record<DesignSlotId, TroopDesignFn | null>;
    clockworkbeetle: Record<DesignSlotId, TroopDesignFn | null>;
    physicianscart: Record<DesignSlotId, TroopDesignFn | null>;
    pavisebearer: Record<DesignSlotId, TroopDesignFn | null>;
    quartermaster: Record<DesignSlotId, TroopDesignFn | null>;
    siegetower: Record<DesignSlotId, TroopDesignFn | null>;
    necromancer: Record<DesignSlotId, TroopDesignFn | null>;
    trebuchet: Record<DesignSlotId, TroopDesignFn | null>;
    hawkeyeassassin: Record<DesignSlotId, TroopDesignFn | null>;
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
        C: null, // SLOT clockworkbeetle C
    },
    physicianscart: {
        A: drawPhysicianscartA, // SLOT physicianscart A
        B: drawPhysicianscartB, // SLOT physicianscart B
        C: drawPhysicianscartC, // SLOT physicianscart C
    },
    pavisebearer: {
        A: drawPavisebearerA, // SLOT pavisebearer A
        B: null, // SLOT pavisebearer B
        C: null, // SLOT pavisebearer C
    },
    quartermaster: {
        A: drawQuartermasterA, // SLOT quartermaster A
        B: drawQuartermasterB, // SLOT quartermaster B
        C: null, // SLOT quartermaster C
    },
    siegetower: {
        A: drawSiegetowerA, // SLOT siegetower A
        B: drawSiegetowerB, // SLOT siegetower B
        C: null, // SLOT siegetower C
    },
    necromancer: {
        A: drawNecromancerA, // SLOT necromancer A
        B: drawNecromancerB, // SLOT necromancer B
        C: null, // SLOT necromancer C
    },
    trebuchet: {
        A: drawTrebuchetA, // SLOT trebuchet A
        B: drawTrebuchetB, // SLOT trebuchet B
        C: drawTrebuchetC, // SLOT trebuchet C
    },
    hawkeyeassassin: {
        A: drawHawkeyeassassinA, // SLOT hawkeyeassassin A
        B: null, // SLOT hawkeyeassassin B
        C: null, // SLOT hawkeyeassassin C
    },
    warelephant: {
        A: drawWarelephantA, // SLOT warelephant A
        B: null, // SLOT warelephant B
        C: null, // SLOT warelephant C
    },
    ornithopter: {
        A: drawOrnithopterA, // SLOT ornithopter A
        B: null, // SLOT ornithopter B
        C: null, // SLOT ornithopter C
    },
    // Skeleton slots are filled by the NECROMANCER designers — each slot's
    // skeleton ships in the same design file as its summoner so the pair
    // always matches visually.
    skeleton: {
        A: drawSkeletonA, // SLOT skeleton A
        B: drawSkeletonB, // SLOT skeleton B
        C: null, // SLOT skeleton C
    },
};

/**
 * Resolve the live design for a unit. Reads `localStorage['clash.design.<unit>']`
 * on EVERY call ('A'|'B'|'C'); an unset/invalid/empty selection falls back to
 * the first non-null slot in A→B→C order. Returns null when no slot is filled.
 * SSR/test safe: any environment without a usable `window.localStorage` just
 * uses the fallback order.
 */
export function activeDesign<U extends DesignUnit>(unit: U): DesignSlots[U][DesignSlotId] {
    // Every DesignSlots entry is a Record<DesignSlotId, Fn | null>; the cast
    // keeps the per-unit fn type (Building vs Troop) on the return value.
    const slots = DESIGN_SLOTS[unit] as Record<DesignSlotId, DesignSlots[U][DesignSlotId]>;
    const picked = readStoredSlot(unit);
    if (picked !== null && slots[picked]) return slots[picked];
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
 *  filled slot, else the first filled slot in A→B→C order (mirroring
 *  activeDesign's fallback), else 'A'. */
export function activeSlot(unit: DesignUnit): DesignSlotId {
    const slots = DESIGN_SLOTS[unit];
    const picked = readStoredSlot(unit);
    if (picked !== null && slots[picked]) return picked;
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
