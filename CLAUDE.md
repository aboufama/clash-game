# clash-game — agent notes

Isometric base-builder (Clash of Clans-like). React + Phaser 3 client, Node
game server in `server/` (device-token auth, atomic JSON saves, instant
replays). Building/troop art is authored as hand-drawn vector code and baked
into committed pixel-art sprite sheets (see the rework below).

## Graphify FIRST — do not waste context

PRIORITY, every session: this repo has a queryable knowledge graph
(`graphify-out/graph.json`, committed). Before grepping or reading files to
answer ANY structural question ("what calls X", "how does Y relate to Z",
"where does concept W live"), query the graph — it is faster and burns far
less context:

- `/graphify` skill in Claude Code, or the CLI directly:
  `graphify query "<question>"` · `graphify explain "X"` ·
  `graphify path "A" "B"` · `graphify affected "X"`
- If graphify is NOT installed on this machine:
  `uv tool install graphifyy && graphify install` (30 seconds).
- After meaningful code changes, refresh with `graphify update .`
  (deterministic AST pass, no LLM; the cache under `graphify-out/cache/` is
  local-only and gitignored — `graph.json` is committed for everyone).

## Read before working

- **Any building/art/visual work:** `src/game/renderers/BUILDING_ART_GUIDE.md` — REQUIRED.
  It encodes the owner's calibrated taste and the iso-rendering math; art that
  ignores it gets rejected. Verify visually with `tools/art-preview/`
  screenshots before calling anything done.
- Layering/depth bugs: `src/game/renderers/RENDERING_AND_DEPTH.md`
- New building wiring: `src/game/config/ADDING_BUILDINGS.md` · troops: `src/game/config/ADDING_TROOPS.md`
- **Creating/redesigning ANY unit's art:** `src/game/renderers/redesign/DESIGN_TOURNAMENTS.md` — the
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
- **The sprite-asset rework + asset-creation pipeline:** `tools/art-preview/AGENTS_SPRITE_PIPELINE.md`

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
  kinds join the bank. `villagers/` (11 units, 2,924 frames): villagers
  (5 palettes × 2 styles × 4 roles + elder/child, every state — walk, work,
  panic, cheer, sleep, lantern, rock/pack carries), dogs, chickens, all
  birds, the dragon shadow (16 headings), merchant, stall, thief, owl.
  `figures/` (10 units, 168 frames): the 8 road-traveller kinds (80 frames),
  caravan soldiers for the 20 live/generated troop types in `TROOP_PARAMS`
  (including romanwarrior/skeleton), refreshed after the two-path roster
  collapse (80 frames), and the postcard fish (8 frames). `projectiles/` (10 units / 326
  frames — trebuchet_stone + ornithopter_bomb joined; musket_ball and
  frostfall_shard were removed):
  every RIGID projectile at 16 rotation variants ×
  material levels (arrow, bolts, shells, cannonball, rocket, spike ball,
  trebuchet stone, bomb) — runtime picks the nearest baked angle, never
  rotates the sprite.
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
- **DONE — the prior troop overhaul + resolved design tournaments
  (2026-07-18):** canonical winners remain Goblin Plunderer **A**, Clockwork
  Beetle **B**, Physician's Cart **B**, Siege Tower **C**, Necromancer **B**,
  Skeleton **C**, Trebuchet **B**, War Elephant **A**, and Ornithopter **A**.
  Quartermaster and Frostfall were removed end-to-end; the earlier
  ward/recursion/giant/sharpshooter, pavisebearer/hawkeyeassassin and
  musket_ball deletions remain self-cleaning for old saves/replays. The
  packed normal bank is now exactly **33,483 frames / 94 manifests** (after
  the promoted 'Foundry Bastion' barracks rebake, +36 frames, and the mortar
  wreck redesign, +4). The death bank contributes another 3,888 frames /
  6 manifests, bringing the strict full gate to **37,371 / 100**.
