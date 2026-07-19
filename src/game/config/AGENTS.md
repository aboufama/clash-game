# src/game/config — the data layer (definitions, economy, world)

Everything a building / troop / defense **is** — its stats, cost, footprint,
level curve, behaviour flags — lives here as plain data. This directory is
imported by BOTH the Phaser client AND the Node server, so **keep it
Phaser-free** (no `import Phaser`, no `Graphics`, no DOM). The server's
`tsconfig.node.json` compiles `config/` + `data/Models`; a stray Phaser import
here breaks the server build.

## Where things live

```
config/
  GameDefinitions.ts        barrel re-export (the public import surface)
  Economy.ts                pricing, loot share, hashString/mulberry32, watchtowerSightOf
  WorldHydrology.ts         great-lake / river macro-cell seeding (see systems/AGENTS.md)
  definitions/
    BuildingTypes.ts        the type UNIONS + BuildingDef / BuildingLevelStats interfaces
    BuildingDefinitions.ts  composes the 4 category modules in shop order; getBuildingStats()
    buildings/
      DefenseBuildings.ts   cannon, ballista, xbow, mortar, tesla, prism, dragons_breath,
                            spike_launcher, wall              (category:'defense')
      MilitaryBuildings.ts  town_hall, the 2 faction barracks, army_camp, lab, …
      ResourceBuildings.ts  mine, farm, storehouse, …         (produces / storageCapacity)
      UtilityBuildings.ts   watchtower (pure sight — NOT a defense), decor, …
    TroopFactions.ts        the 2 faction ids, metadata, and faction→barracks mapping
    TroopDefinitions.ts     TroopDef + TROOP_DEFINITIONS + Core/2×7 trees + getTroopStats()
    CostDefinitions.ts / MapDefinitions.ts / ObstacleDefinitions.ts / index.ts
```

Import from the barrel: `import { BUILDING_DEFINITIONS, TROOP_DEFINITIONS, getBuildingStats, getTroopStats } from '../config/GameDefinitions'`.

## BuildingDef schema (`definitions/BuildingTypes.ts`)

One registry entry drives the shop card, placement price, HP, collision,
depth, server sanitize/validate, and the economy sim — **zero per-building
code** for all of that.

```ts
interface BuildingDef {
  id; name; desc;
  cost;                       // base gold; per-level cost lives in levels[]
  width; height;              // iso footprint in tiles
  maxHealth;
  category?: 'defense'|'resource'|'army'|'military'|'other';  // drives shop section + behaviour
  maxCount?;                  // shop cap AND server cap
  color?;                     // generic-draw + shop tint fallback
  maxLevel?; levels?: BuildingLevelStats[];   // levels[0] = L1
  // defense:   range, minRange, damage, fireRate
  // resource:  productionRate, produces:'ore'|'food'
  // storage:   storageCapacity
  // army:      capacity (housing)
}
interface BuildingLevelStats { hp; cost; damage?; fireRate?; range?; productionRate?; capacity?; storageCapacity? }
```

`getBuildingStats(type, level)` (`BuildingDefinitions.ts`) flattens base + `levels[level-1]`, cached by `type:level`; unknown types return a grey 1×1 fallback. **There is no `splash` / `projectile` / `targetPriority` field for defenses** — those are still hard-coded in per-defense code (see `docs/MODULARITY_ASSESSMENT.md`).

## TroopDef schema (`definitions/TroopDefinitions.ts`)

Troop *behaviour* is far more declarative than buildings — most of a troop is data:

```ts
interface TroopDef {
  id; name; desc; cost; space;               // space = housing cost
  health; range; damage; speed; color;
  targetPriority?: 'town_hall'|'defense'|'wall';
  wallDamageMultiplier?; movementType?: 'ground'|'air'|'ghost'; wallTraversalCost?;
  straightCharge?;                            // ray the objective, fight the first structure on the line
  splashRadius?; chainCount?; chainRange?;    // aoe / chain
  healRadius?; healAmount?; boostRadius?; boostAmount?;   // support
  attackDelay?; firstAttackDelay?;
}
```

- `CORE_TROOP_TYPES` is the ONE factionless Army Camp catalog: Barbarian
  (`warrior`), Archer, Healer (`physicianscart`), and Phalanx.
  `CORE_TROOP_UNLOCK_LEVELS` pins them to Army Camp L1-L4. Core still pays
  resources and housing; an absent or upgrading camp contributes no unlock.
- `TROOP_TECH_TREES` is the ONE faction membership, unlock-order, and
  display-order authority. It has two seven-unit paths, one unlock per
  matching barracks level; do not restate those lists in a consumer.
