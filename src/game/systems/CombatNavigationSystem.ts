import {
    BUILDING_DEFINITIONS,
    MAP_SIZE,
    getTroopStats,
    type TroopDef
} from '../config/GameDefinitions';
import type { PlacedBuilding, Troop } from '../types/GameTypes';

export interface CombatPoint {
    x: number;
    y: number;
}

export interface CombatNavigationPlan {
    /** The building (or moving follow target) the troop ultimately cares about. */
    strategicTargetId: string;
    /** The building currently safe to damage: objective or required wall. */
    activeTargetId: string;
    /** For A* plans always the first wall to breach. For straight-charge
     * plans it may be ANY structure sitting on the charge ray. */
    blockerId?: string;
    topologyRevision: number;
    routeCost: number;
    /** Continuous grid-space endpoint. Waypoints are cell centers as well. */
    goal: CombatPoint;
    waypoints: CombatPoint[];
    plannedAt: number;
}

export interface CombatNavigationSelection {
    strategicTarget: PlacedBuilding | null;
    activeTarget: PlacedBuilding | null;
    plan: CombatNavigationPlan | null;
}

export interface CombatMovementResult {
    x: number;
    y: number;
    dx: number;
    dy: number;
    blocked: boolean;
}

interface TargetRegion {
    id: string;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    range: number;
}

interface TraversalContext {
    grid: Float64Array;
    occupied: Uint8Array;
    wallAt: Array<PlacedBuilding | null>;
    canBypassStructures: boolean;
    /** Enemy wall ids a parked allied siege tower has turned into ramps:
     *  crossable at COST_OPEN+12 (never free), never a goal/attack slot,
     *  never a blocker. The deliberate, scoped exception to invariant 1. */
    rampWalls?: ReadonlySet<string>;
    /** Every live, defined structure — straight-charge ray geometry needs
     * the full set even where the cost grid abstracts it away. */
    solids: PlacedBuilding[];
    /** Nearby allies committed to the same objective lend a bounded preference
     * to one breach. It remains only a cost hint: an opened gap always wins. */
    breachAffinity: Map<string, string>;
    /** Attack-slot claims by allied plans: strategicTargetId → goal cell index
     * → claimant count. Soft costs that fan a cohort across a target's rim
     * instead of letting everyone stop on the same corridor-exit cell. */
    goalClaims: Map<string, Map<number, number>>;
}

interface SearchResult {
    nodes: number[];
    cost: number;
}

/**
 * Pure combat navigation. It intentionally has no Phaser dependency: combat
 * decisions can be regression-tested without booting a scene, and ambient
 * village paths remain isolated in PathfindingSystem.
 *
 * Ground invariants:
 *  - emitted movement waypoints never lie inside a live structure;
 *  - a wall (or, for straight-charge units, any structure on the charge
 *    ray) can be a temporary interaction target, never the objective;
 *  - conceptual A* wall crossings are truncated at the first required wall;
 *  - every committed displacement is conservatively sub-stepped and checked.
 */
export class CombatNavigationSystem {
    /** The two-tile deployment apron is part of navigation, not an invalid
     * coordinate that may be clamped through an edge structure. */
    private static readonly GRID_MIN = -2;
    private static readonly GRID_SIZE = MAP_SIZE + 4;
    private static readonly GRID_MAX = CombatNavigationSystem.GRID_MIN + CombatNavigationSystem.GRID_SIZE - 1;
    private static readonly NODE_COUNT = CombatNavigationSystem.GRID_SIZE * CombatNavigationSystem.GRID_SIZE;
    private static readonly COST_OPEN = 10;
    private static readonly COST_IMPASSABLE = 1_000_000_000;
    /** Per-troop directional preference on goal cells (≈1.8 open cells at the
     * far side of the rim). Small against wall-break cost, so it spreads a
     * cohort around the rim without ever changing a breach decision. */
    private static readonly GOAL_DIRECTION_COST = 18;
    /** Cost per allied claim on a goal cell (≈2.6 open cells). Soft, so a big
     * cohort saturates gracefully to a few claimants per cell. */
    private static readonly GOAL_CLAIM_COST = 26;
    private static readonly MAX_HEAP = CombatNavigationSystem.NODE_COUNT * 16;

    private static readonly gridScratch = new Float64Array(CombatNavigationSystem.NODE_COUNT);
    private static readonly occupiedScratch = new Uint8Array(CombatNavigationSystem.NODE_COUNT);
    private static readonly wallScratch: Array<PlacedBuilding | null> = Array.from(
        { length: CombatNavigationSystem.NODE_COUNT },
        () => null
    );
    private static readonly goalScratch = new Uint8Array(CombatNavigationSystem.NODE_COUNT);
    private static readonly closedScratch = new Uint8Array(CombatNavigationSystem.NODE_COUNT);
    private static readonly gScoreScratch = new Float64Array(CombatNavigationSystem.NODE_COUNT);
    private static readonly cameFromScratch = new Int32Array(CombatNavigationSystem.NODE_COUNT);
    private static readonly heapNode = new Int32Array(CombatNavigationSystem.MAX_HEAP);
    private static readonly heapF = new Float64Array(CombatNavigationSystem.MAX_HEAP);
    private static heapSize = 0;

    static isGroundTroop(troop: Pick<Troop, 'type' | 'level'>): boolean {
        const movement = getTroopStats(troop.type, troop.level || 1).movementType;
        return movement !== 'air' && movement !== 'ghost';
    }

