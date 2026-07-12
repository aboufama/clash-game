import assert from 'node:assert/strict';
import {
    buildWildernessTopology,
    classifyJoinedWildernessGapTap,
    isJoinedWildernessHorizontalEdge,
    isJoinedWildernessJunction,
    isJoinedWildernessVerticalEdge,
    isKnownWildernessPlot,
    needsOccupiedRoadShoulder,
    occupiedRoadShouldersFor,
    roadJunctionShapeForArms,
    roundedRoadBendFor,
    wildernessRoadJunctionAt,
    type WildernessTopologyPlot
} from '../src/game/systems/WildernessTopology';

const plot = (
    x: number,
    y: number,
    kind: WildernessTopologyPlot['kind'],
    settleable?: boolean
): WildernessTopologyPlot => ({ x, y, kind, ...(settleable === undefined ? {} : { settleable }) });

// Protected and settleable empty plots are both wilderness and must join.
const mixedEmpty = buildWildernessTopology({ x: 10, y: 20 }, 2, [
    plot(8, 19, 'empty', false),
    plot(9, 19, 'empty', true),
    plot(11, 18, 'empty', false),
    plot(11, 19, 'empty', true)
]);
assert(isJoinedWildernessVerticalEdge(mixedEmpty, -1, -1));
assert(isJoinedWildernessHorizontalEdge(mixedEmpty, 1, -1));

// The live center stays occupied even if a malformed/fallback caller labels it empty.
const centerOccupied = buildWildernessTopology({ x: 0, y: 0 }, 1, [
    plot(0, 0, 'empty', false),
    plot(1, 0, 'empty', true),
    plot(-1, 0, 'empty', true)
]);
assert(!isKnownWildernessPlot(centerOccupied, 0, 0));
assert(!isJoinedWildernessVerticalEdge(centerOccupied, 1, 0));
assert(!isJoinedWildernessVerticalEdge(centerOccupied, 0, 0));

// Occupied and unknown neighbors fail closed: no road may disappear beside a base.
const occupiedAndUnknown = buildWildernessTopology({ x: 0, y: 0 }, 2, [
    plot(-2, 1, 'empty'),
    // (-1, 1) is missing/unknown.
    plot(1, 1, 'empty'),
    plot(2, 1, 'player'),
    plot(1, -2, 'bot'),
    plot(1, -1, 'empty')
]);
assert(!isJoinedWildernessVerticalEdge(occupiedAndUnknown, -1, 1));
assert(!isJoinedWildernessVerticalEdge(occupiedAndUnknown, 2, 1));
assert(!isJoinedWildernessHorizontalEdge(occupiedAndUnknown, 1, -1));

// Conflicting duplicate records also fail closed, independent of input order.
const duplicateA = buildWildernessTopology({ x: 0, y: 0 }, 2, [
    plot(-2, 1, 'empty'),
    plot(-1, 1, 'empty'),
    plot(-1, 1, 'bot')
]);
const duplicateB = buildWildernessTopology({ x: 0, y: 0 }, 2, [
    plot(-1, 1, 'bot'),
    plot(-1, 1, 'empty'),
    plot(-2, 1, 'empty')
]);
assert(!isJoinedWildernessVerticalEdge(duplicateA, -1, 1));
assert.equal(duplicateA.signature, duplicateB.signature);

// Four known wilderness plots remove the crossing; three plus unknown do not.
const fourWild = buildWildernessTopology({ x: 0, y: 0 }, 2, [
    plot(-2, -2, 'empty'),
    plot(-1, -2, 'empty'),
    plot(-2, -1, 'empty'),
    plot(-1, -1, 'empty')
]);
assert(isJoinedWildernessJunction(fourWild, -1, -1));
const threeWild = buildWildernessTopology({ x: 0, y: 0 }, 2, [
    plot(-2, -2, 'empty'),
    plot(-1, -2, 'empty'),
    plot(-2, -1, 'empty')
]);
assert(!isJoinedWildernessJunction(threeWild, -1, -1));

