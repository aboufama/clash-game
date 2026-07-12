import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const entry = path.join(root, 'src/game/renderers/WorldHydrologyRenderer.ts');
const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    plugins: [{
        name: 'iso-utils-test-double',
        setup(buildApi) {
            buildApi.onResolve({ filter: /IsoUtils$/ }, () => ({ path: 'iso-utils', namespace: 'test-double' }));
            buildApi.onLoad({ filter: /.*/, namespace: 'test-double' }, () => ({
                loader: 'js',
                contents: `export class IsoUtils {
                    static cartToIso(x, y) { return { x: (x - y) * 32, y: (x + y) * 16 }; }
                }`
            }));
        }
    }]
});
const source = bundled.outputFiles[0].text;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const {
    WorldHydrologyRenderer,
    buildVariableWidthRibbon,
    clipPolygonToRect,
    clipSegmentToRect,
    normalizeHydrologyClipRect
} = await import(moduleUrl);

const area = polygon => Math.abs(polygon.reduce((sum, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return sum + point.x * next.y - next.x * point.y;
}, 0)) * 0.5;
const within = (point, rect) => point.x >= rect.minX - 1e-7 && point.x <= rect.maxX + 1e-7
    && point.y >= rect.minY - 1e-7 && point.y <= rect.maxY + 1e-7;

const normalized = normalizeHydrologyClipRect({ minX: 8, minY: 5, maxX: -2, maxY: -4 });
assert.deepEqual(normalized, { minX: -2, minY: -4, maxX: 8, maxY: 5 });

const outer = [{ x: -2, y: -2 }, { x: 12, y: -2 }, { x: 12, y: 12 }, { x: -2, y: 12 }, { x: -2, y: -2 }];
const unitClip = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
const clippedOuter = clipPolygonToRect(outer, unitClip);
assert.equal(clippedOuter.length, 4, 'A containing polygon should clip to the rectangle.');
assert.equal(area(clippedOuter), 100);
assert.ok(clippedOuter.every(point => within(point, unitClip)));
assert.deepEqual(clipPolygonToRect([
    { x: 20, y: 20 }, { x: 22, y: 20 }, { x: 22, y: 22 }, { x: 20, y: 22 }
], unitClip), []);

// Two parcel clips of one absolute concave shore must preserve total area and
// land on the exact same absolute seam (no independently-generated edge).
const shore = [
    { x: 0.5, y: 1 }, { x: 8.5, y: 0.5 }, { x: 9.5, y: 4 },
    { x: 7.2, y: 5.2 }, { x: 9, y: 9 }, { x: 4.7, y: 8.4 },
    { x: 2.2, y: 9.5 }, { x: 0.4, y: 6 }, { x: 2.6, y: 4 }
];
const leftRect = { minX: 0, minY: 0, maxX: 5, maxY: 10 };
const rightRect = { minX: 5, minY: 0, maxX: 10, maxY: 10 };
const left = clipPolygonToRect(shore, leftRect);
const right = clipPolygonToRect(shore, rightRect);
assert.ok(left.every(point => within(point, leftRect)));
assert.ok(right.every(point => within(point, rightRect)));
assert.ok(Math.abs(area(left) + area(right) - area(shore)) < 1e-6, 'Split clips must conserve shoreline area.');
const leftSeam = left.filter(point => Math.abs(point.x - 5) < 1e-7).map(point => point.y).sort((a, b) => a - b);
const rightSeam = right.filter(point => Math.abs(point.x - 5) < 1e-7).map(point => point.y).sort((a, b) => a - b);
assert.deepEqual(leftSeam, rightSeam, 'Both slices must share identical seam intersections.');

assert.deepEqual(clipSegmentToRect({ x: -4, y: 5 }, { x: 14, y: 5 }, unitClip), [
    { x: 0, y: 5 }, { x: 10, y: 5 }
]);
assert.equal(clipSegmentToRect({ x: -4, y: -1 }, { x: 14, y: -1 }, unitClip), null);
assert.deepEqual(clipSegmentToRect({ x: 3, y: 3 }, { x: 3, y: 3 }, unitClip), [
    { x: 3, y: 3 }, { x: 3, y: 3 }
]);

