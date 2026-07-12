import type { DefenseBuildingType } from '../config/GameDefinitions';

/** Walls share the defense shop category but never participate in combat ticks. */
export type ActiveDefenseType = Exclude<DefenseBuildingType, 'wall'>;

export type DefenseTargetingPolicy = 'locked' | 'nearest';
export type DefenseStartPolicy = 'cooldown' | 'ready';
export type DefenseIdleEffect = 'cleanupPrismLaser';

export type DefenseScheduler =
    | { kind: 'standard' }
    | { kind: 'charged'; chargeMs: number; chargedVisualMs: number };

export interface DefenseBehavior {
    fireEffect: ActiveDefenseType;
    targeting: DefenseTargetingPolicy;
    start: DefenseStartPolicy;
    scheduler: DefenseScheduler;
    idleEffect?: DefenseIdleEffect;
}

const LOCKED_STANDARD = {
    targeting: 'locked',
    scheduler: { kind: 'standard' }
} as const;

const NEAREST_STANDARD = {
    targeting: 'nearest',
    scheduler: { kind: 'standard' }
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
        scheduler: { kind: 'charged', chargeMs: 800, chargedVisualMs: 400 }
    },
    prism: {
        ...LOCKED_STANDARD,
        fireEffect: 'prism',
        start: 'ready',
        idleEffect: 'cleanupPrismLaser'
    },
    dragons_breath: { ...NEAREST_STANDARD, fireEffect: 'dragons_breath', start: 'cooldown' },
    spike_launcher: { ...NEAREST_STANDARD, fireEffect: 'spike_launcher', start: 'cooldown' },
    frostfall: { ...NEAREST_STANDARD, fireEffect: 'frostfall', start: 'ready' }
} as const satisfies Record<ActiveDefenseType, DefenseBehavior>;

export function getDefenseBehavior(type: string): DefenseBehavior | undefined {
    if (!Object.prototype.hasOwnProperty.call(DEFENSE_BEHAVIOR_CATALOG, type)) return undefined;
    return DEFENSE_BEHAVIOR_CATALOG[type as ActiveDefenseType];
}
