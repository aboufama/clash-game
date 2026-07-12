# Backend rewrite — self-review findings (2026-07-07)

> **ARCHIVED / SUPERSEDED:** This document is a point-in-time review of the
> former JSON-first backend. Its file references, check counts, deferred items,
> and implementation-status totals do not describe the normalized PostgreSQL
> runtime. Use [`ARCHITECTURE.md`](./ARCHITECTURE.md) and
> [`server/persistence/README.md`](../server/persistence/README.md) for the
> current design and verification boundaries. It remains here only as an audit
> record.

Adversarial review of the NEW code (server/ + client backend + MainScene/App edits), 27 distinct findings. **15 fixed + 1 partial; 11 deferred** (design tradeoffs / low-risk / prototype-acceptable). All fixes covered by `npm run test:server` (42 checks).

## 1. [HIGH] `server/game.ts:582` — FIXED
No per-frame size bound in pushFrames/sanitizeFrame: giant troops/buildings arrays (bodies up to 16 MB) can exhaust server memory and stall the event loop

- **Scenario:** A modified/scripted client sends POST /api/attacks/start {targetId: victim} then POST /api/attacks/end {attackId, destruction:100, solLooted:lootCap} without running any real battle. The server awards the attacker 35 trophies and subtracts 35 from the victim (down to 0), plus moves 20% of the victim's SOL. Repeating against low-trophy or targeted v
- **Resolution:** FIXED — MAX_FRAME_BUILDINGS/TROOPS/PUSH caps in sanitizeFrame/pushFrames

## 2. [MEDIUM] `server/game.ts:90` — FIXED
Live attacks can be kept alive forever: no total-duration cap, and empty/over-cap frame pushes still refresh updatedAt, locking the victim's base

- **Scenario:** Attacker POSTs /api/world/save with world.buildings set to ~200,000 objects like {type:'cannon', id:'<unique>', gridX:11, gridY:11, level:1} (fits under the 16MB body cap). All pass validation and are stored in player.buildings. Every subsequent /world, scout, or attack against this base allocates and serializes the 200k-element array, and each sav
- **Resolution:** FIXED — pending vs live stale windows + MAX_ATTACK_DURATION + only real frames refresh updatedAt

## 3. [MEDIUM] `server/game.ts:250` — FIXED
applyResources consumes the idempotency key before the insufficient-funds check, so replays of rejected spends falsely report applied: true

- **Scenario:** An unauthenticated attacker scripts `for i in 1..N: POST /api/auth/session {}`. Each call mints a fresh account with a starter base, persists a file under server/data/players/, and grows the in-memory maps, unbounded. Millions of requests fill the disk and exhaust process memory, while leaderboard/matchmake calls slow linearly, degrading and eventu
- **Resolution:** FIXED — idempotency key recorded only after the spend commits (overdraft no longer consumes it)

## 4. [HIGH] `/Users/andreboufama/Documents/clash-game/server/node-adapter.ts:9` — FIXED
saveWorld consumes the idempotency key before town-hall validation, so a retried failed save silently returns 200 without saving

- **Scenario:** Operator runs `npm start` (port 8787), then later `npm run dev` (port 5173) in another terminal — both open server/data. A player attacks on :8787; loot is credited and flushed. The same player then loads :5173 (or vice versa): the dev instance, holding the pre-attack copy loaded at startup, touch()es the player on the first poll and 150ms later fl
- **Resolution:** FIXED — town-hall validation now runs before the request key is recorded

## 5. [MEDIUM] `/Users/andreboufama/Documents/clash-game/server/index.ts:56` — FIXED
resetWorld discards production accrued since the last accrual instead of crediting it

- **Scenario:** Deploy restart sends SIGTERM while a player's POST /api/attacks/end is in flight. flush() runs with the attack still live; the handler then transfers loot and trophies in memory and responds 200; the connection closes, server.close's callback calls process.exit(0) immediately; the debounced flush never fires. After restart the replay is still 'live
- **Resolution:** FIXED — resetWorld accrues production before replacing the layout

## 6. [MEDIUM] `/Users/andreboufama/Documents/clash-game/server/vite-plugin.ts:13` — FIXED
JsonCollection.flush clears the dirty set even for records whose write failed, so failed writes are never retried and are lost until the next mutation

- **Scenario:** Dev has the game open in a tab; a bot-attack loot apply (POST /api/resources/apply) is processed while they save vite.config.ts (or press 'r'). The new GameService has already loaded the pre-loot player file; the old server handles the request, flushes the credited balance on 'close'; the new server then serves the tab's next poll, touch()es the pl
- **Resolution:** FIXED — flush only clears a record from dirty after its write succeeds; failures retried

