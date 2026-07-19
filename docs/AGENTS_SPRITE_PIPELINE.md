# Sprite-Asset Pipeline — vector-authored, pixel-baked

*The agentic art pipeline. Companion: `docs/MODULARITY_ASSESSMENT.md` (why),
directory `AGENTS.md` files (where). Status and pilot results at the bottom.*

## The idea in one paragraph

Agents keep authoring art exactly the way they do today — **iso-aware vector
draw code** (the `BuildingRenderer` idiom, governed by
`docs/BUILDING_ART_GUIDE.md`). A bake tool then renders that code through the
**real game renderer**, quantizes the result into pixel-art texels offline
using the **same math the removed runtime Pixelate shader used**, and writes
PNG frames + a manifest. The shipped game loads only the baked frames — no
live vector drawing for sprite-routed units. The result is virtually
indistinguishable from the old shader look at rest, and **cleaner while
dragging**: the old shader re-sampled the frame through a *world-anchored*
grid every frame (sub-pixel camera motion re-rasterized every cell edge, and
on real GPUs its fp16 math shimmered); a baked sprite's pixels are anchored to
the **object**, so panning translates them rigidly.

```
Stage A (agent)          Stage B (machine)                 Stage C (runtime)
vector draw fn   ──►   bake-sprites.mjs                ──►  atlas + manifest
(iso rules,             renders via the REAL renderer        generic sprite
 code review,           (window.__clashBake bridge),         handler; frame =
 deterministic)         quantizes @ CELL=1.35 wpx,           f(type, level,
                        16 angles for turrets,               state, angle/dir)
                        writes PNG + manifest
```

## Stage A — authoring (what an agent does)

Nothing changes about *how* art is made. An agent:

1. Writes/edits a vector draw function in the existing idiom
   (`BuildingRenderer.drawX` / `TroopRenderer.drawX`) — iso math, base/elevated
   split, contact-shadow grounding, all ambient motion a deterministic
   function of `time` (iron rule 3 — this is what makes baking possible:
   **pinning `time` pins the pose**).
2. Wires the compile-checked catalogs (`BuildingVisualCatalog`,
   `DefenseBehaviorCatalog`) as before.
3. Runs the bake (Stage B) and **looks at the emitted contact sheet** —
   iron rule 1 applies to baked frames exactly as it did to screenshots.

Vector code stays the **source of truth** in the repo: reviewable diffs,
deterministic regeneration, no hand-edited binaries. Hand-authored pixel art
is still possible (drop PNGs + manifest entries in the same format), but the
default path is code → bake.

## Stage B — the bake (`tools/art-preview/bake-sprites.mjs`)

```
# server must be running (npm start on 8788, or npm run dev on 5173 —
# the bake auto-falls back to 5173 when 8788 is down)
cd tools/art-preview
UNITS=all TROOPS=all node bake-sprites.mjs        # the whole roster (~4 min)
UNITS=cannon LEVELS=1,2 node bake-sprites.mjs     # one unit, chosen levels
TROOPS=archer TROOP_LEVELS=1 node bake-sprites.mjs
VERIFY=1 UNITS=cannon node bake-sprites.mjs       # + in-game A/B + fidelity metrics
```

Both the bake and the screenshot harnesses resume ONE shared identity from
`tools/art-preview/.shared-device-token.json` (auto-created, gitignored).
Never mint sessions via `/api/auth/session` per run: guest creation is
rate-limited (30/hour/address) and every extra guest permanently junks the
world map with an abandoned village.