- **DONE — Army Camp Core + two troop paths (2026-07-18):** the trainable
  roster is **18 troops**. Core unlocks from the highest completed online Army
  Camp: `warrior` (displayed as Barbarian) L1, `archer` L2,
  `physicianscart` (displayed as Healer) L3, and `phalanx` L4. Two independent
  seven-level paths are owned by `TROOP_TECH_TREES`: `mystic` =
  goblinplunderer, wallbreaker, stormmage, necromancer, warelephant, golem,
  icegolem; `mechanica` = clockworkbeetle, ram, mobilemortar, siegetower,
  trebuchet, ornithopter, davincitank. Mystic uses `mystic_barracks` and
  Mechanica retains `barracks`; L1-L7 unlock troops and L8-L9 are Mastery.
  Biopunk and `biopunk_barracks` were purged together with needleback,
  razorwing, vatbrute, apexchimera, riftdjinn, sporelobber, and mantisstalker;
  old saves/replays self-clean unknown ids. Goblin Plunderer and War Elephant
  moved to Mystic, Stone Golem returned to live training, and Battering Ram
  moved to Mechanica. `romanwarrior` and `skeleton` remain generated-only.
  The removed A/B/C and Rift design rounds, candidate deaths, icons, visual
  routes, and packed assets are gone; exact portraits remain for all 20
  live/generated troop manifests. Authoritative settlement is now
  `ATTACK_SIMULATION_VERSION` **8**: each Siege Tower's recorded deploy point
  rays directly to the nearest Town Hall and receives pathing credit only when
  that ray meets a wall (stored v7 keeps its closed-loop gate; v4-v6 keep the
  old unconditional credit), while the Clockwork Beetle keeps its 125 ms live
  fuse (stored v5 keeps 1,000 ms). See
  `src/game/config/TROOP_FACTION_ARCHITECTURE.md`.
- **DONE — persistent procedural bot villages (2026-07-19):** bot layouts are
  never synthesized by a client or reconstructed at attack start. The
  server-only generator (`server/domain/world/procedural-village.ts`, v2
  2026-07-19) rolls CoC-style wall COMPLEXES per seed — 1–3 rectangular
  loops sized from the band's wants-inside footprint, curtain-wall runs
  that usually CLOSE the circuit (1-2, 2-3, 3-1, or a DOUBLE run between a
  facing pair) so the interstitial ground becomes a walled ward that baits
  attackers (owner: like real castles; MOST heavy bases must follow this
  format — spec-enforced >=55/100 on fortress/extreme), an occasional full
  concentric enceinte (outer ring wrapping the keep), single tree links
  kept for light bands, full internal dividing walls
  (sealed cells) at high bands, ONE cohort wall level per base (v3 wall-level
  enforcer: walls upgrade as a cohort in this game, so bot walls all match
  world.wallLevel) — then derives
  compartments by flood fill and sites defenses by marginal range coverage
  (real `range`/`minRange`, mortar blind spots respected), storages as
  guarded shields, and the economy/military skirt hugging the walls outside,
  spread by angle. NO symmetry — deliberately. Bands scale topology +
  placement discipline (established sloppy/small, extreme tight/subdivided)
  across established/strong/elite/fortress/extreme; only 8% are the
  lowest band. A version bump regenerates persisted camps in place
  (`ensurePersistedBotVillage`). Provisioning commits the complete village to `bot_villages`
  (PostgreSQL migration 13) or `bot-villages/` (legacy JSON) before map/attack
  consumers can see it. Player claims hide rather than erase the durable bot;
  it resurfaces with the same ID/revision when the plot is released. Map
  postcards are server snapshots, attacks pin persisted provenance, and bot
  loot debits the stored village with CAS/crash-journal protection.
- The vector draw functions remain in the bundle as the AUTHORING source and
  per-unit fallback. Iron rules still govern them — they are what gets baked.
  See `tools/art-preview/AGENTS_SPRITE_PIPELINE.md` for the full architecture and the
  remaining follow-ups (per-figure carriers for caravan/postcard life,
  projectile impact FX, flag-cloth treatment).

## Iron rules

1. **Never ship art you haven't screenshotted POST-BAKE** — judge the baked
   pixel frames, never the raw vector drawing (owner hard rule 2026-07-19:
   quantization changes how art reads; scratch-bake with `DESIGN=`/`UNITS=`/
   `OUT=` for pre-approval work). Screenshot via (`tools/art-preview/`, needs
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
