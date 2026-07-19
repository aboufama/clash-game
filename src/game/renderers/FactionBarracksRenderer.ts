import type Phaser from 'phaser';
import { drawBarracksA } from './redesign/BarracksA';
import { drawMysticBarracksA } from './redesign/Mystic_barracksA';

// ============================================================================
// CANONICAL DESIGNS (2026-07-19) — the 2-variant faction-barracks redesign
// round is FINISHED. The owner approved both clean-room rebuilds from the
// post-bake showcases:
//   - 'Foundry Bastion'   (unit `barracks`, Mechanica) — drawBarracksA
//   - 'Athenaeum of War'  (unit `mystic_barracks`)     — drawMysticBarracksA
// Following the cannon-B / golem-C / deadwood-A precedent, the winners are
// called DIRECTLY here and the round was retired from
// ./redesign/DesignRegistry.ts (no activeDesign routing, no placeholder).
// The pre-round canonical art survives in git history.
// ============================================================================

/** Kept for the dispatcher contract: the theme picks which canonical design a
 * plot renders. */
export type FactionBarracksTheme = 'mechanica' | 'mystic';

type G = Phaser.GameObjects.Graphics;
type V = Phaser.Math.Vector2;

interface BarracksState {
    level?: number;
    doorOpen?: number;
}

export function drawFactionBarracks(
    graphics: G,
    c1: V,
    c2: V,
    c3: V,
    c4: V,
    center: V,
    alpha: number,
    building: BarracksState | undefined,
    baseGraphics: G | undefined,
    skipBase: boolean,
    onlyBase: boolean,
    time: number,
    theme: FactionBarracksTheme,
): void {
    const design = theme === 'mystic' ? drawMysticBarracksA : drawBarracksA;
    design(graphics, c1, c2, c3, c4, center, alpha, null, building, baseGraphics, skipBase, onlyBase, time);
}
