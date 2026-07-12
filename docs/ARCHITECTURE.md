# Architecture

This is the current map of the game after the MMO/world, attack-domain, and
normalized PostgreSQL runtime migration.

## System shape

- React owns menus, HUD state, account flows, and creates the Phaser game.
- `src/game/scenes/MainScene.ts` orchestrates the interactive isometric scene.
  It owns Phaser objects and presentation state, not durable economy or combat
  outcomes.
- `src/game/GameManager.ts` is the React/Phaser bridge.
- `src/game/backend/GameBackend.ts` is the client API adapter. It serializes
  mutations, reconciles revisions, retries idempotent requests, and keeps a
  local cache for fast scene hydration.
- `server/http.ts` is the async same-origin JSON route table and
  `server/node-adapter.ts` binds any conforming service to Node HTTP (or the
  JSON compatibility service to Vite in development).
- `server/runtime/service.ts` coordinates normalized economy/world use cases;
  `server/runtime/auth-service.ts` owns credentials, sessions, registration,
  and guest-lease lifecycle; `server/runtime/village-authority.ts` centralizes
  stable player lock order, revision updates, lazy simulation, and production
  ledger auditing. `server/runtime/attack-service.ts` is the transactional
  combat adapter.
- `server/game.ts` is retained as the explicitly single-writer JSON
  compatibility/cutover adapter.
- `server/persistence/` contains the normalized transactional model,
  PostgreSQL repositories/migrations, bounded MMO query surfaces, and the
  frozen-JSON cutover tools.

## Authority boundaries

| State | Durable authority | Client responsibility |
| --- | --- | --- |
| Account, sessions, trophies, shields, plot claim | Server | Display and submit authenticated intent |
| Village layout | Server-stored, revision-fenced layout validated and priced from a client proposal | Edit the layout and send the complete proposed snapshot |
| Gold, ore, food, army, upgrades, population | Server | Predictive display only; adopt the returned revision/state |
| Public village appearance and resident census | Server snapshot (`appearanceRevision` plus `VillageLifeManifest`) | Cache/render the exact layout and deterministically derive ambient motion |
| Attack target, army reservation, commands, result, settlement | Server `AttackAggregate` and settlement adapter | Render combat and publish sequenced deploy/ability/surrender commands |
| Phaser objects, particles, camera, interpolation | Client | Full presentation authority; never trusted for rewards |

The client can choose where to move or what to deploy, but it cannot mint a
building level, troop, resource, target version, destruction percentage, loot,
or trophy result.

## Shared game catalog

`src/game/config/GameDefinitions.ts` is now a compatibility barrel. New code
should use the focused modules under `src/game/config/definitions/`:

- `BuildingTypes.ts` — building category/type unions and definition shapes.
- `buildings/DefenseBuildings.ts`, `MilitaryBuildings.ts`,
  `ResourceBuildings.ts`, and `UtilityBuildings.ts` — category catalogs.
- `BuildingDefinitions.ts` — explicit, stable composition of the full catalog
  plus level-stat lookup.
- `TroopDefinitions.ts` — troop catalog, canonical player troop order, unlock
  order, and level scaling.
- `CostDefinitions.ts`, `MapDefinitions.ts`, and `ObstacleDefinitions.ts` —
  their focused rules/data.

`src/game/config/Economy.ts` contains deterministic economy math shared by the
client and server. Shared definitions must remain free of Phaser/runtime-only
types because the server imports them for validation and simulation.

## Client runtime

### Main orchestration

`MainScene` still coordinates scene lifecycle, placement, combat presentation,
replays, and transitions, but reusable policy is moving into focused systems:

- `SceneInputController.ts` — pointer and keyboard input.
- `CombatNavigationSystem.ts` — legal combat goals, wall breaches, and
  collision-aware routing.
- `TargetingSystem.ts` — target preference helpers.
- `DefenseSystem.ts` — defense target locks, cooldowns, and shot scheduling.
- `DefenseBehaviorCatalog.ts` — exhaustive data-driven behavior for every
  active defense; walls are explicitly excluded.
- `WorldMapSystem.ts` — bounded neighborhood views, plot interactions, focus
  swaps, roads, wilderness, and caravans.
- `VillageLifeSystem.ts` — the interactive home/battlefield residents and
  animals.
- `NeighborLifeSim.ts` — exact public resident census for neighboring player
  villages, sampled from shared wall time.
- `DayNightSystem.ts`, `WeatherSystem.ts`, `DepthSystem.ts`, `LootSystem.ts`,
  and `ParticleManager.ts` — focused presentation concerns.

Projectile visuals and impact effects remain scene callbacks because they
create Phaser objects. Defense selection and cadence do not belong in the
scene switch anymore.