    static edgeDistance(
        x: number,
        y: number,
        target: Pick<PlacedBuilding, 'gridX' | 'gridY' | 'type'>
    ): number {
        const info = BUILDING_DEFINITIONS[target.type as keyof typeof BUILDING_DEFINITIONS];
        const width = info?.width ?? 1;
        const height = info?.height ?? 1;
        return this.distanceToRect(
            x,
            y,
            target.gridX,
            target.gridY,
            target.gridX + width,
            target.gridY + height
        );
    }

    static selectTargetAndPlan(
        troop: Troop,
        buildings: PlacedBuilding[],
        allTroops: Troop[],
        topologyRevision: number,
        plannedAt: number,
        preferredTarget?: PlacedBuilding,
        rampWallIds?: ReadonlySet<string>
    ): CombatNavigationSelection {
        const enemies = buildings.filter(building =>
            building.owner !== troop.owner
            && building.health > 0
            && !building.isDestroyed
            && !!BUILDING_DEFINITIONS[building.type as keyof typeof BUILDING_DEFINITIONS]
        );
        if (enemies.length === 0) {
            return { strategicTarget: null, activeTarget: null, plan: null };
        }

        const stats = getTroopStats(troop.type, troop.level || 1);
        const nonWalls = enemies.filter(building => building.type !== 'wall');
        let priorityCandidates: PlacedBuilding[] = [];

        if (stats.targetPriority === 'defense') {
            priorityCandidates = nonWalls.filter(building =>
                BUILDING_DEFINITIONS[building.type as keyof typeof BUILDING_DEFINITIONS]?.category === 'defense'
            );
        } else if (stats.targetPriority === 'town_hall') {
            priorityCandidates = nonWalls.filter(building => building.type === 'town_hall');
        } else if (stats.targetPriority === 'wall') {
            priorityCandidates = enemies.filter(building => building.type === 'wall');
        } else if (stats.targetPriority === 'resource') {
            priorityCandidates = nonWalls.filter(building =>
                BUILDING_DEFINITIONS[building.type as keyof typeof BUILDING_DEFINITIONS]?.category === 'resource'
            );
        } else {
            priorityCandidates = nonWalls;
        }

        // Preserve target tiers, but do not idle forever if every preferred
        // structure has no legal approach. Lower tiers are evaluated only when
        // the complete preferred tier yields no plan.
        const fallbackCandidates = nonWalls.filter(building =>
            !priorityCandidates.some(priority => priority.id === building.id)
        );
        const tiers = priorityCandidates.length > 0
            ? [priorityCandidates, fallbackCandidates]
            : [fallbackCandidates];
        if (tiers.every(tier => tier.length === 0)) {
            return { strategicTarget: null, activeTarget: null, plan: null };
        }

        const context = this.buildContext(troop, buildings, allTroops, stats, rampWallIds);
        let bestTarget: PlacedBuilding | null = null;
        let bestPlan: CombatNavigationPlan | null = null;

        for (const tier of tiers) {
            if (tier.length === 0) continue;
            bestTarget = null;
            bestPlan = null;

            let bestScore = Number.POSITIVE_INFINITY;
            const sorted = [...tier].sort((a, b) => {
                const distanceDelta = this.edgeDistance(troop.gridX, troop.gridY, a)
                    - this.edgeDistance(troop.gridX, troop.gridY, b);
                return distanceDelta || a.id.localeCompare(b.id);
            });

            // Evaluate the locked target explicitly before distance pruning.
            // It may sort after the first ten candidates yet still win once
            // its 16% hysteresis is applied.
            const preferredInTier = preferredTarget
                ? sorted.find(candidate => candidate.id === preferredTarget.id)
                : undefined;
            if (preferredInTier) {
                const preferredPlan = this.planToBuildingWithContext(
                    troop,
                    preferredInTier,
                    context,
                    topologyRevision,
                    plannedAt,
                    stats
                );
                if (preferredPlan) {
                    bestTarget = preferredInTier;
                    bestPlan = preferredPlan;
                    bestScore = preferredPlan.routeCost * 0.84;
                }
            }

            let evaluated = 0;
            for (const candidate of sorted) {
                if (candidate.id === preferredInTier?.id) continue;
                const edgeLowerBound = Math.max(
                    0,
                    this.edgeDistance(troop.gridX, troop.gridY, candidate) - stats.range
                ) * 9;
                // Always search until a reachable candidate exists. Once one
                // does, the admissible edge bound safely prunes farther options.
                if (bestPlan && evaluated >= 10 && edgeLowerBound > bestScore) break;

                const plan = this.planToBuildingWithContext(
                    troop,
                    candidate,
                    context,
                    topologyRevision,
                    plannedAt,
                    stats
                );
                evaluated++;
                if (!plan) continue;
                const score = plan.routeCost;
                if (score < bestScore || (score === bestScore && candidate.id < (bestTarget?.id ?? ''))) {
                    bestScore = score;
                    bestTarget = candidate;
                    bestPlan = plan;
                }
            }
            if (bestTarget && bestPlan) break;
        }

        if (!bestTarget || !bestPlan) {
            return { strategicTarget: null, activeTarget: null, plan: null };
        }
        const activeTarget = buildings.find(building => building.id === bestPlan.activeTargetId) ?? null;
        return { strategicTarget: bestTarget, activeTarget, plan: bestPlan };
    }

    static planToBuilding(
        troop: Troop,
        target: PlacedBuilding,
        buildings: PlacedBuilding[],
        allTroops: Troop[],
        topologyRevision: number,
        plannedAt: number,
        rampWallIds?: ReadonlySet<string>
    ): CombatNavigationPlan | null {
        const stats = getTroopStats(troop.type, troop.level || 1);
        const context = this.buildContext(troop, buildings, allTroops, stats, rampWallIds);
        return this.planToBuildingWithContext(
            troop,
            target,
            context,
            topologyRevision,
            plannedAt,
            stats
        );
    }

