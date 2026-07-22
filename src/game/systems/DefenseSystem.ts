import { getBuildingStats, type BuildingType } from '../config/GameDefinitions';
import type { PlacedBuilding, Troop } from '../types/GameTypes';
import {
    getDefenseBehavior,
    type ActiveDefenseType,
    type DefenseIdleEffect
} from './DefenseBehaviorCatalog';

/** Fire handlers may refuse a shot by returning `false` (e.g. the cannon's
 * previous ball is still in flight); a refused shot must not consume the
 * cooldown. Any other return value (including `undefined`) counts as fired. */
export type DefenseFireHandler = (defense: PlacedBuilding, target: Troop, time: number) => boolean | void;
export type DefenseFireHandlers = Record<ActiveDefenseType, DefenseFireHandler>;
export type DefenseIdleHandlers = Record<DefenseIdleEffect, (defense: PlacedBuilding) => void>;
export type DefenseChargePhase = 'start' | 'cancel' | 'complete' | 'visual-clear';
export type DefenseChargeHandler = (
    phase: DefenseChargePhase,
    defense: PlacedBuilding,
    target: Troop | undefined,
    time: number,
    chargeMs: number,
    chargedVisualMs: number
) => void;

export interface DefenseEffects {
    fire: DefenseFireHandlers;
    idle: DefenseIdleHandlers;
    /** Optional causal presentation hook. The simulation remains authoritative
     *  over the charge fields; replay capture only observes each transition. */
    charge?: DefenseChargeHandler;
}

function gridDistance(ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
}

/** The range/ownership rule and the nearest-pick shared by the sim tick and
 *  the read-only display probe below — ONE implementation so the barrel a
 *  turret shows can never drift from the target the sim will hand it. */
interface DefenseTargetingParams {
    owner: PlacedBuilding['owner'];
    centerX: number;
    centerY: number;
    maxRange: number;
    minRange?: number;
}

function isDefenseTargetInRange(params: DefenseTargetingParams, troop: Troop | null | undefined): troop is Troop {
    if (!troop || troop.health <= 0 || troop.owner === params.owner) return false;
    const distance = gridDistance(params.centerX, params.centerY, troop.gridX, troop.gridY);
    if (distance > params.maxRange) return false;
    if (params.minRange && distance < params.minRange) return false;
    return true;
}

function findNearestDefenseTarget(params: DefenseTargetingParams, troops: readonly Troop[]): Troop | null {
    let nearest: Troop | null = null;
    let nearestDistance = params.maxRange;
    for (const troop of troops) {
        if (!isDefenseTargetInRange(params, troop)) continue;
        const distance = gridDistance(params.centerX, params.centerY, troop.gridX, troop.gridY);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = troop;
        }
    }
    return nearest;
}

function defenseTargetingParams(defense: Readonly<PlacedBuilding>): DefenseTargetingParams {
    const stats = getBuildingStats(defense.type as BuildingType, defense.level || 1);
    return {
        owner: defense.owner,
        centerX: defense.gridX + (stats.width || 1) / 2,
        centerY: defense.gridY + (stats.height || 1) / 2,
        maxRange: stats.range || 7,
        minRange: stats.minRange
    };
}

/**
 * READ-ONLY prospective-target probe for the PRESENTATION layer: the troop
 * this defense would shoot if its cooldown expired right now. Locked
 * defenses resolve their existing lock first (alive + in range), then fall
 * back to the exact nearest-in-[minRange, range] rule `update()` applies —
 * through the shared helpers above, never a copy. MUTATES NOTHING: no lock
 * clearing, no lastFireTime stamp, no fire/idle dispatch — turret barrels
 * may track their next victim during reload without perturbing targeting
 * order, replay bytes or ATTACK_SIMULATION_VERSION.
 */
export function peekDefenseTarget(
    defense: Readonly<PlacedBuilding>,
    troops: readonly Troop[],
    time: number
): Troop | null {
    const behavior = getDefenseBehavior(defense.type);
    if (!behavior || defense.health <= 0 || defense.upgradingTo) return null;
    // Frozen defenses hold their bearing solid (the sim tick skips them too).
    if (defense.frozenUntil !== undefined && time < defense.frozenUntil) return null;

    const params = defenseTargetingParams(defense);
    if (behavior.targeting === 'locked' && defense.lockedTargetId) {
        const existing = troops.find(troop => troop.id === defense.lockedTargetId);
        if (isDefenseTargetInRange(params, existing)) return existing;
        // Dead/escaped lock: fall through to the same nearest rule the sim
        // will apply on its next tick — WITHOUT clearing the lock (that
        // mutation belongs to update()).
    }
    return findNearestDefenseTarget(params, troops);
}

/**
 * Owns defense selection, target locks and shot scheduling. Rendering and
 * impact effects remain scene concerns and are supplied through callbacks.
 */
export class DefenseSystem {
    private readonly effects: DefenseEffects;

    constructor(effects: DefenseEffects) {
        this.effects = effects;
    }

