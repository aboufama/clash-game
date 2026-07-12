import { getBuildingStats, type BuildingType } from '../config/GameDefinitions';
import type { PlacedBuilding, Troop } from '../types/GameTypes';
import {
    getDefenseBehavior,
    type ActiveDefenseType,
    type DefenseIdleEffect
} from './DefenseBehaviorCatalog';

export type DefenseFireHandler = (defense: PlacedBuilding, target: Troop, time: number) => void;
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

            const stats = getBuildingStats(defense.type as BuildingType, defense.level || 1);
            const maxRange = stats.range || 7;
            const interval = stats.fireRate || 2500;
            const centerX = defense.gridX + (stats.width || 1) / 2;
            const centerY = defense.gridY + (stats.height || 1) / 2;

            const isTargetInRange = (troop: Troop | null | undefined): troop is Troop => {
                if (!troop || troop.health <= 0 || troop.owner === defense.owner) return false;
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
                    isTargetInRange
                );
                continue;
            }

            if (time < (defense.lastFireTime || 0) + interval) continue;

            const target = lockedTarget ?? findNearestTarget();
            if (target) {
                if (usesTargetLock) defense.lockedTargetId = target.id;
                defense.lastFireTime = time;
                this.effects.fire[behavior.fireEffect](defense, target, time);
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
        isTargetInRange: (troop: Troop | null | undefined) => troop is Troop
    ): void {
        if (defense.teslaCharging && defense.teslaChargeStart) {
            const target = defense.teslaChargeTarget;
            if (!isTargetInRange(target)) {
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
            defense.teslaChargeTarget = target;
            if (usesTargetLock) defense.lockedTargetId = target.id;
        } else if (usesTargetLock) {
            defense.lockedTargetId = undefined;
        }
    }
}
