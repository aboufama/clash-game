import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { getBuildingStats, getTroopStats, type BuildingType, type TroopType } from '../src/game/config/GameDefinitions';
import { CombatNavigationSystem } from '../src/game/systems/CombatNavigationSystem';
import { PathfindingSystem } from '../src/game/systems/PathfindingSystem';
import type { PlacedBuilding, Troop } from '../src/game/types/GameTypes';

const building = (
    id: string,
    type: BuildingType,
    gridX: number,
    gridY: number,
    health?: number
): PlacedBuilding => {
    const stats = getBuildingStats(type, 1);
    const maxHealth = stats.maxHealth || 100;
    return {
        id,
        type,
        gridX,
        gridY,
        level: 1,
        health: health ?? maxHealth,
        maxHealth,
        owner: 'ENEMY'
    } as unknown as PlacedBuilding;
};

const troop = (id: string, type: TroopType, gridX: number, gridY: number): Troop => {
    const stats = getTroopStats(type, 1);
    return {
        id,
        type,
        level: 1,
        gridX,
        gridY,
        health: stats.health,
        maxHealth: stats.health,
        owner: 'PLAYER',
        target: null,
        lastAttackTime: 0,
        attackDelay: stats.attackDelay ?? 1000,
        speedMult: 1,
        hasTakenDamage: false,
        facingAngle: 0
    } as unknown as Troop;
};

const wallLoop = (min: number, max: number): PlacedBuilding[] => {
    const walls: PlacedBuilding[] = [];
    for (let x = min; x <= max; x++) {
        walls.push(building(`wall-n-${x}`, 'wall', x, min));
        walls.push(building(`wall-s-${x}`, 'wall', x, max));
    }
    for (let y = min + 1; y < max; y++) {
        walls.push(building(`wall-w-${y}`, 'wall', min, y));
        walls.push(building(`wall-e-${y}`, 'wall', max, y));
    }
    return walls;
};

const contains = (structure: PlacedBuilding, x: number, y: number): boolean => {
    const stats = getBuildingStats(structure.type as BuildingType, structure.level);
    return x >= structure.gridX && x < structure.gridX + stats.width
        && y >= structure.gridY && y < structure.gridY + stats.height;
};

const inside = building('inside', 'town_hall', 10, 10);
const loop = wallLoop(8, 14);
const warrior = troop('warrior-fixed', 'warrior', 4.5, 11.5);
const closed = [inside, ...loop];

const closedPlan = CombatNavigationSystem.planToBuilding(warrior, inside, closed, [warrior], 1, 0);
assert(closedPlan, 'closed wall loop should still produce a breach plan');
assert.equal(closedPlan.strategicTargetId, inside.id, 'breach must retain the real objective');
assert(closedPlan.blockerId, 'melee route into a closed loop must select a wall blocker');
assert.equal(closedPlan.activeTargetId, closedPlan.blockerId);
for (const waypoint of closedPlan.waypoints) {
    assert(!closed.some(item => contains(item, waypoint.x, waypoint.y)), 'physical waypoint entered live structure');
}

// Home-village figures are not combatants: a fresh recruit walks from the
// barracks door to a station tile INSIDE its army camp. Even the tightest wall
// ring around the 3x3 camp must be routable, while a real opening still wins.
const ambientCamp = building('ambient-camp', 'army_camp', 10, 10);
const ambientBarracks = building('ambient-barracks', 'barracks', 3, 10);
const ambientLoop = wallLoop(9, 13);
const ambientStart = { x: 4, y: 12 }; // front-center door of the 2x2 barracks
const ambientTarget = { gridX: 10, gridY: 11 }; // camp footprint, behind the ring
const ambientWallCells = new Set(ambientLoop.map(item => `${item.gridX},${item.gridY}`));
const ambientClosedPath = PathfindingSystem.findAmbientPath(
    ambientStart.x,
    ambientStart.y,
    ambientTarget,
    [ambientBarracks, ambientCamp, ...ambientLoop],
    ambientCamp.id
);
assert(ambientClosedPath?.length, 'friendly camp figure could not cross a closed wall loop');
assert(
    ambientClosedPath.some(point => ambientWallCells.has(`${point.x},${point.y}`)),
    'friendly camp path reached a closed enclosure without a wall-hop waypoint'
);
assert.deepEqual(
    { x: ambientClosedPath.at(-1)?.x, y: ambientClosedPath.at(-1)?.y },
    { x: ambientTarget.gridX, y: ambientTarget.gridY },
    'friendly camp path did not finish on the selected interior station tile'
);

