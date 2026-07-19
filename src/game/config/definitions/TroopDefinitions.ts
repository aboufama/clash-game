import { FACTION_BARRACKS, TROOP_FACTIONS, TROOP_FACTION_META, type FactionBarracksType, type TroopFaction } from './TroopFactions';
import type { SerializedBuilding } from '../../data/Models';

/**
 * The ONE player unlock/display authority: one troop per level in each
 * faction barracks, with the flagship at level 7. Consumers may group or
 * flatten these trees, but must never restate their membership or order.
 */
export const TROOP_TECH_TREES = {
    mystic: [
        'goblinplunderer',
        'wallbreaker',
        'stormmage',
        'necromancer',
        'warelephant',
        'golem',
        'icegolem'
    ],
    mechanica: [
        'clockworkbeetle',
        'ram',
        'mobilemortar',
        'siegetower',
        'trebuchet',
        'ornithopter',
        'davincitank'
    ]
} as const satisfies Record<TroopFaction, readonly string[]>;

/** Baseline troops unlocked one per completed, online Army Camp level. */
export const CORE_TROOP_TYPES = ['warrior', 'archer', 'physicianscart', 'phalanx'] as const;
export type CoreTroopType = typeof CORE_TROOP_TYPES[number];

/** The ONE Army Camp unlock authority for the factionless baseline roster. */
export const CORE_TROOP_UNLOCK_LEVELS = {
    warrior: 1,
    archer: 2,
    physicianscart: 3,
    phalanx: 4
} as const satisfies Record<CoreTroopType, number>;

export function getCoreTroopUnlockLevel(troopType: string): number {
    return isCoreTroopType(troopType) ? CORE_TROOP_UNLOCK_LEVELS[troopType] : Infinity;
}

export interface ArmyCampUnlockProgress {
    /** Highest fully online Army Camp level. A camp under upgrade is offline. */
    completedLevel: number;
    /** Highest in-flight target among camps, or null when none are upgrading. */
    upgradingToLevel: number | null;
    upgrading: boolean;
}

/** Shared client/server Army Camp progression. The persisted `level` is only
 * eligible while that camp is online; `upgradingTo` is presentation state,
 * never unlock authority. */
export function armyCampUnlockProgress(
    buildings: readonly SerializedBuilding[]
): ArmyCampUnlockProgress {
    let completedLevel = 0;
    let upgradingToLevel: number | null = null;
    for (const building of buildings) {
        if (building.type !== 'army_camp') continue;
        const level = Math.max(1, Math.floor(Number(building.level) || 1));
        const upgradingTo = Math.floor(Number(building.upgradingTo) || 0);
        if (upgradingTo > 0) {
            upgradingToLevel = Math.max(upgradingToLevel ?? 0, upgradingTo);
            continue;
        }
        completedLevel = Math.max(completedLevel, level);
    }
    return {
        completedLevel,
        upgradingToLevel,
        upgrading: upgradingToLevel !== null
    };
}

export function maxCompletedArmyCampLevel(
    buildings: readonly SerializedBuilding[]
): number {
    return armyCampUnlockProgress(buildings).completedLevel;
}
export type FactionTroopType = typeof TROOP_TECH_TREES[TroopFaction][number];

/** Canonical faction-tree flattening; barracks progression reads only this. */
export const FACTION_TROOP_TYPES = TROOP_FACTIONS.flatMap(
    faction => [...TROOP_TECH_TREES[faction]]
) as readonly FactionTroopType[];

export type TrainableTroopType = CoreTroopType | FactionTroopType;
export const TRAINABLE_TROOP_TYPES = [
    ...CORE_TROOP_TYPES,
    ...FACTION_TROOP_TYPES
] as readonly TrainableTroopType[];

/** Retained-owned troop ids, if any. Catalog deletions intentionally do not
 * enter this list: removed Biopunk armies self-clean as unsupported data. */
export const LEGACY_PLAYER_TROOP_TYPES = [] as const;
export type LegacyPlayerTroopType = typeof LEGACY_PLAYER_TROOP_TYPES[number];
export type PlayerTroopType = TrainableTroopType | LegacyPlayerTroopType;

