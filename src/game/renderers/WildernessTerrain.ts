/**
 * Pure deterministic terrain geometry for wilderness water bodies.
 *
 * The lake is not a perturbed ellipse. We synthesize a small digital elevation
 * model (DEM) from several overlapping depressions and coherent noise, cut one
 * low spill saddle, then run Priority-Flood. The cells raised by the flood are
 * a physically meaningful connected basin. Renderer code can fill the returned
 * contours after mapping their grid-space vertices through the isometric
 * transform; this module deliberately has no Phaser or scene dependency.
 */

export interface TerrainPoint {
    x: number;
    y: number;
}

export interface TerrainBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export type LakeBand = 'bank' | 'water' | 'mid' | 'deep';

export interface LakeContours {
    bank: readonly TerrainPoint[];
    water: readonly TerrainPoint[];
    mid: readonly TerrainPoint[];
    deep: readonly TerrainPoint[];
}

export interface LakeTerrainOptions {
    seed: number;
    centerX: number;
    centerY: number;
    /** Intended outer water radii in grid tiles. */
    radiusX: number;
    radiusY: number;
    /** Optional hard sampling/contour bounds, normally the owning plot. */
    bounds?: TerrainBounds;
    /** Grid spacing in tiles. Defaults to 0.35 and is clamped for safety. */
    sampleStep?: number;
    /** Number of overlapping artificial depressions. Defaults to 3..5. */
    lobeCount?: number;
    /** Width of exposed damp bank outside the water, in tiles. */
    bankWidth?: number;
    /** Closed-curve corner-cutting passes. Defaults to one. */
    smoothingPasses?: number;
}

export interface LakeTerrain {
    readonly seed: number;
    readonly center: TerrainPoint;
    readonly bounds: TerrainBounds;
    readonly columns: number;
    readonly rows: number;
    readonly stepX: number;
    readonly stepY: number;
    readonly spillElevation: number;
    readonly maxDepth: number;
    readonly contours: LakeContours;
    /** Normalized 0..1 depth. Returns zero outside the connected water body. */
    sampleDepth(x: number, y: number): number;
    /** Original synthesized DEM elevation, bilinearly sampled. */
    sampleElevation(x: number, y: number): number;
    /** Polygon containment for a rendered band; defaults to actual water. */
    contains(x: number, y: number, band?: LakeBand): boolean;
}

interface BasinLobe {
    x: number;
    y: number;
    radiusX: number;
    radiusY: number;
    rotation: number;
}

interface HeapNode {
    index: number;
    priority: number;
}

const TAU = Math.PI * 2;
const EPSILON = 1e-9;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function quintic(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

/** A stable 32-bit integer mixer suitable for lattice gradients and streams. */
export function mixTerrainSeed(value: number): number {
    let h = value >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
}

function hashLattice(x: number, y: number, seed: number): number {
    const hx = Math.imul(x | 0, 0x1f123bb5);
    const hy = Math.imul(y | 0, 0x5f356495);
    return mixTerrainSeed((seed ^ hx ^ hy) >>> 0);
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

const GRADIENTS: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2],
    [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]
];

/** Smooth seeded gradient noise, approximately in [-1, 1]. */
export function coherentNoise2D(x: number, y: number, seed: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const u = quintic(tx);
    const v = quintic(ty);

    const dot = (ix: number, iy: number, ox: number, oy: number): number => {
        const gradient = GRADIENTS[hashLattice(ix, iy, seed) & 7];
        return gradient[0] * ox + gradient[1] * oy;
    };
    const top = lerp(dot(x0, y0, tx, ty), dot(x0 + 1, y0, tx - 1, ty), u);
    const bottom = lerp(dot(x0, y0 + 1, tx, ty - 1), dot(x0 + 1, y0 + 1, tx - 1, ty - 1), u);
    return lerp(top, bottom, v) * 1.42;
}

/** Fractal Brownian motion built from the smooth deterministic noise above. */
export function fbmNoise2D(
    x: number,
    y: number,
    seed: number,
    octaves = 4,
    lacunarity = 2,
    gain = 0.5
): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let amplitudeSum = 0;
    const count = clamp(Math.floor(octaves), 1, 8);
    for (let octave = 0; octave < count; octave++) {
        const octaveSeed = mixTerrainSeed(seed + Math.imul(octave + 1, 0x9e3779b9));
        value += coherentNoise2D(x * frequency, y * frequency, octaveSeed) * amplitude;
        amplitudeSum += amplitude;
        amplitude *= gain;
        frequency *= lacunarity;
    }
    return amplitudeSum > 0 ? value / amplitudeSum : 0;
}

class MinHeap {
    private readonly nodes: HeapNode[] = [];

    get size(): number {
        return this.nodes.length;
    }

