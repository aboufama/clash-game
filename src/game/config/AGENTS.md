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
                            spike_launcher, frostfall, wall   (category:'defense')
      MilitaryBuildings.ts  town_hall, barracks, army_camp, lab, …
      ResourceBuildings.ts  mine, farm, storehouse, …         (produces / storageCapacity)
      UtilityBuildings.ts   watchtower (pure sight — NOT a defense), decor, …
    TroopDefinitions.ts     TroopDef + TROOP_DEFINITIONS + unlock order + getTroopStats()
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

- `PLAYER_TROOP_TYPES` (tuple) derives the type union AND the battle-bar order.
- `BARRACKS_TROOP_UNLOCK_ORDER` = unlock-by-lab-level.
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
1. `TroopDefinitions.ts` — add to `PLAYER_TROOP_TYPES`, add the `TROOP_DEFINITIONS` entry, place it in `BARRACKS_TROOP_UNLOCK_ORDER`.
2. `src/icons/accurate-icons.css` — add the icon.
3. **Visual:** `TroopRenderer` draw fn — see `src/game/renderers/AGENTS.md`.
4. Behaviour expressible via `targetPriority`/`splashRadius`/`chainCount`/… needs no code. Anything novel touches `TargetingSystem` / `CombatNavigationSystem` and the server sim (bump `simulationVersion`).
5. `TrainingModal` is data-driven — only add a `TROOP_FLAVOR` string.

### Add a defense
A defense is a building with `category:'defense'` + combat stats, PLUS a
targeting/fire behaviour and a projectile/impact. See `src/game/systems/AGENTS.md`
("Add a defense") — it spans this dir, `renderers/`, and `systems/`.

## Compile-time safety net

`BUILDING_VISUAL_CATALOG` and `DEFENSE_BEHAVIOR_CATALOG` are declared
`satisfies Record<…Type, …>`. Add a new type to a union and **the build fails**
until you give it a visual route and (if a defense) a fire behaviour. Lean on
this: wire the data first, let `tsc` tell you what's missing.
