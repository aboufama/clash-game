/** Canonical battle-bar/training order; consumers must not restate this list. */
export const PLAYER_TROOP_TYPES = [
    'warrior',
    'archer',
    'wallbreaker',
    'ram',
    'stormmage',
    'golem',
    'icegolem',
    'mobilemortar',
    'davincitank',
    'phalanx'
] as const;

export type PlayerTroopType = typeof PLAYER_TROOP_TYPES[number];
/** Scenario-only units stay renderable but never enter a player's army. */
export type TroopType = PlayerTroopType | 'romanwarrior';

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
    boostRadius?: number;
    boostAmount?: number;
    targetPriority?: 'town_hall' | 'defense' | 'wall';
    wallDamageMultiplier?: number;
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
}

export const TROOP_DEFINITIONS: Record<TroopType, TroopDef> = {
    warrior: { id: 'warrior', name: 'Warrior', cost: 25, space: 1, desc: 'Fast melee fighter.', health: 100, range: 0.5, damage: 10, speed: 0.003, color: 0xffff00, attackDelay: 800 },
    archer: { id: 'archer', name: 'Archer', cost: 40, space: 1, desc: 'Ranged attacker.', health: 50, range: 2.7, damage: 14.0, speed: 0.0025, color: 0x00ffff, attackDelay: 900 },
    ram: { id: 'ram', name: 'Battering Ram', cost: 200, space: 8, desc: 'Charges Town Hall. 4x wall damage.', health: 800, range: 0.6, damage: 50, speed: 0.0018, color: 0x8b4513, targetPriority: 'town_hall', wallDamageMultiplier: 4, wallTraversalCost: 50, attackDelay: 1100 },
    stormmage: { id: 'stormmage', name: 'Storm Mage', cost: 180, space: 6, desc: 'Chain lightning hits 4 targets.', health: 200, range: 4.9, damage: 40, speed: 0.002, color: 0x4444ff, chainCount: 4, chainRange: 5, attackDelay: 1700 },
    golem: { id: 'golem', name: 'Stone Golem', cost: 500, space: 25, desc: 'Colossal stone titan. Nearly indestructible.', health: 9000, range: 0.8, damage: 106, speed: 0.0004, color: 0x6b7b8b, targetPriority: 'defense', attackDelay: 3000, firstAttackDelay: 1500 },
    // Ice golem = golem chassis with a faster slam and a lighter frame:
    // attackDelay 3000→2700 (+10% cadence, firstAttackDelay scaled 1500→1350),
    // health 9000→8100 (−10%). Housing/cost/damage/range/speed match golem.
    icegolem: { id: 'icegolem', name: 'Ice Golem', cost: 500, space: 25, desc: 'Frozen colossus. Swifter slam, lighter frame.', health: 8100, range: 0.8, damage: 106, speed: 0.0004, color: 0x9ed2e6, targetPriority: 'defense', attackDelay: 2700, firstAttackDelay: 1350 },
    mobilemortar: { id: 'mobilemortar', name: 'Mobile Mortar', cost: 180, space: 8, desc: 'Portable mortar with splash damage.', health: 150, range: 6.75, damage: 200, speed: 0.0012, color: 0x555555, splashRadius: 2.2, attackDelay: 2200, firstAttackDelay: 1000 },
    davincitank: { id: 'davincitank', name: 'Da Vinci Tank', cost: 600, space: 30, desc: 'Leonardo\'s armored war machine. Spins and fires in all directions.', health: 8000, range: 4.0, damage: 80, speed: 0.0006, color: 0xb8956e, targetPriority: 'defense', attackDelay: 1800 },
    phalanx: { id: 'phalanx', name: 'Phalanx', cost: 350, space: 18, desc: 'Roman testudo formation. 3x3 shield wall with spears. Splits into 9 soldiers on death.', health: 3000, range: 0.6, damage: 45, speed: 0.0008, color: 0xc9a07a, attackDelay: 1400 },
    romanwarrior: { id: 'romanwarrior', name: 'Roman Soldier', cost: 0, space: 1, desc: 'An individual soldier from a Phalanx formation.', health: 300, range: 0.5, damage: 15, speed: 0.0015, color: 0xcc3333, attackDelay: 900 },
    wallbreaker: { id: 'wallbreaker', name: 'Wall Breaker', cost: 100, space: 4, desc: 'Suicidal bomber. Runs at walls and explodes for massive damage.', health: 200, range: 0.5, damage: 800, speed: 0.004, color: 0xff6633, targetPriority: 'wall', wallDamageMultiplier: 3, splashRadius: 2.5, attackDelay: 500 }
};

/** Maps barracks level (1-indexed) to the troop type unlocked at that level. */
export const BARRACKS_TROOP_UNLOCK_ORDER: TroopType[] = [
    'warrior',
    'archer',
    'wallbreaker',
    'stormmage',
    'mobilemortar',
    'ram',
    'phalanx',
    'golem',
    'icegolem',
    'davincitank'
];

/** Returns Infinity for non-trainable troop types. */
export function getTroopUnlockLevel(troopType: TroopType): number {
    const index = BARRACKS_TROOP_UNLOCK_ORDER.indexOf(troopType);
    return index >= 0 ? index + 1 : Infinity;
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
