import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

const battleResultsModalUrl = new URL('../src/components/BattleResultsModal.tsx', import.meta.url)
const [app, appCss, notifications, backend, scene, worldMap, villageLife] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/NotificationsPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/backend/GameBackend.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/scenes/MainScene.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/systems/WorldMapSystem.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/systems/VillageLifeSystem.ts', import.meta.url), 'utf8')
])

assert.equal(existsSync(battleResultsModalUrl), false,
  'The end-of-battle results modal must stay removed')
for (const symbol of ['BattleResultsModal', 'RaidReportStats', 'showBattleResults', 'pendingBattleResultsRef', 'heldLootRef']) {
  assert.doesNotMatch(app, new RegExp(symbol),
    `${symbol} must not restore the dismissed end-of-battle popup path`)
}
assert.doesNotMatch(appCss, /\.battle-results|\.battle-home-btn/,
  'Removed battle-results UI must not leave orphan modal styling')

const raidEndHandler = app.slice(app.indexOf('onRaidEnded:'), app.indexOf('onRetreatEnded:'))
assert.match(raidEndHandler, /transitionHome\(applied\?\.settlementDelayed \? 0 : lootWon\);/,
  'A natural battle finish must carry confirmed gold into the home resource animation')
const retreatEndHandler = app.slice(app.indexOf('onRetreatEnded:'), app.indexOf('getArmy:'))
assert.match(retreatEndHandler, /const reward = Math\.floor\(results\.goldLooted\);[\s\S]*?cloudTransitionRewardRef\.current = reward;[\s\S]*?setCloudTransitionReward\(reward\);/,
  'A retreat must inject confirmed gold into an already-running cloud transition')
