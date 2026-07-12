import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = relative => readFileSync(path.join(root, relative), 'utf8');

const configSource = readSource('src/game/GameConfig.ts');
assert.match(configSource, /antialias:\s*true/);
assert.match(configSource, /antialiasGL:\s*true/);
assert.match(configSource, /pixelArt:\s*false/);
assert.match(configSource, /roundPixels:\s*false/);
assert.doesNotMatch(configSource, /pixelArt:\s*true/);

const cssSource = readSource('src/App.css');
assert.match(cssSource, /#game-container>canvas\s*\{[^}]*image-rendering:\s*auto/s);
assert.doesNotMatch(cssSource, /\*\s*\{[^}]*image-rendering:/s,
  'image-rendering must be scoped to intentional pixel-art elements, never every element');

const policySource = readSource('src/game/renderers/TextureRenderPolicy.ts');
assert.match(policySource, /TextureSampling\.PIXEL_ART\]:\s*Phaser\.Textures\.FilterMode\.NEAREST/);
assert.match(policySource, /TextureSampling\.SMOOTH\]:\s*Phaser\.Textures\.FilterMode\.LINEAR/);
assert.match(policySource, /applyPixelArtManifestFrame/);
assert.match(policySource, /target\.setOrigin\(placement\.originX,\s*placement\.originY\)/);
assert.match(policySource, /target\.setScale\(placement\.cellWorldPx\)/);
assert.match(policySource, /export\s+(?:function|const)\s+currentPixelMode\b/);
assert.match(policySource, /export\s+(?:function|const)\s+setPixelMode\b/);
assert.match(policySource, /export\s+(?:function|const)\s+registerPixelSurface\b/);
assert.match(policySource, /export\s+(?:function|const)\s+settleLogicalZoom\b/);

const worldMapSource = readSource('src/game/systems/WorldMapSystem.ts');
assert.match(worldMapSource, /applyTextureSampling\(rt\.texture,\s*TextureSampling\.PIXEL_ART\)/,
  'wilderness postcard RTs stay hard-wired NEAREST in every mode (seam safety)');
assert.match(worldMapSource, /registerPixelSurface\(rt\.texture\)/,
  'village snapshot postcard RTs must follow PixelMode via registerPixelSurface');

