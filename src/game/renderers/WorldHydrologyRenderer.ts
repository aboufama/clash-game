import type Phaser from 'phaser';
import type {
    GreatLakeFeature,
    RiverNode,
    RiverReach
} from '../config/WorldHydrology';
import { IsoUtils } from '../utils/IsoUtils';
import { contourContains } from './WildernessTerrain';
import type { TerrainBounds, TerrainPoint } from './WildernessTerrain';
import {
    normalizeWorldNatureSeedVersion,
    worldHydrologyDecorationSeed
} from './WorldNatureSeed';

/**
 * A rectangular view onto absolute world-tile hydrology.
 *
 * `localGridX/localGridY` are the local grid coordinates where the clip's
 * north-west corner should land. A plot postcard therefore passes its
 * absolute 25x25 plot rectangle and the plot's local `offX/offY`; a reclaimed
 * road gap passes its absolute two-tile rectangle and that gap's local map
 * coordinate. Both calls clip the same absolute contours, so no shoreline is
 * regenerated (or subtly changed) at a parcel seam.
 */
export interface WorldHydrologyRenderWindow {
    readonly clip: TerrainBounds;
    readonly localGridX: number;
    readonly localGridY: number;
    readonly alpha?: number;
    /** Disable freestanding wildlife/foliage when drawing narrow gap pieces. */
    readonly includeDetails?: boolean;
    /** Mutable scenery epoch. Structural lake/river geometry never uses it. */
    readonly presentationSeedVersion?: number;
}

export type HydrologyLifeKind = 'fish' | 'duck' | 'frog' | 'heron';

/** Static world anchors that a caller may animate as a function of time. */
export interface HydrologyLifeAnchor {
    readonly featureId: string;
    readonly kind: HydrologyLifeKind;
    readonly worldX: number;
    readonly worldY: number;
    readonly localGridX: number;
    readonly localGridY: number;
    readonly phase: number;
    readonly scale: number;
}

export interface WorldHydrologyRenderResult {
    readonly featureId: string;
    readonly visible: boolean;
    readonly lakePolygons: number;
    readonly riverPolygons: number;
    readonly life: readonly HydrologyLifeAnchor[];
}

interface IslandDecoration {
    x: number;
    y: number;
    radiusX: number;
    radiusY: number;
    seed: number;
}

interface PointDecoration {
    x: number;
    y: number;
    phase: number;
    scale: number;
}

interface TreeDecoration extends PointDecoration {
    kind: 'conifer' | 'broadleaf';
}

interface FeatureDecorations {
    islands: readonly IslandDecoration[];
    fish: readonly PointDecoration[];
    reeds: readonly PointDecoration[];
    rocks: readonly PointDecoration[];
    lilies: readonly PointDecoration[];
    trees: readonly TreeDecoration[];
    logs: readonly PointDecoration[];
    duck: PointDecoration | null;
    frog: PointDecoration | null;
    heron: PointDecoration | null;
}

interface RiverBandGeometry {
    bank: readonly TerrainPoint[];
    water: readonly TerrainPoint[];
    channel: readonly TerrainPoint[];
}

const EPSILON = 1e-7;
const TAU = Math.PI * 2;
const LAKE_BANK_COLOR = 0x5e6b51;
const LAKE_SHALLOW_COLOR = 0x42939b;
const LAKE_MID_COLOR = 0x2c778d;
const LAKE_DEEP_COLOR = 0x1d5b76;
const decorationCache = new WeakMap<GreatLakeFeature, Map<number, FeatureDecorations>>();

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function mix32(value: number): number {
    let h = value >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
}

function hashCoordinate(seed: number, x: number, y: number, salt = 0): number {
    return mix32(
        seed
        ^ Math.imul(x | 0, 0x1f123bb5)
        ^ Math.imul(y | 0, 0x5f356495)
        ^ Math.imul(salt | 0, 0x9e3779b1)
    );
}

function hashUnit(seed: number, x: number, y: number, salt = 0): number {
    return hashCoordinate(seed, x, y, salt) / 4294967296;
}

function makeRandom(seed: number): () => number {
    let state = mix32(seed);
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function samePoint(a: TerrainPoint, b: TerrainPoint): boolean {
    return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
}

function finitePoint(point: TerrainPoint): boolean {
    return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** Normalize and validate a clip rectangle without mutating the caller's object. */
export function normalizeHydrologyClipRect(rect: TerrainBounds): TerrainBounds {
    if (![rect.minX, rect.minY, rect.maxX, rect.maxY].every(Number.isFinite)) {
        throw new Error('Hydrology clip bounds must be finite.');
    }
    const normalized = {
        minX: Math.min(rect.minX, rect.maxX),
        minY: Math.min(rect.minY, rect.maxY),
        maxX: Math.max(rect.minX, rect.maxX),
        maxY: Math.max(rect.minY, rect.maxY)
    };
    if (normalized.maxX - normalized.minX <= EPSILON
        || normalized.maxY - normalized.minY <= EPSILON) {
        throw new Error('Hydrology clip bounds must have positive area.');
    }
    return normalized;
}

function dedupePolygon(points: readonly TerrainPoint[]): TerrainPoint[] {
    const result: TerrainPoint[] = [];
    for (const point of points) {
        if (!finitePoint(point)) continue;
        if (result.length === 0 || !samePoint(result[result.length - 1], point)) {
            result.push({ x: point.x, y: point.y });
        }
    }
    if (result.length > 1 && samePoint(result[0], result[result.length - 1])) result.pop();
    return result;
}

type ClipEdge = 'left' | 'right' | 'top' | 'bottom';

function insideEdge(point: TerrainPoint, edge: ClipEdge, rect: TerrainBounds): boolean {
    if (edge === 'left') return point.x >= rect.minX - EPSILON;
    if (edge === 'right') return point.x <= rect.maxX + EPSILON;
    if (edge === 'top') return point.y >= rect.minY - EPSILON;
    return point.y <= rect.maxY + EPSILON;
}

function edgeIntersection(
    from: TerrainPoint,
    to: TerrainPoint,
    edge: ClipEdge,
    rect: TerrainBounds
): TerrainPoint {
    if (edge === 'left' || edge === 'right') {
        const x = edge === 'left' ? rect.minX : rect.maxX;
        const dx = to.x - from.x;
        const t = Math.abs(dx) <= EPSILON ? 0 : clamp((x - from.x) / dx, 0, 1);
        return { x, y: clamp(from.y + (to.y - from.y) * t, rect.minY, rect.maxY) };
    }
    const y = edge === 'top' ? rect.minY : rect.maxY;
    const dy = to.y - from.y;
    const t = Math.abs(dy) <= EPSILON ? 0 : clamp((y - from.y) / dy, 0, 1);
    return { x: clamp(from.x + (to.x - from.x) * t, rect.minX, rect.maxX), y };
}

/**
 * Sutherland-Hodgman clipping against an axis-aligned world-tile rectangle.
 * Input may be clockwise/counter-clockwise and may repeat its closing point.
 */
export function clipPolygonToRect(
    polygon: readonly TerrainPoint[],
    clipRect: TerrainBounds
): TerrainPoint[] {
    const rect = normalizeHydrologyClipRect(clipRect);
    let output = dedupePolygon(polygon);
    if (output.length < 3) return [];
    const edges: readonly ClipEdge[] = ['left', 'right', 'top', 'bottom'];
    for (const edge of edges) {
        if (output.length === 0) break;
        const input = output;
        output = [];
        let previous = input[input.length - 1];
        let previousInside = insideEdge(previous, edge, rect);
        for (const current of input) {
            const currentInside = insideEdge(current, edge, rect);
            if (currentInside !== previousInside) {
                output.push(edgeIntersection(previous, current, edge, rect));
            }
            if (currentInside) output.push({ x: current.x, y: current.y });
            previous = current;
            previousInside = currentInside;
        }
        output = dedupePolygon(output);
    }
    return output.length >= 3 ? output : [];
}

/** Liang-Barsky segment clipping, used for shore glints and rapid foam. */
export function clipSegmentToRect(
    from: TerrainPoint,
    to: TerrainPoint,
    clipRect: TerrainBounds
): readonly [TerrainPoint, TerrainPoint] | null {
    if (!finitePoint(from) || !finitePoint(to)) return null;
    const rect = normalizeHydrologyClipRect(clipRect);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let t0 = 0;
    let t1 = 1;
    const tests: readonly [number, number][] = [
        [-dx, from.x - rect.minX],
        [dx, rect.maxX - from.x],
        [-dy, from.y - rect.minY],
        [dy, rect.maxY - from.y]
    ];
    for (const [p, q] of tests) {
        if (Math.abs(p) <= EPSILON) {
            if (q < -EPSILON) return null;
            continue;
        }
        const t = q / p;
        if (p < 0) {
            if (t > t1) return null;
            t0 = Math.max(t0, t);
        } else {
            if (t < t0) return null;
            t1 = Math.min(t1, t);
        }
    }
    if (t1 < t0 - EPSILON) return null;
    return [
        { x: from.x + dx * t0, y: from.y + dy * t0 },
        { x: from.x + dx * t1, y: from.y + dy * t1 }
    ];
}

function normalizeVector(x: number, y: number): TerrainPoint {
    const length = Math.hypot(x, y);
    return length <= EPSILON ? { x: 1, y: 0 } : { x: x / length, y: y / length };
}

/**
 * A joined, variable-width grid-space ribbon. Interior vertices use a bounded
 * miter, avoiding the pinholes left by stamping independent river ellipses.
 */
export function buildVariableWidthRibbon(
    sourcePoints: readonly TerrainPoint[],
    sourceWidths: readonly number[]
): TerrainPoint[] {
    if (sourcePoints.length !== sourceWidths.length) {
        throw new Error('River ribbon points and widths must have matching lengths.');
    }
    const points: TerrainPoint[] = [];
    const widths: number[] = [];
    for (let index = 0; index < sourcePoints.length; index++) {
        const point = sourcePoints[index];
        const width = sourceWidths[index];
        if (!finitePoint(point) || !Number.isFinite(width) || width <= EPSILON) continue;
        if (points.length > 0 && samePoint(points[points.length - 1], point)) {
            widths[widths.length - 1] = Math.max(widths[widths.length - 1], width);
            continue;
        }
        points.push({ x: point.x, y: point.y });
        widths.push(width);
    }
    if (points.length < 2) return [];

    const left: TerrainPoint[] = [];
    const right: TerrainPoint[] = [];
    for (let index = 0; index < points.length; index++) {
        const current = points[index];
        const previous = points[Math.max(0, index - 1)];
        const next = points[Math.min(points.length - 1, index + 1)];
        const incoming = normalizeVector(current.x - previous.x, current.y - previous.y);
        const outgoing = normalizeVector(next.x - current.x, next.y - current.y);
        let normal: TerrainPoint;
        let miterScale = widths[index] * 0.5;
        if (index === 0) {
            normal = { x: -outgoing.y, y: outgoing.x };
        } else if (index === points.length - 1) {
            normal = { x: -incoming.y, y: incoming.x };
        } else {
            const incomingNormal = { x: -incoming.y, y: incoming.x };
            const outgoingNormal = { x: -outgoing.y, y: outgoing.x };
            normal = normalizeVector(
                incomingNormal.x + outgoingNormal.x,
                incomingNormal.y + outgoingNormal.y
            );
            const denominator = Math.abs(normal.x * outgoingNormal.x + normal.y * outgoingNormal.y);
            miterScale = denominator <= 0.2
                ? widths[index] * 0.5
                : Math.min(widths[index] * 1.15, (widths[index] * 0.5) / denominator);
        }
        left.push({ x: current.x + normal.x * miterScale, y: current.y + normal.y * miterScale });
        right.push({ x: current.x - normal.x * miterScale, y: current.y - normal.y * miterScale });
    }
    return dedupePolygon([...left, ...right.reverse()]);
}

function boundsIntersect(a: TerrainBounds, b: TerrainBounds): boolean {
    return a.maxX >= b.minX && a.minX <= b.maxX
        && a.maxY >= b.minY && a.minY <= b.maxY;
}

function pointInsideRect(point: TerrainPoint, rect: TerrainBounds, margin = 0): boolean {
    return point.x >= rect.minX + margin && point.x <= rect.maxX - margin
        && point.y >= rect.minY + margin && point.y <= rect.maxY - margin;
}

function irregularLoop(
    center: TerrainPoint,
    radiusX: number,
    radiusY: number,
    seed: number,
    vertices = 20
): TerrainPoint[] {
    const phase2 = hashUnit(seed, 2, 7) * TAU;
    const phase3 = hashUnit(seed, 3, 11) * TAU;
    const phase5 = hashUnit(seed, 5, 13) * TAU;
    const result: TerrainPoint[] = [];
    for (let index = 0; index < vertices; index++) {
        const angle = index / vertices * TAU;
        const wobble = 1
            + Math.sin(angle * 2 + phase2) * 0.13
            + Math.sin(angle * 3 + phase3) * 0.08
            + Math.sin(angle * 5 + phase5) * 0.045;
        result.push({
            x: center.x + Math.cos(angle) * radiusX * wobble,
            y: center.y + Math.sin(angle) * radiusY * wobble
        });
    }
    return result;
}

function decorationWithinIsland(point: TerrainPoint, islands: readonly IslandDecoration[]): boolean {
    return islands.some(island => {
        const dx = (point.x - island.x) / Math.max(0.1, island.radiusX * 1.2);
        const dy = (point.y - island.y) / Math.max(0.1, island.radiusY * 1.2);
        return dx * dx + dy * dy <= 1;
    });
}

function distanceToSegment(point: TerrainPoint, from: TerrainPoint, to: TerrainPoint): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const denominator = dx * dx + dy * dy;
    const t = denominator <= EPSILON
        ? 0
        : clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / denominator, 0, 1);
    return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
}

