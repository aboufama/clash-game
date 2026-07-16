import Phaser from 'phaser';
import { TROOP_DEFINITIONS } from '../config/GameDefinitions';
import { pixelEllipse, pixelRect } from '../render/PixelDraw';

/**
 * The world map's little vector people — border-road travellers, the war
 * caravan's marching escort, and the wilderness lake fish. Extracted from
 * WorldMapSystem as pure screen-space draw functions (already-projected
 * x/y in, every animation a deterministic function of `time`, never
 * Math.random()) so the sprite bake (docs/AGENTS_SPRITE_PIPELINE.md) can
 * quantize them like any other unit. WorldMapSystem keeps ownership of
 * motion, culling, depth and iso projection.
 */
export class WorldFigureRenderer {
    /**
     * One border-road traveller at screen (x, y): the camp pose (bedroll +
     * bonfire) or the walking figure of its kind. `facing` is the ±1 screen
     * direction sign; `seed` desynchronizes gaits between figures.
     */
    static drawTraveller(
        g: Phaser.GameObjects.Graphics,
        x: number,
        y: number,
        kind: string,
        facing: 1 | -1,
        time: number,
        seed: number,
        state: 'walk' | 'camp'
    ) {
        if (state === 'camp') {
            // Bedroll + bonfire: crossed logs and a flickering two-tongue
            // flame, pitched on the WALKING side (`facing` mirrors the whole
            // pose). The bake captures facing=+1 and flip-X mirrors it at
            // runtime; the vector fallback must mirror the same way or its
            // fire would sit opposite the firelight pool
            // (WorldMapSystem.campfireGrid projects the glow at the fire).
            const f = facing;
            g.fillStyle(0x000000, 0.16);
            g.fillEllipse(x, y + 3, 22, 8);
            g.lineStyle(2, 0x5c4326, 1);
            g.lineBetween(x + 6 * f, y + 2, x + 13 * f, y - 1);
            g.lineBetween(x + 6 * f, y - 1, x + 13 * f, y + 2);
            const lick = Math.sin(time * 0.02 + seed) * 1.6;
            g.fillStyle(0xff7a2a, 0.95);
            g.fillTriangle(x + 7 * f, y, x + 12 * f, y, x + (9.5 + lick * 0.4) * f, y - 7 - Math.abs(lick));
            g.fillStyle(0xffc36a, 0.95);
            g.fillTriangle(x + 8 * f, y, x + 11 * f, y, x + (9.5 + lick * 0.3) * f, y - 4.4 - Math.abs(lick) * 0.6);
            // The traveller sits by it, hood up.
            g.fillStyle(0x4a4258, 1);
            g.fillEllipse(x - 2 * f, y - 3, 7.5, 8);
            g.fillStyle(0xd9b38c, 1);
            g.fillCircle(x - 2 * f, y - 8, 2.4);
            g.fillStyle(0x3c3648, 1);
            g.fillEllipse(x - 2 * f, y - 9.4, 5.4, 3);
            return;
        }

        const bob = Math.abs(Math.sin(time * 0.008 + seed)) * 1.4;

        // A little walking figure, reused by several kinds.
        const walker = (x: number, y: number, cloak: number, skin: number, hood: number | null, wobble: number) => {
            g.fillStyle(0x000000, 0.15);
            g.fillEllipse(x, y + 3, 9, 3.6);
            g.fillStyle(cloak, 1);
            g.fillTriangle(x - 4, y + 2, x + 4, y + 2, x, y - 9 - wobble);
            g.fillStyle(skin, 1);
            g.fillCircle(x, y - 10 - wobble, 2.3);
            if (hood !== null) {
                g.fillStyle(hood, 1);
                g.fillEllipse(x, y - 11.4 - wobble, 5, 2.8);
            }
        };
        switch (kind) {
            case 'courier': {
                // A runner at full stride: satchel bouncing, dust at his heels.
                const stride = Math.abs(Math.sin(time * 0.016 + seed)) * 2.6;
                walker(x, y, 0x2f5f8a, 0xd9b38c, null, stride);
                g.fillStyle(0x8a6a42, 1);
                g.fillEllipse(x - 3.4 * facing, y - 6 - stride * 0.4, 3.6, 2.8);
                g.lineStyle(1, 0x6a5432, 1);
                g.lineBetween(x - 3.4 * facing, y - 8 - stride * 0.4, x + 1 * facing, y - 11 - stride);
                for (let d = 0; d < 2; d++) {
                    const cycle = ((time * 0.003 + d * 0.5 + seed) % 1);
                    g.fillStyle(0xcbb894, 0.28 * (1 - cycle));
                    g.fillCircle(x - (7 + cycle * 7) * facing, y + 2, 1.4 + cycle * 1.8);
                }
                break;
            }
            case 'monk': {
                // A brown-robed brother, hands folded, unhurried.
                walker(x, y, 0x6a4f30, 0xd9b38c, 0x59422a, bob * 0.6);
                g.fillStyle(0x8a6a42, 1);
                g.fillEllipse(x, y - 4 - bob * 0.6, 5.6, 1.6); // rope belt
                g.fillStyle(0xd9b38c, 1);
                g.fillEllipse(x + 2.6 * facing, y - 5.4 - bob * 0.6, 2.2, 1.6); // folded hands
                break;
            }
            case 'hunter': {
                // Green hood, bow across the back — a lean dog trots ahead.
                walker(x, y, 0x3f5f38, 0xd9b38c, 0x33502e, bob);
                g.lineStyle(1.3, 0x8a6a42, 1);
                g.beginPath();
                g.arc(x - 2 * facing, y - 6 - bob, 5.4, -1.2, 1.2);
                g.strokePath();
                g.lineStyle(0.8, 0xd8d2c4, 0.9);
                g.lineBetween(x - 2 * facing, y - 11.2 - bob, x - 2 * facing, y - 0.8 - bob);
                const dogX = x + 11 * facing + Math.sin(time * 0.006 + seed) * 2;
                const trot = Math.abs(Math.sin(time * 0.014 + seed)) * 1;
                g.fillStyle(0x000000, 0.13);
                g.fillEllipse(dogX, y + 3, 7, 2.6);
                g.fillStyle(0x5a4a36, 1);
                g.fillEllipse(dogX, y - 1 - trot, 7, 3.4);
                g.fillCircle(dogX + 3.6 * facing, y - 3 - trot, 1.9);
                g.lineStyle(1.1, 0x5a4a36, 1);
                g.lineBetween(dogX - 3.4 * facing, y - 2 - trot, dogX - 5.4 * facing, y - 4.6 - trot);
                break;
            }
            case 'woodcutter': {
                // Broad fellow under a shoulder-load of logs.
                walker(x, y, 0x7a5638, 0xd9b38c, null, bob * 0.7);
                g.fillStyle(0x8a6440, 1);
                g.fillRect(x - 7, y - 12.5 - bob * 0.7, 14, 2.2);
                g.fillStyle(0x6e4e30, 1);
                g.fillRect(x - 7, y - 14.7 - bob * 0.7, 14, 2.2);
                g.fillStyle(0xc9b593, 1);
                g.fillEllipse(x - 7, y - 13.6 - bob * 0.7, 1.6, 2.8);
                g.fillEllipse(x + 7, y - 13.6 - bob * 0.7, 1.6, 2.8);
                break;
            }
            case 'marketgoer': {
                // Off to the neighbours' stalls: bright dress, full basket.
                walker(x, y, 0x8a4a62, 0xd9b38c, 0xc9a24a, bob);
                g.fillStyle(0x8a6a42, 1);
                g.fillEllipse(x + 4.4 * facing, y - 4.6 - bob, 4.2, 3);
                g.lineStyle(1, 0x6a5432, 1);
                g.beginPath();
                g.arc(x + 4.4 * facing, y - 6.2 - bob, 2, Math.PI, 0);
                g.strokePath();
                g.fillStyle(0xd85a3c, 1);
                g.fillCircle(x + 3.4 * facing, y - 6 - bob, 0.9);
                g.fillStyle(0x6fae4a, 1);
                g.fillCircle(x + 5.4 * facing, y - 6.2 - bob, 0.9);
                break;
            }
            case 'shepherd': {
                walker(x, y, 0x6a5a3c, 0xd9b38c, 0x8a744e, bob);
                g.lineStyle(1.4, 0x8a6a42, 1);
                g.lineBetween(x + 4 * facing, y + 3, x + 5.5 * facing, y - 9 - bob);
                g.lineStyle(1.4, 0x8a6a42, 1);
                const hookX = x + 5.5 * facing;
                g.lineBetween(hookX, y - 9 - bob, hookX + 2 * facing, y - 10.5 - bob);
                // Two sheep amble behind, out of step with each other.
                for (let s = 0; s < 2; s++) {
                    const sx = x - (9 + s * 8) * facing + Math.sin(time * 0.004 + s * 2 + seed) * 1.6;
                    const sy = y + 1 + Math.cos(time * 0.005 + s * 3) * 0.8;
                    const hop = Math.abs(Math.sin(time * 0.009 + s * 1.7 + seed)) * 1;
                    g.fillStyle(0x000000, 0.14);
                    g.fillEllipse(sx, sy + 2.4, 7, 2.6);
                    g.fillStyle(0xe8e2d4, 1);
                    g.fillEllipse(sx, sy - 2 - hop, 7.5, 5);
                    g.fillStyle(0x3c3226, 1);
                    g.fillEllipse(sx + 3.6 * facing, sy - 3 - hop, 2.6, 2.2);
                    g.lineStyle(1, 0x3c3226, 1);
                    g.lineBetween(sx - 2, sy, sx - 2, sy + 2.2);
                    g.lineBetween(sx + 2, sy, sx + 2, sy + 2.2);
                }
                break;
            }
            case 'patrol': {
                // A guard walking the beat: mail, kite shield, tall spear.
                walker(x, y, 0x5a6470, 0xd9b38c, null, bob);
                g.fillStyle(0x8a9aae, 1);
                g.fillEllipse(x, y - 11.6 - bob, 4.6, 3.4);
                g.fillStyle(0x2f5f8a, 1);
                g.fillTriangle(x - 4.5 * facing, y - 7 - bob, x - 1.5 * facing, y - 7 - bob, x - 3 * facing, y - 1 - bob);
                g.lineStyle(1.3, 0x8a6a42, 1);
                g.lineBetween(x + 3.5 * facing, y + 2, x + 3.5 * facing, y - 14 - bob);
                g.fillStyle(0xc8d4e4, 1);
                g.fillTriangle(x + 3.5 * facing - 1.4, y - 14 - bob, x + 3.5 * facing + 1.4, y - 14 - bob, x + 3.5 * facing, y - 17.5 - bob);
                break;
            }
            default: {
                // The hooded wanderer, staff in hand.
                walker(x, y, 0x4a4258, 0xd9b38c, 0x3c3648, bob);
                g.lineStyle(1.4, 0x8a6a42, 1);
                g.lineBetween(x + 4 * facing, y + 3, x + 5.5 * facing, y - 8 - bob);
            }
        }
    }

