# Troop overhaul — remaining items (stub, 2026-07-16)

The overhaul itself is DONE and documented in CLAUDE.md / AGENTS.md (the
"troop overhaul + design tournaments" bullet): 19-troop roster (was 21 —
pavisebearer + hawkeyeassassin were deleted end-to-end 2026-07-16, owner
call, on top of the earlier ward/recursion/giant/sharpshooter deletion),
2-per-level barracks unlocks (barracks maxLevel 10),
`ATTACK_SIMULATION_VERSION` 4, every
tournament slot baked + live-switchable, judge-panel defaults live in
`DEFAULT_DESIGN_SLOTS` (`src/game/renderers/redesign/DesignRegistry.ts`).
Gate live
checkpoints (trebuchet-vs-dragons_breath duel, elephant wall trample,
quartermaster aura, TrainingModal/battle bar) were captured
2026-07-16 (pre-deletion, at the then-21-entry roster). This file lists
only what remains; delete it when the list empties.

## Waiting on the OWNER (block winner promotion until picked)

- **Frostfall design pick:** `frostfall@A/B/C` baked + switchable
  (`localStorage['clash.design.frostfall']`); no judged default — the
  owner chooses.
- **Per-troop winners:** the judge defaults in `DEFAULT_DESIGN_SLOTS` are
  PROVISIONAL; the owner confirms or overrides each unit in the Design
  Lab. Only after the picks: promote winners / delete losers per
  docs/DESIGN_TOURNAMENTS.md "Winner promotion", then reconcile the
  regression's exact counts once.

## Open decisions / known gaps

- **Wallbreaker L4 balance cliff** (flagged by the balance review) —
  owner decision pending on the retune.
- **clockworkbeetle judge verdict** still in flight — no
  `DEFAULT_DESIGN_SLOTS` entry yet (default falls back A→B→C, i.e. @A).

## Environment notes (kept — they save an hour)

- The Vite-embedded game server CANNOT hot-reload shared definitions —
  restart after TroopDefinitions/MilitaryBuildings edits or trains 404.
- ONE shared harness identity: `tools/art-preview/.shared-device-token.json`.
  NEVER mint per-run guests (30/hour limit + world-map junk).