/** Inside the water system (unified border when present, lake bank otherwise). */
function insideWaterBank(feature: GreatLakeFeature, x: number, y: number): boolean {
    if (feature.waterBody) return contourContains(feature.waterBody.bank, x, y);
    return feature.terrain.contains(x, y, 'bank');
}

function nearOpenRiver(feature: GreatLakeFeature, point: TerrainPoint, clearance: number): boolean {
    return feature.network.reaches.some(reach => {
        if (reach.kind === 'lake-passage') return false;
        for (let index = 0; index + 1 < reach.points.length; index++) {
            if (distanceToSegment(point, reach.points[index], reach.points[index + 1])
                < reach.width * 0.5 + clearance) return true;
        }
        return false;
    });
}

function buildDecorations(feature: GreatLakeFeature, presentationSeedVersion: number): FeatureDecorations {
    let versions = decorationCache.get(feature);
    if (!versions) {
        versions = new Map();
        decorationCache.set(feature, versions);
    }
    const cached = versions.get(presentationSeedVersion);
    if (cached) return cached;
    const seed = worldHydrologyDecorationSeed(feature.seed, presentationSeedVersion);
    const random = makeRandom(seed ^ 0xb7e15162);
    const terrain = feature.terrain;
    const bounds = terrain.bounds;
    const islands: IslandDecoration[] = [];
    const targetIslands = 2 + (seed % 3);
    for (let attempt = 0; attempt < 180 && islands.length < targetIslands; attempt++) {
        const radiusX = 2.8 + random() * 2.8;
        const radiusY = 2 + random() * 2.2;
        const point = {
            x: bounds.minX + radiusX + random() * Math.max(0.1, bounds.maxX - bounds.minX - radiusX * 2),
            y: bounds.minY + radiusY + random() * Math.max(0.1, bounds.maxY - bounds.minY - radiusY * 2)
        };
        const checks = [
            point,
            { x: point.x - radiusX, y: point.y }, { x: point.x + radiusX, y: point.y },
            { x: point.x, y: point.y - radiusY }, { x: point.x, y: point.y + radiusY }
        ];
        if (terrain.sampleDepth(point.x, point.y) < 0.48
            || checks.some(check => terrain.sampleDepth(check.x, check.y) < 0.18)) continue;
        if (islands.some(island => Math.hypot(point.x - island.x, point.y - island.y)
            < Math.max(radiusX, radiusY) + Math.max(island.radiusX, island.radiusY) + 5)) continue;
        islands.push({ x: point.x, y: point.y, radiusX, radiusY, seed: mix32(seed + attempt) });
    }

    const fish: PointDecoration[] = [];
    const reeds: PointDecoration[] = [];
    const rocks: PointDecoration[] = [];
    const lilies: PointDecoration[] = [];
    const trees: TreeDecoration[] = [];
    const logs: PointDecoration[] = [];
    let duck: PointDecoration | null = null;
    let frog: PointDecoration | null = null;
    let heron: PointDecoration | null = null;
    const spacing = 5.25;
    const minCellX = Math.floor(bounds.minX / spacing) - 1;
    const maxCellX = Math.ceil(bounds.maxX / spacing) + 1;
    const minCellY = Math.floor(bounds.minY / spacing) - 1;
    const maxCellY = Math.ceil(bounds.maxY / spacing) + 1;
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
            const x = (cellX + 0.16 + hashUnit(seed, cellX, cellY, 1) * 0.68) * spacing;
            const y = (cellY + 0.16 + hashUnit(seed, cellX, cellY, 2) * 0.68) * spacing;
            const point = { x, y };
            if (!pointInsideRect(point, bounds) || decorationWithinIsland(point, islands)) continue;
            const depth = terrain.sampleDepth(x, y);
            const inBank = terrain.contains(x, y, 'bank');
            const inWater = terrain.contains(x, y, 'water');
            const phase = hashUnit(seed, cellX, cellY, 3) * TAU;
            const scale = 0.75 + hashUnit(seed, cellX, cellY, 4) * 0.65;
            const roll = hashUnit(seed, cellX, cellY, 5);
            const decoration = { x, y, phase, scale };
            if (depth >= 0.23 && roll < 0.26 && fish.length < 30) fish.push(decoration);
            if (depth >= 0.07 && depth <= 0.34 && roll > 0.82 && lilies.length < 24) lilies.push(decoration);
            if (inBank && (!inWater || depth <= 0.13) && roll < 0.38 && reeds.length < 38) {
                reeds.push(decoration);
                if (!frog && hashUnit(seed, cellX, cellY, 7) > 0.76) frog = decoration;
            }
            if (inBank && !inWater && roll > 0.7 && rocks.length < 20) {
                rocks.push(decoration);
                if (!heron && hashUnit(seed, cellX, cellY, 8) > 0.84) heron = decoration;
            }
            if (!duck && depth >= 0.18 && depth <= 0.58
                && hashUnit(seed, cellX, cellY, 9) > 0.965) duck = decoration;
        }
    }
    if (!duck) duck = fish.find(point => terrain.sampleDepth(point.x, point.y) < 0.62) ?? null;

    // Mainland forest is arranged in a handful of absolute shoreline groves,
    // never as an evenly spaced necklace. Each grove owns a mixed understory,
    // while long stretches remain open meadow, bluff, or reed shore.
    const bank = terrain.contours.bank;
    const groveCenters: Array<TerrainPoint & { tangent: TerrainPoint; outward: TerrainPoint }> = [];
    const targetGroves = 10 + (seed % 5);
    for (let attempt = 0; attempt < 260 && groveCenters.length < targetGroves; attempt++) {
        const shoreIndex = Math.floor(random() * bank.length);
        const shore = bank[shoreIndex];
        const before = bank[(shoreIndex - 2 + bank.length) % bank.length];
        const after = bank[(shoreIndex + 2) % bank.length];
        const tangent = normalizeVector(after.x - before.x, after.y - before.y);
        const radial = normalizeVector(shore.x - terrain.center.x, shore.y - terrain.center.y);
        const normalA = { x: -tangent.y, y: tangent.x };
        const normalB = { x: tangent.y, y: -tangent.x };
        const outward = normalA.x * radial.x + normalA.y * radial.y >= 0 ? normalA : normalB;
        const center = {
            x: shore.x + outward.x * (2.1 + random() * 3.8),
            y: shore.y + outward.y * (2.1 + random() * 3.8)
        };
        if (terrain.contains(center.x, center.y, 'bank') || !pointInsideRect(center, bounds, 0.8)) continue;
        if (nearOpenRiver(feature, center, 2.2)) continue;
        if (groveCenters.some(other => Math.hypot(center.x - other.x, center.y - other.y) < 7.5)) continue;
        groveCenters.push({ ...center, tangent, outward });
    }
    groveCenters.forEach((center, groveIndex) => {
        const groveSeed = mix32(seed ^ Math.imul(groveIndex + 1, 0x9e3779b9));
        const groveRandom = makeRandom(groveSeed);
        const targetTrees = 8 + Math.floor(groveRandom() * 7);
        for (let attempt = 0; attempt < 78 && trees.filter(tree => {
            const dx = tree.x - center.x;
            const dy = tree.y - center.y;
            return Math.hypot(dx, dy) < 8;
        }).length < targetTrees; attempt++) {
            const along = (groveRandom() - 0.5) * (7 + groveRandom() * 5);
            const inland = (groveRandom() - 0.35) * (3.5 + groveRandom() * 3.2);
            const point = {
                x: center.x + center.tangent.x * along + center.outward.x * inland,
                y: center.y + center.tangent.y * along + center.outward.y * inland
            };
            if (!pointInsideRect(point, bounds, 0.7) || terrain.contains(point.x, point.y, 'bank')) continue;
            if (nearOpenRiver(feature, point, 1.5)) continue;
            if (trees.some(tree => Math.hypot(point.x - tree.x, point.y - tree.y) < 1.3)) continue;
            trees.push({
                ...point,
                kind: groveRandom() < 0.38 ? 'broadleaf' : 'conifer',
                phase: groveRandom() * TAU,
                scale: 1.02 + groveRandom() * 0.72
            });
        }
        // Fallen timber and a hero stone make the grove edge feel old rather
        // than freshly planted. They share the same absolute cluster seed.
        if (groveIndex % 2 === seed % 2) {
            const point = {
                x: center.x + center.tangent.x * (groveRandom() - 0.5) * 6 + center.outward.x * 1.2,
                y: center.y + center.tangent.y * (groveRandom() - 0.5) * 6 + center.outward.y * 1.2
            };
            if (!terrain.contains(point.x, point.y, 'bank') && !nearOpenRiver(feature, point, 1.3)) {
                logs.push({ ...point, phase: Math.atan2(center.tangent.y, center.tangent.x), scale: 0.8 + groveRandom() * 0.4 });
            }
        }
        const rockPoint = {
            x: center.x - center.tangent.x * (2.2 + groveRandom() * 3) + center.outward.x * (0.3 + groveRandom() * 1.8),
            y: center.y - center.tangent.y * (2.2 + groveRandom() * 3) + center.outward.y * (0.3 + groveRandom() * 1.8)
        };
        if (!terrain.contains(rockPoint.x, rockPoint.y, 'bank') && !nearOpenRiver(feature, rockPoint, 1.2)) {
            rocks.push({ ...rockPoint, phase: groveRandom() * TAU, scale: 0.95 + groveRandom() * 0.65 });
        }
    });

    const result: FeatureDecorations = {
        islands: Object.freeze(islands),
        fish: Object.freeze(fish),
        reeds: Object.freeze(reeds),
        rocks: Object.freeze(rocks),
        lilies: Object.freeze(lilies),
        trees: Object.freeze(trees),
        logs: Object.freeze(logs),
        duck,
        frog,
        heron
    };
    versions.set(presentationSeedVersion, result);
    // A feature normally belongs to one epoch, but previews can deliberately
    // render several. Bound that diagnostic path instead of retaining an
    // unbounded map of obsolete decoration generations.
    if (versions.size > 4) {
        const oldest = versions.keys().next().value as number | undefined;
        if (oldest !== undefined && oldest !== presentationSeedVersion) versions.delete(oldest);
    }
    return result;
}

