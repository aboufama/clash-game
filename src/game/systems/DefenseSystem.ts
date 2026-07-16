import { getBuildingStats, getTroopStats, type BuildingType } from '../config/GameDefinitions';
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

export interface DefenseEffects {
    fire: DefenseFireHandlers;
    idle: DefenseIdleHandlers;
}

function gridDistance(ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
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
            const maxRange = stats.range || 7;
            const interval = stats.fireRate || 2500;
            const centerX = defense.gridX + (stats.width || 1) / 2;
            const centerY = defense.gridY + (stats.height || 1) / 2;

            const isTargetInRange = (troop: Troop | null | undefined): troop is Troop => {
                if (!troop || troop.health <= 0 || troop.owner === defense.owner) return false;
                // Hawk-eye cloak: the ONE acquisition gate — covers standard
                // fire, target locks, mortar/nearest reselection AND the tesla
                // charge validity re-check.
                if (troop.untargetableUntil !== undefined && time < troop.untargetableUntil) return false;
                const distance = gridDistance(centerX, centerY, troop.gridX, troop.gridY);
                if (distance > maxRange) return false;
                if (stats.minRange && distance < stats.minRange) return false;
                return true;
            };

            const findNearestTarget = (): Troop | null => {
                let nearest: Troop | null = null;
                let nearestDistance = maxRange;
                for (const troop of troops) {
                    if (!isTargetInRange(troop)) continue;
                    const distance = gridDistance(centerX, centerY, troop.gridX, troop.gridY);
                    if (distance < nearestDistance) {
                        nearestDistance = distance;
                        nearest = troop;
                    }
                }
                return nearest;
            };

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
                // The LOCK stays on the original ally (or the 50% redirect
                // share silently becomes 100% via lock persistence); only the
                // fired shot — projectile art and damage together, every
                // shoot*At handler damages the troop it is PASSED — may swing
                // to a guarding pavise bearer.
                if (usesTargetLock) defense.lockedTargetId = target.id;
                const firedTarget = this.resolveFiredTarget(defense, target, troops, time);
                // Fire first: a swallowed shot (handler returned false) must
                // not consume the cooldown window.
                const fired = this.effects.fire[behavior.fireEffect](defense, firedTarget, time);
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
                defense.teslaCharging = false;
                defense.teslaChargeTarget = undefined;
                if (usesTargetLock) defense.lockedTargetId = undefined;
                return;
            }

            if (time >= defense.teslaChargeStart + chargeMs) {
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
            defense.teslaCharged = false;
        }

        if (time < (defense.lastFireTime || 0) + interval) return;

        const target = lockedTarget ?? findNearestTarget();
        if (target) {
            defense.teslaCharging = true;
            defense.teslaChargeStart = time;
            // Second acquisition point (charged/tesla): the CHARGE swings to
            // the pavise; the lock below stays on the original ally.
            defense.teslaChargeTarget = this.resolveFiredTarget(defense, target, troops, time);
            if (usesTargetLock) defense.lockedTargetId = target.id;
        } else if (usesTargetLock) {
            defense.lockedTargetId = undefined;
        }
    }

    /**
     * Pavise-bearer redirect. When the acquired target is a RANGED ally
     * (range ≥ 1.5) guarded by a live pavise bearer — within his guardRadius
     * AND standing nearer the defense than the ally ("behind the shield") —
     * a deterministic guardRedirectShare of the eligible shots swings to the
     * bearer: shot n redirects iff floor(n·share) > floor((n−1)·share), a
     * per-defense counter, never Math.random (replay determinism). Returns
     * the troop the shot must actually hit.
     */
    private resolveFiredTarget(
        defense: PlacedBuilding,
        target: Troop,
        troops: readonly Troop[],
        time: number
    ): Troop {
        const targetStats = getTroopStats(target.type, target.level || 1);
        if ((targetStats.range ?? 0) < 1.5) return target; // melee allies are never redirected

        const defenseStats = getBuildingStats(defense.type as BuildingType, defense.level || 1);
        const centerX = defense.gridX + (defenseStats.width || 1) / 2;
        const centerY = defense.gridY + (defenseStats.height || 1) / 2;

        const targetDistance = gridDistance(centerX, centerY, target.gridX, target.gridY);
        let bearer: Troop | null = null;
        let bearerShare = 0;
        let bearerDistance = Number.POSITIVE_INFINITY;
        for (const candidate of troops) {
            if (candidate.health <= 0 || candidate.owner !== target.owner || candidate.id === target.id) continue;
            const stats = getTroopStats(candidate.type, candidate.level || 1);
            const guardRadius = stats.guardRadius ?? 0;
            const share = stats.guardRedirectShare ?? 0;
            if (guardRadius <= 0 || share <= 0) continue;
            if (gridDistance(candidate.gridX, candidate.gridY, target.gridX, target.gridY) > guardRadius) continue;
            const defenseDistance = gridDistance(centerX, centerY, candidate.gridX, candidate.gridY);
            if (defenseDistance >= targetDistance) continue; // must stand between ally and defense
            if (defenseDistance < bearerDistance
                || (defenseDistance === bearerDistance && candidate.id < (bearer?.id ?? ''))) {
                bearer = candidate;
                bearerShare = share;
                bearerDistance = defenseDistance;
            }
        }
        if (!bearer) return target;

        const counter = (defense.redirectShotCounter ?? 0) + 1;
        defense.redirectShotCounter = counter;
        const redirect = Math.floor(counter * bearerShare) > Math.floor((counter - 1) * bearerShare);
        if (!redirect) return target;
        // Arm the shield-spark cue: the scene flashes it when the redirected
        // impact actually lands damage on the bearer.
        bearer.guardFlareUntil = time + 1500;
        return bearer;
    }
}