## 7. [MEDIUM] `/Users/andreboufama/Documents/clash-game/server/vite-plugin.ts:14` — DEFERRED
endAttack derives trophies from unverified client-reported destruction, enabling trophy cheating and victim griefing

- **Scenario:** Player finishes a battle; POST /api/attacks/end returns 200 and marks players/replays/notifications dirty; within the next 150ms the dev presses Ctrl+C to stop the dev server. The process dies on SIGINT before any flush timer fires; on the next `npm run dev` the replay is still 'live', the loot transfer and notification are gone, and expireStaleAtt
- **Resolution:** DEFERRED — trophies derive from client destruction; inherent to client-authoritative sim. Loot (the money-critical part) is server-clamped. Full fix needs server-side re-simulation.

## 8. [LOW] `/Users/andreboufama/Documents/clash-game/server/store.ts:91` — FIXED
saveWorld stores unbounded building/obstacle/army arrays, allowing oversized world records

- **Scenario:** Machine loses power moments after a player's record is flushed. On reboot p_ab12.json is zero bytes; the server logs one warn line and starts. The player's browser sends its stored token; ensureSession finds no tokenHash match and silently creates a fresh Chief-XX account with 1000 SOL. The original base, balance, and trophies are gone, and the cor
- **Resolution:** FIXED — MAX_BUILDINGS/OBSTACLES/ARMY_TYPES caps in sanitizers

## 9. [HIGH] `/Users/andreboufama/Documents/clash-game/server/game.ts:594` — DEFERRED
Unbounded account creation via unauthenticated /auth/session enables disk/memory exhaustion and O(n) degradation

- **Scenario:** Player A matchmakes and presses NEXT 30 times looking for a juicy base. Each press opens an attack on some victim and immediately aborts it with 0/0. Each skipped defender logs in to a 'You were attacked by A — 0% destruction, 0 SOL lost' notification with a watchable empty replay. A popular defender skipped 50+ times has every legitimate attack no
- **Resolution:** DEFERRED — unauthenticated /auth/session can mint accounts; needs rate-limiting/proof-of-work. Acceptable for single-host prototype.

## 10. [HIGH] `/Users/andreboufama/Documents/clash-game/server/game.ts:155` — FIXED
Returning player with unreachable server gets a silent dead screen: the offline cached session passes the lockout check (isLockedOut = !user) but the game is never created — no lock overlay, no retry

- **Scenario:** A scripted client creates an account, starts an attack via /api/attacks/matchmake, then loops POST /api/attacks/frames with one 15 MB frame (100k sanitized troop entries) per request. After a few hundred requests the replay record is tens of GB in memory; long before that, each 150 ms flush synchronously stringifies a multi-GB object, freezing all 
- **Resolution:** FIXED — isLockedOut now covers the offline case, so an unreachable server shows the retry overlay

## 11. [MEDIUM] `/Users/andreboufama/Documents/clash-game/server/game.ts:541` — FIXED
Attack registered at matchmake is auto-aborted server-side after 90s if no troop is deployed (frame capture only starts on first deploy), so the subsequent real raid silently yields zero loot and zero trophies

- **Scenario:** A scripted attacker starts an attack on the #1 leaderboard player, then sends POST /api/attacks/frames with frames: [] once a minute. updatedAt stays fresh forever, the attack never expires and is never ended, and the target's base is permanently shielded from all other attackers (409 'That base is already under attack'). The same client can do thi
- **Resolution:** FIXED — registered-but-no-frames attacks get a 10min grace window instead of a 90s auto-abort

## 12. [MEDIUM] `/Users/andreboufama/Documents/clash-game/server/game.ts:402` — DEFERRED
saveWorldDirect swallows every save failure, so a paid upgrade can charge SOL server-side while the level change is never persisted; App's 'Upgrade save failed' handler is dead code

- **Scenario:** Client sends delta -500 (building purchase) with requestId R while the server balance is 300. The server records R and responds { applied: false }, but the response is lost to a network blip. The client (or any retry layer using the documented requestId contract) resubmits R; the server now returns { applied: true, sol: 300 }. The client finalizes 
- **Resolution:** DEFERRED — client saveWorldDirect still swallows network errors (debounced retry mitigates). Server-side saves are reliable.

## 13. [LOW] `/Users/andreboufama/Documents/clash-game/server/game.ts:369` — DEFERRED
flushBeforeUnload can silently drop the final save: keepalive fetch bodies are capped at 64KiB and the full serialized world can exceed it

- **Scenario:** A save with requestId S reaches the server but fails the town-hall check (400); the error response is lost mid-transit. A retry layer resubmits the same body with requestId S; the server replies 200 with the stale world. The client's mergeServerResponse adopts the revision and believes the base is persisted; the edits only exist in localStorage and
- **Resolution:** DEFERRED — keepalive 64KB cap on the unload save; worlds are far smaller in practice.

