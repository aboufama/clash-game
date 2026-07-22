/**
 * Pure plot-topology for joining adjacent wilderness parcels.
 *
 * This module deliberately knows nothing about Phaser or rendering. The map
 * authority supplies the known plot classifications; callers can then use the
 * returned local keys to replace only wild-to-wild road segments with shared
 * ground. Missing cells are never assumed to be wilderness, so a short or
 * stale map response fails closed by retaining its roads.
 */

export type WildernessTopologyPlotKind = 'player' | 'bot' | 'empty';

export interface WildernessTopologyCoordinate {
    readonly x: number;
    readonly y: number;
}

export interface WildernessTopologyPlot extends WildernessTopologyCoordinate {
    readonly kind: WildernessTopologyPlotKind;
    /** Settlement protection does not change terrain: both empty forms are wild. */
    readonly settleable?: boolean;
}

export type WildernessVerticalJoinKey = `v:${number},${number}`;
export type WildernessHorizontalJoinKey = `h:${number},${number}`;
export type WildernessJunctionKey = `j:${number},${number}`;
export type WildernessRoadJunctionKey = `road-junction:${number},${number}`;
export type WildernessRoadBendKey = `road-bend:${number},${number}:${WildernessJunctionQuadrant}`;
export type WildernessRoadShoulderKey = `road-shoulder:${number},${number}:${WildernessJunctionQuadrant}`;

export type WildernessRoadJunctionShape = 'cross' | 't' | 'l' | 'straight' | 'dead' | 'none';
export type WildernessJunctionQuadrant = 'nw' | 'ne' | 'se' | 'sw';
export type WildernessJunctionCellState = 'wild' | 'occupied' | 'unknown';

export interface WildernessRoadArms {
    readonly n: boolean;
    readonly e: boolean;
    readonly s: boolean;
    readonly w: boolean;
}

export interface WildernessOccupiedRoadShoulder {
    /** Which of the four plots around the junction owns this corner. */
    readonly quadrant: WildernessJunctionQuadrant;
    /** The physical corner of that plot which touches the road junction. */
    readonly plotCorner: WildernessJunctionQuadrant;
    readonly localPlot: WildernessTopologyCoordinate;
    readonly worldPlot: WildernessTopologyCoordinate;
    readonly localKey: WildernessRoadShoulderKey;
    readonly worldKey: WildernessRoadShoulderKey;
}

export interface WildernessRoadJunction {
    readonly boundaryX: number;
    readonly boundaryY: number;
    readonly worldBoundaryX: number;
    readonly worldBoundaryY: number;
    readonly localKey: WildernessRoadJunctionKey;
    readonly worldKey: WildernessRoadJunctionKey;
    readonly arms: WildernessRoadArms;
    /** N=1, E=2, S=4, W=8. Useful as a compact renderer switch. */
    readonly armMask: number;
    readonly shape: WildernessRoadJunctionShape;
    readonly cornerStates: Readonly<Record<WildernessJunctionQuadrant, WildernessJunctionCellState>>;
    readonly occupiedShoulders: readonly WildernessOccupiedRoadShoulder[];
}

export interface WildernessRoundedRoadBend {
    /** Plot quadrant embraced by both arms: the grass corner inside the turn. */
    readonly innerCorner: WildernessJunctionQuadrant;
    /** Opposite quadrant on the convex outside of the road turn. */
    readonly outerCorner: WildernessJunctionQuadrant;
    readonly localKey: WildernessRoadBendKey;
    readonly worldKey: WildernessRoadBendKey;
}

export interface WildernessVerticalJoin {
    readonly kind: 'vertical';
    /** Boundary X and plot-row Y relative to the topology center. */
    readonly boundaryX: number;
    readonly plotY: number;
    readonly localKey: WildernessVerticalJoinKey;
    /** Absolute key stays stable when this same edge is viewed from another center. */
    readonly worldKey: WildernessVerticalJoinKey;
    readonly worldBoundaryX: number;
    readonly worldPlotY: number;
}

