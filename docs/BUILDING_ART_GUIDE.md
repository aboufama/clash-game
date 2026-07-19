# Building Art Guide

**Read this before touching any building or art code.** Every building in this
game is hand-drawn layered vector art in
`src/game/renderers/BuildingRenderer.ts` (Phaser Graphics, painter's order).
The live authoring path renders antialiased; baked pixel-art sprites opt into
nearest-neighbour sampling per texture through `TextureRenderPolicy`. The
conventions below were calibrated over many rounds of the owner's feedback — follow them and new
art will land on the first or second try; ignore them and it will be rejected.

**The quality bar** (look at these first, in the code and in game): spike
launcher L4, cannon L4, prism tower L4, dragons breath max, town hall. New art
must feel like it belongs next to them.

**The iron rule of iteration: never ship art you have not screenshotted.**
Run the dev server, run `tools/art-preview/shoot-defenses.mjs`, LOOK at the
png, fix, repeat. Code that typechecks is not art that works. (§9)

---

## 1. Coordinate system in one minute

- Grid → screen: `IsoUtils.cartToIso(gx, gy)` → `((gx−gy)·32, (gx+gy)·16)`.
  Tiles are 64×32. The iso vertical squash is **0.5** — it appears everywhere.
- A renderer receives its plot corners as `Vector2`s:
  `c1` = North (top), `c2` = East (right), `c3` = South (bottom),
  `c4` = West (left), plus `center`. For a square plot `c2.y === c4.y === center.y`.
- Standard local helpers (copy the pattern from `drawTownHall`):

```ts
const quad = (gr, pts, color, a) => { /* moveTo/lineTo/closePath/fillPath */ };
const lerp = (a: Vector2, t: number) => [center.x + (a.x−center.x)·t, center.y + (a.y−center.y)·t];
const up   = (pt: number[], h: number) => [pt[0], pt[1] − h];
```

`lerp(corner, s)` shrinks toward the center — this is how buildings sit
**inset** in their plots (see §4).

## 2. The renderer contract

```ts
static drawX(graphics, c1, c2, c3, c4, center, alpha, _tint,
             building?, baseGraphics?, skipBase = false, onlyBase = false, time = 0)
```

- **Base vs elevated split (required):** everything painted ON the ground
  (contact shadows, dirt patches, stone borders, pads) draws on
  `const g = baseGraphics || graphics` inside `if (!skipBase) { ... }`; then
  `if (onlyBase) return;` and all standing geometry draws on `graphics`.
  MainScene bakes bases into a ground texture (`bakeBuildingToGround`) and
  draws elevated parts with depth sorting. Break this split and layering bugs
  return. Details: `docs/RENDERING_AND_DEPTH.md`.
- **`_tint` is legacy** — most renderers ignore it (underscore the param).
- **`building`** carries `level`, `doorOpen`, and weapon animation state (§6).
- **`time`** comes through `BuildingVisualDispatcher` (`this.time.now` for
  live art, pinned to `0` for cached postcards). ALL ambient
  animation must be a **deterministic function of `time`** — sines and
  phases, never `Math.random()` per frame (it strobes).
- Register new renderers once in `BuildingVisualCatalog.ts` and
  `BuildingVisualDispatcher.ts`. MainScene and neighboring postcards share
  that route, including level selection and the base/elevated contract.

## 3. Light, palette, and level language

- **Light comes from the NW.** Top faces lightest, SW face lit, SE face dark.
  Every box: draw SE face (dark), then SW face (lit), then the roof.
- **Level progression:** L1 timber/field materials → mid levels stone/iron →
  max level warm sandstone/parchment/cream (`0xbfb49a`, `0xc9c2ae`,
  `0xdcd3ba`) with gold (`0xdaa520`/`0xffd700`).
- **THE max-level rule (owner is strict about this):** gold and white are
  **subtle accents**, never large pure-white masses. A gilded ridge line, a
  finial, a small roundel — not a white building. Prism L4 is the calibration
  reference. On weapons the **weapon** goes gold/white while the base/tower
  stays wood or stone (xbow L3: gold bow + white limbs on a timber drum).
- Keep silhouettes simple and readable — this is a pixelated game viewed
  zoomed out. When in doubt, remove detail.

## 4. Grounding — the Clash of Clans model

No building may fill its footprint with a material plate. The lawn is one
continuous meadow; buildings sit ON it:

- **Every building:** `BuildingRenderer.groundShadow(g, c1..c4, center,
  alpha, strength, scale)` — soft dark-green contact shadow. Shadows must
  never spill past the plot (big buildings: smaller scale or none).
- **Defenses:** additionally `BuildingRenderer.chamferPad(...)` — a compact
  chamfered platform sized to the machine (~0.55–0.72 of footprint),
  level-materialed (earth → stone → dark stone → sandstone+gold).
- **Structures are inset:** the walls start at `lerp(corner, s)` with
  s ≈ 0.6–0.8 of the plot (town hall 0.62 of 3×3, lab 0.68, storage 0.8).
- Special grounds: army camp = chamfered dirt patch (no shadow), mine =
  compact trampled patch (~0.64), dragons breath = octagonal deck (no
  shadow), town hall = **simple flat stone border quad** at 0.76 (the owner
  explicitly rejected a chamfered apron there — "super simple").

## 5. Architecture vocabulary

**Box + pyramid crown** (lab, town hall): walls from `lerp(c, s)` up `wallH`,
roof corners at `lerp(c, s·o)` (overhang o ≈ 1.08–1.16) raised `wallH`, apex
at `center − wallH − roofH`. Four triangular faces: near two full alpha,
far two ×0.92. No pentagon gable roofs — a "gable" that only draws one slope
was a real shipped bug.

**Hipped ridge roof** (barracks, storehouse — deliberately distinct from the
pyramids): ridge runs along grid-x through the center:

```ts
const q  = s * 0.22;                    // ridge half-length factor
const RA = [center.x − (c2.x−c1.x)·q, center.y − (c2.y−c1.y)·q − wallH − roofH];
const RB = [center.x + (c2.x−c1.x)·q, center.y + (c2.y−c1.y)·q − wallH − roofH];
// far slope [r1,r2,RB,RA], far hip [r4,r1,RA], near slope [r4,r3,RB,RA], near hip [r3,r2,RB]
```

Draw far faces first. Add tile-course lines parallel to the eave, a ridge cap
line, finials/chimney/spikes at the ridge by level.

**Doors sit on a wall FACE, never a corner** (we're isometric — a corner door
reads broken). Center on the SW face and **skew the whole assembly into the
wall plane** so its bottom runs parallel to the wall base:

```ts
const dX = (p3[0]+p4[0])/2, dY = (p3[1]+p4[1])/2;
const sk = (p3[1]−p4[1]) / (p3[0]−p4[0]);          // SW face slope (~0.5)
const dp = (ox, h) => [dX + ox, dY + ox·sk − h];    // build EVERYTHING with dp()
```

Anything mounted on a face (windows, lanterns, steps, roundels) uses the same
skew. **`doorOpen` contract:** villagers walk through doors —
`building.doorOpen` is 0..1; when > 0.02 show a dark interior, a warm light
spill ellipse, and a swung-leaf sliver at the jamb (copy from `drawStorage`).
Do not remove this from a building that has it.

**Mini-structures on roofs** (cupolas etc.) must be proper little iso boxes
(diamond base, two visible faces) — a screen-axis-aligned flat-bottomed
rectangle sitting on a sloped roof was rejected as "jarring."

## 6. Rotating weapons (turrets)

The aim angle is a screen-space angle stored on `building.ballistaAngle`
(target: `ballistaTargetAngle`; MainScene lerps them). The toolkit:

```ts
const ax = d => Math.cos(a)·d;          // along-aim, screen x
const ay = d => Math.sin(a)·0.5·d;      // along-aim, screen y (iso squash!)
const px = w => −Math.sin(a)·w;         // across-aim
const py = w =>  Math.cos(a)·0.5·w;
const P  = (d, w, h) => [center.x + ax(d)+px(w), center.y + h + ay(d)+py(w)];
```

- **Aim-aware layering:** when `sin(a) < 0` (pointing up-screen) draw the
  weapon BEFORE its mount, otherwise after. Order far→mount→near pieces by
  the sign of `sin(a)`.
- **Rotation-proof boxes:** on a rotating mount draw exactly the two side
  faces whose outward normals point down-screen (pick by `cos`/`sin` signs).
  Fixed face choices disappear at some aims — a shipped bug, twice.
- **Discs perpendicular to the aim** (muzzle faces): span them with the
  horizontal perpendicular + the vertical axis so they go edge-on when
  sideways. Gate bores with `sin(a) > 0.05`. Spheres are plain circles.
- **Volumetric barrels** (the cannon): a screen-space capsule — offset the
  silhouette perpendicular to the *projected* axis, belly shadow + top
  light, rings as arcs, and `aySquash = sin < 0 ? 0.74 : 0.5` so the barrel
  doesn't look stubby pointing up. Never draw a barrel as a flat quad
  ("flat worm" — rejected).
- **Tapered strips** (bow limbs): thickness along the screen-space normal
  `(−dy, dx)/len`, never a vertical offset.
- Animation state: `building.lastFireTime` (all defenses),
  `ballistaStringTension` (ballista draws 0→1, xbow decays 1→0 after a
  shot), `ballistaBoltLoaded`, `cannonRecoilOffset`.

## 7. Projectiles

- **Spawn where the art says:** cannon muzzle at +28 along aim, height −14;
  ballista bolt exits the rail at
  `(start.x + cos(a)·14, start.y − 28 + sin(a)·0.5·14)`. If you move a
  weapon's geometry, move its spawn point in MainScene.
- **The flying projectile must be drawn identical to the loaded/deployed
  art** (the ballista's flying bolt mirrors the loaded bolt; dragons-breath
  rockets mirror the silo pods — which launch with a 230 ms vertical liftoff
  from the exact silo before arcing).
- **Big projectiles cast ground shadows:** a dark ellipse (`0x18220f`,
  depth 950) tweened along the ground line, slimming at an arc's apex.

## 8. Walls, and shapes lying ON the ground

**Walls** (`drawWall`): overlap-proof partition — each tile draws only its
SOUTH and EAST connector bars (center-to-center) plus a corner post; N/W
connections belong to those neighbours, so painter's order is exactly
back-to-front. Posts render ONLY at corners/junctions/ends (straight runs
are slim continuous bars — the CoC rhythm the owner wants). Within a tile the
POST draws FIRST and bars start at the post's face (`barStart`). Never
reorder. Caps by level: stake / stone slab / iron band / gold pyramid.

**Anything drawn flat on the lawn** (the dragon-shadow easter egg, light
pools, big shadows) must be **ONE closed polygon at uniform alpha** — stacked
sub-shapes double-darken at every overlap (rejected as "looks like shit").
Design top-down with +x = travel direction, then:

```ts
const psi = groundHeading + Math.PI/4;   // grid axes sit 45° off screen axes
screenPt = [x·cos(psi) − y·sin(psi), (x·sin(psi) + y·cos(psi)) · 0.5];
```

The dragon shadow is now one multiply-blended silhouette above the complete
world scene, so the same closed shape dims grass, walls, and roofs without
per-building seams or overlapping alpha. There is no per-building drape table
to update.

## 9. Day/night — what building art must provide

`src/game/systems/DayNightSystem.ts` (see its header comment):

- The color grade is a **world-space** rect stretched over `cam.worldView`
  each frame. Never use `setScrollFactor(0)` for full-screen overlays —
  camera zoom still scales those (that was the shrinking-darkness bug).
- A building that should glow at night gets a `LIGHT_SOURCES` entry:
  `{ kind: fire|energy|molten|lamp, tint, radius, ox, oy, h, shaft?, minLevel? }`.
  `ox/oy` are hand-matched to the drawn emitter (door, fire pit, crystal).
  **Light may only exist where the art draws a source** — use `minLevel` if
  the lantern/fire only appears at higher levels, or draw a lantern (the
  storehouse got one for exactly this reason).
- All light lying on the ground is a **2:1 ellipse, never a circle**; only
  elevated emitters (prism crystal, tesla coil) keep round halos.
- Test: `PHASE=0.8 TAG=night node shoot-defenses.mjs`, or the N key in game.

## 10. Adding a building end-to-end

1. Add the type and category definition under
   `src/game/config/definitions/`, then compose it in
   `BuildingDefinitions.ts`. `GameDefinitions.ts` is only the compatibility
   barrel.
2. `src/game/renderers/BuildingRenderer.ts` — `drawX` per this guide.
3. Add its explicit route to `BuildingVisualCatalog.ts` and its one handler
   to `BuildingVisualDispatcher.ts` (pass the supplied `time` if animated).
   The shared dispatcher serves both MainScene and neighboring postcards.
4. If villagers should use its door, support `doorOpen` (§5).
5. Active defenses also need a policy in `DefenseBehaviorCatalog.ts` and a
   projectile/effect callback in MainScene's `DefenseSystem` wiring.
6. `src/game/systems/DayNightSystem.ts` — `LIGHT_SOURCES` if it glows (§9).
7. `src/icons/accurate-icons.css` — shop icon.
8. `src/game/backend/BotWorlds.ts` — bot base placements, if bots build it.
9. Depth is automatic (`DepthSystem`), but verify layering vs walls/troops.
10. **Screenshot it** (§11) at every level, day and night, before calling it
   done.

Deleting a building = the reverse of all of the above **plus** purging
catalog/special-behavior references; old saves self-clean (the server drops
unknown types). See `docs/ADDING_BUILDINGS.md` for the full code checklist.

## 11. Verifying your art (mandatory)

```bash
npm run dev                      # terminal 1 — game + server on :5173
cd tools/art-preview && npm i    # once
node shoot-defenses.mjs          # terminal 2 — screenshots every showcase building
```

- Output: `tools/art-preview/shots/<type>-L<level>-<tag>.png`. **Open and
  look at them.** Iterate until it's right at every level.
- Env knobs: `ANGLE=` (aim), `TENSION=`, `RECOIL=`, `TAG=` (filename suffix),
  `PHASE=` (0.3 day / 0.8 night — pins the day/night clock).
- Add new buildings to the `SHOWCASE` array at the top of the script
  (`[type, level, gridX, gridY, w, h]`, map is 25×25 — keep placements on it).
- `shoot-walls.mjs` = wall shapes (lines/corners/T/cross/staircase);
  `shoot-dragon.mjs` = steers the dragon-shadow easter egg over the town hall.
- In-game debug: D key menu (pixelation OFF to inspect raw vectors), N key
  (hop day phase), D (summon dragon shadow).
- Rotating defenses: shoot several `ANGLE`s including one with `sin < 0`
  (pointing up-screen) — that's where layering bugs hide.
- If a screenshot looks impossibly wrong (missing geometry that the code
  clearly draws), suspect a stale HMR module from a parallel session's
  mid-edit state — reload/re-run before debugging your own code.

## 12. Owner's taste, distilled

- Simple > detailed. Readable silhouettes. Fewer, bolder shapes.
- Warm sandstone + gold accents at max level; never big white masses.
- Wood and stone are the body of everything; gold/white belongs to weapons,
  trims, and crowns.
- Buildings smaller than their plots; the lawn breathes between them.
- Everything grounded: contact shadows, compact pads, no plates.
- Ambient life beats static perfection: flags wave, smoke drifts, doors
  open, lights flicker — all deterministic in `time`.
- When the owner says a thing looks wrong, redesign the geometry — don't
  nudge constants and hope.