    /** Route to a moving point (the support-follower lane: physician's cart
     *  trailing an ally). The point is a zero-size region reached at
     *  `followRange`; everything else is the standard planner. */
    static planToPoint(
        troop: Troop,
        point: { id?: string; gridX: number; gridY: number },
        followRange: number,
        buildings: PlacedBuilding[],
        allTroops: Troop[],
        topologyRevision: number,
        plannedAt: number,
        rampWallIds?: ReadonlySet<string>
    ): CombatNavigationPlan | null {
        const stats = getTroopStats(troop.type, troop.level || 1);
        const context = this.buildContext(troop, buildings, allTroops, stats, rampWallIds);
        const id = point.id ?? `point:${point.gridX.toFixed(2)},${point.gridY.toFixed(2)}`;
        return this.planToRegion(
            troop,
            {
                id,
                minX: point.gridX,
                minY: point.gridY,
                maxX: point.gridX,
                maxY: point.gridY,
                range: Math.max(0.2, followRange)
            },
            context,
            topologyRevision,
            plannedAt,
            stats
        );
    }

    static isPositionWalkable(
        troop: Pick<Troop, 'type' | 'level'>,
        x: number,
        y: number,
        buildings: PlacedBuilding[],
        mapSize: number = MAP_SIZE,
        rampWallIds?: ReadonlySet<string>
    ): boolean {
        if (!this.isGroundTroop(troop)) {
            return x >= -2.25 && y >= -2.25 && x <= mapSize + 2.25 && y <= mapSize + 2.25;
        }
        return this.penetrationScore(troop, x, y, buildings, mapSize, rampWallIds) <= 0;
    }

    static resolveMovement(
        troop: Troop,
        desiredDx: number,
        desiredDy: number,
        fallbackDx: number,
        fallbackDy: number,
        buildings: PlacedBuilding[],
        mapSize: number = MAP_SIZE,
        rampWallIds?: ReadonlySet<string>
    ): CombatMovementResult {
        const startX = troop.gridX;
        const startY = troop.gridY;

        if (!this.isGroundTroop(troop)) {
            const x = this.clamp(startX + desiredDx, -2.25, mapSize + 2.25);
            const y = this.clamp(startY + desiredDy, -2.25, mapSize + 2.25);
            return { x, y, dx: x - startX, dy: y - startY, blocked: false };
        }

        const distance = Math.max(
            Math.hypot(desiredDx, desiredDy),
            Math.hypot(fallbackDx, fallbackDy)
        );
        const steps = Math.max(1, Math.ceil(distance / 0.08));
        const ddx = desiredDx / steps;
        const ddy = desiredDy / steps;
        const fdx = fallbackDx / steps;
        const fdy = fallbackDy / steps;
        let x = startX;
        let y = startY;
        let blocked = false;

        const tryStep = (stepX: number, stepY: number): boolean => {
            const nextX = x + stepX;
            const nextY = y + stepY;
            const before = this.penetrationScore(troop, x, y, buildings, mapSize, rampWallIds);
            const after = this.penetrationScore(troop, nextX, nextY, buildings, mapSize, rampWallIds);
            if (after <= 0 || (before > 0 && after < before - 0.000_001)) {
                x = nextX;
                y = nextY;
                return true;
            }
            return false;
        };

        for (let step = 0; step < steps; step++) {
            if (tryStep(ddx, ddy)) continue;
            blocked = true;

            // First recover the route direction stripped of local avoidance,
            // then slide along an axis. No candidate bypasses collision checks.
            const blendX = ddx * 0.6 + fdx * 0.4;
            const blendY = ddy * 0.6 + fdy * 0.4;
            if (tryStep(blendX, blendY)) continue;
            if (tryStep(fdx, fdy)) continue;

            const xFirst = Math.abs(ddx) >= Math.abs(ddy);
            if (xFirst) {
                if (tryStep(ddx, 0) || tryStep(0, ddy)) continue;
                if (tryStep(fdx, 0) || tryStep(0, fdy)) continue;
            } else {
                if (tryStep(0, ddy) || tryStep(ddx, 0)) continue;
                if (tryStep(0, fdy) || tryStep(fdx, 0)) continue;
            }
            break;
        }

        return { x, y, dx: x - startX, dy: y - startY, blocked };
    }

    private static planToBuildingWithContext(
        troop: Troop,
        target: PlacedBuilding,
        context: TraversalContext,
        topologyRevision: number,
        plannedAt: number,
        stats: TroopDef
    ): CombatNavigationPlan | null {
        const info = BUILDING_DEFINITIONS[target.type as keyof typeof BUILDING_DEFINITIONS];
        if (!info || target.health <= 0 || target.isDestroyed) return null;
        // Straight-charge units ray-cast the objective and fight the first
        // structure standing on the line. A* remains their fallback whenever
        // the ray has no legal stop (friendly geometry, a corner-clipped stop
        // point), so a charger can never brick on pure geometry.
        if (stats.straightCharge && !context.canBypassStructures) {
            const charge = this.planStraightCharge(
                troop,
                target,
                context.solids,
                topologyRevision,
                plannedAt,
                stats
            );
            if (charge) return charge;
        }
        return this.planToRegion(
            troop,
            {
                id: target.id,
                minX: target.gridX,
                minY: target.gridY,
                maxX: target.gridX + info.width,
                maxY: target.gridY + info.height,
                range: Math.max(0.1, stats.range)
            },
            context,
            topologyRevision,
            plannedAt,
            stats
        );
    }

