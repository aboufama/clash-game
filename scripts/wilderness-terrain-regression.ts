import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
    generateLakeTerrain,
    isSimpleContour,
    priorityFloodFill,
    type LakeBand,
    type TerrainPoint
} from '../src/game/renderers/WildernessTerrain';

const bowl = new Float64Array([
    5, 5, 5,
    5, 0, 5,
    5, 5, 5
]);
assert.deepEqual(Array.from(priorityFloodFill(bowl, 3, 3)), [5, 5, 5, 5, 5, 5, 5, 5, 5]);
assert.equal(bowl[4], 0, 'Priority-Flood must not mutate its input DEM');

const options = {
    seed: 0x91a4d23f,
    centerX: 12.5,
    centerY: 12.5,
    radiusX: 8.1,
    radiusY: 6.4,
    bounds: { minX: 1.5, minY: 1.5, maxX: 23.5, maxY: 23.5 }
};
const first = generateLakeTerrain(options);
const second = generateLakeTerrain(options);
assert.deepEqual(first.contours, second.contours, 'same seed/spec must reproduce byte-equivalent contours');
assert.equal(first.maxDepth, second.maxDepth);
assert.equal(first.spillElevation, second.spillElevation);

const bands: LakeBand[] = ['bank', 'water', 'mid', 'deep'];
for (const band of bands) {
    const contour = first.contours[band];
    assert.ok(contour.length >= 8, `${band} contour needs a useful silhouette`);
    assert.ok(isSimpleContour(contour), `${band} contour must not self-intersect`);
    for (const point of contour) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `${band} contains a non-finite vertex`);
        assert.ok(point.x >= options.bounds.minX && point.x <= options.bounds.maxX);
        assert.ok(point.y >= options.bounds.minY && point.y <= options.bounds.maxY);
    }
}

assert.ok(first.contains(options.centerX, options.centerY), 'the main basin must contain its requested center');
assert.ok(first.sampleDepth(options.centerX, options.centerY) > 0.2, 'the main basin center must carry visible depth');
assert.equal(first.contains(options.bounds.minX, options.bounds.minY), false);
assert.equal(first.sampleDepth(options.bounds.minX, options.bounds.minY), 0);

const different = generateLakeTerrain({ ...options, seed: options.seed + 1 });
assert.notDeepEqual(first.contours.water, different.contours.water, 'different seeds must change the shoreline');

function radialVariation(points: readonly TerrainPoint[], cx: number, cy: number): number {
    const radii = points.map(point => Math.hypot(point.x - cx, point.y - cy));
    const mean = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
    const variance = radii.reduce((sum, radius) => sum + (radius - mean) ** 2, 0) / radii.length;
    return Math.sqrt(variance) / mean;
}

assert.ok(radialVariation(first.contours.water, options.centerX, options.centerY) > 0.12,
    'shoreline must be substantially more varied than a differently-sized circle');

const started = performance.now();
let totalVertices = 0;
for (let seed = 1; seed <= 40; seed++) {
    const lake = generateLakeTerrain({
        ...options,
        seed: seed * 7919,
        centerX: 10 + ((seed * 17) % 11) * 0.5,
        centerY: 10 + ((seed * 23) % 11) * 0.5,
        radiusX: 2 + ((seed * 29) % 15) * 0.47,
        radiusY: 1.6 + ((seed * 31) % 13) * 0.43
    });
    for (const band of bands) {
        assert.ok(isSimpleContour(lake.contours[band]), `seed ${seed} produced a bad ${band} contour`);
        totalVertices += lake.contours[band].length;
    }
    assert.ok(lake.contains(lake.center.x, lake.center.y), `seed ${seed} lost the center basin`);
}
const elapsedMs = performance.now() - started;
assert.ok(elapsedMs < 5000, `40 terrain bakes took ${elapsedMs.toFixed(1)}ms`);

console.log(JSON.stringify({
    ok: true,
    sampleGrid: `${first.columns}x${first.rows}`,
    sampleVertices: Object.fromEntries(bands.map(band => [band, first.contours[band].length])),
    sampleMaxDepth: Number(first.maxDepth.toFixed(4)),
    sampleRadialVariation: Number(radialVariation(first.contours.water, options.centerX, options.centerY).toFixed(4)),
    generated: 42,
    regressionMs: Number(elapsedMs.toFixed(1)),
    totalVertices
}, null, 2));
