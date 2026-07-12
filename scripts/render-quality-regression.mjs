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

const worldMapSource = readSource('src/game/systems/WorldMapSystem.ts');
assert.match(worldMapSource, /applyTextureSampling\(rt\.texture,\s*TextureSampling\.PIXEL_ART\)/);
assert.match(worldMapSource, /applyTextureSampling\(rt\.texture,\s*TextureSampling\.SMOOTH\)/);

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
assert.equal(manifestFiles.length, 33, 'expected manifests for 19 buildings and 14 troops');

const referencedPngs = new Set();
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
    assert.ok(Number.isFinite(frame.originX) && frame.originX >= 0 && frame.originX <= 1,
      `${label} has invalid originX`);
    assert.ok(Number.isFinite(frame.originY) && frame.originY >= 0 && frame.originY <= 1,
      `${label} has invalid originY`);
    assert.equal(frame.cellWorldPx, manifestScale, `${label} disagrees with its manifest scale`);

    const png = path.join(path.dirname(manifestFile), frame.file);
    assert.ok(existsSync(png), `${label} references a missing PNG`);
    const relativePng = path.relative(spriteRoot, png);
    assert.equal(referencedPngs.has(relativePng), false, `${relativePng} is referenced more than once`);
    referencedPngs.add(relativePng);
    assert.deepEqual(pngDimensions(png), { width: frame.texelW, height: frame.texelH },
      `${label} dimensions disagree with the PNG`);
    frameCount += 1;
  });
}

const emittedPngs = collectFiles(spriteRoot, '.png')
  .map(file => path.relative(spriteRoot, file));
assert.equal(frameCount, 4_608, 'the baked roster is incomplete');
assert.deepEqual([...referencedPngs].sort(), emittedPngs.sort(),
  'every emitted sprite PNG must be represented by exactly one manifest frame');

console.log(JSON.stringify({
  status: 'ok',
  rendering: 'smooth-world-explicit-pixel-assets',
  manifests: manifestFiles.length,
  frames: frameCount
}));