`UNITS=all` discovers the roster from `BUILDING_DEFINITIONS` + the visual
catalog (generic-routed types are skipped; levels come from `maxLevel`), bakes
**16 angles** for the rotating turrets (`cannon`, `ballista`, `xbow` — the
`ROTATING` set in the script), 1 angle for static buildings, and **walls as 16
neighbor-topology variants per level** (`wall_L<k>_m<N|E|S|W-mask>_body.png`,
driven through the dispatcher's `wallNeighbors`).

- **The bridge.** `src/game/dev/BakeBridge.ts` exposes
  `window.__clashBake = { scene, drawBuildingVisual, BUILDING_DEFINITIONS, … }`
  from MainScene — the bake drives the *exact* renderer the game uses (same
  dispatcher, same corner math), so a baked frame can never drift from what
  the game would have drawn.
- **Two passes per unit-level**, mirroring the base/elevated split:
  - `ground` (`onlyBase: true`) → the contact shadow/pad decal. Does not
    rotate; one frame. At runtime it is drawn into the ground bake, exactly
    where the vector base used to go.
  - `body` (`skipBase: true`) → the standing geometry, **one frame per aim
    angle**.
- **Angles: 16 for rotating defenses (the CoC model — critical), 1 for static
  buildings.** `ANGLES=16` bakes the body at `i·2π/16`, pinning the pose via
  the same state fields the game animates (`ballistaAngle`,
  `cannonRecoilOffset`, …, `time`). Troops will use 8 directions the same way.
- **Capture** goes through a transparent `RenderTexture` + `snapshot()` — true
  alpha, no chroma keying, no ground in frame.
- **The quantizer** is the removed shader's math, re-anchored:
  one output texel per `CELL = 1.35` world px (the shipped cell size),
  color = the **center sample** of the cell, alpha included. The only
  difference from the old shader: the grid is anchored to the **object's
  frame**, not to absolute world coordinates — which is what makes every
  cannon identical everywhere and panning rigid. Then a tight alpha-crop.
- **Outputs** → `public/assets/sprites/buildings/<type>/` and
  `public/assets/sprites/troops/<type>/`:
  - `cannon_L1_ground.png`, `cannon_L1_body_a00.png … a15.png`, …
  - `archer_L1_P_d3_walk04.png` (troop: level, owner P/E, direction, state+frame)
  - `manifest.json` per unit (schemas below)
  - review contact sheets → `tools/art-preview/shots/bake-sheet-<type>-L<k>.png`
    and `bake-sheet-troop-<type>-L1.png` (nearest-upscaled grids — the
    mandatory eyeball)

### Troop sheets — how animation frames are chosen

Troop pose is a pure function of `(time, attackAge, facingAngle, isMoving)`
(`TroopRenderer.drawTroopVisual`), so frames are **time samples**:

- **walk**: 6 frames at `time = k·stride/6` — `stride` is each troop's real
  gait period, read from its `hRig` call site and recorded in the script's
  `TROOP_PARAMS` table (warrior 420 ms, wallbreaker 260 ms, …). Sampling one
  exact period makes the sheet loop seamlessly.
- **attack**: frames sample the **windup ramp** (attackAge approaching the
  damage tick: `delay − windup·[1, .6, .3, .05]`) then the **strike decay**
  (`strike·[.15, .6]`). The manifest records each frame's `attackAge`; the
  runtime picks the frame nearest its live `time − lastAttackTime` — no fps
  math, and the anticipation still peaks exactly on the damage tick.
- **idle**: 12 exact-loop breath/ambient frames. **Directions**: troops whose draw consumes
  `facingAngle` bake 8 (`archer`, `mobilemortar`, `ram`,
  `davincitank`, `phalanx`, `romanwarrior`); symmetric troops bake 1.
  **Owners**: both `P`layer and `E`nemy palettes. Troops with externally-driven
  attack poses (`golem` slam, `phalanx` spear, `siegetower` deployment,
  `davincitank` spin) bake one attack
  frame per declared driver value; runtime selects the nearest value. The
  Da Vinci Tank's six `tankSpin01` poses cover its 200 ms post-shot bay turn,
  and the final pose is pixel-identical to the next direction's idle frame.
  The Siege Tower's eight `parked01` poses cover its full 700 ms ramp descent
  in every heading (including screen-down `d2`); the last pose is
  pixel-identical to its timeless `deactivated` frame.

### Manifest schema (as emitted)

```jsonc
{
  "cellWorldPx": 1.35,          // world px per texel — MUST equal sprite.setScale
  "angles": 16,
  "levels": {
    "1": {
      "ground": { "file": "cannon_L1_ground.png", "texelW": 37, "texelH": 19,
                   "cellWorldPx": 1.35, "originX": 0.51, "originY": 0.47,
                   "pose": { "time": 1000, "ballistaAngle": 0 } },
      "body": { "angles": 16, "frames": [
        { "file": "cannon_L1_body_a00.png", "angle": 0, "texelW": 43, "texelH": 25,
          "originX": 0.46, "originY": 0.83, "cellWorldPx": 1.35, "pose": { … } },
        …16 frames…
      ] }
    }, …
  }
}
```

`originX/originY` are `setOrigin` fractions locating the building's iso
**center** inside the cropped frame — position the sprite at
`cartToIso(gridX + w/2, gridY + h/2)`, `setOrigin(originX, originY)`,
`setScale(cellWorldPx)`, and it lands pixel-exactly where the vector art stood.

### Commit policy
Baked PNGs + manifests are **committed** (deterministic given the code +
pinned pose; committing keeps CI/dev boot free of a bake step). Regenerate
whenever the authoring code changes; the bake is idempotent.

## Stage C — runtime

- The renderer is deliberately smooth by default: live vectors, the canvas,
  and cached village postcards use antialiasing/LINEAR sampling. Every baked
  pixel texture must cross `TextureRenderPolicy.applyPixelArtManifestFrame`,
  which validates `originX/originY/cellWorldPx`, applies the manifest placement,
  and opts that texture into NEAREST sampling. Never restore global pixel-art
  mode; pixel sampling is an asset-level contract.
- One **generic sprite handler** replaces the per-unit draw functions:
  - static building → `(type, level)` → body image (+ ground decal into the
    ground bake).
  - defense → `(type, level, state, angleIdx)` where
    `angleIdx = round(simAngle / (2π/16)) mod 16`. The continuous aim slerp in
    the sim is untouched; only the *drawn* angle quantizes (CoC-style snap).
  - troop → `(type, level, state, dirIdx(8), frame)`;
    `state ∈ idle|walk|attack|death` derived from sim outputs the code already
    produces (`isMoving`, `attackAge`, `health`).
- During migration, `BuildingVisualCatalog` routes decide per unit: `'sprite'`
  or the legacy vector route — both coexist; migrate one unit at a time.
- **End state:** no live vector drawing for units at runtime ("no live SVGs");
  the authoring modules are only executed by the bake harness and can leave
  the client bundle.

## Fidelity contract (measured, cannon pilot)

The bar: *virtually indistinguishable from the old game at rest; cleaner in
motion.* The old look = vector art quantized at 1.35 world-px cells,
center-sampled. The bake performs the **identical quantization**, so what can
differ is only *grid phase* (world-anchored then vs object-anchored now) and
*motion behaviour*. Measured on the cannon pilot (headless, zoom 1):

| Metric | Result | Meaning |
|---|---|---|
| Rest: world-anchored vs object-anchored quantize, same frame | 25% of texels differ, mean ΔRGB 6.2/255 (≈2.4%) | Pure grid-phase difference on AA edges — the same magnitude of change the old shader itself produced when a building sat at a different world position. Same pitch, same character; per-texel phase differs. |
| Drag: baked sprite across a 0.6 px pan | **0% texels change** | Pixels are object-anchored; panning is a rigid translate. |
| Drag: old shader | eliminated by construction | The old artifact (per-frame framebuffer resampling through a world grid + fp16 GPU math) cannot occur — there is no runtime resampling at all. (Note: the old shimmer never reproduced in headless SwiftShader either — fp32; see the `pixelate-headless-capture` memory — so it can't be "measured" here, only removed.) |

Plus the eyeball: `bake-ab-cannon-L1.png` (in-game vector vs sprite side by
side) and the 16-angle contact sheets. **Acceptance for each migrated unit:**
the contact sheet reviewed, the in-game A/B taken, and the sprite placed via
manifest anchors lands exactly on the vector footprint.

## Coverage matrix (what gets which treatment)

| Layer | Treatment |
|---|---|
| Buildings (static) | body sprite + ground decal, 1 angle |
| Defenses (rotating) | 16-angle body sheets per level + ground decal + fire/charge states |
| Troops | 8-direction × state (idle/walk/attack/death) × frame sheets, time-sampled from the parametric rig |
| Obstacles / wrecks | static sprites (same bake, `ANGLES=1`) |
| Ground / grass, world postcards | stay vector-drawn into RenderTextures, then a **one-time quantize pass over the baked RT** (same cell math) at bake/rebake time — world-anchored phase is correct here because these layers are glued to the world; no per-frame cost |
| Projectiles / impacts / weather / particles | remain code-drawn world-space FX (optionally spritified later); splash/arc constants promoted to the registry |

## The intelligence layers (v3 — "every possible state of motion")

The tool discovers coverage instead of trusting a hand-written table:

- **State-read audit**: before baking a type, its draw fn runs once against a
  Proxy stub that records every `building.*` field it reads. Known fields
  self-heal (a `doorOpen` read auto-adds a door sweep — this caught lab and
  barracks doors nobody declared); truly novel fields print
  `COVERAGE WARNING` (this caught mortar + spike launcher consuming
  `ballistaAngle` — both are now in the 16-angle `ROTATING` set).
- **Ambient-motion discovery**: every non-wall building is probed over 8 s
  — per type+LEVEL, and since 2026-07-12 this includes the 16-angle
  `ROTATING` turrets (probed once at the default aim; the discovered loop
  then bakes at every aim angle). Changed-texel autocorrelation measures
  the true idle period, and the idle bakes as a loop at exactly that period
  (town hall banner ≈ 5.25 s, watchman 750 ms, jukebox found a perfect
  5.5 s loop with 0.00% residual; storage correctly ruled static). The
  period pick prefers the FIRST strong minimum so fast spinners (prism
  ring) keep their true short period instead of a long harmonic, and the
  frame count scales with the period — 1-angle ambients at ~18 fps capped
  at 36 frames, turrets leaner (~12 fps, cap 20) because their idle frames
  multiply by all 16 angles. Multi-rate motion (farm crops in wind) gets
  the best approximate period, `loopExact: false`. EVERY defense now ships
  an idle loop; authored idle terms must be exact harmonics of a declared
  250 ms-multiple period and survive quantization (displace ≥1.5 world px
  or swing ≥16/255 RGB over ≥1% of silhouette texels), or the probe rules
  the building static and the sprite freezes.
- **Fire/charge sequences** are baked per angle for rotating defenses
  (recoil/tension/reload/charge drivers matched to what MainScene tweens),
  and pure `f(time − lastFireTime)` types get age sweeps automatically.
- **Alpha snap**: quantized texels commit (255) or vanish (0) at the 50%
  coverage line — hard binary silhouettes, no translucent AA halo around any
  sprite (owner request: crisper, more intentional edges).
- **Vapor off**: `BuildingRenderer.AMBIENT_VAPOR = false` during bake —
  chimney/powder smoke and launch columns are a runtime effect layer, never
  body art.

## Stage C as shipped — `src/game/render/SpriteBank.ts`

The runtime loads `public/assets/sprites/index.json` → ~57 per-unit atlases
(packed by `tools/art-preview/pack-atlases.mjs`) and converts via **shadow
sprites**: every existing carrier `Graphics` (building, troop, wreck,
obstacle) stays the position/depth/lifecycle owner but stays EMPTY — a managed
`Image` keyed to it shows the baked frame. Integration is a handful of guards
at the render choke points (`drawBuildingVisuals`, `bakeBuildingToGround`,
`redrawTroop[WithMovement]`, `createRubble`, `drawObstacle`); everything else
(selection, targeting, depth, destruction) is untouched. Frame selection
mirrors the sim: aim → nearest baked angle; fire/charge → nearest baked age
for `time − lastFireTime`; troop state from `isMoving`/`attackAge`/drivers;
ambient loops replay at the measured period on global time (instances stay in
sync, exactly like the old vector animation). Kill switch:
`localStorage['clash.sprites.off'] = '1'` falls back to vectors wholesale;
any unit missing from the bank falls back per-unit.

**World-glued layers** use the same math as a one-time RT pass
(`SpriteBank.quantizeRenderTexture`): the ground bake (grass tiles, building
ground decals — re-quantized ~250 ms after any bake write) and both postcard
renderers (villages + wilderness, at `1.35 × SNAP` cells). World-anchored
grids are CORRECT here — these layers never move relative to the world, so
they pan rigidly.

**Per-frame dynamic layers** have NO snapping pass. The per-layer `PixelSnap`
PostFX pass is removed for good — never recreate it, and never add another
snapping post pass. Two tiers remain: **baked sprites** (object-anchored
texels) and the **one-time RT quantize** for world-glued layers. Layers that
still redraw as live vectors every frame — rain + splashes, fireflies/night
glow, the living cloud edge + deep bank, the between-plot road/wilderness
layer, stone lanes, village-life figures (villagers, dogs, chickens,
merchant + stall), road travellers, the war caravan, and postcard life —
render SMOOTH until their bake lands; migration step 5 below is that path
(weather and additive night glows may stay smooth by design). The in-world
overlays (selection ring, ghost, deploy zones) are intentionally smooth UI
feedback and never get a bake. The five particle
emitters already crossed over: they emit chunky NEAREST textures. Camp
figures and troop spawn frames reuse the baked TROOP sprites via
`SpriteBank.syncLooseTroop` (same frames as battle); walls carry their baked
ground decal as a second shadow (they never enter the ground bake).

Kill switches: `localStorage['clash.sprites.off'] = '1'` (vectors wholesale)
stays; `clash.pixelsnap.off` is gone with the pass; sampling is now chosen by
`clash.pixelmode` (below).

### The PixelMode sampling contract (`src/game/renderers/TextureRenderPolicy.ts`)

How baked pixel surfaces are sampled is a per-texture, runtime-switchable
contract — never a global renderer setting:

- **Modes** — `'legacy'` (LINEAR everywhere, the pre-fix baseline),
  `'nearest'` (default: every registered surface samples NEAREST), `'snap'`
  (`nearest` plus post-gesture zoom settling).
- **Selection** — `?pixelMode=` query param (persisted) >
  `localStorage['clash.pixelmode']` > default `'nearest'`.
  `window.__pixelMode('legacy'|'nearest'|'snap')` switches live, re-filtering
  registered textures without a reload.
- **`registerPixelSurface(texture)`** is the single opt-in boundary: bank
  atlases, the ground RT, postcard RTs, and chunky particle textures register
  there; the active mode's filter is applied immediately and re-applied on
  every mode switch. (`applyPixelArtManifestFrame` handles the per-frame
  anchor/scale side and routes through the same boundary.)
- **`settleLogicalZoom(logicalZoom, renderScale)`** — in `'snap'` mode the
  camera eases after each wheel/pinch gesture to the nearest zoom where one
  baked texel (`BAKE_CELL_WORLD_PX = 1.35` world px) covers a whole number of
  backing pixels, keeping texel columns even.
- **The rule:** never restore global pixel-art mode (`pixelArt` /
  `roundPixels`), and never add a snapping post pass — crispness comes from
  per-texture sampling of baked assets only.

## Migration order (each step shippable)

0. ✅ Remove the runtime pixelation filter.
1. ✅ Pipeline + cannon pilot (quantizer, 16-angle sweep, fidelity metrics).
2. ✅ Full roster baked.
3. ✅ **v3 completeness**: per-angle fire sequences, tesla charge, fill
   stages, doors, jukebox, ambient-loop discovery,
   state-read audit, vapor off, troop breath loops, golem/phalanx driver
   attacks, tank deactivated pose, wrecks, obstacles (16 hash-bucket
   variants + sway loops), alpha snap. The historical v3 snapshot was 9,676
   frames across 57 manifests (19 buildings, 14 troops, 19 wrecks,
   5 obstacles); later roster gates supersede those counts.
4. ✅ **Runtime conversion live**: SpriteBank + shadow-sprite integration for
   buildings (including walls via topology tags), troops, wrecks,
   obstacles; ground-RT + postcard-RT quantize passes. Verified headful in
   the village and a practice raid, zero page errors.
5. ✅ **Figures + projectiles baked (2026-07-12).** Three new kinds:
   `villagers/` (villager 60 identity variants × full state set, dog,
   chicken, birds, dragon 16-heading silhouette, merchant, stall, thief,
   owl — 2,124 frames), `figures/` (8 traveller kinds walk+camp, caravan
   soldier × 14 troop palettes, postcard fish — 144 frames), `projectiles/`
   (10 rigid projectiles × 16 rotation variants × material levels — 326
   frames; runtime picks the nearest baked angle instead of rotating).
   Bake plan lives in `bake-sprites.mjs` `FIGURE_UNITS` (`FIGURES=1`);
   figures bake at final world scale, anchor (0,0), flip-X at runtime;
   translucent silhouettes bake opaque (alpha restored on the carrier).
   Runtime: `SpriteBank.syncFigure` at every single-figure call site.
   Still open in this bucket: per-figure carriers for the caravan column +
   postcard life (their frames are baked; both draw into one shared
   Graphics today), the between-plot gap layer (chunked RT quantize),
   cloud puffs as sprites, impact/patina/burning FX (the "smoke bucket"),
   battle-preview figures, flag cloth (procedural heraldry stays vector). This step
   covers most — not all — of the layers that render smooth since the snap
   pass was removed: rain/splashes stay runtime FX per the coverage matrix,
   night glows and the interaction overlays stay smooth by design.
6. Delete migrated vector bodies from the client bundle; keep them as
   bake-only authoring modules. Bump `RENDER_VERSION`s +
   `BOT_WORLD_GENERATION_VERSION` when postcard content changes.

### Canonical roster gate (2026-07-18)

The committed normal bank is exactly **33,443 frames / 94 manifests**:

- 7,913 building frames across 19 manifests
- 21,168 troop frames across 20 manifests
- 72 wreck frames across 19 manifests
- 872 obstacle frames across 5 manifests
- 2,924 villager frames across 11 manifests
- 168 figure frames across 10 manifests (80 caravan soldiers + 80 road
  travellers + 8 postcard fish)
- 326 projectile frames across 10 manifests

Goblin Plunderer A, Clockwork Beetle B, Healer/Physician's Cart B, Siege Tower
C, Necromancer B, Skeleton C, Trebuchet B, War Elephant A and Ornithopter A
are canonical plain-unit bakes. Quartermaster, Frostfall, the Biopunk faction
and Barracks, Needleback, Razorwing Harpy, Vat Brute, Apex Chimera, Rift Djinn,
Spore Lobber, and Mantis Stalker are fully removed. A separately counted death
bank contributes 3,888 frames across six canonical large-troop manifests. The
strict full gate is **37,331 frames / 100 manifests**. The regression pins
counts and presence/absence rules.

## Keep, don't touch
`TextureRenderPolicy`'s per-asset sampling boundary · `IsoUtils` · `DepthSystem` · the registries &
`getBuildingStats`/`getTroopStats` · `DefenseSystem`/`DefenseBehaviorCatalog`
seam · `TargetingSystem`/`CombatNavigationSystem` · the server · the RT-bake +
LOD/residency world-map architecture.

## Design variants (tournament infrastructure)

Clean-room design tournaments (multiple competing redesigns of one unit) are
first-class in both halves of the pipeline. Everything keys off ONE
localStorage key per unit — `clash.design.<unit>` — so the baked sprites, the
vector fallback, and the Settings dev tool can never disagree.

**The `@slot` asset convention.** A design variant is a FULL standalone unit
bake living in a sibling dir named `<unit>@<slot>`:
`public/assets/sprites/troops/exampleunit@A/`, `exampleunit@B/`, … — each with
its own frames, `manifest.json`, and packed atlas. `pack-atlases.mjs` and the
render-quality regression walk them as ordinary units (nothing special about
`@` in a dir name). At runtime `SpriteBank.resolveVariantUnit(kind, unit)` is
the single resolution point: when variant atlases exist for a unit, the plain
name (`'exampleunit'`) transparently resolves to the active slot
(`'exampleunit@A'`) — the stored slot when baked, else the judged default,
else `A`, else the first baked
slot. Every bank lookup routes through it (`unitOf`/`backed` are the only
doors), so no call site knows variants exist. Units with no `@` dirs resolve
to themselves. During an unresolved tournament the untagged unit dir is
retired; final promotion restores the winner under the plain unit name and
deletes the resolved `@slot` dirs.

**Adding a future variant (the whole checklist):**

1. **Register the vector draw** in
   `src/game/renderers/redesign/DesignRegistry.ts` (import anchor + slot
   anchor; extend `DesignUnit`/`DESIGN_SLOTS` for a brand-new unit and give
   the unit's renderer the standard `activeDesign(...)` stub delegator).
2. **Bake the slot**: `DESIGN=<slot> UNITS=<unit> node bake-sprites.mjs`
   (buildings) or `DESIGN=<slot> TROOPS=<unit> node bake-sprites.mjs`
   (troops), then `node pack-atlases.mjs`. `DESIGN` seeds
   `clash.design.<unit>=<slot>` (and `clash.sprites.off`) before game boot so
   every pass — state audit, ambient probe, capture — bakes that design, and
   writes output to `<unit>@<slot>`. Explicit unit lists only, never `all`.
3. **It appears in the Design Lab automatically**: the dev-only DESIGN LAB
   section of the Settings modal renders purely from
   `DesignRegistry.listVariantUnits()` — zero hardcoded names.

**The switch event contract.** `setActiveSlot(unit, slot)` writes
`localStorage['clash.design.<unit>']` and dispatches the window event
`'clash:design-changed'` with `detail: { unit }` (`DESIGN_CHANGED_EVENT`).
MainScene listens: it busts the draw cache of every placed building of that
unit and re-stamps its ground decal (unbake → rebake, since designs ship
their own pads); troops and camp figures re-pick frames on their own
per-frame draws. `SpriteBank.resolveVariantUnit` and the vector
`activeDesign` both re-read the key per call, so the switch is visually
instant — no reload, no ghosts. Anything that caches drawn unit art and
doesn't already repaint per frame must listen for the same event.
