# Rendering and Depth (Isometric)

Use this when a building, troop, projectile or effect appears in front of the
wrong thing.

## Core Rule

Simulation happens in grid space.
Rendering happens in isometric pixel space.

Coordinate helpers:
- `src/game/utils/IsoUtils.ts`

Tile geometry used by scene:
- `tileWidth = 64`
- `tileHeight = 32`

## Depth Source of Truth

All depth values come from:
- `src/game/systems/DepthSystem.ts`

The painter's-order base formula (fractional grid coords are fine):

```
baseDepth(x, y) = 1000 + (x + y) * 100 + (x - y) * 0.1
```

`(x + y)` is the isometric row (100 per row); `(x - y)` is a tiny tie-break
along the row (it must stay tiny: two same-row objects whose art can overlap
on screen sit within ~4 tiles along the row, so their tie difference stays
under the 0.5 sub-band rungs below — a tie scale of 1 once let a wall
two tiles along the row out-tie a same-row 3x3 roof). Everything visible in
the world adds a LAYER OFFSET to that base — offsets never approach 100, so
nothing can cross into the next row:

| layer                    | offset       | notes                                    |
| ------------------------ | ------------ | ---------------------------------------- |
| rubble / wrecks          | 3            | floor-center anchor — walk-over art      |
| troop / character        | 15 + bias    | bias `min(6, max(1, space))` → [16, 21]  |
| obstacle                 | 18 + 0.5·sz  | occluder band, capped bias (sz ≤ 4)      |
| building / wall          | 18.5 + 0.5·(sz−1) | occluder band → wall/1x1 18.5 … 4x4 20 |
| projectile               | 60           | `depthForProjectile(x, y)`               |
| airborne burst FX        | 62           | `depthForGroundEffect(x, y)` — NOT lawn decals (see the two effect classes below) |

## The Occluder Band (characters vs solids)

Characters anchor at their FEET (fractional position) with offset
`15 + bias ∈ [16, 21]`. Every solid occluder — wall, building, obstacle —
anchors at its exact footprint CENTER (the visual boundary of its art) with
an offset strictly INSIDE the character range. For any character/solid pair:

```
charDepth − solidDepth = 100·(charRow − centerRow) + (charOff − solidOff)
                       = 100·Δrow ± ≤3
```

so the painter flips within ±0.03 rows (≈1 screen px) of the art's center:
feet in front of the tile/footprint center → character paints over the
crest/roof; feet behind → occluded. This holds for EVERY troop type at every
sub-tile offset. Two consequences are load-bearing:

- **Never anchor a solid behind its center** (the old back-corner /
  floor-center anchor). It re-opens the band `anchorRow < charRow <
  centerRow` where a character standing BEHIND the art out-depths it
  (villagers stood on the town-hall roof; every troop painted over walls it
  stood 0.05–0.6 tiles behind; characters on the walkable tile north of a
  2x2 tower drew on top of it).
- **Never give a solid an offset outside (16, 21).** Above 21 it swallows
  characters standing just in front; at/below 16 tall troops pop over it
  from behind. The old barracks roof lift (+60) violated this and is gone —
  same-row roof-over-wall ordering now comes from the 0.5 sub-band rungs
  (bigger footprint = higher rung) plus the shrunken tie scale.

Exported functions:
- `depthForGroundPlane()` — the baked ground RT (0)
- `depthForFootprint(gridX, gridY, w, h, layerOffset, bias)`
- `depthForBuilding(gridX, gridY, type)`
- `depthForObstacle(gridX, gridY, w, h)`
- `depthForRubble(gridX, gridY, w, h)`
- `depthForTroop(gridX, gridY, type)`
- `depthForProjectile(gridX, gridY)` — rigid shots, at their CURRENT position
- `depthForGroundEffect(gridX, gridY)` — AIRBORNE burst FX (muzzle flashes,
  impact blooms, debris in flight)
- `depthForGroundDecal(kind)` — GROUND-PLANE effect decals (absolute band,
  see below)

## Footprint Anchor

