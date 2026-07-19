# Modularity Assessment — buildings, defenses, troops

*Written 2026-07 as the groundwork for the sprite-asset rework. Companion:
`tools/art-preview/AGENTS_SPRITE_PIPELINE.md`.*

## Verdict in one paragraph

The **data and simulation layers are well-factored and modular**; the **art and
effects layers are O(n) bespoke code and are the scaling wall.** A building's
stats, cost, footprint, HP, production, collision, depth, shop card, server
pricing/sanitize, and a troop's stats, targeting, level-scaling, pathfinding and
authoritative damage are all driven by declarative registry entries with
compile-checked wiring — adding a *stat-only* entity touches ~4 declarative
spots and zero logic. But **every** building carries a 100–540-line hand-written
vector draw function, **every** defense adds a 90–310-line bespoke `shoot*At`
method, and **every** troop adds a 100–600-line draw function plus a client FX
function. That is exactly the "custom code a tower-defense can't have": the
spine is right, the leaves are hand-carved.

## The format — how a defense is organized today

One cannon is spread across **six** places. Data (modular) on the left, bespoke
code (the problem) on the right. Shapes below are illustrative of the real
structure, not verbatim.

**1. Registry — `config/definitions/buildings/DefenseBuildings.ts`** *(data)*
```ts
cannon: {
  id: 'cannon', name: 'Cannon', width: 2, height: 2, maxHealth: 420,
  category: 'defense', range: 5.5, damage: 18, fireRate: 800,
  maxCount: 6, maxLevel: 4, color: 0x6b7280,
  levels: [ { hp: 420, damage: 18, fireRate: 800, range: 5.5, cost: 250 }, … ],
}
```

**2. Visual route — `renderers/BuildingVisualCatalog.ts`** *(data, compile-checked)*
```ts
cannon: { route: 'cannon' },     //  satisfies Record<BuildingType, …>
```

**3. Fire behaviour — `systems/DefenseBehaviorCatalog.ts`** *(data, compile-checked)*
```ts
cannon: { fireEffect: 'cannon', targeting: 'nearest', start: 'ready', scheduler: 'standard' },
```

**4. Visual dispatch — `renderers/BuildingVisualDispatcher.ts`** *(glue)*
```ts
cannon: (g, c1,c2,c3,c4, center, a, tint, b, base, skipBase, onlyBase, time) => {
  const lvl = b?.level ?? 1;
  if (lvl >= 4) return BuildingRenderer.drawCannonL4(…);
  if (lvl === 3) return BuildingRenderer.drawCannonL3(…);
  …
  return BuildingRenderer.drawCannon(…);
}
```

**5. The turret art — `renderers/BuildingRenderer.ts`** *(bespoke, ~130 lines × 4 levels)*
```ts
static drawCannon(g, c1,c2,c3,c4, center, a, _tint, building?, baseGraphics?, skipBase?, onlyBase?, time?) {
  const base = baseGraphics || g;
  if (!skipBase) { /* contact shadow + chamfer pad */ }
  if (onlyBase) return;
  const angle = building?.ballistaAngle ?? 0;          // ← procedural rotation, infinite resolution
  const recoil = building?.cannonRecoilOffset ?? 0;
  /* ~130 lines of carriage + barrel vector geometry, rotated by cos/sin(angle) */
}
```

**6. The shot — `scenes/MainScene.ts`** *(bespoke, ~123 lines)*
```ts
private shootAt(defense: PlacedBuilding, target: Troop, time: number) {
  const angle = Math.atan2(endIso.y - (startIso.y - 14), endIso.x - startIso.x);
  /* muzzle flash → spawn ball graphics → tween arc → on hit: hard-coded splash
     radius, damage, screenshake, impact particles */
}
```

Plus per-defense **aim state** on the runtime struct (`types/GameTypes.ts`):
`ballistaAngle`, `ballistaTargetAngle`, `ballistaStringTension`, `cannonRecoilOffset`,
`teslaCharging`, … The turret is rotated by writing
`cos/sin(angle)` into vector geometry every frame.

Buildings that aren't defenses are the same minus steps 3 and 6. Troops mirror
it: a `TroopDef` (very declarative — `targetPriority`, `splashRadius`,
`chainCount`, `movementType` are all data) + a `switch` case in `drawTroopVisual`
+ a bespoke `drawX` posed by the parametric `hRig`/`attackAnim` rig + a client FX
function + `if (type === …)` branches in the MainScene combat block.

