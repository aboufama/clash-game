
import Phaser from 'phaser';

/**
 * ProjectileRenderer — the rigid projectile shapes fired by defenses and
 * troops, extracted verbatim from MainScene so they can be baked into
 * sprite frames.
 *
 * Every function draws at the LOCAL origin (0,0), unrotated: directional
 * shapes (arrows, bolts, shells) point along +x exactly as they were drawn
 * inline in MainScene before setRotation; the dragon rocket stands nose-up
 * (-y) as it does in its silo. Positioning, rotation, tweens, trails and
 * impact FX stay with the call sites in MainScene.
 *
 * Dynamic-geometry projectiles (tesla bolts, storm lightning, prism beam)
 * are NOT here — their shapes depend on both endpoints per frame and
 * cannot bake to a fixed sprite.
 */
export class ProjectileRenderer {

    /** Archer troop arrow — identical to the nocked arrow in TroopRenderer. */
    static drawArcherArrow(g: Phaser.GameObjects.Graphics) {
        g.fillStyle(0x4a341f, 1);
        g.fillRect(-4.5, -0.6, 9, 1.2);
        g.fillStyle(0xaab0ba, 1);
        g.fillTriangle(7, 0, 4.5, -1.4, 4.5, 1.4);
        g.fillStyle(0x2e7d32, 1);
        g.fillTriangle(-4.5, 0, -2.8, -1.6, -2.8, 1.6);
    }

    /** Mobile mortar (troop) shell. */
    static drawMobileMortarShell(g: Phaser.GameObjects.Graphics) {
        g.fillStyle(0x3a3a3a, 1);
        g.fillCircle(0, 0, 5);
        g.fillStyle(0x555555, 1);
        g.fillCircle(-1.5, -1.5, 2.5);
    }

    /** Cannonball (pixelated rectangle); L4 is the gold/marble variant. */
    static drawCannonball(g: Phaser.GameObjects.Graphics, level: number) {
        if (level >= 4) {
            // Gold cannonball with marble core
            g.fillStyle(0xb8860b, 1);
            g.fillRect(-7, -7, 14, 14);
            g.fillStyle(0xdaa520, 1);
            g.fillRect(-6, -6, 8, 8);
            g.fillStyle(0xffd700, 0.6);
            g.fillRect(-4, -4, 4, 4);
        } else {
            g.fillStyle(0x1a1a1a, 1);
            g.fillRect(-7, -7, 14, 14);
            g.fillStyle(0x3a3a3a, 1);
            g.fillRect(-6, -6, 8, 8);
        }
    }

    /** Defense mortar shell — level-based size, L4 gold-studded. */
    static drawMortarShell(g: Phaser.GameObjects.Graphics, level: number) {
        // Level-based scaling - L3 is 1.3x bigger
        const shellScale = level >= 3 ? 1.3 : 1.0;
        const shellRadius = 8 * shellScale;
        if (level >= 4) {
            // Gold-studded shell
            g.fillStyle(0xb8860b, 1);
            g.fillCircle(0, 0, shellRadius);
            g.fillStyle(0xdaa520, 1);
            g.fillCircle(-2 * shellScale, -2 * shellScale, 4 * shellScale);
            // Gold studs
            g.fillStyle(0xffd700, 0.9);
            g.fillCircle(shellRadius * 0.5, -shellRadius * 0.3, 1.5);
            g.fillCircle(-shellRadius * 0.3, shellRadius * 0.5, 1.5);
            g.fillCircle(shellRadius * 0.4, shellRadius * 0.4, 1.5);
            g.fillCircle(-shellRadius * 0.6, -shellRadius * 0.1, 1.5);
        } else {
            g.fillStyle(0x3a3a3a, 1);
            g.fillCircle(0, 0, shellRadius);
            g.fillStyle(0x5a5a5a, 1);
            g.fillCircle(-2 * shellScale, -2 * shellScale, 3 * shellScale);
            if (level >= 3) {
                g.fillStyle(0xaaaaaa, 0.6);
                g.fillCircle(-3 * shellScale, -3 * shellScale, 2);
            }
        }
    }

