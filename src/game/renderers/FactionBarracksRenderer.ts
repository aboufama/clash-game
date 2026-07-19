import type Phaser from 'phaser';
import { activeDesign, type BuildingDesignFn } from './redesign/DesignRegistry';

// ============================================================================
// CLEAN-ROOM REDESIGN IN PROGRESS (2026-07-19)
//
// Both faction barracks are in a live 2-variant design tournament
// (units `barracks` and `mystic_barracks`, slots A/B — see
// ./redesign/DesignRegistry.ts and ./redesign/DESIGN_TOURNAMENTS.md).
// The previous canonical art was deliberately REMOVED from the bundle so the
// isolated designer agents cannot see it; it survives in git history for the
// revert-to-old promotion path (`git show <pre-round-commit>:<this file>`).
//
// This file now only: (a) resolves the live tournament slot per unit via
// activeDesign(unit) — re-read from localStorage['clash.design.<unit>'] on
// every draw, so switching designs is instant — and (b) paints a neutral,
// styleless placeholder while a unit has no filled slot.
// ============================================================================

/** Kept for the dispatcher contract: the theme picks which tournament unit
 * (and, post-round, which canonical design) a plot renders. */
export type FactionBarracksTheme = 'mechanica' | 'mystic';

type G = Phaser.GameObjects.Graphics;
type V = Phaser.Math.Vector2;

interface BarracksState {
    level?: number;
    doorOpen?: number;
}

/** Theme → DesignRegistry unit key (equal to the building type id). */
const THEME_UNIT: Record<FactionBarracksTheme, 'barracks' | 'mystic_barracks'> = {
    mechanica: 'barracks',
    mystic: 'mystic_barracks',
};

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
    // CLEAN-ROOM REDESIGN IN PROGRESS — delegate to the live tournament slot.
    const design = activeDesign(THEME_UNIT[theme]) as BuildingDesignFn | null;
    if (design) {
        design(graphics, c1, c2, c3, c4, center, alpha, null, building, baseGraphics, skipBase, onlyBase, time);
        return;
    }

    // Neutral placeholder: a flat, styleless iso block. No faction language,
    // no ambient motion — this must never be mistaken for a design.
    const ground = baseGraphics ?? graphics;
    if (!skipBase) {
        ground.fillStyle(0x000000, alpha * 0.18);
        ground.fillEllipse(center.x, center.y + 3, 56, 24);
    }
    if (onlyBase) return;

    const inset = 0.55;
    const wallH = 18;
    const p = (v: V): [number, number] => [
        center.x + (v.x - center.x) * inset,
        center.y + (v.y - center.y) * inset,
    ];
    const quad = (pts: ReadonlyArray<readonly [number, number]>, color: number): void => {
        graphics.fillStyle(color, alpha);
        graphics.beginPath();
        graphics.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) graphics.lineTo(pts[i][0], pts[i][1]);
        graphics.closePath();
        graphics.fillPath();
    };
    const p1 = p(c1);
    const p2 = p(c2);
    const p3 = p(c3);
    const p4 = p(c4);
    const up = (pt: readonly [number, number]): [number, number] => [pt[0], pt[1] - wallH];
    quad([p2, p3, up(p3), up(p2)], 0x6f6f6f); // SE face (dark)
    quad([p3, p4, up(p4), up(p3)], 0x8a8a8a); // SW face (lit)
    quad([up(p1), up(p2), up(p3), up(p4)], 0x9e9e9e); // top
}