### Rendering

- `BuildingRenderer.ts` — hand-drawn vector buildings and the required
  `skipBase` / `onlyBase` split.
- `BuildingVisualCatalog.ts` and `BuildingVisualDispatcher.ts` — exhaustive
  shared routing from catalog type and level to exact live, preview, and
  neighboring-postcard art; those surfaces cannot drift into separate type
  switches.
- `TroopRenderer.ts`, `ObstacleRenderer.ts`, `RubbleRenderer.ts`, and
  `WreckRenderer.ts` — entity art.
- `GrassRenderer.ts`, `StonePathRenderer.ts`, `WildernessRenderer.ts`, and
  `WorldHydrologyRenderer.ts` — world surface art.

Read `BUILDING_ART_GUIDE.md` before visual changes and
`RENDERING_AND_DEPTH.md` for ground-bake/layering work.

## Server runtimes

`server/index.ts` selects authority explicitly:

- `DATABASE_URL` or `CLASH_STORAGE_MODE=postgres` applies migrations and starts
  `PostgresPersistence` with the normalized core and attack services. A
  requested database runtime fails closed; no JSON fallback is possible.
- `CLASH_STORAGE_MODE=legacy-json` (or an explicit `CLASH_DATA_DIR`) starts
  `GameService` for local compatibility and frozen cutover work. Vite uses this
  zero-setup path during development.

The JSON adapter loads one `JsonCollection` per record family and writes with
fsync plus atomic rename. A data-directory lease rejects a second writer. Its
in-memory indexes avoid request-time global scans:

- `PlayerDirectory` provides O(1) membership/removal and bounded matchmaking
  probes (2,048 players at most per request).
- `RequestReplayIndex` provides bounded/expiring O(1) attack-start retry lookup.
- Live attack indexes are keyed by attacker and defender.
- The legacy leaderboard caches a bounded top slice.
- World allocation uses a durable high-water ordinal plus indexed released
  slots instead of rescanning from the origin.

It is safe for local development, compatibility operation, and a frozen
cutover source. Production horizontal scale uses PostgreSQL revisions, unique
constraints, row locks, serializable retries, aggregate CAS, and `SKIP LOCKED`
maintenance claims.

### Focused server domains

- `server/domain/auth/` — credential format, token/session rotation, and
  deterministic abuse-limit decisions.
- `server/domain/village/` — untrusted layout normalization, invariant checks,
  diff pricing, upgrade clocks, and deterministic village advancement.
- `server/domain/world/` — coordinates/regions, generator pinning, plot
  classification, versioned claims/guest leases, local windows, and allocation.
- `server/attack-domain/` — one command/state-machine aggregate for PLAYER,
  BOT, and SCENARIO targets plus deterministic combat and settlement plans.
- `server/domain/player/` and `server/domain/idempotency/` — bounded indexes
  used by the JSON application adapter.

The domain modules are transport- and persistence-independent. Both runtime
adapters map typed failures to API errors; only the normalized adapter is the
production multi-process authority.

The normalized use-case layer is split separately from those pure domains:

- `server/runtime/auth-service.ts` handles password hashing/verification without
  blocking the event loop, opaque device sessions, bounded session history,
  registration, logout, and guest creation/reaping.
- `server/runtime/village-authority.ts` is the shared account → village → plot lock
  boundary. It owns revision fencing, materialization, production-ledger audit,
  and throttled presence writes so auth, economy, and world handlers cannot
  acquire player authority differently.
- `server/runtime/service.ts` composes those services for non-combat API use
  cases; `server/runtime/attack-service.ts` owns attack preparation through
  settlement.

## Village simulation at scale

There is no per-player background tick. `advanceVillage` advances from an
explicit `simulatedThrough` checkpoint only when a player record is touched.
It jumps between meaningful event boundaries (upgrade completion, production,
storage caps, staffing changes, population arrivals/departures), so advancing
once for a week produces the same result as many small advances.

This lazy deterministic model keeps offline players effectively free while the
server remains authoritative for:

- ore/food production and fractional remainders;
- storage caps and worker staffing;
- upgrade completion;
- population count, capacity, growth, departures, and birth timestamps.

Layout saves use an expected revision and idempotency key. The server first
normalizes and validates the full proposed layout, prices the diff, verifies
funds, and then applies it as one mutation. Army changes never ride inside a
layout save; training and battle settlement own them.

## Expandable shared world

World coordinates are bounded to +/-1,000,000 as an input-safety envelope, not
as a preallocated border. The world domain divides coordinates into versioned
32x32 regions. A region keeps the generation version it was created with, so a
future generator cannot reinterpret old land.

