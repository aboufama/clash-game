import {
    contourContains,
    fbmNoise2D,
    generateLakeTerrain,
    generateWaterBodyContours,
    mixTerrainSeed,
    type LakeBand,
    type LakeContours,
    type LakeTerrain,
    type TerrainBounds,
    type TerrainPoint
} from '../renderers/WildernessTerrain';

/**
 * Pure world-scale hydrology index.
 *
 * Rare Great Lakes are owned by bounded macro-cells in plot coordinates, but
 * their terrain is generated directly in absolute world-tile coordinates.
 * Every plot/window therefore queries the same cached feature and clips the
 * same contour instead of independently inventing a shoreline at its edge.
 */

export const HYDROLOGY_PLOT_TILES = 25;
export const HYDROLOGY_PLOT_GAP = 2;
export const HYDROLOGY_PLOT_PITCH = HYDROLOGY_PLOT_TILES + HYDROLOGY_PLOT_GAP;
export const HYDROLOGY_MACRO_PLOTS = 12;
export const HYDROLOGY_STARTER_SAFE_RADIUS = 4;

const WORLD_SEED = 0x4c414b45; // "LAKE"
const WORLD_SEED_EPOCH_STEP = 0x9e3779b9;
const MAX_WORLD_PLOT_COORDINATE = 1_000_000;
const MAX_QUERY_SPAN_PLOTS = 64;
const MAX_QUERY_MACRO_CELLS = 64;
const MACRO_CACHE_LIMIT = 192;
const SHOWCASE_MACRO_X = 2;
const SHOWCASE_MACRO_Y = -2;
const OWNER_VISTA_MACRO_X = -1;
const OWNER_VISTA_MACRO_Y = -1;
const OWNER_SAFE_PLOTS: ReadonlyArray<PlotCoordinate> = Object.freeze([
    Object.freeze({ x: -5, y: -7 }),
    Object.freeze({ x: -5, y: -8 })
]);
const TAU = Math.PI * 2;

export interface PlotCoordinate {
    x: number;
    y: number;
}

export interface PlotWindow {
    minPlotX: number;
    minPlotY: number;
    maxPlotX: number;
    maxPlotY: number;
}

/** The current owner's earned 5x5 horizon; kept scenic but home-safe. */
export const HYDROLOGY_OWNER_VISTA_WINDOW: Readonly<PlotWindow> = Object.freeze({
    minPlotX: -7,
    minPlotY: -9,
    maxPlotX: -3,
    maxPlotY: -5
});

export type RiverNodeKind = 'source' | 'inlet' | 'outlet' | 'rapid' | 'sink';
export type RiverReachKind = 'stream' | 'lake-passage' | 'outflow' | 'rapids';

export interface RiverNode {
    readonly id: string;
    readonly kind: RiverNodeKind;
    readonly point: TerrainPoint;
}

export interface RiverReach {
    readonly id: string;
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly kind: RiverReachKind;
    readonly width: number;
    /** Relative current speed: ~0.1 lake passage, ~0.55 stream, >1.3 whitewater. */
    readonly speed: number;
    /** Half-width at each point of `points` — mouth flares included, so the
     *  field carving the channel and every renderer share ONE width model. */
    readonly halfWidths: readonly number[];
    readonly points: readonly TerrainPoint[];
}

export interface HydrologyNetwork {
    readonly sourceNodeId: string;
    readonly sinkNodeId: string;
    readonly nodes: readonly RiverNode[];
    readonly reaches: readonly RiverReach[];
}

export interface HydrologyPlotCoverage extends PlotCoordinate {
    readonly lake: boolean;
    readonly river: boolean;
}

export interface GreatLakeFeature {
    readonly id: string;
    readonly kind: 'great-lake';
    readonly label: string;
    readonly seed: number;
    readonly macroCell: PlotCoordinate;
    readonly requestedSpanPlots: Readonly<{ x: number; y: number }>;
    /** Absolute world-tile geometry shared by every intersecting plot. */
    readonly terrain: LakeTerrain;
    /** ONE continuous border for the whole water system (lake + joined
     *  rivers) with interior depth bands, extracted from a combined field —
     *  the renderer fills these instead of stitching shapes at the mouths.
     *  Null when the field degenerates; renderers then fall back per-shape. */
    readonly waterBody: LakeContours | null;
    readonly network: HydrologyNetwork;
    readonly worldBounds: TerrainBounds;
    readonly protectedPlots: readonly HydrologyPlotCoverage[];
}

export interface HydrologyPlotFeatureClassification {
    readonly id: string;
    readonly label: string;
    readonly kind: 'great-lake';
    readonly lake: boolean;
    readonly river: boolean;
}

export interface HydrologyPlotClassification {
    readonly protected: boolean;
    readonly features: readonly HydrologyPlotFeatureClassification[];
}

export interface AnchoredHydrologyFeature {
    readonly id: string;
    readonly label: string;
    readonly seed: number;
    readonly anchorPlot: PlotCoordinate;
    readonly anchorWorldTile: TerrainPoint;
    /** Feature contours relative to anchorWorldTile. */
    readonly contours: LakeContours;
    readonly network: HydrologyNetwork;
    contains(localX: number, localY: number, band?: LakeBand): boolean;
    sampleDepth(localX: number, localY: number): number;
}

interface GreatLakePlacement {
    centerX: number;
    centerY: number;
    spanX: number;
    spanY: number;
    flowAngle?: number;
}