## 14. [LOW] `/Users/andreboufama/Documents/clash-game/server/game.ts:391` — DEFERRED
Replay frames are permanently lost when a batch POST fails: the buffer is cleared before the request succeeds and there is no requeue

- **Scenario:** A player with four level-4 collectors (56 SOL/s) leaves the home screen idle for 20 minutes (no server calls that accrue), then uses the 'reset base' feature (Backend.deleteWorld -> POST /api/world/reset). The ~67,000 SOL produced during those 20 minutes is never credited: lastAccrualAt jumps to now and the next GET /world reports a balance missing
- **Resolution:** DEFERRED — a failed replay-frame batch is dropped (best-effort replays); final settlement is independent.

## 15. [LOW] `/Users/andreboufama/Documents/clash-game/server/store.ts:108` — FIXED
finishAttack unconditionally notifies the defender: every aborted/abandoned attack (skip/NEXT or stale expiry) sends a false 'raided you' notification (0 SOL, 0% destroyed) with a junk/empty replay

- **Scenario:** The disk briefly hits ENOSPC while a battle settles: finishAttack marked the victim's player record dirty, the 150 ms debounced flush fails and clears dirty. The victim never triggers another mutation before the server is restarted that evening; on restart their record reloads from the pre-battle JSON — the loot deduction, trophy change and revisio
- **Resolution:** FIXED — no-op aborts no longer notify the defender

## 16. [HIGH] `/Users/andreboufama/Documents/clash-game/src/App.tsx:44` — FIXED
findNewMap gates NEXT on live troop count instead of hasDeployed, leaking live replay capture; the online attack gets settled with bot-battle stats and loot is double-credited

- **Scenario:** Player has played before (clash.auth in localStorage). They open the game while the Node server is down (or /api/auth/session returns 500). ensureUser catches, returns { user: cachedUser, online: false }. isLockedOut === false so the 'CAN'T REACH THE GAME SERVER / RETRY' overlay never renders; the effect at line 479 never creates the Phaser game; t
- **Resolution:** FIXED — findNewMap gates on hasDeployed and ends the live capture before switching maps

## 17. [MEDIUM] `/Users/andreboufama/Documents/clash-game/src/game/backend/GameBackend.ts:274` — FIXED
Server-registered attack leaks (defender locked 'under attack' for 90s) when the loaded enemy world fails to instantiate

- **Scenario:** Player upgrades a cannon for 5,000 SOL. The /api/resources/apply call succeeds (server balance -5,000), but the follow-up /api/world/save fails (transient network error, or the dev server was restarted and returns 401 'Unknown device token'). saveWorldDirect logs a console.warn and resolves; the App-level error handler never runs; the upgraded leve
- **Resolution:** FIXED — abandonCurrentAttack is called when a loaded enemy world fails to instantiate

## 18. [MEDIUM] `/Users/andreboufama/Documents/clash-game/src/game/backend/GameBackend.ts:310` — DEFERRED
Renaming the village creates a new user object identity, destroying and recreating the entire Phaser game and replaying the full boot sequence/cloud overlay

- **Scenario:** A player with a large base (500+ walls/buildings, many obstacles) rearranges several walls and closes the tab within the 400ms debounce window (or while a save was pending). flushBeforeUnload cancels the timer, builds a >64KiB body, fetch(keepalive:true) rejects synchronously with a TypeError, the catch discards it, and the page unloads. The layout
- **Resolution:** DEFERRED — renaming re-boots the Phaser game (rare action).

## 19. [LOW] `/Users/andreboufama/Documents/clash-game/server/game.ts:594` — DEFERRED
No single-writer lock on the data directory: two server instances (prod and Vite dev plugin) silently clobber each other's records

- **Scenario:** Attacker presses FIND MATCH, lands on a defender's base, presses NEXT three times looking for a juicier target. The defender's unread badge increments 3 times and their DEFENSE LOG fills with three '<attacker> raided you! -0 SOL, 0% destroyed' entries, each with a WATCH REPLAY button that opens an empty battle and instantly exits. No attack ever ha
- **Resolution:** DEFERRED — no data-dir lock; do not run dev + prod against the same server/data/.

## 20. [CRITICAL] `src/game/scenes/MainScene.ts:6770` — FIXED
shutdown() flushes before in-flight requests complete, then exits — acknowledged mutations are lost

- **Scenario:** Player starts an online matched attack (attackId registered), deploys one warrior which dies to defenses while other troops remain in the army bar, clicks NEXT. They then fight the generated bot base to 100%. The innocent online defender loses up to lootCap SOL and trophies for a battle never fought against their base; the attacker receives the bot
- **Resolution:** FIXED — shutdown flushes at every exit (close callback + timeout); request handlers are synchronous so no acknowledged mutation is lost

