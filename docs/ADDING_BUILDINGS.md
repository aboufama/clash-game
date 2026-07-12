# Adding Buildings

End-to-end checklist for a new building type. Read
**[BUILDING_ART_GUIDE.md](./BUILDING_ART_GUIDE.md)** before drawing anything;
it defines the art direction, isometric math, base/elevated split, and required
screenshot loop.

## 1. Add the focused catalog entry

Do not add data to the compatibility barrel.

1. Add the ID to the appropriate union in
   `src/game/config/definitions/BuildingTypes.ts`.
2. Add the definition to exactly one category module:
   - `src/game/config/definitions/buildings/DefenseBuildings.ts`
   - `src/game/config/definitions/buildings/MilitaryBuildings.ts`
   - `src/game/config/definitions/buildings/ResourceBuildings.ts`
   - `src/game/config/definitions/buildings/UtilityBuildings.ts`
3. Add it to the explicit stable-order composition in
   `src/game/config/definitions/BuildingDefinitions.ts`.

`src/game/config/GameDefinitions.ts` only re-exports the focused catalog so old
imports remain compatible. Type completeness should fail if a category or the
full composition is missing the new type.

The shared definition is also server input. Footprint, level limits, shop
count, HP, costs, production, and capacity are used when the village domain
normalizes, validates, prices, and simulates saves.

## 2. Draw it once, wire the shared visual dispatcher

1. Add a `BuildingRenderer.drawX(...)` implementation in
   `src/game/renderers/BuildingRenderer.ts`.
2. Add an explicit route in `BuildingVisualCatalog.ts`.
3. Add its handler in `BuildingVisualDispatcher.ts`, preserving the renderer's
   exact argument order and dynamic state.

`MainScene` and `WorldMapSystem` both call this dispatcher, so level selection,
door/weapon state, and renderer choice cannot drift between the live village
and neighboring postcards. A generic route is allowed only when its catalog
entry includes an explicit reason. `npm run test:building-visuals` rejects
missing catalog entries and accidental generic fallbacks.

Both paths must honor `skipBase` and `onlyBase`. Ground paint is baked first;
raised art is depth-sorted separately. Ambient animation must be a
deterministic function of the supplied `time`, never per-frame randomness.

## 3. Wire gameplay only when the category needs it

### Active defense

Walls are non-firing defenses. For every other new `DefenseBuildingType`:

1. Add its scheduling/targeting policy to
   `src/game/systems/DefenseBehaviorCatalog.ts`.
2. Add its Phaser projectile/impact callback to the exhaustive `fire` map used
   to construct `DefenseSystem` in `MainScene.ts`.

`DefenseSystem` already owns range checks, min range, target locks, cooldowns,
and standard/charged scheduling. Put reusable policy there or in the behavior
catalog; keep only Phaser effects in the scene callback. The exhaustive record
is intended to make a missing defense behavior a compile error.

### Producer, storage, housing, or army building

- Generic production comes from `produces` and `productionRate` in the shared
  definition and is advanced by `server/domain/village/simulation.ts`.
- New storage/housing/army-capacity semantics may need an update to the shared
  helpers in `src/game/config/Economy.ts` or the village simulator. Do not add a
  second client-only/server-only formula.
- If the building changes bot composition, add deterministic placements to
  `src/game/backend/BotWorlds.ts`.

## 4. Presentation integration

- Add `<building-id>-icon::before` to `src/icons/accurate-icons.css`.
- If villagers enter it, make its renderer consume `building.doorOpen` in the
  same way as existing door-bearing buildings.
- If it visibly emits light, add an entry to `LIGHT_SOURCES` in
  `src/game/systems/DayNightSystem.ts`; use `minLevel` when appropriate.
- Confirm any special selection/info UI derives correctly from the catalog.

Depth sorting and standard placement collision derive from the shared
footprint. Old saves self-clean unknown building types on the server.

## 5. Verify (mandatory)

- Add the building to `SHOWCASE` in
  `tools/art-preview/shoot-defenses.mjs` and inspect every level at day
  (`PHASE=0.3`) and night (`PHASE=0.8`). Never ship art without inspecting
  screenshots.
- Buy, place, move, upgrade, and sell it. Check collision and all four
  wall/troop layering directions.
- Open the world map and inspect the same building in a neighboring postcard;
  verify it is the same art and resolution as the local version.
- For a defense, attack it and verify first-shot policy, range/min-range,
  retargeting, cooldown, projectile, and cleanup.
- Run client and server typechecks plus the relevant pathing/attack regressions.