/** Stable army/battle-bar order: Core, faction trees, then owned legacy units. */
export const PLAYER_TROOP_TYPES = [
    ...TRAINABLE_TROOP_TYPES,
    ...LEGACY_PLAYER_TROOP_TYPES
] as readonly PlayerTroopType[];
/** Scenario-only units stay renderable but never enter a player's army. */
export type TroopType = PlayerTroopType | 'romanwarrior' | 'skeleton';

const CORE_TROOP_TYPE_SET: ReadonlySet<string> = new Set(CORE_TROOP_TYPES);
const FACTION_TROOP_TYPE_SET: ReadonlySet<string> = new Set(FACTION_TROOP_TYPES);
const TRAINABLE_TROOP_TYPE_SET: ReadonlySet<string> = new Set(TRAINABLE_TROOP_TYPES);
const LEGACY_PLAYER_TROOP_TYPE_SET: ReadonlySet<string> = new Set(LEGACY_PLAYER_TROOP_TYPES);

export function isCoreTroopType(value: string): value is CoreTroopType {
    return CORE_TROOP_TYPE_SET.has(value);
}

export function isFactionTroopType(value: string): value is FactionTroopType {
    return FACTION_TROOP_TYPE_SET.has(value);
}

export function isTrainableTroopType(value: string): value is TrainableTroopType {
    return TRAINABLE_TROOP_TYPE_SET.has(value);
}

export function isLegacyPlayerTroopType(value: string): value is LegacyPlayerTroopType {
    return LEGACY_PLAYER_TROOP_TYPE_SET.has(value);
}

/**
 * Units that only ever exist because another unit spawned them (phalanx →
 * romanwarrior, necromancer → skeleton). Both client and server gate on this
 * ONE set: generated-only types are never trainable, reservable or directly
 * deployable. Typed over plain strings so untrusted ids can be checked
 * without casting.
 */
export const GENERATED_ONLY: ReadonlySet<string> = new Set<TroopType>(['romanwarrior', 'skeleton']);

export interface TroopDef {
    id: TroopType;
    name: string;
    cost: number;
    space: number;
    desc: string;
    health: number;
    range: number;
    damage: number;
    speed: number;
    color: number;
    targetPriority?: 'town_hall' | 'defense' | 'wall' | 'resource';
    wallDamageMultiplier?: number;
    /** Damage multiplier applied when the target is a resource building (goblin plunderer). */
    resourceDamageMultiplier?: number;
    /** Summoner (necromancer): the generated-only troop type it raises. */
    summonType?: TroopType;
    /** Summoner: units raised per summon wave. */
    summonCount?: number;
    /** Summoner: ms between summon waves. */
    summonIntervalMs?: number;
    /** Summoner: max summons alive PER SUMMONER (checked via summonedBy === troop.id). */
    summonCap?: number;
    /** Suicide unit: dies delivering its attack (wallbreaker, clockwork beetle). */
    detonateOnAttack?: boolean;
    /** Suicide-unit fuse after contact. The clockwork beetle attaches to its
     *  target for this exact duration before its single detonation. */
    detonationDelayMs?: number;
    chainCount?: number;
    chainRange?: number;
    healRadius?: number;
    healAmount?: number;
    attackDelay?: number;
    firstAttackDelay?: number;
    splashRadius?: number;
    movementType?: 'ground' | 'air' | 'ghost';
    /** Planner-only breach reluctance; never permission to phase through walls. */
    wallTraversalCost?: number;
    /** Charger: plans a straight ray to its objective and attacks the first structure on it. */
    straightCharge?: boolean;
}

