# clash-game — agent notes

Isometric base-builder (Clash of Clans-like). React + Phaser 3 client, Node
game server in `server/` (device-token auth, atomic JSON saves, instant
replays). Building/troop art is authored as hand-drawn vector code and baked
into committed pixel-art sprite sheets (see the rework below).

## Read before working

- **Any building/art/visual work:** `docs/BUILDING_ART_GUIDE.md` — REQUIRED.
  It encodes the owner's calibrated taste and the iso-rendering math; art that
  ignores it gets rejected. Verify visually with `tools/art-preview/`
  screenshots before calling anything done.
- Layering/depth bugs: `docs/RENDERING_AND_DEPTH.md`
- New building wiring: `docs/ADDING_BUILDINGS.md` · troops: `docs/ADDING_TROOPS.md`
- **Creating/redesigning ANY unit's art:** `docs/DESIGN_TOURNAMENTS.md` — the
  clean-room variant process (ALWAYS ask the owner how many design variations
  first; saved workflow `design-tournament`).
- Code map: `docs/ARCHITECTURE.md` · scene internals: `src/game/scenes/MainScene_Organization.md`

## Domain guides (how to do X)

Directory-level `AGENTS.md` files map each subsystem and give ordered
touch-point checklists — read the one for the area you're editing:

- **Add/edit a building, troop, or defense (the data):** `src/game/config/AGENTS.md`
- **How an entity is drawn (art + visual dispatch):** `src/game/renderers/AGENTS.md`
- **Combat, targeting, world map, world generation, day/night, weather:**
  `src/game/systems/AGENTS.md`
- **Server authority, API, saves:** `server/AGENTS.md`
- **Why the art (not the data) is the scaling wall:** `docs/MODULARITY_ASSESSMENT.md`
- **The sprite-asset rework + asset-creation pipeline:** `docs/AGENTS_SPRITE_PIPELINE.md`

`CLAUDE.md` is a byte-for-byte mirror of this file — keep them in sync.

## In-flight rework (2026-07)

A major art rework is underway: the runtime pixelation shader is being
replaced by **baked pixel-art assets** — buildings become static sprites,
defenses and troops become sprite sheets (one frame per angle + animation).

- **DONE — the runtime `Pixelate` post-FX filter is removed** (it lived on the
  MainScene camera). `GameConfig` renders smooth: `antialias:true` /
  `antialiasGL:true` / `pixelArt:false` / `roundPixels:false`; baked pixel
  textures opt into NEAREST per-texture via `TextureRenderPolicy`
  (`registerPixelSurface`). The tuning slider (AccountModal) and debug toggle
  went with it.
- **DONE — the bake pipeline exists and the FULL ROSTER is baked** (9,676
  frames across 57 manifests, enforced by
  `scripts/render-quality-regression.mjs`): every non-generic building ×
  every level (turrets at **16 aim angles**, CoC-style; walls × 16 neighbor
  topologies), every troop × 3 levels × both owner palettes × 8/1
  directions × idle/walk/attack frames, plus wrecks and obstacles. Vector
  code stays the authoring source; `tools/art-preview/bake-sprites.mjs`
  (via `src/game/dev/BakeBridge.ts`) quantizes it into committed frames
  under `public/assets/sprites/` (`buildings/<type>/`, `troops/<type>/`,
  `wrecks/<type>/`, `obstacles/<type>/`, each with a `manifest.json`).
- **DONE — the runtime conversion is LIVE** (`src/game/render/SpriteBank.ts`):
  buildings (walls included), troops, wrecks and obstacles render from
  baked atlases via shadow sprites; the ground bake and neighbour postcards
  get a one-time RT quantize. Frame selection mirrors the sim (aim → nearest
  of 16 angles, fire/charge by `time − lastFireTime`, troop state/direction/
  stride, measured ambient loops). Kill switch:
  `localStorage['clash.sprites.off']='1'`. The bake is now INTELLIGENT: a
  Proxy state-read audit self-heals coverage (caught mortar/spike aiming +
  lab/barracks doors), ambient motion is discovered by autocorrelation, and
  alpha-snapping keeps silhouettes hard.
