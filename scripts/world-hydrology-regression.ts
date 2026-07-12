import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
    HYDROLOGY_OWNER_VISTA_WINDOW,
    HYDROLOGY_PLOT_PITCH,
    HYDROLOGY_STARTER_SAFE_RADIUS,
    anchorHydrologyFeature,
    classifyHydrologyPlot,
    clearWorldHydrologyCache,
    findWorldHydrologyShowcase,
    greatLakeForMacroCell,
    isHydrologyNetworkConnected,
    isHydrologyProtectedPlot,
    queryWorldHydrology,
    worldHydrologyCacheSize,
    type GreatLakeFeature
} from '../src/game/config/WorldHydrology';
import { isSimpleContour } from '../src/game/renderers/WildernessTerrain';
import { botSeedAt, isWildernessPreserveAt } from '../src/game/config/Economy';

for (const owner of [{ x: -5, y: -7 }, { x: -5, y: -8 }]) {
    assert.equal(isHydrologyProtectedPlot(owner.x, owner.y), false, `owner-safe plot ${owner.x},${owner.y} must stay hydrology-free`);
    assert.equal(isWildernessPreserveAt(owner.x, owner.y), false, `owner-safe plot ${owner.x},${owner.y} must stay settleable terrain`);
}
for (let y = -HYDROLOGY_STARTER_SAFE_RADIUS; y <= HYDROLOGY_STARTER_SAFE_RADIUS; y++) {
    for (let x = -HYDROLOGY_STARTER_SAFE_RADIUS; x <= HYDROLOGY_STARTER_SAFE_RADIUS; x++) {
        assert.equal(isHydrologyProtectedPlot(x, y), false, `starter-safe plot ${x},${y} was occupied`);
    }
}

const ownerVista = greatLakeForMacroCell(-1, -1);
assert.ok(ownerVista, 'owner macro must contain its deterministic vista lake');
assert.ok(ownerVista.protectedPlots.every(plot => !(plot.x === -5 && (plot.y === -7 || plot.y === -8))),
    'owner vista feature covered a current or legacy home');
const vistaFeatures = queryWorldHydrology(HYDROLOGY_OWNER_VISTA_WINDOW);
assert.ok(vistaFeatures.some(feature => feature.id === ownerVista.id), 'earned owner sight window cannot see the vista lake');
const visibleVistaPlots = ownerVista.protectedPlots.filter(plot =>
    plot.x >= HYDROLOGY_OWNER_VISTA_WINDOW.minPlotX
    && plot.x <= HYDROLOGY_OWNER_VISTA_WINDOW.maxPlotX
    && plot.y >= HYDROLOGY_OWNER_VISTA_WINDOW.minPlotY
    && plot.y <= HYDROLOGY_OWNER_VISTA_WINDOW.maxPlotY);
assert.ok(visibleVistaPlots.length >= 4, 'vista exposes fewer than four protected feature plots');
assert.ok(visibleVistaPlots.filter(plot => plot.lake).length >= 3, 'vista exposes fewer than three actual lake plots');
const visibleVistaKeys = new Set(visibleVistaPlots.map(plot => `${plot.x},${plot.y}`));
assert.ok(visibleVistaPlots.some(plot =>
    visibleVistaKeys.has(`${plot.x + 1},${plot.y}`) || visibleVistaKeys.has(`${plot.x},${plot.y + 1}`)),
    'visible Great Lake plots do not share an adjacent edge');
assert.ok(visibleVistaPlots.some(plot =>
    Math.max(Math.abs(plot.x + 5), Math.abs(plot.y + 7)) <= 2),
    'vista lake has no protected plot within Chebyshev 2 of the current owner');

const showcase = findWorldHydrologyShowcase();
assert.ok(showcase.protectedPlots.length >= 4, 'Great Lake must span several protected plots');
assert.ok(showcase.requestedSpanPlots.x >= 2 && showcase.requestedSpanPlots.x <= 4);
assert.ok(showcase.requestedSpanPlots.y >= 2 && showcase.requestedSpanPlots.y <= 4);
assert.ok(isSimpleContour(showcase.terrain.contours.water), 'shared water contour must be simple and connected');
assert.ok(isHydrologyNetworkConnected(showcase.network), 'source must reach sink through the lake network');

const source = showcase.network.nodes.find(node => node.id === showcase.network.sourceNodeId);
const sink = showcase.network.nodes.find(node => node.id === showcase.network.sinkNodeId);
assert.ok(source && sink, 'network needs explicit source and sink nodes');
assert.equal(showcase.terrain.contains(source.point.x, source.point.y), false, 'source must begin outside open water');
assert.equal(showcase.terrain.contains(sink.point.x, sink.point.y), false, 'sink must end outside open water');