    update(time: number, buildings: readonly PlacedBuilding[], troops: readonly Troop[]): void {
        for (const defense of buildings) {
            const behavior = getDefenseBehavior(defense.type);
            if (!behavior || defense.health <= 0 || defense.upgradingTo) continue;

            // Ice-golem freeze-on-death: a frozen defense is a full stop —
            // no shots, no tesla charge progress, no idle handler. The
            // cooldown clock is deliberately untouched, so the "~2.5 s of
            // silence" is exactly the freeze window (client battle sim
            // only; server settlement ignores debuffs by design).
            if (defense.frozenUntil !== undefined && time < defense.frozenUntil) continue;

            const stats = getBuildingStats(defense.type as BuildingType, defense.level || 1);
            const interval = stats.fireRate || 2500;

            // Same-shape closures as before, now backed by the shared
            // helpers peekDefenseTarget reads — selection semantics are
            // byte-identical (same guards, same strict `<` nearest rule).
            const params = defenseTargetingParams(defense);
            const isTargetInRange = (troop: Troop | null | undefined): troop is Troop =>
                isDefenseTargetInRange(params, troop);
            const findNearestTarget = (): Troop | null =>
                findNearestDefenseTarget(params, troops);

            const usesTargetLock = behavior.targeting === 'locked';
            if (!usesTargetLock && defense.lockedTargetId) defense.lockedTargetId = undefined;

            let lockedTarget: Troop | null = null;
            if (usesTargetLock && defense.lockedTargetId) {
                const existing = troops.find(troop => troop.id === defense.lockedTargetId);
                if (isTargetInRange(existing)) {
                    lockedTarget = existing;
                } else {
                    defense.lockedTargetId = undefined;
                }
            }

            if (defense.lastFireTime === undefined) {
                defense.lastFireTime = behavior.start === 'cooldown' ? time : time - interval;
            }

            if (behavior.scheduler.kind === 'charged') {
                this.updateChargedDefense(
                    time,
                    defense,
                    interval,
                    behavior.scheduler.chargeMs,
                    behavior.scheduler.chargedVisualMs,
                    behavior.fireEffect,
                    usesTargetLock,
                    lockedTarget,
                    findNearestTarget,
                    isTargetInRange,
                    troops
                );
                continue;
            }

            if (time < (defense.lastFireTime || 0) + interval) continue;

            const target = lockedTarget ?? findNearestTarget();
            if (target) {
                if (usesTargetLock) defense.lockedTargetId = target.id;
                // Fire first: a swallowed shot (handler returned false) must
                // not consume the cooldown window.
                const fired = this.effects.fire[behavior.fireEffect](defense, target, time);
                if (fired !== false) defense.lastFireTime = time;
            } else {
                if (usesTargetLock) defense.lockedTargetId = undefined;
                if (behavior.idleEffect) this.effects.idle[behavior.idleEffect](defense);
            }
        }
    }

    private updateChargedDefense(
        time: number,
        defense: PlacedBuilding,
        interval: number,
        chargeMs: number,
        chargedVisualMs: number,
        fireEffect: ActiveDefenseType,
        usesTargetLock: boolean,
        lockedTarget: Troop | null,
        findNearestTarget: () => Troop | null,
        isTargetInRange: (troop: Troop | null | undefined) => troop is Troop,
        troops: readonly Troop[]
    ): void {
        if (defense.teslaCharging && defense.teslaChargeStart) {
            const target = defense.teslaChargeTarget;
            // The stored reference must still be a live member of the scene
            // roster: replay frame-sync removes troops without zeroing their
            // health, and a stale object would otherwise take the discharge.
            const isSceneMember = !!target && troops.includes(target);
            if (!isSceneMember || !isTargetInRange(target)) {
                this.effects.charge?.(
                    'cancel', defense, target, time, chargeMs, chargedVisualMs
                );
                defense.teslaCharging = false;
                defense.teslaChargeTarget = undefined;
                if (usesTargetLock) defense.lockedTargetId = undefined;
                return;
            }

            if (time >= defense.teslaChargeStart + chargeMs) {
                this.effects.charge?.(
                    'complete', defense, target, time, chargeMs, chargedVisualMs
                );
                if (target.health > 0) this.effects.fire[fireEffect](defense, target, time);
                defense.teslaCharging = false;
                defense.teslaCharged = true;
                defense.lastFireTime = time;
                defense.teslaChargeTarget = undefined;
                if (usesTargetLock) defense.lockedTargetId = target.id;
            }
            return;
        }

        if (defense.teslaCharged && defense.lastFireTime && time > defense.lastFireTime + chargedVisualMs) {
            this.effects.charge?.(
                'visual-clear', defense, undefined, time, chargeMs, chargedVisualMs
            );
            defense.teslaCharged = false;
        }

        if (time < (defense.lastFireTime || 0) + interval) return;

        const target = lockedTarget ?? findNearestTarget();
        if (target) {
            this.effects.charge?.(
                'start', defense, target, time, chargeMs, chargedVisualMs
            );
            defense.teslaCharging = true;
            defense.teslaChargeStart = time;
            defense.teslaChargeTarget = target;
            if (usesTargetLock) defense.lockedTargetId = target.id;
        } else if (usesTargetLock) {
            defense.lockedTargetId = undefined;
        }
    }
}