    /**
     * One caravan troop on foot at screen (x, y): cloaked in its type
     * colour, spear shouldered, heavier types drawn bigger — the column
     * LOOKS like your army. `wobbleSeed` staggers the march bounce per rank
     * (the caravan passes rank-index × 1.31).
     */
    static drawCaravanSoldier(
        g: Phaser.GameObjects.Graphics,
        x: number,
        y: number,
        troopType: string,
        time: number,
        wobbleSeed: number
    ) {
        const wobble = Math.abs(Math.sin(time * 0.009 + wobbleSeed)) * 1.3;
        const def = TROOP_DEFINITIONS[troopType as keyof typeof TROOP_DEFINITIONS];
        const s = (def && def.space >= 5 ? 1.45 : def && def.space >= 3 ? 1.18 : 1) * 1.32;
        g.fillStyle(0x000000, 0.15);
        g.fillEllipse(x, y + 2.6 * s, 7.4 * s, 2.9 * s);
        // Dark edge first so the cloak pops off any grass tone.
        g.fillStyle(0x1c1a16, 0.85);
        g.fillTriangle(x - 3.8 * s, y + 2.4 * s, x + 3.8 * s, y + 2.4 * s, x, y - (8.2 + wobble) * s);
        g.fillStyle(def?.color ?? 0xb8bfca, 1);
        g.fillTriangle(x - 3.1 * s, y + 2 * s, x + 3.1 * s, y + 2 * s, x, y - (7.5 + wobble) * s);
        g.fillStyle(0xd9b38c, 1);
        g.fillCircle(x, y - (8.6 + wobble) * s, 1.9 * s);
        // Spear on the shoulder, steel tip catching the light.
        g.lineStyle(1.4, 0x6e5136, 1);
        g.lineBetween(x + 2.2 * s, y + 1.8 * s, x + 4.4 * s, y - (12 + wobble) * s);
        g.fillStyle(0xd8d8e0, 1);
        g.fillTriangle(
            x + 4.4 * s - 1.2, y - (12 + wobble) * s,
            x + 4.4 * s + 1.2, y - (12 + wobble) * s,
            x + 4.4 * s, y - (14.4 + wobble) * s
        );
    }