export interface WildernessHorizontalJoin {
    readonly kind: 'horizontal';
    /** Plot-column X and boundary Y relative to the topology center. */
    readonly plotX: number;
    readonly boundaryY: number;
    readonly localKey: WildernessHorizontalJoinKey;
    /** Absolute key stays stable when this same edge is viewed from another center. */
    readonly worldKey: WildernessHorizontalJoinKey;
    readonly worldPlotX: number;
    readonly worldBoundaryY: number;
}

export interface WildernessJunctionJoin {
    readonly kind: 'junction';
    /** Plot-boundary intersection relative to the topology center. */
    readonly boundaryX: number;
    readonly boundaryY: number;
    readonly localKey: WildernessJunctionKey;
    /** Absolute key stays stable when this same junction is viewed from another center. */
    readonly worldKey: WildernessJunctionKey;
    readonly worldBoundaryX: number;
    readonly worldBoundaryY: number;
}

export interface WildernessTopology {
    readonly center: WildernessTopologyCoordinate;
    readonly radius: number;
    readonly verticalJoins: readonly WildernessVerticalJoin[];
    readonly horizontalJoins: readonly WildernessHorizontalJoin[];
    readonly junctionJoins: readonly WildernessJunctionJoin[];
    /** Every visible road-band intersection, including perimeter, all-road, and no-road forms. */
    readonly roadJunctions: readonly WildernessRoadJunction[];
    readonly roadJunctionByLocalKey: ReadonlyMap<WildernessRoadJunctionKey, WildernessRoadJunction>;
    readonly verticalJoinKeys: ReadonlySet<WildernessVerticalJoinKey>;
    readonly horizontalJoinKeys: ReadonlySet<WildernessHorizontalJoinKey>;
    readonly junctionJoinKeys: ReadonlySet<WildernessJunctionKey>;
    readonly wildLocalPlotKeys: ReadonlySet<string>;
    /** Cache key for the complete local join topology and its absolute anchor. */
    readonly signature: string;
}

export interface WildernessGapGeometry {
    readonly plotTiles: number;
    readonly plotGap: number;
}

export const DEFAULT_WILDERNESS_GAP_GEOMETRY: WildernessGapGeometry = Object.freeze({
    plotTiles: 25,
    plotGap: 2
});

export interface JoinedWildernessGapTap {
    readonly kind: 'vertical' | 'horizontal' | 'junction';
    readonly localKey: WildernessVerticalJoinKey | WildernessHorizontalJoinKey | WildernessJunctionKey;
    readonly adjacentLocalPlots: readonly WildernessTopologyCoordinate[];
    readonly adjacentWorldPlots: readonly WildernessTopologyCoordinate[];
    /** The nearest wilderness plot, with coordinate order breaking exact ties. */
    readonly selectedLocalPlot: WildernessTopologyCoordinate;
    readonly selectedWorldPlot: WildernessTopologyCoordinate;
}

type CellState = 'wild' | 'occupied';

const JUNCTION_CORNERS: ReadonlyArray<{
    quadrant: WildernessJunctionQuadrant;
    dx: number;
    dy: number;
    plotCorner: WildernessJunctionQuadrant;
}> = [
    { quadrant: 'nw', dx: -1, dy: -1, plotCorner: 'se' },
    { quadrant: 'ne', dx: 0, dy: -1, plotCorner: 'sw' },
    { quadrant: 'se', dx: 0, dy: 0, plotCorner: 'nw' },
    { quadrant: 'sw', dx: -1, dy: 0, plotCorner: 'ne' }
];

const localPlotKey = (x: number, y: number): string => `${x},${y}`;

export const wildernessVerticalJoinKey = (boundaryX: number, plotY: number): WildernessVerticalJoinKey =>
    `v:${boundaryX},${plotY}`;

export const wildernessHorizontalJoinKey = (plotX: number, boundaryY: number): WildernessHorizontalJoinKey =>
    `h:${plotX},${boundaryY}`;

export const wildernessJunctionKey = (boundaryX: number, boundaryY: number): WildernessJunctionKey =>
    `j:${boundaryX},${boundaryY}`;

export const wildernessRoadJunctionKey = (boundaryX: number, boundaryY: number): WildernessRoadJunctionKey =>
    `road-junction:${boundaryX},${boundaryY}`;

export const wildernessRoadBendKey = (
    boundaryX: number,
    boundaryY: number,
    innerCorner: WildernessJunctionQuadrant
): WildernessRoadBendKey => `road-bend:${boundaryX},${boundaryY}:${innerCorner}`;

