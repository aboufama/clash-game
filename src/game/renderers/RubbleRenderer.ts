
import Phaser from 'phaser';
import { IsoUtils } from '../utils/IsoUtils';

export class RubbleRenderer {
    static drawRubble(graphics: Phaser.GameObjects.Graphics, gridX: number, gridY: number, width: number, height: number, time: number = 0, fireIntensity: number = 1) {
        const c1 = IsoUtils.cartToIso(gridX, gridY);
        const c2 = IsoUtils.cartToIso(gridX + width, gridY);
        const c3 = IsoUtils.cartToIso(gridX + width, gridY + height);
        const c4 = IsoUtils.cartToIso(gridX, gridY + height);
        const center = IsoUtils.cartToIso(gridX + width / 2, gridY + height / 2);

        // Base rubble pile (dark shadow)
        graphics.fillStyle(0x2a2a2a, 0.5);
        graphics.fillPoints([c1, c2, c3, c4], true);

        // Debris count scales with building size
        const debrisCount = width * height * 5;
        const seed = gridX * 1000 + gridY; // Consistent random per location
        const isLarge = width >= 3 || height >= 3;

        // For large rubble (3x3), add significant structural pieces
        if (isLarge) {
            // Collapsed wall sections
            for (let i = 0; i < 4; i++) {
                const rand1 = Math.sin(seed + i * 11.11) * 0.5 + 0.5;
                const rand2 = Math.cos(seed + i * 12.22) * 0.5 + 0.5;
                const wx = center.x + (rand1 - 0.5) * width * 30;
                const wy = center.y + (rand2 - 0.5) * height * 15;

                const wallLen = 15 + rand1 * 10;
                const wallHeight = 8 + rand2 * 6;

                // Wall segment (collapsed stone wall piece)
                graphics.fillStyle(0x6a6a6a, 0.9);
                graphics.beginPath();
                graphics.moveTo(wx - wallLen * 0.5, wy);
                graphics.lineTo(wx + wallLen * 0.5, wy);
                graphics.lineTo(wx + wallLen * 0.4, wy - wallHeight);
                graphics.lineTo(wx - wallLen * 0.3, wy - wallHeight * 0.8);
                graphics.closePath();
                graphics.fillPath();

                // Shadow
                graphics.fillStyle(0x3a3a3a, 0.4);
                graphics.beginPath();
                graphics.moveTo(wx - wallLen * 0.5, wy);
                graphics.lineTo(wx + wallLen * 0.5, wy);
                graphics.lineTo(wx + wallLen * 0.6, wy + 4);
                graphics.lineTo(wx - wallLen * 0.4, wy + 3);
                graphics.closePath();
                graphics.fillPath();
            }

            // Large broken pillars/columns
            for (let i = 0; i < 2; i++) {
                const rand1 = Math.sin(seed + i * 20.1) * 0.5 + 0.5;
                const rand2 = Math.cos(seed + i * 21.2) * 0.5 + 0.5;
                const px = center.x + (rand1 - 0.5) * width * 20;
                const py = center.y + (rand2 - 0.5) * height * 10;

                // Fallen pillar
                graphics.fillStyle(0x8a7a6a, 0.9);
                graphics.fillRect(px - 12, py - 4, 24, 8);
                graphics.fillStyle(0x9a8a7a, 1);
                graphics.fillRect(px - 10, py - 6, 20, 4);
            }
        }

        // Scattered stone chunks
        for (let i = 0; i < debrisCount; i++) {
            const rand1 = Math.sin(seed + i * 1.23) * 0.5 + 0.5;
            const rand2 = Math.cos(seed + i * 2.34) * 0.5 + 0.5;
            const rand3 = Math.sin(seed + i * 3.45) * 0.5 + 0.5;

            const px = center.x + (rand1 - 0.5) * width * 32;
            const py = center.y + (rand2 - 0.5) * height * 16;
            const size = isLarge ? (4 + rand3 * 8) : (3 + rand3 * 6);

            // Stone colors vary
            const stoneColors = [0x8a8a8a, 0x6a6a6a, 0x5a5a5a, 0x7a6a5a, 0x9a8a7a];
            const colorIdx = Math.min(stoneColors.length - 1, Math.floor(rand1 * stoneColors.length));

            graphics.fillStyle(stoneColors[colorIdx], 0.9);
            // Draw irregular stone shapes
            graphics.beginPath();
            graphics.moveTo(px, py - size * 0.6);
            graphics.lineTo(px + size * 0.5, py - size * 0.2);
            graphics.lineTo(px + size * 0.4, py + size * 0.4);
            graphics.lineTo(px - size * 0.3, py + size * 0.5);
            graphics.lineTo(px - size * 0.5, py);
            graphics.closePath();
            graphics.fillPath();
        }

        // Broken wood beams (for larger buildings)
        if (width >= 2 || height >= 2) {
            const beamCount = isLarge ? 6 : Math.floor((width + height) / 2);
            for (let i = 0; i < beamCount; i++) {
                const rand1 = Math.sin(seed + i * 5.67 + 100) * 0.5 + 0.5;
                const rand2 = Math.cos(seed + i * 6.78 + 100) * 0.5 + 0.5;
                const rand3 = Math.sin(seed + i * 7.89 + 100) * 0.5 + 0.5;

                const bx = center.x + (rand1 - 0.5) * width * 26;
                const by = center.y + (rand2 - 0.5) * height * 13;
                const angle = rand3 * Math.PI;
                const length = isLarge ? (12 + rand1 * 18) : (8 + rand1 * 12);

                graphics.lineStyle(isLarge ? 4 : 3, 0x5a3a2a, 0.8);
                graphics.lineBetween(
                    bx - Math.cos(angle) * length,
                    by - Math.sin(angle) * length * 0.5,
                    bx + Math.cos(angle) * length,
                    by + Math.sin(angle) * length * 0.5
                );

                // Charred ends for large rubble (pixelated)
                if (isLarge) {
                    graphics.fillStyle(0x2a1a0a, 0.7);
                    const cx = bx - Math.cos(angle) * length;
                    const cy = by - Math.sin(angle) * length * 0.5;
                    graphics.fillRect(cx - 2, cy - 2, 5, 5);
                }
            }
        }

        // Dust/ash patches - use rectangles for pixelated look
        for (let i = 0; i < debrisCount / 2; i++) {
            const rand1 = Math.sin(seed + i * 9.01 + 200) * 0.5 + 0.5;
            const rand2 = Math.cos(seed + i * 0.12 + 200) * 0.5 + 0.5;

            const dx = center.x + (rand1 - 0.5) * width * 28;
            const dy = center.y + (rand2 - 0.5) * height * 14;
            const size = 4 + rand1 * 4;

            graphics.fillStyle(0x4a4a4a, 0.3);
            graphics.fillRect(dx - size / 2, dy - size / 2, size, size);
        }

        // BURNING EFFECTS for large (3x3) rubble - fades out over time
        // All effects use rectangles for consistent pixelation
        if (isLarge && time > 0) {
            // Fire spots - fade out based on fireIntensity
            if (fireIntensity > 0.05) {
                for (let i = 0; i < 4; i++) {
                    const rand1 = Math.sin(seed + i * 30.3) * 0.5 + 0.5;
                    const rand2 = Math.cos(seed + i * 31.4) * 0.5 + 0.5;
                    const fx = center.x + (rand1 - 0.5) * width * 20;
                    const fy = center.y + (rand2 - 0.5) * height * 10;

                    const flicker = Math.sin(time / 100 + i * 2) * 0.3 + 0.7;
                    const fireSize = Math.floor((6 + Math.sin(time / 150 + i) * 3) * fireIntensity);

                    // Orange glow base (rectangle)
                    const glowSize = fireSize + 6;
                    graphics.fillStyle(0xff6600, 0.4 * flicker * fireIntensity);
                    graphics.fillRect(fx - glowSize / 2, fy - glowSize / 2, glowSize, glowSize);

                    // Fire core (rectangle)
                    graphics.fillStyle(0xff4400, 0.7 * flicker * fireIntensity);
                    graphics.fillRect(fx - fireSize / 2, fy - 2 - fireSize / 2, fireSize, fireSize);

                    // Yellow flame tip (small rectangle)
                    const tipSize = Math.max(2, fireSize * 0.5);
                    const tipY = fy - 5 - Math.sin(time / 80 + i) * 2;
                    graphics.fillStyle(0xffaa00, 0.8 * flicker * fireIntensity);
                    graphics.fillRect(fx - tipSize / 2, tipY - tipSize / 2, tipSize, tipSize);
                }

                // Rising embers - small pixel particles
                for (let i = 0; i < 6; i++) {
                    const rand1 = Math.sin(seed + i * 40.4) * 0.5 + 0.5;
                    const rand2 = Math.cos(seed + i * 41.5) * 0.5 + 0.5;
                    const emberCycle = ((time / 2000) + rand1) % 1;

                    const ex = center.x + (rand1 - 0.5) * width * 15 + Math.sin(time / 300 + i) * 5;
                    const ey = center.y + (rand2 - 0.5) * height * 8 - emberCycle * 30;
                    const emberAlpha = (1 - emberCycle) * 0.8 * fireIntensity;

                    graphics.fillStyle(0xff6600, emberAlpha);
                    graphics.fillRect(ex - 1, ey - 1, 3, 3); // 3x3 pixel ember
                }
            }

            // Smoke wisps - INCREASE as fire fades out (smoldering effect)
            // Use rectangles for pixelated smoke
            const smokeIntensity = 1 - fireIntensity * 0.5; // More smoke as fire fades
            const smokeCount = fireIntensity > 0.3 ? 3 : 5; // More smoke when fire is low
            for (let i = 0; i < smokeCount; i++) {
                const rand1 = Math.sin(seed + i * 50.5) * 0.5 + 0.5;
                const rand2 = Math.cos(seed + i * 51.6) * 0.5 + 0.5;
                const smokeCycle = ((time / 3000) + rand1) % 1;

                const sx = center.x + (rand1 - 0.5) * width * 12 + Math.sin(time / 500 + i) * 8;
                const sy = center.y + (rand2 - 0.5) * height * 6 - smokeCycle * 50;
                const smokeAlpha = (1 - smokeCycle) * 0.3 * smokeIntensity;
                const smokeSize = Math.floor((4 + smokeCycle * 10) * smokeIntensity);

                graphics.fillStyle(0x555555, smokeAlpha);
                graphics.fillRect(sx - smokeSize / 2, sy - smokeSize / 2, smokeSize, smokeSize);
            }
        }
    }

}