const macroCache = new Map<string, GreatLakeFeature | null>();

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function assertPlotCoordinate(value: number, name: string): void {
    if (!Number.isInteger(value) || Math.abs(value) > MAX_WORLD_PLOT_COORDINATE) {
        throw new Error(`${name} must be an integer within +/-${MAX_WORLD_PLOT_COORDINATE}.`);
    }
}

function normalizeSeedVersion(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < 0) return 0;
    return Math.min(0xffff_ffff, numeric);
}

function macroKey(x: number, y: number, seedVersion: number): string {
    return `${seedVersion}:${x},${y}`;
}

function macroSeed(x: number, y: number, seedVersion: number): number {
    // Epoch zero is the shipped world and must remain byte-for-byte stable for
    // production saves. Development reseeds rotate the root seed itself, so
    // lake presence, position, contour, river graph and shore all regenerate.
    const worldSeed = seedVersion === 0
        ? WORLD_SEED
        : mixTerrainSeed(WORLD_SEED ^ Math.imul(seedVersion, WORLD_SEED_EPOCH_STEP));
    return mixTerrainSeed(
        worldSeed
        ^ Math.imul(x | 0, 0x1f123bb5)
        ^ Math.imul(y | 0, 0x5f356495)
    );
}

function makeRandom(seed: number): () => number {
    let state = mixTerrainSeed(seed);
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function freezePoint(point: TerrainPoint): TerrainPoint {
    return Object.freeze({ x: point.x, y: point.y });
}

function freezeContour(points: readonly TerrainPoint[]): readonly TerrainPoint[] {
    return Object.freeze(points.map(freezePoint));
}

function freezeContours(contours: LakeContours): LakeContours {
    return Object.freeze({
        bank: freezeContour(contours.bank),
        water: freezeContour(contours.water),
        mid: freezeContour(contours.mid),
        deep: freezeContour(contours.deep)
    });
}

function freezeTerrain(terrain: LakeTerrain): LakeTerrain {
    return Object.freeze({
        ...terrain,
        center: freezePoint(terrain.center),
        bounds: Object.freeze({ ...terrain.bounds }),
        contours: freezeContours(terrain.contours)
    });
}

function freezeNetwork(network: HydrologyNetwork): HydrologyNetwork {
    return Object.freeze({
        sourceNodeId: network.sourceNodeId,
        sinkNodeId: network.sinkNodeId,
        nodes: Object.freeze(network.nodes.map(node => Object.freeze({
            ...node,
            point: freezePoint(node.point)
        }))),
        reaches: Object.freeze(network.reaches.map(reach => Object.freeze({
            ...reach,
            halfWidths: Object.freeze([...reach.halfWidths]),
            points: freezeContour(reach.points)
        })))
    });
}

function isSafetyPlot(x: number, y: number): boolean {
    if (OWNER_SAFE_PLOTS.some(plot => plot.x === x && plot.y === y)) return true;
    return Math.max(Math.abs(x), Math.abs(y)) <= HYDROLOGY_STARTER_SAFE_RADIUS;
}

function pointInBounds(point: TerrainPoint, bounds: TerrainBounds): boolean {
    return point.x >= bounds.minX && point.x <= bounds.maxX
        && point.y >= bounds.minY && point.y <= bounds.maxY;
}

function boundsIntersect(a: TerrainBounds, b: TerrainBounds): boolean {
    return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
}

function orientation(a: TerrainPoint, b: TerrainPoint, c: TerrainPoint): number {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: TerrainPoint, a: TerrainPoint, b: TerrainPoint): boolean {
    if (Math.abs(orientation(a, b, point)) > 1e-8) return false;
    return point.x >= Math.min(a.x, b.x) - 1e-8 && point.x <= Math.max(a.x, b.x) + 1e-8
        && point.y >= Math.min(a.y, b.y) - 1e-8 && point.y <= Math.max(a.y, b.y) + 1e-8;
}

function lineSegmentsIntersect(a: TerrainPoint, b: TerrainPoint, c: TerrainPoint, d: TerrainPoint): boolean {
    const abC = orientation(a, b, c);
    const abD = orientation(a, b, d);
    const cdA = orientation(c, d, a);
    const cdB = orientation(c, d, b);
    if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
        && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
    return (Math.abs(abC) <= 1e-8 && pointOnSegment(c, a, b))
        || (Math.abs(abD) <= 1e-8 && pointOnSegment(d, a, b))
        || (Math.abs(cdA) <= 1e-8 && pointOnSegment(a, c, d))
        || (Math.abs(cdB) <= 1e-8 && pointOnSegment(b, c, d));
}

function polygonIntersectsBounds(points: readonly TerrainPoint[], bounds: TerrainBounds): boolean {
    if (points.some(point => pointInBounds(point, bounds))) return true;
    const corners = [
        { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY }
    ];
    if (corners.some(point => contourContains(points, point.x, point.y))) return true;
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        for (let edge = 0; edge < corners.length; edge++) {
            if (lineSegmentsIntersect(a, b, corners[edge], corners[(edge + 1) % corners.length])) return true;
        }
    }
    return false;
}