    push(node: HeapNode): void {
        const nodes = this.nodes;
        let index = nodes.length;
        nodes.push(node);
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (nodes[parent].priority <= node.priority) break;
            nodes[index] = nodes[parent];
            index = parent;
        }
        nodes[index] = node;
    }

    pop(): HeapNode | undefined {
        const nodes = this.nodes;
        if (nodes.length === 0) return undefined;
        const root = nodes[0];
        const tail = nodes.pop();
        if (nodes.length === 0 || !tail) return root;
        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            if (left >= nodes.length) break;
            const right = left + 1;
            let child = left;
            if (right < nodes.length && nodes[right].priority < nodes[left].priority) child = right;
            if (nodes[child].priority >= tail.priority) break;
            nodes[index] = nodes[child];
            index = child;
        }
        nodes[index] = tail;
        return root;
    }
}

/**
 * Fill every DEM depression to its lowest spill elevation using a
 * Priority-Flood traversal. The input is not mutated.
 */
export function priorityFloodFill(
    elevations: Float64Array,
    width: number,
    height: number,
    connectivity: 4 | 8 = 8
): Float64Array {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
        throw new Error('Priority-Flood dimensions must be integers >= 2.');
    }
    if (elevations.length !== width * height) {
        throw new Error(`Priority-Flood DEM length ${elevations.length} does not match ${width}x${height}.`);
    }

    const filled = elevations.slice();
    const visited = new Uint8Array(elevations.length);
    const heap = new MinHeap();
    const enqueue = (index: number): void => {
        if (visited[index]) return;
        const elevation = elevations[index];
        if (!Number.isFinite(elevation)) throw new Error('Priority-Flood DEM contains a non-finite elevation.');
        visited[index] = 1;
        heap.push({ index, priority: elevation });
    };

    for (let x = 0; x < width; x++) {
        enqueue(x);
        enqueue((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
        enqueue(y * width);
        enqueue(y * width + width - 1);
    }

    const offsets4 = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
    const offsets8 = [
        ...offsets4,
        [-1, -1], [1, -1], [-1, 1], [1, 1]
    ] as const;
    const offsets = connectivity === 8 ? offsets8 : offsets4;

    while (heap.size > 0) {
        const current = heap.pop();
        if (!current) break;
        const cx = current.index % width;
        const cy = Math.floor(current.index / width);
        for (const [ox, oy] of offsets) {
            const nx = cx + ox;
            const ny = cy + oy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const index = ny * width + nx;
            if (visited[index]) continue;
            visited[index] = 1;
            const priority = Math.max(elevations[index], current.priority);
            filled[index] = priority;
            heap.push({ index, priority });
        }
    }
    return filled;
}

function smoothMinimum(a: number, b: number, radius: number): number {
    const h = clamp(0.5 + 0.5 * (b - a) / radius, 0, 1);
    return lerp(b, a, h) - radius * h * (1 - h);
}

function validateBounds(bounds: TerrainBounds): TerrainBounds {
    const result = { ...bounds };
    if (![result.minX, result.minY, result.maxX, result.maxY].every(Number.isFinite)
        || result.maxX <= result.minX || result.maxY <= result.minY) {
        throw new Error('Lake terrain bounds must be finite and have positive area.');
    }
    return result;
}

function componentFromAnchor(mask: Uint8Array, width: number, height: number, anchor: number): Uint8Array {
    const component = new Uint8Array(mask.length);
    if (!mask[anchor]) return component;
    const queue = new Int32Array(mask.length);
    let head = 0;
    let tail = 0;
    queue[tail++] = anchor;
    component[anchor] = 1;
    while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        if (x > 0) add(index - 1);
        if (x + 1 < width) add(index + 1);
        if (y > 0) add(index - width);
        if (y + 1 < height) add(index + width);
    }
    return component;

    function add(index: number): void {
        if (!mask[index] || component[index]) return;
        component[index] = 1;
        queue[tail++] = index;
    }
}

function largestComponent(mask: Uint8Array, width: number, height: number): Uint8Array {
    const seen = new Uint8Array(mask.length);
    let best: number[] = [];
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || seen[start]) continue;
        const queue = [start];
        const cells: number[] = [];
        seen[start] = 1;
        for (let head = 0; head < queue.length; head++) {
            const index = queue[head];
            cells.push(index);
            const x = index % width;
            const y = Math.floor(index / width);
            const neighbors = [
                x > 0 ? index - 1 : -1,
                x + 1 < width ? index + 1 : -1,
                y > 0 ? index - width : -1,
                y + 1 < height ? index + width : -1
            ];
            for (const next of neighbors) {
                if (next < 0 || !mask[next] || seen[next]) continue;
                seen[next] = 1;
                queue.push(next);
            }
        }
        if (cells.length > best.length) best = cells;
    }
    const result = new Uint8Array(mask.length);
    for (const index of best) result[index] = 1;
    return result;
}

function fillMaskHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
    const exterior = new Uint8Array(mask.length);
    const queue = new Int32Array(mask.length);
    let head = 0;
    let tail = 0;
    const add = (index: number): void => {
        if (mask[index] || exterior[index]) return;
        exterior[index] = 1;
        queue[tail++] = index;
    };
    for (let x = 0; x < width; x++) {
        add(x);
        add((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
        add(y * width);
        add(y * width + width - 1);
    }
    while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        if (x > 0) add(index - 1);
        if (x + 1 < width) add(index + 1);
        if (y > 0) add(index - width);
        if (y + 1 < height) add(index + width);
    }
    const result = mask.slice();
    for (let i = 0; i < result.length; i++) {
        if (!result[i] && !exterior[i]) result[i] = 1;
    }
    return result;
}