assert.match(retreatEndHandler, /if \(results\.settlementDelayed\) \{[\s\S]*?gameManager\.showToast\(/,
  'A delayed retreat settlement must explain why no reward animates yet')

assert.doesNotMatch(app, /Backend\.endAttack\(/,
  'App must consume MainScene settlement results instead of settling PvP twice')
assert.match(app, /onRevenge=\{handleDirectUserAttack\}/,
  'Revenge must route through the shared direct-user army gate')
assert.doesNotMatch(notifications, /gameManager\.startAttackOnUser/,
  'Notification UI must not bypass App attack gating')

for (const field of ['x', 'y', 'seed']) {
  assert.match(backend, new RegExp(`Number\\.isInteger\\(result\\.${field}\\)`),
    `Bot start must validate integer ${field}`)
}
assert.ok((backend.match(/Backend\.validStartedBotRaid\(result\)/g) ?? []).length >= 2,
  'Normal and recovered bot starts must share runtime validation')

assert.ok((scene.match(/arriveAndFight\(/g) ?? []).length >= 3,
  'All issued attack starts must use the shared in-place arrival handoff')
assert.match(scene, /onMidpoint\(epoch\)\)[\s\S]*?\.finally\(\(\) => \{[\s\S]*?finishExclusiveTransition\(epoch\)/,
  'The cloud-transition midpoint must always release the transition lock in its finally')
assert.match(scene, /private async arriveAndFight\([\s\S]*?Backend\.endAttack\(meta\.attackId, 'aborted'[\s\S]*?await this\.abortBotSession\(meta\)/,
  'Arrival failure paths must close both the player attack and bot raid sessions')
assert.match(worldMap, /prepareFocus[\s\S]*?const focusRadius = 1;/,
  'Battle focus must remain one local 3x3 ring regardless of exploration sight')

const nextMapHandler = scene.slice(
  scene.indexOf('findNewMap: () => {'),
  scene.indexOf('deleteSelectedBuilding:', scene.indexOf('findNewMap: () => {'))
)
assert.match(nextMapHandler, /const excludeTargetId = this\.currentEnemyWorld\?\.isBot[\s\S]*?: this\.currentEnemyWorld\?\.id;[\s\S]*?await this\.abandonCurrentAttack\(\);[\s\S]*?const loaded = await this\.generateFindMatchVillage\(epoch, \{ excludeTargetId \}\);/,
  'NEXT must capture the skipped player, close its reservation, then run the shared FIND MATCH path')
assert.doesNotMatch(nextMapHandler, /const loaded = await this\.generateEnemyVillage\(epoch\);/,
  'NEXT must never switch a world-map player search into the bot generator')
const findMatchHelper = scene.slice(
  scene.indexOf('private generateFindMatchVillage('),
  scene.indexOf('// Matchmake against a random online player.')
)
assert.match(findMatchHelper, /Auth\.isOnlineMode\(\)[\s\S]*?generateOnlineEnemyVillage\(epoch, options\)[\s\S]*?generateEnemyVillage\(epoch\)/,
  'FIND MATCH and NEXT must share one online world-map matcher with only the offline fallback')
assert.equal((scene.match(/const loaded = await this\.generateFindMatchVillage\(epoch\);/g) ?? []).length, 2,
  'Both initial FIND MATCH commands must use the shared loader without an exclusion')

const pendingStartParser = backend.slice(
  backend.indexOf('function parsePendingBattleStart('),
  backend.indexOf('function readPendingBattleStartRecord(')
)
assert.match(pendingStartParser, /excludeTargetId[\s\S]*?parsed\.excludeTargetId/,
  'A pending NEXT must retain its excluded player through storage parsing')
const battleReconciliation = backend.slice(
  backend.indexOf('static async reconcileInterruptedBattle('),
  backend.indexOf('static async placeBuilding(')
)
assert.match(battleReconciliation, /pending\.matchmade && pending\.excludeTargetId[\s\S]*?excludeTargetId: pending\.excludeTargetId/,
  'Crash recovery must resend the same player exclusion with the stable request id')
const matchedAttackStart = backend.slice(
  backend.indexOf('static async startMatchedAttack('),
  backend.indexOf('static async startAttackOnUser(')
)
assert.match(matchedAttackStart, /rememberPendingBattleStart[\s\S]*?excludeTargetId[\s\S]*?\/api\/attacks\/matchmake[\s\S]*?excludeTargetId/,
  'The match gateway must persist and send NEXT exclusions')

const combatAdapter = scene.slice(
  scene.indexOf('private updateCombat('),
  scene.indexOf('private shootMortarAt(')
)
assert.match(combatAdapter, /else if \(\(stats\.chainCount \?\? 0\) > 0\)/,
  'chain presentation must dispatch from declarative stats instead of troop ids')
assert.match(combatAdapter, /else if \(stats\.range > 1\)[\s\S]*?showGenericRangedAttack/,
  'unnamed declarative ranged troops must use the generic ranged adapter')
assert.match(scene, /private applyDeclarativeTroopHit\([\s\S]*?stats\.splashRadius[\s\S]*?falloff = 0\.6/,
  'the local generic hit adapter must apply declared splash to clustered buildings')
for (const type of ['goblinplunderer', 'wallbreaker', 'stormmage', 'necromancer']) {
  assert.doesNotMatch(combatAdapter, new RegExp(`troop\\.type === '${type}'`),
    `${type} must not regain a type-hardcoded punch adapter`)
}

assert.doesNotMatch(villageLife, /fallbackBarracks/,
  'Core troop figures must never fall back to an arbitrary faction Barracks')
assert.match(villageLife, /building\.type === FACTION_BARRACKS\[faction\]/,
  'Faction troop figures must use only their exact faction Barracks')
assert.match(villageLife, /getTroopFaction\(type as TroopType\)[\s\S]*?\? factionBarracksFor\(type as TroopType\)[\s\S]*?: coreCamp/,
  'Dismissed Core troop figures must return to their assigned Army Camp')
assert.match(villageLife, /const trainingBuilding = getTroopFaction\(type\) \? factionBarracks : coreCamp;/,
  'Fresh Core troop figures must originate at their assigned Army Camp')

console.log('client attack path regression: 39 checks passed')
