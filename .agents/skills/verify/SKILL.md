---
name: verify
description: Build, run, and drive the clash game end-to-end in a headless browser to verify changes at the real surface (browser UI + HTTP API).
---

# Verifying clash-game changes

## Build + run

```bash
npm run build                      # tsc -b + vite build (dist/) + esbuild server (dist-server/)
PORT=8788 CLASH_DATA_DIR=$(mktemp -d) node dist-server/index.mjs &   # serves game + API on one port
curl -s http://127.0.0.1:8788/api/health                             # {"ok":true,...}
```

The production server serves `dist/` from disk per request, so rebuilding the
client does NOT require a server restart — but player records are cached in
memory, so wiping/reseeding `CLASH_DATA_DIR` DOES require a restart.

## API surface

`scripts/integration-test.mjs` covers the whole HTTP API (auth/accounts, saves,
resources, attacks, replays, notifications) against a real server on port 8791:

```bash
npm run test:server
```

## Browser surface (Playwright)

Install playwright in the scratchpad (NOT the repo) and drive Chromium headless.
Key handles:

- Boot: wait for `canvas` + `.settings-btn`, then ~4-5s for the cloud-reveal
  animation before screenshots (screenshots during reveal are all white).
- Account modal: `.settings-btn` opens it; guest shows `.account-tabs` with
  PROFILE / SAVE VILLAGE / LOG IN; registered profile shows `.logout-btn`.
  Register/login forms: `input[autocomplete="username"]`, `input[type="password"]`,
  submit `.account-panel button[type="submit"]`; success notice `.account-warning`,
  errors `.account-error`. Login and logout reload the page (waitForNavigation).
- "New device" simulation: `page.evaluate(() => localStorage.clear())` + reload.
- Battle: bottom bar `.action-btn.raid` opens the training modal
  (`.training-modal`); click `.troop-grid-item` cells to train (costs SOL),
  then `.header-btn.practice` starts a practice raid. Deploy by clicking grass
  near the base edge. Watch `page.on('pageerror')` — a clean battle logs none.
- Bottom-bar TEST (`.action-btn.test`) is the scarecrow dummy toggle, NOT battle.
- PRACTICE (`.header-btn.practice`) is DISABLED until at least one troop is
  trained — click a `.troop-grid-item` first or the click times out.
- Day/night: `scene.dayNight.setPhaseOverride(t)` pins the cycle (0.6 sunset,
  0.8 deep night, 0.3 day, null = wall clock). `nightFactor()`, `strength`
  (0 in ATTACK/REPLAY), `buildingLights` (Map). Night sends villagers indoors
  (state 'inside', hiddenUntil Infinity), one lantern watch stays out
  (`e.lantern`), dogs/chickens `e.sleeping` outside; elders walk at 0.55x so
  allow ~15-20s for the village to settle after forcing night. The N key
  (`gameManager.advanceDayNight()`) steps day -> sunset -> night -> dawn.
- Economy: shop is `.bshop-modal` (open via `.action-btn.build`); cards are
  `.bshop-card:has(.<id>-icon)`; place by selecting a card then clicking a
  tile (screen pos = ((gx-gy)*32, (gx+gy)*16) camera-transformed). The dev
  scripts enable server-authoritative infinite resources: the HUD shows
  `999,999` for gold, ore, and food, while player resource costs do not debit
  the saved finite balances. Chicken eggs: set a hen's `nextEggAt=1`, egg
  appears in `villageLife.eggs`, click it for +5 food. Rocks: place via
  `scene.placeObstacle(x,y,'rock_small',true,id)`, click it — a villager
  hauls it to the storehouse/town hall for ore. Miners/farmers finish shifts
  with `carryingPack` deliveries to storage. Roles reassign only on
  `villageLife.populate('PLAYER')`, so repopulate after placing a mine/farm.
- Server: mine/farm accrue ore/food (produces field in GameDefinitions);
  storage raises both caps (`world.storage {ore, food}`); ambient collection
  clamps at cap, while the dev infinite wallet leaves saved balances finite.
  Staffing: production scales by population/workersNeeded (2 per mine/farm);
  each population growth eats 10 food (stalls at 0). `world.population`
  carries {count, capacity, workersNeeded, staffing}.
- Keys: D = summon dragon shadow, P = FPS debug overlay, N = advance
  day/night, M = move the selected building.
- Dev upgrades: the server stamps `upgradeStartedAt` and `upgradeEndsAt`
  exactly 1,000 ms apart. Scaffold, progress, and builder presentation use
  that same interval; verify both a normal upgrade and an immediate second
  upgrade on the same building.
- Sound: `window.__clashSound` — `.state` ('running' after first gesture),
  `.muted`, `.lastPlayed` (e.g. 'voice:villager', 'coin'). HUD `.mute-btn`
  toggles + persists. Clicking creatures fires voices; sleeping ones answer
  soft. Music/ambience shift with nightFactor; birds don't spawn at night.