const ambientLoopWithGap = ambientLoop.filter(item => item.id !== 'wall-w-11');
const ambientLiveWallCells = new Set(ambientLoopWithGap.map(item => `${item.gridX},${item.gridY}`));
const ambientGapPath = PathfindingSystem.findAmbientPath(
    ambientStart.x,
    ambientStart.y,
    ambientTarget,
    [ambientBarracks, ambientCamp, ...ambientLoopWithGap],
    ambientCamp.id
);
assert(ambientGapPath?.length, 'friendly camp figure could not use an open wall gap');
assert(
    ambientGapPath.every(point => !ambientLiveWallCells.has(`${point.x},${point.y}`)),
    'friendly camp path hopped a live wall despite a direct opening'
);

const startCellTarget = building('start-cell-target', 'wall', 10, 10);
const betweenCenterAndRange = troop('between-center', 'warrior', 9.2, 10.5);
const startCellPlan = CombatNavigationSystem.planToBuilding(
    betweenCenterAndRange,
    startCellTarget,
    [startCellTarget],
    [betweenCenterAndRange],
    1,
    0
);
assert(startCellPlan?.waypoints.length, 'continuous position was stranded when its cell center was an attack goal');
assert(Math.abs(startCellPlan.waypoints[0].x - 9.5) < 0.001, 'start-cell approach did not use the legal center slot');

const townHallStats = getBuildingStats('town_hall', 1);
const tightWalls: PlacedBuilding[] = [];
const tightMinX = inside.gridX - 1;
const tightMaxX = inside.gridX + townHallStats.width;
const tightMinY = inside.gridY - 1;
const tightMaxY = inside.gridY + townHallStats.height;
for (let x = tightMinX; x <= tightMaxX; x++) {
    tightWalls.push(building(`tight-n-${x}`, 'wall', x, tightMinY));
    tightWalls.push(building(`tight-s-${x}`, 'wall', x, tightMaxY));
}
for (let y = tightMinY + 1; y < tightMaxY; y++) {
    tightWalls.push(building(`tight-w-${y}`, 'wall', tightMinX, y));
    tightWalls.push(building(`tight-e-${y}`, 'wall', tightMaxX, y));
}
const tightPlan = CombatNavigationSystem.planToBuilding(warrior, inside, [inside, ...tightWalls], [warrior], 1, 0);
assert(tightPlan?.blockerId, 'a wall immediately adjacent to its target produced no breach plan');

const apronTroop = troop('apron', 'warrior', -1, 10.5);
const edgeStructure = building('edge-structure', 'town_hall', 0, 9);
const apronTarget = building('apron-target', 'storage', 10, 10);
const apronPlan = CombatNavigationSystem.planToBuilding(
    apronTroop,
    apronTarget,
    [edgeStructure, apronTarget],
    [apronTroop],
    1,
    0
);
assert(apronPlan?.waypoints.length, 'legal off-map deployment apron produced no route');
assert(apronPlan.waypoints.some(point => point.x < 0), 'apron route was clamped through an edge structure');
assert(apronPlan.waypoints.every(point => !contains(edgeStructure, point.x, point.y)), 'apron route entered the edge structure');

const deterministicSignature = JSON.stringify({
    blocker: closedPlan.blockerId,
    path: closedPlan.waypoints
});
for (let attempt = 0; attempt < 20; attempt++) {
    const repeated = CombatNavigationSystem.planToBuilding(warrior, inside, closed, [warrior], 1, 0);
    assert(repeated);
    assert.equal(JSON.stringify({ blocker: repeated.blockerId, path: repeated.waypoints }), deterministicSignature);
}

const opened = closed.filter(item => item.id !== closedPlan.blockerId);
const openedPlan = CombatNavigationSystem.planToBuilding(warrior, inside, opened, [warrior], 2, 1);
assert(openedPlan, 'destroyed blocker should open a route to the retained objective');
assert.equal(openedPlan.blockerId, undefined, 'troop should use the new gap instead of attacking another wall');
assert.equal(openedPlan.activeTargetId, inside.id);