function reachWidthScale(kind: RiverNode['kind'] | undefined): number {
    if (kind === 'source') return 0.48;
    // A river meets a lake as a trumpet, not a hose: the mouth flares so
    // the banks peel open and the waters merge inside the basin.
    if (kind === 'inlet' || kind === 'outlet') return 1.45;
    if (kind === 'rapid') return 1.12;
    if (kind === 'sink') return 1.42;
    return 1;
}

/** Prolong a reach past a lake node so the ribbon dies INSIDE the basin —
 *  the river's water then meets the lake's water, never a shore plug. */
function extendIntoLake(
    points: readonly TerrainPoint[],
    fromKind: RiverNode['kind'] | undefined,
    toKind: RiverNode['kind'] | undefined
): TerrainPoint[] {
    const out = points.map(point => ({ x: point.x, y: point.y }));
    const REACH_IN = 2.4;
    const lakeEnd = (kind: RiverNode['kind'] | undefined) => kind === 'inlet' || kind === 'outlet';
    if (lakeEnd(toKind) && out.length >= 2) {
        const a = out[out.length - 2];
        const b = out[out.length - 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        out.push({ x: b.x + ((b.x - a.x) / len) * REACH_IN, y: b.y + ((b.y - a.y) / len) * REACH_IN });
    }
    if (lakeEnd(fromKind) && out.length >= 2) {
        const a = out[1];
        const b = out[0];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        out.unshift({ x: b.x + ((b.x - a.x) / len) * REACH_IN, y: b.y + ((b.y - a.y) / len) * REACH_IN });
    }
    return out;
}

/** One Chaikin corner-cut over a width-carrying polyline; ends stay pinned. */
function chaikinWithWidths(
    points: readonly TerrainPoint[],
    widths: readonly number[]
): { points: TerrainPoint[]; widths: number[] } {
    if (points.length < 3) return { points: points.map(point => ({ x: point.x, y: point.y })), widths: [...widths] };
    const outPoints: TerrainPoint[] = [{ x: points[0].x, y: points[0].y }];
    const outWidths: number[] = [widths[0]];
    for (let index = 0; index + 1 < points.length; index++) {
        const a = points[index];
        const b = points[index + 1];
        outPoints.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        outWidths.push(widths[index] * 0.75 + widths[index + 1] * 0.25);
        outPoints.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
        outWidths.push(widths[index] * 0.25 + widths[index + 1] * 0.75);
    }
    outPoints.push({ x: points[points.length - 1].x, y: points[points.length - 1].y });
    outWidths.push(widths[widths.length - 1]);
    return { points: outPoints, widths: outWidths };
}

function riverGeometry(feature: GreatLakeFeature): RiverBandGeometry[] {
    const nodeKinds = new Map(feature.network.nodes.map(node => [node.id, node.kind] as const));
    const open = feature.network.reaches
        .filter(reach => reach.kind !== 'lake-passage' && reach.width > 0 && reach.points.length >= 2);
    // Consecutive reaches (outflow -> rapids) render as ONE continuous ribbon:
    // independent per-reach ribbons leave a width notch at the shared node.
    const chains: RiverReach[][] = [];
    for (const reach of open) {
        const chain = chains.find(candidate => candidate[candidate.length - 1].toNodeId === reach.fromNodeId);
        if (chain) chain.push(reach);
        else chains.push([reach]);
    }
    return chains.map(chain => {
        // A node's absolute width is shared by both adjoining reaches, so the
        // joined ribbon is width-continuous by construction.
        const nodeWidth = (index: number): number => {
            const before = chain[Math.max(0, index - 1)];
            const after = chain[Math.min(chain.length - 1, index)];
            const nodeId = index === 0 ? chain[0].fromNodeId : chain[index - 1].toNodeId;
            return ((before.width + after.width) / 2) * reachWidthScale(nodeKinds.get(nodeId));
        };
        const points: TerrainPoint[] = [];
        const widths: number[] = [];
        chain.forEach((reach, reachIndex) => {
            const startWidth = nodeWidth(reachIndex);
            const endWidth = nodeWidth(reachIndex + 1);
            const reachPoints = extendIntoLake(
                reach.points,
                nodeKinds.get(reach.fromNodeId),
                nodeKinds.get(reach.toNodeId)
            );
            reachPoints.forEach((point, index) => {
                if (reachIndex > 0 && index === 0) return; // shared joint point
                const t = reachPoints.length <= 1 ? 0 : index / (reachPoints.length - 1);
                const eased = t * t * (3 - 2 * t);
                const coherentVariation = 1 + Math.sin((points.length) * 1.77 + feature.seed * 0.00001) * 0.055;
                points.push({ x: point.x, y: point.y });
                widths.push((startWidth + (endWidth - startWidth) * eased) * coherentVariation);
            });
        });
        // Two corner-cutting passes turn the meander's few segments into a
        // continuous curve: the banks bend instead of kinking.
        let smooth = chaikinWithWidths(points, widths);
        smooth = chaikinWithWidths(smooth.points, smooth.widths);
        return {
            bank: buildVariableWidthRibbon(smooth.points, smooth.widths.map(width => width + 1.15)),
            water: buildVariableWidthRibbon(smooth.points, smooth.widths),
            channel: buildVariableWidthRibbon(smooth.points, smooth.widths.map(width => Math.max(0.28, width * 0.42)))
        };
    });
}

/** River mouths: where an open reach meets the lake (inlet/outlet nodes). */
function riverMouths(feature: GreatLakeFeature): Array<{ point: TerrainPoint; radius: number }> {
    const nodesById = new Map(feature.network.nodes.map(node => [node.id, node] as const));
    const mouths: Array<{ point: TerrainPoint; radius: number }> = [];
    for (const reach of feature.network.reaches) {
        if (reach.kind === 'lake-passage' || reach.width <= 0) continue;
        for (const nodeId of [reach.fromNodeId, reach.toNodeId]) {
            const node = nodesById.get(nodeId);
            if (!node || (node.kind !== 'inlet' && node.kind !== 'outlet')) continue;
            mouths.push({ point: node.point, radius: reach.width * reachWidthScale(node.kind) * 0.5 });
        }
    }
    return mouths;
}

function drawScreenPolygon(
    graphics: Phaser.GameObjects.Graphics,
    points: readonly { x: number; y: number }[],
    color: number,
    alpha: number
): boolean {
    if (points.length < 3) return false;
    graphics.fillStyle(color, alpha);
    graphics.beginPath();
    graphics.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) graphics.lineTo(points[index].x, points[index].y);
    graphics.closePath();
    graphics.fillPath();
    return true;
}