    /**
     * Straight-charge planning: draw the ray from the troop to the
     * objective's footprint center and stop at attack range of the first
     * structure standing on it — wall OR building, that structure becomes
     * the active target; once it falls, the next replan re-aims the ray
     * from the breach and the charge continues. Pure segment geometry: no
     * cost model, no cohort claims, no RNG, so identical inputs always
     * yield the identical plan. Returns null whenever the ray has no legal
     * stop; every caller then falls back to A*.
     */
    private static planStraightCharge(
        troop: Troop,
        target: PlacedBuilding,
        solids: PlacedBuilding[],
        topologyRevision: number,
        plannedAt: number,
        stats: TroopDef
    ): CombatNavigationPlan | null {
        const info = BUILDING_DEFINITIONS[target.type as keyof typeof BUILDING_DEFINITIONS];
        if (!info) return null;
        const originX = troop.gridX;
        const originY = troop.gridY;
        const segX = target.gridX + info.width / 2 - originX;
        const segY = target.gridY + info.height / 2 - originY;
        const segmentLength = Math.hypot(segX, segY);
        if (segmentLength < 0.000_001) return null;

        const range = Math.max(0.1, stats.range);
        // Deterministic ~0.05-tile march along the ray, shared by the
        // range-stop search and the walk-back. Pure function of endpoints.
        const stepT = 0.05 / segmentLength;
        const firstInRangeT = (
            structure: PlacedBuilding,
            width: number,
            height: number
        ): number => {
            for (let t = 0; t <= 1; t += stepT) {
                const distance = this.distanceToRect(
                    originX + segX * t,
                    originY + segY * t,
                    structure.gridX,
                    structure.gridY,
                    structure.gridX + width,
                    structure.gridY + height
                );
                if (distance <= range) return t;
            }
            // t = 1 is the footprint center: always within range.
            return 1;
        };
        const targetStopT = firstInRangeT(target, info.width, info.height);

        // The charge fights the first structure whose radius-inflated
        // footprint the segment enters before it reaches attack range of
        // the objective; later intersections are behind the stop point.
        const radius = this.agentRadius(troop);
        let blocker: PlacedBuilding | null = null;
        let blockerWidth = 0;
        let blockerHeight = 0;
        let blockerEntryT = Number.POSITIVE_INFINITY;
        for (const solid of solids) {
            if (solid.id === target.id) continue;
            const solidInfo = BUILDING_DEFINITIONS[solid.type as keyof typeof BUILDING_DEFINITIONS];
            if (!solidInfo) continue;
            const entryT = this.segmentEntryIntoRect(
                originX,
                originY,
                segX,
                segY,
                solid.gridX - radius,
                solid.gridY - radius,
                solid.gridX + solidInfo.width + radius,
                solid.gridY + solidInfo.height + radius
            );
            if (entryT === null) continue;
            // A friendly structure on the line can never be fought through:
            // surrender the whole charge to A* instead of idling against it.
            if (solid.owner === troop.owner) return null;
            if (entryT >= targetStopT) continue;
            if (entryT < blockerEntryT
                || (entryT === blockerEntryT && solid.id < (blocker?.id ?? ''))) {
                blocker = solid;
                blockerWidth = solidInfo.width;
                blockerHeight = solidInfo.height;
                blockerEntryT = entryT;
            }
        }

        const stopTarget = blocker ?? target;
        // Already at fighting distance of whatever the ray says to hit:
        // hold. Mirrors planToRegion's stopPlan shape (goal = current
        // position, no waypoints) so the empty-waypoint terminal-state
        // reset downstream keeps stuck recovery quiet.
        if (this.edgeDistance(originX, originY, stopTarget) <= stats.range + 0.08) {
            return {
                strategicTargetId: target.id,
                activeTargetId: stopTarget.id,
                blockerId: blocker?.id,
                topologyRevision,
                routeCost: 0,
                goal: { x: originX, y: originY },
                waypoints: [],
                plannedAt
            };
        }

        const stopT = blocker
            ? firstInRangeT(blocker, blockerWidth, blockerHeight)
            : targetStopT;

        // The segment before the stop clears every inflated footprint, but
        // the stop point itself may clip a structure adjacent to the line.
        // Walk back along the ray; if no legal point remains inside the
        // acceptance range the charge is corner-clipped and A* must take
        // over (never phase, and never return a plan that stuck recovery
        // would re-derive forever).
        for (let back = 0; back <= 12; back++) {
            const t = stopT - back * stepT;
            if (t < 0) break;
            const x = originX + segX * t;
            const y = originY + segY * t;
            if (!this.isPositionWalkable(troop, x, y, solids)) continue;
            if (this.edgeDistance(x, y, stopTarget) > stats.range + 0.08) return null;
            return {
                strategicTargetId: target.id,
                activeTargetId: stopTarget.id,
                blockerId: blocker?.id,
                topologyRevision,
                routeCost: segmentLength * this.COST_OPEN,
                goal: { x, y },
                waypoints: [{ x, y }],
                plannedAt
            };
        }
        return null;
    }

