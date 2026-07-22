import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

const battleResultsModalUrl = new URL('../src/components/BattleResultsModal.tsx', import.meta.url)
const [app, appCss, notifications, backend, gameManager, scene, inputController, worldMap, villageLife, villageBubbles] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/NotificationsPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/backend/GameBackend.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/GameManager.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/scenes/MainScene.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/scenes/controllers/SceneInputController.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/systems/WorldMapSystem.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/systems/VillageLifeSystem.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/systems/VillageBubbles.ts', import.meta.url), 'utf8')
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
assert.equal((backend.match(/Backend\.validStartedBotRaid\(result\)/g) ?? []).length, 1,
  'A fresh bot start must require the full presentation contract')
assert.equal((backend.match(/reservedArmy: Record<string, number>;/g) ?? []).length, 2,
  'PvP and bot attack-start contracts must both carry the server-reserved army')
assert.ok((backend.match(/Backend\.validReservedArmy\(result\.reservedArmy\)/g) ?? []).length >= 3,
  'Every PvP and bot attack-start response must runtime-validate its reserved army')

const managerPin = gameManager.slice(
  gameManager.indexOf('pinAttackArmy('),
  gameManager.indexOf('hasPinnedAttackArmy(')
)
assert.match(managerPin, /this\.pinnedAttackArmy = \{ reservationId, army: pinned \};[\s\S]*?onAttackArmyPinned\?\.\(\{ \.\.\.pinned \}\)/,
  'Attack army pinning must publish synchronously before React or HOME polling can race it')