- Mushroom grass variants (ObstacleRenderer.grassLookOf(id): variant 3 or
  egg 0=golden) are foraged by VILLAGERS, not the mouse: a click assigns the
  chore (villageLife.assignForage), the villager walks over, kneels ~1.1s,
  patch is consumed, they carry a food pack (packAmount 6/50) to the
  storehouse/town hall and the grant lands at deposit. Villagers also
  self-assign via nextForageAt (force =1 to test). Allow ~30-45s end to end.
- Mine/farm `fillLevel` (0..1 over 90s from `lastHarvestAt`) drives crop
  height / ore pile size; worker deliveries reset it.
- Economy costs: shop cards gate + spend gold AND ore (`buildOreCostOf` = 10%
  of gold, walls exempt); upgrades spend `upgradeOreCostOf` (20%); troops
  train on food (`troopFoodCostOf` = space*2, refunded on untrain via
  `.remove-btn`). Starter stock is 25 ore / 50 food — most tests must earn
  first: `window.__clashGM.collectResource('ore', N)` uses the real
  egg/rock-haul pipeline (server clamps at storage cap).
- Jukebox: buildable (600 gold, maxCount 1); clicking it opens
  `.jukebox-modal` (7 tracks, 2 free, 2 rare '??????'). Picking a track sets
  `__clashSound.overrideActive`/`currentTrackId()`; the cabinet then floats
  ♪ notes. Track unlocks: harvest_home (food pack deposit), miners_vein
  (rock deposit), merchants_tune (first merchant trade), golden_cap (+50
  forage), dragons_shadow (dragon flyover). `soundSystem.unlockTrack(id)`
  returns true once; persisted in localStorage 'clash.tracks'.
- Children: server population growth arrives via
  `gameManager.syncPopulation(n)` (or `villageLife.syncPopulation(n)`) —
  new heads spawn as `e.child` at the hall door with a birth toast, play
  (dash at other villagers), and mature at `e.matureAt` — the flip happens
  at their NEXT decision point, so clear `path`/`state` when forcing it.
- Traveling merchant: spawns on `villageLife.nextMerchantAt` (force =1;
  day + HOME + no panic only). `villageLife.merchant` = {state:
  arriving|trading|leaving, offers, speed (bump to 0.01+ in tests),
  leaveAt}. He walks in from the map edge, pitches a striped stall on the
  camera-facing side of the hall (`merchantSpotNear`), and trades for ~115s.
  Clicking him (only while trading, within 2.2 tiles) plays the jingle and
  opens `.merchant-modal`: 3 `.merchant-offer` rows (gold↔ore/food, rare
  `*bargain` at ~half rate), TRADE gates on the give side, one deal each
  (SOLD after). First trade unlocks merchants_tune. Departure (leaveAt,
  night, or panic) packs the stall (`stallDrawn` false) and he walks off
  the map (`merchant` → null).
- World map: `scene.worldMap` — `views` (neighbor postcards, Map by "x,y"),
  `myPlot`, `handleTap(gx,gy)` (grid coords; plots at PLOT_PITCH=27).
  Clicking a neighbor opens the fixed-size DOM `.plot-panel`; actions are
  `.plot-action` buttons;
  attack with an empty army is gated in App (toast + barracks opens).
  `worldMap.prime(sceneTime)` force-loads postcards and is awaited inside
  reloadHomeBase so the cloud reveal never shows missing neighbors;
  `dayNight.resyncLights()` does the same for night light rigs (both are
  called automatically — sample `views.size`/`rigs.size` at the moment
  `.cloud-overlay` gains class `opening` to test).
- ART: read src/game/renderers/BUILDING_ART_GUIDE.md BEFORE touching building/prop art.
  Screenshot loop is mandatory: add the building to SHOWCASE in
  tools/art-preview/shoot-defenses.mjs, `npm run dev`, then
  `TAG=x node shoot-defenses.mjs` (PHASE=0.8 for night) and LOOK at the png.
- Village life (villagers/dogs/chickens/camp troops): reach it via
  `window.__clashGame.scene.getScene('MainScene').villageLife` — `entities`
  (kind/role/state/x/y), `campFigures`, `isPanicking()`. Screen position of an
  entity: `(e.gfx.x - cam.worldView.x) * cam.zoom`. Plant greenery/easter eggs
  with `scene.placeObstacle(x, y, 'grass_patch', true, id)` — the variant is
  FNV-1a(id) (see ObstacleRenderer.hashId; roll %500 < 4 = easter egg).
  Deploying any troop in a practice raid triggers the village panic.

## Gotchas

- Vite dev (`npm run dev`) mounts the same server as middleware on 5173 —
  fine for manual poking, but verification should use the built artifacts.
- The repo has ~65 pre-existing eslint errors (mostly `no-explicit-any`);
  compare against `git stash` baseline before attributing them to a change.