const ribbon = buildVariableWidthRibbon(
    [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 7, y: 3 }, { x: 10, y: 3 }],
    [1, 1.8, 2.4, 3]
);
assert.equal(ribbon.length, 8);
assert.ok(ribbon.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
assert.ok(area(ribbon) > 14, 'Variable river ribbon should have meaningful area.');
assert.deepEqual(ribbon, buildVariableWidthRibbon(
    [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 7, y: 3 }, { x: 10, y: 3 }],
    [1, 1.8, 2.4, 3]
), 'Ribbon geometry must be deterministic.');
assert.throws(() => buildVariableWidthRibbon([{ x: 0, y: 0 }], []), /matching lengths/);

let randomState = 0x91e10da5;
const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
};
for (let sample = 0; sample < 400; sample++) {
    const cx = (random() - 0.5) * 40;
    const cy = (random() - 0.5) * 40;
    const polygon = Array.from({ length: 18 }, (_, index) => {
        const angle = index / 18 * Math.PI * 2;
        const radius = 2 + random() * 12;
        return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
    });
    const x0 = (random() - 0.5) * 30;
    const y0 = (random() - 0.5) * 30;
    const rect = { minX: x0, minY: y0, maxX: x0 + 1 + random() * 15, maxY: y0 + 1 + random() * 15 };
    const clipped = clipPolygonToRect(polygon, rect);
    assert.ok(clipped.every(point => finite(point.x) && finite(point.y) && within(point, rect)));
}

function finite(value) {
    return Number.isFinite(value);
}

class GraphicsDouble {
    commands = [];
    command(name, ...values) {
        assert.ok(values.every(value => typeof value !== 'number' || Number.isFinite(value)), `${name} emitted non-finite geometry.`);
        this.commands.push([name, ...values]);
        return this;
    }
    fillStyle(...values) { return this.command('fillStyle', ...values); }
    beginPath(...values) { return this.command('beginPath', ...values); }
    moveTo(...values) { return this.command('moveTo', ...values); }
    lineTo(...values) { return this.command('lineTo', ...values); }
    closePath(...values) { return this.command('closePath', ...values); }
    fillPath(...values) { return this.command('fillPath', ...values); }
    lineStyle(...values) { return this.command('lineStyle', ...values); }
    lineBetween(...values) { return this.command('lineBetween', ...values); }
    fillEllipse(...values) { return this.command('fillEllipse', ...values); }
    fillCircle(...values) { return this.command('fillCircle', ...values); }
    fillTriangle(...values) { return this.command('fillTriangle', ...values); }
    fillRect(...values) { return this.command('fillRect', ...values); }
}

const loop = (cx, cy, rx, ry, count = 32) => Array.from({ length: count }, (_, index) => {
    const angle = index / count * Math.PI * 2;
    const wobble = 1 + Math.sin(angle * 3 + 0.7) * 0.13 + Math.sin(angle * 5) * 0.06;
    return { x: cx + Math.cos(angle) * rx * wobble, y: cy + Math.sin(angle) * ry * wobble };
});
const feature = {
    id: 'regression-great-lake',
    kind: 'great-lake',
    label: 'Lake Regression',
    seed: 0x4c414b45,
    macroCell: { x: 0, y: 0 },
    requestedSpanPlots: { x: 2, y: 2 },
    worldBounds: { minX: 0, minY: 0, maxX: 24, maxY: 20 },
    protectedPlots: [],
    terrain: {
        seed: 1,
        center: { x: 12, y: 10 },
        bounds: { minX: 2, minY: 1, maxX: 22, maxY: 19 },
        columns: 10,
        rows: 10,
        stepX: 1,
        stepY: 1,
        spillElevation: 0,
        maxDepth: 1,
        contours: {
            bank: loop(12, 10, 9.8, 8.4),
            water: loop(12, 10, 9.1, 7.7),
            mid: loop(12, 10, 6.7, 5.6),
            deep: loop(12, 10, 3.9, 3.1)
        },
        sampleDepth(x, y) {
            return Math.max(0, 1 - Math.hypot((x - 12) / 9.1, (y - 10) / 7.7));
        },
        sampleElevation() { return 0; },
        contains(x, y, band = 'water') {
            const radii = { bank: [9.8, 8.4], water: [9.1, 7.7], mid: [6.7, 5.6], deep: [3.9, 3.1] }[band];
            return ((x - 12) / radii[0]) ** 2 + ((y - 10) / radii[1]) ** 2 <= 1;
        }
    },
    network: {
        sourceNodeId: 'source',
        sinkNodeId: 'sink',
        nodes: [
            { id: 'source', kind: 'source', point: { x: 0.8, y: 4 } },
            { id: 'inlet', kind: 'inlet', point: { x: 3, y: 7 } },
            { id: 'outlet', kind: 'outlet', point: { x: 20.7, y: 12 } },
            { id: 'rapid', kind: 'rapid', point: { x: 22, y: 14 } },
            { id: 'sink', kind: 'sink', point: { x: 23, y: 18 } }
        ],
        reaches: [
            { id: 'upper', fromNodeId: 'source', toNodeId: 'inlet', kind: 'stream', width: 1.4, points: [{ x: 0.8, y: 4 }, { x: 1.4, y: 5.2 }, { x: 3, y: 7 }] },
            { id: 'passage', fromNodeId: 'inlet', toNodeId: 'outlet', kind: 'lake-passage', width: 0, points: [{ x: 3, y: 7 }, { x: 12, y: 10 }, { x: 20.7, y: 12 }] },
            { id: 'outflow', fromNodeId: 'outlet', toNodeId: 'rapid', kind: 'outflow', width: 1.9, points: [{ x: 20.7, y: 12 }, { x: 21.4, y: 12.9 }, { x: 22, y: 14 }] },
            { id: 'rapids', fromNodeId: 'rapid', toNodeId: 'sink', kind: 'rapids', width: 2.2, points: [{ x: 22, y: 14 }, { x: 21.7, y: 16 }, { x: 23, y: 18 }] }
        ]
    }
};