assert.match(gameManager, /getArmy\(\) \{[\s\S]*?return this\.pinnedAttackArmy\?\.army \?\? this\.uiHandlers\.getArmy\?\.\(\) \?\? \{\};/,
  'All scene army reads must prefer the active server reservation')
const managerDeploy = gameManager.slice(
  gameManager.indexOf('deployTroop(type: string)'),
  gameManager.indexOf('refreshCampCapacity(', gameManager.indexOf('deployTroop(type: string)'))
)
assert.match(managerDeploy, /this\.pinnedAttackArmy = \{ \.\.\.this\.pinnedAttackArmy, army: next \};[\s\S]*?this\.uiHandlers\.deployTroop\?\.\(type, pinnedArmy\);/,
  'Deployment must decrement the synchronous reservation before notifying React')
assert.match(app, /if \(!gameManager\.hasPinnedAttackArmy\(\)\) Backend\.updateArmy\(userId, army\);/,
  'HOME persistence must not write a reserved battle army back to the server cache')
assert.match(app, /if \(world\.army && !gameManager\.hasPinnedAttackArmy\(\)\) \{[\s\S]*?armyRef\.current = nextArmy;/,
  'Own-world heartbeats must not erase a pinned army during slow battle loading')
assert.match(app, /onAttackArmyPinned:[\s\S]*?armyRef\.current = pinned;[\s\S]*?onAttackArmyReleased:/,
  'The React army ref must mirror a reservation synchronously and expose a release path')
assert.match(app, /const currentArmy = gameManager\.getArmy\(\);[\s\S]*?setVisibleTroops\(battleTroops\);/,
  'ATTACK-mode HUD setup must read GameManager reservation truth, not a stale React ref')

assert.ok((scene.match(/arriveAndFight\(/g) ?? []).length >= 3,
  'All issued attack starts must use the shared in-place arrival handoff')
assert.equal((scene.match(/reservedArmy: (?:started|startedAttack)\.reservedArmy/g) ?? []).length, 4,
  'Bot plot, generated bot, matchmade PvP, and direct-user PvP must all pin their start army')
const arrivalHandoff = scene.slice(
  scene.indexOf('private async arriveAndFight('),
  scene.indexOf('/** Live destruction percentage', scene.indexOf('private async arriveAndFight('))
)
const pinAt = arrivalHandoff.indexOf('gameManager.pinAttackArmy(')
const armyReadAt = arrivalHandoff.indexOf('gameManager.getArmy()')
const slowLoadAt = arrivalHandoff.indexOf('await Promise.all([')
assert.ok(pinAt >= 0 && pinAt < armyReadAt && armyReadAt < slowLoadAt,
  'The authoritative army must be pinned before the first read and before slow focus/sprite loading')
const botAttackLoader = scene.slice(
  scene.indexOf('private async generateEnemyVillage('),
  scene.indexOf('/** A fresh FIND MATCH', scene.indexOf('private async generateEnemyVillage('))
)
assert.match(botAttackLoader, /id: started\.world\.ownerId/,
  'Bot battle presentation must use the server-persisted village identity, never a seed-derived alias')
assert.doesNotMatch(botAttackLoader, /id: `bot_\$\{started\.seed/,
  'Bot seeds are provenance and must never become client entity/cache identities')
assert.match(scene, /onMidpoint\(epoch\)\)[\s\S]*?\.finally\(\(\) => \{[\s\S]*?finishExclusiveTransition\(epoch\)/,
  'The cloud-transition midpoint must always release the transition lock in its finally')
assert.match(scene, /private async abortUnpresentedAttack\([\s\S]*?await this\.abortBotSession\(meta\)[\s\S]*?Backend\.endAttack\(meta\.attackId, 'aborted'[\s\S]*?gameManager\.releaseAttackArmy\(reservationId\)/,
  'Arrival failure paths must close both the player attack and bot raid sessions')
assert.match(worldMap, /prepareFocus[\s\S]*?const focusRadius = 1;/,
  'Battle focus must remain one local 3x3 ring regardless of exploration sight')

const nextMapHandler = scene.slice(
  scene.indexOf('findNewMap: () => {'),
  scene.indexOf('deleteSelectedBuilding:', scene.indexOf('findNewMap: () => {'))
)
assert.match(nextMapHandler, /if \(this\.currentEnemyWorld && !this\.currentEnemyWorld\.isBot\) \{[\s\S]*?this\.recordMatchmakeOffer\(this\.currentEnemyWorld\.id\);[\s\S]*?await this\.abandonCurrentAttack\(\);[\s\S]*?const loaded = await this\.generateFindMatchVillage\(epoch\);/,
  'NEXT must add the skipped player to the strict session exclusions, close its reservation, then run the shared FIND MATCH path')
assert.doesNotMatch(nextMapHandler, /const loaded = await this\.generateEnemyVillage\(epoch\);/,
  'NEXT must never switch a world-map player search into the bot generator directly')
assert.doesNotMatch(nextMapHandler, /resetMatchmakeSession/,
  'NEXT must keep the cycling session alive — only a fresh FIND MATCH resets it')
assert.match(nextMapHandler, /const skippedReservationId[\s\S]*?await this\.abandonCurrentAttack\(\);[\s\S]*?gameManager\.releaseAttackArmy\(skippedReservationId\);[\s\S]*?generateFindMatchVillage\(epoch\)/,
  'NEXT must release only the settled old reservation before starting its replacement')
const findMatchHelper = scene.slice(
  scene.indexOf('private async generateFindMatchVillage('),
  scene.indexOf('// Matchmake against a random online player.')
)
assert.match(findMatchHelper, /if \(!Auth\.isOnlineMode\(\)\) return this\.generateEnemyVillage\(epoch\);/,
  'Offline play must keep the local practice generator')
assert.match(findMatchHelper, /if \(this\.matchmakePhase === 'bots'\) return this\.generateEnemyVillage\(epoch\);/,
  'After pool exhaustion NEXT must keep cycling bot camps until a fresh FIND MATCH')
assert.match(findMatchHelper, /excludeTargetIds: \[\.\.\.this\.matchmakeSeenTargetIds\]/,
  'Player searches must send the strict session exclusions to the server')
assert.match(findMatchHelper, /if \(loaded !== 'no-players'\) return loaded;[\s\S]*?this\.matchmakePhase = 'bots';[\s\S]*?return this\.generateEnemyVillage\(epoch\);/,
  'Only a server-reported empty/exhausted player pool may transition the session to bot camps')
assert.equal((scene.match(/const loaded = await this\.generateFindMatchVillage\(epoch\);/g) ?? []).length, 3,
  'FIND MATCH and NEXT must all use the shared loader (session state carries the exclusions)')
assert.equal((scene.match(/this\.resetMatchmakeSession\(\);/g) ?? []).length, 2,
  'Both initial FIND MATCH commands must reset the cycling session back to players')
assert.match(scene, /enemy\?\.isBot \? ' · BOT' : ' · PLAYER'/,
  'Server-issued raid targets must be labeled PLAYER or BOT in the Town Hall tooltip')
assert.doesNotMatch(scene, /fontFamily: 'Outfit|setAngle\(-26\.5\)/,
  'Enemy identity must not return to the angled lawn text presentation')
assert.match(scene, /key: 'enemy-village-name'[\s\S]*?townHallApexLift\(hall\.level \?\? 1\)[\s\S]*?visibleModes: \['ATTACK', 'REPLAY'\]/,
  'Enemy identity must use the sticky world-anchored tooltip above the Town Hall')
assert.match(scene, /owner === 'PLAYER' && this\.mode === 'ATTACK' && !this\.isScouting[\s\S]*?this\.setVillageNameVisible\(false\)/,
  'The first real troop deployment must dismiss the Town Hall tooltip')
assert.match(villageBubbles, /visibleModes\?: readonly GameMode\[\][\s\S]*?live\.spec\.visibleModes\?\.includes\(this\.scene\.mode\)/,
  'Village bubbles must explicitly opt into visibility outside HOME mode')

const pointerDownHandler = inputController.slice(
  inputController.indexOf('onPointerDown(pointer:'),
  inputController.indexOf('async onPointerUp(pointer:')
)
assert.match(pointerDownHandler, /!this\.startedOnGameCanvas\(pointer\)[\s\S]*?this\.resetPointerGameplayState\(\);[\s\S]*?return;/,
  'DOM-origin pointer downs must be rejected before deployment starts')
assert.match(inputController, /pointer\.downElement === this\.scene\.game\.canvas/,
  'The native pointer-down target must define the DOM/gameplay input boundary')
assert.match(inputController, /!pointer\.isDown \|\| this\.isPointerSuppressed\(pointer\) \|\| !this\.startedOnGameCanvas\(pointer\)/,
  'Clock-driven hold deployment must reject gestures that began on DOM UI')

const pendingStartParser = backend.slice(
  backend.indexOf('function parsePendingBattleStart('),
  backend.indexOf('function readPendingBattleStartRecord(')
)
assert.match(pendingStartParser, /excludeTargetId[\s\S]*?parsed\.excludeTargetId/,
  'A pending NEXT must retain its excluded player through storage parsing')
assert.match(pendingStartParser, /parsed\.excludeTargetIds[\s\S]*?\.slice\(-64\)/,
  'A pending NEXT must retain its bounded strict exclusion list through storage parsing')
const battleReconciliation = backend.slice(
  backend.indexOf('static async reconcileInterruptedBattle('),
  backend.indexOf('static async placeBuilding(')
)
assert.match(battleReconciliation, /Backend\.validStartedBotRaidIdentity\(result\)[\s\S]*?rememberBattle\(user\.id, \{ kind: 'bot'[\s\S]*?await Backend\.botSettle\(/,
  'Recovery must abort an identified bot reservation even when its army snapshot is unsafe to present')
assert.match(battleReconciliation, /pending\.matchmade && pending\.excludeTargetId[\s\S]*?excludeTargetId: pending\.excludeTargetId/,
  'Crash recovery must resend the same player exclusion with the stable request id')
assert.match(battleReconciliation, /pending\.matchmade && pending\.excludeTargetIds\?\.length[\s\S]*?excludeTargetIds: pending\.excludeTargetIds/,
  'Crash recovery must resend the same strict exclusion list with the stable request id')
const matchedAttackStart = backend.slice(
  backend.indexOf('static async startMatchedAttack('),
  backend.indexOf('static async startAttackOnUser(')
)
assert.match(matchedAttackStart, /rememberPendingBattleStart[\s\S]*?excludeTargetId[\s\S]*?\/api\/attacks\/matchmake[\s\S]*?excludeTargetId/,
  'The match gateway must persist and send NEXT exclusions')
assert.match(matchedAttackStart, /status === 404\) return 'no-players';/,
  "An empty or exhausted player pool must resolve 'no-players' for the bot fallback, never a thrown failure")

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
// Necromancer left this list with the troop overhaul: its bespoke orb
// presentation (showNecromancerOrb) is intentional, like the beetle latch
// and siege-tower park in the same dispatch chain.
for (const type of ['goblinplunderer', 'wallbreaker', 'stormmage']) {
  assert.doesNotMatch(combatAdapter, new RegExp(`troop\\.type === '${type}'`),
    `${type} must not regain a type-hardcoded punch adapter`)
}

const siegeParking = scene.slice(
  scene.indexOf('private parkSiegeTower('),
  scene.indexOf('private rampSetFor(', scene.indexOf('private parkSiegeTower('))
)
assert.match(siegeParking, /approvedRampWallId = troop\.navigationPlan\?\.topologyRevision === this\.combatTopologyRevision[\s\S]*?troop\.navigationPlan\.rampWallId[\s\S]*?target\.type !== 'wall'[\s\S]*?target\.id !== approvedRampWallId[\s\S]*?return;/,
  'Siege Tower deployment must require the exact wall authorized by its current topology revision')
assert.match(combatAdapter, /troop\.type === 'siegetower'[\s\S]*?targetWall\.type !== 'wall' \|\| targetWall\.id !== approvedRampWallId[\s\S]*?troop\.attackClockActive = false;[\s\S]*?return;/,
  'The no-wall Town Hall fallback must not start even a partial Siege Tower deployment animation')

const troopMovement = scene.slice(
  scene.indexOf('private updateTroops('),
  scene.indexOf('private destroyBuilding(', scene.indexOf('private updateTroops('))
)
assert.match(troopMovement, /candidate\.health <= 0 \|\| candidate\.type === 'siegetower'/,
  'Rolling and parked Siege Towers must stay out of the local troop-separation obstacle grid')
assert.equal((troopMovement.match(/if \(troop\.type !== 'siegetower'\) \{\s*forEachNeighbor/g) ?? []).length, 2,
  'Moving and holding Siege Towers must ignore ally separation while retaining structure collision')
assert.match(troopMovement, /finalApproachStillOutOfRange = troop\.path\.length === 1[\s\S]*?geometry\.distance > geometry\.stopRange;[\s\S]*?if \(finalApproachStillOutOfRange\) break;/,
  'A short-range final waypoint must not be discarded before the target is truly in range')
assert.match(troopMovement, /moveDir\.lengthSq\(\) > 0\.000_000_01/,
  'Sub-cell final approaches must retain precise movement below the old 0.01-tile cutoff')

const battleEnd = scene.slice(
  scene.indexOf('private checkBattleEnd('),
  scene.indexOf('private getDefenseStats(', scene.indexOf('private checkBattleEnd('))
)
assert.match(battleEnd, /activeRaidTroops[\s\S]*?stats\.damage > 0[\s\S]*?if \(!target\) return false;[\s\S]*?holdingAtFallback[\s\S]*?stats\.range \+ 0\.08[\s\S]*?armyRemaining <= 0 && activeRaidTroops === 0 && this\.pendingSpawnCount === 0/,
  'A routeable no-wall Siege Tower must finish its Town Hall fallback without letting an unrouteable tower hang the raid')
assert.match(scene, /private replaySiegeRampWallNear\([\s\S]*?building\.type !== 'wall'[\s\S]*?interactionRange[\s\S]*?const rampWall = this\.replaySiegeRampWallNear\(troop\);[\s\S]*?motionDist > 0\.004 \|\| !rampWall/,
  'Replay watch may infer a deployed Siege Tower only when it is stationary at a live enemy wall')
assert.match(scene, /rampAuthorizationInvalidated = removed\.type === 'wall'[\s\S]*?troop\.parked01 === undefined[\s\S]*?troop\.navigationPlan\?\.rampWallId[\s\S]*?urgent = intentDestroyed \|\| activeDestroyed \|\| routeBlockerDestroyed[\s\S]*?rampAuthorizationInvalidated[\s\S]*?troop\.nextPathTime = rampAuthorizationInvalidated[\s\S]*?\? now/,
  'Destroying any wall must revoke and immediately reacquire an unparked Siege Tower first-ray-wall authorization')

const botSettlement = scene.slice(
  scene.indexOf('private async settleBotRaid('),
  scene.indexOf('/** Clicked on (or near)', scene.indexOf('private async settleBotRaid('))
)
assert.match(botSettlement, /this\.botRaidSettled = true;[\s\S]*?gameManager\.releaseAttackArmy\(enemy\.botRaidId\);/,
  'Bot settlement must release its own pin only after authoritative army adoption')
const pvpSettlement = scene.slice(
  scene.indexOf('private endAttackReplayCapture('),
  scene.indexOf('private createReplayTroop(', scene.indexOf('private endAttackReplayCapture('))
)
assert.match(pvpSettlement, /Backend\.endAttack\([\s\S]*?\.then\(result => \{[\s\S]*?gameManager\.releaseAttackArmy\(state\.attackId\);/,
  'PvP settlement must release its own pin only after authoritative army adoption')
const goHome = scene.slice(
  scene.indexOf('public async goHome()'),
  scene.indexOf('private calculateMaxCameraZoom(', scene.indexOf('public async goHome()'))
)
assert.match(goHome, /await this\.settleBotRaid\(\);[\s\S]*?gameManager\.releaseAttackArmy\(\);[\s\S]*?gameManager\.setGameMode\('HOME'\);/,
  'Returning home must retain the pin through settlement and then clear any recovery fallback')

assert.doesNotMatch(villageLife, /fallbackBarracks/,
  'Core troop figures must never fall back to an arbitrary faction Barracks')
assert.match(villageLife, /building\.type === FACTION_BARRACKS\[faction\]/,
  'Faction troop figures must use only their exact faction Barracks')
assert.match(villageLife, /getTroopFaction\(type as TroopType\)[\s\S]*?\? factionBarracksFor\(type as TroopType\)[\s\S]*?: coreCamp/,
  'Dismissed Core troop figures must return to their assigned Army Camp')
assert.match(villageLife, /const trainingBuilding = getTroopFaction\(type\) \? factionBarracks : coreCamp;/,
  'Fresh Core troop figures must originate at their assigned Army Camp')

console.log('client attack path regression: all checks passed (reserved-army race covered)')
