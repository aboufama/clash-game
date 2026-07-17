/** Canonical battle-bar/training order; consumers must not restate this list.
 *  This IS the unlock order: two troops unlock per barracks level (see
 *  getTroopUnlockLevel), so the tuple doubles as the display order. */
export const PLAYER_TROOP_TYPES = [
    'warrior',
    'archer',
    'wallbreaker',
    'goblinplunderer',
    'clockworkbeetle',
    'physicianscart',
    'stormmage',
    'mobilemortar',
    'ram',
    'phalanx',
    'quartermaster',
    'siegetower',
    'golem',
    'icegolem',
    'necromancer',
    'trebuchet',
    'davincitank',
    'warelephant',
    'ornithopter'
] as const;

export type PlayerTroopType = typeof PLAYER_TROOP_TYPES[number];
/** Scenario-only units stay renderable but never enter a player's army. */
export type TroopType = PlayerTroopType | 'romanwarrior' | 'skeleton';

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
    boostRadius?: number;
    boostAmount?: number;
    /** Quartermaster war drums: fraction shaved off allies' effective attack delay (0.15 = −15%). */
    boostCadence?: number;
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
    warrior: { id: 'warrior', name: 'Warrior', cost: 25, space: 1, desc: 'Fast melee fighter.', health: 100, range: 0.5, damage: 10, speed: 0.003, color: 0xffff00, attackDelay: 800 },
    archer: { id: 'archer', name: 'Archer', cost: 40, space: 1, desc: 'Ranged attacker.', health: 50, range: 2.7, damage: 14.0, speed: 0.0025, color: 0x00ffff, attackDelay: 900 },
    ram: { id: 'ram', name: 'Battering Ram', cost: 200, space: 8, desc: 'Charges Town Hall. 4x wall damage.', health: 800, range: 0.6, damage: 50, speed: 0.0018, color: 0x8b4513, targetPriority: 'town_hall', wallDamageMultiplier: 4, wallTraversalCost: 50, straightCharge: true, attackDelay: 1100 },
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
    wallbreaker: { id: 'wallbreaker', name: 'Wall Breaker', cost: 100, space: 4, desc: 'Suicidal bomber. Runs at walls and explodes for massive damage.', health: 200, range: 0.5, damage: 800, speed: 0.004, color: 0xff6633, targetPriority: 'wall', wallDamageMultiplier: 3, splashRadius: 2.5, attackDelay: 500, detonateOnAttack: true },
    goblinplunderer: { id: 'goblinplunderer', name: 'Goblin Plunderer', cost: 30, space: 1, desc: 'Manic thief. Beelines for resources and hits them 3x harder.', health: 80, range: 0.5, damage: 6, speed: 0.0038, color: 0x7ec850, targetPriority: 'resource', resourceDamageMultiplier: 3, attackDelay: 700 },
    clockworkbeetle: { id: 'clockworkbeetle', name: 'Clockwork Beetle', cost: 60, space: 1, desc: 'Wind-up bomb on legs. Scuttles to the nearest building and detonates.', health: 60, range: 0.5, damage: 150, speed: 0.0035, color: 0x7a5c20, splashRadius: 1.8, attackDelay: 500, detonateOnAttack: true },
    physicianscart: { id: 'physicianscart', name: "Physician's Cart", cost: 120, space: 5, desc: 'Battlefield medic. Never attacks; pulses healing to nearby allies.', health: 600, range: 0.5, damage: 0, speed: 0.0012, color: 0x8fd98f, healRadius: 5.5, healAmount: 120, attackDelay: 6000 },
    quartermaster: { id: 'quartermaster', name: 'Quartermaster', cost: 250, space: 8, desc: 'War drums. Never attacks; nearby allies march and strike faster.', health: 900, range: 0.5, damage: 0, speed: 0.0018, color: 0xd4a017, boostRadius: 6.0, boostAmount: 1.5, boostCadence: 0.15 },
    // Siege tower rides the ram's straight-charge lane: the ray to the town
    // hall finds the nearest wall on its line; the tower PARKS there (damage 0
    // — it never fights) and the wall becomes the ally ramp.
    siegetower: { id: 'siegetower', name: 'Siege Tower', cost: 300, space: 14, desc: 'Rolling belfry. Parks at a wall and turns it into a ramp for allies.', health: 3500, range: 0.5, damage: 0, speed: 0.001, color: 0x9a7b4f, targetPriority: 'town_hall', straightCharge: true },
    necromancer: { id: 'necromancer', name: 'Necromancer', cost: 320, space: 12, desc: 'Raises skeletons from the battlefield while blasting from range.', health: 900, range: 4.0, damage: 25, speed: 0.0014, color: 0x6a4c93, summonType: 'skeleton', summonCount: 2, summonIntervalMs: 5000, summonCap: 8, attackDelay: 1600 },
    trebuchet: { id: 'trebuchet', name: 'Trebuchet Crew', cost: 450, space: 16, desc: 'Counterweight artillery. Outranges every defense but one.', health: 1200, range: 11.0, damage: 320, speed: 0.0006, color: 0x8a6d4a, splashRadius: 2.0, attackDelay: 4000, firstAttackDelay: 1500 },
    warelephant: { id: 'warelephant', name: 'War Elephant', cost: 420, space: 12, desc: 'Armored titan. Tramples straight through walls.', health: 4200, range: 0.6, damage: 85, speed: 0.0011, color: 0x8d8d99, wallDamageMultiplier: 20, attackDelay: 2000 },
    ornithopter: { id: 'ornithopter', name: 'Ornithopter', cost: 550, space: 15, desc: "Da Vinci's flying machine. Soars over walls and bombs defenses.", health: 1500, range: 1.5, damage: 90, speed: 0.0022, color: 0xa88d5e, splashRadius: 1.2, movementType: 'air', targetPriority: 'defense', attackDelay: 1600 },
    skeleton: { id: 'skeleton', name: 'Skeleton', cost: 0, space: 1, desc: 'A rattling servant raised by a Necromancer.', health: 180, range: 0.5, damage: 14, speed: 0.0025, color: 0xd8d8c8, attackDelay: 900 }
};

/** Unlock sequence: TWO troops per barracks level (owner directive), so the
 *  troop unlocked at level L sits at indices 2(L−1) and 2(L−1)+1. Identical
 *  to PLAYER_TROOP_TYPES — the tuple IS the unlock order. */
export const BARRACKS_TROOP_UNLOCK_ORDER: TroopType[] = [...PLAYER_TROOP_TYPES];

/** Returns Infinity for non-trainable troop types. Two troops unlock per
 *  barracks level: level = floor(index / 2) + 1. */
export function getTroopUnlockLevel(troopType: TroopType): number {
    const index = BARRACKS_TROOP_UNLOCK_ORDER.indexOf(troopType);
    return index >= 0 ? Math.floor(index / 2) + 1 : Infinity;
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