type ProjectPoint = (point: TerrainPoint) => { x: number; y: number };

function drawClippedPolygon(
    graphics: Phaser.GameObjects.Graphics,
    points: readonly TerrainPoint[],
    rect: TerrainBounds,
    project: ProjectPoint,
    color: number,
    alpha: number
): boolean {
    const clipped = clipPolygonToRect(points, rect);
    return drawScreenPolygon(graphics, clipped.map(project), color, alpha);
}

function drawClippedSegment(
    graphics: Phaser.GameObjects.Graphics,
    from: TerrainPoint,
    to: TerrainPoint,
    rect: TerrainBounds,
    project: ProjectPoint,
    width: number,
    color: number,
    alpha: number
): boolean {
    const clipped = clipSegmentToRect(from, to, rect);
    if (!clipped || samePoint(clipped[0], clipped[1])) return false;
    const a = project(clipped[0]);
    const b = project(clipped[1]);
    graphics.lineStyle(width, color, alpha);
    graphics.lineBetween(a.x, a.y, b.x, b.y);
    return true;
}

function drawBrokenShoreline(
    graphics: Phaser.GameObjects.Graphics,
    feature: GreatLakeFeature,
    rect: TerrainBounds,
    project: ProjectPoint,
    alpha: number,
    mouths: ReadonlyArray<{ point: TerrainPoint; radius: number }>,
    decorationSeed: number
): void {
    const shore = feature.waterBody?.water ?? feature.terrain.contours.water;
    const center = project(feature.terrain.center);
    for (let index = 0; index < shore.length; index++) {
        const from = shore[index];
        const to = shore[(index + 1) % shore.length];
        // The waterline parts at every river mouth: a stroke straight across
        // the flowing junction reads as a hard seam between the two waters.
        if (mouths.some(mouth =>
            Math.hypot(from.x - mouth.point.x, from.y - mouth.point.y) < mouth.radius + 1.9
            || Math.hypot(to.x - mouth.point.x, to.y - mouth.point.y) < mouth.radius + 1.9)) continue;
        // A quiet dark waterline is continuous in world geometry, but is
        // clipped edge-by-edge so no rectangular postcard border is stroked.
        drawClippedSegment(graphics, from, to, rect, project, 1.45, 0x123d50, alpha * 0.42);
        const midpoint = { x: (from.x + to.x) * 0.5, y: (from.y + to.y) * 0.5 };
        const screenMidpoint = project(midpoint);
        const litHalf = screenMidpoint.y < center.y + 5 && screenMidpoint.x < center.x + 90;
        if (!litHalf || hashCoordinate(decorationSeed, index, shore.length, 29) % 7 > 1) continue;
        drawClippedSegment(graphics, from, to, rect, project, 2.45, 0xb8e0dd, alpha * 0.58);
    }
}

/** Broken gravel, ochre sand, and slate shelves interrupt the green waterline. */
function drawShoreMaterials(
    graphics: Phaser.GameObjects.Graphics,
    feature: GreatLakeFeature,
    rect: TerrainBounds,
    project: ProjectPoint,
    alpha: number,
    mouths: ReadonlyArray<{ point: TerrainPoint; radius: number }>,
    decorationSeed: number
): void {
    const bank = feature.waterBody?.bank ?? feature.terrain.contours.bank;
    for (let index = 0; index < bank.length; index++) {
        const group = Math.floor(index / 7);
        const roll = hashCoordinate(decorationSeed, group, 67, 79) % 13;
        if (roll > 3) continue;
        const from = bank[index];
        const to = bank[(index + 1) % bank.length];
        if (mouths.some(mouth =>
            Math.hypot(from.x - mouth.point.x, from.y - mouth.point.y) < mouth.radius + 2.2
            || Math.hypot(to.x - mouth.point.x, to.y - mouth.point.y) < mouth.radius + 2.2)) continue;
        const slate = roll === 0;
        drawClippedSegment(
            graphics,
            from,
            to,
            rect,
            project,
            slate ? 5.2 : 4.5,
            slate ? 0x747b75 : roll === 1 ? 0xa09265 : 0x8d8d62,
            alpha * (slate ? 0.72 : 0.76)
        );
    }
}

function drawRock(
    graphics: Phaser.GameObjects.Graphics,
    point: PointDecoration,
    project: ProjectPoint,
    alpha: number
): void {
    const p = project(point);
    const scale = point.scale;
    graphics.fillStyle(0x1b271e, alpha * 0.18);
    graphics.fillEllipse(p.x + 2 * scale, p.y + 2 * scale, 14 * scale, 5 * scale);
    drawScreenPolygon(graphics, [
        { x: p.x - 6 * scale, y: p.y + scale },
        { x: p.x - 3.5 * scale, y: p.y - 7 * scale },
        { x: p.x + 1.5 * scale, y: p.y - 10 * scale },
        { x: p.x + 7 * scale, y: p.y },
        { x: p.x + 2 * scale, y: p.y + 3 * scale }
    ], 0x657174, alpha * 0.96);
    drawScreenPolygon(graphics, [
        { x: p.x - 3.5 * scale, y: p.y - 7 * scale },
        { x: p.x + 1.5 * scale, y: p.y - 10 * scale },
        { x: p.x + 2 * scale, y: p.y - 1 * scale },
        { x: p.x - 5 * scale, y: p.y + scale }
    ], 0x9aa49f, alpha * 0.9);
}

function drawReeds(
    graphics: Phaser.GameObjects.Graphics,
    point: PointDecoration,
    project: ProjectPoint,
    alpha: number
): void {
    const p = project(point);
    for (let index = 0; index < 4; index++) {
        const offset = (index - 1.5) * 2.2 * point.scale;
        const height = (8 + ((index * 7 + Math.floor(point.phase * 13)) % 6)) * point.scale;
        const lean = Math.sin(point.phase + index * 1.6) * 2.4;
        graphics.lineStyle(Math.max(1, 1.35 * point.scale), index % 2 ? 0x5c8248 : 0x466f42, alpha);
        graphics.lineBetween(p.x + offset, p.y + 1, p.x + offset + lean, p.y - height);
        if (index % 2 === 0) {
            graphics.fillStyle(0x76563b, alpha * 0.95);
            graphics.fillEllipse(p.x + offset + lean, p.y - height + 1.4, 2.3, 5.3);
        }
    }
}

