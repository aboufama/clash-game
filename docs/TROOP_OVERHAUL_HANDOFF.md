# Troop overhaul — handoff state (2026-07-16, branch `claude/troop-creation-tournament-k2o8df`)

One-session status marker for the next agent. Everything below is committed on
this branch; all gates were green at handoff (tsc app+node clean · pathing
150 plans · attack-domain 53 checks (v3 goldens byte-stable + v4 fixtures) ·
render-quality ok 84 manifests / 23,788 frames · server integration 365/365).

## DONE (do not redo)

- **Deleted end-to-end:** ward, recursion, giant, sharpshooter (defs, art,
  sim special-cases, server volley ceilings, icons, sprite dirs, tests;
  saves/replays self-clean).
- **Ram fix:** declarative `straightCharge` — rams the town-hall line,
  attacking blockers on the ray (fixtures in pathing regression).
- **Ice golem:** distinct two-handed glacier-crush attack + calving death
  spectacle; re-baked; freeze mechanics/replay parity intact.
- **11 new troops fully wired + mechanics live** (see
  `src/game/config/definitions/TroopDefinitions.ts` and the v2 blueprint the
  stats came from — commit history has it as scratchpad/TROOP_DESIGN.md, and
  the numbers are all in the definitions): goblinplunderer, clockworkbeetle,
  physicianscart, pavisebearer, quartermaster, siegetower, necromancer
  (+ generated-only skeleton), trebuchet, hawkeyeassassin, warelephant,
  ornithopter. 2-per-level barracks unlocks (`floor(index/2)+1`, maxLevel 11).
  Client kits + server settlement under ONE `ATTACK_SIMULATION_VERSION`
  3→4 bump (v3 preserved verbatim). Per-troop acceptance blocks in
  `scripts/integration-test.mjs`.
- **Design tournament art: 21/33 slots** registered live-switchable in
  DesignRegistry / Design Lab:
  - goblinplunderer A/B/C · physicianscart A/B/C · trebuchet A/B/C ·
    clockworkbeetle A/B · necromancer A/B (+ skeleton A/B) ·
    quartermaster A/B · siegetower A/B · pavisebearer A · warelephant A ·
    hawkeyeassassin A · ornithopter A
  - **Fully screenshot-verified (16):** goblin A/B/C, cart A/B, trebuchet
    A/B, siegetower A/B, beetle B, necromancer B + skeleton B,
    quartermaster B, pavise A, warelephant A, hawkeye A, ornithopter A.
  - **Registered but PENDING VISUAL SIGN-OFF (5):** beetle A, necromancer A
    (+ skeleton A), quartermaster A, cart C, trebuchet C — their artists were
    killed by a usage limit mid-polish; code compiles and is registered, but
    nobody eyeballed final screenshots. Verify before judging.

## NOT DONE — pick up here

1. **12 remaining design slots:** beetle C · pavise B/C · quartermaster C ·
   siegetower C (a discarded partial exists in session scratchpad only —
   treat as gone; re-run fresh) · necromancer C · hawkeye B/C ·
   warelephant B/C · ornithopter B/C. Artist-prompt template: see the
   persisted workflow scripts in the session dir, or crib the prompt shape
   from any registered design file header + docs/DESIGN_TOURNAMENTS.md.
   All screenshots are REPRODUCIBLE (designs are code; use
   `localStorage['clash.sprites.off']='1'` + `clash.design.<unit>='<slot>'`
   pre-boot) — nothing visual is lost if scratch dirs vanish.
2. **Visual sign-off** on the 5 pending slots above (screenshot day/night,
   walk/attack/idle, headings; reject or accept per BUILDING_ART_GUIDE taste).
3. **Judge panel + default picks** per unit (multi-lens: silhouette,
   readability zoomed out, motion legibility, level language, palette split;
   set default = winning slot; losers stay switchable).
4. **TROOP_PARAMS re-sync** in `tools/art-preview/bake-sprites.mjs` from each
   design's reported periods BEFORE baking. Known deltas: beetle B authored
   windup 500 (table pins 240); verify each winner's stride/windup/strike
   against its report (in the git history of this handoff / workflow outputs).
5. **Bake pipeline** (docs/DESIGN_TOURNAMENTS.md steps 4–5 +
   docs/AGENTS_SPRITE_PIPELINE.md): `DESIGN=<slot> TROOPS=<explicit list>
   node bake-sprites.mjs` per variant (never 'all'), `FIGURES=1` re-bake
   (caravan palettes derive from TROOP_PARAMS — do AFTER params surgery),
   projectile bakes (trebuchet_stone, ornithopter_bomb, hawkeye bolt if art
   demands; musket_ball already removed), then ONE `pack-atlases.mjs`, then
   reconcile `scripts/render-quality-regression.mjs` exact counts ONCE.
6. **Live checkpoints** (from the balance review): trebuchet-vs-dragons_breath
   duel (DB must land hits — range 11 math), elephant one-strike wall trample,
   quartermaster aura ×1.5 (never stacking), TrainingModal + battle bar
   screenshots at 21 entries.
7. **Docs:** update CLAUDE.md + AGENTS.md (byte-identical mirrors) — roster,
   2-per-level barracks, sim v4, tournament state; this file shrinks/dies
   as items complete.
8. **Owner showcase artifact** (per-unit cards: concept, screenshots,
   `clash.design.*` keys, judge rationale) — publish AFTER re-shooting
   winners, so the owner can re-pick in the Design Lab.

## Environment notes for the next agent (this saves you an hour)

- Dev server: `npm run dev` (:5173, use 127.0.0.1 not localhost). It CANNOT
  hot-reload shared definitions — restart after TroopDefinitions/
  MilitaryBuildings edits or trains 404.
- Headless Chrome on Linux containers: harness scripts hardcode the mac path —
  `mkdir -p "/Applications/Google Chrome.app/Contents/MacOS" && ln -sf
  /opt/pw-browsers/chromium ".../Google Chrome"`.
- ONE shared harness identity: `tools/art-preview/.shared-device-token.json`
  (auto-seeds on first harness run against a live server). NEVER mint
  per-run guests (30/hour limit + world-map junk).
- Artists are clean-room: they may read only DesignRegistry.ts + their own
  file in redesign/; anchor lines `// IMPORT <unit> <slot>` /
  `// SLOT <unit> <slot>`; hoisted `export function`s, no side effects.
- A git stash (`partial P5/P7 work interrupted by usage limit...`) holds
  superseded fragments from a limit outage — safe to drop.