    /** Smallest t in [0,1] at which the segment origin + t·(dx,dy) is inside
     * the rect (0 when it starts inside), or null when the segment misses. */
    private static segmentEntryIntoRect(
        originX: number,
        originY: number,
        dx: number,
        dy: number,
        minX: number,
        minY: number,
        maxX: number,
        maxY: number
    ): number | null {
        let tEntry = 0;
        let tExit = 1;
        if (Math.abs(dx) < 0.000_000_001) {
            if (originX < minX || originX > maxX) return null;
        } else {
            const t1 = (minX - originX) / dx;
            const t2 = (maxX - originX) / dx;
            tEntry = Math.max(tEntry, Math.min(t1, t2));
            tExit = Math.min(tExit, Math.max(t1, t2));
        }
        if (Math.abs(dy) < 0.000_000_001) {
            if (originY < minY || originY > maxY) return null;
        } else {
            const t1 = (minY - originY) / dy;
            const t2 = (maxY - originY) / dy;
            tEntry = Math.max(tEntry, Math.min(t1, t2));
            tExit = Math.min(tExit, Math.max(t1, t2));
        }
        return tEntry <= tExit ? tEntry : null;
    }

    private static planToRegion(
        troop: Troop,
        region: TargetRegion,
        context: TraversalContext,
        topologyRevision: number,
        plannedAt: number,
        stats: TroopDef
    ): CombatNavigationPlan | null {
        const exactDistance = this.distanceToRect(
            troop.gridX,
            troop.gridY,
            region.minX,
            region.minY,
            region.maxX,
            region.maxY
        );
        const stopPlan = (): CombatNavigationPlan => ({
            strategicTargetId: region.id,
            activeTargetId: region.id,
            topologyRevision,
            routeCost: 0,
            goal: { x: troop.gridX, y: troop.gridY },
            waypoints: [],
            plannedAt
        });

        const startCellX = this.clamp(Math.floor(troop.gridX), this.GRID_MIN, this.GRID_MAX);
        const startCellY = this.clamp(Math.floor(troop.gridY), this.GRID_MIN, this.GRID_MAX);
        const startX = startCellX - this.GRID_MIN;
        const startY = startCellY - this.GRID_MIN;
        const startIndex = startY * this.GRID_SIZE + startX;

        // Deterministic goal spreading: allied claims and a stable per-id
        // approach preference are folded into goal-cell costs, so a cohort
        // deployed at one point fans across the rim instead of stacking on
        // the first in-range cell of a shared corridor.
        const claims = context.goalClaims.get(region.id);
        const spreadGoals = !!claims && claims.size > 0;
        const startClaims = claims?.get(startIndex) ?? 0;
        const inRangeNow = exactDistance <= region.range + 0.08;
        if (inRangeNow && startClaims === 0) return stopPlan();

        const regionCenterX = (region.minX + region.maxX) / 2;
        const regionCenterY = (region.minY + region.maxY) / 2;
        const preferredAngle = this.approachAngle(troop.id);
        const directionBias = (cellX: number, cellY: number): number => {
            if (!spreadGoals) return 0;
            const cellAngle = Math.atan2(
                cellY + 0.5 - regionCenterY,
                cellX + 0.5 - regionCenterX
            );
            let delta = cellAngle - preferredAngle;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            return (Math.abs(delta) / Math.PI) * this.GOAL_DIRECTION_COST;
        };

        const goals = this.goalScratch;
        goals.fill(0);
        let goalCount = 0;
        const goalAdjustRestore: Array<{ index: number; cost: number }> = [];
        for (let gridY = 0; gridY < this.GRID_SIZE; gridY++) {
            for (let gridX = 0; gridX < this.GRID_SIZE; gridX++) {
                const index = gridY * this.GRID_SIZE + gridX;
                // An enemy wall cell may become a legal attack slot after that
                // wall is destroyed, so keep it as a conceptual goal. Other
                // occupied cells can never be terminal positions.
                if (!context.canBypassStructures
                    && context.occupied[index]
                    && !context.wallAt[index]) continue;
                const cellX = gridX + this.GRID_MIN;
                const cellY = gridY + this.GRID_MIN;
                const distance = this.distanceToRect(
                    cellX + 0.5,
                    cellY + 0.5,
                    region.minX,
                    region.minY,
                    region.maxX,
                    region.maxY
                );
                if (distance <= region.range + 0.08) {
                    goals[index] = 1;
                    goalCount++;
                    const bias = (claims?.get(index) ?? 0) * this.GOAL_CLAIM_COST
                        + directionBias(cellX, cellY);
                    if (bias > 0) {
                        goalAdjustRestore.push({ index, cost: context.grid[index] });
                        context.grid[index] += bias;
                    }
                }
            }
        }
        if (goalCount === 0) return inRangeNow ? stopPlan() : null;

        // In range but the current cell is claimed: unmark it so the search
        // must price an alternative slot (A* would otherwise terminate on the
        // start cell immediately, where entry costs never apply).
        if (inRangeNow && goals[startIndex]) {
            if (goalCount === 1) return stopPlan();
            goals[startIndex] = 0;
            goalCount--;
        }

        // A local cohort should tend to break one useful opening instead of
        // shaving several adjacent walls. The discount is deliberately small
        // compared with a wall's destruction cost, so a real open gap or a
        // substantially shorter route still wins immediately.
        const affinityWallId = context.breachAffinity.get(region.id);
        const affinityRestore: Array<{ index: number; cost: number }> = [];
        if (affinityWallId) {
            for (let index = 0; index < context.wallAt.length; index++) {
                if (context.wallAt[index]?.id !== affinityWallId) continue;
                affinityRestore.push({ index, cost: context.grid[index] });
                context.grid[index] = Math.max(this.COST_OPEN, context.grid[index] * 0.9);
            }
        }

        // A troop displaced into geometry by an old save/area impulse must be
        // allowed to plan an exit; continuous collision still requires each
        // committed step to reduce penetration.
        const originalStartCost = context.grid[startIndex];
        context.grid[startIndex] = this.COST_OPEN;
        const search = this.aStar(startX, startY, region, context);
        context.grid[startIndex] = originalStartCost;
        for (const restore of affinityRestore) context.grid[restore.index] = restore.cost;
        for (const restore of goalAdjustRestore) context.grid[restore.index] = restore.cost;
        if (!search) return inRangeNow ? stopPlan() : null;

        // Contested in-range slot: relocate only when a cheaper slot exists.
        // Soft claim costs make big cohorts saturate to shared cells instead
        // of orbiting a full rim forever.
        if (inRangeNow) {
            const stayCost = startClaims * this.GOAL_CLAIM_COST
                + directionBias(startCellX, startCellY);
            if (stayCost <= search.cost + this.COST_OPEN) return stopPlan();
        }

        const firstWallAt = search.nodes.findIndex(index => !!context.wallAt[index]);
        const blocker = firstWallAt >= 0 ? context.wallAt[search.nodes[firstWallAt]] : null;
        let movementNodes = firstWallAt >= 0
            ? search.nodes.slice(0, firstWallAt)
            : [...search.nodes];

        // A* reconstruction omits the start node. If its cell center is the
        // legal goal (or the attack position before an immediately-adjacent
        // wall), continuous positions near the far edge of that cell still
        // need one short approach waypoint instead of an empty route.
        const startCenterX = startCellX + 0.5;
        const startCenterY = startCellY + 0.5;
        if (movementNodes.length === 0
            && Math.hypot(troop.gridX - startCenterX, troop.gridY - startCenterY) > 0.04
            && (!blocker || this.edgeDistance(startCenterX, startCenterY, blocker) <= stats.range + 0.08)) {
            movementNodes = [startIndex];
        }

        if (blocker) {
            if (this.edgeDistance(troop.gridX, troop.gridY, blocker) <= stats.range + 0.08) {
                movementNodes = [];
            } else {
                const approachAt = movementNodes.findIndex(index => {
                    const x = (index % this.GRID_SIZE) + this.GRID_MIN + 0.5;
                    const y = Math.floor(index / this.GRID_SIZE) + this.GRID_MIN + 0.5;
                    return this.edgeDistance(x, y, blocker) <= stats.range + 0.08;
                });
                if (approachAt >= 0) movementNodes = movementNodes.slice(0, approachAt + 1);
            }
        }

        const waypoints = this.compressCollinear(movementNodes);
        const goal = waypoints[waypoints.length - 1] ?? { x: troop.gridX, y: troop.gridY };
        return {
            strategicTargetId: region.id,
            activeTargetId: blocker?.id ?? region.id,
            blockerId: blocker?.id,
            topologyRevision,
            routeCost: search.cost,
            goal,
            waypoints,
            plannedAt
        };
    }