- **REMOVED — the per-layer `PixelSnap` post pass** (never recreate it, or
  any other snapping pass). Crispness is the **PixelMode sampling contract**
  (`src/game/renderers/TextureRenderPolicy.ts`): modes `legacy`/`nearest`/
  `snap` selected by `?pixelMode=` > `localStorage['clash.pixelmode']` >
  default `nearest` (live handle `window.__pixelMode`);
  `registerPixelSurface` is the single NEAREST opt-in boundary;
  `settleLogicalZoom` gives pixel-perfect zoom in `snap` mode. Particle
  emitters now emit chunky NEAREST textures.
- **DONE — the figure + projectile bake (2026-07-12)**: three new sprite
  kinds join the bank. `villagers/` (11 units, 2,124 frames): villagers
  (5 palettes × 2 styles × 4 roles + elder/child, every state — walk, work,
  panic, cheer, sleep, lantern, rock/pack carries), dogs, chickens, all
  birds, the dragon shadow (16 headings), merchant, stall, thief, owl.
  `figures/` (10 units): the 8 road-traveller kinds (walk + camp), caravan
  soldiers (one palette per troop, refreshed by the 2026-07-16 figures
  re-bake after the roster change; two are stale since the
  pavisebearer/hawkeyeassassin deletion, pruned on the next figures
  bake — a missing variant falls back to the vector column), the
  postcard fish. `projectiles/`
  (originally 10 units, 326 frames; now 11 units / 374 frames —
  trebuchet_stone + ornithopter_bomb joined, musket_ball removed):
  every RIGID projectile at 16 rotation variants ×
  material levels (arrow, bolts, shells, cannonball, crystal, rocket, spike
  ball) — runtime picks the nearest baked angle, never rotates the sprite.
  Wiring: `SpriteBank.syncFigure`/`pickFigureFrame` (variant + state +
  caller-computed phase); call sites in VillageLifeSystem (drawEntity,
  merchant, stall, thief, owl), NeighborLifeSim, WorldMapSystem travellers,
  MainScene projectiles. Figures bake at final world scale, anchor (0,0),
  flip-X at runtime; translucent silhouettes (owl/dragon) bake OPAQUE and
  get alpha restored on the carrier (the 50% alpha snap would erase them).