export const TROOP_DEFINITIONS: Record<TroopType, TroopDef> = {
    warrior: { id: 'warrior', name: 'Barbarian', cost: 25, space: 1, desc: 'Army Camp L1 melee fighter with dependable all-round stats.', health: 100, range: 0.5, damage: 10, speed: 0.003, color: 0xffff00, attackDelay: 800 },
    archer: { id: 'archer', name: 'Archer', cost: 40, space: 1, desc: 'Army Camp L2 ranged fighter who attacks safely from behind the line.', health: 50, range: 2.7, damage: 14.0, speed: 0.0025, color: 0x00ffff, attackDelay: 900 },
    ram: { id: 'ram', name: 'Battering Ram', cost: 200, space: 8, desc: 'Mechanica siege engine. Charges the Town Hall and deals 4x wall damage.', health: 800, range: 0.6, damage: 50, speed: 0.0018, color: 0x8b4513, targetPriority: 'town_hall', wallDamageMultiplier: 4, wallTraversalCost: 50, straightCharge: true, attackDelay: 1100 },
    stormmage: { id: 'stormmage', name: 'Storm Mage', cost: 180, space: 6, desc: 'Chain lightning hits 4 targets.', health: 200, range: 4.9, damage: 40, speed: 0.002, color: 0x4444ff, chainCount: 4, chainRange: 5, attackDelay: 1700 },
    golem: { id: 'golem', name: 'Stone Golem', cost: 500, space: 25, desc: 'Colossal stone titan. Nearly indestructible.', health: 9000, range: 0.8, damage: 106, speed: 0.0004, color: 0x6b7b8b, targetPriority: 'defense', attackDelay: 3000, firstAttackDelay: 1500 },
    // Ice golem = golem chassis with a faster slam and a lighter frame:
    // attackDelay 3000→2700 (+10% cadence, firstAttackDelay scaled 1500→1350),
    // health 9000→8100 (−10%). Housing/cost/damage/range/speed match golem.
    icegolem: { id: 'icegolem', name: 'Ice Golem', cost: 500, space: 25, desc: 'Mystic flagship: a frozen colossus with a swift, crushing slam.', health: 8100, range: 0.8, damage: 106, speed: 0.0004, color: 0x9ed2e6, targetPriority: 'defense', attackDelay: 2700, firstAttackDelay: 1350 },
    mobilemortar: { id: 'mobilemortar', name: 'Mobile Mortar', cost: 180, space: 8, desc: 'Portable mortar with splash damage.', health: 150, range: 6.75, damage: 200, speed: 0.0012, color: 0x555555, splashRadius: 2.2, attackDelay: 2200, firstAttackDelay: 1000 },
    davincitank: { id: 'davincitank', name: 'Da Vinci Tank', cost: 600, space: 30, desc: 'Mechanica flagship: Leonardo\'s armored war machine fires in every direction.', health: 8000, range: 4.0, damage: 80, speed: 0.0006, color: 0xb8956e, targetPriority: 'defense', attackDelay: 1800 },
    phalanx: { id: 'phalanx', name: 'Phalanx', cost: 350, space: 18, desc: 'Army Camp L4 runic shield formation that splits into nine Bound Spirits on death.', health: 3000, range: 0.6, damage: 45, speed: 0.0008, color: 0xc9a07a, attackDelay: 1400 },
    romanwarrior: { id: 'romanwarrior', name: 'Bound Spirit', cost: 0, space: 1, desc: 'An individual spirit released from a fallen Phalanx.', health: 300, range: 0.5, damage: 15, speed: 0.0015, color: 0xcc3333, attackDelay: 900 },
    wallbreaker: { id: 'wallbreaker', name: 'Emberling', cost: 100, space: 4, desc: 'Volatile summoned creature that races to walls and erupts.', health: 200, range: 0.5, damage: 800, speed: 0.004, color: 0xff6633, targetPriority: 'wall', wallDamageMultiplier: 3, splashRadius: 2.5, attackDelay: 500, detonateOnAttack: true },
    goblinplunderer: { id: 'goblinplunderer', name: 'Goblin Plunderer', cost: 30, space: 1, desc: 'Manic thief. Beelines for resources and hits them 3x harder.', health: 80, range: 0.5, damage: 6, speed: 0.0038, color: 0x7ec850, targetPriority: 'resource', resourceDamageMultiplier: 3, attackDelay: 700 },
    clockworkbeetle: { id: 'clockworkbeetle', name: 'Clockwork Beetle', cost: 60, space: 1, desc: 'Leaps onto a building, clamps on, and detonates almost instantly.', health: 60, range: 0.5, damage: 150, speed: 0.0035, color: 0x7a5c20, splashRadius: 1.8, attackDelay: 500, detonateOnAttack: true, detonationDelayMs: 125 },
    physicianscart: { id: 'physicianscart', name: 'Healer', cost: 120, space: 5, desc: 'Army Camp L3 support cart that restores nearby allied troops.', health: 600, range: 0.5, damage: 0, speed: 0.0012, color: 0x8fd98f, healRadius: 5.5, healAmount: 120, attackDelay: 6000 },
    // Siege tower rides the ram's straight-charge lane: the ray to the town
    // hall finds the nearest wall on its line; the tower PARKS there (damage 0
    // — it never fights) and the wall becomes the ally ramp.
    siegetower: { id: 'siegetower', name: 'Siege Tower', cost: 300, space: 14, desc: 'Rolling belfry. Parks tight against a wall and turns it into a ramp for allies.', health: 3500, range: 0.2, damage: 0, speed: 0.001, color: 0x9a7b4f, targetPriority: 'town_hall', straightCharge: true },
    necromancer: { id: 'necromancer', name: 'Necromancer', cost: 320, space: 12, desc: 'Raises skeletons from the battlefield while blasting from range.', health: 900, range: 4.0, damage: 25, speed: 0.0014, color: 0x6a4c93, summonType: 'skeleton', summonCount: 2, summonIntervalMs: 5000, summonCap: 8, attackDelay: 1600 },
    trebuchet: { id: 'trebuchet', name: 'Trebuchet Crew', cost: 450, space: 16, desc: 'Counterweight artillery. Outranges every defense but one.', health: 1200, range: 11.0, damage: 320, speed: 0.0006, color: 0x8a6d4a, splashRadius: 2.0, attackDelay: 4000, firstAttackDelay: 1500 },
    warelephant: { id: 'warelephant', name: 'War Elephant', cost: 420, space: 12, desc: 'Armored titan. Tramples straight through walls.', health: 4200, range: 0.6, damage: 85, speed: 0.0011, color: 0x8d8d99, wallDamageMultiplier: 20, attackDelay: 2000 },
    ornithopter: { id: 'ornithopter', name: 'Ornithopter', cost: 550, space: 15, desc: "Da Vinci's flying machine. Soars over walls and bombs defenses.", health: 1500, range: 1.5, damage: 90, speed: 0.0022, color: 0xa88d5e, splashRadius: 1.2, movementType: 'air', targetPriority: 'defense', attackDelay: 1600 },
    skeleton: { id: 'skeleton', name: 'Skeleton', cost: 0, space: 1, desc: 'A rattling servant raised by a Necromancer.', health: 180, range: 0.5, damage: 14, speed: 0.0025, color: 0xd8d8c8, attackDelay: 900 }
};