function polylineIntersectsBounds(points: readonly TerrainPoint[], bounds: TerrainBounds, width: number): boolean {
    const expanded = {
        minX: bounds.minX - width * 0.5,
        minY: bounds.minY - width * 0.5,
        maxX: bounds.maxX + width * 0.5,
        maxY: bounds.maxY + width * 0.5
    };
    if (points.some(point => pointInBounds(point, expanded))) return true;
    const corners = [
        { x: expanded.minX, y: expanded.minY }, { x: expanded.maxX, y: expanded.minY },
        { x: expanded.maxX, y: expanded.maxY }, { x: expanded.minX, y: expanded.maxY }
    ];
    for (let i = 0; i + 1 < points.length; i++) {
        for (let edge = 0; edge < corners.length; edge++) {
            if (lineSegmentsIntersect(points[i], points[i + 1], corners[edge], corners[(edge + 1) % corners.length])) return true;
        }
    }
    return false;
}

function contourBounds(points: readonly TerrainPoint[]): TerrainBounds {
    return {
        minX: Math.min(...points.map(point => point.x)),
        minY: Math.min(...points.map(point => point.y)),
        maxX: Math.max(...points.map(point => point.x)),
        maxY: Math.max(...points.map(point => point.y))
    };
}

function unionBounds(a: TerrainBounds, b: TerrainBounds): TerrainBounds {
    return {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY)
    };
}

function polylineBounds(points: readonly TerrainPoint[], width: number): TerrainBounds {
    const half = width * 0.5;
    return {
        minX: Math.min(...points.map(point => point.x)) - half,
        minY: Math.min(...points.map(point => point.y)) - half,
        maxX: Math.max(...points.map(point => point.x)) + half,
        maxY: Math.max(...points.map(point => point.y)) + half
    };
}

function shorelineExtreme(
    shore: readonly TerrainPoint[],
    center: TerrainPoint,
    directionX: number,
    directionY: number
): TerrainPoint {
    let result = shore[0];
    let best = Number.NEGATIVE_INFINITY;
    for (const point of shore) {
        const projection = (point.x - center.x) * directionX + (point.y - center.y) * directionY;
        if (projection > best) {
            best = projection;
            result = point;
        }
    }
    return { ...result };
}

function outwardPoint(
    shore: TerrainPoint,
    center: TerrainPoint,
    distance: number,
    clampBounds: TerrainBounds
): TerrainPoint {
    const dx = shore.x - center.x;
    const dy = shore.y - center.y;
    const length = Math.max(0.001, Math.hypot(dx, dy));
    return {
        x: clamp(shore.x + dx / length * distance, clampBounds.minX + 1, clampBounds.maxX - 1),
        y: clamp(shore.y + dy / length * distance, clampBounds.minY + 1, clampBounds.maxY - 1)
    };
}

function meanderPath(
    start: TerrainPoint,
    end: TerrainPoint,
    seed: number,
    amplitude: number,
    segments = 7
): readonly TerrainPoint[] {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(0.001, Math.hypot(dx, dy));
    const nx = -dy / length;
    const ny = dx / length;
    const points: TerrainPoint[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const envelope = Math.sin(Math.PI * t);
        const noise = fbmNoise2D(t * 3.1 + 7.3, seed * 0.00001 - 2.7, seed, 3);
        const offset = noise * amplitude * envelope;
        points.push({
            x: start.x + dx * t + nx * offset,
            y: start.y + dy * t + ny * offset
        });
    }
    return points;
}