- **DONE — total pixel coverage (2026-07-12, full-code sweep):** NOTHING
  visible draws anti-aliased anymore. `src/game/render/PixelDraw.ts`
  (pixelEllipse/pixelLine/pixelRect/pixelBitmap/pixelBlob — whole
  1.35-px cells, world-anchored for static layers, carrier-anchored for
  overlay art; clouds use a 7.5× cell, battle-transition clouds PX 4.5,
  cloud rows tuck at 2-tile corner wraps with shadow tones blended to the
  neighbour layer's body) now renders: the between-plot roads
  and all roadside props, BOTH cloud layers (`WorldMapSystem.puff`),
  every MainScene combat effect (explosions, lightning, beams, rings via
  the `pixelRing` helper, muzzle/impact/debris), rain + splashes +
  puddles (pixelBlob), fireflies/moths/festival glow, the hydrology
  water layer (`WorldHydrologyRenderer` internals — live layer AND
  postcard RTs), road junctions, battle markers, flag cloth (waving
  pixel columns, heraldry intact), postcard life, speech bubbles +
  emotes (hand-authored `pixelBitmap`), and all micro-props
  (eggs/feed/festival rig/scaffolds/scars/wolf eyes). Smooth
  `add.circle` sparkles became chunky `particle_circle`/`particle_square`
  images. The stone lanes present through a pixel-quantized RT on the
  ground-RT grid (`VillageLifeSystem.presentStonePaths`); the caravan
  escorts ride per-figure baked sprite carriers. WALL LOAD-ORDER FIX:
  the bank emits `spritebank:ready` and MainScene busts every building's
  draw cache once — walls paint once and would otherwise stay stuck on
  the vector fallback forever. Allowed non-pixel survivors: flat solid
  fills whose edges are owned by pixel elements, full-screen tints,
  radial-gradient light images, and DOM UI. **Never draw an AA
  ellipse/line/circle on a live layer — use PixelDraw**; the
  render-quality regression fails on regressions.
- **DONE — motion cadence + dense ambients (2026-07-12):** ambient/idle
  loops bake DENSE for smoothness (building ambients ≈18 fps up to 36
  frames, troop idle breath 12 frames, tree/grass sway 20 frames — roster
  now 15,681 frames / ~76 MB), while FIGURE MOTION is deliberately steppy:
  `PixelDraw.FIGURE_ANIM_HZ = 24` is the ONE figure clock — home villagers/
  animals/merchant/camp figures/thief (`lastPlaceTick`/`lastDrawTick`
  gates), road travellers, AND near neighbor villages (`hz = FIGURE_ANIM_HZ`
  in the LOD line) all step position + animation on the same 24 Hz tick
  (2× the old neighbor rate — owner's sweet spot), and every figure stamp
  snaps to the texel grid in `SpriteBank.syncFigure`. Subtle ambients =
  smooth; walking figures = a touch jagged, in step across every village.
- **DONE — every defense idles (2026-07-12):** the bake's ambient probe now
  runs per type+LEVEL for ALL non-wall buildings — including the 16-angle
  `ROTATING` turrets, which bake a leaner per-angle idle loop (~12 fps, cap
  20 frames; 1-angle ambients keep 18 fps/36). All six previously-frozen
  defenses got authored idle loops on exact probe-measurable periods
  (harmonics of the declared P, all residual 0.00%): cannon breech ember +
  ring glint + retimed L4 pennant (1750 ms), ballista skein breathing +
  ratchet notch + glints (1500 ms), xbow crank-reels retuned to an exact
  90°-per-P repeat + magazine glint chase (1500 ms), mortar bore shell +
  fuse ember + rim glint (1750 ms), spike launcher breathing loader +
  4-site spike-tip glint gated off during combat (2000 ms), dragons_breath
  vein surge + fuse sputter + L2 head breath (2000 ms). Roster at that
  point: 23,788 frames / 84 manifests after the 2026-07 troop deletion
  (ward/recursion/giant/sharpshooter + musket_ball removed; counts since
  superseded — see the troop-overhaul bullet below). Harness upgrades: `shoot-defenses.mjs` gained
  `VECTOR=1` (sprites-off authoring shots), `ONLY=<types>`, `BURST=<n>`/
  `BURST_MS` (idle-motion series); both harnesses resume ONE shared
  identity from `tools/art-preview/.shared-device-token.json` (guest
  creation is rate-limited 30/hour and junks the world map — never call
  `/api/auth/session` per run) and `bake-sprites.mjs` falls back to :5173
  when :8788 is down. Idle terms in draw fns must be exact harmonics of a
  250 ms-multiple period and survive quantization (≥1.5 world px or
  ≥16/255 RGB over ≥1% of texels — see the probe thresholds).
- **DONE — the troop overhaul + design tournaments (2026-07-16):** the
  trainable roster is **19 troops** (`PLAYER_TROOP_TYPES` in
  `src/game/config/definitions/TroopDefinitions.ts` — that tuple IS the
  unlock and display order; consumers must not restate it). 9 new units
  joined: goblinplunderer, clockworkbeetle, physicianscart,
  quartermaster, siegetower, necromancer (whose skeleton summons are
  generated-only, like phalanx's romanwarrior), trebuchet,
  warelephant, ornithopter; ward/recursion/giant/sharpshooter were DELETED
  end-to-end (with their musket_ball projectile — saves/replays
  self-clean), and pavisebearer + hawkeyeassassin were DELETED the same
  way on 2026-07-16 (owner disliked the redirect/stealth mechanics —
  kits, variants, icons and baked dirs all removed; saves/replays
  self-clean, a stale L11 barracks clamps to 10 on read). TWO troops
  unlock per barracks level
  (`getTroopUnlockLevel` = `floor(index/2)+1`; barracks maxLevel 10).
  Client kits + server settlement shipped under ONE
  `ATTACK_SIMULATION_VERSION` **3→4** bump (v3 replays preserved
  verbatim). Tournament state: every tournament unit is baked AND
  live-switchable in the Design Lab — frostfall@A/B/C building slots plus
  30 troop variant dirs (10 units × @A/@B/@C incl. skeleton) — with
  judge-panel defaults live in
  `DEFAULT_DESIGN_SLOTS` (`src/game/renderers/redesign/DesignRegistry.ts`;
  clockworkbeetle's verdict still in flight) and per-slot authored periods
  baked via the `PARAMS` export (docs/DESIGN_TOURNAMENTS.md). AWAITING THE
  OWNER: the frostfall A/B/C pick and per-troop winner confirmation vs the
  judge defaults — never promote winners or delete variant dirs before
  those picks (docs/TROOP_OVERHAUL_HANDOFF.md tracks the remainder).
  Roster now **51,129 frames / 118 manifests** (~71 MB loose frames +
  ~29 MB packed atlases; `scripts/render-quality-regression.mjs` enforces
  the exact counts).
- The vector draw functions remain in the bundle as the AUTHORING source and
  per-unit fallback. Iron rules still govern them — they are what gets baked.
  See `docs/AGENTS_SPRITE_PIPELINE.md` for the full architecture and the
  remaining follow-ups (per-figure carriers for caravan/postcard life,
  projectile impact FX, flag-cloth treatment).

## Iron rules

1. **Never ship art you haven't screenshotted** (`tools/art-preview/`, needs
   `npm run dev` running). Typechecking is not seeing.
2. Renderers keep the base/elevated split (`skipBase` / `onlyBase`) — ground
   paint bakes into the ground texture; breaking the split breaks layering.
3. All ambient animation is a deterministic function of `time` — never
   `Math.random()` per frame.
4. No ground plates under buildings — contact shadow + compact pad/patch only
   (the CoC grounding model, see the art guide §4).
5. Max-level styling = warm sandstone + gold/white as subtle ACCENTS, never
   large white masses.
6. Full-screen overlays draw in world space over `cam.worldView` per frame —
   `setScrollFactor(0)` rects get scaled by camera zoom (known bug class).

## Parallel sessions

Multiple agents often work in this repo simultaneously. Anchor edits on exact
unique strings (not line numbers), never revert code you didn't write, and if
`tsc` shows errors in files you haven't touched, assume the other session is
mid-edit and ignore those (filter, don't fix). If the dev server serves stale
art after your edit, it's usually another session's broken mid-edit module —
reload before debugging yourself.

## Commands

- `npm run dev` — client + game server on :5173 (server mounts as a Vite plugin)
- `npm run test:server` — HTTP integration suite for `server/`
- `npx tsc --noEmit -p tsconfig.app.json` — typecheck the client
- `cd tools/art-preview && node shoot-defenses.mjs` — screenshot all showcase
  buildings (env: `ANGLE`, `TENSION`, `RECOIL`, `TAG`, `PHASE=0.8` for night)

## Server authority split

Client owns the base layout and pushes it on edit; server owns balances,
trophies, attack outcomes, replays. Loot capped server-side (20% of defender
balance at attack start). Old saves self-clean: the server drops unknown
building types, so deleting a building type is safe.
