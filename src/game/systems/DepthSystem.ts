import { BUILDING_DEFINITIONS, TROOP_DEFINITIONS, type BuildingType, type TroopType } from '../config/GameDefinitions';

const DEPTH_BASE = 1000;
const DEPTH_STEP = 100;
// Along-row tie-break. Must stay TINY: (x − y) spans ±mapSize, and the tie of
// two objects on the SAME row can differ by up to 2 per tile of horizontal
// screen distance. Any pair whose art can actually overlap on screen sits
// within ~4 tiles along the row (Δ(x−y) ≤ 8 → tie ≤ 0.8), which must never
// exceed the sub-band margins below (0.5 between occluder rungs). The old
// value (1) let a wall 2 tiles along the row out-tie a same-row 3x3 roof —
// that is what the removed BARRACKS_DEPTH_OFFSET papered over.
const DEPTH_TIE = 0.1;
const MAX_BIAS = Math.floor(DEPTH_STEP * 0.4);
const GROUND_PLANE_DEPTH = 0;

const TROOP_BIAS_SCALE = 1;

/**
 * THE OCCLUDER BAND (see docs/RENDERING_AND_DEPTH.md for the full derivation)
 *
 * Characters (troops + villagers) anchor at their feet with offset
 * 15 + bias ∈ [16, 21]. Every SOLID occluder (wall, building, obstacle)
 * anchors at its exact footprint CENTER — the visual boundary of its art —
 * with an offset strictly INSIDE the character range (16, 21). Then for any
 * character/solid pair:
 *
 *   charDepth − solidDepth = 100·(charRow − centerRow) + (charOff − solidOff)
 *                          = 100·Δrow ± ≤3
 *
 * so the painter flips within ±0.03 rows (≤1 screen px) of the art's visual
 * boundary: a character whose feet are in FRONT of the tile/footprint center
 * paints over the crest/roof, a character behind it is occluded — for EVERY
 * troop type, at every sub-tile offset. Anchoring solids anywhere behind
 * their center (the old back-corner/floor-center anchor) re-opens the band
 * `anchorRow < charRow < centerRow` where a character behind the art
 * out-depths it (villagers stood ON the town-hall roof; every troop painted
 * over walls it stood 0.05–0.6 tiles behind).
 *
 * Within the band, rungs 0.5 apart order same-row (diagonal) neighbours:
 * bigger buildings above smaller above walls above obstacles, so a tall 3x3
 * roof beats the crest of a same-row wall two tiles along the row.
 */
const LAYER_OFFSETS = {
    // 17.5 + 0.5·size → 1x1 tree 18, 2x2 rock 19. Bottom of the band:
    // characters clear a trunk from 0.02 rows in front of it.
    obstacle: 17.5,
    // Wrecks are walk-over ground art: they must stay BELOW every character
    // standing anywhere ON the footprint (min char row there = back corner
    // row), so rubble keeps the legacy floor-center anchor + a tiny offset —
    // NOT the occluder band.
    rubble: 3,
    // 18 + 0.5·max(w,h) (capped +2) → wall/1x1 18.5, 2x2 19, 3x3 19.5,
    // 4x4 20. All strictly inside (16, 21).
    building: 18,
    // Characters: 15 + bias(1..6) ∈ [16, 21]. Villagers share this exact
    // convention (VillageLifeSystem.characterDepth → depthForTroop).
    troop: 15,
    // Rigid projectiles sort with the world at their CURRENT ground-track
    // position: above characters and same-row crests, gone behind anything
    // ~0.4+ rows in front. Ground-hugging impact FX sit just above the
    // projectile that spawned them.
    projectile: 60,
    groundEffect: 62
};

// Solid-occluder size bias: bigger footprints win same-row (diagonal)
// overlaps because their roofs are taller/wider. Capped so the total offset
// (18 + 2 = 20) never leaves the character band (16, 21) — a cap of 3 would
// put a 6-tile footprint at 21 and swallow a golem standing 0.01 in front.
const OCCLUDER_BIAS_CAP = 2;
const occluderBias = (width: number, height: number) =>
    Math.min(OCCLUDER_BIAS_CAP, Math.max(width, height) * 0.5);