const coveredKeys = new Set(showcase.protectedPlots.map(plot => `${plot.x},${plot.y}`));
const adjacentPair = showcase.protectedPlots.some(plot =>
    coveredKeys.has(`${plot.x + 1},${plot.y}`) || coveredKeys.has(`${plot.x},${plot.y + 1}`));
assert.ok(adjacentPair, 'multi-plot feature needs at least one shared plot edge');
for (const plot of showcase.protectedPlots) {
    const classification = classifyHydrologyPlot(plot.x, plot.y);
    assert.ok(classification.protected, `covered plot ${plot.x},${plot.y} was not reserved`);
    assert.ok(classification.features.some(feature => feature.id === showcase.id));
    assert.equal(isWildernessPreserveAt(plot.x, plot.y), true, 'server preserve predicate omitted hydrology');
    assert.equal(botSeedAt(plot.x, plot.y), null, 'bot allocation occupied world hydrology');
}

const firstPlot = showcase.protectedPlots[0];
const secondPlot = showcase.protectedPlots.find(plot => plot.x !== firstPlot.x || plot.y !== firstPlot.y) ?? firstPlot;
const firstAnchor = anchorHydrologyFeature(showcase, firstPlot.x, firstPlot.y);
const secondAnchor = anchorHydrologyFeature(showcase, secondPlot.x, secondPlot.y);
for (let i = 0; i < showcase.terrain.contours.water.length; i++) {
    const absolute = showcase.terrain.contours.water[i];
    const fromFirst = firstAnchor.contours.water[i];
    const fromSecond = secondAnchor.contours.water[i];
    assert.equal(fromFirst.x + firstAnchor.anchorWorldTile.x, absolute.x);
    assert.equal(fromFirst.y + firstAnchor.anchorWorldTile.y, absolute.y);
    assert.equal(fromSecond.x + secondAnchor.anchorWorldTile.x, absolute.x);
    assert.equal(fromSecond.y + secondAnchor.anchorWorldTile.y, absolute.y);
}
assert.equal(firstAnchor.sampleDepth(
    showcase.terrain.center.x - firstAnchor.anchorWorldTile.x,
    showcase.terrain.center.y - firstAnchor.anchorWorldTile.y
), showcase.terrain.sampleDepth(showcase.terrain.center.x, showcase.terrain.center.y));

function snapshot(feature: GreatLakeFeature): unknown {
    return {
        id: feature.id,
        label: feature.label,
        seed: feature.seed,
        macroCell: feature.macroCell,
        requestedSpanPlots: feature.requestedSpanPlots,
        contours: feature.terrain.contours,
        network: feature.network,
        protectedPlots: feature.protectedPlots
    };
}

const beforeClear = snapshot(showcase);
const macro = showcase.macroCell;
clearWorldHydrologyCache();
const regenerated = greatLakeForMacroCell(macro.x, macro.y);
assert.ok(regenerated, 'showcase macro must deterministically regenerate');
assert.deepEqual(snapshot(regenerated), beforeClear, 'cache eviction/reload changed world geometry');

const minPlotX = Math.floor(showcase.worldBounds.minX / HYDROLOGY_PLOT_PITCH);
const minPlotY = Math.floor(showcase.worldBounds.minY / HYDROLOGY_PLOT_PITCH);
const maxPlotX = Math.floor(showcase.worldBounds.maxX / HYDROLOGY_PLOT_PITCH);
const maxPlotY = Math.floor(showcase.worldBounds.maxY / HYDROLOGY_PLOT_PITCH);
const queried = queryWorldHydrology({ minPlotX, minPlotY, maxPlotX, maxPlotY });
assert.ok(queried.some(feature => feature.id === showcase.id), 'window query failed to rediscover shared feature');

const started = performance.now();
const regional = queryWorldHydrology({ minPlotX: -24, minPlotY: -24, maxPlotX: 24, maxPlotY: 24 });
const elapsedMs = performance.now() - started;
assert.ok(elapsedMs < 3000, `bounded regional query took ${elapsedMs.toFixed(1)}ms`);
assert.ok(worldHydrologyCacheSize() <= 192, 'geometry cache exceeded its hard bound');

console.log(JSON.stringify({
    ok: true,
    showcase: { id: showcase.id, label: showcase.label, macro: showcase.macroCell },
    requestedSpanPlots: showcase.requestedSpanPlots,
    protectedPlots: showcase.protectedPlots.length,
    visibleProtectedPlots: visibleVistaPlots.length,
    visibleLakePlots: visibleVistaPlots.filter(plot => plot.lake).length,
    contourVertices: showcase.terrain.contours.water.length,
    network: { nodes: showcase.network.nodes.length, reaches: showcase.network.reaches.length },
    regionalFeatures: regional.length,
    regionalQueryMs: Number(elapsedMs.toFixed(1)),
    cacheSize: worldHydrologyCacheSize()
}, null, 2));