const archer = troop('archer-fixed', 'archer', 7.4, 11.5);
const rangedPlan = CombatNavigationSystem.planToBuilding(archer, inside, closed, [archer], 1, 0);
assert(rangedPlan);
assert.equal(rangedPlan.blockerId, undefined, 'ranged troop in range outside a wall should fire over it');
assert.equal(rangedPlan.activeTargetId, inside.id);

const tunnelWall = building('tunnel-wall', 'wall', 8, 10);
const tunneler = troop('tunneler', 'warrior', 7.2, 10.5);
const swept = CombatNavigationSystem.resolveMovement(tunneler, 2.6, 0, 2.6, 0, [tunnelWall], 25);
assert(swept.blocked, 'large movement delta should report wall contact');
assert(swept.x < 8, 'large movement delta tunneled through a live wall');
assert(CombatNavigationSystem.isPositionWalkable(tunneler, swept.x, swept.y, [tunnelWall], 25));

const cornerTroop = troop('corner', 'warrior', 7.5, 7.5);
const cornerWalls = [
    building('corner-east', 'wall', 8, 7),
    building('corner-south', 'wall', 7, 8)
];
const cornerMove = CombatNavigationSystem.resolveMovement(cornerTroop, 2, 2, 2, 2, cornerWalls, 25);
assert(cornerMove.blocked, 'perpendicular walls should block diagonal corner cutting');
assert(cornerMove.x < 8 && cornerMove.y < 8, 'troop escaped through a closed diagonal corner');

// No live troop is airborne yet, so temporarily exercise the configured
// mobility contract through the memoized profile and restore it immediately.
const syntheticAirStats = getTroopStats('warrior', 1);
const originalMovement = syntheticAirStats.movementType;
try {
    syntheticAirStats.movementType = 'air';
    const airTroop = troop('synthetic-air', 'warrior', 4.5, 11.5);
    const airPlan = CombatNavigationSystem.planToBuilding(airTroop, inside, closed, [airTroop], 1, 0);
    assert(airPlan);
    assert.equal(airPlan.blockerId, undefined, 'air mobility incorrectly acquired a wall blocker');
    const airMove = CombatNavigationSystem.resolveMovement(airTroop, 6, 0, 6, 0, closed, 25);
    assert(!airMove.blocked && airMove.x > 8, 'air mobility did not bypass ground structures');
} finally {
    syntheticAirStats.movementType = originalMovement;
}

const cannon = building('priority-cannon', 'cannon', 18, 18);
const storage = building('near-storage', 'storage', 6, 6);
const golem = troop('golem-priority', 'golem', 4, 4);
const golemSelection = CombatNavigationSystem.selectTargetAndPlan(golem, [storage, cannon], [golem], 1, 0);
assert.equal(golemSelection.strategicTarget?.id, cannon.id, 'defense-priority troop ignored its target tier');

const ram = troop('ram-priority', 'ram', 4.5, 11.5);
const ramSelection = CombatNavigationSystem.selectTargetAndPlan(ram, closed, [ram], 1, 0);
assert.equal(ramSelection.strategicTarget?.id, inside.id, 'ram must retain Town Hall as strategic objective');
assert(ramSelection.plan?.blockerId, 'ram must use the required wall instead of phasing through it');

// Straight charge: every waypoint sits ON the deploy→objective segment
// (zero cross product, inside the segment) and outside live footprints.
const assertOnChargeLine = (
    plan: { waypoints: Array<{ x: number; y: number }> } | null | undefined,
    from: { x: number; y: number },
    to: { x: number; y: number },
    live: PlacedBuilding[]
) => {
    assert(plan, 'expected a straight-charge plan');
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    for (const waypoint of plan.waypoints) {
        const cross = dx * (waypoint.y - from.y) - dy * (waypoint.x - from.x);
        assert(Math.abs(cross) < 0.001,
            `charge waypoint ${JSON.stringify(waypoint)} left the straight line`);
        const along = (dx * (waypoint.x - from.x) + dy * (waypoint.y - from.y)) / (dx * dx + dy * dy);
        assert(along >= 0 && along <= 1, 'charge waypoint overshot the deploy→objective segment');
        assert(!live.some(item => contains(item, waypoint.x, waypoint.y)),
            'charge waypoint entered a live structure');
    }
};

