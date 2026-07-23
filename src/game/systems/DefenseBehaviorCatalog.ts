import type { DefenseBuildingType } from '../config/GameDefinitions';

/** Walls share the defense shop category but never participate in combat ticks. */
export type ActiveDefenseType = Exclude<DefenseBuildingType, 'wall'>;

export type DefenseTargetingPolicy = 'locked' | 'nearest';
export type DefenseStartPolicy = 'cooldown' | 'ready';
export type DefenseIdleEffect = 'cleanupPrismLaser';

export type DefenseScheduler =
    | { kind: 'standard' }
    | { kind: 'charged'; chargeMs: number; chargedVisualMs: number };

/**
 * How the declared `damage` stat maps onto time — the ONE derivation the
 * combat code and the UI share (see `defenseDps`):
 *  - `perShot`: `damage` lands once per `fireRate` ms, × `salvoSize` shots
 *    per volley (salvo batteries fire every pod at the same volley cadence).
 *  - `dps`: `damage` IS damage-per-second; `fireRate` is only the tick
 *    granularity a continuous beam applies it at
 *    (see MainScene.shootPrismContinuousLaser).
 */
export type DefenseFireModel =
    | {
        kind: 'perShot';
        salvoSize?: number;
        /** Expected total damage from one launch after bounded secondary
         * effects. Spike Launcher uses impact + two typical zone ticks; the
         * live hazard can punish a stationary tank longer, but settlement
         * must not pretend the persistent zone does no damage at all. */
        secondaryDamageMultiplier?: number;
    }
    | { kind: 'dps' };

export interface DefenseBehavior {
    fireEffect: ActiveDefenseType;
    targeting: DefenseTargetingPolicy;
    start: DefenseStartPolicy;
    scheduler: DefenseScheduler;
    fireModel: DefenseFireModel;
    idleEffect?: DefenseIdleEffect;
}

const LOCKED_STANDARD = {
    targeting: 'locked',
    scheduler: { kind: 'standard' },
    fireModel: { kind: 'perShot' }
} as const;

const NEAREST_STANDARD = {
    targeting: 'nearest',
    scheduler: { kind: 'standard' },
    fireModel: { kind: 'perShot' }
} as const;

/**
 * Runtime behavior belongs beside the defense catalog, not in MainScene.
 * Adding a defense to DefenseBuildingType makes this record fail to compile
 * until its scheduling and targeting policy are declared here.
 */
export const DEFENSE_BEHAVIOR_CATALOG = {
    cannon: { ...LOCKED_STANDARD, fireEffect: 'cannon', start: 'cooldown' },
    ballista: { ...LOCKED_STANDARD, fireEffect: 'ballista', start: 'cooldown' },
    xbow: { ...LOCKED_STANDARD, fireEffect: 'xbow', start: 'cooldown' },
    mortar: { ...NEAREST_STANDARD, fireEffect: 'mortar', start: 'cooldown' },
    tesla: {
        fireEffect: 'tesla',
        targeting: 'locked',
        start: 'cooldown',
        scheduler: { kind: 'charged', chargeMs: 800, chargedVisualMs: 400 },
        fireModel: { kind: 'perShot' }
    },
    prism: {
        ...LOCKED_STANDARD,
        fireEffect: 'prism',
        start: 'ready',
        // The beam is continuous: its damage stat is already per-second.
        fireModel: { kind: 'dps' },
        idleEffect: 'cleanupPrismLaser'
    },
    dragons_breath: {
        ...NEAREST_STANDARD,
        fireEffect: 'dragons_breath',
        start: 'cooldown',
        // 16 rockets per volley — the battery's pod count is a property of
        // the box, not of its (now 3×3) footprint; MainScene fires exactly
        // this many per volley and the UI derives DPS from the same number.
        fireModel: { kind: 'perShot', salvoSize: 16 }
    },
    spike_launcher: {
        ...NEAREST_STANDARD,
        fireEffect: 'spike_launcher',
        start: 'cooldown',
        // 1.45x impact plus two representative 0.5x zone ticks.
        fireModel: { kind: 'perShot', secondaryDamageMultiplier: 2.45 }
    }
} as const satisfies Record<ActiveDefenseType, DefenseBehavior>;

export function getDefenseBehavior(type: string): DefenseBehavior | undefined {
    if (!Object.prototype.hasOwnProperty.call(DEFENSE_BEHAVIOR_CATALOG, type)) return undefined;
    return DEFENSE_BEHAVIOR_CATALOG[type as ActiveDefenseType];
}

/**
 * Sustained damage per second implied by a defense's level stats, derived
 * from its fire model. This is the ONE place that math lives: tick beams
 * (prism) already declare per-second damage, salvo batteries
 * (dragons_breath) land every pod per volley. Returns null when the type
 * isn't an active defense or the stats can't support the derivation.
 */
export function defenseDps(
    type: string,
    stats: { damage?: number; fireRate?: number },
    options: { includeSecondaryEffects?: boolean } = {}
): number | null {
    const behavior = getDefenseBehavior(type);
    if (!behavior || !stats.damage) return null;
    if (behavior.fireModel.kind === 'dps') return stats.damage;
    if (!stats.fireRate) return null;
    const secondary = options.includeSecondaryEffects === false
        ? 1
        : (behavior.fireModel.secondaryDamageMultiplier ?? 1);
    return stats.damage * (behavior.fireModel.salvoSize ?? 1) * secondary * (1000 / stats.fireRate);
}