    private static buildContext(
        troop: Troop,
        buildings: PlacedBuilding[],
        allTroops: Troop[],
        stats: TroopDef,
        rampWallIds?: ReadonlySet<string>
    ): TraversalContext {
        const grid = this.gridScratch;
        const occupied = this.occupiedScratch;
        const wallAt = this.wallScratch;
        grid.fill(this.COST_OPEN);
        occupied.fill(0);
        wallAt.fill(null);

        const canBypassStructures = stats.movementType === 'air' || stats.movementType === 'ghost';
        const solids = buildings.filter(building =>
            building.health > 0 && !building.isDestroyed
            && !!BUILDING_DEFINITIONS[building.type as keyof typeof BUILDING_DEFINITIONS]
        );
        const breachAffinity = new Map<string, string>();
        if (!canBypassStructures) {
            const wallDamage = Math.max(0.1, stats.damage * (stats.wallDamageMultiplier ?? 1));
            const attackDelay = Math.max(150, stats.attackDelay ?? 1000);
            const wallDps = wallDamage / (attackDelay / 1000);

            for (const building of buildings) {
                if (building.health <= 0 || building.isDestroyed) continue;
                const info = BUILDING_DEFINITIONS[building.type as keyof typeof BUILDING_DEFINITIONS];
                if (!info) continue;

                const enemyWall = building.type === 'wall' && building.owner !== troop.owner;
                // Ally ramp (parked siege tower): the wall is crossable at a
                // small toll — COST_OPEN+12, never free or ramps would beat
                // open ground. occupied stays 1 (never a goal/attack slot);
                // wallAt stays null (never a blocker, so the physical route
                // is NOT truncated at it).
                const isRamp = enemyWall && !!rampWallIds?.has(building.id);
                const baseWallCost = stats.wallTraversalCost ?? 220;
                const wallCost = isRamp
                    ? this.COST_OPEN + 12
                    : enemyWall
                        ? this.COST_OPEN + baseWallCost + (building.health / wallDps) * 35
                        : this.COST_IMPASSABLE;

                for (let x = building.gridX; x < building.gridX + info.width; x++) {
                    for (let y = building.gridY; y < building.gridY + info.height; y++) {
                        if (x < this.GRID_MIN || y < this.GRID_MIN || x > this.GRID_MAX || y > this.GRID_MAX) continue;
                        const gridX = x - this.GRID_MIN;
                        const gridY = y - this.GRID_MIN;
                        const index = gridY * this.GRID_SIZE + gridX;
                        occupied[index] = 1;
                        grid[index] = Math.max(grid[index], wallCost);
                        if (enemyWall && !isRamp) wallAt[index] = building;
                    }
                }
            }

            // Tiny, bounded crowd cost spreads lanes without making dynamic
            // agents part of topology or changing which walls are solid.
            for (const other of allTroops) {
                if (other.id === troop.id || other.health <= 0) continue;
                const x = Math.floor(other.gridX);
                const y = Math.floor(other.gridY);
                if (x < this.GRID_MIN || y < this.GRID_MIN || x > this.GRID_MAX || y > this.GRID_MAX) continue;
                const index = (y - this.GRID_MIN) * this.GRID_SIZE + (x - this.GRID_MIN);
                if (!occupied[index] && grid[index] < this.COST_IMPASSABLE) grid[index] += 4;
            }

            // Coordinate only a local formation and only around an objective
            // allies have already selected. This avoids army-wide magnetism
            // between independent fronts while making the choice stable once
            // a cohort starts working on a breach.
            const liveWallIds = new Set(buildings
                .filter(building => building.type === 'wall' && building.health > 0 && !building.isDestroyed)
                .map(building => building.id));
            const votesByTarget = new Map<string, Map<string, { votes: number; distance: number }>>();
            for (const other of allTroops) {
                if (other.owner !== troop.owner || other.health <= 0) continue;
                const plan = other.navigationPlan;
                // The liveWallIds guard also intentionally drops straight-
                // charge blockers that are ordinary buildings: only wall
                // breaches take affinity votes.
                if (!plan?.blockerId || !liveWallIds.has(plan.blockerId)) continue;
                const distance = Math.hypot(other.gridX - troop.gridX, other.gridY - troop.gridY);
                if (other.id !== troop.id && distance > 7.5) continue;
                let wallVotes = votesByTarget.get(plan.strategicTargetId);
                if (!wallVotes) {
                    wallVotes = new Map();
                    votesByTarget.set(plan.strategicTargetId, wallVotes);
                }
                const previous = wallVotes.get(plan.blockerId) ?? { votes: 0, distance: 0 };
                previous.votes += other.id === troop.id ? 2 : 1;
                previous.distance += distance;
                wallVotes.set(plan.blockerId, previous);
            }
            for (const [targetId, wallVotes] of votesByTarget) {
                const ranked = [...wallVotes.entries()].sort((a, b) =>
                    b[1].votes - a[1].votes
                    || a[1].distance - b[1].distance
                    || a[0].localeCompare(b[0])
                );
                if (ranked[0]) breachAffinity.set(targetId, ranked[0][0]);
            }
        }

        // Attack-slot claims from allied plans (any mobility): a plan whose
        // goal is a rim cell reserves it softly, so later planners prefer
        // free cells. Stopped in-range troops claim the cell they stand on.
        const goalClaims = new Map<string, Map<number, number>>();
        for (const other of allTroops) {
            if (other.id === troop.id || other.health <= 0 || other.owner !== troop.owner) continue;
            const plan = other.navigationPlan;
            if (!plan) continue;
            const cellX = Math.floor(plan.goal.x);
            const cellY = Math.floor(plan.goal.y);
            if (cellX < this.GRID_MIN || cellY < this.GRID_MIN
                || cellX > this.GRID_MAX || cellY > this.GRID_MAX) continue;
            const index = (cellY - this.GRID_MIN) * this.GRID_SIZE + (cellX - this.GRID_MIN);
            let cells = goalClaims.get(plan.strategicTargetId);
            if (!cells) {
                cells = new Map();
                goalClaims.set(plan.strategicTargetId, cells);
            }
            cells.set(index, (cells.get(index) ?? 0) + 1);
        }

        return { grid, occupied, wallAt, canBypassStructures, solids, breachAffinity, goalClaims, rampWalls: rampWallIds };
    }

