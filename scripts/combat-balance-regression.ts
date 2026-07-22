import assert from 'node:assert/strict';
import {
    TRAINABLE_TROOP_TYPES,
    TROOP_DEFINITIONS,
    getBuildingStats,
    getTroopStats,
    type BuildingType,
    type TroopDef
} from '../src/game/config/GameDefinitions';
import {
    DEFENSE_BEHAVIOR_CATALOG,
    defenseDps,
    type ActiveDefenseType
} from '../src/game/systems/DefenseBehaviorCatalog';

const stableLabFields = [
    'range',
    'speed',
    'attackDelay',
    'firstAttackDelay',
    'splashRadius',
    'chainRange',
    'healRadius'
] as const satisfies readonly (keyof TroopDef)[];

for (const type of TRAINABLE_TROOP_TYPES) {
    const base = TROOP_DEFINITIONS[type];
    for (const level of [2, 3]) {
        const upgraded = getTroopStats(type, level);
        assert(upgraded.health >= base.health, `${type} L${level} lost health`);
        assert(upgraded.damage >= base.damage, `${type} L${level} lost damage`);
        for (const field of stableLabFields) {
            assert.equal(
                upgraded[field],
                base[field],
                `${type} L${level} changed ${field}; Lab upgrades must preserve counter geometry and timing`
            );
        }
    }
}

const trebuchet = getTroopStats('trebuchet', 3);
assert.equal(trebuchet.range, 9.25, 'Trebuchet range must remain fixed through L3');
assert(trebuchet.space >= 18, 'Trebuchet artillery safety must carry a meaningful housing cost');
assert(trebuchet.firstAttackDelay! >= 2_000, 'Trebuchet must expose a setup window before its first boulder');

/** Defenses target from their center while troops attack the nearest footprint
 * edge. Subtracting the half-diagonal is the conservative, any-approach reach
 * beyond that footprint. A positive margin means the defense can answer the
 * Trebuchet even on a diagonal approach. */
function edgeReach(type: BuildingType, level: number): number {
    const stats = getBuildingStats(type, level);
    return (stats.range ?? 0) - Math.hypot((stats.width ?? 1) / 2, (stats.height ?? 1) / 2);
}

assert(edgeReach('xbow', 1) - trebuchet.range >= 0.25,
    'L1 X-Bow needs a visible all-angle counter window against Trebuchet');
assert(edgeReach('mortar', 4) >= trebuchet.range,
    'max Mortar should narrowly answer Trebuchet after investing in upgrades');
assert(edgeReach('dragons_breath', 1) - trebuchet.range >= 1,
    "Dragon's Breath must comfortably cover Trebuchet on every approach");

const beetle = TROOP_DEFINITIONS.clockworkbeetle;
assert(beetle.space >= 2 && beetle.damage <= 140,
    'one-space Clockwork Beetle burst spam must stay retired');
const elephant = TROOP_DEFINITIONS.warelephant;
assert(elephant.space >= 16 && (elephant.wallDamageMultiplier ?? Infinity) <= 10,
    'War Elephant must not match Golem durability per housing while one-shotting max walls');

for (const type of Object.keys(DEFENSE_BEHAVIOR_CATALOG) as ActiveDefenseType[]) {
    const definition = getBuildingStats(type, 1);
    const maxLevel = Math.max(1, definition.maxLevel ?? 1);
    let priorHp = 0;
    let priorDps = 0;
    let priorRange = 0;
    for (let level = 1; level <= maxLevel; level++) {
        const stats = getBuildingStats(type, level);
        const dps = defenseDps(type, stats) ?? 0;
        assert(stats.maxHealth >= priorHp, `${type} L${level} health regressed`);
        assert(dps >= priorDps, `${type} L${level} DPS regressed`);
        assert((stats.range ?? 0) >= priorRange, `${type} L${level} range regressed`);
        assert((stats.minRange ?? 0) < (stats.range ?? Infinity), `${type} L${level} has no legal firing band`);
        priorHp = stats.maxHealth;
        priorDps = dps;
        priorRange = stats.range ?? 0;
    }
}

const ballistaL3 = defenseDps('ballista', getBuildingStats('ballista', 3)) ?? 0;
const xbowL3 = defenseDps('xbow', getBuildingStats('xbow', 3)) ?? 0;
assert(ballistaL3 > xbowL3, 'Ballista must retain its heavy single-hit DPS niche over X-Bow');
assert((defenseDps('prism', getBuildingStats('prism', 4)) ?? Infinity) <= 300,
    'Prism cap must not return to its no-dead-zone 330 DPS outlier');
assert((defenseDps('dragons_breath', getBuildingStats('dragons_breath', 2)) ?? Infinity) <= 280,
    "Dragon's Breath L2 salvo progression must stay below the old 300 DPS spike");
assert((defenseDps('spike_launcher', getBuildingStats('spike_launcher', 4)) ?? 0) >= 70,
    'Spike Launcher settlement must credit a bounded share of its persistent hazard');

console.log('combat balance regressions passed');
