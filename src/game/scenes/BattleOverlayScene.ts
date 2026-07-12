import Phaser from 'phaser';
import { applyTextureSampling, TextureSampling } from '../renderers/TextureRenderPolicy';

/**
 * Transparent scene stacked above MainScene. Its camera mirrors the main
 * camera every frame, so world-anchored UI parented here lines up exactly
 * with the battlefield while staying above the day/night grade (depth 30000)
 * and the rain layer (depth 30006) that both draw inside
 * MainScene. Health bars and troop level chips live here so they stay
 * readable at any zoom, day or night.
 *
 * MainScene launches this scene in create() and parents graphics here via
 * createHealthBarGraphics(). Nothing in this scene is interactive, so all
 * pointer input falls through to MainScene.
 */
export class BattleOverlayScene extends Phaser.Scene {
    /** 5x7 pixel numeral rows for the level chip textures (0-9). */
    private static readonly DIGITS_5X7: number[][] = [
        [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
        [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
        [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
        [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
        [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
        [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
        [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
        [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
        [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
        [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100]
    ];

    constructor() {
        super('BattleOverlay');
    }

    /** Bakes (once) and returns the texture key for a troop level chip: a
     *  13x13-cell pre-pixelated tag — dark pill outline, plate with a subtle
     *  bevel, gold 5x7 digit — at one canvas pixel per cell. Drawn at fixed
     *  WORLD scale docked to the health bar; NEAREST sampling keeps the
     *  baked pixels hard-edged at any zoom instead of linear-blurring. */
    ensureLevelChipTexture(level: number): string {
        const digit = Math.abs(Math.floor(level)) % 10;
        const key = `level-chip-${digit}`;
        if (this.textures.exists(key)) return key;
        const W = 13, H = 13;
        const tex = this.textures.createCanvas(key, W, H);
        if (!tex) return key;
        const ctx = tex.getContext();
        // Dark outline pill (one corner cell cut per corner)
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(1, 0, W - 2, H);
        ctx.fillRect(0, 1, W, H - 2);
        // Plate face, inset one cell
        ctx.fillStyle = '#333333';
        ctx.fillRect(2, 1, W - 4, H - 2);
        ctx.fillRect(1, 2, W - 2, H - 4);
        // Bevel: light top row, dark bottom row
        ctx.fillStyle = '#454545';
        ctx.fillRect(2, 1, W - 4, 1);
        ctx.fillStyle = '#262626';
        ctx.fillRect(2, H - 2, W - 4, 1);
        // Gold digit, centred
        const rows = BattleOverlayScene.DIGITS_5X7[digit];
        ctx.fillStyle = '#ffd700';
        for (let r = 0; r < 7; r++) {
            for (let c = 0; c < 5; c++) {
                if (rows[r] & (1 << (4 - c))) ctx.fillRect(4 + c, 3 + r, 1, 1);
            }
        }
        tex.refresh();
        applyTextureSampling(tex, TextureSampling.PIXEL_ART);
        return key;
    }

    update() {
        const main = this.scene.get('MainScene');
        if (!main) return;
        // This scene updates after MainScene (scene-list order), so the main
        // camera's scroll/zoom are final for this frame when we copy them.
        const source = main.cameras.main;
        const cam = this.cameras.main;
        cam.setZoom(source.zoom);
        cam.setScroll(source.scrollX, source.scrollY);
    }
}