    /** Stable per-troop approach preference derived from the id hash — the
     * deterministic substitute for randomness when fanning a cohort around a
     * target (identical inputs still yield identical plans). */
    private static approachAngle(id: string): number {
        let hash = 2166136261;
        for (let i = 0; i < id.length; i++) {
            hash ^= id.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return ((hash >>> 0) / 4294967296) * Math.PI * 2;
    }

    private static aStar(
        startX: number,
        startY: number,
        region: TargetRegion,
        context: TraversalContext
    ): SearchResult | null {
        const closed = this.closedScratch;
        const gScore = this.gScoreScratch;
        const cameFrom = this.cameFromScratch;
        closed.fill(0);
        gScore.fill(Number.POSITIVE_INFINITY);
        cameFrom.fill(-1);
        this.heapSize = 0;

        const heuristic = (x: number, y: number) => {
            const cellX = x + this.GRID_MIN;
            const cellY = y + this.GRID_MIN;
            const distance = this.distanceToRect(
                cellX + 0.5,
                cellY + 0.5,
                region.minX,
                region.minY,
                region.maxX,
                region.maxY
            );
            return Math.max(0, distance - region.range) * 9;
        };

        const start = startY * this.GRID_SIZE + startX;
        gScore[start] = 0;
        this.heapPush(start, heuristic(startX, startY));

        const dx = [1, -1, 0, 0, 1, 1, -1, -1] as const;
        const dy = [0, 0, 1, -1, 1, -1, 1, -1] as const;

        while (this.heapSize > 0) {
            const current = this.heapPop();
            if (closed[current]) continue;
            closed[current] = 1;
            const cx = current % this.GRID_SIZE;
            const cy = Math.floor(current / this.GRID_SIZE);

            if (this.goalScratch[current]) {
                const nodes: number[] = [];
                let cursor = current;
                while (cameFrom[cursor] !== -1) {
                    nodes.push(cursor);
                    cursor = cameFrom[cursor];
                }
                nodes.reverse();
                return { nodes, cost: gScore[current] };
            }

            for (let direction = 0; direction < 8; direction++) {
                const nx = cx + dx[direction];
                const ny = cy + dy[direction];
                if (nx < 0 || ny < 0 || nx >= this.GRID_SIZE || ny >= this.GRID_SIZE) continue;
                const next = ny * this.GRID_SIZE + nx;
                if (closed[next] || context.grid[next] >= this.COST_IMPASSABLE) continue;

                if (direction >= 4) {
                    const sideA = cy * this.GRID_SIZE + nx;
                    const sideB = ny * this.GRID_SIZE + cx;
                    // Do not cut corners and only enter conceptual wall cells
                    // cardinally. The returned physical route stops before one.
                    if (context.grid[sideA] >= this.COST_IMPASSABLE
                        || context.grid[sideB] >= this.COST_IMPASSABLE
                        || context.wallAt[sideA]
                        || context.wallAt[sideB]
                        || context.wallAt[current]
                        || context.wallAt[next]) {
                        continue;
                    }
                }

                const stepCost = direction >= 4 ? 14 : 10;
                const tentative = gScore[current] + (context.grid[next] * stepCost) / 10;
                if (tentative >= gScore[next]) continue;
                gScore[next] = tentative;
                cameFrom[next] = current;
                if (this.heapSize < this.MAX_HEAP) {
                    this.heapPush(next, tentative + heuristic(nx, ny));
                }
            }
        }
        return null;
    }

    private static compressCollinear(nodes: number[]): CombatPoint[] {
        const points = nodes.map(index => ({
            x: (index % this.GRID_SIZE) + this.GRID_MIN + 0.5,
            y: Math.floor(index / this.GRID_SIZE) + this.GRID_MIN + 0.5
        }));
        if (points.length < 3) return points;

        const compressed: CombatPoint[] = [points[0]];
        for (let i = 1; i < points.length - 1; i++) {
            const previous = compressed[compressed.length - 1];
            const current = points[i];
            const next = points[i + 1];
            const ax = Math.sign(current.x - previous.x);
            const ay = Math.sign(current.y - previous.y);
            const bx = Math.sign(next.x - current.x);
            const by = Math.sign(next.y - current.y);
            if (ax !== bx || ay !== by) compressed.push(current);
        }
        compressed.push(points[points.length - 1]);
        return compressed;
    }

    private static penetrationScore(
        troop: Pick<Troop, 'type' | 'level'>,
        x: number,
        y: number,
        buildings: PlacedBuilding[],
        mapSize: number,
        rampWallIds?: ReadonlySet<string>
    ): number {
        let score = 0;
        if (x < -2.25) score += -2.25 - x;
        if (y < -2.25) score += -2.25 - y;
        if (x > mapSize + 2.25) score += x - (mapSize + 2.25);
        if (y > mapSize + 2.25) score += y - (mapSize + 2.25);

        const radius = this.agentRadius(troop);
        for (const building of buildings) {
            if (building.health <= 0 || building.isDestroyed) continue;
            // Ramped wall (parked allied siege tower): physically crossable —
            // the cost model above keeps it priced, this keeps it passable.
            // Both layers must agree or troops plan through and bounce off.
            if (rampWallIds?.has(building.id)) continue;
            const info = BUILDING_DEFINITIONS[building.type as keyof typeof BUILDING_DEFINITIONS];
            if (!info) continue;
            const minX = building.gridX - radius;
            const minY = building.gridY - radius;
            const maxX = building.gridX + info.width + radius;
            const maxY = building.gridY + info.height + radius;
            if (x <= minX || x >= maxX || y <= minY || y >= maxY) continue;
            score += Math.min(x - minX, maxX - x, y - minY, maxY - y) + 0.0001;
        }
        return score;
    }

    private static agentRadius(troop: Pick<Troop, 'type' | 'level'>): number {
        const stats = getTroopStats(troop.type, troop.level || 1);
        return 0.12 + Math.min(0.12, Math.sqrt(Math.max(1, stats.space)) * 0.018);
    }

    private static distanceToRect(
        x: number,
        y: number,
        minX: number,
        minY: number,
        maxX: number,
        maxY: number
    ): number {
        const dx = Math.max(minX - x, 0, x - maxX);
        const dy = Math.max(minY - y, 0, y - maxY);
        return Math.hypot(dx, dy);
    }

    private static heapPush(node: number, f: number) {
        let index = this.heapSize++;
        this.heapNode[index] = node;
        this.heapF[index] = f;
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (this.heapF[parent] <= this.heapF[index]) break;
            const parentNode = this.heapNode[parent];
            const parentF = this.heapF[parent];
            this.heapNode[parent] = this.heapNode[index];
            this.heapF[parent] = this.heapF[index];
            this.heapNode[index] = parentNode;
            this.heapF[index] = parentF;
            index = parent;
        }
    }

    private static heapPop(): number {
        const top = this.heapNode[0];
        const last = --this.heapSize;
        this.heapNode[0] = this.heapNode[last];
        this.heapF[0] = this.heapF[last];
        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            if (left >= last) break;
            const right = left + 1;
            const smallest = right < last && this.heapF[right] < this.heapF[left] ? right : left;
            if (this.heapF[index] <= this.heapF[smallest]) break;
            const childNode = this.heapNode[smallest];
            const childF = this.heapF[smallest];
            this.heapNode[smallest] = this.heapNode[index];
            this.heapF[smallest] = this.heapF[index];
            this.heapNode[index] = childNode;
            this.heapF[index] = childF;
            index = smallest;
        }
        return top;
    }

    private static clamp(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, value));
    }
}