/** One open-polyline Chaikin pass; the endpoints stay pinned. */
function chaikinOpen(points: readonly TerrainPoint[]): TerrainPoint[] {
    if (points.length < 3) return points.map(point => ({ ...point }));
    const out: TerrainPoint[] = [{ ...points[0] }];
    for (let index = 0; index + 1 < points.length; index++) {
        const a = points[index];
        const b = points[index + 1];
        out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push({ ...points[points.length - 1] });
    return out;
}

/** How wide a reach runs at each end, relative to its nominal width. A river
 *  meets the lake as a trumpet, not a hose: the mouth flares open. */
function nodeWidthScale(kind: RiverNodeKind): number {
    if (kind === 'source') return 0.48;
    if (kind === 'inlet' || kind === 'outlet') return 1.45;
    if (kind === 'rapid') return 1.12;
    if (kind === 'sink') return 1.42;
    return 1;
}

function buildNetwork(
    id: string,
    seed: number,
    terrain: LakeTerrain,
    macroBounds: TerrainBounds,
    random: () => number,
    flowAngleOverride?: number
): HydrologyNetwork {
    const sampledFlowAngle = random() * TAU;
    const flowAngle = flowAngleOverride ?? sampledFlowAngle;
    const flowX = Math.cos(flowAngle);
    const flowY = Math.sin(flowAngle);
    const inlet = shorelineExtreme(terrain.contours.water, terrain.center, -flowX, -flowY);
    const outlet = shorelineExtreme(terrain.contours.water, terrain.center, flowX, flowY);
    const source = outwardPoint(inlet, terrain.center, 8 + random() * 7, macroBounds);
    const sink = outwardPoint(outlet, terrain.center, 12 + random() * 9, macroBounds);
    const rapid = { x: outlet.x + (sink.x - outlet.x) * 0.48, y: outlet.y + (sink.y - outlet.y) * 0.48 };
    const node = (suffix: string, kind: RiverNodeKind, point: TerrainPoint): RiverNode => ({
        id: `${id}:${suffix}`,
        kind,
        point
    });
    const nodes = [
        node('source', 'source', source),
        node('inlet', 'inlet', inlet),
        node('outlet', 'outlet', outlet),
        node('rapid', 'rapid', rapid),
        node('sink', 'sink', sink)
    ];
    const kindOf = new Map(nodes.map(entry => [entry.id, entry.kind] as const));
    const reach = (
        suffix: string,
        fromNodeId: string,
        toNodeId: string,
        kind: RiverReachKind,
        width: number,
        speed: number,
        rawPoints: readonly TerrainPoint[]
    ): RiverReach => {
        // A smoothed centerline (the meander has few segments) plus the
        // trumpet width profile give every consumer one continuous channel.
        const points = kind === 'lake-passage' ? [...rawPoints] : chaikinOpen(chaikinOpen(rawPoints));
        const startScale = nodeWidthScale(kindOf.get(fromNodeId) ?? 'rapid');
        const endScale = nodeWidthScale(kindOf.get(toNodeId) ?? 'rapid');
        const halfWidths = points.map((_, index) => {
            const t = points.length <= 1 ? 0 : index / (points.length - 1);
            const eased = t * t * (3 - 2 * t);
            return width * (startScale + (endScale - startScale) * eased) * 0.5;
        });
        return { id: `${id}:${suffix}`, fromNodeId, toNodeId, kind, width, speed, halfWidths, points };
    };
    return {
        sourceNodeId: nodes[0].id,
        sinkNodeId: nodes[4].id,
        nodes,
        reaches: [
            reach('upper-stream', nodes[0].id, nodes[1].id, 'stream', 1.45, 0.55,
                meanderPath(source, inlet, seed ^ 0x3c6ef372, 2.3)),
            reach('lake-passage', nodes[1].id, nodes[2].id, 'lake-passage', 0, 0.1,
                [inlet, terrain.center, outlet]),
            reach('outflow', nodes[2].id, nodes[3].id, 'outflow', 1.9, 0.95,
                meanderPath(outlet, rapid, seed ^ 0xa54ff53a, 1.7, 5)),
            reach('rapids', nodes[3].id, nodes[4].id, 'rapids', 2.35, 1.65,
                meanderPath(rapid, sink, seed ^ 0x510e527f, 1.25, 5))
        ]
    };
}

/**
 * The owner's junction rule: ONE border equation for the whole water system.
 * Lake basin depth and carved river channels join in a single smooth-blended
 * field; the border and every interior band are contoured from that field,
 * so a river leaves its lake through one continuous shoreline — there is no
 * seam to stitch and nothing to patch over.
 */
function buildWaterBody(
    terrain: LakeTerrain,
    network: HydrologyNetwork,
    worldBounds: TerrainBounds
): LakeContours | null {
    // The sink pool (r 3) plus the shore ring (1.35) can reach ~4.5 tiles
    // past worldBounds; a smaller margin lets the bank mask touch the field
    // boundary, whose clamped contour degenerates into the box fallback —
    // rendered as a giant mineral slab around the whole system.
    const margin = 6.5;
    const bounds = {
        minX: worldBounds.minX - margin,
        minY: worldBounds.minY - margin,
        maxX: worldBounds.maxX + margin,
        maxY: worldBounds.maxY + margin
    };
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    const sampleStep = clamp(span / 150, 0.35, 0.8);
    interface ChannelSegment {
        ax: number; ay: number; bx: number; by: number;
        aw: number; bw: number; depth: number;
    }
    const segments: ChannelSegment[] = [];
    const pools: Array<{ x: number; y: number; radius: number; depth: number }> = [];
    for (const reach of network.reaches) {
        if (reach.kind === 'lake-passage' || reach.width <= 0) continue;
        const channelDepth = Math.min(0.5, 0.26 + reach.width * 0.09);
        for (let index = 0; index + 1 < reach.points.length; index++) {
            segments.push({
                ax: reach.points[index].x, ay: reach.points[index].y,
                bx: reach.points[index + 1].x, by: reach.points[index + 1].y,
                aw: reach.halfWidths[index], bw: reach.halfWidths[index + 1],
                depth: channelDepth
            });
        }
    }
    for (const node of network.nodes) {
        if (node.kind === 'source') pools.push({ x: node.point.x, y: node.point.y, radius: 1.7, depth: 0.3 });
        if (node.kind === 'sink') pools.push({ x: node.point.x, y: node.point.y, radius: 3, depth: 0.34 });
    }
    const smoothMax = (a: number, b: number, k: number): number => {
        const h = clamp(0.5 + 0.5 * (a - b) / k, 0, 1);
        return a * h + b * (1 - h) + k * h * (1 - h);
    };
    const riverDepthAt = (x: number, y: number): number => {
        let best = 0;
        for (const segment of segments) {
            const dx = segment.bx - segment.ax;
            const dy = segment.by - segment.ay;
            const dd = dx * dx + dy * dy;
            const t = dd <= 1e-9 ? 0 : clamp(((x - segment.ax) * dx + (y - segment.ay) * dy) / dd, 0, 1);
            const half = segment.aw + (segment.bw - segment.aw) * t;
            const distance = Math.hypot(x - (segment.ax + dx * t), y - (segment.ay + dy * t));
            if (distance >= half) continue;
            const r = distance / Math.max(0.001, half);
            const depth = segment.depth * (1 - r * r);
            if (depth > best) best = depth;
        }
        return best;
    };
    const lakeBox = terrain.bounds;
    const lakeDepthAt = (x: number, y: number): number =>
        (x < lakeBox.minX || x > lakeBox.maxX || y < lakeBox.minY || y > lakeBox.maxY) ? 0 : terrain.sampleDepth(x, y);
    const depthAt = (x: number, y: number): number => {
        let depth = smoothMax(lakeDepthAt(x, y), riverDepthAt(x, y), 0.16);
        for (const pool of pools) {
            const r = Math.hypot(x - pool.x, y - pool.y) / pool.radius;
            if (r < 1) depth = smoothMax(depth, pool.depth * (1 - r * r), 0.16);
        }
        return depth;
    };
    try {
        return generateWaterBodyContours({
            bounds,
            sampleStep,
            depthAt,
            anchor: terrain.center,
            bankWidth: 1.35,
            smoothingPasses: 1
        });
    } catch {
        // A degenerate field (pathological seed) falls back to per-shape
        // rendering rather than failing the whole feature.
        return null;
    }
}

function buildCoverage(
    terrain: LakeTerrain,
    network: HydrologyNetwork,
    worldBounds: TerrainBounds
): HydrologyPlotCoverage[] {
    const minPlotX = Math.floor(worldBounds.minX / HYDROLOGY_PLOT_PITCH);
    const minPlotY = Math.floor(worldBounds.minY / HYDROLOGY_PLOT_PITCH);
    const maxPlotX = Math.floor(worldBounds.maxX / HYDROLOGY_PLOT_PITCH);
    const maxPlotY = Math.floor(worldBounds.maxY / HYDROLOGY_PLOT_PITCH);
    const width = maxPlotX - minPlotX + 1;
    const height = maxPlotY - minPlotY + 1;
    if (width > 10 || height > 10) throw new Error('Hydrology feature exceeds its 10x10 plot coverage safety bound.');
    const result: HydrologyPlotCoverage[] = [];
    for (let plotY = minPlotY; plotY <= maxPlotY; plotY++) {
        for (let plotX = minPlotX; plotX <= maxPlotX; plotX++) {
            const bounds = {
                minX: plotX * HYDROLOGY_PLOT_PITCH,
                minY: plotY * HYDROLOGY_PLOT_PITCH,
                maxX: (plotX + 1) * HYDROLOGY_PLOT_PITCH,
                maxY: (plotY + 1) * HYDROLOGY_PLOT_PITCH
            };
            const lake = polygonIntersectsBounds(terrain.contours.bank, bounds);
            const river = network.reaches.some(reach => reach.kind !== 'lake-passage'
                && polylineIntersectsBounds(reach.points, bounds, reach.width));
            if (lake || river) result.push({ x: plotX, y: plotY, lake, river });
        }
    }
    return result.sort((a, b) => a.y - b.y || a.x - b.x);
}

const NAME_HEADS = ['Alder', 'Azure', 'Bracken', 'Cinder', 'Elder', 'Frost', 'Heron', 'Iron', 'Juniper', 'Moon', 'Otter', 'Storm'];
const NAME_TAILS = ['deep', 'glass', 'mere', 'reach', 'rest', 'water', 'wake', 'hollow', 'mirror', 'basin'];

function featureLabel(seed: number): string {
    const head = NAME_HEADS[seed % NAME_HEADS.length];
    const tail = NAME_TAILS[Math.floor(seed / 31) % NAME_TAILS.length];
    return `Lake ${head}${tail}`;
}

function buildGreatLake(
    macroX: number,
    macroY: number,
    seed: number,
    placement?: GreatLakePlacement
): GreatLakeFeature | null {
    const random = makeRandom(seed ^ 0xbb67ae85);
    const sampledSpanX = 2 + Math.floor(random() * 3);
    const sampledSpanY = 2 + Math.floor(random() * 3);
    const spanX = placement?.spanX ?? sampledSpanX;
    const spanY = placement?.spanY ?? sampledSpanY;
    const macroWorldMinX = macroX * HYDROLOGY_MACRO_PLOTS * HYDROLOGY_PLOT_PITCH;
    const macroWorldMinY = macroY * HYDROLOGY_MACRO_PLOTS * HYDROLOGY_PLOT_PITCH;
    const macroWorldMaxX = macroWorldMinX + HYDROLOGY_MACRO_PLOTS * HYDROLOGY_PLOT_PITCH;
    const macroWorldMaxY = macroWorldMinY + HYDROLOGY_MACRO_PLOTS * HYDROLOGY_PLOT_PITCH;
    const macroBounds = {
        minX: macroWorldMinX,
        minY: macroWorldMinY,
        maxX: macroWorldMaxX,
        maxY: macroWorldMaxY
    };
    const sampledCenterX = macroWorldMinX + (3.2 + random() * 5.6) * HYDROLOGY_PLOT_PITCH;
    const sampledCenterY = macroWorldMinY + (3.2 + random() * 5.6) * HYDROLOGY_PLOT_PITCH;
    const centerX = placement?.centerX ?? sampledCenterX;
    const centerY = placement?.centerY ?? sampledCenterY;
    const radiusX = spanX * HYDROLOGY_PLOT_PITCH * 0.48;
    const radiusY = spanY * HYDROLOGY_PLOT_PITCH * 0.48;
    const extent = Math.max(radiusX, radiusY) * 1.18 + 0.8;
    const terrainBounds = {
        minX: centerX - extent,
        minY: centerY - extent,
        maxX: centerX + extent,
        maxY: centerY + extent
    };
    if (!boundsIntersect(terrainBounds, macroBounds)
        || terrainBounds.minX < macroBounds.minX || terrainBounds.maxX > macroBounds.maxX
        || terrainBounds.minY < macroBounds.minY || terrainBounds.maxY > macroBounds.maxY) return null;

    const id = `great-lake:${macroX}:${macroY}:${seed.toString(16).padStart(8, '0')}`;
    const terrain = freezeTerrain(generateLakeTerrain({
        seed: mixTerrainSeed(seed ^ 0x6a09e667),
        centerX,
        centerY,
        radiusX,
        radiusY,
        bounds: terrainBounds,
        sampleStep: 0.8,
        lobeCount: 5 + (seed & 1),
        bankWidth: 1.35,
        smoothingPasses: 1
    }));
    const network = freezeNetwork(buildNetwork(id, seed, terrain, macroBounds, random, placement?.flowAngle));
    let worldBounds = contourBounds(terrain.contours.bank);
    for (const reach of network.reaches) {
        if (reach.kind !== 'lake-passage') worldBounds = unionBounds(worldBounds, polylineBounds(reach.points, reach.width));
    }
    if (worldBounds.minX < macroBounds.minX || worldBounds.maxX > macroBounds.maxX
        || worldBounds.minY < macroBounds.minY || worldBounds.maxY > macroBounds.maxY) return null;
    const protectedPlots = buildCoverage(terrain, network, worldBounds);
    if (protectedPlots.length < 4 || protectedPlots.some(plot => isSafetyPlot(plot.x, plot.y))) return null;
    const waterBody = buildWaterBody(terrain, network, worldBounds);

    return Object.freeze({
        id,
        kind: 'great-lake' as const,
        label: featureLabel(seed),
        seed,
        macroCell: Object.freeze({ x: macroX, y: macroY }),
        requestedSpanPlots: Object.freeze({ x: spanX, y: spanY }),
        terrain,
        waterBody: waterBody ? freezeContours(waterBody) : null,
        network,
        worldBounds: Object.freeze({ ...worldBounds }),
        protectedPlots: Object.freeze(protectedPlots.map(plot => Object.freeze({ ...plot })))
    });
}

function buildOwnerVistaGreatLake(macroX: number, macroY: number, seed: number): GreatLakeFeature | null {
    const placements: readonly GreatLakePlacement[] = [
        // Plot-space centers are deliberately west/northwest of both possible
        // owner homes. A vertical drainage axis keeps source and rapids in the
        // same scenic strip instead of pointing toward either base.
        { centerX: -6.5 * HYDROLOGY_PLOT_PITCH, centerY: -8.5 * HYDROLOGY_PLOT_PITCH, spanX: 2, spanY: 2, flowAngle: Math.PI * 0.5 },
        { centerX: -6.6 * HYDROLOGY_PLOT_PITCH, centerY: -8.4 * HYDROLOGY_PLOT_PITCH, spanX: 2, spanY: 2, flowAngle: Math.PI * 0.5 },
        { centerX: -6.7 * HYDROLOGY_PLOT_PITCH, centerY: -8.3 * HYDROLOGY_PLOT_PITCH, spanX: 2, spanY: 2, flowAngle: Math.PI * 0.5 }
    ];
    const currentOwner = OWNER_SAFE_PLOTS[0];
    for (let attempt = 0; attempt < placements.length; attempt++) {
        const attemptSeed = mixTerrainSeed(seed ^ Math.imul(attempt + 1, 0x9e3779b9));
        const feature = buildGreatLake(macroX, macroY, attemptSeed, placements[attempt]);
        if (!feature) continue;
        const visible = feature.protectedPlots.filter(plot =>
            plot.x >= HYDROLOGY_OWNER_VISTA_WINDOW.minPlotX
            && plot.x <= HYDROLOGY_OWNER_VISTA_WINDOW.maxPlotX
            && plot.y >= HYDROLOGY_OWNER_VISTA_WINDOW.minPlotY
            && plot.y <= HYDROLOGY_OWNER_VISTA_WINDOW.maxPlotY);
        const visibleKeys = new Set(visible.map(plot => `${plot.x},${plot.y}`));
        const hasAdjacentPair = visible.some(plot =>
            visibleKeys.has(`${plot.x + 1},${plot.y}`) || visibleKeys.has(`${plot.x},${plot.y + 1}`));
        const visibleNearby = visible.some(plot =>
            Math.max(Math.abs(plot.x - currentOwner.x), Math.abs(plot.y - currentOwner.y)) <= 2);
        if (visible.length >= 4 && visible.filter(plot => plot.lake).length >= 4 && hasAdjacentPair && visibleNearby) return feature;
    }
    return null;
}

function cacheMacro(key: string, value: GreatLakeFeature | null): void {
    if (macroCache.size >= MACRO_CACHE_LIMIT && !macroCache.has(key)) {
        const oldest = macroCache.keys().next().value as string | undefined;
        if (oldest !== undefined) macroCache.delete(oldest);
    }
    macroCache.set(key, value);
}

/** Deterministic candidate for one bounded macro-cell, or null for dry land. */
export function greatLakeForMacroCell(
    macroX: number,
    macroY: number,
    rawSeedVersion: unknown = 0
): GreatLakeFeature | null {
    assertPlotCoordinate(macroX, 'macroX');
    assertPlotCoordinate(macroY, 'macroY');
    const seedVersion = normalizeSeedVersion(rawSeedVersion);
    const key = macroKey(macroX, macroY, seedVersion);
    const cached = macroCache.get(key);
    if (cached !== undefined || macroCache.has(key)) return cached ?? null;
    const seed = macroSeed(macroX, macroY, seedVersion);
    // The authored showcase and owner vista are compatibility fixtures for the
    // original world only. Keeping either anchor in later epochs made a reseed
    // visibly retain the same huge lake and river beside the player's home.
    const guaranteedShowcase = seedVersion === 0
        && macroX === SHOWCASE_MACRO_X && macroY === SHOWCASE_MACRO_Y;
    const guaranteedOwnerVista = seedVersion === 0
        && macroX === OWNER_VISTA_MACRO_X && macroY === OWNER_VISTA_MACRO_Y;
    if (!guaranteedShowcase && !guaranteedOwnerVista && seed % 1000 >= 155) {
        cacheMacro(key, null);
        return null;
    }
    let feature: GreatLakeFeature | null = null;
    try {
        feature = guaranteedOwnerVista
            ? buildOwnerVistaGreatLake(macroX, macroY, seed)
            : buildGreatLake(macroX, macroY, seed);
    } catch {
        // A pathological bounded terrain seed becomes dry macro terrain. The
        // result is cached and deterministic; callers never receive partial
        // geometry or an unbounded retry loop.
        feature = null;
    }
    cacheMacro(key, feature);
    return feature;
}

function normalizeWindow(window: PlotWindow): PlotWindow {
    for (const [name, value] of Object.entries(window)) assertPlotCoordinate(value, name);
    const result = {
        minPlotX: Math.min(window.minPlotX, window.maxPlotX),
        minPlotY: Math.min(window.minPlotY, window.maxPlotY),
        maxPlotX: Math.max(window.minPlotX, window.maxPlotX),
        maxPlotY: Math.max(window.minPlotY, window.maxPlotY)
    };
    const width = result.maxPlotX - result.minPlotX + 1;
    const height = result.maxPlotY - result.minPlotY + 1;
    if (width > MAX_QUERY_SPAN_PLOTS || height > MAX_QUERY_SPAN_PLOTS) {
        throw new Error(`Hydrology windows are capped at ${MAX_QUERY_SPAN_PLOTS}x${MAX_QUERY_SPAN_PLOTS} plots.`);
    }
    return result;
}

/** All world hydrology features whose absolute geometry intersects a plot window. */
export function queryWorldHydrology(window: PlotWindow, rawSeedVersion: unknown = 0): readonly GreatLakeFeature[] {
    const normalized = normalizeWindow(window);
    const seedVersion = normalizeSeedVersion(rawSeedVersion);
    // One-cell padding is defensive: features are required to remain in their
    // owner macro, but this keeps query correctness if that policy later opens.
    const minMacroX = Math.floor(normalized.minPlotX / HYDROLOGY_MACRO_PLOTS) - 1;
    const minMacroY = Math.floor(normalized.minPlotY / HYDROLOGY_MACRO_PLOTS) - 1;
    const maxMacroX = Math.floor(normalized.maxPlotX / HYDROLOGY_MACRO_PLOTS) + 1;
    const maxMacroY = Math.floor(normalized.maxPlotY / HYDROLOGY_MACRO_PLOTS) + 1;
    const macroCount = (maxMacroX - minMacroX + 1) * (maxMacroY - minMacroY + 1);
    if (macroCount > MAX_QUERY_MACRO_CELLS) throw new Error('Hydrology query exceeds its macro-cell safety bound.');
    const worldBounds = {
        minX: normalized.minPlotX * HYDROLOGY_PLOT_PITCH,
        minY: normalized.minPlotY * HYDROLOGY_PLOT_PITCH,
        maxX: (normalized.maxPlotX + 1) * HYDROLOGY_PLOT_PITCH,
        maxY: (normalized.maxPlotY + 1) * HYDROLOGY_PLOT_PITCH
    };
    const result: GreatLakeFeature[] = [];
    for (let macroY = minMacroY; macroY <= maxMacroY; macroY++) {
        for (let macroX = minMacroX; macroX <= maxMacroX; macroX++) {
            const feature = greatLakeForMacroCell(macroX, macroY, seedVersion);
            if (feature && boundsIntersect(feature.worldBounds, worldBounds)
                && feature.protectedPlots.some(plot =>
                    plot.x >= normalized.minPlotX && plot.x <= normalized.maxPlotX
                    && plot.y >= normalized.minPlotY && plot.y <= normalized.maxPlotY)) result.push(feature);
        }
    }
    result.sort((a, b) => a.id.localeCompare(b.id));
    return Object.freeze(result);
}

export function hydrologyFeaturesForPlot(
    plotX: number,
    plotY: number,
    seedVersion: unknown = 0
): readonly GreatLakeFeature[] {
    return Object.freeze(queryWorldHydrology(
        { minPlotX: plotX, minPlotY: plotY, maxPlotX: plotX, maxPlotY: plotY },
        seedVersion
    )
        .filter(feature => feature.protectedPlots.some(plot => plot.x === plotX && plot.y === plotY)));
}

/** Hydrology reservation details suitable for settlement/allocation checks. */
export function classifyHydrologyPlot(
    plotX: number,
    plotY: number,
    seedVersion: unknown = 0
): HydrologyPlotClassification {
    assertPlotCoordinate(plotX, 'plotX');
    assertPlotCoordinate(plotY, 'plotY');
    const features = hydrologyFeaturesForPlot(plotX, plotY, seedVersion).map(feature => {
        const coverage = feature.protectedPlots.find(plot => plot.x === plotX && plot.y === plotY);
        return Object.freeze({
            id: feature.id,
            label: feature.label,
            kind: feature.kind,
            lake: coverage?.lake ?? false,
            river: coverage?.river ?? false
        });
    });
    return Object.freeze({ protected: features.length > 0, features: Object.freeze(features) });
}

export function isHydrologyProtectedPlot(plotX: number, plotY: number, seedVersion: unknown = 0): boolean {
    return classifyHydrologyPlot(plotX, plotY, seedVersion).protected;
}

/**
 * Translate one absolute feature into a map/view anchor without regenerating
 * it. Adding anchorWorldTile back to any returned point exactly recovers the
 * cached absolute contour, including on shared plot edges.
 */
export function anchorHydrologyFeature(
    feature: GreatLakeFeature,
    anchorPlotX: number,
    anchorPlotY: number
): AnchoredHydrologyFeature {
    assertPlotCoordinate(anchorPlotX, 'anchorPlotX');
    assertPlotCoordinate(anchorPlotY, 'anchorPlotY');
    const anchorWorldTile = { x: anchorPlotX * HYDROLOGY_PLOT_PITCH, y: anchorPlotY * HYDROLOGY_PLOT_PITCH };
    const translate = (point: TerrainPoint): TerrainPoint => ({
        x: point.x - anchorWorldTile.x,
        y: point.y - anchorWorldTile.y
    });
    const contours: LakeContours = Object.freeze({
        bank: freezeContour(feature.terrain.contours.bank.map(translate)),
        water: freezeContour(feature.terrain.contours.water.map(translate)),
        mid: freezeContour(feature.terrain.contours.mid.map(translate)),
        deep: freezeContour(feature.terrain.contours.deep.map(translate))
    });
    const network = freezeNetwork({
        sourceNodeId: feature.network.sourceNodeId,
        sinkNodeId: feature.network.sinkNodeId,
        nodes: feature.network.nodes.map(node => ({ ...node, point: translate(node.point) })),
        reaches: feature.network.reaches.map(reach => ({
            ...reach,
            points: reach.points.map(translate)
        }))
    });
    return Object.freeze({
        id: feature.id,
        label: feature.label,
        seed: feature.seed,
        anchorPlot: Object.freeze({ x: anchorPlotX, y: anchorPlotY }),
        anchorWorldTile: Object.freeze(anchorWorldTile),
        contours,
        network,
        contains: (localX: number, localY: number, band: LakeBand = 'water'): boolean =>
            feature.terrain.contains(localX + anchorWorldTile.x, localY + anchorWorldTile.y, band),
        sampleDepth: (localX: number, localY: number): number =>
            feature.terrain.sampleDepth(localX + anchorWorldTile.x, localY + anchorWorldTile.y)
    });
}

/** True if the directed reach graph contains a source-to-sink path. */
export function isHydrologyNetworkConnected(network: HydrologyNetwork): boolean {
    const nodeIds = new Set(network.nodes.map(node => node.id));
    if (!nodeIds.has(network.sourceNodeId) || !nodeIds.has(network.sinkNodeId)) return false;
    const outgoing = new Map<string, string[]>();
    for (const reach of network.reaches) {
        if (!nodeIds.has(reach.fromNodeId) || !nodeIds.has(reach.toNodeId) || reach.points.length < 2) return false;
        const values = outgoing.get(reach.fromNodeId);
        if (values) values.push(reach.toNodeId);
        else outgoing.set(reach.fromNodeId, [reach.toNodeId]);
    }
    const seen = new Set<string>([network.sourceNodeId]);
    const queue = [network.sourceNodeId];
    for (let head = 0; head < queue.length; head++) {
        const node = queue[head];
        if (node === network.sinkNodeId) return true;
        for (const next of outgoing.get(node) ?? []) {
            if (seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
        }
    }
    return false;
}

/** Bounded discovery hook for previews/tests in any generated-world epoch. */
export function findWorldHydrologyShowcase(seedVersion: unknown = 0): GreatLakeFeature {
    const normalizedSeedVersion = normalizeSeedVersion(seedVersion);
    const maximumRadius = normalizedSeedVersion === 0 ? 3 : 12;
    for (let radius = 0; radius <= maximumRadius; radius++) {
        for (let y = -radius; y <= radius; y++) {
            for (let x = -radius; x <= radius; x++) {
                if (radius > 0 && Math.max(Math.abs(x), Math.abs(y)) !== radius) continue;
                const feature = greatLakeForMacroCell(x, y, normalizedSeedVersion);
                if (feature) return feature;
            }
        }
    }
    // Epoch zero has an explicit (2,-2) fixture. Later epochs intentionally do
    // not pin a lake location, but retain a generous finite discovery bound.
    throw new Error(`No world hydrology showcase exists within macro radius ${maximumRadius}.`);
}

/** Primarily for deterministic regression checks and controlled hot reloads. */
export function clearWorldHydrologyCache(): void {
    macroCache.clear();
}

/** Exposed for diagnostics without granting mutation of the cache. */
export function worldHydrologyCacheSize(): number {
    return macroCache.size;
}

/** Whether an absolute point belongs to a lake; convenient for future rivers. */
export function featureContainsWorldPoint(
    feature: GreatLakeFeature,
    worldTileX: number,
    worldTileY: number,
    band: LakeBand = 'water'
): boolean {
    return feature.terrain.contains(worldTileX, worldTileY, band);
}
