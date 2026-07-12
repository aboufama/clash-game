# Documentation

Entry point for the docs. Start here, then open the specific guide.

## The important one

- **[BUILDING_ART_GUIDE.md](./BUILDING_ART_GUIDE.md)** — how building art is
  actually made in this game (layered vector graphics in
  `BuildingRenderer.ts`): iso math, the renderer contract, lighting/palette
  rules, roofs, doors, turret math, walls, day/night light rigs, and the
  screenshot-verification workflow in `tools/art-preview/`. Required reading
  before any visual work.

## Task guides

- [ADDING_BUILDINGS.md](./ADDING_BUILDINGS.md) — end-to-end wiring checklist
  for a new building type.
- [ADDING_TROOPS.md](./ADDING_TROOPS.md) — same for troops.
- [RENDERING_AND_DEPTH.md](./RENDERING_AND_DEPTH.md) — depth sorting and the
  base/elevated (ground-bake) contract. Read when something layers wrong.
- [COMBAT_NAVIGATION.md](./COMBAT_NAVIGATION.md) — strategic targets, wall
  breaches, legal attack positions, collision, and regression requirements.

## Reference

- [ARCHITECTURE.md](./ARCHITECTURE.md) — where everything lives (client,
  scene, `server/`).
- [MainScene_Organization.md](../src/game/scenes/MainScene_Organization.md) —
  scene responsibilities, focused collaborators, and extension seams.
- [attack-domain/README.md](../server/attack-domain/README.md) — unified
  attack state machine, transaction contract, and replay authority.
- [persistence/README.md](../server/persistence/README.md) — normalized schema,
  production runtime selection, bounded MMO queries, and cutover runbook.
- [REWRITE_REVIEW.md](./REWRITE_REVIEW.md) — historical: findings from the
  2026-07 backend rewrite review.
