# Design tournaments — the clean-room asset creation process

The owner's standard process for creating or redesigning any visual unit
(building, troop, obstacle, wreck). **When the owner asks for a new or redone
unit, FIRST ask how many design variations they want** (default: 3), then run
this process. It is implemented as the saved workflow
`.claude/workflows/design-tournament.js` (invoke by name with args).

## Why clean-room

Multiple isolated designers with no knowledge of the previous art — and no
knowledge of each other — naturally diverge, giving the owner real options
instead of three shades of the same idea. Isolation is enforced, not asked
for.

## The process

1. **Prep agent** (one, runs first):
   - Extracts a **technical contract** per unit: draw signature(s), dispatcher
     wiring, registry stats, sim state fields the art must read (aim angle,
     fire timing, facing, ability fields), projectile-origin coupling, iso and
     grounding basics, ambient-period rules, required reading list.
     **The contract contains ZERO visual information** — no colors, shapes,
     motifs, or pose descriptions.
   - **Redesign mode:** stubs the old draw function bodies (delegator +
     neutral placeholder) so artists physically cannot see the old art.
   - **New-unit mode:** wires the data half first (type union, definitions
     registry, visual catalog + dispatcher route, behavior catalog if a
     defense, `GameTypes` state fields) with a placeholder, per
     `docs/ADDING_BUILDINGS.md` / `ADDING_TROOPS.md`.
   - Ensures a slot per variant exists in
     `src/game/renderers/redesign/DesignRegistry.ts` (unique
     `// IMPORT <unit> <slot>` and `// SLOT <unit> <slot>` anchors).

2. **N isolated artist agents** (parallel, one per variant):
   - FORBIDDEN: git history of renderer files/sprites, the unit's dirs under
     `public/assets/sprites/`, `tools/art-preview/shots/`, and every other
     designer's file in `redesign/`.
   - Required reading: `docs/BUILDING_ART_GUIDE.md` (whole),
     `docs/AGENTS_SPRITE_PIPELINE.md` ambient rules, the relevant ADDING doc.
   - Each writes ONE new file (`redesign/<Unit><Slot>.ts`) + fills exactly
     their two registry anchor lines.
   - Iron rules apply (deterministic f(time), 250ms-multiple ambient periods
     that survive quantization, base/elevated split, contact-shadow
     grounding, max-level gold-as-accent).
   - Must screenshot-iterate live (own headless page, shared token
     `tools/art-preview/.shared-device-token.json`, never guest sessions),
     with `localStorage['clash.sprites.off']='1'` +
     `localStorage['clash.design.<unit>']='<slot>'`: every level, day AND
     night, idle-motion series, fire/attack sequences, and for
     direction-aware units 8+ headings. Curate 4–6 labeled finals.

3. **Showcase artifact** for the owner: one card per design (concept
   statement, animation notes, screenshots, live-preview keys). The owner
   picks winners or mixes.

4. **Bake all variants** under the `@slot` convention
   (`public/assets/sprites/<kind>/<unit>@<slot>/`): the bake pipeline's
   `DESIGN=<slot>` env seeds the design key into the bake page; delete the
   old plain unit dir on retirement; orphan-sweep, `pack-atlases.mjs`, update
   `scripts/render-quality-regression.mjs` exact counts.

5. **Design Lab** (Settings → dev-only section) switches variants live via
   `setActiveSlot(unit, slot)` → `clash:design-changed` → cache-bust +
   re-stamp. SpriteBank resolves every unit through
   `resolveVariantUnit(...)` so 'cannon' transparently means
   `cannon@<active>`. Judged defaults live in `DEFAULT_DESIGN_SLOTS`
   (DesignRegistry) — the vector dispatch and SpriteBank's variant resolver
   both read that ONE map, so the two paths can never disagree. Winner
   promotion = change the unit's entry there; losers can be deleted later
   without touching call sites.

## Per-slot bake params — the `PARAMS` export

`TROOP_PARAMS` (in `tools/art-preview/bake-sprites.mjs`) is per-UNIT, but
design slots legitimately author different periods (pavisebearer B walks a
600 ms stride where the table pins 500; clockworkbeetle B's arming overwind
covers the whole 500 ms cycle where the table pins windup 240). Baking a slot
with the unit table's values mis-samples its loops — the classic stride bug.