function drawFish(
    graphics: Phaser.GameObjects.Graphics,
    point: PointDecoration,
    project: ProjectPoint,
    alpha: number
): void {
    const p = project(point);
    const length = 4.5 * point.scale;
    const vx = Math.cos(point.phase) * length;
    const vy = Math.sin(point.phase) * length * 0.48;
    const nx = -Math.sin(point.phase) * 1.55 * point.scale;
    const ny = Math.cos(point.phase) * 0.78 * point.scale;
    drawScreenPolygon(graphics, [
        { x: p.x + vx, y: p.y + vy },
        { x: p.x + nx, y: p.y + ny },
        { x: p.x - vx * 0.72, y: p.y - vy * 0.72 },
        { x: p.x - nx, y: p.y - ny }
    ], 0x123c49, alpha * 0.5);
    drawScreenPolygon(graphics, [
        { x: p.x - vx * 0.68, y: p.y - vy * 0.68 },
        { x: p.x - vx - nx * 1.4, y: p.y - vy - ny * 1.4 },
        { x: p.x - vx + nx * 1.4, y: p.y - vy + ny * 1.4 }
    ], 0x1b4b58, alpha * 0.48);
}

function drawLily(
    graphics: Phaser.GameObjects.Graphics,
    point: PointDecoration,
    project: ProjectPoint,
    alpha: number
): void {
    const p = project(point);
    const size = 3.4 * point.scale;
    graphics.fillStyle(hashCoordinate(Math.floor(point.phase * 1000), 1, 2) % 2 ? 0x5a844d : 0x6a9657, alpha * 0.92);
    graphics.fillEllipse(p.x, p.y, size * 2, size);
    graphics.lineStyle(0.9, 0x315d3a, alpha * 0.8);
    graphics.lineBetween(p.x, p.y, p.x + Math.cos(point.phase) * size, p.y + Math.sin(point.phase) * size * 0.42);
}

function drawDuck(
    graphics: Phaser.GameObjects.Graphics,
    point: PointDecoration,
    project: ProjectPoint,
    alpha: number
): void {
    const p = project(point);
    const facing = Math.cos(point.phase) < 0 ? -1 : 1;
    graphics.lineStyle(1, 0xc1dfe0, alpha * 0.34);
    graphics.lineBetween(p.x - facing * 12, p.y - 1, p.x - facing * 5, p.y);
    graphics.lineBetween(p.x - facing * 11, p.y + 2, p.x - facing * 4, p.y + 1);
    graphics.fillStyle(0x72533a, alpha);
    graphics.fillEllipse(p.x, p.y, 10 * point.scale, 5.5 * point.scale);
    graphics.fillStyle(0x2d5b43, alpha);
    graphics.fillCircle(p.x + facing * 4 * point.scale, p.y - 3.4 * point.scale, 2.55 * point.scale);
    graphics.fillStyle(0xd99c3e, alpha);
    graphics.fillTriangle(
        p.x + facing * 5.8 * point.scale, p.y - 3.5 * point.scale,
        p.x + facing * 9 * point.scale, p.y - 2.4 * point.scale,
        p.x + facing * 5.8 * point.scale, p.y - 1.9 * point.scale
    );
}

function drawHeron(
    graphics: Phaser.GameObjects.Graphics,
    point: PointDecoration,
    project: ProjectPoint,
    alpha: number
): void {
    const p = project(point);
    const facing = Math.cos(point.phase) < 0 ? -1 : 1;
    graphics.lineStyle(1.15, 0x9aa8a2, alpha);
    graphics.lineBetween(p.x - 1.3, p.y, p.x - 0.5, p.y - 10 * point.scale);
    graphics.lineBetween(p.x + 1.3, p.y, p.x + 0.5, p.y - 10 * point.scale);
    graphics.fillStyle(0xc3cbc4, alpha);
    graphics.fillEllipse(p.x, p.y - 15 * point.scale, 6 * point.scale, 12 * point.scale);
    graphics.lineStyle(2, 0xc3cbc4, alpha);
    graphics.lineBetween(p.x + facing * 1.5, p.y - 19 * point.scale, p.x + facing * 4, p.y - 25 * point.scale);
    graphics.fillStyle(0xd1d6cf, alpha);
    graphics.fillCircle(p.x + facing * 4, p.y - 26 * point.scale, 2.2 * point.scale);
    graphics.lineStyle(1.2, 0xc49a4b, alpha);
    graphics.lineBetween(p.x + facing * 6, p.y - 26 * point.scale, p.x + facing * 12, p.y - 25 * point.scale);
}

function drawShorelineTree(
    graphics: Phaser.GameObjects.Graphics,
    tree: TreeDecoration,
    project: ProjectPoint,
    alpha: number
): void {
    const p = project(tree);
    const scale = tree.scale;
    graphics.fillStyle(0x172215, alpha * 0.21);
    graphics.fillEllipse(p.x + 5 * scale, p.y + 4 * scale, (tree.kind === 'conifer' ? 31 : 39) * scale, 11 * scale);
    if (tree.kind === 'conifer') {
        // The trunk remains visible below the lowest bough, with two roots
        // pinning the tree to the continuous mainland lawn.
        drawScreenPolygon(graphics, [
            { x: p.x - 3 * scale, y: p.y + 1.5 * scale },
            { x: p.x - 1.6 * scale, y: p.y - 29 * scale },
            { x: p.x + 2 * scale, y: p.y - 29 * scale },
            { x: p.x + 4 * scale, y: p.y + 1.5 * scale }
        ], 0x583a24, alpha);
        graphics.lineStyle(1.5 * scale, 0x6f4929, alpha * 0.85);
        graphics.lineBetween(p.x - 1, p.y, p.x - 8 * scale, p.y + 3 * scale);
        graphics.lineBetween(p.x + 1, p.y, p.x + 8 * scale, p.y + 2 * scale);
        const palette = hashCoordinate(Math.floor(tree.phase * 1000), 7, 19) % 2 === 0
            ? [0x173f2d, 0x23573c, 0x35714b, 0x4a855b]
            : [0x1d4229, 0x2b5933, 0x3c7040, 0x56864e];
        const tiers = [
            { y: -10, width: 36, height: 20 },
            { y: -22, width: 31, height: 21 },
            { y: -35, width: 24, height: 21 },
            { y: -48, width: 15, height: 19 }
        ];
        tiers.forEach((tier, index) => {
            const lean = Math.sin(tree.phase + index * 2.1) * 1.7 * scale;
            const baseY = p.y + tier.y * scale;
            const apex = { x: p.x + lean, y: baseY - tier.height * scale };
            const left = { x: p.x - tier.width * 0.56 * scale, y: baseY };
            const right = { x: p.x + tier.width * 0.5 * scale, y: baseY + 1.3 * scale };
            drawScreenPolygon(graphics, [left, right, apex], palette[index], alpha);
            drawScreenPolygon(graphics, [apex, right, { x: p.x + 1.4 * scale, y: baseY - 2 * scale }], 0x102f25, alpha * 0.24);
            drawScreenPolygon(graphics, [left, apex, { x: p.x - 1 * scale, y: baseY - 3 * scale }], 0x86a975, alpha * 0.15);
        });
        return;
    }

    drawScreenPolygon(graphics, [
        { x: p.x - 5.5 * scale, y: p.y + 2 * scale },
        { x: p.x - 2.6 * scale, y: p.y - 26 * scale },
        { x: p.x + 2.7 * scale, y: p.y - 26 * scale },
        { x: p.x + 6 * scale, y: p.y + 2 * scale }
    ], 0x634229, alpha);
    graphics.lineStyle(2.1 * scale, 0x634229, alpha);
    graphics.lineBetween(p.x - 1.5 * scale, p.y - 19 * scale, p.x - 11 * scale, p.y - 33 * scale);
    graphics.lineBetween(p.x + 1.5 * scale, p.y - 18 * scale, p.x + 12 * scale, p.y - 31 * scale);
    const palettes = [
        [0x28552f, 0x3b703c, 0x4f864b, 0x6a995d],
        [0x31502a, 0x486937, 0x607f43, 0x7c9855]
    ];
    const tones = palettes[hashCoordinate(Math.floor(tree.phase * 1000), 13, 23) % palettes.length];
    const lobes = [
        [-15, -27, 17, 12], [-5, -37, 20, 14], [8, -39, 19, 14],
        [17, -27, 17, 12], [4, -24, 23, 15], [-12, -18, 16, 10]
    ];
    lobes.forEach(([ox, oy, width, height], index) => {
        graphics.fillStyle(tones[index % 3], alpha * 0.98);
        graphics.fillEllipse(
            p.x + (ox + Math.sin(tree.phase + index * 1.9) * 1.4) * scale,
            p.y + oy * scale,
            width * scale,
            height * scale
        );
    });
    graphics.fillStyle(tones[3], alpha * 0.72);
    graphics.fillEllipse(p.x - 10 * scale, p.y - 42 * scale, 10 * scale, 6 * scale);
    graphics.fillEllipse(p.x + 3 * scale, p.y - 46 * scale, 9 * scale, 5.5 * scale);
}