export const wildernessRoadShoulderKey = (
    boundaryX: number,
    boundaryY: number,
    quadrant: WildernessJunctionQuadrant
): WildernessRoadShoulderKey => `road-shoulder:${boundaryX},${boundaryY}:${quadrant}`;

/** Total classification for all 16 arm masks, including future clipped/custom roads. */
export function roadJunctionShapeForArms(arms: WildernessRoadArms): WildernessRoadJunctionShape {
    const count = Number(arms.n) + Number(arms.e) + Number(arms.s) + Number(arms.w);
    if (count === 4) return 'cross';
    if (count === 3) return 't';
    if (count === 1) return 'dead';
    if (count === 0) return 'none';
    return (arms.n && arms.s) || (arms.e && arms.w) ? 'straight' : 'l';
}

function assertTopologyCoordinate(value: WildernessTopologyCoordinate) {
    if (!Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y)) {
        throw new RangeError('Wilderness topology center must use safe integer plot coordinates.');
    }
}

function assertTopologyRadius(radius: number) {
    if (!Number.isSafeInteger(radius) || radius < 0) {
        throw new RangeError('Wilderness topology radius must be a non-negative safe integer.');
    }
}

/**
 * Build the wilderness joins visible inside one map window.
 *
 * `empty` is wilderness whether it is settleable or protected. Player, bot,
 * malformed, conflicting, and missing records all retain roads. Normal map
 * windows treat their omitted local center as the live village/battlefield;
 * full-atlas callers may explicitly classify a supplied empty center as wild.
 */
