# Icons

This folder contains the CSS-based building/resource/UI fallback icons. Live
troop portraits are exact committed images generated from troop sprite bakes.

Files
- `src/icons/accurate-icons.css`: building, resource, obstacle, and legacy
  network-fallback troop glyphs.
- `src/icons/ui-icons.css`: small UI/action icons (move/delete/upgrade).
- `src/icons/index.css`: import hub used by `src/App.css`.

How to add an icon

- Troops: bake the troop first, then run
  `node tools/art-preview/gen-troop-sprite-icons.mjs`. Inspect
  `tools/art-preview/shots/troop-sprite-icon-preview.png`; `TroopIcon` loads
  the generated file and follows unresolved Design Lab slots live.
- All icons are baked data-URI PNGs (image-rendering: pixelated) — never
  box-shadow pixel grids, which AA-bleed hairline gaps between cells.
- Building/obstacle/fallback icons: add the pixel list in
  `tools/art-preview/game-icon-data.mjs`, run
  `node tools/art-preview/gen-game-icons.mjs`, check
  `shots/game-icon-preview.png`, splice `shots/game-icon-css.txt` into
  `src/icons/accurate-icons.css`.
- Resource / UI / symbol icons: same flow via `gen-icons.mjs`,
  `gen-ui-icons.mjs`, `gen-sym-icons.mjs`.
- Use the naming convention `<id>-icon::before` (for example, `archer-icon::before`).
- Render it with `<div class="icon <id>-icon"></div>` (the ::before is
  position: absolute — the holder needs a positioned ancestor).

Sizing
- Base sizes live in `src/App.css` under the `.icon` rules.