/** Compatibility flattening for consumers that only need faction unlocks. */
export const BARRACKS_TROOP_UNLOCK_ORDER: readonly FactionTroopType[] = [...FACTION_TROOP_TYPES];

/** Visual affinity for generated-only troops outside the training trees. */
const NON_TREE_TROOP_FACTIONS: Partial<Record<TroopType, TroopFaction>> = {
    romanwarrior: 'mystic',
    skeleton: 'mystic'
};

/** Core troops are factionless; generated troops retain visual affinity. */
export function getTroopFaction(troopType: TroopType): TroopFaction | null {
    if (isCoreTroopType(troopType)) return null;
    for (const faction of TROOP_FACTIONS) {
        if ((TROOP_TECH_TREES[faction] as readonly string[]).includes(troopType)) return faction;
    }
    return NON_TREE_TROOP_FACTIONS[troopType] ?? null;
}

export function troopsForFaction(faction: TroopFaction): readonly FactionTroopType[] {
    return TROOP_TECH_TREES[faction];
}

/** Core unlocks at Army Camp L1-L4; faction nodes at L1-L7; generated are Infinity. */
export function getTroopUnlockLevel(troopType: TroopType): number {
    if (isCoreTroopType(troopType)) return getCoreTroopUnlockLevel(troopType);
    if (!isFactionTroopType(troopType)) return Infinity;
    const faction = getTroopFaction(troopType);
    if (!faction) return Infinity;
    const index = (TROOP_TECH_TREES[faction] as readonly string[]).indexOf(troopType);
    return index >= 0 ? index + 1 : Infinity;
}