export function buildWildernessTopology(
    center: WildernessTopologyCoordinate,
    radius: number,
    knownPlots: readonly WildernessTopologyPlot[],
    options: { readonly centerOccupied?: boolean } = {}
): WildernessTopology {
    assertTopologyCoordinate(center);
    assertTopologyRadius(radius);

    const cells = new Map<string, CellState>();
    for (const plot of knownPlots) {
        if (!Number.isSafeInteger(plot?.x) || !Number.isSafeInteger(plot?.y)) continue;
        const localX = plot.x - center.x;
        const localY = plot.y - center.y;
        if (Math.abs(localX) > radius || Math.abs(localY) > radius) continue;

        const next: CellState | null = plot.kind === 'empty'
            ? 'wild'
            : plot.kind === 'player' || plot.kind === 'bot'
                ? 'occupied'
                : null;
        if (next === null) continue;

        const key = localPlotKey(localX, localY);
        const previous = cells.get(key);
        // An occupied record wins a duplicate conflict. Rendering a road until
        // the next authoritative response is safer than joining through a base.
        cells.set(key, previous && previous !== next ? 'occupied' : next);
    }
    // Ordinary world-map windows omit the live center village, so it must
    // fail closed to occupied. Full-atlas/cinematic callers can supply the
    // center explicitly and opt out when it is genuine wilderness.
    if (options.centerOccupied !== false) cells.set(localPlotKey(0, 0), 'occupied');

    const isWild = (x: number, y: number): boolean => cells.get(localPlotKey(x, y)) === 'wild';
    const cellState = (x: number, y: number): WildernessJunctionCellState =>
        cells.get(localPlotKey(x, y)) ?? 'unknown';
    const roadRemains = (a: WildernessJunctionCellState, b: WildernessJunctionCellState): boolean =>
        a !== 'wild' || b !== 'wild';
    const verticalJoins: WildernessVerticalJoin[] = [];
    const horizontalJoins: WildernessHorizontalJoin[] = [];
    const junctionJoins: WildernessJunctionJoin[] = [];
    const roadJunctions: WildernessRoadJunction[] = [];

    // A vertical boundary at X=b separates columns b-1 and b for one plot row.
    for (let plotY = -radius; plotY <= radius; plotY++) {
        for (let boundaryX = -radius + 1; boundaryX <= radius; boundaryX++) {
            if (!isWild(boundaryX - 1, plotY) || !isWild(boundaryX, plotY)) continue;
            const worldBoundaryX = center.x + boundaryX;
            const worldPlotY = center.y + plotY;
            verticalJoins.push({
                kind: 'vertical',
                boundaryX,
                plotY,
                localKey: wildernessVerticalJoinKey(boundaryX, plotY),
                worldKey: wildernessVerticalJoinKey(worldBoundaryX, worldPlotY),
                worldBoundaryX,
                worldPlotY
            });
        }
    }

    // A horizontal boundary at Y=b separates rows b-1 and b for one plot column.
    for (let boundaryY = -radius + 1; boundaryY <= radius; boundaryY++) {
        for (let plotX = -radius; plotX <= radius; plotX++) {
            if (!isWild(plotX, boundaryY - 1) || !isWild(plotX, boundaryY)) continue;
            const worldPlotX = center.x + plotX;
            const worldBoundaryY = center.y + boundaryY;
            horizontalJoins.push({
                kind: 'horizontal',
                plotX,
                boundaryY,
                localKey: wildernessHorizontalJoinKey(plotX, boundaryY),
                worldKey: wildernessHorizontalJoinKey(worldPlotX, worldBoundaryY),
                worldPlotX,
                worldBoundaryY
            });
        }
    }

    // The crossing square becomes shared ground only when all four parcels are
    // known wilderness. The same pass records the surviving arms for soft road
    // corners; unknown corners deliberately retain both incident road arms.
    // Include the two perimeter boundaries as well as internal crossings. Their
    // outside cells are unknown, so they fail closed to roads under the fog.
    for (let boundaryY = -radius; boundaryY <= radius + 1; boundaryY++) {
        for (let boundaryX = -radius; boundaryX <= radius + 1; boundaryX++) {
            const worldBoundaryX = center.x + boundaryX;
            const worldBoundaryY = center.y + boundaryY;
            const cornerStates: Record<WildernessJunctionQuadrant, WildernessJunctionCellState> = {
                nw: cellState(boundaryX - 1, boundaryY - 1),
                ne: cellState(boundaryX, boundaryY - 1),
                se: cellState(boundaryX, boundaryY),
                sw: cellState(boundaryX - 1, boundaryY)
            };
            const arms: WildernessRoadArms = {
                n: roadRemains(cornerStates.nw, cornerStates.ne),
                e: roadRemains(cornerStates.ne, cornerStates.se),
                s: roadRemains(cornerStates.sw, cornerStates.se),
                w: roadRemains(cornerStates.nw, cornerStates.sw)
            };
            const armMask = Number(arms.n) | (Number(arms.e) << 1) | (Number(arms.s) << 2) | (Number(arms.w) << 3);
            const occupiedShoulders: WildernessOccupiedRoadShoulder[] = [];
            for (const corner of JUNCTION_CORNERS) {
                if (cornerStates[corner.quadrant] !== 'occupied') continue;
                const localPlot = { x: boundaryX + corner.dx, y: boundaryY + corner.dy };
                const worldPlot = { x: center.x + localPlot.x, y: center.y + localPlot.y };
                occupiedShoulders.push({
                    quadrant: corner.quadrant,
                    plotCorner: corner.plotCorner,
                    localPlot,
                    worldPlot,
                    localKey: wildernessRoadShoulderKey(boundaryX, boundaryY, corner.quadrant),
                    worldKey: wildernessRoadShoulderKey(worldBoundaryX, worldBoundaryY, corner.quadrant)
                });
            }
            roadJunctions.push({
                boundaryX,
                boundaryY,
                worldBoundaryX,
                worldBoundaryY,
                localKey: wildernessRoadJunctionKey(boundaryX, boundaryY),
                worldKey: wildernessRoadJunctionKey(worldBoundaryX, worldBoundaryY),
                arms,
                armMask,
                shape: roadJunctionShapeForArms(arms),
                cornerStates,
                occupiedShoulders
            });
            if (armMask === 0) {
                junctionJoins.push({
                    kind: 'junction',
                    boundaryX,
                    boundaryY,
                    localKey: wildernessJunctionKey(boundaryX, boundaryY),
                    worldKey: wildernessJunctionKey(worldBoundaryX, worldBoundaryY),
                    worldBoundaryX,
                    worldBoundaryY
                });
            }
        }
    }

    const verticalJoinKeys = new Set(verticalJoins.map(join => join.localKey));
    const horizontalJoinKeys = new Set(horizontalJoins.map(join => join.localKey));
    const junctionJoinKeys = new Set(junctionJoins.map(join => join.localKey));
    const roadJunctionByLocalKey = new Map(roadJunctions.map(junction => [junction.localKey, junction] as const));
    const wildLocalPlotKeys = new Set(
        [...cells.entries()]
            .filter(([, state]) => state === 'wild')
            .map(([key]) => key)
    );
    const signature = [
        'wilderness-topology-v2',
        `center=${center.x},${center.y}`,
        `radius=${radius}`,
        `vertical=${verticalJoins.map(join => join.worldKey).join(';')}`,
        `horizontal=${horizontalJoins.map(join => join.worldKey).join(';')}`,
        `junctions=${junctionJoins.map(join => join.worldKey).join(';')}`,
        `roads=${roadJunctions.map(junction => {
            const shoulders = junction.occupiedShoulders.map(shoulder => shoulder.quadrant).join('');
            return `${junction.worldKey}:${junction.armMask}:${shoulders}`;
        }).join(';')}`
    ].join('|');

    return {
        center: { x: center.x, y: center.y },
        radius,
        verticalJoins,
        horizontalJoins,
        junctionJoins,
        roadJunctions,
        roadJunctionByLocalKey,
        verticalJoinKeys,
        horizontalJoinKeys,
        junctionJoinKeys,
        wildLocalPlotKeys,
        signature
    };
}