// The ray (4.5,11.5) → town-hall center (11.5,11.5) crosses exactly
// wall-w-11: the ram fights the wall ON its line, not the cheapest breach.
const townHallCenter = { x: 11.5, y: 11.5 };
assert.equal(ramSelection.plan.blockerId, 'wall-w-11', 'ram did not attack the wall on its charge line');
assert.equal(ramSelection.plan.activeTargetId, 'wall-w-11');
assertOnChargeLine(ramSelection.plan, { x: ram.gridX, y: ram.gridY }, townHallCenter, closed);

// Identical inputs must produce the byte-identical charge plan.
const ramSignature = JSON.stringify({
    blocker: ramSelection.plan.blockerId,
    path: ramSelection.plan.waypoints
});
for (let attempt = 0; attempt < 20; attempt++) {
    const repeated = CombatNavigationSystem.selectTargetAndPlan(ram, closed, [ram], 1, 0);
    assert(repeated.plan);
    assert.equal(
        JSON.stringify({ blocker: repeated.plan.blockerId, path: repeated.plan.waypoints }),
        ramSignature,
        'straight-charge plan is not deterministic'
    );
}

// A non-wall building straddling the line is fought, not circumnavigated.
const chargeObstacle = building('charge-storage', 'storage', 6, 11);
const chargeThrough = CombatNavigationSystem.selectTargetAndPlan(
    ram,
    [chargeObstacle, ...closed],
    [ram],
    1,
    0
);
assert.equal(chargeThrough.strategicTarget?.id, inside.id);
assert.equal(chargeThrough.plan?.activeTargetId, chargeObstacle.id,
    'ram routed around a building on its charge line');
assert.equal(chargeThrough.plan?.blockerId, chargeObstacle.id);
assertOnChargeLine(chargeThrough.plan, { x: ram.gridX, y: ram.gridY }, townHallCenter, [chargeObstacle, ...closed]);

// Destroying the ray blocker continues the charge on the now-clear line.
const ramOpened = closed.filter(item => item.id !== 'wall-w-11');
const ramContinue = CombatNavigationSystem.selectTargetAndPlan(ram, ramOpened, [ram], 2, 1);
assert.equal(ramContinue.strategicTarget?.id, inside.id);
assert.equal(ramContinue.plan?.blockerId, undefined, 'ram kept a blocker after its charge line opened');
assert.equal(ramContinue.plan?.activeTargetId, inside.id);
assertOnChargeLine(ramContinue.plan, { x: ram.gridX, y: ram.gridY }, townHallCenter, ramOpened);

// Town Hall already destroyed: the ram falls back to the normal non-wall
// tier and still emits a straight-line plan toward the survivor.
const chargeSurvivor = building('charge-survivor', 'storage', 10, 10);
const ramFallback = CombatNavigationSystem.selectTargetAndPlan(ram, [chargeSurvivor], [ram], 1, 0);
assert.equal(ramFallback.strategicTarget?.id, chargeSurvivor.id,
    'ram with no Town Hall must fall back to non-wall targeting');
assert.equal(ramFallback.plan?.blockerId, undefined);
assert.equal(ramFallback.plan?.waypoints.length, 1, 'fallback charge should be one straight-line waypoint');
assertOnChargeLine(ramFallback.plan, { x: ram.gridX, y: ram.gridY }, { x: 11, y: 11 }, [chargeSurvivor]);

const wallbreaker = troop('wallbreaker-priority', 'wallbreaker', 4.5, 11.5);
const wallbreakerSelection = CombatNavigationSystem.selectTargetAndPlan(wallbreaker, closed, [wallbreaker], 1, 0);
assert.equal(wallbreakerSelection.strategicTarget?.type, 'wall', 'wall breaker lost explicit wall priority');

