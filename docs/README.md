# docs/ — global documentation index

Global, cross-cutting docs live here. **Folder-specific docs live in the
folders they document** (owner mandate, 2026-07-18: keeps per-area context
load small — read the docs of the folder you are working in).

## Global (this directory)

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the whole-system map: client/server
  split, authority boundaries, persistence, attack pipeline.
- [`MODULARITY_ASSESSMENT.md`](MODULARITY_ASSESSMENT.md) — why the art layer
  (not data) is the scaling wall.
- [`REWRITE_REVIEW.md`](REWRITE_REVIEW.md) — historical rewrite review.

## Folder-specific (moved to their homes)

| Doc | Lives at |
| --- | --- |
| Building art guide (REQUIRED for any art) | `src/game/renderers/BUILDING_ART_GUIDE.md` |
| Rendering & depth contracts | `src/game/renderers/RENDERING_AND_DEPTH.md` |
| Design tournaments (clean-room process) | `src/game/renderers/redesign/DESIGN_TOURNAMENTS.md` |
| Combat navigation contracts | `src/game/systems/COMBAT_NAVIGATION.md` |
| Adding buildings | `src/game/config/ADDING_BUILDINGS.md` |
| Adding troops | `src/game/config/ADDING_TROOPS.md` |
| Troop faction architecture (roster authority) | `src/game/config/TROOP_FACTION_ARCHITECTURE.md` |
| Troop overhaul handoff | `src/game/config/TROOP_OVERHAUL_HANDOFF.md` |
| Sprite/bake pipeline | `tools/art-preview/AGENTS_SPRITE_PIPELINE.md` |

Directory `AGENTS.md` files (config, renderers, systems, server) remain the
first-read maps for each area. The graphify knowledge graph
(`graphify-out/graph.json`) indexes all of it — query before grepping.