const baseDepth = (anchorX: number, anchorY: number) =>
    DEPTH_BASE + (anchorX + anchorY) * DEPTH_STEP + (anchorX - anchorY) * DEPTH_TIE;

const clampBias = (bias: number) => Math.max(-MAX_BIAS, Math.min(MAX_BIAS, bias));

/**
 * Depth for a solid occluder footprint, anchored at the EXACT footprint
 * center `(gridX + w/2, gridY + h/2)` — the visual boundary of the art.
 * Anything whose feet/anchor row is in front of the center row paints over
 * this object, anything behind is occluded (crossing within ±0.03 rows, see
 * the band derivation above). For non-square footprints the center row is
 * the optimal compromise between the two diagonal ambiguity zones.
 */
export const depthForFootprint = (
    gridX: number,
    gridY: number,
    width: number,
    height: number,
    layerOffset: number,
    bias: number = 0
) => {
    const anchorX = gridX + width / 2;
    const anchorY = gridY + height / 2;
    return baseDepth(anchorX, anchorY) + layerOffset + clampBias(bias);
};

export const depthForGroundPlane = () => GROUND_PLANE_DEPTH;

// A troop's bias must keep its TOTAL character offset (troop 15 + bias)
// under the top of the occluder band: solids sit at 18..20, so bias ≤ 6
// keeps the worst crossing (golem 21 vs obstacle 18) at 0.03 rows — ~1
// screen px. Uncapped space (golem 25, davincitank 30) put colossal troops
// a full sub-row above every wall. The cap also preserves big-over-small
// ordering for troops sharing a tile.
const TROOP_MAX_BIAS = 6;

const troopBias = (type: TroopType) => {
    const def = TROOP_DEFINITIONS[type];
    if (!def) return 0;
    return Math.min(TROOP_MAX_BIAS, clampBias(Math.max(1, def.space) * TROOP_BIAS_SCALE));
};

export const depthForBuilding = (gridX: number, gridY: number, type: BuildingType) => {
    const def = BUILDING_DEFINITIONS[type];
    // Unknown type: sane 1x1 occluder depth, never a crash.
    if (!def) return depthForFootprint(gridX, gridY, 1, 1, LAYER_OFFSETS.building, occluderBias(1, 1));
    // Walls take the same path: a wall is a 1x1 occluder anchored at its tile
    // center (18.5 total). The old back-corner anchor + 27 made every
    // character whose row passed anchorRow + 0.11 paint over a crest it
    // stood half a tile behind.
    return depthForFootprint(gridX, gridY, def.width, def.height, LAYER_OFFSETS.building, occluderBias(def.width, def.height));
};

export const depthForObstacle = (gridX: number, gridY: number, width: number, height: number) =>
    depthForFootprint(gridX, gridY, width, height, LAYER_OFFSETS.obstacle, occluderBias(width, height) - 0.5);

// Legacy floor-center anchor ON PURPOSE (see LAYER_OFFSETS.rubble): wreck
// smears never rise above a character standing on them.
export const depthForRubble = (gridX: number, gridY: number, width: number, height: number) =>
    baseDepth(gridX + Math.floor((width - 1) / 2), gridY + Math.floor((height - 1) / 2)) + LAYER_OFFSETS.rubble;

export const depthForTroop = (gridX: number, gridY: number, type: TroopType) =>
    baseDepth(gridX, gridY) + LAYER_OFFSETS.troop + troopBias(type);

/**
 * Painter's-order depth for a rigid projectile at its CURRENT position
 * (fractional grid coords are fine — lerp the ground track by tween
 * progress for arcing shots). Clears characters and same-row crests, still
 * disappears behind anything ~0.4+ rows in front.
 */
export const depthForProjectile = (gridX: number, gridY: number) =>
    baseDepth(gridX, gridY) + LAYER_OFFSETS.projectile;