    /** Ballista bolt — huge spear matching the loaded bolt on the machine. */
    static drawBallistaBolt(g: Phaser.GameObjects.Graphics, level: number) {
        // L3: gold bolt, L2: grey, L1: wood
        g.fillStyle(level >= 3 ? 0xb8860b : 0x5d4e37, 1);
        g.fillRect(-24, -2.8, 48, 5.6);
        g.fillStyle(level >= 3 ? 0xffd700 : (level >= 2 ? 0x9a9aa6 : 0xa8845e), 0.8);
        g.fillRect(-24, -2.8, 48, 2);
        // Big leaf arrowhead
        g.fillStyle(level >= 3 ? 0xdaa520 : 0x3a3a3a, 1);
        g.beginPath();
        g.moveTo(35, 0);
        g.lineTo(27, -6);
        g.lineTo(24, 0);
        g.lineTo(27, 6);
        g.closePath();
        g.fillPath();
        // Fletching - Gold for L3, Grey for L2, Red for L1
        const fletchColor = level >= 3 ? 0xffd700 : (level >= 2 ? 0x444444 : 0xcc3333);
        g.fillStyle(fletchColor, 1);
        g.beginPath();
        g.moveTo(-24, 0);
        g.lineTo(-16, -8);
        g.lineTo(-8, 0);
        g.closePath();
        g.fillPath();
        g.beginPath();
        g.moveTo(-24, 0);
        g.lineTo(-16, 8);
        g.lineTo(-8, 0);
        g.closePath();
        g.fillPath();
    }

    /** X-Bow bolt — small, narrow arrow (shuttle). */
    static drawXbowBolt(g: Phaser.GameObjects.Graphics, level: number) {
        // L3: gold shaft, L2: grey, L1: wood
        g.fillStyle(level >= 3 ? 0xb8860b : 0x5d4e37, 1);
        g.fillRect(-6, -0.8, 12, 1.6);
        // Small arrowhead
        g.fillStyle(level >= 3 ? 0xdaa520 : 0x4a4a4a, 1);
        g.beginPath();
        g.moveTo(7, 0);
        g.lineTo(4, -2);
        g.lineTo(4, 2);
        g.closePath();
        g.fillPath();
        // Fletching - Gold for L3, Grey for L2, Red for L1
        const fletchColor = level >= 3 ? 0xffd700 : (level >= 2 ? 0x444444 : 0xcc4444);
        g.fillStyle(fletchColor, 0.8);
        g.beginPath();
        g.moveTo(-6, 0);
        g.lineTo(-4, -2);
        g.lineTo(-2, 0);
        g.closePath();
        g.fillPath();
    }