function dilateMask(
    mask: Uint8Array,
    width: number,
    height: number,
    stepX: number,
    stepY: number,
    radius: number
): Uint8Array {
    const result = mask.slice();
    const reachX = Math.ceil(radius / stepX);
    const reachY = Math.ceil(radius / stepY);
    const offsets: Array<readonly [number, number]> = [];
    for (let oy = -reachY; oy <= reachY; oy++) {
        for (let ox = -reachX; ox <= reachX; ox++) {
            if (Math.hypot(ox * stepX, oy * stepY) <= radius + EPSILON) offsets.push([ox, oy]);
        }
    }
    for (let index = 0; index < mask.length; index++) {
        if (!mask[index]) continue;
        const x = index % width;
        const y = Math.floor(index / width);
        for (const [ox, oy] of offsets) {
            const nx = x + ox;
            const ny = y + oy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) result[ny * width + nx] = 1;
        }
    }
    return result;
}

function erodeMask(mask: Uint8Array, width: number, height: number): Uint8Array {
    const result = new Uint8Array(mask.length);
    for (let index = 0; index < mask.length; index++) {
        if (!mask[index]) continue;
        const x = index % width;
        const y = Math.floor(index / width);
        if (x === 0 || x + 1 === width || y === 0 || y + 1 === height) continue;
        if (mask[index - 1] && mask[index + 1] && mask[index - width] && mask[index + width]) result[index] = 1;
    }
    return largestComponent(result, width, height);
}

function maskCount(mask: Uint8Array): number {
    let count = 0;
    for (const value of mask) count += value;
    return count;
}

interface Segment {
    a: TerrainPoint;
    b: TerrainPoint;
}

function pointKey(point: TerrainPoint): string {
    return `${Math.round(point.x * 1e7)},${Math.round(point.y * 1e7)}`;
}

function marchingSegments(
    values: Uint8Array,
    width: number,
    height: number,
    bounds: TerrainBounds,
    stepX: number,
    stepY: number
): Segment[] {
    const segments: Segment[] = [];
    const edgePoint = (x: number, y: number, edge: number): TerrainPoint => {
        const x0 = bounds.minX + x * stepX;
        const y0 = bounds.minY + y * stepY;
        if (edge === 0) return { x: x0 + stepX * 0.5, y: y0 };
        if (edge === 1) return { x: x0 + stepX, y: y0 + stepY * 0.5 };
        if (edge === 2) return { x: x0 + stepX * 0.5, y: y0 + stepY };
        return { x: x0, y: y0 + stepY * 0.5 };
    };
    const add = (x: number, y: number, edgeA: number, edgeB: number): void => {
        segments.push({ a: edgePoint(x, y, edgeA), b: edgePoint(x, y, edgeB) });
    };

    for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
            const tl = values[y * width + x];
            const tr = values[y * width + x + 1];
            const br = values[(y + 1) * width + x + 1];
            const bl = values[(y + 1) * width + x];
            const state = tl | (tr << 1) | (br << 2) | (bl << 3);
            switch (state) {
                case 0:
                case 15:
                    break;
                case 1:
                case 14:
                    add(x, y, 3, 0);
                    break;
                case 2:
                case 13:
                    add(x, y, 0, 1);
                    break;
                case 3:
                case 12:
                    add(x, y, 3, 1);
                    break;
                case 4:
                case 11:
                    add(x, y, 1, 2);
                    break;
                case 5:
                    // Four-connected masks keep the two diagonal islands apart.
                    add(x, y, 3, 0);
                    add(x, y, 1, 2);
                    break;
                case 6:
                case 9:
                    add(x, y, 0, 2);
                    break;
                case 7:
                case 8:
                    add(x, y, 2, 3);
                    break;
                case 10:
                    add(x, y, 0, 1);
                    add(x, y, 2, 3);
                    break;
            }
        }
    }
    return segments;
}

function signedArea(points: readonly TerrainPoint[]): number {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        area += a.x * b.y - b.x * a.y;
    }
    return area * 0.5;
}

function chainLargestLoop(segments: Segment[]): TerrainPoint[] {
    const incident = new Map<string, number[]>();
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        for (const point of [segment.a, segment.b]) {
            const key = pointKey(point);
            const list = incident.get(key);
            if (list) list.push(i);
            else incident.set(key, [i]);
        }
    }
    const used = new Uint8Array(segments.length);
    const loops: TerrainPoint[][] = [];
    for (let startIndex = 0; startIndex < segments.length; startIndex++) {
        if (used[startIndex]) continue;
        const start = segments[startIndex];
        const loop: TerrainPoint[] = [start.a];
        used[startIndex] = 1;
        let current = start.b;
        const startKey = pointKey(start.a);
        let closed = false;
        for (let guard = 0; guard <= segments.length; guard++) {
            if (pointKey(current) === startKey) {
                closed = true;
                break;
            }
            loop.push(current);
            const candidates = incident.get(pointKey(current)) ?? [];
            const nextIndex = candidates.find(index => !used[index]);
            if (nextIndex === undefined) break;
            used[nextIndex] = 1;
            const next = segments[nextIndex];
            current = pointKey(next.a) === pointKey(current) ? next.b : next.a;
        }
        if (closed && loop.length >= 3) loops.push(loop);
    }
    loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    const largest = loops[0] ?? [];
    if (signedArea(largest) < 0) largest.reverse();
    return largest;
}