const leftGraphics = new GraphicsDouble();
const leftRender = WorldHydrologyRenderer.drawFeature(leftGraphics, feature, {
    clip: { minX: 0, minY: 0, maxX: 12, maxY: 20 },
    localGridX: -12,
    localGridY: 7
});
const rightGraphics = new GraphicsDouble();
const rightRender = WorldHydrologyRenderer.drawFeature(rightGraphics, feature, {
    clip: { minX: 12, minY: 0, maxX: 24, maxY: 20 },
    localGridX: 0,
    localGridY: 7
});
assert.equal(leftRender.visible, true);
assert.equal(rightRender.visible, true);
assert.ok(leftRender.lakePolygons >= 4 && rightRender.lakePolygons >= 4);
assert.ok(leftRender.riverPolygons > 0 && rightRender.riverPolygons > 0);
assert.ok(leftGraphics.commands.length > 40 && rightGraphics.commands.length > 40);

const repeatedGraphics = new GraphicsDouble();
const repeated = WorldHydrologyRenderer.drawFeature(repeatedGraphics, feature, {
    clip: { minX: 0, minY: 0, maxX: 12, maxY: 20 },
    localGridX: -12,
    localGridY: 7
});
assert.deepEqual(repeated, leftRender, 'Life anchors and polygon counts must be deterministic.');
assert.deepEqual(repeatedGraphics.commands, leftGraphics.commands, 'Static vector art must be deterministic.');

const structuralHydrology = JSON.stringify({
    contours: feature.terrain.contours,
    network: feature.network,
    protectedPlots: feature.protectedPlots
});
const renderSeededHydrology = presentationSeedVersion => {
    const graphics = new GraphicsDouble();
    const result = WorldHydrologyRenderer.drawFeature(graphics, feature, {
        clip: { minX: 0, minY: 0, maxX: 24, maxY: 20 },
        localGridX: 0,
        localGridY: 0,
        presentationSeedVersion
    });
    return { commands: graphics.commands, result };
};
const seededA = renderSeededHydrology(27);
const seededARepeat = renderSeededHydrology(27);
const seededB = renderSeededHydrology(28);
assert.deepEqual(seededARepeat, seededA,
    'same presentation epoch must reproduce hydrology detail and life anchors exactly');
assert.notDeepEqual(seededB.commands, seededA.commands,
    'next presentation epoch must regenerate shoreline props and water details');
assert.notDeepEqual(seededB.result.life, seededA.result.life,
    'next presentation epoch must regenerate hydrology wildlife anchors');
assert.equal(JSON.stringify({
    contours: feature.terrain.contours,
    network: feature.network,
    protectedPlots: feature.protectedPlots
}), structuralHydrology, 'rendering presentation epochs must never mutate feature authority');

console.log(JSON.stringify({
    status: 'ok',
    stressSamples: 400,
    ribbonVertices: ribbon.length,
    leftCommands: leftGraphics.commands.length,
    rightCommands: rightGraphics.commands.length,
    lifeAnchors: leftRender.life.length + rightRender.life.length,
    seededCommands: seededA.commands.length
}));