    /**
     * A lake fish at screen (x, y): shadow-body and tail under the surface
     * plus an expanding ripple ring. The swim direction is re-derived from
     * the same `time`/`phase` the caller used to place it.
     */
    static drawFish(
        g: Phaser.GameObjects.Graphics,
        x: number,
        y: number,
        time: number,
        phase: number,
        scale: number
    ) {
        const swim = time * 0.00115 + phase;
        const facing = Math.cos(swim) >= 0 ? 1 : -1;
        // Pixel cells — this draw runs LIVE on postcard life (and is the
        // fish bake source; pre-snapped input quantizes to itself).
        pixelEllipse(g, x, y, 4 * scale, 1.65 * scale, 0x163e49, 0.5);
        // Tail wedge: two stacked cell rows behind the body.
        pixelRect(g, x - facing * 6.4 * scale, y - 1.8 * scale, 3.1 * scale, 1.6 * scale, 0x163e49, 0.5);
        pixelRect(g, x - facing * 6.4 * scale, y + 0.2 * scale, 3.1 * scale, 1.6 * scale, 0x163e49, 0.5);
        const ripple = (time * 0.00052 + phase / (Math.PI * 2)) % 1;
        // Expanding ripple ring as perimeter cells.
        const rx = (5 + ripple * 18 * scale) / 2;
        const ry = (2 + ripple * 7 * scale) / 2;
        const rippleAlpha = 0.34 * (1 - ripple);
        const CELL = 1.35;
        let px = NaN, py = NaN;
        for (let k = 0; k < 24; k++) {
            const a = (k / 24) * Math.PI * 2;
            const cx = Math.floor((x + Math.cos(a) * rx) / CELL) * CELL;
            const cy = Math.floor((y + Math.sin(a) * ry) / CELL) * CELL;
            if (cx === px && cy === py) continue;
            px = cx; py = cy;
            pixelRect(g, cx, cy, CELL, CELL, 0xc6e5e3, rippleAlpha);
        }
    }
}
