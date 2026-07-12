# clash-game — agent notes

Isometric base-builder (Clash of Clans-like). React + Phaser 3 client, Node
game server in `server/` (device-token auth, atomic JSON saves, instant
replays). All building art is hand-drawn vector graphics — no sprite sheets.

## Read before working

- **Any building/art/visual work:** `docs/BUILDING_ART_GUIDE.md` — REQUIRED.
  It encodes the owner's calibrated taste and the iso-rendering math; art that
  ignores it gets rejected. Verify visually with `tools/art-preview/`
  screenshots before calling anything done.
- Layering/depth bugs: `docs/RENDERING_AND_DEPTH.md`
- New building wiring: `docs/ADDING_BUILDINGS.md` · troops: `docs/ADDING_TROOPS.md`
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
  MainScene camera). `GameConfig` still sets `pixelArt:true` / `antialias:false`
  / `roundPixels:true`, so every texture still samples NEAREST; art now renders
  at native vector fidelity with no runtime snap-to-cell. The tuning slider
  (AccountModal) and debug toggle went with it.
- **DONE — the bake pipeline exists and the FULL ROSTER is baked** (4,608
  frames, ~21 MB): every non-generic building × every level (turrets at
  **16 aim angles**, CoC-style; walls × 16 neighbor topologies) and every
  troop × 3 levels × both owner palettes × 8/1 directions ×
  idle/walk/attack frames. Vector code stays the authoring source;
  `tools/art-preview/bake-sprites.mjs` (via `src/game/dev/BakeBridge.ts`)
  quantizes it into committed frames under `public/assets/sprites/`
  (`buildings/<type>/`, `troops/<type>/`, each with a `manifest.json`).
- **DONE — the runtime conversion is LIVE** (`src/game/render/SpriteBank.ts`):
  buildings (walls/gates included), troops, wrecks and obstacles render from
  baked atlases via shadow sprites; the ground bake and neighbour postcards
  get a one-time RT quantize. Frame selection mirrors the sim (aim → nearest
  of 16 angles, fire/charge by `time − lastFireTime`, troop state/direction/
  stride, measured ambient loops). Kill switch:
  `localStorage['clash.sprites.off']='1'`. The bake is now INTELLIGENT: a
  Proxy state-read audit self-heals coverage (caught mortar/spike aiming +
  lab/barracks doors), ambient motion is discovered by autocorrelation, and
  alpha-snapping keeps silhouettes hard.
- **DONE — the third tier covers every per-frame layer**
  (`src/game/render/PixelSnap.ts`): rain/splashes, fireflies, clouds (bank +
  living edge), the between-plot road layer, stone lanes, village-life
  figures, travellers, the war caravan, postcard life, particles, and the
  in-world overlays all run the old shader's math as a per-LAYER post pass
  (kill switch `clash.pixelsnap.off`). Camp figures + troop spawns reuse the
  baked troop sprites; walls carry their baked ground decal as a second
  shadow. Three tiers total: baked sprites (units) · one-time RT quantize
  (ground, postcards) · per-layer snap (dynamic FX/life).
- The vector draw functions remain in the bundle as the AUTHORING source and
  per-unit fallback. Iron rules still govern them — they are what gets baked.
  See `docs/AGENTS_SPRITE_PIPELINE.md` for the full architecture and the
  remaining follow-ups (true villager bake, projectile sprite sheets).

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
