
import Phaser from 'phaser';
import { OBSTACLE_DEFINITIONS, type ObstacleType } from '../config/GameDefinitions';
import { IsoUtils } from '../utils/IsoUtils';

const OBSTACLES = OBSTACLE_DEFINITIONS as any;

export class ObstacleRenderer {
    /**
     * Stable per-obstacle hash (FNV-1a over the persisted id): the same patch
     * keeps its look — and its easter egg — across sessions and devices.
     */
    private static hashId(id: string | undefined): number {
        if (!id) return 0;
        let h = 2166136261;
        for (let i = 0; i < id.length; i++) {
            h ^= id.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    /**
     * What a grass patch's persisted id resolves to: which easter egg (0-3, or
     * null) and which regular variant (0 grass, 1 daisies, 2 reeds,
     * 3 mushrooms, 4 clover, 5 tulips). Gameplay (mushroom picking) and
     * rendering must agree, so both use this.
     */
    static grassLookOf(id: string | undefined): { egg: number | null; variant: number } {
        // A missing/empty id hashes to 0, and 0 % 2000 would ROLL THE
        // GOLDEN-MUSHROOM EGG — every un-persisted patch a rare find.
        // Guard them to the plain-grass look instead.
        if (!id) return { egg: null, variant: 0 };
        const hash = this.hashId(id);
        const eggRoll = hash % 2000;
        if (eggRoll < 4) return { egg: eggRoll, variant: -1 };
        const weighted = hash % 12;
        return { egg: null, variant: weighted < 7 ? 0 : weighted - 6 };
    }

    /**
     * Per-type sway loop periods — exact 250 ms multiples so baked sway
     * loops close seamlessly (bake-sprites.mjs reads this table for each
     * type's loopMs; every sway term below is an exact harmonic of it).
     */
    static readonly SWAY_MS: Record<string, number> = {
        tree_oak: 5000,
        tree_pine: 4500,
        grass_patch: 3000
    };

    static drawObstacle(graphics: Phaser.GameObjects.Graphics, obstacle: { type: ObstacleType, gridX: number, gridY: number, animOffset: number, id?: string }, time: number = 0) {
        const info = OBSTACLES[obstacle.type];
        if (!info) return; // unknown type must never crash the draw loop
        const center = IsoUtils.cartToIso(obstacle.gridX + info.width / 2, obstacle.gridY + info.height / 2);
        const hash = this.hashId(obstacle.id);
        // Real per-obstacle desync: a millisecond phase offset derived from
        // the persisted id hash. (The legacy animOffset field mixed radians
        // and ms semantics across callers and shifted a multi-second sway by
        // at most ~6 ms — obstacles were never actually desynced.)
        const t = time + hash % (ObstacleRenderer.SWAY_MS[obstacle.type] ?? 1);

        graphics.clear();

        switch (obstacle.type) {
            case 'rock_small':
                this.drawSmallRock(graphics, center);
                break;
            case 'rock_large':
                this.drawLargeRock(graphics, center);
                break;
            case 'tree_oak':
                this.drawOakTree(graphics, center, t, hash);
                break;
            case 'tree_pine':
                this.drawPineTree(graphics, center, t, hash);
                break;
            case 'grass_patch':
                this.drawGrassPatch(graphics, center, t, hash);
                break;
        }
    }

    private static drawSmallRock(graphics: Phaser.GameObjects.Graphics, center: Phaser.Math.Vector2) {
        const x = center.x;
        const y = center.y;

        // Ground contact shadow (very subtle, touching the rock)
        graphics.fillStyle(0x3a3a3a, 0.25);
        graphics.fillEllipse(x, y + 2, 16, 5);

        // Flat stone base sitting ON the ground (isometric diamond shape)
        graphics.fillStyle(0x6a6a6a, 1);
        graphics.beginPath();
        graphics.moveTo(x, y - 4); // top
        graphics.lineTo(x + 10, y + 1); // right
        graphics.lineTo(x, y + 6); // bottom
        graphics.lineTo(x - 10, y + 1); // left
        graphics.closePath();
        graphics.fillPath();

        // Top surface (lighter, slightly raised)
        graphics.fillStyle(0x8a8a8a, 1);
        graphics.beginPath();
        graphics.moveTo(x, y - 6); // top
        graphics.lineTo(x + 8, y - 1); // right
        graphics.lineTo(x, y + 3); // bottom
        graphics.lineTo(x - 8, y - 1); // left
        graphics.closePath();
        graphics.fillPath();

        // Highlight on top-left edge
        graphics.fillStyle(0x9a9a9a, 0.7);
        graphics.beginPath();
        graphics.moveTo(x - 6, y - 2);
        graphics.lineTo(x, y - 5);
        graphics.lineTo(x + 2, y - 3);
        graphics.lineTo(x - 4, y);
        graphics.closePath();
        graphics.fillPath();

        // Small texture details (crevices)
        graphics.lineStyle(1, 0x5a5a5a, 0.6);
        graphics.lineBetween(x - 3, y, x + 3, y + 1);
    }

    private static drawLargeRock(graphics: Phaser.GameObjects.Graphics, center: Phaser.Math.Vector2) {
        const x = center.x;
        const y = center.y;

        // Ground contact shadow (subtle, directly under rocks)
        graphics.fillStyle(0x3a3a3a, 0.2);
        graphics.fillEllipse(x, y + 6, 40, 12);

        // Main stone slab (flat isometric, sitting on ground)
        graphics.fillStyle(0x5a5a5a, 1);
        graphics.beginPath();
        graphics.moveTo(x, y - 8); // top
        graphics.lineTo(x + 18, y); // right
        graphics.lineTo(x, y + 10); // bottom
        graphics.lineTo(x - 18, y); // left
        graphics.closePath();
        graphics.fillPath();

        // Top surface of main slab (lighter)
        graphics.fillStyle(0x7a7a7a, 1);
        graphics.beginPath();
        graphics.moveTo(x, y - 10); // top
        graphics.lineTo(x + 15, y - 2); // right
        graphics.lineTo(x, y + 6); // bottom
        graphics.lineTo(x - 15, y - 2); // left
        graphics.closePath();
        graphics.fillPath();

        // Second smaller stone (overlapping, slight offset)
        graphics.fillStyle(0x6a6a6a, 1);
        graphics.beginPath();
        graphics.moveTo(x + 8, y - 12); // top
        graphics.lineTo(x + 18, y - 6); // right
        graphics.lineTo(x + 10, y); // bottom
        graphics.lineTo(x, y - 6); // left
        graphics.closePath();
        graphics.fillPath();

        // Top of second stone
        graphics.fillStyle(0x8a8a8a, 1);
        graphics.beginPath();
        graphics.moveTo(x + 8, y - 14);
        graphics.lineTo(x + 16, y - 8);
        graphics.lineTo(x + 10, y - 3);
        graphics.lineTo(x + 2, y - 8);
        graphics.closePath();
        graphics.fillPath();

        // Third small stone (bottom left area)
        graphics.fillStyle(0x5a5a5a, 1);
        graphics.beginPath();
        graphics.moveTo(x - 10, y + 2);
        graphics.lineTo(x - 4, y + 6);
        graphics.lineTo(x - 8, y + 10);
        graphics.lineTo(x - 14, y + 6);
        graphics.closePath();
        graphics.fillPath();

        // Highlight on main stone
        graphics.fillStyle(0x9a9a9a, 0.6);
        graphics.beginPath();
        graphics.moveTo(x - 10, y - 4);
        graphics.lineTo(x, y - 8);
        graphics.lineTo(x + 4, y - 6);
        graphics.lineTo(x - 6, y - 2);
        graphics.closePath();
        graphics.fillPath();

        // Moss patch between stones
        graphics.fillStyle(0x4a6a4a, 0.5);
        graphics.fillCircle(x - 4, y + 3, 3);
        graphics.fillCircle(x + 6, y - 3, 2);

        // Crevice details
        graphics.lineStyle(1, 0x4a4a4a, 0.5);
        graphics.lineBetween(x - 8, y, x + 4, y + 2);
        graphics.lineBetween(x + 2, y - 4, x + 8, y - 2);
    }

    // Foliage shade families so a forest isn't a single flat green.
    private static readonly OAK_PALETTES = [
        [0x2a6a2a, 0x3a8a3a, 0x4a9a4a],
        [0x2a6a3a, 0x3a8a52, 0x50a862],
        [0x3d6d26, 0x548c32, 0x6aa242]
    ];
    private static readonly PINE_PALETTES = [
        [0x1a5a2a, 0x2a6a3a, 0x3a7a4a],
        [0x184f33, 0x266344, 0x357a55],
        [0x2a5a22, 0x3a6e2e, 0x4c823c]
    ];

    private static drawOakTree(graphics: Phaser.GameObjects.Graphics, center: Phaser.Math.Vector2, time: number, hash: number = 0) {
        const x = center.x;
        const y = center.y;
        const sway = Math.sin(time * (Math.PI * 2) / ObstacleRenderer.SWAY_MS.tree_oak) * 2;

        // Shadow
        graphics.fillStyle(0x333333, 0.3);
        graphics.fillEllipse(x + 5, y + 20, 40, 16);

        // Trunk
        graphics.fillStyle(0x5a3a2a, 1);
        graphics.beginPath();
        graphics.moveTo(x - 6, y + 15);
        graphics.lineTo(x - 4 + sway * 0.3, y - 15);
        graphics.lineTo(x + 4 + sway * 0.3, y - 15);
        graphics.lineTo(x + 6, y + 15);
        graphics.closePath();
        graphics.fillPath();

        // Trunk bark detail
        graphics.lineStyle(1, 0x4a2a1a, 0.6);
        graphics.lineBetween(x - 2, y + 10, x - 1 + sway * 0.2, y - 10);
        graphics.lineBetween(x + 2, y + 12, x + 1 + sway * 0.2, y - 8);

        // Foliage layers (bottom to top)
        const foliageColors = this.OAK_PALETTES[hash % this.OAK_PALETTES.length];
        const foliageLayers = [
            { yOff: -20, size: 24, sway: sway * 0.5 },
            { yOff: -30, size: 20, sway: sway * 0.7 },
            { yOff: -40, size: 16, sway: sway * 1.0 }
        ];

        foliageLayers.forEach((layer, i) => {
            graphics.fillStyle(foliageColors[i], 1);
            graphics.fillEllipse(x + layer.sway, y + layer.yOff, layer.size, layer.size * 0.6);
        });

        // Highlight spots on top layer
        graphics.fillStyle(0x5aaa5a, 0.5);
        graphics.fillCircle(x - 4 + sway, y - 42, 4);
        graphics.fillCircle(x + 6 + sway, y - 38, 3);
    }

    private static drawPineTree(graphics: Phaser.GameObjects.Graphics, center: Phaser.Math.Vector2, time: number, hash: number = 0) {
        const x = center.x;
        const y = center.y;
        const sway = Math.sin(time * (Math.PI * 2) / ObstacleRenderer.SWAY_MS.tree_pine) * 1.5;

        // Shadow
        graphics.fillStyle(0x333333, 0.3);
        graphics.fillEllipse(x + 3, y + 12, 20, 8);

        // Trunk
        graphics.fillStyle(0x5a3a2a, 1);
        graphics.beginPath();
        graphics.moveTo(x - 3, y + 10);
        graphics.lineTo(x - 2 + sway * 0.2, y - 10);
        graphics.lineTo(x + 2 + sway * 0.2, y - 10);
        graphics.lineTo(x + 3, y + 10);
        graphics.closePath();
        graphics.fillPath();

        // Pine layers (triangular)
        const pineColors = this.PINE_PALETTES[hash % this.PINE_PALETTES.length];
        const layers = [
            { yOff: -5, width: 18, height: 12, sway: sway * 0.3 },
            { yOff: -15, width: 14, height: 12, sway: sway * 0.6 },
            { yOff: -25, width: 10, height: 12, sway: sway * 0.9 },
            { yOff: -34, width: 6, height: 10, sway: sway * 1.2 }
        ];

        layers.forEach((layer, i) => {
            graphics.fillStyle(pineColors[Math.min(i, 2)], 1);
            graphics.beginPath();
            graphics.moveTo(x + layer.sway, y + layer.yOff - layer.height);
            graphics.lineTo(x + layer.width / 2 + layer.sway * 0.5, y + layer.yOff);
            graphics.lineTo(x - layer.width / 2 + layer.sway * 0.5, y + layer.yOff);
            graphics.closePath();
            graphics.fillPath();
        });
    }

    /**
     * Grass patches come in several looks, chosen deterministically from the
     * obstacle's persisted id. Plain grass dominates (7 in 12); flowers,
     * reeds, mushrooms, clover and tulips are the uncommon finds — and four
     * super-rare easter eggs (~1 in 2000 each) hide among them: a golden
     * mushroom, a four-leaf clover, a rainbow tulip and a tiny garden gnome.
     * Because patches persist in the village save, a lucky egg stays put.
     */
    private static drawGrassPatch(graphics: Phaser.GameObjects.Graphics, center: Phaser.Math.Vector2, time: number, hash: number = 0) {
        const x = center.x;
        const y = center.y;

        const eggRoll = hash % 2000;
        // hash === 0 means "no persisted id" (hashId's guard) — same rule as
        // grassLookOf: an un-persisted patch never wins an easter egg.
        const isEgg = hash !== 0 && eggRoll < 4;
        const weighted = hash % 12;
        const variant = isEgg ? -1 : (weighted < 7 ? 0 : weighted - 6);
        // All grass-patch sway terms are exact harmonics of the shared
        // 3000 ms loop, so the baked sway closes for every variant and egg.
        const gw = (Math.PI * 2) / ObstacleRenderer.SWAY_MS.grass_patch;

        // Base grass blades (sparser when props share the patch)
        const bladeCount = variant === 0 ? 8 : 5;
        for (let i = 0; i < bladeCount; i++) {
            const bx = x + (i - bladeCount / 2) * (32 / bladeCount) + Math.sin(i * 2 + hash) * 3;
            const by = y + Math.cos(i * 3) * 4;
            const sway = Math.sin(time * gw + i * 0.5) * 2;
            const height = (variant === 2 ? 15 : 10) + Math.sin(i * 1.5) * 4;

            const grassColor = i % 2 === 0 ? 0x4a8a4a : 0x5a9a5a;
            graphics.lineStyle(2, grassColor, 0.9);
            graphics.beginPath();
            graphics.moveTo(bx, by);
            graphics.lineTo(bx + sway, by - height);
            graphics.strokePath();
        }

        // Ground accent
        graphics.fillStyle(0x3a6a3a, 0.3);
        graphics.fillEllipse(x, y + 2, 16, 6);

        if (isEgg) {
            this.drawGrassEasterEgg(graphics, x, y, time, eggRoll);
            return;
        }

        switch (variant) {
            case 1: { // Daisies
                for (let i = 0; i < 3; i++) {
                    const fx = x + (i - 1) * 7 + Math.sin(hash + i * 5) * 2;
                    const fy = y - 4 + Math.cos(hash + i * 3) * 3;
                    const sway = Math.sin(time * gw + i) * 1.2;
                    graphics.lineStyle(1.2, 0x3f7a3f, 0.9);
                    graphics.lineBetween(fx, fy + 6, fx + sway, fy);
                    graphics.fillStyle(0xf5f2e8, 1);
                    for (let p = 0; p < 5; p++) {
                        const a = (p / 5) * Math.PI * 2;
                        graphics.fillCircle(fx + sway + Math.cos(a) * 2.2, fy + Math.sin(a) * 2.2, 1.3);
                    }
                    graphics.fillStyle(0xf2c84b, 1);
                    graphics.fillCircle(fx + sway, fy, 1.5);
                }
                break;
            }
            case 2: { // Tall reeds with cattail heads
                for (let i = 0; i < 3; i++) {
                    const rx = x + (i - 1) * 5;
                    const sway = Math.sin(time * gw + i * 0.8) * 2.5;
                    graphics.lineStyle(1.6, 0x5c8a3c, 1);
                    graphics.lineBetween(rx, y + 2, rx + sway, y - 16);
                    graphics.fillStyle(0x7a5230, 1);
                    graphics.fillEllipse(rx + sway, y - 17, 2.6, 5.5);
                }
                break;
            }
            case 3: { // Mushroom cluster
                for (let i = 0; i < 3; i++) {
                    const mx = x + (i - 1) * 6 + Math.sin(hash + i) * 2;
                    const my = y + 1 + (i % 2) * 2;
                    const capW = 5 - (i % 2);
                    graphics.fillStyle(0xe6dcc8, 1);
                    graphics.fillRect(mx - 1, my - 3.5, 2, 3.5);
                    graphics.fillStyle(i === 1 ? 0xa8543a : 0x8a6a4a, 1);
                    graphics.fillEllipse(mx, my - 4, capW * 2, capW);
                    graphics.fillStyle(0xf0e8d8, 0.9);
                    graphics.fillCircle(mx - 1.5, my - 4.5, 0.7);
                }
                break;
            }
            case 4: { // Clover carpet
                graphics.fillStyle(0x2f6b2f, 0.9);
                for (let i = 0; i < 6; i++) {
                    const cx2 = x + Math.sin(hash * 3 + i * 7) * 9;
                    const cy2 = y + Math.cos(hash * 5 + i * 4) * 4;
                    graphics.fillCircle(cx2 - 1.2, cy2, 1.2);
                    graphics.fillCircle(cx2 + 1.2, cy2, 1.2);
                    graphics.fillCircle(cx2, cy2 - 1.4, 1.2);
                }
                break;
            }
            case 5: { // Wildflowers (tulips)
                const tulipColors = [0xd06a9c, 0x9c6ad0, 0xd0806a];
                for (let i = 0; i < 2; i++) {
                    const fx = x + (i === 0 ? -5 : 6) + Math.sin(hash + i * 9) * 2;
                    const fy = y - 3;
                    const sway = Math.sin(time * gw + i * 2) * 1.4;
                    graphics.lineStyle(1.2, 0x3f7a3f, 0.9);
                    graphics.lineBetween(fx, fy + 7, fx + sway, fy);
                    const c = tulipColors[(hash + i) % tulipColors.length];
                    graphics.fillStyle(c, 1);
                    graphics.fillEllipse(fx + sway, fy - 1, 4, 5);
                    graphics.fillTriangle(fx + sway - 2, fy - 3, fx + sway, fy - 5, fx + sway + 2, fy - 3);
                }
                break;
            }
            // case 0: classic grass — blades only
        }
    }

    /** The four super-rare finds. Lucky bases get one growing wild.
     *  Every time term is an exact harmonic of the 3000 ms grass loop. */
    private static drawGrassEasterEgg(graphics: Phaser.GameObjects.Graphics, x: number, y: number, time: number, egg: number) {
        const gw = (Math.PI * 2) / ObstacleRenderer.SWAY_MS.grass_patch;
        switch (egg) {
            case 0: { // Golden mushroom — softly pulsing glow and sparkles
                const pulse = 0.5 + Math.sin(time * gw * 2) * 0.3;
                graphics.fillStyle(0xffd54a, 0.18 * pulse);
                graphics.fillEllipse(x, y - 4, 22, 14);
                graphics.fillStyle(0xf0e8d8, 1);
                graphics.fillRect(x - 1.6, y - 4, 3.2, 5);
                graphics.fillStyle(0xe8b52a, 1);
                graphics.fillEllipse(x, y - 5.5, 12, 6.5);
                graphics.fillStyle(0xffe98a, 1);
                graphics.fillCircle(x - 3, y - 6.5, 1.2);
                graphics.fillCircle(x + 2.5, y - 5, 0.9);
                // Orbiting sparkle (one orbit per loop)
                const sa = time * gw;
                graphics.fillStyle(0xfff2b8, 0.9 * pulse);
                graphics.fillCircle(x + Math.cos(sa) * 9, y - 7 + Math.sin(sa) * 3, 1);
                break;
            }
            case 1: { // Four-leaf clover — one big lucky charm
                const sway = Math.sin(time * gw) * 1;
                graphics.fillStyle(0x3fae4a, 0.16);
                graphics.fillEllipse(x, y - 3, 18, 11);
                graphics.lineStyle(1.4, 0x2f7b35, 1);
                graphics.lineBetween(x, y + 4, x + sway, y - 3);
                graphics.fillStyle(0x46c452, 1);
                for (let p = 0; p < 4; p++) {
                    const a = (p / 4) * Math.PI * 2 + Math.PI / 4;
                    const lx = x + sway + Math.cos(a) * 3.4;
                    const ly = y - 5 + Math.sin(a) * 3.4;
                    graphics.fillCircle(lx - 0.9, ly - 0.6, 1.7);
                    graphics.fillCircle(lx + 0.9, ly - 0.6, 1.7);
                    graphics.fillTriangle(lx - 2.2, ly, lx + 2.2, ly, lx, ly + 2.6);
                }
                break;
            }
            case 2: { // Rainbow tulip — petals slowly cycle through the rainbow
                const hue = (time / 3000) % 1;
                const petal = Phaser.Display.Color.HSVToRGB(hue, 0.65, 0.95) as Phaser.Types.Display.ColorObject;
                const petalColor = ((petal.r & 0xff) << 16) | ((petal.g & 0xff) << 8) | (petal.b & 0xff);
                const sway = Math.sin(time * gw) * 1.6;
                graphics.fillStyle(petalColor, 0.14);
                graphics.fillEllipse(x, y - 6, 18, 12);
                graphics.lineStyle(1.5, 0x3f7a3f, 1);
                graphics.lineBetween(x, y + 5, x + sway, y - 4);
                graphics.fillStyle(petalColor, 1);
                graphics.fillEllipse(x + sway, y - 6, 5.5, 7);
                graphics.fillTriangle(x + sway - 2.8, y - 9, x + sway, y - 12, x + sway + 2.8, y - 9);
                graphics.fillStyle(0xffffff, 0.5);
                graphics.fillCircle(x + sway - 1.2, y - 7.5, 1);
                break;
            }
            default: { // Tiny garden gnome standing in the grass
                const bob = Math.sin(time * gw) * 0.6;
                // Body
                graphics.fillStyle(0x3a5a9c, 1);
                graphics.fillEllipse(x, y - 2 + bob, 6, 6.5);
                // Beard
                graphics.fillStyle(0xf0ece2, 1);
                graphics.fillTriangle(x - 2.6, y - 5 + bob, x + 2.6, y - 5 + bob, x, y + 0.5 + bob);
                // Face
                graphics.fillStyle(0xe6b98a, 1);
                graphics.fillCircle(x, y - 5.5 + bob, 2.2);
                // Pointy red hat
                graphics.fillStyle(0xc23b2e, 1);
                graphics.fillTriangle(x - 3, y - 6.5 + bob, x + 3, y - 6.5 + bob, x + 0.6, y - 14 + bob);
                // Nose
                graphics.fillStyle(0xd9a06a, 1);
                graphics.fillCircle(x + 0.6, y - 5 + bob, 0.9);
                break;
            }
        }
    }
}