/**
 * ═══════════════ THE TWO EFFECT DEPTH CLASSES (policy) ═══════════════
 *
 * Every effect is exactly one of two things:
 *
 * (a) GROUND-PLANE DECAL — flat art painted ON the lawn: slam cracks and
 *     dust/shock rings, scorch marks, craters, spike/caltrop hazard zones,
 *     rime & freeze rings, chill residue, deploy/heal/aura rings, any
 *     shockfront that travels along the ground. These must render UNDER
 *     every entity (troop, villager, building standing art) at ALL times →
 *     `depthForGroundDecal(kind)`: a small ABSOLUTE depth in the
 *     ground-decal band, above the stone-lanes RT (2.5) and below the
 *     entity range (1000+). NEVER give a lawn decal painter's-order depth:
 *     base+62 out-depths every troop up to ~0.4 rows in FRONT of the
 *     effect's tile, so the decal paints OVER units standing inside it
 *     (the golem-slam-ring-over-troops bug).
 *
 * (b) AIRBORNE / BURST FX — anything with a vertical body or in flight:
 *     explosion blooms, muzzle flashes, debris/embers/chips in flight,
 *     beams, rising smoke, floating particles, impact flashes. These sort
 *     with the world → painter's order via `depthForProjectile` /
 *     `depthForGroundEffect`.
 *
 * Debris that FALLS and LANDS may transition (a) ← (b) on landfall if a
 * case visibly needs it; today's landed chunks fade fast enough to stay
 * painter's-order.
 *
 * Sub-ordering of the decal band (persistent stains low, living/transient
 * FX on top; callers may stack tiny ±0.5 offsets for internal layering):
 */
export const GROUND_DECAL_DEPTHS = {
    /** Persistent earth damage: mortar craters, slam/impact crack webs. */
    crater: 3,
    /** Persistent hazard fields: spike-launcher caltrop zones. */
    zone: 4,
    /** Prism scorch / chasm trail. */
    scorch: 5,
    /** Dragons-breath scorch, melt puddles. */
    scorchHot: 6,
    /** Frost rime patches, freeze fissures, spike-impact cracks. */
    residue: 7,
    /** Living rings: heal/drum auras, heal waves, click/deploy pulses. */
    aura: 8,
    /** Transient expanding ground rings / dust blooms — topmost decal. */
    shockfront: 9
} as const;

export type GroundDecalKind = keyof typeof GROUND_DECAL_DEPTHS;

/**
 * Depth for a GROUND-PLANE effect decal (class (a) above): flat lawn art
 * that must never cover an entity. Absolute band value — no grid coords,
 * the decal never competes with painter's order.
 */
export const depthForGroundDecal = (kind: GroundDecalKind) => GROUND_DECAL_DEPTHS[kind];

/**
 * Painter's-order depth for AIRBORNE/burst FX (class (b) above): muzzle
 * flashes, impact blooms, debris in flight, rising smoke — effects with a
 * vertical body that sort with the world at a grid position, just above
 * the projectile band so an impact covers the shot that caused it. Callers
 * may stack tiny ±N offsets on top to keep an effect's internal layers
 * ordered. NOT for flat lawn decals (cracks/scorch/rings/zones) — those
 * use `depthForGroundDecal`, or they will paint over troops standing up
 * to ~0.4 rows in front of the tile.
 */
export const depthForGroundEffect = (gridX: number, gridY: number) =>
    baseDepth(gridX, gridY) + LAYER_OFFSETS.groundEffect;

// Debug handle (same culture as __clashGame/__clashGM/__clashBake — tiny and
// side-effect-free): the layering regression harness
// (tools/art-preview/verify-layering.mjs) and console diagnostics evaluate
// the REAL formulas through this instead of duplicating them.
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__clashDepth = {
        depthForFootprint,
        depthForBuilding,
        depthForObstacle,
        depthForRubble,
        depthForTroop,
        depthForProjectile,
        depthForGroundEffect,
        depthForGroundDecal
    };
}
