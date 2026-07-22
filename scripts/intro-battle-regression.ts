import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INTRO_BATTLE_ARMY,
  INTRO_BATTLE_ARMY_SPACE,
  INTRO_BATTLE_WORLD_ID,
  createSirAndreIntroWorld
} from '../src/game/config/IntroBattle';
import { BUILDING_DEFINITIONS } from '../src/game/config/GameDefinitions';

const world = createSirAndreIntroWorld(1234);
assert.equal(world.id, INTRO_BATTLE_WORLD_ID);
assert.equal(world.lastSaveTime, 1234);

const occupied = new Map<string, string>();
const buildingCounts = new Map<string, number>();
for (const building of world.buildings) {
  const definition = BUILDING_DEFINITIONS[building.type];
  assert.ok(definition, `unknown tutorial building ${building.type}`);
  assert.equal(building.level, definition.maxLevel, `${building.id} is not max level`);
  assert.ok(building.gridX >= 0 && building.gridY >= 0, `${building.id} starts outside the plot`);
  assert.ok(building.gridX + definition.width <= 25, `${building.id} exceeds the east edge`);
  assert.ok(building.gridY + definition.height <= 25, `${building.id} exceeds the south edge`);
  buildingCounts.set(building.type, (buildingCounts.get(building.type) ?? 0) + 1);
  for (let x = building.gridX; x < building.gridX + definition.width; x += 1) {
    for (let y = building.gridY; y < building.gridY + definition.height; y += 1) {
      const key = `${x},${y}`;
      assert.equal(occupied.get(key), undefined, `${building.id} overlaps ${occupied.get(key)} at ${key}`);
      occupied.set(key, building.id);
    }
  }
}

for (const [type, count] of buildingCounts) {
  assert.ok(
    count <= BUILDING_DEFINITIONS[type].maxCount,
    `tutorial has ${count} ${type} buildings but a legal village allows ${BUILDING_DEFINITIONS[type].maxCount}`
  );
}
assert.equal(
  buildingCounts.get('wall'),
  BUILDING_DEFINITIONS.wall.maxCount,
  'tutorial needs the full legal 100-wall double-curtain fortress'
);
for (const type of ['dragons_breath', 'mortar', 'xbow', 'ballista', 'spike_launcher', 'prism', 'tesla'] as const) {
  assert.ok(world.buildings.some(building => building.type === type), `tutorial fortress is missing ${type}`);
}

assert.ok(INTRO_BATTLE_ARMY.golem >= 2, 'tutorial must feature multiple Golems');
assert.ok(INTRO_BATTLE_ARMY.davincitank >= 2, 'tutorial must feature multiple Da Vinci Tanks');
assert.ok(INTRO_BATTLE_ARMY.trebuchet >= 3, 'tutorial must feature a Trebuchet battery');
assert.ok(INTRO_BATTLE_ARMY.siegetower >= 1, 'tutorial must teach Siege Tower deployment');
assert.equal(INTRO_BATTLE_ARMY.wallbreaker, 0);
assert.equal(INTRO_BATTLE_ARMY.goblinplunderer, 0);
assert.equal(INTRO_BATTLE_ARMY.stormmage, 0);
assert.equal(INTRO_BATTLE_ARMY.physicianscart, 0);
assert.ok(INTRO_BATTLE_ARMY_SPACE > 150, 'the tutorial army should feel larger than an ordinary camp cap');

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const hudSource = readFileSync(new URL('../src/components/Hud.tsx', import.meta.url), 'utf8');
const sceneSource = readFileSync(new URL('../src/game/scenes/MainScene.ts', import.meta.url), 'utf8');
assert.match(appSource, /beginVillageLoadCloud\(4\);[\s\S]*?setNeedsAccount\(false\);/,
  'account admission must close clouds before removing the auth gate');
assert.match(appSource, /introBattleRequiredRef\.current\) \{[\s\S]*?setShowCloudOverlay\(true\);/,
  'required onboarding must keep clouds closed even when the starter scene fails');
assert.match(appSource, /introOnboardingBlocksGame = introBattleRequired[\s\S]*?view === 'ATTACK'/,
  'the ordinary game shell must remain inert until the tutorial battle is interactive');
assert.match(appSource, /gameManager\.pinAttackArmy\(INTRO_BATTLE_WORLD_ID, suppliedArmy\)/,
  'the supplied army must use the synchronous reservation path');
assert.match(hudSource, /!battleStarted && !isMobile && allowNextMap/,
  'the normal NEXT control must be absent from the authored tutorial target');
assert.match(sceneSource, /findNewMap: \(\) => \{[\s\S]*?if \(this\.currentEnemyWorld\?\.tutorial\) return;/,
  'the scene must defensively reject tutorial NEXT calls outside React');
assert.match(sceneSource, /beginAttackSession\(false, epoch, \{ skipHomeFlush: true \}\)/,
  'banner-blocked starter saves must never deadlock the local tutorial launch');

console.log(`intro battle regression passed (${world.buildings.length} max-level buildings, ${INTRO_BATTLE_ARMY_SPACE} housing supplied)`);