// Junction arms retain roads beside occupied plots and classify soft corners.
const crossTopology = buildWildernessTopology({ x: 0, y: 0 }, 2, [
    plot(-2, -2, 'player'),
    plot(-1, -2, 'empty'),
    plot(-2, -1, 'empty'),
    plot(-1, -1, 'bot')
]);
const cross = wildernessRoadJunctionAt(crossTopology, -1, -1);
assert(cross);
assert.equal(cross.shape, 'cross');
assert.equal(cross.armMask, 15);
assert.deepEqual(cross.arms, { n: true, e: true, s: true, w: true });
assert.equal(cross.localKey, 'road-junction:-1,-1');
assert.equal(cross.worldKey, 'road-junction:-1,-1');

// One occupied quadrant leaves an L wrapping that plot and exposes both
// rounded-corner roles to the grass/road overlay renderer.
const bendTopology = buildWildernessTopology({ x: 0, y: 0 }, 2, [
    plot(-2, -2, 'empty'),
    plot(-1, -2, 'player'),
    plot(-2, -1, 'empty'),
    plot(-1, -1, 'empty')
]);
const bend = wildernessRoadJunctionAt(bendTopology, -1, -1);
assert(bend);
assert.equal(bend.shape, 'l');
assert.deepEqual(bend.arms, { n: true, e: true, s: false, w: false });
const roundedBend = roundedRoadBendFor(bend);
assert(roundedBend);
assert.equal(roundedBend.innerCorner, 'ne');
assert.equal(roundedBend.outerCorner, 'sw');
assert.equal(roundedBend.localKey, 'road-bend:-1,-1:ne');
assert.equal(roundedBend.worldKey, 'road-bend:-1,-1:ne');
assert(needsOccupiedRoadShoulder(bend, 'ne'));
assert(!needsOccupiedRoadShoulder(bend, 'nw'));
const bendShoulders = occupiedRoadShouldersFor(bend);
assert.equal(bendShoulders.length, 1);
assert.deepEqual(bendShoulders[0].localPlot, { x: -1, y: -2 });
assert.equal(bendShoulders[0].plotCorner, 'sw');
assert.equal(bendShoulders[0].localKey, 'road-shoulder:-1,-1:ne');

// Two adjacent occupied quadrants leave a T; all-wild leaves no junction.
const teeTopology = buildWildernessTopology({ x: 0, y: 0 }, 2, [
    plot(-2, -2, 'empty'),
    plot(-1, -2, 'bot'),
    plot(-2, -1, 'empty'),
    plot(-1, -1, 'player')
]);
const tee = wildernessRoadJunctionAt(teeTopology, -1, -1);
assert(tee);
assert.equal(tee.shape, 't');
assert.deepEqual(tee.arms, { n: true, e: true, s: true, w: false });
assert.equal(roundedRoadBendFor(tee), null);

const noRoad = wildernessRoadJunctionAt(fourWild, -1, -1);
assert(noRoad);
assert.equal(noRoad.shape, 'none');
assert.equal(noRoad.armMask, 0);
assert.deepEqual(noRoad.arms, { n: false, e: false, s: false, w: false });
const unknownPerimeter = wildernessRoadJunctionAt(fourWild, -2, -2);
assert(unknownPerimeter);
assert.equal(unknownPerimeter.shape, 'cross', 'unknown perimeter cells must retain every road arm');
assert.equal(unknownPerimeter.occupiedShoulders.length, 0, 'unknown cells must not invent occupied shoulders');

// Straight and dead masks cannot currently arise from four parcel states, but
// total mask classification keeps clipped/custom future road renderers honest.
assert.equal(roadJunctionShapeForArms({ n: true, e: false, s: true, w: false }), 'straight');
assert.equal(roadJunctionShapeForArms({ n: false, e: true, s: false, w: true }), 'straight');
assert.equal(roadJunctionShapeForArms({ n: true, e: false, s: false, w: false }), 'dead');

// Negative world coordinates produce valid local keys and stable absolute keys.
const negative = buildWildernessTopology({ x: -5, y: -8 }, 2, [
    plot(-7, -7, 'empty'),
    plot(-6, -7, 'empty')
]);
const negativeEdge = negative.verticalJoins.find(join => join.localKey === 'v:-1,1');
assert(negativeEdge);
assert.equal(negativeEdge.worldKey, 'v:-6,-7');