A design file may therefore export a module-level **`PARAMS`** constant, keyed
by unit (so paired units like necromancer + skeleton each get their own row in
their shared file), listing ONLY the values that differ from the table:

```ts
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    clockworkbeetle: { windup: 500, idleMs: 2000 },
};
```

Fields: `stride` / `delay` / `windup` / `strike` / `idleMs` / `dirs` (see
`DesignBakeParams` in `DesignRegistry.ts`). Resolution:
`DesignRegistry.designBakeParams(unit, slot)` reads the export lazily off a
namespace-import map (cycle-safe; files without the export resolve to null),
the BakeBridge exposes it, and a `DESIGN=<slot>` bake overlays it on the
unit's `TROOP_PARAMS` row for that run. The merged values (plus a
`designParamsOverride` provenance key) are written into the variant's baked
`manifest.json` — the ONLY place SpriteBank reads playback periods from, so
the runtime needs no change. It supersedes the older golem-only
`designStride` table (`PARAMS.stride` wins over `designStride` if both exist).

Two rules artists must respect when authoring `PARAMS`:

- **`delay` must equal the runtime TroopDefinitions `attackDelay`.**
  SpriteBank matches baked `attackAge` by NEAREST VALUE against runtime ages;
  ages baked against a wrong delay pair windup ages with the wrong frames
  (necromancer precedent: ages baked at the table's pinned 5000 could never
  match runtime windup ages at delay 1600 — the windup displayed strike
  frames).
- **`idleMs` is required whenever the idle loop closes on its own exact
  period** (a 250 ms multiple, terms exact harmonics). Without it the bake
  samples the default 2π·640 ≈ 4021 ms breath window, which does NOT close a
  2000 ms loop — the seam pops.

## Winner promotion (the finals) — proven procedure

When the owner picks (winner per unit, possibly mixes, possibly "revert to
old", possibly "loser becomes a NEW unit"):

1. **Winner:** rewire the stubbed draw fn to call the winning design DIRECTLY
   (the `redesign/<Unit><Slot>.ts` file stays as the canonical
   implementation); remove the unit from `DesignRegistry` (Design Lab drops
   the row automatically); promote the bake by renaming
   `<unit>@<slot>` → `<unit>` (verify no `@slot` key is embedded in
   manifest/atlas first — if it is, re-bake plain instead); delete losing
   files, slots, and `@` dirs. Stale `localStorage['clash.design.<unit>']`
   values are harmless by design (resolver short-circuits when no variant
   dirs exist).
2. **Revert-to-old:** the original body lives in git HEAD
   (`git show HEAD:<file>`) — restore surgically (never `checkout`, other
   uncommitted work must survive), re-bake plain, purge variants.
3. **Loser promoted to a new unit:** wire the data half per ADDING_*.md
   (definitions, canonical order, TROOP_PARAMS, dispatch, icon), then a
   clean-room agent WITH context of that design file (only) reskins it and
   builds its effect kit. Bespoke effects (hit/death/ability) follow the same
   clean-room rule: stub the OLD effect implementations first, hand the new
   designer a mechanics-only contract.
4. Gate once at the end: `pack-atlases.mjs`, reconcile
   `render-quality-regression.mjs` exact counts, tsc, pathing, server tests,
   dangling-reference grep, live smoke of every pick.

## Operational gotchas (learned the hard way)

- The Vite-embedded game server CANNOT hot-reload (data-dir lock): after any
  `server/` or shared-definition change (new troop types!), manually restart
  the dev server or trainings/deploys 404 with "Unknown troop type".
- Workflow `args` may arrive as a JSON STRING — the saved workflow parses
  both; keep that guard.
- Bake agents must NOT run `pack-atlases.mjs` concurrently — one pack, at the
  gate.
- Isolated same-unit designers converge when the brief is narrow (three
  "glacial well" frostfalls; three "bulldog bombard" cannons): if the owner
  wants structural divergence, seed each slot with a divergence-forcing
  angle, or accept the convergence as signal about the brief.

## Invariants

- Rotating defenses bake 16 aim angles; direction-aware troops bake up to 16
  directions (`TROOP_PARAMS.dirs`).
- Variant dirs are full standalone unit bakes — manifest + frames + atlas.
- Committed assets are never touched during the design phase; only the bake
  phase writes `public/assets/`.
- The regression's exact frame counts are reconciled once, by the gate, after
  all bakes.