function distanceToLine(point: TerrainPoint, a: TerrainPoint, b: TerrainPoint): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) + Math.abs(dy) < EPSILON) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
    return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function simplifyOpen(points: readonly TerrainPoint[], tolerance: number): TerrainPoint[] {
    if (points.length <= 2) return points.map(point => ({ ...point }));
    let farthest = -1;
    let maxDistance = tolerance;
    for (let i = 1; i < points.length - 1; i++) {
        const distance = distanceToLine(points[i], points[0], points[points.length - 1]);
        if (distance > maxDistance) {
            farthest = i;
            maxDistance = distance;
        }
    }
    if (farthest < 0) return [{ ...points[0] }, { ...points[points.length - 1] }];
    const left = simplifyOpen(points.slice(0, farthest + 1), tolerance);
    const right = simplifyOpen(points.slice(farthest), tolerance);
    return [...left.slice(0, -1), ...right];
}

function simplifyClosed(points: readonly TerrainPoint[], tolerance: number): TerrainPoint[] {
    if (points.length < 6) return points.map(point => ({ ...point }));
    let split = 1;
    let maxDistance = 0;
    for (let i = 1; i < points.length; i++) {
        const distance = Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y);
        if (distance > maxDistance) {
            maxDistance = distance;
            split = i;
        }
    }
    const first = simplifyOpen(points.slice(0, split + 1), tolerance);
    const second = simplifyOpen([...points.slice(split), points[0]], tolerance);
    const joined = [...first.slice(0, -1), ...second.slice(0, -1)];
    return joined.length >= 3 ? joined : points.map(point => ({ ...point }));
}

function chaikin(points: readonly TerrainPoint[]): TerrainPoint[] {
    if (points.length < 3) return points.map(point => ({ ...point }));
    const result: TerrainPoint[] = [];
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        result.push({ x: lerp(a.x, b.x, 0.25), y: lerp(a.y, b.y, 0.25) });
        result.push({ x: lerp(a.x, b.x, 0.75), y: lerp(a.y, b.y, 0.75) });
    }
    return result;
}

function convexHull(points: readonly TerrainPoint[]): TerrainPoint[] {
    const unique = new Map<string, TerrainPoint>();
    for (const point of points) unique.set(pointKey(point), { ...point });
    const sorted = [...unique.values()].sort((a, b) => a.x - b.x || a.y - b.y);
    if (sorted.length <= 3) return sorted;
    const cross = (a: TerrainPoint, b: TerrainPoint, c: TerrainPoint): number =>
        (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const lower: TerrainPoint[] = [];
    for (const point of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
        lower.push(point);
    }
    const upper: TerrainPoint[] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const point = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
        upper.push(point);
    }
    lower.pop();
    upper.pop();
    return [...lower, ...upper];
}

function orientation(a: TerrainPoint, b: TerrainPoint, c: TerrainPoint): number {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: TerrainPoint, a: TerrainPoint, b: TerrainPoint): boolean {
    if (Math.abs(orientation(a, b, point)) > 1e-8) return false;
    return point.x >= Math.min(a.x, b.x) - 1e-8 && point.x <= Math.max(a.x, b.x) + 1e-8
        && point.y >= Math.min(a.y, b.y) - 1e-8 && point.y <= Math.max(a.y, b.y) + 1e-8;
}

function segmentsIntersect(a: TerrainPoint, b: TerrainPoint, c: TerrainPoint, d: TerrainPoint): boolean {
    const abC = orientation(a, b, c);
    const abD = orientation(a, b, d);
    const cdA = orientation(c, d, a);
    const cdB = orientation(c, d, b);
    if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
        && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true;
    return (Math.abs(abC) <= EPSILON && pointOnSegment(c, a, b))
        || (Math.abs(abD) <= EPSILON && pointOnSegment(d, a, b))
        || (Math.abs(cdA) <= EPSILON && pointOnSegment(a, c, d))
        || (Math.abs(cdB) <= EPSILON && pointOnSegment(b, c, d));
}

/** True when a closed contour has no self intersections or repeated edges. */
export function isSimpleContour(points: readonly TerrainPoint[]): boolean {
    if (points.length < 3) return false;
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || Math.hypot(b.x - a.x, b.y - a.y) < EPSILON) return false;
        for (let j = i + 1; j < points.length; j++) {
            if (j === i || j === i + 1 || (i === 0 && j === points.length - 1)) continue;
            const c = points[j];
            const d = points[(j + 1) % points.length];
            if (segmentsIntersect(a, b, c, d)) return false;
        }
    }
    return true;
}