export function isJoinedWildernessVerticalEdge(
    topology: WildernessTopology,
    boundaryX: number,
    plotY: number
): boolean {
    return topology.verticalJoinKeys.has(wildernessVerticalJoinKey(boundaryX, plotY));
}

export function isJoinedWildernessHorizontalEdge(
    topology: WildernessTopology,
    plotX: number,
    boundaryY: number
): boolean {
    return topology.horizontalJoinKeys.has(wildernessHorizontalJoinKey(plotX, boundaryY));
}

export function isJoinedWildernessJunction(
    topology: WildernessTopology,
    boundaryX: number,
    boundaryY: number
): boolean {
    return topology.junctionJoinKeys.has(wildernessJunctionKey(boundaryX, boundaryY));
}

export function wildernessRoadJunctionAt(
    topology: WildernessTopology,
    boundaryX: number,
    boundaryY: number
): WildernessRoadJunction | null {
    return topology.roadJunctionByLocalKey.get(wildernessRoadJunctionKey(boundaryX, boundaryY)) ?? null;
}

/**
 * Describe the two corners a soft L-road renderer should round. The inner
 * corner is the plot quadrant touched by both arms; the outer corner is its
 * diagonal opposite. Non-L junctions deliberately return null.
 */
export function roundedRoadBendFor(junction: WildernessRoadJunction): WildernessRoundedRoadBend | null {
    if (junction.shape !== 'l') return null;
    const arms = junction.arms;
    const innerCorner: WildernessJunctionQuadrant | null =
        arms.n && arms.e ? 'ne'
            : arms.e && arms.s ? 'se'
                : arms.s && arms.w ? 'sw'
                    : arms.w && arms.n ? 'nw'
                        : null;
    if (innerCorner === null) return null;
    const outerCorner: WildernessJunctionQuadrant = {
        nw: 'se',
        ne: 'sw',
        se: 'nw',
        sw: 'ne'
    }[innerCorner] as WildernessJunctionQuadrant;
    return {
        innerCorner,
        outerCorner,
        localKey: wildernessRoadBendKey(junction.boundaryX, junction.boundaryY, innerCorner),
        worldKey: wildernessRoadBendKey(junction.worldBoundaryX, junction.worldBoundaryY, innerCorner)
    };
}

/** Known occupied corners only; unknown cells retain roads but never invent a shoulder. */
export function occupiedRoadShouldersFor(
    junction: WildernessRoadJunction
): readonly WildernessOccupiedRoadShoulder[] {
    return junction.occupiedShoulders;
}

export function needsOccupiedRoadShoulder(
    junction: WildernessRoadJunction,
    quadrant: WildernessJunctionQuadrant
): boolean {
    return junction.cornerStates[quadrant] === 'occupied';
}