Player allocation is O(1)-amortized:

1. Try versioned released ordinals from the free-slot index.
2. Otherwise continue the world's monotonic high-water ordinal.
3. Claim the classified PLAYER coordinate and persist its `plotVersion` fence.

Vacating a plot increments its version before reuse. Guest plots are leases;
registration promotes a live guest claim without moving it. The normalized
store persists allocation, regions, claims, released slots, and lease times in
separate indexed tables. The JSON adapter persists the generation-1 allocation
cursor/released slots and player claim fields in compatibility records.

Only automatic admission locks the per-world high-water cursor. Releases and
explicit-coordinate moves use coordinate fencing independently; every claim
atomically consumes its same-coordinate released row. Expired-guest maintenance
locks account roots before plots, so it cannot invert the player mutation lock
chain. The remaining write-scaling boundary is the short automatic-admission
cursor critical section; replacing it safely requires durable, recoverable
ordinal block reservations rather than an in-process cache.

`GET /api/map` returns a watchtower-bounded window (maximum radius 2) containing
players, deterministic bot plots, wilderness/preserves, live-battle metadata,
and `serverNow`. A client may focus beyond normal sight only on the canonical
target of its active player or bot attack; that focused battlefield always gets
at least its immediate 3x3 world context so a new account never falls back to a
detached-looking island. `known` appearance revisions let unchanged player
layouts be omitted without an N+1 fetch.

### Accurate neighboring villages without full simulation cost

Player postcards are not low-resolution substitutes:

- The server returns the exact public buildings, obstacles, wall level, and
  appearance revision. Private balances, army, and storage are excluded.
- `WorldMapSystem` renders each player village once into a full-resolution
  1600x890 RenderTexture and reuses that texture as one quad until its
  appearance revision changes. Ring one is always resident; ring two is
  camera-prefetched at full resolution and evicted after a three-second grace
  while its authoritative source stays in memory. Only distant wilderness may
  use lower-resolution caches.
- Server-authored `stoneMaturity` gives every viewer the same paving age;
  grass, paths, and other deterministic decoration are rebuilt from stable
  village identity/layout.
- `VillageLifeManifest` carries stable identity, exact population (currently
  capped at 30), birth timestamps, and simulation checkpoint.
- `NeighborLifeSim` creates the exact resident count with the same vector
  villager renderer as the home village. Positions are a deterministic
  function of identity, layout, and server-corrected wall time; they are not
  networked or integrated every frame.
- Visibility and redraw frequency are LOD controls only. Skipping a draw does
  not delete residents, reduce their art quality, or change simulation state.
- Appearance revisions advance once per deterministic upgrade, birth, or
  departure, so a read-only offline projection cannot change resident state
  while accidentally reusing an older client cache key.

This is the mass-simulation split: the server owns compact semantic state, the
client derives repeatable presentation, and static geometry is cached.

## Unified attack path

Target discovery and combat are separate. Neighbor, direct, matchmade, and
revenge choices all become a PLAYER `WorldAttackTarget`; map and matchmade bot
choices become a BOT target. They then use the same `AttackAggregate` phases:

```text
PREPARING -> ENGAGED -> ACTIVE -> FINALIZING -> SETTLED
     |          |
     +-> CANCELLED <-+
     |          |
     +-> EXPIRED  <-+
```

The production flow is:

1. Start selects a canonical plot, snapshots its combat layout and public
   version, fixes reward caps, and reserves an immutable army snapshot.
2. Every start response returns the target plot. `MainScene` calls
   `WorldMapSystem.prepareFocus` and `arriveAndFight`; nearby armies visibly
   march, while direct/matchmade travel may be cloud-covered, but all arrive at
   the real map plot and use the same local battlefield swap.
3. The first `DEPLOY` command rechecks target identity, plot version, village
   appearance, shield, and the exclusive defender lease before engagement.
4. `/api/attacks/commands` accepts exactly one contiguous, idempotent command
   per request. PLAYER and BOT raids both use this endpoint.
5. Finalization replays the immutable snapshot, seed, rules version, and compact
   command events in the deterministic simulator. Client destruction/loot
   counters do not decide settlement.
6. The adapter clamps actual transfer to available defender stock and attacker
   capacity, consumes only deployed reserved troops, applies trophies/shields/
   revenge rights, and records an idempotent settlement receipt.

Frame uploads still exist for live visual spectating and replay interpolation.
For new attacks they are presentation data only. They have an atomic 2 MiB /
512-frame budget and are removed seven days after terminal settlement; start
snapshots, commands, compact authority, and settlements remain durable.
Converting frames into combat commands is disabled unless
`CLASH_ALLOW_LEGACY_FRAME_COMMANDS=1` is explicitly set for compatibility work.