function makeContour(
    mask: Uint8Array,
    width: number,
    height: number,
    bounds: TerrainBounds,
    stepX: number,
    stepY: number,
    smoothingPasses: number
): TerrainPoint[] {
    const raw = chainLargestLoop(marchingSegments(mask, width, height, bounds, stepX, stepY));
    if (raw.length < 3) {
        let minColumn = width;
        let minRow = height;
        let maxColumn = -1;
        let maxRow = -1;
        for (let index = 0; index < mask.length; index++) {
            if (!mask[index]) continue;
            const column = index % width;
            const row = Math.floor(index / width);
            minColumn = Math.min(minColumn, column);
            maxColumn = Math.max(maxColumn, column);
            minRow = Math.min(minRow, row);
            maxRow = Math.max(maxRow, row);
        }
        if (maxColumn < minColumn || maxRow < minRow) return [];
        const minX = clamp(bounds.minX + (minColumn - 0.5) * stepX, bounds.minX, bounds.maxX);
        const maxX = clamp(bounds.minX + (maxColumn + 0.5) * stepX, bounds.minX, bounds.maxX);
        const minY = clamp(bounds.minY + (minRow - 0.5) * stepY, bounds.minY, bounds.maxY);
        const maxY = clamp(bounds.minY + (maxRow + 0.5) * stepY, bounds.minY, bounds.maxY);
        return chaikin([
            { x: minX, y: minY }, { x: maxX, y: minY },
            { x: maxX, y: maxY }, { x: minX, y: maxY }
        ]);
    }
    const minimumStep = Math.min(stepX, stepY);
    const simplified = simplifyClosed(raw, minimumStep * 0.2);
    let smooth = simplified;
    for (let pass = 0; pass < smoothingPasses; pass++) smooth = chaikin(smooth);
    smooth = simplifyClosed(smooth, minimumStep * 0.1);
    const bounded = smooth.map(point => ({
        x: clamp(point.x, bounds.minX, bounds.maxX),
        y: clamp(point.y, bounds.minY, bounds.maxY)
    }));
    if (isSimpleContour(bounded)) return bounded;
    if (isSimpleContour(simplified)) return simplified;
    // A rare one-cell diagonal saddle can make a marching loop kiss itself.
    // The hull is a deterministic, bounded last resort and is normally hidden
    // behind the more detailed inner band; never return invalid geometry.
    let fallback = convexHull(raw);
    for (let pass = 0; pass < smoothingPasses; pass++) fallback = chaikin(fallback);
    if (isSimpleContour(fallback)) return fallback;
    const xs = raw.map(point => point.x);
    const ys = raw.map(point => point.y);
    let box: TerrainPoint[] = [
        { x: Math.min(...xs), y: Math.min(...ys) },
        { x: Math.max(...xs), y: Math.min(...ys) },
        { x: Math.max(...xs), y: Math.max(...ys) },
        { x: Math.min(...xs), y: Math.max(...ys) }
    ];
    for (let pass = 0; pass < Math.max(1, smoothingPasses); pass++) box = chaikin(box);
    return box;
}

/** Point-in-polygon with boundary points treated as contained. */
export function contourContains(points: readonly TerrainPoint[], x: number, y: number): boolean {
    if (points.length < 3) return false;
    const point = { x, y };
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[j];
        const b = points[i];
        if (pointOnSegment(point, a, b)) return true;
        if ((a.y > y) !== (b.y > y)) {
            const crossX = (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x;
            if (x < crossX) inside = !inside;
        }
    }
    return inside;
}

function bilinearSample(
    values: Float64Array,
    width: number,
    height: number,
    bounds: TerrainBounds,
    stepX: number,
    stepY: number,
    x: number,
    y: number
): number {
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) return 0;
    const gx = clamp((x - bounds.minX) / stepX, 0, width - 1);
    const gy = clamp((y - bounds.minY) / stepY, 0, height - 1);
    const x0 = Math.min(width - 2, Math.floor(gx));
    const y0 = Math.min(height - 2, Math.floor(gy));
    const tx = gx - x0;
    const ty = gy - y0;
    const top = lerp(values[y0 * width + x0], values[y0 * width + x0 + 1], tx);
    const bottom = lerp(values[(y0 + 1) * width + x0], values[(y0 + 1) * width + x0 + 1], tx);
    return lerp(top, bottom, ty);
}

function buildLobes(
    random: () => number,
    centerX: number,
    centerY: number,
    radiusX: number,
    radiusY: number,
    count: number,
    axis: number
): BasinLobe[] {
    const lobes: BasinLobe[] = [{
        x: centerX,
        y: centerY,
        radiusX: radiusX * (0.61 + random() * 0.09),
        radiusY: radiusY * (0.61 + random() * 0.09),
        rotation: axis + (random() - 0.5) * 0.35
    }];
    for (let i = 1; i < count; i++) {
        // All secondary depressions overlap the main bowl, but their offset,
        // anisotropy and rotation make coves and necks instead of a rosette.
        const along = i === 1
            ? (0.42 + random() * 0.12) * radiusX
            : (random() * 1.08 - 0.5) * radiusX;
        const across = i === 2
            ? (random() < 0.5 ? -1 : 1) * (0.3 + random() * 0.16) * radiusY
            : (random() - 0.5) * radiusY * 0.94;
        const cos = Math.cos(axis);
        const sin = Math.sin(axis);
        lobes.push({
            x: centerX + cos * along - sin * across,
            y: centerY + sin * along + cos * across,
            radiusX: radiusX * (0.38 + random() * 0.18),
            radiusY: radiusY * (0.37 + random() * 0.18),
            rotation: axis + (random() - 0.5) * 1.15
        });
    }
    return lobes;
}