const spriteBankSource = readSource('src/game/render/SpriteBank.ts');
assert.match(spriteBankSource, /registerPixelSurface\(/,
  'bank atlases must follow PixelMode via registerPixelSurface');

const mainSceneSource = readSource('src/game/scenes/MainScene.ts');
assert.match(mainSceneSource, /registerPixelSurface\(/,
  'the ground render texture must follow PixelMode via registerPixelSurface');

const particleSource = readSource('src/game/systems/ParticleManager.ts');
assert.match(particleSource, /registerPixelSurface\(/,
  'chunky particle textures must follow PixelMode via registerPixelSurface');

// The per-layer PixelSnap PostFX pass is removed permanently: crispness comes from
// per-texture NEAREST sampling (registerPixelSurface), never from a snapping pass.
assert.equal(existsSync(path.join(root, 'src/game/render/PixelSnap.ts')), false,
  'src/game/render/PixelSnap.ts must stay deleted');
for (const file of collectFiles(path.join(root, 'src'), '')) {
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /applyPixelSnap/, `${file} references the removed PixelSnap pass`);
  assert.doesNotMatch(source, /setPostPipeline\(\s*['"]PixelSnap['"]/,
    `${file} re-attaches the removed PixelSnap pipeline`);
}

function collectFiles(dir, suffix) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(absolute, suffix));
    else if (entry.name.endsWith(suffix)) files.push(absolute);
  }
  return files;
}

function pngDimensions(file) {
  const header = readFileSync(file).subarray(0, 24);
  assert.equal(header.length, 24, `${file} has a truncated PNG header`);
  assert.equal(header.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is not a PNG`);
  assert.equal(header.subarray(12, 16).toString('ascii'), 'IHDR', `${file} has no leading IHDR`);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function visitManifestFrames(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.file === 'string') visit(value);
  for (const child of Object.values(value)) visitManifestFrames(child, visit);
}

const spriteRoot = path.join(root, 'public/assets/sprites');
const manifestFiles = collectFiles(spriteRoot, 'manifest.json').sort();
const kindOf = manifestFile => path.relative(spriteRoot, manifestFile).split(path.sep)[0];

const manifestsByKind = {};
for (const manifestFile of manifestFiles) {
  manifestsByKind[kindOf(manifestFile)] = (manifestsByKind[kindOf(manifestFile)] ?? 0) + 1;
}
assert.deepEqual(manifestsByKind, { buildings: 19, obstacles: 5, troops: 14, wrecks: 19 },
  'expected manifests for 19 buildings, 14 troops, 19 wrecks and 5 obstacles');
assert.equal(manifestFiles.length, 57, 'the baked unit roster changed size');

const referencedPngs = new Set();
const framesByKind = {};
let frameCount = 0;
for (const manifestFile of manifestFiles) {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const manifestScale = Number(manifest.cellWorldPx);
  assert.ok(Number.isFinite(manifestScale) && manifestScale > 0, `${manifestFile} needs a positive cellWorldPx`);
  visitManifestFrames(manifest, frame => {
    const label = `${manifestFile}:${frame.file}`;
    assert.equal(path.basename(frame.file), frame.file, `${label} must stay inside its asset directory`);
    assert.ok(Number.isSafeInteger(frame.texelW) && frame.texelW > 0, `${label} has invalid texelW`);
    assert.ok(Number.isSafeInteger(frame.texelH) && frame.texelH > 0, `${label} has invalid texelH`);
    // Origins are frame-relative; anchors may overhang a trimmed frame slightly
    // (obstacle bases), but anything past +/-0.5 of the frame is bake garbage.
    assert.ok(Number.isFinite(frame.originX) && frame.originX >= -0.5 && frame.originX <= 1.5,
      `${label} has invalid originX`);
    assert.ok(Number.isFinite(frame.originY) && frame.originY >= -0.5 && frame.originY <= 1.5,
      `${label} has invalid originY`);
    assert.equal(frame.cellWorldPx, manifestScale, `${label} disagrees with its manifest scale`);

    const png = path.join(path.dirname(manifestFile), frame.file);
    assert.ok(existsSync(png), `${label} references a missing PNG`);
    const relativePng = path.relative(spriteRoot, png);
    assert.equal(referencedPngs.has(relativePng), false, `${relativePng} is referenced more than once`);
    referencedPngs.add(relativePng);
    assert.deepEqual(pngDimensions(png), { width: frame.texelW, height: frame.texelH },
      `${label} dimensions disagree with the PNG`);
    framesByKind[kindOf(manifestFile)] = (framesByKind[kindOf(manifestFile)] ?? 0) + 1;
    frameCount += 1;
  });
}

// Every unit directory also ships a packed atlas (atlas.png + atlas.json) covering
// each loose frame PNG; manifests may place only a subset of the packed frames.
const atlasPackedPngs = new Set();
for (const manifestFile of manifestFiles) {
  const unitDir = path.dirname(manifestFile);
  const atlasJsonFile = path.join(unitDir, 'atlas.json');
  assert.ok(existsSync(atlasJsonFile), `${unitDir} is missing atlas.json`);
  assert.ok(existsSync(path.join(unitDir, 'atlas.png')), `${unitDir} is missing atlas.png`);
  for (const frameName of Object.keys(JSON.parse(readFileSync(atlasJsonFile, 'utf8')).frames)) {
    assert.ok(existsSync(path.join(unitDir, frameName)),
      `${atlasJsonFile} packs a missing PNG: ${frameName}`);
    atlasPackedPngs.add(path.relative(spriteRoot, path.join(unitDir, frameName)));
  }
}

// atlas.png sheets are derived artifacts, never manifest frames themselves.
const emittedPngs = collectFiles(spriteRoot, '.png')
  .map(file => path.relative(spriteRoot, file))
  .filter(file => path.basename(file) !== 'atlas.png');
assert.deepEqual(framesByKind, { buildings: 2_717, obstacles: 416, troops: 6_480, wrecks: 71 },
  'the baked roster is incomplete');
assert.equal(frameCount, 9_684,
  '2,717 building + 6,480 troop + 71 wreck + 416 obstacle frames');
assert.deepEqual(emittedPngs.sort(), [...atlasPackedPngs].sort(),
  'every emitted sprite PNG must be packed into exactly one unit atlas');
for (const png of referencedPngs) {
  assert.ok(atlasPackedPngs.has(png), `${png} is placed by a manifest but missing from its atlas`);
}

console.log(JSON.stringify({
  status: 'ok',
  rendering: 'smooth-world-explicit-pixel-assets',
  manifests: manifestFiles.length,
  frames: frameCount
}));
