# Adding Troops

Troop integration has one shared definition, several presentation adapters,
and optional special combat behavior.

## 1. Add the focused definition

Edit `src/game/config/definitions/TroopDefinitions.ts`:

1. For a faction unit, add the ID once at the intended L1–L7 slot of exactly
   one `TROOP_TECH_TREES` branch. For a deliberately universal starter, add
   it to `CORE_TROOP_TYPES` and give it one explicit Army Camp level in
   `CORE_TROOP_UNLOCK_LEVELS`. The derived
   `TRAINABLE_TROOP_TYPES` catalog is the only new-training authority.
   Normally retire an already-owned ID through `LEGACY_PLAYER_TROOP_TYPES`;
   when the owner explicitly requests an end-to-end purge, remove the
   definition and rely on shared save/replay sanitation instead. Add a
   scenario-only ID directly to `TroopType`.
2. Add its `TROOP_DEFINITIONS` entry.

Do not infer progression from `BARRACKS_TROOP_UNLOCK_ORDER`; it remains only a
compatibility flattening of faction nodes. `troopTrainingRequirement()`
returns a Core requirement with an Army Camp unlock level or a faction
Barracks requirement, and returns `null` for generated/unknown types. The
current four Core + 2×7 layout and migration contract are recorded in
[TROOP_FACTION_ARCHITECTURE.md](./TROOP_FACTION_ARCHITECTURE.md).

Typical fields are `cost`, `space`, `health`, `damage`, `range`, `speed`, and
`movementType`. `wallTraversalCost` changes breach preference; it is never
permission to phase through walls. Prefer declarative fields such as
`targetPriority`, splash, chain, healing, or wall multipliers before adding a
troop-specific branch.

`src/game/config/GameDefinitions.ts` is only a compatibility re-export. The
server attack domain imports the focused catalog through it to validate
reservations, command troop types, and deterministic combat.

Generated-only units need an explicit authority decision. `romanwarrior`
(displayed as Bound Spirit) is created from a deployed Phalanx, and
`skeleton` is raised by a Necromancer. Both are Mystic and deliberately
excluded from direct training, army reservation, and deployment.

## 2. Wire presentation

- Add the draw case/helper to `src/game/renderers/TroopRenderer.ts`.
- Bake the troop, then run `node tools/art-preview/gen-troop-sprite-icons.mjs`.
  `TroopIcon` uses the generated portrait from the real highest-level PLAYER
  idle frame; do not alias another troop's hand-authored CSS glyph.

Creating or redesigning troop art requires the clean-room tournament in
[DESIGN_TOURNAMENTS.md](./DESIGN_TOURNAMENTS.md). Ask the owner how many visual
variants to make before authoring any of them; screenshot the candidates,
promote only the owner's winner, and then bake/update the exact sprite gates.
A neutral placeholder is acceptable for architecture work only and is never a
finished visual.

`GameTypes`, `TroopRenderer`, the attack reservation type, selection state, and
HUD order all consume the central types/tuple. Do not add another handwritten
troop union or ordering list.

## 3. Add special behavior only when needed

Default target selection, legal attack positions, wall breaches, and movement
live in:

- `src/game/systems/TargetingSystem.ts`
- `src/game/systems/CombatNavigationSystem.ts`
- `src/game/scenes/MainScene.ts` (combat presentation and special troop
  effects)

Read [COMBAT_NAVIGATION.md](./COMBAT_NAVIGATION.md) before changing targeting,
breach behavior, movement, or collision. `PathfindingSystem.ts` is for ambient
village life, not combat troops.

If a behavior changes authoritative damage rather than only visuals, update the
versioned simulator in `server/attack-domain/simulation.ts` as well. Preserve
old simulation-version behavior so stored attacks/replays remain reproducible.

## 4. Verify

- Each Core troop rejects training below its intended Army Camp level and
  trains once the highest online camp reaches that level. A faction troop
  appears at its intended branch level and can be trained/untrained.
- A barracks from either other faction does not unlock it; a matching barracks
  that is absent, too low-level, or upgrading remains rejected server-side.
- Army housing and food cost match client and server responses.
- It can be deployed through `/api/attacks/commands`; retries do not consume a
  second troop.
- Local animation, depth/layering, target choice, breach path, damage cadence,
  and range are correct.
- Removed troop ids self-clean from stored armies and reject new training;
  generated descendants cannot be directly reserved unless intentionally
  designed that way.
- Run `npm run test:pathing`, the attack-domain regression, and both client and
  server typechecks.