export function isKnownWildernessPlot(
    topology: WildernessTopology,
    localPlotX: number,
    localPlotY: number
): boolean {
    return topology.wildLocalPlotKeys.has(localPlotKey(localPlotX, localPlotY));
}

function nearestPlot(
    gridX: number,
    gridY: number,
    candidates: readonly WildernessTopologyCoordinate[],
    pitch: number,
    plotTiles: number
): WildernessTopologyCoordinate {
    let selected = candidates[0];
    let selectedDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        const centerX = candidate.x * pitch + plotTiles / 2;
        const centerY = candidate.y * pitch + plotTiles / 2;
        const distance = (gridX - centerX) ** 2 + (gridY - centerY) ** 2;
        if (distance < selectedDistance
            || (distance === selectedDistance
                && (candidate.x < selected.x || (candidate.x === selected.x && candidate.y < selected.y)))) {
            selected = candidate;
            selectedDistance = distance;
        }
    }
    return { x: selected.x, y: selected.y };
}

/**
 * Resolve a tap on a road-gap coordinate only when that gap was replaced by a
 * wilderness join. Active roads and taps inside plot footprints return null.
 * `gridX/gridY` use the same center-relative tile coordinates as WorldMapSystem.
 */
export function classifyJoinedWildernessGapTap(
    topology: WildernessTopology,
    gridX: number,
    gridY: number,
    geometry: WildernessGapGeometry = DEFAULT_WILDERNESS_GAP_GEOMETRY
): JoinedWildernessGapTap | null {
    if (!Number.isFinite(gridX) || !Number.isFinite(gridY)) return null;
    if (!Number.isFinite(geometry.plotTiles) || geometry.plotTiles <= 0
        || !Number.isFinite(geometry.plotGap) || geometry.plotGap <= 0) {
        throw new RangeError('Wilderness gap geometry requires positive finite plotTiles and plotGap.');
    }

    const pitch = geometry.plotTiles + geometry.plotGap;
    const cellX = Math.floor(gridX / pitch);
    const cellY = Math.floor(gridY / pitch);
    const withinCellX = gridX - cellX * pitch;
    const withinCellY = gridY - cellY * pitch;
    const inVerticalGap = withinCellX >= geometry.plotTiles;
    const inHorizontalGap = withinCellY >= geometry.plotTiles;
    if (!inVerticalGap && !inHorizontalGap) return null;

    let kind: JoinedWildernessGapTap['kind'];
    let localKey: JoinedWildernessGapTap['localKey'];
    let candidates: WildernessTopologyCoordinate[];
    if (inVerticalGap && inHorizontalGap) {
        kind = 'junction';
        localKey = wildernessJunctionKey(cellX + 1, cellY + 1);
        if (!topology.junctionJoinKeys.has(localKey)) return null;
        candidates = [
            { x: cellX, y: cellY },
            { x: cellX + 1, y: cellY },
            { x: cellX, y: cellY + 1 },
            { x: cellX + 1, y: cellY + 1 }
        ];
    } else if (inVerticalGap) {
        kind = 'vertical';
        localKey = wildernessVerticalJoinKey(cellX + 1, cellY);
        if (!topology.verticalJoinKeys.has(localKey)) return null;
        candidates = [
            { x: cellX, y: cellY },
            { x: cellX + 1, y: cellY }
        ];
    } else {
        kind = 'horizontal';
        localKey = wildernessHorizontalJoinKey(cellX, cellY + 1);
        if (!topology.horizontalJoinKeys.has(localKey)) return null;
        candidates = [
            { x: cellX, y: cellY },
            { x: cellX, y: cellY + 1 }
        ];
    }

    const selectedLocalPlot = nearestPlot(gridX, gridY, candidates, pitch, geometry.plotTiles);
    const toWorld = (plot: WildernessTopologyCoordinate): WildernessTopologyCoordinate => ({
        x: topology.center.x + plot.x,
        y: topology.center.y + plot.y
    });
    return {
        kind,
        localKey,
        adjacentLocalPlots: candidates.map(plot => ({ x: plot.x, y: plot.y })),
        adjacentWorldPlots: candidates.map(toWorld),
        selectedLocalPlot,
        selectedWorldPlot: toWorld(selectedLocalPlot)
    };
}