Practice and replay viewing are presentation-only exceptions; they do not open
a second reward-bearing attack implementation.

Player-scoped attack metadata is bounded as well. A revenge right expires 48
hours after it is earned, is capped at three uses per opponent and the 32
latest-expiring opponents, and is checked again on first deploy. Completed bot
camp coordinates have a 30-minute cooldown; expired entries are discarded and
only the newest 128 are retained.

## Normalized persistence and cutover

`server/persistence/` provides:

- a unit-of-work/repository boundary with copy-on-write `MemoryPersistence`;
- PostgreSQL migrations and repositories for accounts/sessions, villages,
  resources, world regions/claims/allocation, attacks/commands/snapshots,
  settlements, replays, notifications, ledgers, idempotency, and outbox events;
- bounded indexed queries for leaderboard, matchmaking candidates, spatial
  atlas windows, active attacks, participant replay chunks, and notification
  pages;
- deterministic JSON materialization, validation, one-transaction import, and
  checksum/aggregate verification.

Production startup constructs these repositories directly. Existing JSON
worlds use the sealed materialize → validate → import → verify runbook in
`server/persistence/README.md`; the tools refuse live attacks, a live JSON
lease, source mutation, checksum drift, or partial import.

Auxiliary records have explicit finite storage contracts: notifications keep
the exact newest 50 per player; transport idempotency records expire after 24
hours; merchant operation markers are pruned after two days; published outbox
hints are retained for 24 hours and unpublished hints get a seven-day delivery
window. Maintenance claims bounded batches and PostgreSQL workers cooperate
with `SKIP LOCKED`. Replay presentation data follows the separate 2 MiB,
512-frame, seven-day limits above. Compact attack authority, settlements, and
gameplay ledgers are not removed by these retention passes.

### Deliberate operational boundaries

- Login/guest abuse throttles are process-local. A multi-process public
  deployment should enforce a shared gateway/Redis limiter; Redis must never
  become gameplay authority.
- The JSON `GameService` remains large because it is a compatibility boundary,
  not the place for new gameplay rules. New rules belong in focused domains
  and normalized use-case services.
- Presentation frames coexist with compact authoritative commands to support
  smooth live spectating. Their strict byte/time retention prevents them from
  becoming durable combat or unbounded storage authority.
- No external outbox publisher is bundled. Outbox rows are transactional
  integration hints, not gameplay authority; a deployment that needs an
  external event sink must provide a publisher and deliver within the
  documented seven-day window.
- The embedded PostgreSQL regression covers migrations, constraints, JSONB
  canonicalization, repository SQL, indexed plans, and normalized core/attack
  service flows. It does not exercise socket/network failure, connection-pool
  pressure, failover, or live contention across multiple hosts; those remain
  staging/operations validation requirements.

## Request flows

### Home mutation

```text
React/Phaser edit
  -> GameBackend serialized save queue
  -> POST /api/world/save (expected revision + request id)
  -> village normalize/validate/price
  -> lazy village advance + authority mutation
  -> authoritative world response
  -> client revision/cache reconciliation
```

### Attack command

```text
target selection
  -> immutable snapshot + army reservation
  -> focus canonical world plot
  -> first deploy revalidation/lease
  -> sequenced compact commands
  -> deterministic finalization
  -> idempotent settlement + notification/replay
```

## Game modes

- `HOME` — own village and world-neighborhood interaction.
- `ATTACK` — a focused local battlefield at the target's real world plot.
- `REPLAY` — presentation playback/spectating with no economy authority.

## Verification entry points

```sh
npm run test:server
npm run test:persistence
npm run test:runtime
npm run test:postgres
node scripts/run-attack-domain-regression.mjs
npm run test:defenses
npm run test:building-visuals
npm run test:client-attacks
npm run test:pathing
npm run test:world-postcards
npm run build
npx tsc --noEmit -p tsconfig.app.json
npx tsc --noEmit -p tsconfig.node.json
```

`test:runtime` drives the normalized service through the shared HTTP route
table over the hermetic repository implementation. `test:postgres` separately
drives migrations, PostgreSQL repositories, normalized core/attack services,
and an ephemeral real Node HTTP server against embedded PGlite. Together they
cover the normalized HTTP route and PostgreSQL service layers without claiming to simulate real
multi-host network/pool contention. Run `npm run verify` to execute the focused
suite above as one chain; production staging must still validate concurrent
hosts, pool sizing, latency, and failover against the deployed PostgreSQL
service.

Building art additionally requires screenshots through `tools/art-preview/`;
typechecking cannot verify visual quality or isometric layering.