// A locked objective must be evaluated even when more than ten slightly
// nearer candidates precede it in the raw-distance ordering. Its bounded
// hysteresis should keep the lock when the discounted route remains best.
const stickyTroop = troop('sticky', 'warrior', 12.5, 12.5);
const stickyPositions = [
    [21, 16], [21, 8], [16, 21], [8, 21], [3, 16], [3, 8],
    [16, 3], [8, 3], [20, 18], [20, 6], [4, 18]
] as const;
const stickyDecoys = stickyPositions.map(([x, y], index) => building(`sticky-${index}`, 'jukebox', x, y));
const stickyPreferred = building('sticky-preferred', 'jukebox', 23, 12);
const stickyCandidates = [...stickyDecoys, stickyPreferred];
const stickyRawOrder = [...stickyCandidates].sort((a, b) =>
    CombatNavigationSystem.edgeDistance(stickyTroop.gridX, stickyTroop.gridY, a)
    - CombatNavigationSystem.edgeDistance(stickyTroop.gridX, stickyTroop.gridY, b)
    || a.id.localeCompare(b.id)
);
assert(stickyRawOrder.findIndex(candidate => candidate.id === stickyPreferred.id) >= 10,
    'sticky-target fixture no longer exercises the post-shortlist case');
const stickySelection = CombatNavigationSystem.selectTargetAndPlan(
    stickyTroop,
    stickyCandidates,
    [stickyTroop],
    1,
    0,
    stickyPreferred
);
assert.equal(stickySelection.strategicTarget?.id, stickyPreferred.id,
    'preferred target was pruned before route hysteresis could be evaluated');

// Cohorts should converge on a small number of nearby useful breaches, then
// abandon all wall work quickly once any selected gap becomes genuinely open.
const cohort = Array.from({ length: 24 }, (_, index) =>
    troop(`cohort-${String(index).padStart(2, '0')}`, 'warrior',
        3.8 + (index % 4) * 0.28,
        9.2 + Math.floor(index / 4) * 0.72)
);
for (const unit of cohort) {
    const selection = CombatNavigationSystem.selectTargetAndPlan(unit, closed, cohort, 1, 0);
    unit.strategicTarget = selection.strategicTarget;
    unit.target = selection.activeTarget;
    unit.navigationPlan = selection.plan ?? undefined;
}
const cohortBlockers = new Map<string, number>();
for (const unit of cohort) {
    const blockerId = unit.navigationPlan?.blockerId;
    if (blockerId) cohortBlockers.set(blockerId, (cohortBlockers.get(blockerId) ?? 0) + 1);
}
assert(cohortBlockers.size <= 3,
    `cohort scattered across irrelevant walls: ${JSON.stringify([...cohortBlockers])}`);
const cohortGapId = [...cohortBlockers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
assert(cohortGapId, 'cohort fixture produced no breach');
const cohortOpened = closed.filter(item => item.id !== cohortGapId);
let routesThroughGap = 0;
for (const unit of cohort) {
    const plan = CombatNavigationSystem.planToBuilding(unit, inside, cohortOpened, cohort, 2, 1);
    unit.navigationPlan = plan ?? undefined;
    if (plan && !plan.blockerId) routesThroughGap++;
}
assert(routesThroughGap >= Math.ceil(cohort.length * 0.9),
    'cohort kept attacking adjacent walls after a shared gap opened');

// SIEGE-TOWER ALLY RAMP: a ramped wall becomes crossable for allied plans at
// a TOLL (COST_OPEN+12, never free), is never a blocker or an attack slot,
// and both layers (cost model + collision) agree so nothing plans through
// and then bounces. Without the set the wall stays fully solid.
const rampWallId = closedPlan.blockerId!;
const rampWall = closed.find(item => item.id === rampWallId)!;
const rampSet = new Set([rampWallId]);
const rampPlan = CombatNavigationSystem.planToBuilding(warrior, inside, closed, [warrior], 3, 2, rampSet);
assert(rampPlan, 'ramped wall loop should produce a through-plan');
assert.equal(rampPlan.blockerId, undefined, 'a ramped wall must never be a blocker');
assert.equal(rampPlan.activeTargetId, inside.id, 'ramp route must keep the real objective active');
// Waypoints are compressed collinear — sample the route's SEGMENTS to prove
// it physically crosses the ramped wall tile (no other loop wall is passable).
const rampRouteCrosses = (() => {
    const points = [{ x: warrior.gridX, y: warrior.gridY }, ...rampPlan.waypoints];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05));
        for (let s = 0; s <= steps; s++) {
            const x = a.x + ((b.x - a.x) * s) / steps;
            const y = a.y + ((b.y - a.y) * s) / steps;
            if (contains(rampWall, x, y)) return true;
        }
    }
    return false;
})();
assert(rampRouteCrosses, 'ramp route should cross the ramped wall tile');
assert(!contains(rampWall, rampPlan.goal.x, rampPlan.goal.y),
    'a ramp cell must never become an attack slot/goal');