/**
 * Generate one deterministic, connected, bounded lake terrain.
 *
 * Contours remain in ordinary grid coordinates. The caller owns projection,
 * palette and painter ordering.
 */
export function generateLakeTerrain(options: LakeTerrainOptions): LakeTerrain {
    const values = [options.seed, options.centerX, options.centerY, options.radiusX, options.radiusY];
    if (!values.every(Number.isFinite) || options.radiusX <= 0 || options.radiusY <= 0) {
        throw new Error('Lake terrain seed, center and positive radii must be finite.');
    }
    const seed = options.seed >>> 0;
    const requestedStep = Number.isFinite(options.sampleStep) ? options.sampleStep ?? 0.35 : 0.35;
    const sampleStep = clamp(requestedStep, 0.2, 0.8);
    const defaultMargin = Math.max(2, Math.min(options.radiusX, options.radiusY) * 0.45);
    const bounds = validateBounds(options.bounds ?? {
        minX: options.centerX - options.radiusX - defaultMargin,
        minY: options.centerY - options.radiusY - defaultMargin,
        maxX: options.centerX + options.radiusX + defaultMargin,
        maxY: options.centerY + options.radiusY + defaultMargin
    });
    if (options.centerX <= bounds.minX || options.centerX >= bounds.maxX
        || options.centerY <= bounds.minY || options.centerY >= bounds.maxY) {
        throw new Error('Lake center must lie strictly inside its bounds.');
    }

    const inset = Math.max(0.65, sampleStep * 2);
    const availableX = Math.min(options.centerX - bounds.minX, bounds.maxX - options.centerX) - inset;
    const availableY = Math.min(options.centerY - bounds.minY, bounds.maxY - options.centerY) - inset;
    if (availableX <= 0.75 || availableY <= 0.75) throw new Error('Lake bounds leave no safe shoreline inset.');
    // The generated basin rotates in grid space, so either requested radius
    // may become its horizontal or vertical extent. Fit the major radius in
    // both axes rather than allowing a long lake to graze a plot boundary.
    const majorRadius = Math.max(options.radiusX, options.radiusY);
    const radiusScale = Math.min(1, availableX / (majorRadius * 1.18), availableY / (majorRadius * 1.18));
    const radiusX = options.radiusX * radiusScale;
    const radiusY = options.radiusY * radiusScale;

    const columns = Math.ceil((bounds.maxX - bounds.minX) / sampleStep) + 1;
    const rows = Math.ceil((bounds.maxY - bounds.minY) / sampleStep) + 1;
    if (columns > 160 || rows > 160) throw new Error('Lake terrain grid exceeds the 160x160 safety limit.');
    const stepX = (bounds.maxX - bounds.minX) / (columns - 1);
    const stepY = (bounds.maxY - bounds.minY) / (rows - 1);

    const random = makeRandom(seed ^ 0x51ed270b);
    const axis = random() * TAU;
    const lobeCount = clamp(Math.floor(options.lobeCount ?? (3 + random() * 3)), 2, 7);
    const lobes = buildLobes(random, options.centerX, options.centerY, radiusX, radiusY, lobeCount, axis);
    const minimumRadius = Math.min(radiusX, radiusY);
    const warpStrength = minimumRadius * (0.1 + random() * 0.045);
    const spillAngle = axis + (random() - 0.5) * 1.9;
    const spillCos = Math.cos(spillAngle);
    const spillSin = Math.sin(spillAngle);
    const raw = new Float64Array(columns * rows);

    const basinElevation = (x: number, y: number): number => {
        const warpX = fbmNoise2D(x * 0.115 + 17.3, y * 0.115 - 8.1, seed ^ 0x68bc21eb, 3) * warpStrength;
        const warpY = fbmNoise2D(x * 0.115 - 4.7, y * 0.115 + 21.9, seed ^ 0x02e5be93, 3) * warpStrength;
        const px = x + warpX;
        const py = y + warpY;
        let elevation = Number.POSITIVE_INFINITY;
        for (const lobe of lobes) {
            const dx = px - lobe.x;
            const dy = py - lobe.y;
            const cos = Math.cos(lobe.rotation);
            const sin = Math.sin(lobe.rotation);
            const lx = (dx * cos + dy * sin) / lobe.radiusX;
            const ly = (-dx * sin + dy * cos) / lobe.radiusY;
            const lobeElevation = lx * lx + ly * ly - 1;
            elevation = Number.isFinite(elevation) ? smoothMinimum(elevation, lobeElevation, 0.14) : lobeElevation;
        }
        const broadNoise = fbmNoise2D(x * 0.16, y * 0.16, seed ^ 0x9e3779b9, 3) * 0.15;
        const detailNoise = fbmNoise2D(x * 0.36, y * 0.36, seed ^ 0x85ebca6b, 2) * 0.045;
        elevation += broadNoise + detailNoise;

        // A narrow zero-height saddle gives Priority-Flood a known outlet.
        // It is dry (raw === filled) outside the bowl, so it does not become
        // a ruler-straight tail in the water mask.
        const dx = x - options.centerX;
        const dy = y - options.centerY;
        const along = dx * spillCos + dy * spillSin;
        const cross = -dx * spillSin + dy * spillCos;
        if (along > minimumRadius * 0.52) {
            const saddle = Math.abs(cross) / Math.max(0.25, minimumRadius * 0.2) * 0.22;
            elevation = Math.min(elevation, saddle);
        }
        return elevation;
    };

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) {
            raw[y * columns + x] = basinElevation(bounds.minX + x * stepX, bounds.minY + y * stepY);
        }
    }
    const filled = priorityFloodFill(raw, columns, rows, 8);
    const centerColumn = clamp(Math.round((options.centerX - bounds.minX) / stepX), 0, columns - 1);
    const centerRow = clamp(Math.round((options.centerY - bounds.minY) / stepY), 0, rows - 1);
    const centerIndex = centerRow * columns + centerColumn;
    let preliminaryMaxDepth = 0;
    for (let i = 0; i < raw.length; i++) preliminaryMaxDepth = Math.max(preliminaryMaxDepth, filled[i] - raw[i]);
    if (preliminaryMaxDepth <= 0.08) throw new Error('Synthesized lake has no floodable depression.');

    // Ignore the numerically shallow spill trace; it is the outlet, not lake.
    const shorelineDepth = Math.max(0.055, preliminaryMaxDepth * 0.04);
    const candidate = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        if (filled[i] - raw[i] >= shorelineDepth) candidate[i] = 1;
    }
    let anchor = centerIndex;
    if (!candidate[anchor]) {
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < candidate.length; i++) {
            if (!candidate[i]) continue;
            const x = i % columns;
            const y = Math.floor(i / columns);
            const distance = (x - centerColumn) ** 2 + (y - centerRow) ** 2;
            if (distance < bestDistance) {
                bestDistance = distance;
                anchor = i;
            }
        }
    }
    let waterMask = componentFromAnchor(candidate, columns, rows, anchor);
    waterMask = fillMaskHoles(waterMask, columns, rows);
    if (maskCount(waterMask) < 24) throw new Error('Synthesized lake basin is too small to contour.');

    let maxDepth = 0;
    const normalizedDepth = new Float64Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        if (waterMask[i]) maxDepth = Math.max(maxDepth, filled[i] - raw[i]);
    }
    for (let i = 0; i < raw.length; i++) {
        if (waterMask[i]) normalizedDepth[i] = clamp((filled[i] - raw[i]) / maxDepth, 0, 1);
    }

    const depthMask = (threshold: number): Uint8Array => {
        const mask = new Uint8Array(raw.length);
        for (let i = 0; i < mask.length; i++) {
            if (waterMask[i] && normalizedDepth[i] >= threshold) mask[i] = 1;
        }
        return fillMaskHoles(largestComponent(mask, columns, rows), columns, rows);
    };
    let midMask = depthMask(0.3);
    if (maskCount(midMask) < 12) midMask = erodeMask(waterMask, columns, rows);
    let deepMask = depthMask(0.58);
    if (maskCount(deepMask) < 8) deepMask = erodeMask(midMask, columns, rows);

    const bankRadius = clamp(options.bankWidth ?? 0.62, Math.min(stepX, stepY), minimumRadius * 0.25);
    const bankMask = dilateMask(waterMask, columns, rows, stepX, stepY, bankRadius);
    const smoothingPasses = clamp(Math.floor(options.smoothingPasses ?? 1), 0, 2);
    const contours: LakeContours = {
        bank: makeContour(bankMask, columns, rows, bounds, stepX, stepY, smoothingPasses),
        water: makeContour(waterMask, columns, rows, bounds, stepX, stepY, smoothingPasses),
        mid: makeContour(midMask, columns, rows, bounds, stepX, stepY, smoothingPasses),
        deep: makeContour(deepMask, columns, rows, bounds, stepX, stepY, smoothingPasses)
    };
    for (const [name, contour] of Object.entries(contours)) {
        if (!isSimpleContour(contour)) throw new Error(`Synthesized lake ${name} contour is not a simple closed polygon.`);
    }

    return {
        seed,
        center: { x: options.centerX, y: options.centerY },
        bounds,
        columns,
        rows,
        stepX,
        stepY,
        spillElevation: filled[anchor],
        maxDepth,
        contours,
        sampleDepth: (x: number, y: number): number => {
            if (!contourContains(contours.water, x, y)) return 0;
            return clamp(bilinearSample(normalizedDepth, columns, rows, bounds, stepX, stepY, x, y), 0, 1);
        },
        sampleElevation: (x: number, y: number): number => bilinearSample(raw, columns, rows, bounds, stepX, stepY, x, y),
        contains: (x: number, y: number, band: LakeBand = 'water'): boolean => contourContains(contours[band], x, y)
    };
}

