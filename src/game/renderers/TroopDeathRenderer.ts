import type Phaser from 'phaser';
import { drawGolemDeath } from './troopDeaths/GolemDeaths';
import { drawMachineDeath } from './troopDeaths/MachineDeaths';
import { drawHeavyDeath } from './troopDeaths/HeavyDeaths';
import { troopWorldVisualScale } from './TroopVisualScale';

/** Deliberately curated by the owner. Do not infer this set from housing,
 *  bake-canvas size, or machine-ness: several visually large troops were
 *  explicitly excluded from bespoke remnants. */
export const LARGE_TROOP_DEATH_TYPES = [
    'golem',
    'icegolem',
    'siegetower',
    'davincitank',
    'trebuchet',
    'warelephant'
] as const;

export type LargeTroopDeathType = typeof LARGE_TROOP_DEATH_TYPES[number];
export type SiegeDeathPose = 'rolling' | 'parked';

const LARGE_TROOP_DEATH_SET: ReadonlySet<string> = new Set(LARGE_TROOP_DEATH_TYPES);

export function isLargeTroopDeathType(type: string): type is LargeTroopDeathType {
    return LARGE_TROOP_DEATH_SET.has(type);
}

/** Vector authoring source for terminal troop art. The bake bridge samples
 *  this pure progress surface into `troop_deaths/` atlases; runtime uses the
 *  same draw only as a kill-switch/missing-asset fallback. `phase=1` is the
 *  persistent, low remnant and must never contain a living glow/pose. */
export class TroopDeathRenderer {
    static draw(
        graphics: Phaser.GameObjects.Graphics,
        type: LargeTroopDeathType,
        owner: 'PLAYER' | 'ENEMY',
        troopLevel: number,
        facingAngle: number,
        phase: number,
        siegePose: SiegeDeathPose = 'rolling'
    ): void {
        const isPlayer = owner === 'PLAYER';
        if (type === 'golem' || type === 'icegolem') {
            drawGolemDeath(graphics, type, isPlayer, troopLevel, facingAngle, phase);
            return;
        }
        if (type === 'davincitank' || type === 'siegetower') {
            drawMachineDeath(graphics, type, isPlayer, troopLevel, facingAngle, phase, siegePose);
            return;
        }
        drawHeavyDeath(graphics, type, isPlayer, troopLevel, facingAngle, phase);
    }

    /** Runtime vector fallback matching SpriteBank's presentation scale. */
    static drawWorld(...args: Parameters<typeof TroopDeathRenderer.draw>): void {
        const [graphics, type] = args;
        const scale = troopWorldVisualScale(type);
        if (scale === 1) {
            TroopDeathRenderer.draw(...args);
            return;
        }
        graphics.save();
        graphics.scaleCanvas(scale, scale);
        try {
            TroopDeathRenderer.draw(...args);
        } finally {
            graphics.restore();
        }
    }
}
