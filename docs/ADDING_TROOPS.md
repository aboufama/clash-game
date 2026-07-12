# Adding Troops

Troop integration has one shared definition, several presentation adapters,
and optional special combat behavior.

## 1. Add the focused definition

Edit `src/game/config/definitions/TroopDefinitions.ts`:

1. For a player-trainable unit, add the ID once to `PLAYER_TROOP_TYPES`; the
   `PlayerTroopType` union and battle-bar order derive from that tuple. Add a
   scenario-only ID directly to `TroopType` instead.
2. Add its `TROOP_DEFINITIONS` entry.
3. If it is trainable, place it in `BARRACKS_TROOP_UNLOCK_ORDER` at the intended
   unlock level.

Typical fields are `cost`, `space`, `health`, `damage`, `range`, `speed`, and
`movementType`. `wallTraversalCost` changes breach preference; it is never
permission to phase through walls. Prefer declarative fields such as
`targetPriority`, splash, chain, healing, or wall multipliers before adding a
troop-specific branch.

`src/game/config/GameDefinitions.ts` is only a compatibility re-export. The
server attack domain imports the focused catalog through it to validate
reservations, command troop types, and deterministic combat.

Generated-only units need an explicit authority decision. For example,
`romanwarrior` is created from a deployed phalanx and is deliberately excluded
from direct army reservation/deployment.

## 2. Wire presentation

- Add `<troop-id>-icon::before` to `src/icons/accurate-icons.css`.
- Add the draw case/helper to `src/game/renderers/TroopRenderer.ts`.

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

- The troop appears at the intended barracks level and can be trained/untrained.
- Army housing and food cost match client and server responses.
- It can be deployed through `/api/attacks/commands`; retries do not consume a
  second troop.
- Local animation, depth/layering, target choice, breach path, damage cadence,
  and range are correct.
- Generated descendants cannot be directly reserved unless intentionally
  designed that way.
- Run `npm run test:pathing`, the attack-domain regression, and both client and
  server typechecks.