## The numbers

| Surface | Size | Per new entity |
|---|---|---|
| `BuildingRenderer.ts` | ~4,844 lines, ~27 draw fns | +100–540 lines (× levels) |
| `TroopRenderer.ts` | ~2,969 lines, 14 draw fns | +100–600 lines |
| `MainScene` fire fns | ~9 fns, ~1,500 lines | +90–310 lines (defense) |
| Registry + catalogs | data | +~15 lines + 2–3 one-liners |

So a new **defense** ≈ 15 data lines + 3 compile-checked one-liners + **~130–540
lines of turret art × up to 4 levels + ~90–310 lines of fire code + bespoke
struct fields.** Roughly **10–20% data, 80–90% bespoke code.** A **troop** is
~30% data, ~70% bespoke rendering/animation.

## Why this can't scale to a tower-defense roster

A tower-defense lives or dies on the *breadth* of its tower/enemy roster.
Hand-writing a multi-hundred-line vector function (and, for towers, a bespoke
projectile+impact method with hard-coded splash/arc) **per unit** means:

- **Linear author cost with a high constant** — every unit is a from-scratch art
  + FX commission, gated behind a manual screenshot-review loop (iron rule 1).
- **No angle/animation reuse** — turret aim is `cos/sin(angle)` baked into each
  draw fn; there's no shared frame model, so every new turret re-solves aiming.
- **Drifting signatures** — the "canonical" draw signature isn't actually uniform
  (`drawTownHall` takes grid coords, `drawLab` reorders `time`); the dispatcher
  closures exist mostly to paper over that drift, which is per-building glue.
- **Simulation constants trapped in art/FX** — splash radius, projectile arc, and
  screenshake live inside `shoot*At` bodies, so tuning a tower means editing code,
  not data.
- **One 243 KB file** (`BuildingRenderer`) that every art change contends on —
  and, with parallel agents, a merge hazard.

## What's already right (keep it)

The recent refactor did the hard structural work:

- **Split registries** in `config/definitions/` + a barrel, shared client/server.
- **Two compile-checked catalogs** (`BUILDING_VISUAL_CATALOG`,
  `DEFENSE_BEHAVIOR_CATALOG`, both `satisfies Record<…>`) — you *cannot* add a
  type without wiring its visual + behaviour; missing wiring is a build error.
- **One shared visual dispatcher** used by the live scene, previews, and world-map
  postcards — art is defined once.
- **A clean simulation seam:** `DefenseSystem` calls `effects.fire[type](defense,
  target, time)` with zero visual knowledge; `TargetingSystem` picks targets off
  declarative `targetPriority`; the server sim recomputes from the same numbers.
- **Data-driven server sanitize** — unknown types self-clean, so deleting a unit
  is safe.

The architecture is a data-driven registry with a **procedural-art plug-in per
type.** The rework keeps the registry and swaps the plug-in from
"hand-written vector function" to "sprite lookup + small parameterized FX module."

## The path forward (detail in the pipeline doc)

1. **Bake the visuals into assets.** Replace the 27 + 14 draw functions with one
   generic sprite handler keyed `(type, level)` for buildings and `(type, state,
   direction, frame)` for defenses/troops. Turret aim becomes `angle → frame
   index`; walk/attack become `state + frame`. This is where ~7,000 lines of
   bespoke render code go away.
2. **Promote FX constants to data.** Add `projectileType`, `projectileSpeed`,
   `arc`, `splashRadius` to the defense registry and lift a single parameterized
   projectile+impact module out of the nine `shoot*At` methods. Projectile and
   impact *particles* stay code (they're world-space effects, not the unit body),
   but they stop being copy-pasted per tower.
3. **The seam already exists** — `DefenseSystem`/`TargetingSystem`/the server sim
   consume only numbers and grid positions and never touch pixels, so none of the
   simulation changes. Only the *consumer* of the sim's outputs (the renderer)
   swaps procedural drawing for frame selection.

Full asset spec, generation pipeline, runtime loader, friction points, and
phased migration order: **`tools/art-preview/AGENTS_SPRITE_PIPELINE.md`**.