    /**
     * Dragon's Breath firecracker rocket — the canonical in-flight munition
     * MainScene spawns at the battery's launch mouth (nose-up at rotation 0).
     * Clears and redraws: MainScene calls this per frame while the rocket flies.
     * `exhaustFlicker` is the per-frame flicker input for the exhaust flame;
     * the current flame math is steady (MainScene passes 0) — the parameter
     * exists so per-frame variation stays an explicit, bakeable input.
     */
    static drawDragonRocket(g: Phaser.GameObjects.Graphics, level: number, exhaustFlicker: number) {
        void exhaustFlicker; // flame currently flicker-free; input reserved for the bake
        g.clear();

        // Ember-Wyrm Reliquary language (Dragons_breathB palette): a
        // charred-oak firework tube with a lacquer-red nose and a gilt
        // band. Deliberately SMALL — a fat arrow, not a log: total run
        // −9..+12 (~21 px, ~15 texels baked; the old rocket was 25).

        // Charred-oak body with a lit flank and a scorched seam
        g.fillStyle(level >= 2 ? 0x38291c : 0x33261b, 1); // OAK
        g.fillRect(-3, -4, 6, 11);
        g.fillStyle(level >= 2 ? 0x46331f : 0x41301e, 1); // OAK_LIT
        g.fillRect(-3, -4, 2.4, 11);
        g.fillStyle(0x160e08, 1); // SEAM
        g.fillRect(1.8, -4, 1.2, 11);

        // Gilt reliquary band (plain bronze at L1) + glint at max level
        g.fillStyle(level >= 2 ? 0xd8b25a : 0x7a6234, 1); // GILT / BRONZE
        g.fillRect(-3, 3.4, 6, 1.9);
        if (level >= 2) {
            g.fillStyle(0xffe9b0, 0.95); // FLASH_CORE
            g.fillRect(-2.1, 3.7, 1.3, 1.3);
        }

        // Lacquer-red nose cone with a lit edge
        g.fillStyle(level >= 2 ? 0xb0342a : 0x9c3026, 1); // RED
        g.beginPath();
        g.moveTo(0, -9);
        g.lineTo(-3, -4);
        g.lineTo(3, -4);
        g.closePath();
        g.fillPath();
        g.fillStyle(0xd8564a, 1); // RED_LIT
        g.beginPath();
        g.moveTo(0, -9);
        g.lineTo(-3, -4);
        g.lineTo(-0.7, -4);
        g.closePath();
        g.fillPath();

        // Dark-bronze tail fins (max level)
        if (level >= 2) {
            g.fillStyle(0x51401f, 1); // BRONZE_DK
            g.beginPath();
            g.moveTo(-3, 4.6);
            g.lineTo(-5, 8);
            g.lineTo(-3, 7.6);
            g.closePath();
            g.fillPath();
            g.beginPath();
            g.moveTo(3, 4.6);
            g.lineTo(5, 8);
            g.lineTo(3, 7.6);
            g.closePath();
            g.fillPath();
        }

        // Ember exhaust
        g.fillStyle(0xe06818, 0.95); // EMBER
        g.beginPath();
        g.moveTo(-2, 7);
        g.lineTo(0, 12);
        g.lineTo(2, 7);
        g.closePath();
        g.fillPath();
        g.fillStyle(0xffa040, 0.9); // EMBER_HI
        g.beginPath();
        g.moveTo(-1.1, 7);
        g.lineTo(0, 10.2);
        g.lineTo(1.1, 7);
        g.closePath();
        g.fillPath();
    }

    /** Ornithopter bomb — a simple iron sphere with a strap band and a lit
     *  fuse nub, dropped from the flying machine (mm_shell class, 1 level). */
    static drawOrnithopterBomb(g: Phaser.GameObjects.Graphics) {
        // Iron body
        g.fillStyle(0x23262b, 1);
        g.fillCircle(0, 0, 5.5);
        // Riveted strap band across the equator
        g.fillStyle(0x3c414a, 1);
        g.fillRect(-5.5, -1.2, 11, 2.4);
        g.fillStyle(0x565d68, 1);
        g.fillRect(-4.5, -1.2, 1.4, 1.2);
        g.fillRect(1.6, -1.2, 1.4, 1.2);
        // Top highlight
        g.fillStyle(0x4a5058, 1);
        g.fillCircle(-1.8, -2.2, 1.8);
        // Fuse collar + spark
        g.fillStyle(0x6b5a35, 1);
        g.fillRect(-1.2, -7, 2.4, 2.2);
        g.fillStyle(0xffb347, 0.95);
        g.fillCircle(0.6, -7.4, 1.1);
        g.fillStyle(0xfff3b0, 0.9);
        g.fillCircle(0.9, -7.7, 0.5);
    }