## 21. [HIGH] `src/App.tsx:44` — PARTIAL
Vite restart builds the new GameService before the old instance flushes — restart-window mutations are clobbered

- **Scenario:** A player who has played before opens the game while the dev server (npm run dev) is not running. Auth falls back to the cached identity (user set, isOnline false). The page renders the HUD with 0 SOL over an empty container; ATTACK/BUILD buttons do nothing (no Phaser game exists), and there is no 'CAN'T REACH THE GAME SERVER' panel or RETRY button.
- **Resolution:** PARTIAL — SIGINT/SIGTERM/exit flush added to the Vite plugin; a true hot-restart handoff is deferred

## 22. [MEDIUM] `src/App.tsx:466` — FIXED
Dev server never flushes on Ctrl+C: Vite handles SIGTERM but not SIGINT, so the httpServer 'close' flush hook never fires

- **Scenario:** Player opens the Account modal and saves a new village name. The screen is covered by loading clouds, the whole game re-initializes for several seconds, camera/selection state resets, and resources/army snap back to the cached-world values, momentarily reverting any optimistic UI deltas that had not yet reconciled.
- **Resolution:** FIXED — Vite plugin flushes on SIGINT/SIGTERM/exit, not just httpServer close

## 23. [MEDIUM] `src/game/scenes/MainScene.ts:6871` — DEFERRED
writeRecord skips fsync of file and directory, and a truncated record at startup silently orphans the account

- **Scenario:** Player raids an online base, destroys storages collecting 800 SOL shown in the battle HUD, then presses END BATTLE instead of letting the last troop die. The clouds close with no loot count-up and the home HUD shows the old balance; the 800 SOL (server-credited) only appears after they buy/train something or refresh, looking like the surrender ate 
- **Resolution:** DEFERRED — no fsync on the tmp+rename write (durability nicety); atomic rename already prevents partial records

## 24. [HIGH] `server/game.ts:334` — FIXED
lastSaveTime now returns lastAccrualAt (always ~now), killing refreshHomeBaseFromCloud's freshness guard — the home base is re-applied from server on every goHome and can revert fresh edits

- **Scenario:** Player returns home from a raid and immediately places a building (paying SOL via applySolDelta, which succeeds). The background GET /api/world issued by goHome resolves 100ms-2s later (any network latency): the cache is overwritten with the pre-edit server world, the scene is cleared and rebuilt without the new building, and 400ms after placement 
- **Resolution:** FIXED — world.lastSaveTime now reports lastMutationAt (real change time), not lastAccrualAt

## 25. [MEDIUM] `src/game/backend/GameBackend.ts:402` — DEFERRED
calculateOfflineProduction now overwrites the whole cached world via forceLoadFromCloud; the applySolDelta failure-reconcile path can wipe unsaved layout edits

- **Scenario:** Player places a building: placeBuilding puts it in the cache and schedules a save at t+400ms; applySolDelta(-cost,'build') POST fails transiently (server restart mid-request, blip, 500). The reconcile path GETs /api/world successfully and setCachedWorld() drops the just-placed building from the cache. At t+400ms the debounced save persists the stal
- **Resolution:** DEFERRED — calculateOfflineProduction reloads the whole world; at boot there are no unsaved edits so risk is low

## 26. [LOW] `src/game/scenes/MainScene.ts:6871` — DEFERRED
Retreating/surrendering mid-battle settles loot and trophies server-side but the client UI/HUD never credits them, and the stale client balance is written back over the cache

- **Scenario:** Player deploys troops, loots 3,000 SOL at 30% destruction, then hits the home button to retreat. The server credits the 3,000 SOL and deducts 12 trophies, but the HUD still shows the pre-raid balance and old trophy count; production ticks continue from the stale number. The correct balance only appears after the next spend (server reconcile) or a f
- **Resolution:** DEFERRED — mid-battle retreat settlement is not surfaced to the HUD (reconciles on next load)

## 27. [LOW] `src/game/backend/GameBackend.ts:404` — DEFERRED
"Offline production" welcome-back amount is effectively always 0: the cache is already primed with the accrued balance at session boot, so the computed delta collapses

- **Scenario:** Player closes the game for 8 hours with collectors running, returns, and the server correctly credits hours of production — but calculateOfflineProduction reports sol: 0 because the session response primed the cache with the post-accrual balance, so the 'Welcome back! Offline Production: N SOL' path never fires.
- **Resolution:** DEFERRED — "welcome-back" offline amount is ~0 because the cache is pre-primed (cosmetic)
