# MainScene organization and extension guide

`MainScene.ts` is the Phaser application orchestrator. It owns live scene
objects, transitions, camera/input integration, and combat presentation. It is
not the source of truth for durable layout pricing, economy, population,
target versions, attack results, or settlement.

## What stays in MainScene

- Phaser lifecycle (`create`, `update`, shutdown) and scene-owned object state.
- Applying serialized home/enemy worlds to Phaser objects.
- Ground baking and the live entry point into `BuildingVisualDispatcher`.
- Coordinating placement UI with `GameBackend` mutations.
- Local combat animation, troop special effects, projectiles, particles, and
  health bars.
- World-map focus/caravan/cloud transitions and one-frame home/battlefield
  swaps.
- Capturing presentation frames and playing live/finished replays.
- Wiring focused systems to scene callbacks.

## Focused collaborators

- `controllers/SceneInputController.ts` — pointer/keyboard interpretation.
- `systems/DefenseSystem.ts` — defense targeting, locks, cooldowns, and shot
  scheduling.
- `systems/DefenseBehaviorCatalog.ts` — exhaustive active-defense policies.
- `systems/CombatNavigationSystem.ts` — combat objectives, breach plans,
  legal attack positions, and collision-aware movement.
- `systems/TargetingSystem.ts` — target-priority helpers.
- `systems/WorldMapSystem.ts` — neighborhood plots, cached postcards, world
  roads/wilderness, focus state, and caravans.
- `systems/VillageLifeSystem.ts` and `NeighborLifeSim.ts` — local residents and
  authoritative neighboring resident presentation.
- `systems/DayNightSystem.ts`, `WeatherSystem.ts`, `DepthSystem.ts`,
  `LootSystem.ts`, and `ParticleManager.ts` — focused presentation concerns.
- `renderers/BuildingRenderer.ts` and `TroopRenderer.ts` — vector art.
- `renderers/BuildingVisualCatalog.ts` and `BuildingVisualDispatcher.ts` —
  exhaustive shared building-art routing for live and postcard contexts.
- `backend/GameBackend.ts` — serialized HTTP mutations, retries, revisions,
  caches, and attack-command publication.

If a rule can be expressed without Phaser, it probably belongs in a focused
system, the shared definition/economy catalog, or a server domain instead of
another `MainScene` branch.

## Major flows

### Home hydration and edits

`loadSavedBase`/`reloadHomeBase` hydrate from the primed client cache and then
refresh server authority. `applyWorldToScene` and `instantiateBuilding` create
the local Phaser representation. Placement/move/upgrade actions update the
client proposal through `GameBackend`; the server returns the authoritative
revision and balances.

### Building rendering

`drawBuildingVisuals` supplies live time, sound, door/weapon state, and wall
topology to `BuildingVisualDispatcher`. `WorldMapSystem.drawWorldStatic`
supplies pinned postcard time and its own wall topology to that same routing
table. The dispatcher preserves the `skipBase`/`onlyBase` ground-bake contract.

### Combat

`spawnTroop` creates the local presentation and publishes a compact deploy
command for first-generation player troops. `updateCombat` delegates defense
scheduling to `DefenseSystem`, then drives troop movement/special effects using
`CombatNavigationSystem` and `TargetingSystem`. Projectile callbacks stay here
because they create Phaser objects; reusable targeting/cadence policy does not.

The server re-simulates the compact command log for the result. Scene damage,
loot counters, and uploaded frames are presentation data.

### World attack transitions

All reward-bearing player and bot attacks receive a canonical plot. The scene
calls `WorldMapSystem.prepareFocus`, prepares the destination lawn, and enters
through `arriveAndFight`. Nearby attacks show the road march; direct/matchmade
attacks may hide travel with clouds, but they use the same local target-plot
swap. `goHome` reverses the focus swap.

### Replay

Capture frames are bounded and uploaded for spectator interpolation. Replay
viewing uses `REPLAY` mode and never applies economy mutations. Compact attack
commands and the server simulator remain outcome authority.

## Extension routes

- Buildings: follow `docs/ADDING_BUILDINGS.md`. Definitions now live under
  `config/definitions/`; active defense policy belongs in
  `DefenseBehaviorCatalog`, not a new manual-fire loop.
- Troops: follow `docs/ADDING_TROOPS.md` and read
  `docs/COMBAT_NAVIGATION.md` before changing movement or breaches.
- Art: read `docs/BUILDING_ART_GUIDE.md` and verify with screenshots.
- Layering: read `docs/RENDERING_AND_DEPTH.md`; do not bypass the ground-bake
  split or depth helpers.

## Remaining modularization seams

- `MainScene` still holds many troop-specific Phaser effects. Extract a system
  when behavior is shared/testable, but keep scene-object creation behind
  callbacks.

Do not add a second durable attack/economy path to solve a presentation need.
Extend the existing backend command/domain boundary and keep the scene as its
renderer/controller.