    /** Trebuchet stone — a round-hewn boulder, 3 material levels (field
     *  stone → dressed granite → pale marble with gold flecks). */
    static drawTrebuchetStone(g: Phaser.GameObjects.Graphics, level: number) {
        const body = level >= 3 ? 0xd9d2c0 : level >= 2 ? 0x8f8f96 : 0x8a7a64;
        const shade = level >= 3 ? 0xb4ad9a : level >= 2 ? 0x6b6b72 : 0x685c4a;
        const lit = level >= 3 ? 0xefe9d8 : level >= 2 ? 0xb0b0b8 : 0xa8967c;
        // Boulder body
        g.fillStyle(body, 1);
        g.fillCircle(0, 0, 8);
        // Under-shade (SE) + lit crown (NW light)
        g.fillStyle(shade, 1);
        g.fillCircle(2.2, 2.4, 5);
        g.fillStyle(body, 1);
        g.fillCircle(-0.6, -0.6, 6.2);
        g.fillStyle(lit, 1);
        g.fillCircle(-2.6, -2.8, 3.2);
        // Chisel facets
        g.fillStyle(shade, 0.85);
        g.fillRect(-1.5, 1.5, 4, 1.4);
        g.fillRect(3, -2.5, 2.4, 1.2);
        g.fillStyle(lit, 0.7);
        g.fillRect(-4.8, 0.5, 2.2, 1.2);
        if (level >= 3) {
            // Gold flecks — accents only (max-level rule)
            g.fillStyle(0xd4af37, 0.9);
            g.fillRect(1.6, -4.2, 1.2, 1.2);
            g.fillRect(-3.4, 2.6, 1.2, 1.2);
        }
    }

    /** Spike launcher ball — spiked boulder, 4 level material tiers. */
    static drawSpikeBall(g: Phaser.GameObjects.Graphics, level: number) {
        const spikeScale = level >= 4 ? 1.3 : (level >= 3 ? 1.2 : 1.0);
        let coreColor: number, spikeColor: number, highlightColor: number;
        if (level >= 4) {
            // White marble boulder with gold spikes
            coreColor = 0xeeeedd;
            spikeColor = 0xdaa520;
            highlightColor = 0xffd700;
        } else if (level >= 3) {
            // Dark iron with red-hot tips
            coreColor = 0x333333;
            spikeColor = 0x888888;
            highlightColor = 0xcc3300;
        } else {
            // Basic grey
            coreColor = 0x555555;
            spikeColor = 0xaaaaaa;
            highlightColor = 0xcccccc;
        }
        // Core/base
        g.fillStyle(coreColor, 1);
        g.fillCircle(0, 0, 6 * spikeScale);
        // Spikes
        g.fillStyle(spikeColor, 1);
        const s = spikeScale;
        // Top spikes
        g.fillTriangle(0, -6 * s, -3 * s, -14 * s, 3 * s, -14 * s);
        g.fillTriangle(-4 * s, -5 * s, -8 * s, -12 * s, -2 * s, -10 * s);
        g.fillTriangle(4 * s, -5 * s, 8 * s, -12 * s, 2 * s, -10 * s);
        // Bottom spikes
        g.fillTriangle(0, 6 * s, -3 * s, 14 * s, 3 * s, 14 * s);
        g.fillTriangle(-4 * s, 5 * s, -8 * s, 12 * s, -2 * s, 10 * s);
        g.fillTriangle(4 * s, 5 * s, 8 * s, 12 * s, 2 * s, 10 * s);
        // Side spikes
        g.fillTriangle(-6 * s, 0, -14 * s, -3 * s, -14 * s, 3 * s);
        g.fillTriangle(6 * s, 0, 14 * s, -3 * s, 14 * s, 3 * s);
        g.fillTriangle(-5 * s, -4 * s, -12 * s, -8 * s, -10 * s, -2 * s);
        g.fillTriangle(5 * s, -4 * s, 12 * s, -8 * s, 10 * s, -2 * s);
        g.fillTriangle(-5 * s, 4 * s, -12 * s, 8 * s, -10 * s, 2 * s);
        g.fillTriangle(5 * s, 4 * s, 12 * s, 8 * s, 10 * s, 2 * s);
        // Spike highlights / tips
        g.fillStyle(highlightColor, 0.8);
        g.fillTriangle(0, -7 * s, -1 * s, -12 * s, 1 * s, -12 * s);
        g.fillTriangle(-6 * s, -1 * s, -12 * s, 0, -12 * s, 2 * s);
        g.fillTriangle(6 * s, -1 * s, 12 * s, 0, 12 * s, 2 * s);
    }
}
