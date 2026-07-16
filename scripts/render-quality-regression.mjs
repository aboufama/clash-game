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

const gatePurgeSources = [
  ...collectFiles(path.join(root, 'src'), '.ts'),
  ...collectFiles(path.join(root, 'src'), '.tsx'),
  path.join(root, 'tools/art-preview/bake-sprites.mjs')
];
for (const file of gatePurgeSources) {
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /\bisGate\b|wallGateRecomputeAt|scheduleGateRecompute|recomputeWallGates|GATE_GAP|m(?:NS|EW)_gate/,
    `${path.relative(root, file)} reintroduces the removed automatic wall-gate feature`);
}

const particleSource = readSource('src/game/systems/ParticleManager.ts');
assert.match(particleSource, /registerPixelSurface\(/,
  'chunky particle textures must follow PixelMode via registerPixelSurface');

// Figure/projectile sprite wiring: every ambient-figure call site must try the
// baked frames before its vector fallback (villagers, neighbors, travellers).
const villageLifeSource = readSource('src/game/systems/VillageLifeSystem.ts');
assert.match(villageLifeSource, /syncEntitySprite\(/, 'village life entities must route through the baked-figure path');
assert.match(villageLifeSource, /syncFigure\(this\.scene,\s*g,\s*'merchant'/, 'the merchant must try its baked frames');
assert.match(villageLifeSource, /syncFigure\(this\.scene,\s*t\.gfx,\s*'thief'/, 'the thief must try its baked frames');
assert.match(villageLifeSource, /syncFigure\(this\.scene,\s*g,\s*'owl'/, 'the owl must try its baked frames');
assert.match(readSource('src/game/systems/NeighborLifeSim.ts'), /syncFigure\(/,
  'neighbor residents must try the baked villager frames');
assert.match(worldMapSource, /syncFigure\(this\.scene,\s*g,\s*`traveller_/,
  'road travellers must try their baked frames');
assert.match(mainSceneSource, /syncProjectileSprite\(/,
  'rigid projectiles must route through the baked-projectile path');

// PixelDraw: live layers that cannot be baked draw whole cells, never AA shapes.
assert.match(worldMapSource, /pixelEllipse\(/, 'road details + cloud puffs must draw as pixel cells');
assert.match(worldMapSource, /pixelLine\(/, 'road ruts/shoulders must draw as pixel cell lines');
assert.match(villageLifeSource, /pixelBitmap\(/, 'speech bubbles/emotes must be hand-authored pixel art');
assert.match(villageLifeSource, /quantizeRenderTexture\(this\.scene,\s*this\.stoneRT/,
  'the stone lanes must present through the quantized RT (ground-bake model)');
assert.match(mainSceneSource, /pixelRing\(/, 'combat FX rings must be cell rings, not stroked ellipses');
// One-shot effects route through the shared PixelFx vocabulary.
assert.match(readSource('src/game/systems/PixelFx.ts'), /static\s+(burst|flash|ring)\b/,
  'PixelFx must expose the shared effect vocabulary');
assert.match(mainSceneSource, /PixelFx\.(burst|flash|ring|stampRing)\(/,
  'MainScene one-shot effects must use PixelFx');
assert.match(villageLifeSource, /PixelFx\.burst\(/,
  'village sparkles must use PixelFx.burst');
for (const [file, label] of [
  ['src/game/systems/WeatherSystem.ts', 'weather'],
  ['src/game/systems/DayNightSystem.ts', 'night life'],
  ['src/game/renderers/WorldHydrologyRenderer.ts', 'hydrology'],
  ['src/game/renderers/VillageFlagRenderer.ts', 'flags'],
  ['src/game/renderers/WorldFigureRenderer.ts', 'world figures']
]) {
  assert.match(readSource(file), /pixel(Ellipse|Line|Rect|Bitmap|Blob)\(/,
    `${label} must draw through PixelDraw cells`);
}
// No live smooth primitives may return to the converted FX surfaces.
for (const file of ['src/game/scenes/MainScene.ts', 'src/game/systems/WeatherSystem.ts', 'src/game/systems/DayNightSystem.ts']) {
  const src = readSource(file);
  for (const call of ['strokeEllipse(', 'strokeCircle(', 'this.add.circle(', 'scene.add.circle(']) {
    assert.equal(src.includes(call), false, `${file} reintroduces smooth ${call.replace('(', '')}`);
  }
}

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
assert.deepEqual(manifestsByKind,
  { buildings: 21, figures: 10, obstacles: 5, projectiles: 11, troops: 47, villagers: 11, wrecks: 19 },
  'expected manifests for 21 buildings (tournament resolved: plain cannon + plain mortar; frostfall pending as @A/@B/@C variant slots), 46 troops (11 plain — golem + icegolem; ward/recursion/giant/sharpshooter deleted with their musket_ball projectile — plus 35 tournament variant dirs: 10 units × @A/@B/@C incl. skeleton, hawkeyeassassin at @A/@B only), 19 wrecks, 5 obstacles, 11 villagers, 10 figures and 11 projectiles (trebuchet_stone + ornithopter_bomb joined 2026-07)');
assert.equal(manifestFiles.length, 124, 'the baked unit roster changed size');

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
    // EXCEPTION: flying troops (ornithopter) anchor at the GROUND point below
    // the airborne body, so a trimmed hover frame legitimately carries an
    // originY well past 1.5 (observed max 2.815 at hover apex) — SpriteBank
    // feeds it to setOrigin verbatim and Phaser handles out-of-frame origins.
    const maxOriginY = kindOf(manifestFile) === 'troops' ? 3.0 : 1.5;
    assert.ok(Number.isFinite(frame.originX) && frame.originX >= -0.5 && frame.originX <= 1.5,
      `${label} has invalid originX`);
    assert.ok(Number.isFinite(frame.originY) && frame.originY >= -0.5 && frame.originY <= maxOriginY,
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
const wallManifestSource = readSource('public/assets/sprites/buildings/wall/manifest.json');
const wallAtlas = JSON.parse(readSource('public/assets/sprites/buildings/wall/atlas.json'));
assert.doesNotMatch(wallManifestSource, /m(?:NS|EW)_gate|\bisGate\b/,
  'the wall manifest still contains a removed gate variant');
assert.equal(Object.keys(wallAtlas.frames).some(name => /_gate_/.test(name)), false,
  'the packed wall atlas still contains a removed gate frame');
assert.equal(emittedPngs.some(file => /^buildings\/wall\/.*_gate_/.test(file)), false,
  'a removed loose wall-gate PNG is still committed');
assert.deepEqual(framesByKind,
  { buildings: 8_224, figures: 180, obstacles: 872, projectiles: 374, troops: 45_396, villagers: 2_924, wrecks: 71 },
  'the baked roster is incomplete');
assert.equal(frameCount, 58_041,
  '8,224 building (incl. frostfall@A/B/C tournament variants, 208 frames each, old frostfall retired) + 44,244 troop (11,664 plain — ward/recursion/giant/sharpshooter deleted 2026-07 — plus 32,580 tournament @-variant frames: goblinplunderer/clockworkbeetle/physicianscart/pavisebearer/quartermaster/siegetower/necromancer/trebuchet/warelephant/ornithopter/skeleton slots, hawkeyeassassin @A/@B only) + 71 wreck + 872 obstacle (16 hash buckets; grass_patch look-keyed at 6 variants + 4 eggs) + 2,924 villager (carry states for all adult roles, elder work, child sleep; stall assembly stages) + 180 figure (caravan_soldier escort palettes refreshed by the 2026-07 figures re-bake) + 374 projectile frames (trebuchet_stone 48 + ornithopter_bomb 1 joined) '
  + '(dense ambient/idle loops; every defense idles — turrets bake per-angle idle loops; tournament finals resolved the @-variant slots: plain cannon (ex-@B) and reverted plain mortar rebaked, plain golem (ex-@C) plus the new icegolem troop; '
  + 'walls carry a per-topology GROUND decal now — the contact shadow stamped under the body by SpriteBank\'s wall-ground slot, 64 frames)');
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