export interface WaterBodyOptions {
    /** World bounds the field is sampled over; contours are clamped inside. */
    bounds: TerrainBounds;
    /** Grid step; clamped like lake terrain and bounded by the 160x160 grid. */
    sampleStep: number;
    /** Combined 0..1 water depth at a world point (lake basin + channels). */
    depthAt: (x: number, y: number) => number;
    /** A point known to be inside the main water body (the lake center). */
    anchor: TerrainPoint;
    /** Shore ring width beyond the waterline. */
    bankWidth: number;
    smoothingPasses?: number;
}

/**
 * Contour an arbitrary connected water body from a caller-supplied depth
 * field: ONE continuous outer border for the whole system (a lake and every
 * river joined to it), then the interior depth bands from the same field —
 * instead of stitching independently drawn shapes together at their seams.
 */
export function generateWaterBodyContours(options: WaterBodyOptions): LakeContours {
    const bounds = validateBounds(options.bounds);
    const sampleStep = clamp(options.sampleStep, 0.2, 0.8);
    const columns = Math.ceil((bounds.maxX - bounds.minX) / sampleStep) + 1;
    const rows = Math.ceil((bounds.maxY - bounds.minY) / sampleStep) + 1;
    if (columns > 160 || rows > 160) throw new Error('Water body grid exceeds the 160x160 safety limit.');
    const stepX = (bounds.maxX - bounds.minX) / (columns - 1);
    const stepY = (bounds.maxY - bounds.minY) / (rows - 1);

    const depth = new Float64Array(columns * rows);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) {
            const value = options.depthAt(bounds.minX + x * stepX, bounds.minY + y * stepY);
            depth[y * columns + x] = Number.isFinite(value) ? clamp(value, 0, 1) : 0;
        }
    }

    const candidate = new Uint8Array(depth.length);
    for (let i = 0; i < depth.length; i++) {
        if (depth[i] >= 0.045) candidate[i] = 1;
    }
    const anchorColumn = clamp(Math.round((options.anchor.x - bounds.minX) / stepX), 0, columns - 1);
    const anchorRow = clamp(Math.round((options.anchor.y - bounds.minY) / stepY), 0, rows - 1);
    let anchor = anchorRow * columns + anchorColumn;
    if (!candidate[anchor]) {
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < candidate.length; i++) {
            if (!candidate[i]) continue;
            const x = i % columns;
            const y = Math.floor(i / columns);
            const distance = (x - anchorColumn) ** 2 + (y - anchorRow) ** 2;
            if (distance < bestDistance) {
                bestDistance = distance;
                anchor = i;
            }
        }
    }
    let waterMask = componentFromAnchor(candidate, columns, rows, anchor);
    waterMask = fillMaskHoles(waterMask, columns, rows);
    if (maskCount(waterMask) < 24) throw new Error('Water body is too small to contour.');

    const bandMask = (threshold: number): Uint8Array => {
        const mask = new Uint8Array(depth.length);
        for (let i = 0; i < mask.length; i++) {
            if (waterMask[i] && depth[i] >= threshold) mask[i] = 1;
        }
        return fillMaskHoles(largestComponent(mask, columns, rows), columns, rows);
    };
    let midMask = bandMask(0.32);
    if (maskCount(midMask) < 12) midMask = erodeMask(waterMask, columns, rows);
    let deepMask = bandMask(0.6);
    if (maskCount(deepMask) < 8) deepMask = erodeMask(midMask, columns, rows);
    const bankRadius = clamp(options.bankWidth, Math.min(stepX, stepY), 4);
    const bankMask = fillMaskHoles(dilateMask(waterMask, columns, rows, stepX, stepY, bankRadius), columns, rows);

    const smoothingPasses = clamp(Math.floor(options.smoothingPasses ?? 1), 0, 2);
    // makeContour's box/hull fallbacks return SIMPLE but grossly oversized
    // polygons — fine hidden behind a compact lake, catastrophic painted
    // around a sprawling river system. Verify each band by area against its
    // own mask; a degenerate band must never render as a giant slab.
    const cellArea = stepX * stepY;
    const contourArea = (points: readonly TerrainPoint[]): number => {
        let area = 0;
        for (let i = 0; i < points.length; i++) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            area += a.x * b.y - b.x * a.y;
        }
        return Math.abs(area) * 0.5;
    };
    const band = (mask: Uint8Array, name: string): TerrainPoint[] => {
        const contour = makeContour(mask, columns, rows, bounds, stepX, stepY, smoothingPasses);
        if (!isSimpleContour(contour)) throw new Error(`Water body ${name} contour is not a simple closed polygon.`);
        if (contourArea(contour) > Math.max(8, maskCount(mask)) * cellArea * 1.6) {
            throw new Error(`Water body ${name} contour degenerated to a fallback envelope.`);
        }
        return contour;
    };
    const water = band(waterMask, 'water');
    let bank: TerrainPoint[];
    try {
        bank = band(bankMask, 'bank');
    } catch {
        // Losing the shore ring is invisible next to losing the whole body:
        // fall back to the waterline itself rather than failing the feature.
        bank = water.map(point => ({ ...point }));
    }
    return {
        bank,
        water,
        mid: band(midMask, 'mid'),
        deep: band(deepMask, 'deep')
    };
}