- `TRAINABLE_TROOP_TYPES` combines Core plus all faction nodes.
  `PLAYER_TROOP_TYPES` is the stable owned-army order. Neither is an
  independently restated progression list.
- `BARRACKS_TROOP_UNLOCK_ORDER` is a faction-tree compatibility flattening
  only. Never use its global index to infer an unlock level.
- `troopTrainingRequirement()` returns a Core Army Camp requirement or a
  faction Barracks requirement and returns `null` for generated-only
  `romanwarrior` / `skeleton` and unknown removed ids. New training is limited
  to `TRAINABLE_TROOP_TYPES`.
- `TroopFactions.ts` owns the barracks mapping. Mechanica intentionally maps
  to legacy id `barracks`; Mystic maps to `mystic_barracks`. Both buildings
  define the same complete L1-L9 structural curve. Their troop trees end at
  L7; L8-L9 are non-unlocking Mastery levels. Retaining the
  complete structural curve prevents purchased progress from being clamped
  away.
- Barracks upgrades unlock their own branch. The global `lab` continues to
  own the shared L1-L3 troop-stat multiplier for now; replacing that contract
  is a separate save/protocol/simulation migration.
- Each of the two faction barracks has one owner-directed canonical themed design for
  every L1-L9 level. This was an explicit single-design exception, not a
  Design Lab tournament; do not create `@A/B/C` slots for these designs.
- `getTroopStats(type, level)` scales by `TROOP_LEVEL_MULTIPLIERS = {1, 1.3, 1.65}`, cached.
- The **server** (`server/attack-domain/simulation.ts`) recomputes combat from these same numbers — a stat-only troop needs no server code, but changing authoritative damage math means bumping `simulationVersion`.

## Recipes

### Add a building (data half — pair with `src/game/renderers/AGENTS.md`)
1. `definitions/BuildingTypes.ts` — add the id to the right category union.
2. `definitions/buildings/<Category>Buildings.ts` — add the `BuildingDef` + `levels[]`.
3. `definitions/BuildingDefinitions.ts` — insert into the stable shop-order composition.
4. `src/icons/accurate-icons.css` — add `.<id>-icon::before`.
5. **Visual:** follow `src/game/renderers/AGENTS.md` (draw fn + catalog route + dispatcher entry — all compile-checked).
6. Producer/storage/army buildings usually need **zero** further code — `produces`/`productionRate`/`capacity` are read by the server sim and the client HUD.
7. Screenshot every level, day + night (`tools/art-preview/`) — mandatory (iron rule 1).

### Add a troop (data half)
1. `TroopDefinitions.ts` — add a normal faction unit once at the intended
   L1–L7 slot of one `TROOP_TECH_TREES` branch, then add its definition. Add
   only foundational starters to `CORE_TROOP_TYPES` and assign their Army
   Camp level in `CORE_TROOP_UNLOCK_LEVELS`. Normally retire owned IDs via
   `LEGACY_PLAYER_TROOP_TYPES`; when the owner explicitly requests a full
   purge, remove the definition and rely on sanitation. Do not hand-edit
   derived flattenings.
2. After baking, run `node tools/art-preview/gen-troop-sprite-icons.mjs` so
   the UI portrait comes from the troop's real sprite. Do not alias another
   unit's CSS glyph.
3. **Visual:** `TroopRenderer` draw fn — see `src/game/renderers/AGENTS.md`.
4. Behaviour expressible via `targetPriority`/`splashRadius`/`chainCount`/… needs no code. Anything novel touches `TargetingSystem` / `CombatNavigationSystem` and the server sim (bump `simulationVersion`).
5. `TrainingModal` groups directly from the faction trees — only add its
   `TROOP_FLAVOR` string.
6. New or redesigned art MUST go through `src/game/renderers/redesign/DESIGN_TOURNAMENTS.md`: ask
   the owner for the number of variants first, screenshot every candidate,
   promote only the selected winner, then bake and update exact sprite gates.

### Add a defense
A defense is a building with `category:'defense'` + combat stats, PLUS a
targeting/fire behaviour and a projectile/impact. See `src/game/systems/AGENTS.md`
("Add a defense") — it spans this dir, `renderers/`, and `systems/`.

## Compile-time safety net

`BUILDING_VISUAL_CATALOG` and `DEFENSE_BEHAVIOR_CATALOG` are declared
`satisfies Record<…Type, …>`. Add a new type to a union and **the build fails**
until you give it a visual route and (if a defense) a fire behaviour. Lean on
this: wire the data first, let `tsc` tell you what's missing.
