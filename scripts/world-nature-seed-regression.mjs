import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bundled = await build({
  stdin: {
    resolveDir: root,
    loader: 'ts',
    contents: `
      export * from './src/game/renderers/WorldNatureSeed.ts';
      export { WildernessRenderer } from './src/game/renderers/WildernessRenderer.ts';
      export { generateLakeTerrain } from './src/game/renderers/WildernessTerrain.ts';
    `
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  plugins: [
    {
      name: 'phaser-test-double',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^phaser$/ }, () => ({ path: 'phaser', namespace: 'test-double' }));
        buildApi.onLoad({ filter: /^phaser$/, namespace: 'test-double' }, () => ({
          loader: 'js',
          contents: 'export default {}'
        }));
      }
    },
    {
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
    }
  ]
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`;
const {
  WildernessRenderer,
  generateLakeTerrain,
  mixWorldNatureSeed,
  normalizeWorldNatureSeedVersion,
  wildernessGrassPatternSample,
  wildernessGrassPresentationSeed,
  wildernessPlotPresentationSeed,
  worldHydrologyDecorationSeed
} = await import(moduleUrl);

assert.equal(normalizeWorldNatureSeedVersion(undefined), 0);
assert.equal(normalizeWorldNatureSeedVersion(-1), 0);
assert.equal(normalizeWorldNatureSeedVersion(3.5), 0);
assert.equal(normalizeWorldNatureSeedVersion(0x1_0000_0000), 0xffff_ffff);
assert.equal(mixWorldNatureSeed(0x12345678, 0, 99), 0x12345678,
  'epoch zero must retain the shipped deterministic seed');

const epoch = 27;
const nextEpoch = epoch + 1;
const plot = { x: -17, y: 23 };
const firstPlotSeed = wildernessPlotPresentationSeed(plot.x, plot.y, epoch);
assert.equal(firstPlotSeed, wildernessPlotPresentationSeed(plot.x, plot.y, epoch));
assert.notEqual(firstPlotSeed, wildernessPlotPresentationSeed(plot.x, plot.y, nextEpoch));
assert.equal(wildernessGrassPresentationSeed(epoch), wildernessGrassPresentationSeed(epoch));
assert.notEqual(wildernessGrassPresentationSeed(epoch), wildernessGrassPresentationSeed(nextEpoch));
assert.equal(worldHydrologyDecorationSeed(0x4c414b45, epoch),
  worldHydrologyDecorationSeed(0x4c414b45, epoch));
assert.notEqual(worldHydrologyDecorationSeed(0x4c414b45, epoch),
  worldHydrologyDecorationSeed(0x4c414b45, nextEpoch));

const grassSnapshot = seedVersion => Array.from({ length: 17 }, (_, y) =>
  Array.from({ length: 17 }, (_, x) => wildernessGrassPatternSample(x - 8, y - 8, seedVersion, 5)));
assert.deepEqual(grassSnapshot(epoch), grassSnapshot(epoch), 'same epoch grass must be byte-stable');
assert.notDeepEqual(grassSnapshot(epoch), grassSnapshot(nextEpoch), 'next epoch must change grass patterning');

const ecologySnapshot = seedVersion => {
  const result = [];
  for (let y = -12; y <= 12; y++) {
    for (let x = -12; x <= 12; x++) result.push(WildernessRenderer.natureAt(x, y, seedVersion).key);
  }
  return result;
};
const ecology = ecologySnapshot(epoch);
assert.deepEqual(ecology, ecologySnapshot(epoch), 'same epoch ecology must be stable');
const nextEcology = ecologySnapshot(nextEpoch);
assert.notDeepEqual(ecology, nextEcology, 'next epoch must change wilderness archetypes');
assert.ok(ecology.filter((key, index) => key !== nextEcology[index]).length >= 40,
  'a reseed must visibly regenerate more than a token handful of plots');
assert.equal(WildernessRenderer.renderRevision(plot.x, plot.y, epoch),
  WildernessRenderer.renderRevision(plot.x, plot.y, epoch));
assert.notEqual(WildernessRenderer.renderRevision(plot.x, plot.y, epoch),
  WildernessRenderer.renderRevision(plot.x, plot.y, nextEpoch));

// Draw one forest plot through the real wilderness generator. A no-op graphics
// proxy keeps this a pure geometry/life test without needing a browser canvas.
const graphics = new Proxy({}, {
  get(_target, property) {
    if (property === 'then') return undefined;
    return () => graphics;
  }
});
let lifePlot = null;
for (let y = -20; y <= 20 && !lifePlot; y++) {
  for (let x = -20; x <= 20; x++) {
    const nature = WildernessRenderer.natureAt(x, y, epoch);
    if (['pines', 'grove', 'thicket', 'deadwood', 'glade', 'crags'].includes(nature.key)) {
      lifePlot = { x, y };
      break;
    }
  }
}
assert.ok(lifePlot, 'fixture search must find wilderness with ambient life');
const renderSummary = seedVersion => {
  const seed = wildernessPlotPresentationSeed(lifePlot.x, lifePlot.y, seedVersion);
  const rendered = WildernessRenderer.drawWildPlot(
    graphics, 0, 0, seed, lifePlot.x, lifePlot.y, seedVersion
  );
  return {
    key: rendered.key,
    life: rendered.life,
    water: rendered.waters.map(lake => lake.contours),
    streams: rendered.streams
  };
};
const lifeA = renderSummary(epoch);
assert.deepEqual(lifeA, renderSummary(epoch), 'same epoch wilderness life/terrain must be stable');
assert.notDeepEqual(lifeA, renderSummary(nextEpoch), 'next epoch must change props, terrain, or life anchors');

const terrainOptions = seedVersion => ({
  seed: wildernessPlotPresentationSeed(8, -5, seedVersion),
  centerX: 12.5,
  centerY: 12.5,
  radiusX: 8,
  radiusY: 6.2,
  bounds: { minX: 1.5, minY: 1.5, maxX: 23.5, maxY: 23.5 }
});
const terrainA = generateLakeTerrain(terrainOptions(epoch));
assert.deepEqual(terrainA.contours, generateLakeTerrain(terrainOptions(epoch)).contours,
  'same epoch terrain contours must be stable');
assert.notDeepEqual(terrainA.contours, generateLakeTerrain(terrainOptions(nextEpoch)).contours,
  'next epoch must regenerate terrain contours');

// Guard the authority handoff itself: a future refactor cannot quietly return
// to coordinate-only rendering while all pure seed tests continue to pass.
const mapSource = await readFile(path.join(root, 'src/game/systems/WorldMapSystem.ts'), 'utf8');
assert.match(mapSource, /adoptPresentationSeedVersion\(window\.seedVersion, window\.serverNow\)/);
assert.match(mapSource, /WildernessRenderer\.renderRevision\(plotX, plotY, this\.presentationSeedVersion\)/);
assert.match(mapSource, /wildernessGrassPalette\(this\.presentationSeedVersion\)/);
assert.match(mapSource, /presentationSeedVersion:\s*this\.presentationSeedVersion/);
assert.match(mapSource, /WildernessRenderer\.drawWildPlot\([\s\S]*?this\.presentationSeedVersion\s*\)/);

console.log(JSON.stringify({
  status: 'ok',
  epoch,
  nextEpoch,
  changedEcologyPlots: ecology.filter((key, index) => key !== nextEcology[index]).length,
  lifePlot,
  grassTiles: 17 * 17
}));