// A shared physical edge keeps its absolute identity under a local reanchor.
const physicalPlots = [plot(11, 11, 'empty'), plot(12, 11, 'empty')];
const anchorA = buildWildernessTopology({ x: 10, y: 10 }, 2, physicalPlots);
const anchorB = buildWildernessTopology({ x: 11, y: 10 }, 2, physicalPlots);
const edgeA = anchorA.verticalJoins.find(join => join.worldKey === 'v:12,11');
const edgeB = anchorB.verticalJoins.find(join => join.worldKey === 'v:12,11');
assert(edgeA && edgeB);
assert.notEqual(edgeA.localKey, edgeB.localKey);
assert.equal(edgeA.worldKey, edgeB.worldKey);
assert.notEqual(anchorA.signature, anchorB.signature, 'absolute anchor must participate in the render cache key');

// Junction and bend identities are likewise absolute and negative-safe.
const physicalJunctionPlots = [
    plot(-7, -8, 'empty'),
    plot(-6, -8, 'bot'),
    plot(-7, -7, 'empty'),
    plot(-6, -7, 'empty')
];
const junctionAnchorA = buildWildernessTopology({ x: -5, y: -5 }, 3, physicalJunctionPlots);
const junctionAnchorB = buildWildernessTopology({ x: -4, y: -5 }, 3, physicalJunctionPlots);
const negativeJunctionA = junctionAnchorA.roadJunctions.find(item => item.worldKey === 'road-junction:-6,-7');
const negativeJunctionB = junctionAnchorB.roadJunctions.find(item => item.worldKey === 'road-junction:-6,-7');
assert(negativeJunctionA && negativeJunctionB);
assert.equal(negativeJunctionA.shape, 'l');
assert.notEqual(negativeJunctionA.localKey, negativeJunctionB.localKey);
assert.equal(negativeJunctionA.worldKey, negativeJunctionB.worldKey);
const negativeBendA = roundedRoadBendFor(negativeJunctionA);
const negativeBendB = roundedRoadBendFor(negativeJunctionB);
assert(negativeBendA && negativeBendB);
assert.equal(negativeBendA.worldKey, negativeBendB.worldKey);
assert.notEqual(negativeBendA.localKey, negativeBendB.localKey);

// Input order and irrelevant settleability do not change topology signatures.
const signaturePlots = [
    plot(-2, -2, 'empty', false),
    plot(-1, -2, 'empty', true),
    plot(-2, -1, 'empty', true),
    plot(-1, -1, 'empty', false)
];
const signatureA = buildWildernessTopology({ x: 0, y: 0 }, 2, signaturePlots);
const signatureB = buildWildernessTopology(
    { x: 0, y: 0 },
    2,
    [...signaturePlots].reverse().map(item => ({ ...item, settleable: !item.settleable }))
);
assert.equal(signatureA.signature, signatureB.signature);

// Real grid-gap hit classification works on negative vertical and junction gaps.
const verticalTap = classifyJoinedWildernessGapTap(negative, -28, 39.5);
assert(verticalTap);
assert.equal(verticalTap.kind, 'vertical');
assert.equal(verticalTap.localKey, 'v:-1,1');
assert.deepEqual(verticalTap.selectedWorldPlot, { x: -7, y: -7 });

const junctionTap = classifyJoinedWildernessGapTap(fourWild, -28, -28);
assert(junctionTap);
assert.equal(junctionTap.kind, 'junction');
assert.equal(junctionTap.localKey, 'j:-1,-1');
assert.equal(junctionTap.adjacentWorldPlots.length, 4);

assert.equal(classifyJoinedWildernessGapTap(fourWild, -40, -40), null, 'plot interior is not a gap');
assert.equal(classifyJoinedWildernessGapTap(threeWild, -28, -28), null, 'active road junction is not a join');
assert.equal(classifyJoinedWildernessGapTap(fourWild, Number.NaN, 0), null);

assert.throws(
    () => buildWildernessTopology({ x: 0.5, y: 0 }, 1, []),
    /safe integer plot coordinates/
);
assert.throws(
    () => buildWildernessTopology({ x: 0, y: 0 }, -1, []),
    /non-negative safe integer/
);

console.log('wilderness topology regression passed', {
    vertical: mixedEmpty.verticalJoins.length,
    horizontal: mixedEmpty.horizontalJoins.length,
    junctions: fourWild.junctionJoins.length,
    roadShapes: [cross.shape, bend.shape, tee.shape, noRoad.shape],
    negativeWorldEdge: negativeEdge.worldKey,
    reanchoredLocalKeys: [edgeA.localKey, edgeB.localKey]
});