export interface CoreTroopTrainingRequirement {
    kind: 'core';
    campType: 'army_camp';
    campName: 'Army Camp';
    unlockLevel: number;
}

export interface FactionTroopTrainingRequirement {
    kind: 'barracks';
    faction: TroopFaction;
    barracksType: FactionBarracksType;
    barracksName: string;
    unlockLevel: number;
}

export type TroopTrainingRequirement = CoreTroopTrainingRequirement | FactionTroopTrainingRequirement;

/** Shared client/server unlock requirement. Legacy/generated types return null. */
export function troopTrainingRequirement(troopType: TroopType): TroopTrainingRequirement | null {
    if (isCoreTroopType(troopType)) {
        return {
            kind: 'core',
            campType: 'army_camp',
            campName: 'Army Camp',
            unlockLevel: getCoreTroopUnlockLevel(troopType)
        };
    }
    if (!isFactionTroopType(troopType)) return null;
    const faction = getTroopFaction(troopType);
    if (!faction) return null;
    return {
        kind: 'barracks',
        faction,
        barracksType: FACTION_BARRACKS[faction],
        barracksName: TROOP_FACTION_META[faction].barracksName,
        unlockLevel: getTroopUnlockLevel(troopType)
    };
}

export function factionUnlocksAtLevel(faction: TroopFaction, level: number): readonly FactionTroopType[] {
    const index = Math.floor(Number(level) || 0) - 1;
    const troop = index >= 0 ? TROOP_TECH_TREES[faction][index] : undefined;
    return troop ? [troop] : [];
}

const TROOP_LEVEL_MULTIPLIERS: Record<number, number> = {
    1: 1,
    2: 1.3,
    3: 1.65
};

const toScaledFloat = (value: number, multiplier: number, digits: number = 2) =>
    Number((value * multiplier).toFixed(digits));

export function normalizeTroopLevel(level: number = 1): number {
    if (!Number.isFinite(level)) return 1;
    const normalized = Math.max(1, Math.floor(level));
    const maxDefined = Math.max(...Object.keys(TROOP_LEVEL_MULTIPLIERS).map(Number));
    return Math.min(normalized, maxDefined);
}

export function getTroopLevelMultiplier(level: number = 1): number {
    return TROOP_LEVEL_MULTIPLIERS[normalizeTroopLevel(level)] ?? 1;
}

// Called per troop per frame in combat loops; cached results are read-only.
const troopStatsCache = new Map<string, TroopDef>();

export function getTroopStats(type: TroopType, level: number = 1): TroopDef {
    const cacheKey = `${type}:${normalizeTroopLevel(level)}`;
    const cached = troopStatsCache.get(cacheKey);
    if (cached) return cached;

    const base = TROOP_DEFINITIONS[type];
    const multiplier = getTroopLevelMultiplier(level);

    let stats: TroopDef;
    if (multiplier <= 1) {
        stats = { ...base };
    } else {
        const utilityMultiplier = 1 + (multiplier - 1) * 0.45;
        const speedMultiplier = 1 + (multiplier - 1) * 0.25;
        const attackSpeedMultiplier = 1 + (multiplier - 1) * 0.2;

        stats = {
            ...base,
            health: Math.round(base.health * multiplier),
            damage: toScaledFloat(base.damage, multiplier),
            speed: toScaledFloat(base.speed, speedMultiplier, 6),
            range: toScaledFloat(base.range, utilityMultiplier),
            healRadius: typeof base.healRadius === 'number' ? toScaledFloat(base.healRadius, utilityMultiplier) : base.healRadius,
            healAmount: typeof base.healAmount === 'number' ? toScaledFloat(base.healAmount, multiplier) : base.healAmount,
            chainRange: typeof base.chainRange === 'number' ? toScaledFloat(base.chainRange, utilityMultiplier) : base.chainRange,
            splashRadius: typeof base.splashRadius === 'number' ? toScaledFloat(base.splashRadius, utilityMultiplier) : base.splashRadius,
            attackDelay: typeof base.attackDelay === 'number' ? Math.max(150, Math.round(base.attackDelay / attackSpeedMultiplier)) : base.attackDelay
        };
    }

    troopStatsCache.set(cacheKey, stats);
    return stats;
}