function drawFallenLog(
    graphics: Phaser.GameObjects.Graphics,
    log: PointDecoration,
    project: ProjectPoint,
    alpha: number
): void {
    const p = project(log);
    const screenAngle = Math.atan2(Math.sin(log.phase) * 0.5, Math.cos(log.phase));
    const dx = Math.cos(screenAngle) * 17 * log.scale;
    const dy = Math.sin(screenAngle) * 17 * log.scale;
    graphics.fillStyle(0x172215, alpha * 0.17);
    graphics.fillEllipse(p.x + 4, p.y + 4, 40 * log.scale, 9 * log.scale);
    graphics.lineStyle(8 * log.scale, 0x573820, alpha);
    graphics.lineBetween(p.x - dx, p.y - dy, p.x + dx, p.y + dy);
    graphics.lineStyle(2.1 * log.scale, 0x93623a, alpha * 0.86);
    graphics.lineBetween(p.x - dx * 0.9, p.y - dy * 0.9 - 1.5, p.x + dx * 0.82, p.y + dy * 0.82 - 1.5);
    graphics.fillStyle(0xa57d50, alpha);
    graphics.fillEllipse(p.x + dx, p.y + dy, 7 * log.scale, 5 * log.scale);
    graphics.lineStyle(2.2 * log.scale, 0x573820, alpha);
    graphics.lineBetween(p.x - dx * 0.2, p.y - dy * 0.2, p.x - dx * 0.15 - 8, p.y - dy * 0.15 - 8);
}

function drawIslandTree(
    graphics: Phaser.GameObjects.Graphics,
    island: IslandDecoration,
    project: ProjectPoint,
    alpha: number
): void {
    const p = project(island);
    const scale = clamp((island.radiusX + island.radiusY) * 0.16, 0.65, 1.05);
    graphics.fillStyle(0x1a2519, alpha * 0.18);
    graphics.fillEllipse(p.x + 4 * scale, p.y + 4 * scale, 29 * scale, 9 * scale);
    graphics.fillStyle(0x5c3e27, alpha);
    graphics.fillRect(p.x - 2.3 * scale, p.y - 24 * scale, 4.8 * scale, 26 * scale);
    const tiers = [
        { y: -8, width: 29, height: 18, color: 0x1c4b35 },
        { y: -19, width: 25, height: 18, color: 0x296143 },
        { y: -30, width: 19, height: 17, color: 0x397552 },
        { y: -40, width: 12, height: 15, color: 0x4a8460 }
    ];
    for (const tier of tiers) {
        graphics.fillStyle(tier.color, alpha);
        graphics.fillTriangle(
            p.x - tier.width * 0.55 * scale, p.y + tier.y * scale,
            p.x + tier.width * 0.5 * scale, p.y + tier.y * scale,
            p.x - 1.5 * scale, p.y + (tier.y - tier.height) * scale
        );
    }
}

function drawIsland(
    graphics: Phaser.GameObjects.Graphics,
    island: IslandDecoration,
    rect: TerrainBounds,
    project: ProjectPoint,
    alpha: number
): number {
    let count = 0;
    const center = { x: island.x, y: island.y };
    const bank = irregularLoop(center, island.radiusX, island.radiusY, island.seed, 22);
    const earth = irregularLoop(center, island.radiusX * 0.88, island.radiusY * 0.86, island.seed ^ 0x517cc1b7, 20);
    const green = irregularLoop(center, island.radiusX * 0.78, island.radiusY * 0.76, island.seed ^ 0x9e3779b9, 18);
    if (drawClippedPolygon(graphics, bank, rect, project, 0x858469, alpha)) count++;
    if (drawClippedPolygon(graphics, earth, rect, project, 0x96895e, alpha)) count++;
    if (drawClippedPolygon(graphics, green, rect, project, 0x5f814e, alpha)) count++;
    if (pointInsideRect(center, rect, 2.4)) {
        drawRock(graphics, {
            x: island.x - island.radiusX * 0.33,
            y: island.y + island.radiusY * 0.12,
            phase: 0,
            scale: 0.55 + (island.seed % 17) / 40
        }, project, alpha);
        drawIslandTree(graphics, island, project, alpha);
        if (island.radiusX > 3.45) {
            const companion: TreeDecoration = {
                x: island.x + island.radiusX * 0.28,
                y: island.y - island.radiusY * 0.14,
                kind: island.seed % 2 === 0 ? 'broadleaf' : 'conifer',
                phase: (island.seed % 997) / 997 * TAU,
                scale: clamp((island.radiusX + island.radiusY) * 0.105, 0.72, 1.02)
            };
            drawShorelineTree(graphics, companion, project, alpha);
            drawRock(graphics, {
                x: island.x + island.radiusX * 0.48,
                y: island.y + island.radiusY * 0.18,
                phase: 0,
                scale: 0.48 + (island.seed % 11) / 50
            }, project, alpha);
        }
    }
    return count;
}

function nodeByKind(feature: GreatLakeFeature, kind: RiverNode['kind']): RiverNode | undefined {
    return feature.network.nodes.find(node => node.kind === kind);
}

function drawSpringAndWetlandBanks(
    graphics: Phaser.GameObjects.Graphics,
    feature: GreatLakeFeature,
    rect: TerrainBounds,
    project: ProjectPoint,
    alpha: number
): number {
    let count = 0;
    const source = nodeByKind(feature, 'source');
    if (source) {
        if (drawClippedPolygon(graphics,
            irregularLoop(source.point, 2.25, 1.65, feature.seed ^ 0x243f6a88, 18),
            rect, project, 0x666b50, alpha)) count++;
    }
    const sink = nodeByKind(feature, 'sink');
    if (sink) {
        const wetlandLobes = [
            { x: 0, y: 0, rx: 5.2, ry: 3.6, salt: 0x85a308d3 },
            { x: 3.5, y: -1.8, rx: 3.2, ry: 2.15, salt: 0x13198a2e },
            { x: -3.1, y: 2.1, rx: 2.9, ry: 1.95, salt: 0x03707344 },
            { x: 1.2, y: 3.1, rx: 2.5, ry: 1.7, salt: 0xa458fea3 }
        ];
        for (const lobe of wetlandLobes) {
            if (drawClippedPolygon(graphics, irregularLoop(
                { x: sink.point.x + lobe.x, y: sink.point.y + lobe.y },
                lobe.rx, lobe.ry, feature.seed ^ lobe.salt, 18
            ), rect, project, 0x686d50, alpha * 0.96)) count++;
        }
    }
    return count;
}

function drawSpringAndWetlandWater(
    graphics: Phaser.GameObjects.Graphics,
    feature: GreatLakeFeature,
    rect: TerrainBounds,
    project: ProjectPoint,
    alpha: number
): number {
    let count = 0;
    const source = nodeByKind(feature, 'source');
    if (source) {
        if (drawClippedPolygon(graphics,
            irregularLoop(source.point, 1.48, 1.08, feature.seed ^ 0xa4093822, 17),
            rect, project, 0x46969c, alpha)) count++;
        if (drawClippedPolygon(graphics,
            irregularLoop(source.point, 0.68, 0.49, feature.seed ^ 0x299f31d0, 13),
            rect, project, 0x23667b, alpha)) count++;
    }
    const sink = nodeByKind(feature, 'sink');
    if (sink) {
        const waterLobes = [
            { x: 0, y: 0, rx: 4.25, ry: 2.75, salt: 0x082efa98 },
            { x: 3.25, y: -1.65, rx: 2.45, ry: 1.55, salt: 0xec4e6c89 },
            { x: -2.85, y: 1.9, rx: 2.15, ry: 1.3, salt: 0x452821e6 },
            { x: 1.05, y: 2.85, rx: 1.8, ry: 1.08, salt: 0x38d01377 }
        ];
        for (const lobe of waterLobes) {
            if (drawClippedPolygon(graphics, irregularLoop(
                { x: sink.point.x + lobe.x, y: sink.point.y + lobe.y },
                lobe.rx, lobe.ry, feature.seed ^ lobe.salt, 17
            ), rect, project, 0x4b9295, alpha)) count++;
        }
    }
    return count;
}