For buildings/walls/obstacles the depth anchor is the EXACT footprint center
(the visual boundary of the art):

```
anchorX = gridX + width / 2
anchorY = gridY + height / 2
```

For non-square footprints (farm 3x2) the center row is the optimal
compromise between the two diagonal ambiguity zones (a single painter scalar
cannot sort both perfectly — errors are confined to art slivers at the
extreme E/W corners). Rubble/wrecks are the exception: they keep the legacy
floor-center anchor + offset 3 so a character standing anywhere ON a wreck
always paints over it.

## Special Cases

- **Walls vs characters**: handled entirely by the occluder band above — a
  wall is just a 1x1 solid at 18.5, no special wall offset exists anymore.
  Villagers (`VillageLifeSystem.characterDepth`) use exactly
  `depthForTroop(x, y)` — same anchor and offsets as combat troops. Never
  re-fix wall occlusion by shifting a character's anchor; that de-syncs
  villagers from troops (an attacker used to overpaint a defender standing
  ~0.95 tiles in FRONT of it). The permanent regression harness for this is
  `tools/art-preview/verify-layering.mjs` — run it after ANY depth change.
- **Construction/scar/forge overlays** (`VillageLifeSystem`) ride on
  `depthForBuilding(...) + 37/38/39`: above the building carrier and any
  same-row character (55.5..59 total), still below the projectile band (60).
- **Projectiles** re-derive `depthForProjectile` per frame in their tween's
  `onUpdate`, lerping the GRID ground track (launch tile → target tile) by
  tween progress — never from the arced iso `y`. Impact/muzzle FX use
  `depthForGroundEffect(tile)` plus tiny ±N offsets for internal stacking.
- **Shared particle emitters**: `ParticleManager` banding — one emitter per
  64-depth band (`depthBandOf`). Never `setDepth` a shared emitter per burst;
  it retro-depths every particle still alive on it.
- **Live world-postcard battles**: the cached lawn/lane/base RenderTexture
  keeps its plot-level world-map depth. Dynamic battle bodies live in one
  Phaser `Layer` immediately above that texture; children call
  `depthForBuilding` / `depthForTroop` with PLOT-LOCAL coordinates so the
  unscaled 0.1/0.5 occluder sub-bands remain exact without crossing into a
  neighboring postcard's plot band. `SpriteBank` shadow sprites must inherit
  their carrier's display list. Wreck scars stay in that Layer's absolute
  `depthForGroundDecal` band, below every body.

## Silhouette Dead Zone (behavioural, NOT a depth rule)

