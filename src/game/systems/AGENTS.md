# src/game/systems — the simulation layer

The systems here run the game: combat, pathfinding, the shared world map,
world generation, day/night, weather, sound, village life. Unlike the
renderers, most of this is **data-driven and clean** — it reads the registry
numbers from `config/` and the grid positions, never pixels. That separation
(simulation ⟂ art) is what makes the sprite-asset rework tractable: none of
this changes when the art changes.

## Combat: two independent target/attack loops

There are **two** combat directions, in different files — don't conflate them:

- **Defenses → troops:** `DefenseSystem.ts` (`update`). Per defense: skip if
  dead/upgrading/no-behaviour; range + `minRange` gate; `findNearestTarget` or a
  locked target; cooldown = `fireRate`; then `effects.fire[fireEffect](defense, target, time)`.
  Charged defenses (tesla) have a windup path. Wired in the MainScene ctor.
  - **`DefenseBehaviorCatalog.ts`** — `DEFENSE_BEHAVIOR_CATALOG: Record<ActiveDefenseType, {fireEffect, targeting:'locked'|'nearest', start, scheduler:'standard'|'charged', idleEffect?}>`,
    `satisfies Record<…>` (a new defense won't compile without a behaviour).
    This is the **seam**: the loop calls `effects.fire[type](defense, target, time)`
    with zero visual knowledge.
  - The actual `fire` implementations are bespoke `shoot*At` methods **in
    MainScene** (~8 of them, 90–310 lines: `shootAt` cannon, `shootBallistaAt`,
    `shootMortarAt`+`createMortarExplosion`, `shootTeslaAt`, `shootPrismContinuousLaser`,
    `shootDragonsBreathAt`, `shootSpikeLauncherAt`). They
    spawn projectiles, apply splash, screenshake, and impact particles. Splash
    radius / projectile art / arc are hard-coded here, NOT in the registry.
- **Troops → buildings:** `TargetingSystem.ts` (`findTarget`) picks a target from
  the troop's declarative `targetPriority`; `CombatNavigationSystem.ts` (pure, no
  Phaser) does A* + wall-breach costing + sub-stepped collision, emitting
  waypoints. `MainScene.updateTroops` integrates movement each frame; a separate
  MainScene block applies the client-predicted attack tick + per-troop FX.
  The **server** (`server/attack-domain/simulation.ts`) is authoritative and
  recomputes deterministically.

`PathfindingSystem.ts` is for **ambient villagers only**, not combat.

### Add a defense (full, spans 3 dirs)
1. `config/definitions/BuildingTypes.ts` — add to `DefenseBuildingType`.
2. `config/definitions/buildings/DefenseBuildings.ts` — registry (range/damage/fireRate/levels).
3. `systems/DefenseBehaviorCatalog.ts` — add the behaviour (compile-guarded).
4. `renderers/BuildingVisualCatalog.ts` + `BuildingVisualDispatcher.ts` — visual route (compile-guarded).
5. `renderers/BuildingRenderer.ts` — `drawXxx` turret art (respect base/elevated split).
6. `MainScene.ts` — wire the handler in the ctor + write `shootXxxAt` (projectile + impact).
7. `types/GameTypes.ts` — add any bespoke aim/recoil state to `PlacedBuilding`.
Steps 3–4 are typed-guarded; 5–6 are the real cost. See `docs/MODULARITY_ASSESSMENT.md`.

## The shared world map & world generation

`WorldMapSystem.ts` renders the neighbourhood around your plot. The whole game
tiles onto one grid: `PLOT_TILES=25`, `PLOT_GAP=2`, `PLOT_PITCH=27`. Scene-grid
→ plot: `px = floor(gx/27)`, `localX = gx − px*27` (`localX ≥ 25` = a road gap).
Iso: `cartToIso(x,y) = ((x−y)*32, (x+y)*16)` (64×32 tiles).

- Each neighbour is a `NeighborView` holding **one frozen `RenderTexture`
  postcard**, rendered once. Your village is the only live one.
- **LOD by ring:** ring ≥3 → 0.25×, ring 2 → 0.35×, ring 1 → 1×, NEAREST filter.
  Residency (`WorldPostcardResidency.ts`): ring-1 always resident, ring-2
  prefetched + evicted after a grace period.
- Player/bot plots → `renderSnapshot` (bakes lawn + buildings via the SHARED
  `BuildingVisualDispatcher`). Bots come from `backend/BotWorlds.ts`
  (`generateBotWorldFromSeed`, `BOT_WORLD_GENERATION_VERSION`).
- Empty plots → `renderNaturePostcard` → `WildernessRenderer.drawWildPlot` or
  `WorldHydrologyRenderer.drawFeatures`.
- Fog of war past `watchtowerSightOf` radius (drawn cumulus, see the weather/
  world-map notes).

### Determinism (the golden rule of world-gen)
Every client must see the same world, so world content is a **pure function of
absolute plot coordinates**: seed only via `hashString` (FNV-1a) / `mulberry32`
(`config/Economy.ts`) + the `WorldNatureSeed` mixers. **Never `Math.random()`**
in world-gen. `natureAt(plotX, plotY)` samples 3 fbm fields
(elevation/moisture/canopy) → one of 11 archetypes (the plot-local river archetype was removed 2026-07-19 — rivers come only from the seam-free hydrology layer).

### Add a wilderness archetype
1. `renderers/WildernessRenderer.ts` — append to `ARCHETYPES` with a `place`
   fn; add its `ARCHETYPE_LABELS` entry; add the selection branch in `natureAt`.
2. Bump `WildernessRenderer.RENDER_VERSION` (invalidates cached postcard RTs).

### Add / edit a hydrology feature
1. `config/WorldHydrology.ts` — great lakes are owned by 12×12-plot macro-cells
   (`greatLakeForMacroCell`, `macroSeed`, ~15.5% wet + guaranteed showcase/vista
   plots). Extend the builder here; protection flows automatically through
   `classifyHydrologyPlot`.
2. `renderers/WorldHydrologyRenderer.ts` — draw it in `drawFeatures`; bump
   `WorldHydrologyRenderer.RENDER_VERSION`.
   (Note: `presentationSeedVersion` is threaded through the renderer but the
   config side is intentionally epoch-immutable — lake geometry is a permanent
   world fact.)

## Ambient world systems
`DayNightSystem` (global sun on the shared clock; transient lights rig),
`WeatherSystem` (globally-synced rain as a pure function of the world clock;
surface-aware splashes; drives wind/sound/village shelter), `VillageLifeSystem`
+ `VillageBubbles` (villagers/animals/events), `SoundSystem`, `LootSystem`,
`DepthSystem` (`depthForBuilding/Troop/Obstacle` — the iso painter order).