assert(
    CombatNavigationSystem.isPositionWalkable(warrior, rampWall.gridX + 0.5, rampWall.gridY + 0.5, closed, 25, rampSet),
    'ramp tile must be physically walkable for allied troops'
);
assert(
    !CombatNavigationSystem.isPositionWalkable(warrior, rampWall.gridX + 0.5, rampWall.gridY + 0.5, closed, 25),
    'without the ramp set the wall must stay solid'
);
const rampWalker = troop('ramp-walker', 'warrior', rampWall.gridX - 0.7, rampWall.gridY + 0.5);
const rampMove = CombatNavigationSystem.resolveMovement(rampWalker, 1.6, 0, 1.6, 0, closed, 25, rampSet);
assert(!rampMove.blocked && rampMove.x > rampWall.gridX + 0.2,
    'allied movement should pass over the ramp tile');
const solidMove = CombatNavigationSystem.resolveMovement(rampWalker, 1.6, 0, 1.6, 0, closed, 25);
assert(solidMove.blocked && solidMove.x < rampWall.gridX,
    'movement without the ramp set must still stop at the wall');
// The toll: strictly costlier than the same route through a genuinely open gap.
const rampGapPlan = CombatNavigationSystem.planToBuilding(
    warrior, inside, closed.filter(item => item.id !== rampWallId), [warrior], 4, 3);
assert(rampGapPlan && rampPlan.routeCost > rampGapPlan.routeCost,
    'ramp crossing must carry a toll over genuinely open ground');

// WAR ELEPHANT: plans into the wall on its route, one trample strike fells
// up to an L4 wall (data invariant), and the very next plan after the wall
// falls continues to the objective with no residual blocker.
const elephant = troop('elephant-trample', 'warelephant', 4.5, 11.5);
const elephantSelection = CombatNavigationSystem.selectTargetAndPlan(elephant, closed, [elephant], 1, 0);
assert.equal(elephantSelection.strategicTarget?.id, inside.id, 'elephant lost its objective to a wall');
assert(elephantSelection.plan?.blockerId, 'elephant must fight the wall on its route');
const elephantStats = getTroopStats('warelephant', 1);
const l4Wall = getBuildingStats('wall', 4);
assert(
    elephantStats.damage * (elephantStats.wallDamageMultiplier ?? 1) >= (l4Wall.maxHealth || 0),
    `one trample strike must fell an L4 wall (${elephantStats.damage} x ${elephantStats.wallDamageMultiplier} < ${l4Wall.maxHealth})`
);
const trampled = closed.filter(item => item.id !== elephantSelection.plan?.blockerId);
const elephantContinue = CombatNavigationSystem.selectTargetAndPlan(
    elephant, trampled, [elephant], 2, 1, elephantSelection.strategicTarget ?? undefined);
assert.equal(elephantContinue.strategicTarget?.id, inside.id, 'elephant dropped its objective after trampling');
assert.equal(elephantContinue.plan?.blockerId, undefined, 'elephant kept a blocker after the wall fell');

const performanceTroops = Array.from({ length: 150 }, (_, index) =>
    troop(`perf-${index}`, 'warrior', 2.5 + (index % 5) * 0.08, 10.5 + (index % 7) * 0.06)
);
const startedAt = performance.now();
for (const unit of performanceTroops) {
    const plan = CombatNavigationSystem.planToBuilding(unit, inside, closed, performanceTroops, 1, 0);
    assert(plan);
}
const elapsed = performance.now() - startedAt;
assert(elapsed < 1000, `150 deterministic plans took ${elapsed.toFixed(1)}ms`);

console.log(`pathing regressions passed (${elapsed.toFixed(1)}ms for 150 closed-loop plans)`);