function drawWhitewater(
    graphics: Phaser.GameObjects.Graphics,
    feature: GreatLakeFeature,
    rect: TerrainBounds,
    project: ProjectPoint,
    alpha: number,
    seed: number
): void {
    for (const reach of feature.network.reaches) {
        if (reach.kind === 'lake-passage' || reach.speed < 0.8) continue;
        // Current speed IS the whitewater dial: a fast outflow shows a few
        // streaks, true rapids boil with rocks, wakes, crests and spray.
        const intensity = clamp((reach.speed - 0.8) / 0.9, 0, 1);
        const points = reach.points;
        for (let segment = 0; segment + 1 < points.length; segment++) {
            const from = points[segment];
            const to = points[segment + 1];
            const direction = normalizeVector(to.x - from.x, to.y - from.y);
            const normal = { x: -direction.y, y: direction.x };
            const at = (t: number, side: number): TerrainPoint => ({
                x: from.x + (to.x - from.x) * t + normal.x * side,
                y: from.y + (to.y - from.y) * t + normal.y * side
            });

            // A mid-channel stone parts the current: a white V-wake peels
            // off it downstream, the way fast water actually reads from above.
            if (intensity >= 0.5 && segment % 4 === 0) {
                const stone = at(0.52, (hashUnit(seed, segment, 1, 46) - 0.5) * reach.width * 0.3);
                if (pointInsideRect(stone, rect, 0.65)) {
                    drawRock(graphics, {
                        ...stone,
                        phase: hashUnit(seed, segment, 0, 40) * TAU,
                        scale: 0.42 + hashUnit(seed, segment, 0, 42) * 0.26
                    }, project, alpha * 0.95);
                }
                for (const side of [-1, 1]) {
                    const reachLength = 1.25 + hashUnit(seed, segment, side + 3, 49) * 0.75;
                    const wakeFrom = {
                        x: stone.x + direction.x * 0.28 + normal.x * side * 0.22,
                        y: stone.y + direction.y * 0.28 + normal.y * side * 0.22
                    };
                    const wakeTo = {
                        x: stone.x + direction.x * reachLength + normal.x * side * 0.62,
                        y: stone.y + direction.y * reachLength + normal.y * side * 0.62
                    };
                    drawClippedSegment(graphics, wakeFrom, wakeTo, rect, project, 1.7, 0xe5f4f1, alpha * 0.58);
                }
            }

            // Riffle bars: broken white crests ACROSS the channel where the
            // bed steps down, each bowed downstream, with a fainter echo.
            const bars = intensity >= 0.5
                ? (segment % 3 === 0 ? (hashCoordinate(seed, segment, 47) % 3 === 0 ? 2 : 1) : 0)
                : (segment % 5 === 0 && hashCoordinate(seed, segment, 47) % 2 === 0 ? 1 : 0);
            for (let bar = 0; bar < bars; bar++) {
                const t = 0.2 + hashUnit(seed, segment, bar, 41) * 0.55;
                const span = reach.width * (0.24 + hashUnit(seed, segment, bar, 43) * 0.16);
                const bow = 0.34 + hashUnit(seed, segment, bar, 45) * 0.3;
                const left = at(t, -span);
                const right = at(t, span);
                const crest = {
                    x: (left.x + right.x) / 2 + direction.x * bow,
                    y: (left.y + right.y) / 2 + direction.y * bow
                };
                const crestAlpha = alpha * (0.45 + intensity * 0.35);
                drawClippedSegment(graphics, left, crest, rect, project, 2.5, 0xe5f4f1, crestAlpha);
                drawClippedSegment(graphics, crest, right, rect, project, 2.5, 0xe5f4f1, crestAlpha);
                const echoShift = bow + 0.55;
                const echoLeft = {
                    x: left.x * 0.6 + right.x * 0.4 + direction.x * echoShift,
                    y: left.y * 0.6 + right.y * 0.4 + direction.y * echoShift
                };
                const echoRight = {
                    x: right.x * 0.6 + left.x * 0.4 + direction.x * echoShift,
                    y: right.y * 0.6 + left.y * 0.4 + direction.y * echoShift
                };
                drawClippedSegment(graphics, echoLeft, echoRight, rect, project, 1.7, 0xb8dcdd, alpha * 0.48);
                // Thrown spray: a couple of bright flecks off the crest.
                for (let fleck = 0; fleck < (intensity >= 0.5 ? 2 : 1); fleck++) {
                    const spot = at(
                        t + 0.06 + hashUnit(seed, segment, bar * 3 + fleck, 51) * 0.1,
                        (hashUnit(seed, segment, bar * 3 + fleck, 52) - 0.5) * span * 1.7
                    );
                    if (!pointInsideRect(spot, rect, 0.4)) continue;
                    const screenSpot = project(spot);
                    graphics.fillStyle(0xf2fbf9, alpha * 0.7);
                    graphics.fillCircle(screenSpot.x, screenSpot.y, 1.15);
                }
            }
        }
    }
}

/** The lakeshore mainland grows the same tall grass as everywhere else. */
function drawGrassTuft(
    graphics: Phaser.GameObjects.Graphics,
    point: PointDecoration,
    project: ProjectPoint,
    alpha: number
): void {
    const p = project(point);
    // Drawn heavy so the silhouette survives postcard caching and camera zoom.
    for (let index = 0; index < 4; index++) {
        const offset = (index - 1.5) * 2.2 * point.scale;
        const height = (5.5 + ((index * 5 + Math.floor(point.phase * 11)) % 5)) * point.scale;
        const lean = Math.sin(point.phase + index * 1.9) * 2.4;
        graphics.lineStyle(Math.max(1.6, 2.3 * point.scale), index % 2 ? 0x46603c : 0x53724a, alpha * 0.95);
        graphics.lineBetween(p.x + offset, p.y + 0.5, p.x + offset + lean, p.y - height);
    }
}

function drawMainlandTufts(
    graphics: Phaser.GameObjects.Graphics,
    feature: GreatLakeFeature,
    rect: TerrainBounds,
    project: ProjectPoint,
    alpha: number,
    decorationSeed: number
): void {
    const spacing = 3.4;
    const minX = Math.floor(rect.minX / spacing) - 1;
    const maxX = Math.ceil(rect.maxX / spacing) + 1;
    const minY = Math.floor(rect.minY / spacing) - 1;
    const maxY = Math.ceil(rect.maxY / spacing) + 1;
    for (let cellY = minY; cellY <= maxY; cellY++) {
        for (let cellX = minX; cellX <= maxX; cellX++) {
            if (hashUnit(decorationSeed, cellX, cellY, 61) > 0.52) continue;
            const point = {
                x: (cellX + 0.2 + hashUnit(decorationSeed, cellX, cellY, 62) * 0.6) * spacing,
                y: (cellY + 0.2 + hashUnit(decorationSeed, cellX, cellY, 63) * 0.6) * spacing
            };
            if (!pointInsideRect(point, rect, 0.5)) continue;
            if (insideWaterBank(feature, point.x, point.y)) continue;
            if (nearOpenRiver(feature, point, 0.9)) continue;
            drawGrassTuft(graphics, {
                ...point,
                phase: hashUnit(decorationSeed, cellX, cellY, 64) * TAU,
                scale: 0.7 + hashUnit(decorationSeed, cellX, cellY, 65) * 0.5
            }, project, alpha);
        }
    }
}

function drawReflections(
    graphics: Phaser.GameObjects.Graphics,
    feature: GreatLakeFeature,
    rect: TerrainBounds,
    project: ProjectPoint,
    alpha: number,
    islands: readonly IslandDecoration[],
    decorationSeed: number
): void {
    const spacing = 5.8;
    const minX = Math.floor(rect.minX / spacing) - 1;
    const maxX = Math.ceil(rect.maxX / spacing) + 1;
    const minY = Math.floor(rect.minY / spacing) - 1;
    const maxY = Math.ceil(rect.maxY / spacing) + 1;
    for (let cellY = minY; cellY <= maxY; cellY++) {
        for (let cellX = minX; cellX <= maxX; cellX++) {
            if (hashUnit(decorationSeed, cellX, cellY, 53) > 0.58) continue;
            const point = {
                x: (cellX + 0.25 + hashUnit(decorationSeed, cellX, cellY, 54) * 0.5) * spacing,
                y: (cellY + 0.25 + hashUnit(decorationSeed, cellX, cellY, 55) * 0.5) * spacing
            };
            if (!pointInsideRect(point, rect, 0.8)
                || feature.terrain.sampleDepth(point.x, point.y) < 0.18
                || decorationWithinIsland(point, islands)) continue;
            const p = project(point);
            const width = 15 + hashUnit(decorationSeed, cellX, cellY, 56) * 30;
            const bold = hashCoordinate(decorationSeed, cellX, cellY, 57) % 4 === 0;
            graphics.lineStyle(bold ? 4 : 2.45,
                bold ? 0xd7edeb : 0xa9d5d3,
                alpha * (0.3 + hashUnit(decorationSeed, cellX, cellY, 58) * 0.25));
            graphics.lineBetween(p.x - width * 0.62, p.y, p.x + width * 0.38, p.y);
            if (bold) {
                graphics.lineStyle(1.45, 0x8fc5c8, alpha * 0.3);
                graphics.lineBetween(p.x - width * 0.42, p.y + 4, p.x + width * 0.27, p.y + 4);
            }
        }
    }
}

function drawEndpointDetails(
    graphics: Phaser.GameObjects.Graphics,
    feature: GreatLakeFeature,
    rect: TerrainBounds,
    project: ProjectPoint,
    alpha: number,
    decorationSeed: number
): PointDecoration | null {
    const source = nodeByKind(feature, 'source');
    if (source) {
        const springRock: PointDecoration = {
            x: source.point.x - 0.72,
            y: source.point.y + 0.38,
            phase: 0,
            scale: 0.62
        };
        if (pointInsideRect(springRock, rect, 0.9)) drawRock(graphics, springRock, project, alpha);
    }
    const sink = nodeByKind(feature, 'sink');
    if (!sink) return null;
    let frog: PointDecoration | null = null;
    for (let index = 0; index < 9; index++) {
        const angle = index / 9 * TAU + hashUnit(decorationSeed, index, 71) * 0.35;
        const radiusX = 3.25 + hashUnit(decorationSeed, index, 72) * 1.85;
        const radiusY = 2 + hashUnit(decorationSeed, index, 73) * 1.2;
        const reed: PointDecoration = {
            x: sink.point.x + Math.cos(angle) * radiusX,
            y: sink.point.y + Math.sin(angle) * radiusY,
            phase: hashUnit(decorationSeed, index, 74) * TAU,
            scale: 0.72 + hashUnit(decorationSeed, index, 75) * 0.42
        };
        if (!pointInsideRect(reed, rect, 0.8)) continue;
        drawReeds(graphics, reed, project, alpha);
        if (!frog && index === decorationSeed % 9) frog = reed;
    }
    return frog;
}