The baked iso art of a building rises only a few px above its REAR footprint
corner (the drawn roofline is the ridge apex→E/W eaves; the back walls are
never drawn). A figure standing within ~0.75 tiles behind the footprint (or
in the footprint's back half) therefore pokes its whole body above the drawn
silhouette and reads as **perched on the roof** — even though the painter's
order is exactly right. This was measured pixel-level (2026-07): a villager
at (11.6, 9.5) behind a 3x3 hall at (11,10) covers ZERO opaque art pixels
(depth 3126 vs hall 3419.6, correctly under); everything you see of him sits
in the transparent sky INSIDE the art's rect. No depth scalar can clip
pixels the art never painted, so the fix is behavioural:

- `VillageLifeSystem.inSilhouetteShadow(x, y)` defines the band (footprint
  expanded 0.75, rows in front of `centerRow − 0.4` excluded). Ambient
  figures may WALK through it but never STOP in it: `openTileAt` /
  `openTileNear` reject band tiles (this also keeps `doorOf`'s fallback from
  ever picking a behind-the-building "door"), and a walk that ends in the
  band immediately walks out to the nearest clear tile.
- The panic-refuge path no longer passes the refuge as `throughId` — a
  villager routed straight ACROSS the hall footprint to its south door read
  as walking through the building for seconds.
- Construction scaffolds (`drawScaffold`) omit poles planted on corner
  points shared with another building's footprint and rail runs along faces
  whose door-step tiles another building occupies — a rail riding the
  sky-gap just above a front-neighbour's roofline read as "fence planted in
  the roof face" (its depth was correctly below; the sliver was sky).

If a "figure on the roof" report comes in: FIRST verify the painter order
with a pixel diff (hide the figure's carrier, diff, classify what was
underneath) before touching depth math — every 2026-07 case was this read
artifact, and "fixing" it by shifting anchors/offsets re-opens the real
occluder-band bugs listed above.

## The Two Effect Depth Classes (policy)

Every effect is exactly one of two things — classify BEFORE picking a depth:

**(a) GROUND-PLANE DECAL** — flat art painted ON the lawn: slam cracks and
dust/shock rings, scorch marks, craters, spike/caltrop zones, rime/freeze
rings, chill residue, deploy/heal/aura rings, ground shockfronts. These must
render UNDER every troop and building standing art, ALWAYS → use
`depthForGroundDecal(kind)` (small ABSOLUTE depths, the band below). Never
give a lawn decal painter's-order depth: base+62 out-depths every troop up
to ~0.4 rows in FRONT of the effect's tile, so the decal paints OVER units
standing inside it (the golem-slam-ring-over-troops bug, fixed 2026-07).

**(b) AIRBORNE / BURST FX** — anything with a vertical body or in flight:
explosion blooms, muzzle flashes, debris/embers/chips in flight, beams,
rising smoke, floating particles, impact flashes → painter's order via
`depthForProjectile` / `depthForGroundEffect` (+ tiny ±N internal offsets).

Debris that FALLS and LANDS may transition (b) → (a) on landfall if a case
visibly needs it; today's landed chunks fade fast enough to stay in (b).

### Ground-Decal Band (absolute, below 1000)

`depthForGroundDecal(kind)` — persistent stains low, living/transient FX on
top; callers may stack tiny ±0.5 offsets:

- ground RT: 0
- stone lanes RT (`VillageLifeSystem.presentStonePaths`): 2.5
- `crater` 3 — mortar craters, slam/impact crack webs
- `zone` 4 — spike-launcher caltrop fields
- `scorch` 5 — prism scorch / chasm trail
- `scorchHot` 6 — dragons-breath scorch, melt puddles
- `residue` 7 — frost rime, freeze fissures, spike-impact cracks
- `aura` 8 — heal/drum auras, heal waves, click pulses
- `shockfront` 9 — transient expanding ground rings / dust blooms

Anything new in this band goes ABOVE 2.5 (the stone lanes RT) and below the
entity range (1000+). Known exceptions that stay painter's-order on purpose:
the defense freeze overlay + range indicator (dressing ANCHORED to a
building's art, not lawn decals) and the 30000-band death/collapse bursts
(legacy always-on-top airborne FX).

## Ground Plane Contract

Ground-level visuals must render below everything else.

How this project handles it:
1. Grass/ground is pre-baked to a render texture.
2. Building base parts are baked onto that texture.
3. Elevated building parts are drawn in runtime pass with normal depth sorting.

Scene methods:
- `MainScene.createIsoGrid()`
- `MainScene.bakeBuildingToGround(...)`
- `MainScene.unbakeBuildingFromGround(...)`

## Renderer Contract (Required)

Building renderers in `src/game/renderers/BuildingRenderer.ts` must support:
- `onlyBase`: draw only ground-plane/base parts
- `skipBase`: skip base parts, draw elevated parts only

Pattern:

```ts
if (!skipBase) {
  // ground-plane/base
}

if (!onlyBase) {
  // elevated geometry
}
```

If this split is not respected, layering bugs return.

## Overlay Scene

`BattleOverlayScene` (health bars, level chips) mirrors the main camera every
frame: zoom, scroll AND the shake offset (`shakeEffect._offsetX/_offsetY`,
applied as `scroll - offset`). Copying only zoom+scroll makes health bars
slide off buildings during every camera shake.

## Quick Layering Test

1. Place walls/buildings and a large troop nearby.
2. Check all relative directions.
3. Confirm:
- Floor/base never draws over troops
- Elevated geometry overlaps correctly by depth
- A defense shot fired south stays visible in front of everything it passes,
  and disappears behind things a full row in front of it
