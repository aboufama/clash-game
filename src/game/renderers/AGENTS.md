# src/game/renderers — the visual layer (how an entity becomes pixels)

Every building, troop, obstacle and wreck is drawn here as **hand-written
vector `Phaser.Graphics`** (no sprite sheets — yet; see
`docs/AGENTS_SPRITE_PIPELINE.md`). This is the least modular part of the
codebase: the data layer is a registry, but the art is O(n) bespoke code.
**Before touching any art, read `docs/BUILDING_ART_GUIDE.md`** — it encodes the
owner's calibrated taste and the iso math, and art that ignores it is rejected.

## The building visual dispatch (two compile-checked layers)

A single dispatch path is used by the live scene, the shop preview, AND the
world-map postcards — never fork it.

1. **`BuildingVisualCatalog.ts`** — `BUILDING_VISUAL_CATALOG: Record<BuildingType, {route}>`,
   `satisfies Record<…>` (exhaustive: a new building type won't compile until it
   has a route; the `'generic'` box fallback requires an explicit `reason`).
2. **`BuildingVisualDispatcher.ts`** — `DEDICATED_BUILDING_VISUALS: Record<route, handler>`.
   `drawBuildingVisual(...)` computes the footprint corners `c1..c4` + `center`
   from the registry `width/height` and calls the handler. This corner math is
   already asset-agnostic and survives the sprite rework.
3. **`BuildingRenderer.ts`** (~4800 lines) — ~27 `static drawX(...)` functions
   (e.g. `drawTownHall`, `drawCannon`, `drawBarracks`). Level variants are
   sometimes separate functions (cannon L1–L4), sometimes an internal
   `building.level` branch (barracks). **Signatures drift** — the canonical
   order is `drawX(graphics, c1,c2,c3,c4, center, alpha, _tint, building?, baseGraphics?, skipBase, onlyBase, time)`
   but real functions vary; the dispatcher closures exist mainly to absorb that
   drift per building.

### The base/elevated split (iron rule 2 — do not break)
```ts
const g = baseGraphics || graphics;
if (!skipBase) { /* ground paint: contact shadow + compact pad only */ }
if (onlyBase) return;
/* standing geometry drawn on `graphics` */
```
MainScene bakes the **base** into a ground RenderTexture (`bakeBuildingToGround`,
`onlyBase:true`) and draws the **elevated** part depth-sorted (`skipBase:true`).
Ground paint that leaks into the elevated pass (or vice-versa) breaks layering.
No footprint plates — contact shadow + `chamferPad` only (iron rule 4).

## The troop visual layer

- **`TroopRenderer.ts`** (~2970 lines) — `drawTroopVisual(...)` is a `switch(type)`
  → ~14 bespoke `drawX` functions (100–600 lines each).
- **Animation is parametric**, not framed: a shared rig `hRig(time, isMoving, …)`
  drives gait/idle via `sin`, and `attackAnim(time, attackAge, attackDelay, …)`
  returns `{windup, strike}` locked to the damage tick. Every pose is redrawn
  each frame. All motion is a function of `time` — never `Math.random()` per
  frame (iron rule 3).
- **Facing** is a continuous `facingAngle` (radians) used trigonometrically to
  aim weapons; walking facing comes from the velocity vector via
  `rotateTroopToward` (turn-rate limited). Only ~7 of 14 troops use facing;
  the rest are symmetric/front-facing.

## Other renderers
`ObstacleRenderer`, `WreckRenderer` (destroyed buildings; `ANIMATED_WRECKS`
gates per-frame redraw), `GrassRenderer` (`drawGrassTile`, shared by battlefield
+ postcards — never fork it), `VillageFlagRenderer`, plus the wilderness /
hydrology renderers documented in `src/game/systems/AGENTS.md`.

## Recipe: the visual half of a new building
1. Write `static drawX(...)` in `BuildingRenderer.ts` (respect the base/elevated
   split; contact-shadow grounding; deterministic ambient motion — pinning
   `time` must pin the pose, the bake depends on it).
2. `BuildingVisualCatalog.ts` — add the route to `DEDICATED_BUILDING_VISUAL_ROUTES`
   AND map `type → {route}` in the catalog.
3. `BuildingVisualDispatcher.ts` — add `route → handler` (match the draw fn's
   exact arg order + any level branching).
4. `tools/art-preview/shoot-defenses.mjs` — add to `SHOWCASE`; screenshot every
   level, day + night, and LOOK at the PNG. Typechecking is not seeing.
5. **Bake the sprites** (`docs/AGENTS_SPRITE_PIPELINE.md`):
   `cd tools/art-preview && UNITS=<id> LEVELS=… ANGLES=16|1 node bake-sprites.mjs`
   (16 angles for aiming defenses — the CoC model; 1 for static buildings),
   then LOOK at `shots/bake-sheet-<id>-L<k>.png`. Vector code is the authoring
   source; the game ships the baked frames.

## Recipe: the visual half of a new troop
1. Add a `switch` case in `drawTroopVisual` + write the bespoke `drawX` (art +
   parametric walk/idle/attack via `hRig`/`attackAnim`; use `facingAngle` to aim).
2. Add a bespoke anim field to `Troop` (`types/GameTypes.ts`) only if the draw
   needs persistent state (e.g. `slamOffset`, `mortarRecoil`).
3. Screenshot with `tools/art-preview/shoot-troops.mjs` (walk + attack poses).

## What the sprite-asset rework changes here
This directory shrinks the most. The 27 building draw fns + 14 troop draw fns +
`hRig`/`attackAnim` collapse to **one generic sprite handler** that blits a
texture keyed by `(type, level)` for buildings and `(type, state, direction, frame)`
for troops/defenses. The catalog/dispatcher corner math and the `DepthSystem`
integration survive. The friction is (a) the base/elevated split — a flat PNG
can't split, so you need two textures (ground-decal + elevated) or you drop the
ground-bake optimization; and (b) `PlacedBuilding.graphics` / `Troop.gameObject`
are typed `Graphics`, not `Sprite`. Full plan: `docs/AGENTS_SPRITE_PIPELINE.md`.