function localLifeAnchor(
    feature: GreatLakeFeature,
    kind: HydrologyLifeKind,
    point: PointDecoration,
    rect: TerrainBounds,
    window: WorldHydrologyRenderWindow
): HydrologyLifeAnchor {
    return {
        featureId: feature.id,
        kind,
        worldX: point.x,
        worldY: point.y,
        localGridX: window.localGridX + point.x - rect.minX,
        localGridY: window.localGridY + point.y - rect.minY,
        phase: point.phase,
        scale: point.scale
    };
}

/**
 * Renderer for cached, absolute Great Lake geometry. It never calls random at
 * frame time: decoration placement is a pure function of feature seed and
 * absolute lattice coordinates, while motion is returned as life anchors.
 */
export class WorldHydrologyRenderer {
    /** Include in postcard cache keys whenever hydrology vector art changes. */
    static readonly RENDER_VERSION = 8;

    static drawFeature(
        graphics: Phaser.GameObjects.Graphics,
        feature: GreatLakeFeature,
        window: WorldHydrologyRenderWindow
    ): WorldHydrologyRenderResult {
        const rect = normalizeHydrologyClipRect(window.clip);
        const alpha = clamp(window.alpha ?? 1, 0, 1);
        const includeDetails = window.includeDetails ?? true;
        const presentationSeedVersion = normalizeWorldNatureSeedVersion(window.presentationSeedVersion);
        const decorationSeed = worldHydrologyDecorationSeed(feature.seed, presentationSeedVersion);
        // Geometry remains exact in absolute world tiles. Seams are handled by
        // the caller using one consistent postcard LOD, not by painting over
        // plot edges and distorting a continuous shoreline.
        const renderRect = rect;
        if (alpha <= 0 || !boundsIntersect(feature.worldBounds, rect)) {
            return Object.freeze({
                featureId: feature.id,
                visible: false,
                lakePolygons: 0,
                riverPolygons: 0,
                life: Object.freeze([])
            });
        }
        const project: ProjectPoint = point => IsoUtils.cartToIso(
            window.localGridX + point.x - rect.minX,
            window.localGridY + point.y - rect.minY
        );
        let lakePolygons = 0;
        let riverPolygons = 0;
        const unified = feature.waterBody;
        const bands = unified ? [] : riverGeometry(feature);
        const mouths = unified ? [] : riverMouths(feature);

        if (unified) {
            // ONE border for the whole water system: every band was contoured
            // from the combined lake+river depth field, so the river leaves
            // the lake through a single continuous shoreline — nothing is
            // stitched, patched or plugged at the mouth.
            if (drawClippedPolygon(graphics, unified.bank, renderRect, project, LAKE_BANK_COLOR, alpha)) lakePolygons++;
            drawShoreMaterials(graphics, feature, renderRect, project, alpha, mouths, decorationSeed);
            riverPolygons += drawSpringAndWetlandBanks(graphics, feature, renderRect, project, alpha);
            if (drawClippedPolygon(graphics, unified.water, renderRect, project, LAKE_SHALLOW_COLOR, alpha)) lakePolygons++;
            if (drawClippedPolygon(graphics, unified.mid, renderRect, project, LAKE_MID_COLOR, alpha)) lakePolygons++;
            if (drawClippedPolygon(graphics, unified.deep, renderRect, project, LAKE_DEEP_COLOR, alpha)) lakePolygons++;
            riverPolygons += drawSpringAndWetlandWater(graphics, feature, renderRect, project, alpha);
        } else {
            // Fallback for a degenerate field: the classic stitched layers.
            if (drawClippedPolygon(graphics, feature.terrain.contours.bank, renderRect, project, LAKE_BANK_COLOR, alpha)) {
                lakePolygons++;
            }
            drawShoreMaterials(graphics, feature, renderRect, project, alpha, mouths, decorationSeed);
            for (const band of bands) {
                if (drawClippedPolygon(graphics, band.bank, renderRect, project, 0x6f7050, alpha)) riverPolygons++;
            }
            for (const mouth of mouths) {
                if (drawClippedPolygon(graphics,
                    irregularLoop(mouth.point, mouth.radius + 1.7, (mouth.radius + 1.7) * 0.86, feature.seed ^ 0x1b873593, 16),
                    renderRect, project, LAKE_BANK_COLOR, alpha)) riverPolygons++;
            }
            riverPolygons += drawSpringAndWetlandBanks(graphics, feature, renderRect, project, alpha);
            if (drawClippedPolygon(graphics, feature.terrain.contours.water, renderRect, project, LAKE_SHALLOW_COLOR, alpha)) lakePolygons++;
            if (drawClippedPolygon(graphics, feature.terrain.contours.mid, renderRect, project, LAKE_MID_COLOR, alpha)) lakePolygons++;
            if (drawClippedPolygon(graphics, feature.terrain.contours.deep, renderRect, project, LAKE_DEEP_COLOR, alpha)) lakePolygons++;
            for (const band of bands) {
                if (drawClippedPolygon(graphics, band.water, renderRect, project, 0x3f9099, alpha)) riverPolygons++;
                if (drawClippedPolygon(graphics, band.channel, renderRect, project, 0x23677e, alpha)) riverPolygons++;
            }
            for (const mouth of mouths) {
                if (drawClippedPolygon(graphics,
                    irregularLoop(mouth.point, mouth.radius + 0.55, (mouth.radius + 0.55) * 0.84, feature.seed ^ 0x85ebca6b, 16),
                    renderRect, project, LAKE_SHALLOW_COLOR, alpha)) riverPolygons++;
            }
            riverPolygons += drawSpringAndWetlandWater(graphics, feature, renderRect, project, alpha);
        }
        drawBrokenShoreline(graphics, feature, renderRect, project, alpha, mouths, decorationSeed);
        drawWhitewater(graphics, feature, renderRect, project, alpha, decorationSeed);

        const decorations = buildDecorations(feature, presentationSeedVersion);
        for (const island of decorations.islands) {
            lakePolygons += drawIsland(graphics, island, renderRect, project, alpha);
        }

        const life: HydrologyLifeAnchor[] = [];
        if (includeDetails) {
            drawReflections(graphics, feature, rect, project, alpha, decorations.islands, decorationSeed);
            drawMainlandTufts(graphics, feature, rect, project, alpha, decorationSeed);
            const endpointFrog = drawEndpointDetails(graphics, feature, rect, project, alpha, decorationSeed);
            if (endpointFrog) life.push(localLifeAnchor(feature, 'frog', endpointFrog, rect, window));
            for (const lily of decorations.lilies) {
                if (pointInsideRect(lily, rect, 0.45)) drawLily(graphics, lily, project, alpha);
            }
            for (const fish of decorations.fish) {
                if (!pointInsideRect(fish, rect, 0.45)) continue;
                drawFish(graphics, fish, project, alpha);
                if (life.length < 14) life.push(localLifeAnchor(feature, 'fish', fish, rect, window));
            }
            const mainlandDetails: Array<
                { point: PointDecoration; draw: () => void }
            > = [
                ...decorations.rocks.map(rock => ({ point: rock, draw: () => drawRock(graphics, rock, project, alpha) })),
                ...decorations.logs.map(log => ({ point: log, draw: () => drawFallenLog(graphics, log, project, alpha) })),
                ...decorations.trees.map(tree => ({ point: tree, draw: () => drawShorelineTree(graphics, tree, project, alpha) }))
            ];
            mainlandDetails.sort((a, b) => (a.point.x + a.point.y) - (b.point.x + b.point.y));
            for (const detail of mainlandDetails) {
                if (pointInsideRect(detail.point, rect, detail.point.scale > 1.25 ? 1.35 : 1.05)) detail.draw();
            }
            for (const reed of decorations.reeds) {
                if (pointInsideRect(reed, rect, 0.8)) drawReeds(graphics, reed, project, alpha);
            }
            if (decorations.duck && pointInsideRect(decorations.duck, rect, 1)) {
                drawDuck(graphics, decorations.duck, project, alpha);
                life.push(localLifeAnchor(feature, 'duck', decorations.duck, rect, window));
            }
            if (decorations.frog && pointInsideRect(decorations.frog, rect, 0.8)) {
                life.push(localLifeAnchor(feature, 'frog', decorations.frog, rect, window));
            }
            if (decorations.heron && pointInsideRect(decorations.heron, rect, 1.2)) {
                drawHeron(graphics, decorations.heron, project, alpha);
                life.push(localLifeAnchor(feature, 'heron', decorations.heron, rect, window));
            }
        }

        return Object.freeze({
            featureId: feature.id,
            visible: lakePolygons + riverPolygons > 0,
            lakePolygons,
            riverPolygons,
            life: Object.freeze(life)
        });
    }

    static drawFeatures(
        graphics: Phaser.GameObjects.Graphics,
        features: readonly GreatLakeFeature[],
        window: WorldHydrologyRenderWindow
    ): readonly WorldHydrologyRenderResult[] {
        return Object.freeze(features.map(feature => this.drawFeature(graphics, feature, window)));
    }
}
