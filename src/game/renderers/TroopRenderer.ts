import Phaser from 'phaser';
import type { TroopType } from '../config/GameDefinitions';

type G = Phaser.GameObjects.Graphics;

/**
 * TroopRenderer — every troop is hand-drawn layered vector art (no sprites).
 *
 * THE SCALE CONTRACT (the villager rule): humanoid troops are the same
 * species as the VillageLifeSystem villagers. Villagers draw ~23px tall and
 * render at 0.8 scale (~18.5px on screen); battle troops render at scale 1,
 * so every humanoid here is drawn ~19-21px head-to-toe (ground at y≈+9.5,
 * head top ≈ -11). Weapons/hats may poke a few px higher — bodies must not.
 * Machines and monsters (golem, da vinci tank, ram trunk) keep their bulk,
 * but any human crew on them uses this same villager scale. The giant is
 * deliberately ~2x a villager — big, but the same world.
 *
 * THE ANIMATION CONTRACT: all motion is a deterministic function of the
 * `time` parameter — sines and phases, never Math.random() per frame.
 * Attack animation keys off `attackAge` = ms since this troop's last damage
 * tick (MainScene passes `time - troop.lastAttackTime`):
 *   - the WIND-UP plays in the last `windupMs` BEFORE the next tick
 *     (remaining = attackDelay - attackAge), so anticipation peaks exactly
 *     when damage fires;
 *   - the STRIKE/impact plays in the first `strikeMs` AFTER the tick.
 * Stale ages (> delay + 600ms — replay troops never update lastAttackTime)
 * free-run on `time % attackDelay` so replays stay alive. attackAge < 0
 * means "not in combat" (army-camp figures): pure idle, no weapon poses.
 */

/** Attack-cycle animation state — see the contract above. */
interface AttackAnim {
    /** 0→1 anticipation ramp during the last `windupMs` before the tick. */
    windup: number;
    /** 1→0 impact decay during the first `strikeMs` after the tick. */
    strike: number;
    /** ms since the damage tick (Infinity when not in combat). */
    age: number;
    inCombat: boolean;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeIn = (t: number): number => t * t;

export class TroopRenderer {
    /** ms after the damage tick at which the sharpshooter's ball leaves the
     *  muzzle — MainScene's projectile delay and the renderer's flash/recoil
     *  keyframes both read this so they can never drift apart. */
    static readonly MUSKET_FIRE_MS = 330;

    static drawTroopVisual(
        graphics: G,
        type: TroopType,
        owner: 'PLAYER' | 'ENEMY',
        facingAngle: number = 0,
        isMoving: boolean = true,
        slamOffset: number = 0,
        bowDrawProgress: number = 0,
        mortarRecoil: number = 0,
        isDeactivated: boolean = false,
        phalanxSpearOffset: number = 0,
        troopLevel: number = 1,
        time: number = Date.now(),
        attackAge: number = -1,
        attackDelay: number = 0
    ) {
        void bowDrawProgress; // legacy sharpshooter tween driver — pose now keys off attackAge
        const isPlayer = owner === 'PLAYER';

        switch (type) {
            case 'warrior':
                TroopRenderer.drawWarrior(graphics, isPlayer, isMoving, troopLevel, time, attackAge, attackDelay);
                break;
            case 'archer':
                TroopRenderer.drawArcher(graphics, isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay);
                break;
            case 'giant':
                TroopRenderer.drawGiant(graphics, isPlayer, isMoving, troopLevel, time, attackAge, attackDelay);
                break;
            case 'golem':
                TroopRenderer.drawGolem(graphics, isPlayer, isMoving, slamOffset, troopLevel, time);
                break;
            case 'sharpshooter':
                TroopRenderer.drawSharpshooter(graphics, isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay);
                break;
            case 'mobilemortar':
                TroopRenderer.drawMobileMortar(graphics, isPlayer, isMoving, facingAngle, mortarRecoil, troopLevel, time, attackAge, attackDelay);
                break;
            case 'ward':
                TroopRenderer.drawWard(graphics, isPlayer, isMoving, troopLevel, time, attackAge, attackDelay);
                break;
            case 'recursion':
                TroopRenderer.drawRecursion(graphics, isPlayer, isMoving, troopLevel, time, attackAge, attackDelay);
                break;
            case 'ram':
                TroopRenderer.drawRam(graphics, isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay);
                break;
            case 'stormmage':
                TroopRenderer.drawStormMage(graphics, isPlayer, isMoving, troopLevel, time, attackAge, attackDelay);
                break;
            case 'davincitank':
                TroopRenderer.drawDaVinciTank(graphics, isPlayer, isMoving, isDeactivated, facingAngle, troopLevel, time);
                break;
            case 'phalanx':
                TroopRenderer.drawPhalanx(graphics, isPlayer, isMoving, facingAngle, phalanxSpearOffset, troopLevel, time);
                break;
            case 'romanwarrior':
                TroopRenderer.drawRomanSoldier(graphics, isPlayer, isMoving, facingAngle, false, 0, 0, 0, 0, troopLevel, time, attackAge, attackDelay);
                break;
            case 'wallbreaker':
                TroopRenderer.drawWallBreaker(graphics, isPlayer, isMoving, troopLevel, time, attackAge, attackDelay);
                break;
        }
    }

    // ================= villager-scale humanoid toolkit =================

    /** Soft contact shadow under a humanoid. */
    private static hShadow(g: G, w: number = 9.5, y: number = 9.6): void {
        g.fillStyle(0x000000, 0.22);
        g.fillEllipse(0, y, w, w * 0.38);
    }

    /**
     * The shared gait/idle rig. Walking: legs/arms swing ±strideLen with a
     * little hop; standing: a slow breath (use `lift` for the chest rise and
     * `breathe` (-1..1) for anything that should sway with it).
     */
    private static hRig(time: number, isMoving: boolean, stride: number, strideLen: number, seed: number = 0): { swing: number; lift: number; breathe: number; ph: number } {
        if (isMoving) {
            const ph = ((time + seed * 137) % stride) / stride;
            const s = Math.sin(ph * Math.PI * 2);
            return { swing: s * strideLen, lift: Math.abs(s) * 1.2, breathe: 0, ph };
        }
        const b = Math.sin((time + seed * 251) / 640);
        return { swing: 0, lift: Math.max(0, b) * 0.4, breathe: b, ph: 0 };
    }

    /** Trouser legs + planted feet (the villager leg grammar). */
    private static hLegs(g: G, trouser: number, swing: number, lift: number, spread: number = 1.6, boot: number = 0x2a211a): void {
        g.fillStyle(trouser, 1);
        g.fillRect(-spread - 1 - swing, 3.5 - lift, 2, 5.5 + lift);
        g.fillRect(spread - 1 + swing, 3.5 - lift, 2, 5.5 + lift);
        g.fillStyle(boot, 1);
        g.fillEllipse(-spread - swing, 9.2, 3, 1.6);
        g.fillEllipse(spread + swing, 9.2, 3, 1.6);
    }

    /** Round tunic torso + belt line, optionally leaned by `ox`. */
    private static hTorso(g: G, tunic: number, dark: number, lift: number, r: number = 4.3, ox: number = 0): void {
        g.fillStyle(tunic, 1);
        g.fillCircle(ox, -1 - lift, r);
        g.fillStyle(dark, 1);
        g.fillRect(ox - r + 0.4, 1 - lift, (r - 0.4) * 2, 1.8);
    }

    /** Head at villager proportions (+ optional hair arc). */
    private static hHead(g: G, skin: number, lift: number, hair?: number, ox: number = 0): void {
        g.fillStyle(skin, 1);
        g.fillCircle(ox, -7 - lift, 3);
        if (hair !== undefined) {
            g.fillStyle(hair, 1);
            g.beginPath();
            g.arc(ox, -7.6 - lift, 3, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
        }
    }

    /** One limb segment drawn as a thick quad from (x0,y0) to (x1,y1). */
    private static hLimb(g: G, color: number, x0: number, y0: number, x1: number, y1: number, w: number = 1.9): void {
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
        g.fillStyle(color, 1);
        g.beginPath();
        g.moveTo(x0 + nx, y0 + ny);
        g.lineTo(x1 + nx, y1 + ny);
        g.lineTo(x1 - nx, y1 - ny);
        g.lineTo(x0 - nx, y0 - ny);
        g.closePath();
        g.fillPath();
    }

    /** Attack-cycle state locked to the damage tick — see the file header. */
    private static attackAnim(time: number, attackAge: number, attackDelay: number, windupMs: number, strikeMs: number): AttackAnim {
        if (attackAge < 0 || attackDelay <= 0) return { windup: 0, strike: 0, age: Infinity, inCombat: false };
        let age = attackAge;
        if (age > attackDelay + 600) {
            // Stale tick (replay playback): free-run the cycle off the clock.
            age = time % attackDelay;
        }
        const remaining = attackDelay - age;
        let windup = 0;
        if (remaining <= 0) windup = 1;
        else if (remaining <= windupMs) windup = 1 - remaining / windupMs;
        const strike = strikeMs > 0 && age <= strikeMs ? 1 - age / strikeMs : 0;
        return { windup, strike, age, inCombat: true };
    }

    // ============================ WARRIOR ============================
    // Villager-scale swordsman: round shield left, arming sword right.
    // Attack: coil the blade behind the shoulder as the cooldown ends, cut
    // through a fast arc exactly on the damage tick, ease back to guard.
    private static drawWarrior(g: G, isPlayer: boolean, isMoving: boolean, troopLevel: number, time: number, attackAge: number, attackDelay: number): void {
        const rig = TroopRenderer.hRig(time, isMoving, 420, 2.2, 0);
        const atk = TroopRenderer.attackAnim(time, attackAge, attackDelay || 800, 280, 170);
        const lift = rig.lift;

        const skin = isPlayer ? 0xdeb887 : 0xc9a66b;
        const tunic = isPlayer ? 0x8b5a2b : 0x6b4a30;
        const tunicDark = isPlayer ? 0x5c3a1c : 0x47311d;
        const steel = troopLevel >= 3 ? 0xe2e6ee : 0xbfc5cf;
        const shieldWood = isPlayer ? 0x9c6a30 : 0x7a5528;
        const shieldRim = isPlayer ? 0x6a4520 : 0x4f371b;

        // ---- sword pose. Angle convention: 0 = blade straight up from the
        // hand, positive = swung forward (screen right). Guard rest ≈ -0.5.
        let swordA = -0.5;
        let lean = 0;       // body lean into the blow
        let arcAlpha = 0;   // motion-arc wedge during the cut
        let arcSweep = 0;
        if (!isMoving && atk.inCombat) {
            if (atk.strike > 0) {
                const sweep = clamp01(atk.age / 70);
                swordA = -1.35 + 2.65 * easeOut(sweep);
                lean = 1.6 * sweep;
                arcSweep = sweep;
                arcAlpha = sweep < 1 ? 0.45 : 0.45 * clamp01(1 - (atk.age - 70) / 100);
            } else if (atk.windup > 0) {
                swordA = -0.5 - 0.85 * easeOut(atk.windup);
                lean = -1.1 * atk.windup;
            } else if (atk.age <= 470) {
                // Recovery: ease from the follow-through back to guard.
                const t = clamp01((atk.age - 170) / 300);
                swordA = 1.3 - 1.8 * easeOut(t);
                lean = 1.6 * (1 - t);
            }
        } else if (isMoving) {
            swordA = -0.5 + rig.swing * 0.06;
        } else {
            // Ambient idle: breathe + a slow roll of the wrist.
            swordA = -0.5 + Math.sin(time / 1900) * 0.12;
        }

        TroopRenderer.hShadow(g);
        TroopRenderer.hLegs(g, tunicDark, rig.swing, lift);
        TroopRenderer.hTorso(g, tunic, tunicDark, lift, 4.3, lean * 0.5);

        // Chest strap
        g.lineStyle(1.1, tunicDark, 0.9);
        g.lineBetween(-2.6 + lean * 0.5, -3.6 - lift, 2.2 + lean * 0.5, 0.4 - lift);

        // ---- shield arm (left): a slight brace on the wind-up (kept wide
        // so it never muddles the torso silhouette).
        const shX = -4.4 + (atk.windup > 0 ? 0.5 * atk.windup : 0) + lean * 0.3;
        const shY = -0.8 - lift - (atk.windup > 0 ? 0.7 * atk.windup : 0);
        TroopRenderer.hLimb(g, skin, -2.6 + lean * 0.4, -2.6 - lift, shX, shY, 1.8);
        g.fillStyle(shieldRim, 1);
        g.fillCircle(shX - 0.6, shY, 3.1);
        g.fillStyle(shieldWood, 1);
        g.fillCircle(shX - 0.6, shY, 2.4);
        g.fillStyle(troopLevel >= 2 ? 0xdaa520 : 0x565b64, 1);
        g.fillCircle(shX - 0.6, shY, 0.9);

        // ---- head (after torso, under the sword arm)
        TroopRenderer.hHead(g, skin, lift, troopLevel >= 2 ? undefined : 0x4a341f, lean * 0.7);
        if (troopLevel >= 2) {
            // Steel half-helm with a nose bar.
            const hx = lean * 0.7;
            g.fillStyle(0x565b64, 1);
            g.beginPath();
            g.arc(hx, -7.4 - lift, 3.3, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
            g.fillStyle(0x8a8f99, 1);
            g.beginPath();
            g.arc(hx, -7.6 - lift, 2.7, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
            g.fillStyle(0x565b64, 1);
            g.fillRect(hx - 0.7, -8 - lift, 1.4, 2.6);
            if (troopLevel >= 3) {
                // Gold band + a short crimson plume — accents, not masses.
                g.fillStyle(0xdaa520, 1);
                g.fillRect(hx - 3.2, -7.8 - lift, 6.4, 1);
                g.fillStyle(0xa8322a, 1);
                g.fillRect(hx - 0.6, -12.2 - lift, 1.2, 2.6);
            }
        }

        // ---- sword arm (right): hand orbits the shoulder, blade beyond it.
        const sx = 2.8 + lean * 0.5;
        const sy = -2.8 - lift;
        const handA = 0.45 + (swordA + 0.5) * 0.75; // 0 = hanging straight down
        const hx = sx + Math.sin(handA) * 3.6;
        const hy = sy + Math.cos(handA) * 3.6;
        TroopRenderer.hLimb(g, skin, sx, sy, hx, hy, 1.8);

        const bs = Math.sin(swordA), bc = Math.cos(swordA);
        // Grip (behind the hand)
        g.fillStyle(0x3a2a15, 1);
        g.fillRect(hx - bs * 1.3 - 0.7, hy + bc * 1.3 - 0.7, 1.4, 1.4);
        // Crossguard
        TroopRenderer.hLimb(g, troopLevel >= 3 ? 0xdaa520 : 0x6a6f78, hx - bc * 1.5, hy - bs * 1.5, hx + bc * 1.5, hy + bs * 1.5, 1.1);
        // Blade: a tapering quad with a bright edge.
        const tipX = hx + bs * 8.2;
        const tipY = hy - bc * 8.2;
        g.fillStyle(steel, 1);
        g.beginPath();
        g.moveTo(hx - bc * 1.05, hy - bs * 1.05);
        g.lineTo(tipX, tipY);
        g.lineTo(hx + bc * 1.05, hy + bs * 1.05);
        g.closePath();
        g.fillPath();
        g.lineStyle(0.7, 0xf2f5f9, troopLevel >= 3 ? 0.9 : 0.75);
        g.lineBetween(hx + bc * 0.3, hy + bs * 0.3, tipX, tipY);
        // Fist over the grip
        g.fillStyle(skin, 1);
        g.fillCircle(hx, hy, 1.4);

        // Motion arc while the cut sweeps through.
        if (arcAlpha > 0) {
            const a0 = -1.35 - Math.PI / 2;
            const a1 = a0 + 2.65 * easeOut(arcSweep);
            g.lineStyle(2.2, 0xf5f2e8, arcAlpha);
            g.beginPath();
            g.arc(hx, hy, 8.2, a0, a1, false);
            g.strokePath();
        }
    }

    // ============================ ARCHER ============================
    // Hooded villager-scale ranger. Attack: nock + draw as the cooldown
    // ends, loose exactly on the tick (string snaps home, arrow leaves).
    private static drawArcher(g: G, isPlayer: boolean, isMoving: boolean, facingAngle: number, troopLevel: number, time: number, attackAge: number, attackDelay: number): void {
        const rig = TroopRenderer.hRig(time, isMoving, 380, 2.4, 1);
        const atk = TroopRenderer.attackAnim(time, attackAge, attackDelay || 900, 380, 150);
        const lift = rig.lift;

        const cloak = isPlayer ? 0x2e7d32 : 0xa03028;
        const cloakDark = isPlayer ? 0x1b5e20 : 0x6e211c;
        const skin = 0xdeb887;
        const fa = facingAngle || 0;
        const ax = Math.cos(fa), ay = Math.sin(fa);

        TroopRenderer.hShadow(g, 8.5);
        TroopRenderer.hLegs(g, cloakDark, rig.swing, lift, 1.4);

        // Quiver rides the hip opposite the aim.
        const qs = ax >= 0 ? -1 : 1;
        TroopRenderer.hLimb(g, 0x5d4037, qs * 2.2, -2.6 - lift, qs * 4, -8.2 - lift, 2.4);
        g.fillStyle(0x8b7355, 1);
        g.fillRect(qs * 3.3 - 0.4, -10 - lift, 0.9, 2.2);
        g.fillRect(qs * 4.1 - 0.4, -9.4 - lift, 0.9, 1.8);
        if (troopLevel >= 2) {
            g.fillStyle(0xdaa520, 1);
            g.fillTriangle(qs * 2.9, -10.6 - lift, qs * 3.7, -10.6 - lift, qs * 3.3, -11.6 - lift);
            g.fillTriangle(qs * 3.7, -10 - lift, qs * 4.5, -10 - lift, qs * 4.1, -11 - lift);
        }

        TroopRenderer.hTorso(g, cloak, cloakDark, lift, 4);
        if (troopLevel >= 2) {
            g.fillStyle(0xdaa520, 1);
            g.fillCircle(0, -3.4 - lift, 0.9); // cloak clasp
        }

        // Hooded head: dark cowl, shadowed face, two bright eyes.
        g.fillStyle(cloakDark, 1);
        g.fillCircle(0, -7 - lift, 3.2);
        g.fillStyle(cloak, 1);
        g.beginPath();
        g.arc(0, -7.4 - lift, 3.2, Math.PI * 0.9, Math.PI * 0.1, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(0x140e08, 1);
        g.fillCircle(ax * 0.6, -6.8 - lift, 2);
        const eyeColor = troopLevel >= 3 ? 0x7dff9a : 0xffe9c4;
        g.fillStyle(eyeColor, troopLevel >= 3 ? 0.95 : 0.85);
        g.fillCircle(ax * 0.6 - 0.9, -7 - lift, 0.55);
        g.fillCircle(ax * 0.6 + 0.9, -7 - lift, 0.55);

        // ---- bow at arm's reach toward the aim.
        const idleDrop = (!atk.inCombat && !isMoving) ? 1.6 : 0; // bow rests low out of combat
        const bx = ax * (5.2 - idleDrop * 0.8);
        const by = -4 - lift + ay * 2.6 + idleDrop;

        // String pull: nocked at rest, drawn to the cheek on wind-up, snaps
        // home (tiny overshoot) on the tick.
        let pull = 1.1;
        if (!isMoving && atk.inCombat) {
            if (atk.windup > 0) pull = 1.1 + 3.9 * easeOut(atk.windup);
            else if (atk.strike > 0) pull = 0.25 + 0.85 * (1 - atk.strike);
        }

        // Bow arm (front) — from the chest to the grip.
        TroopRenderer.hLimb(g, skin, ax * 1.4, -3.4 - lift, bx, by, 1.7);

        // Bow: simple circular limbs read cleanly at any aim.
        const R = 5.2;
        g.lineStyle(1.6, troopLevel >= 3 ? 0x8a5a28 : 0x7a4a26, 1);
        g.beginPath();
        g.arc(bx, by, R, fa - 1.22, fa + 1.22, false);
        g.strokePath();
        const t1x = bx + Math.cos(fa - 1.22) * R, t1y = by + Math.sin(fa - 1.22) * R;
        const t2x = bx + Math.cos(fa + 1.22) * R, t2y = by + Math.sin(fa + 1.22) * R;
        if (troopLevel >= 3) {
            g.fillStyle(0xdaa520, 1);
            g.fillCircle(t1x, t1y, 0.8);
            g.fillCircle(t2x, t2y, 0.8);
        }

        // String through the nock point.
        const nx = bx - ax * pull, ny = by - ay * pull;
        g.lineStyle(0.8, 0xd8d3c4, 0.95);
        g.lineBetween(t1x, t1y, nx, ny);
        g.lineBetween(nx, ny, t2x, t2y);

        // Arrow only while drawing (it leaves on the tick).
        if (!isMoving && atk.inCombat && atk.windup > 0.12) {
            const alen = 6.8;
            g.lineStyle(1.1, 0x4a341f, 1);
            g.lineBetween(nx, ny, nx + ax * alen, ny + ay * alen);
            g.fillStyle(0xaab0ba, 1);
            const hxp = nx + ax * (alen + 1.6), hyp = ny + ay * (alen + 1.6);
            g.fillTriangle(hxp, hyp, nx + ax * alen - ay * 1.1, ny + ay * alen + ax * 1.1, nx + ax * alen + ay * 1.1, ny + ay * alen - ax * 1.1);
            // Draw arm reaching to the nock.
            TroopRenderer.hLimb(g, skin, -ax * 1.2, -3.6 - lift, nx, ny, 1.6);
            g.fillStyle(skin, 1);
            g.fillCircle(nx, ny, 1.1);
        }
        // Release flash: a tiny shiver at the bow as the string slaps home.
        if (atk.strike > 0.55) {
            g.lineStyle(1, 0xfffbe8, (atk.strike - 0.55) * 0.9);
            g.lineBetween(bx - ay * 2.4, by + ax * 2.4, bx + ay * 2.4, by - ax * 2.4);
        }
    }

    // ========================= SHARPSHOOTER =========================
    // Elite marksman with a long musket (was an oversized archer). Walks at
    // port arms; shoulders the piece as the cooldown ends; on the tick the
    // hammer falls — flash, recoil kick and a drifting powder plume, all
    // keyed to MUSKET_FIRE_MS so the ball leaves with the flash.
    private static drawSharpshooter(g: G, isPlayer: boolean, isMoving: boolean, facingAngle: number, troopLevel: number, time: number, attackAge: number, attackDelay: number): void {
        const rig = TroopRenderer.hRig(time, isMoving, 430, 2.2, 2);
        const atk = TroopRenderer.attackAnim(time, attackAge, attackDelay || 1400, 420, 0);
        const lift = rig.lift;
        const FIRE = TroopRenderer.MUSKET_FIRE_MS;

        const coat = isPlayer ? 0x33691e : 0x5d4037;
        const coatDark = isPlayer ? 0x1f4212 : 0x3e2c23;
        const skin = 0xe8d4b8;
        const fa = facingAngle || 0;
        const ax = Math.cos(fa);
        const ays = (d: number) => Math.sin(fa) * 0.5 * d; // iso squash along aim

        // Shoulder-raise: up during the wind-up, held through the shot,
        // lowered back to port ~600ms after the tick.
        let raise = 0;
        if (!isMoving && atk.inCombat) {
            if (atk.windup > 0) raise = easeOut(atk.windup);
            else if (atk.age <= 620) raise = 1;
            else if (atk.age <= 900) raise = 1 - easeIn((atk.age - 620) / 280);
        }
        // Recoil kick right after the ball leaves.
        const sinceFire = atk.age - FIRE;
        const kick = (raise > 0 && sinceFire >= 0 && sinceFire < 260) ? Math.exp(-sinceFire / 70) * 1.8 : 0;

        TroopRenderer.hShadow(g, 9);
        TroopRenderer.hLegs(g, coatDark, rig.swing, lift, 1.6);

        // Long coat tail (a small trapezoid behind the legs).
        g.fillStyle(coatDark, 1);
        g.beginPath();
        g.moveTo(-3.4, 1.5 - lift);
        g.lineTo(3.4, 1.5 - lift);
        g.lineTo(2.6 - rig.swing * 0.4, 6.5);
        g.lineTo(-2.6 - rig.swing * 0.4, 6.5);
        g.closePath();
        g.fillPath();

        const lean = raise * ax * 0.7 - kick * ax * 0.5;
        TroopRenderer.hTorso(g, coat, coatDark, lift, 4.1, lean);
        // Powder horn strap
        g.lineStyle(1, 0x4a341f, 0.9);
        g.lineBetween(-2.4 + lean, -3.8 - lift, 2.6 + lean, 0.6 - lift);

        // Head: cheek drops toward the stock when aiming.
        const hx = lean + raise * ax * 0.6;
        TroopRenderer.hHead(g, skin, lift + raise * 0.4, undefined, hx);
        // Flat-brim marksman hat.
        g.fillStyle(0x3e2c23, 1);
        g.fillEllipse(hx, -9 - lift + raise * 0.4, 7.6, 2);
        g.beginPath();
        g.arc(hx, -9.2 - lift + raise * 0.4, 2.6, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        if (troopLevel >= 2) {
            g.fillStyle(0xdaa520, 1);
            g.fillRect(hx - 2.4, -9.6 - lift + raise * 0.4, 4.8, 0.9);
        }
        if (troopLevel >= 3) {
            // White feather plume — a subtle accent.
            g.fillStyle(0xe8e4da, 0.95);
            g.fillTriangle(hx + 1.8, -10 - lift, hx + 4.6, -13.2 - lift, hx + 2.8, -9.6 - lift);
        }

        // ---- musket: interpolate port-arms → shouldered along the aim.
        const barrelLen = troopLevel >= 3 ? 12 : 10.8;
        // Port pose endpoints (fixed diagonal across the body)
        const pBx = -2.6, pBy = 1 - lift, pMx = 3.4, pMy = -7.8 - lift;
        // Shouldered pose endpoints (along facing, butt at the shoulder)
        const sBx = -ax * 2.2 - kick * ax, sBy = -6.4 - lift + ays(-2.2) + 0.7;
        const sMx = ax * barrelLen - kick * ax, sMy = -7 - lift + ays(barrelLen) - kick * 0.15;
        const bxp = pBx + (sBx - pBx) * raise, byp = pBy + (sBy - pBy) * raise;
        const mxp = pMx + (sMx - pMx) * raise, myp = pMy + (sMy - pMy) * raise;

        // Wood stock: the back 40% of the piece, thicker.
        const stX = bxp + (mxp - bxp) * 0.38, stY = byp + (myp - byp) * 0.38;
        TroopRenderer.hLimb(g, 0x5d4037, bxp, byp, stX, stY, 2.5);
        // Barrel
        TroopRenderer.hLimb(g, 0x757b85, stX, stY, mxp, myp, 1.4);
        g.fillStyle(0x2a2d33, 1);
        g.fillCircle(mxp, myp, 0.9);
        if (troopLevel >= 2) {
            g.fillStyle(0xdaa520, 1);
            const b1x = bxp + (mxp - bxp) * 0.55, b1y = byp + (myp - byp) * 0.55;
            g.fillCircle(b1x, b1y, 1);
        }
        // Hands: trigger hand at the stock, support hand up the barrel.
        TroopRenderer.hLimb(g, skin, lean + 2.4, -2.8 - lift, stX, stY, 1.7);
        const supX = bxp + (mxp - bxp) * 0.62, supY = byp + (myp - byp) * 0.62;
        TroopRenderer.hLimb(g, skin, lean - 1.8, -2.6 - lift, supX, supY, 1.7);
        g.fillStyle(skin, 1);
        g.fillCircle(stX, stY, 1.2);
        g.fillCircle(supX, supY, 1.2);

        // ---- the shot: flash + powder smoke, keyed to MUSKET_FIRE_MS.
        if (raise > 0.9 && sinceFire >= 0) {
            if (sinceFire < 85) {
                const fl = 1 - sinceFire / 85;
                g.fillStyle(0xffd27a, 0.75 * fl);
                g.fillCircle(mxp + ax * 1.4, myp + ays(1.4), 2.6);
                g.fillStyle(0xfff3d0, 0.9 * fl);
                for (let i = 0; i < 4; i++) {
                    const sa = fa + (i - 1.5) * 0.5;
                    g.fillTriangle(
                        mxp + ax * 0.8, myp + ays(0.8),
                        mxp + Math.cos(sa) * 4.4, myp + Math.sin(sa) * 0.5 * 4.4 - 0.4,
                        mxp + Math.cos(sa + 0.16) * 2.2, myp + Math.sin(sa + 0.16) * 0.5 * 2.2
                    );
                }
            }
            // Powder plume: puffs rolling out of the muzzle, drifting up.
            for (let i = 0; i < 4; i++) {
                const p = clamp01((sinceFire - i * 80) / 640);
                if (p > 0 && p < 1) {
                    g.fillStyle(0xd9d4c8, 0.5 * (1 - p));
                    g.fillCircle(
                        mxp + ax * (1.6 + p * 8 + i * 1.2) - Math.sin(fa) * (i - 1.5) * 0.8,
                        myp + ays(1.6 + p * 8) - p * (5 + i * 1.4),
                        1.5 + p * 3.4
                    );
                }
            }
        }
    }

    // =========================== STORM MAGE ===========================
    // Robed villager-scale caster. Attack: both hands raise the staff as
    // the charge builds (motes spiral in), then a glyph ring flashes over
    // the crystal exactly on the tick while the chain lightning fires.
    private static drawStormMage(g: G, isPlayer: boolean, isMoving: boolean, troopLevel: number, time: number, attackAge: number, attackDelay: number): void {
        const rig = TroopRenderer.hRig(time, isMoving, 480, 1.8, 3);
        const atk = TroopRenderer.attackAnim(time, attackAge, attackDelay || 1700, 620, 380);
        const lift = rig.lift;

        const robe = isPlayer ? 0x3344aa : 0x8e2a26;
        const robeDark = isPlayer ? 0x232b77 : 0x5e1a17;
        const skin = isPlayer ? 0xdeb887 : 0xc9a66b;
        const glow = 0x9fd8ff;
        const wu = (!isMoving && atk.inCombat) ? atk.windup : 0;
        const st = (!isMoving && atk.inCombat) ? atk.strike : 0;

        TroopRenderer.hShadow(g, 9);

        // Robe skirt (no visible legs) with a hem that sways on the march.
        const hem = isMoving ? rig.swing * 0.5 : 0;
        g.fillStyle(robeDark, 1);
        g.beginPath();
        g.moveTo(-3.6, 0.8 - lift * 0.5);
        g.lineTo(3.6, 0.8 - lift * 0.5);
        g.lineTo(4.4 + hem, 9.4);
        g.lineTo(-4.4 + hem, 9.4);
        g.closePath();
        g.fillPath();
        g.fillStyle(robe, 1);
        g.beginPath();
        g.moveTo(-3, 0.8 - lift * 0.5);
        g.lineTo(3, 0.8 - lift * 0.5);
        g.lineTo(3.6 + hem, 8.6);
        g.lineTo(-3.6 + hem, 8.6);
        g.closePath();
        g.fillPath();
        if (troopLevel >= 2) {
            g.lineStyle(0.9, 0xdaa520, 0.85);
            g.lineBetween(-3.9 + hem, 8.9, 3.9 + hem, 8.9);
        }

        TroopRenderer.hTorso(g, robe, robeDark, lift, 3.9);
        // Gold sash
        g.fillStyle(0xc9a227, 1);
        g.fillRect(-3.2, 0.4 - lift, 6.4, 1.3);

        // Head + pointed hat (tip sways with the stride / the breath).
        TroopRenderer.hHead(g, skin, lift);
        g.fillStyle(0x2a3a8a, 1);
        g.fillCircle(-1.1, -7 - lift, 0.7);
        g.fillCircle(1.1, -7 - lift, 0.7);
        const tipSway = isMoving ? rig.swing * 0.5 : rig.breathe * 0.4;
        g.fillStyle(robeDark, 1);
        g.fillEllipse(0, -8.9 - lift, 8.6, 2.4);
        g.fillStyle(robe, 1);
        g.fillTriangle(-3.1, -9.1 - lift, 3.1, -9.1 - lift, tipSway, -14.6 - lift);
        g.fillStyle(robeDark, 1);
        g.fillTriangle(-1.1, -11.4 - lift, 1.9, -11.4 - lift, tipSway, -14.6 - lift);
        if (troopLevel >= 2) {
            // Small gold star on the cone.
            g.fillStyle(0xffd700, 0.95);
            g.fillTriangle(-0.9, -10.6 - lift, 0.9, -10.6 - lift, 0, -12.2 - lift);
            g.fillTriangle(-0.9, -11.6 - lift, 0.9, -11.6 - lift, 0, -10 - lift);
        }
        if (troopLevel >= 3) {
            g.lineStyle(0.9, 0xc9ccd4, 0.9);
            g.lineBetween(-3.1, -9.4 - lift, 3.1, -9.4 - lift);
        }

        // ---- staff: planted at rest, raised two-handed to cast.
        const plant = isMoving ? Math.max(0, Math.sin(rig.ph * Math.PI * 2)) * 1 : 0;
        const stfX = 4.6 - 1.1 * wu + (isMoving ? rig.swing * 0.35 : 0);
        const stfTop = -11.5 - lift - 3.4 * wu - plant * 0.4;
        const stfBot = 8.2 - lift * 0.5 - 3.4 * wu - plant;
        g.lineStyle(1.5, 0x5d4e37, 1);
        g.lineBetween(stfX, stfTop, stfX, stfBot);
        // Casting hand on the staff; free hand rises with the charge.
        TroopRenderer.hLimb(g, robe, 2.6, -2.6 - lift, stfX, -3.4 - lift - 2.4 * wu, 1.8);
        g.fillStyle(skin, 1);
        g.fillCircle(stfX, -3.4 - lift - 2.4 * wu, 1.1);
        const palmX = -4.4 - 1.4 * wu, palmY = -3.6 - lift - 2.6 * wu;
        TroopRenderer.hLimb(g, robe, -2.4, -2.4 - lift, palmX, palmY, 1.8);
        g.fillStyle(skin, 1);
        g.fillCircle(palmX, palmY, 1.1);

        // Crystal + charge glow.
        const cX = stfX, cY = stfTop - 1.6;
        const pulse = 0.75 + Math.sin(time / 300) * 0.15;
        g.fillStyle(glow, (0.18 + 0.3 * wu) * pulse);
        g.fillCircle(cX, cY, 2.6 + 2.6 * wu);
        g.fillStyle(0x59c8ff, 0.95);
        g.fillCircle(cX, cY, 1.7);
        g.fillStyle(0xffffff, 0.85);
        g.fillCircle(cX - 0.5, cY - 0.5, 0.7);

        // Charge motes spiral INTO the crystal during the wind-up.
        if (wu > 0.05) {
            for (let i = 0; i < 2; i++) {
                const ma = time / 130 + i * Math.PI;
                const mr = (1 - wu) * 7 + 2.2;
                g.fillStyle(glow, 0.35 + 0.45 * wu);
                g.fillCircle(cX + Math.cos(ma) * mr, cY + Math.sin(ma) * mr * 0.6, 1);
            }
            g.fillStyle(glow, 0.5 * wu);
            g.fillCircle(palmX, palmY - 1.2, 1.3);
        }

        // GLYPH FLASH on the tick: rune ring + orbiting dots + two jags.
        if (st > 0) {
            const gy = cY - 3.4;
            g.lineStyle(1.1, glow, 0.85 * st);
            g.strokeCircle(cX, gy, 4.2);
            g.lineStyle(0.8, 0xffffff, 0.6 * st);
            g.strokeCircle(cX, gy, 2.5);
            for (let i = 0; i < 3; i++) {
                const da = atk.age / 110 + i * 2.094;
                g.fillStyle(0xdff2ff, 0.9 * st);
                g.fillCircle(cX + Math.cos(da) * 3.3, gy + Math.sin(da) * 3.3, 0.7);
            }
            g.lineStyle(1, 0xffffff, 0.8 * st);
            g.beginPath();
            g.moveTo(cX, cY);
            g.lineTo(cX + 2.4, cY - 2.6);
            g.lineTo(cX + 1.6, cY - 4.4);
            g.strokePath();
            g.beginPath();
            g.moveTo(cX, cY);
            g.lineTo(cX - 2.6, cY - 2);
            g.lineTo(cX - 1.8, cY - 4);
            g.strokePath();
            g.fillStyle(0xffffff, 0.7 * st);
            g.fillCircle(cX, cY, 1.9);
        }

        // Ambient: one lazy mote orbiting the crystal when nothing else is on.
        if (wu === 0 && st === 0) {
            const ma = time / 700;
            g.fillStyle(glow, 0.3 + Math.max(0, rig.breathe) * 0.15);
            g.fillCircle(cX + Math.cos(ma) * 3.6, cY + Math.sin(ma) * 2.2, 0.8);
        }
        // L3: a thin arc crackles between hat tip and crystal at full charge.
        if (troopLevel >= 3 && wu > 0.5) {
            g.lineStyle(0.8, glow, 0.35 * wu);
            g.lineBetween(tipSway, -14.6 - lift, cX, cY);
        }
    }

    // ============================= WARD =============================
    // The healer. Keeps its heal-radius aura (gameplay info); the figure is
    // a villager-scale hooded acolyte with an orb staff. Heal ticks raise
    // the free palm and send motes up; the orb flashes on the tick.
    private static drawWard(g: G, isPlayer: boolean, isMoving: boolean, troopLevel: number, time: number, attackAge: number, attackDelay: number): void {
        const rig = TroopRenderer.hRig(time, isMoving, 520, 1.6, 4);
        const atk = TroopRenderer.attackAnim(time, attackAge, attackDelay || 1000, 420, 300);
        const lift = rig.lift;

        const glow = isPlayer ? 0x58d68d : 0x45b39d;
        const robe = isPlayer ? 0x2ecc71 : 0x27ae60;
        const robeDark = isPlayer ? 0x1e8449 : 0x196f3d;
        const skin = isPlayer ? 0xdeb887 : 0xc9a66b;
        const wu = (!isMoving && atk.inCombat) ? atk.windup : 0;
        const st = (!isMoving && atk.inCombat) ? atk.strike : 0;

        // Heal-radius aura (kept: it communicates the heal range).
        const healRadiusPixels = 7 * 32;
        const pulseAlpha = 0.1 + Math.sin(time / 300) * 0.05;
        g.lineStyle(3, glow, pulseAlpha + 0.15);
        g.beginPath();
        const segments = 48;
        for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const noise = Math.sin(time / 25 + theta * 3) * 4 +
                Math.sin(time / 37 + theta * 7) * 2 +
                Math.sin(time / 20 + theta * 11) * 1.5;
            const rx = (healRadiusPixels + noise) * Math.cos(theta);
            const ry = ((healRadiusPixels / 2) + noise * 0.5) * Math.sin(theta);
            if (i === 0) g.moveTo(rx, 5 + ry);
            else g.lineTo(rx, 5 + ry);
        }
        g.closePath();
        g.strokePath();
        g.fillStyle(glow, pulseAlpha * 0.25);
        g.fillEllipse(0, 5, healRadiusPixels, healRadiusPixels / 2);

        TroopRenderer.hShadow(g, 9);

        // Robe skirt.
        const hem = isMoving ? rig.swing * 0.45 : 0;
        g.fillStyle(robeDark, 1);
        g.beginPath();
        g.moveTo(-3.5, 0.8 - lift * 0.5);
        g.lineTo(3.5, 0.8 - lift * 0.5);
        g.lineTo(4.3 + hem, 9.4);
        g.lineTo(-4.3 + hem, 9.4);
        g.closePath();
        g.fillPath();
        g.fillStyle(robe, 1);
        g.beginPath();
        g.moveTo(-2.9, 0.8 - lift * 0.5);
        g.lineTo(2.9, 0.8 - lift * 0.5);
        g.lineTo(3.5 + hem, 8.6);
        g.lineTo(-3.5 + hem, 8.6);
        g.closePath();
        g.fillPath();
        if (troopLevel >= 2) {
            g.lineStyle(0.9, 0xdaa520, 0.8);
            g.lineBetween(-3.8 + hem, 8.9, 3.8 + hem, 8.9);
        }

        TroopRenderer.hTorso(g, robe, robeDark, lift, 3.9);

        // Hooded head with an open face.
        g.fillStyle(robeDark, 1);
        g.fillCircle(0, -7.2 - lift, 3.2);
        g.fillStyle(skin, 1);
        g.fillCircle(0, -6.8 - lift, 2.3);
        g.fillStyle(robe, 1);
        g.beginPath();
        g.arc(0, -7.6 - lift, 3, Math.PI * 0.85, Math.PI * 0.15, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(0x2a5a1a, 1);
        g.fillCircle(-1, -6.8 - lift, 0.65);
        g.fillCircle(1, -6.8 - lift, 0.65);

        // Staff with the healing orb.
        const stfX = 4.6 + (isMoving ? rig.swing * 0.3 : 0);
        g.lineStyle(1.5, 0x5d4e37, 1);
        g.lineBetween(stfX, -10.5 - lift, stfX, 8.2 - lift * 0.5);
        TroopRenderer.hLimb(g, robe, 2.6, -2.6 - lift, stfX, -3 - lift, 1.8);
        g.fillStyle(skin, 1);
        g.fillCircle(stfX, -3 - lift, 1.1);

        const orbY = -12.2 - lift;
        const orbPulse = 0.75 + Math.sin(time / 260) * 0.15;
        g.fillStyle(0x88ffcc, orbPulse * (0.75 + 0.25 * st));
        g.fillCircle(stfX, orbY, 2.1 + 0.6 * st);
        g.fillStyle(0xffffff, 0.55 + 0.35 * st);
        g.fillCircle(stfX - 0.6, orbY - 0.6, 0.8);
        g.lineStyle(1, 0xaaffdd, 0.35 + 0.3 * st);
        g.strokeCircle(stfX, orbY, 3.6 + st);
        if (troopLevel >= 2) {
            g.lineStyle(0.8, 0xffd700, 0.45);
            g.strokeCircle(stfX, orbY, 3);
        }
        if (troopLevel >= 3) {
            g.lineStyle(0.7, glow, 0.3);
            g.strokeCircle(stfX, orbY, 4.6 + st * 0.6);
            g.fillStyle(0xffffff, 0.35);
            g.fillCircle(stfX, orbY, 1.2);
        }

        // Free palm: raised while the blessing gathers, motes rise on the tick.
        const palmX = -4.4 - wu, palmY = -4 - lift - 1.8 * wu;
        TroopRenderer.hLimb(g, robe, -2.4, -2.4 - lift, palmX, palmY, 1.8);
        g.fillStyle(skin, 1);
        g.fillCircle(palmX, palmY, 1.1);
        if (wu > 0.1) {
            g.fillStyle(glow, 0.5 * wu);
            g.fillCircle(palmX, palmY - 1.4, 1.2);
        }
        if (st > 0) {
            for (let i = 0; i < 3; i++) {
                const p = clamp01(atk.age / 300 + i * 0.12);
                if (p < 1) {
                    g.fillStyle(glow, 0.7 * (1 - p));
                    g.fillCircle(palmX - 2 + i * 2, palmY - p * 6 - 1, 1);
                }
            }
        }
        // Ambient: two soft motes drifting around her when idle.
        if (!isMoving && wu === 0 && st === 0) {
            for (let i = 0; i < 2; i++) {
                const ma = time / 480 + i * Math.PI;
                g.fillStyle(glow, 0.28);
                g.fillCircle(Math.cos(ma) * 5.4, -3 + Math.sin(ma) * 2.6, 0.9);
            }
        }
    }

    // ========================== WALL BREAKER ==========================
    // A small, very determined person carrying a lit powder keg overhead.
    private static drawWallBreaker(g: G, isPlayer: boolean, isMoving: boolean, troopLevel: number, time: number, attackAge: number, attackDelay: number): void {
        const rig = TroopRenderer.hRig(time, isMoving, 260, 2.6, 5);
        const atk = TroopRenderer.attackAnim(time, attackAge, attackDelay || 500, 240, 0);
        const lift = rig.lift;
        const lean = isMoving ? 1.1 : 0; // sprints hunched forward
        const brace = (!isMoving && atk.inCombat) ? atk.windup : 0;

        const skin = isPlayer ? 0xdeb887 : 0xc9a66b;
        const shirt = isPlayer ? 0x885533 : 0x664422;
        const shirtDark = isPlayer ? 0x5e3a22 : 0x47301a;

        TroopRenderer.hShadow(g, 8.5);
        TroopRenderer.hLegs(g, shirtDark, rig.swing, lift, 1.5);
        TroopRenderer.hTorso(g, shirt, shirtDark, lift + brace * -1, 3.7, lean);

        // Head tucked between the raised arms.
        TroopRenderer.hHead(g, skin, lift - 0.4 + brace * -1, undefined, lean);
        g.fillStyle(0x140e08, 0.85);
        g.fillCircle(lean - 1, -6.6 - lift, 0.6);
        g.fillCircle(lean + 1, -6.6 - lift, 0.6);
        g.fillStyle(troopLevel >= 2 ? 0xdaa520 : 0xcc3333, 1);
        g.fillRect(lean - 2.7, -8.6 - lift, 5.4, 1.4);

        // Arms straight up, holding the keg.
        const armBob = isMoving ? rig.swing * 0.35 : 0;
        const kegY = -12.6 - lift + armBob * 0.4 - brace * 2;
        TroopRenderer.hLimb(g, skin, lean - 2.4, -2.8 - lift, lean - 2.7, kegY + 3.4, 1.7);
        TroopRenderer.hLimb(g, skin, lean + 2.4, -2.8 - lift, lean + 2.7, kegY + 3.4, 1.7);

        // The keg.
        g.fillStyle(0x4a2f16, 1);
        g.fillEllipse(lean, kegY, 11, 7.4);
        g.fillStyle(0x5f3d1e, 1);
        g.fillEllipse(lean, kegY - 0.6, 9.2, 5.6);
        g.lineStyle(1.1, troopLevel >= 2 ? 0xdaa520 : 0x565b64, 0.9);
        g.strokeEllipse(lean, kegY, 11, 7.4);
        g.lineStyle(0.8, 0x3a2512, 0.7);
        g.lineBetween(lean - 2.4, kegY - 3.4, lean - 2.4, kegY + 3.4);
        g.lineBetween(lean + 2.4, kegY - 3.4, lean + 2.4, kegY + 3.4);
        if (troopLevel >= 3) {
            // Pale skull stencil.
            g.fillStyle(0xddd8cc, 0.75);
            g.fillCircle(lean, kegY - 0.4, 1.7);
            g.fillStyle(0x1a1208, 0.9);
            g.fillCircle(lean - 0.6, kegY - 0.7, 0.45);
            g.fillCircle(lean + 0.6, kegY - 0.7, 0.45);
        }
        // Hands gripping the rim.
        g.fillStyle(skin, 1);
        g.fillCircle(lean - 2.7, kegY + 3.2, 1.2);
        g.fillCircle(lean + 2.7, kegY + 3.2, 1.2);

        // The fuse — always burning, frantic when he's about to blow.
        const fx = lean + 1.4, fy = kegY - 3.4;
        g.lineStyle(1.1, 0x3a3a2a, 1);
        g.lineBetween(fx, fy, fx + 1.2, fy - 2.2);
        const rate = brace > 0 ? 45 : 90;
        const sp = 0.6 + Math.sin(time / rate) * 0.4;
        g.fillStyle(0xffaa00, 0.5 + sp * 0.5);
        g.fillCircle(fx + 1.2, fy - 2.4, 1.3 + sp * 0.5 + brace);
        g.fillStyle(0xff4400, 0.4 + sp * 0.4);
        g.fillCircle(fx + 1.2, fy - 2.4, 0.7 + brace * 0.6);
        if (brace > 0.3) {
            for (let i = 0; i < 3; i++) {
                const sa = time / 50 + i * 2.1;
                g.fillStyle(0xffd27a, 0.6 * brace);
                g.fillCircle(fx + 1.2 + Math.cos(sa) * 2.2, fy - 2.4 + Math.sin(sa) * 1.6, 0.5);
            }
        }
    }

    // ============================= GIANT =============================
    // Redesigned from scratch. A knuckle-dragging wall of a man about twice
    // a villager tall: barrel chest, boulder shoulders, long heavy arms,
    // small bald head sunk low. Walk is slow and weighty; the attack is a
    // two-fisted overhead slam — arms climb through the wind-up, hang for a
    // beat, crash down exactly on the damage tick, dust shock rolls out,
    // then he slowly straightens back up.
    private static drawGiant(g: G, isPlayer: boolean, isMoving: boolean, troopLevel: number, time: number, attackAge: number, attackDelay: number): void {
        const atk = TroopRenderer.attackAnim(time, attackAge, attackDelay || 3600, 950, 550);

        const skin = isPlayer ? 0xd9a36a : 0xbb8f60;
        const skinDark = isPlayer ? 0xb9854e : 0x9f7748;
        const pants = isPlayer ? 0x5a4632 : 0x4a3a2a;
        const pantsDark = isPlayer ? 0x453525 : 0x382c1f;
        const rope = 0x8a6438;

        // ---- gait / breath
        let lift = 0;        // body rise
        let legSwing = 0;
        let armSwing = 0;
        let roll = 0;        // shoulder-line tilt while lumbering
        if (isMoving) {
            const ph = (time % 1300) / 1300;
            const s = Math.sin(ph * Math.PI * 2);
            lift = Math.pow(Math.abs(s), 0.7) * 1.8;
            legSwing = s * 3.2;
            armSwing = -s * 2.4;
            roll = Math.sin(ph * Math.PI * 2) * 0.8;
        } else {
            const period = atk.inCombat ? 280 : 450; // breathes harder mid-fight
            lift = Math.max(0, Math.sin(time / period)) * 0.7;
        }

        // ---- attack pose: armT 0 = hanging, 1 = overhead, then slammed to
        // the ground. stretch/crunch move the torso with the arms.
        let armT = 0;
        let slam = 0;       // 0..1 fists driven into the ground
        let recover = -1;   // 0..1 straightening out of the slam (-1 = not recovering)
        let stretch = 0;    // torso reaches up during the wind-up
        let crunch = 0;     // torso drops into the impact
        if (!isMoving && atk.inCombat) {
            const W = atk.windup;
            if (W > 0) {
                if (W < 0.8) {
                    armT = easeOut(W / 0.8);            // arms climb overhead
                    stretch = armT;
                } else if (W < 0.905) {
                    armT = 1;                            // a held beat at the top
                    stretch = 1;
                } else {
                    const s = easeIn((W - 0.905) / 0.095); // the drop — fast
                    armT = 1;
                    slam = s;
                    stretch = 1 - s;
                    crunch = s;
                }
            } else if (atk.age <= 620) {
                armT = 1; slam = 1; crunch = 1;          // fists in the dirt
            } else if (atk.age <= 1400) {
                const t = easeOut((atk.age - 620) / 780); // slow straighten
                recover = t; armT = 1 - t; crunch = 1 - t;
            }
        }

        const shoulderY = -13 - lift - stretch * 2.5 + crunch * 4.5;
        const leanX = crunch * 2 - stretch * 1.2;

        // ---- shadow (bigger while the fists are airborne overhead)
        g.fillStyle(0x000000, 0.3);
        g.fillEllipse(0, 13.5, 26 + stretch * 2, 9.5);

        // ---- legs: thick trapezoids, wide stance, big flat feet.
        const legs: Array<[number, number]> = [[-1, legSwing], [1, -legSwing]];
        for (const [side, sw] of legs) {
            g.fillStyle(side < 0 ? pantsDark : pants, 1);
            g.beginPath();
            g.moveTo(side * 7.6, 2 - lift * 0.5);
            g.lineTo(side * 3.4, 2.5 - lift * 0.5);
            g.lineTo(side * 4.2 + sw, 12);
            g.lineTo(side * 8.4 + sw, 11.4);
            g.closePath();
            g.fillPath();
            // knee wrap
            g.lineStyle(1, 0x3a2c1d, 0.75);
            g.lineBetween(side * 6.6 + sw * 0.55, 7, side * 3.9 + sw * 0.55, 7.3);
            // foot
            g.fillStyle(0x33261a, 1);
            g.fillEllipse(side * 6.3 + sw, 12.6, 7, 2.8);
        }

        // ---- torso: broad trapezoid, belly, pec shading.
        g.fillStyle(skin, 1);
        g.beginPath();
        g.moveTo(-10.5 + leanX * 0.6 - roll * 0.4, shoulderY - roll);
        g.lineTo(10.5 + leanX * 0.6 + roll * 0.4, shoulderY + roll);
        g.lineTo(6.6 + leanX * 0.2, 3.6 - lift * 0.5);
        g.lineTo(-6.6 + leanX * 0.2, 3.6 - lift * 0.5);
        g.closePath();
        g.fillPath();
        // SE shade plane (light from the NW)
        g.fillStyle(skinDark, 0.55);
        g.beginPath();
        g.moveTo(10.5 + leanX * 0.6 + roll * 0.4, shoulderY + roll);
        g.lineTo(6.6 + leanX * 0.2, 3.6 - lift * 0.5);
        g.lineTo(2.6 + leanX * 0.2, 3.6 - lift * 0.5);
        g.lineTo(6.2 + leanX * 0.6, shoulderY + roll * 0.6);
        g.closePath();
        g.fillPath();
        // Belly + crease
        g.fillStyle(skin, 1);
        g.fillCircle(leanX * 0.3, 0.6 - lift * 0.4, 4.8);
        g.lineStyle(1, skinDark, 0.6);
        g.beginPath();
        g.arc(leanX * 0.3, -0.2 - lift * 0.4, 4.2, 0.35, Math.PI - 0.35, false);
        g.strokePath();
        // Pecs
        g.lineStyle(1, skinDark, 0.5);
        g.beginPath();
        g.arc(-3.6 + leanX * 0.5, shoulderY + 5.4, 3, 0.25, Math.PI * 0.75, false);
        g.strokePath();
        g.beginPath();
        g.arc(3.6 + leanX * 0.5, shoulderY + 5.4, 3, Math.PI * 0.25, Math.PI * 0.75, false);
        g.strokePath();

        // Rope belt + knot.
        g.fillStyle(rope, 1);
        g.fillRect(-7 + leanX * 0.2, 2 - lift * 0.5, 14, 2.2);
        g.fillCircle(leanX * 0.2 + 2.4, 3 - lift * 0.5, 1.5);
        if (troopLevel >= 3) {
            g.fillStyle(0xdaa520, 1);
            g.fillRect(leanX * 0.2 - 1.6, 2.2 - lift * 0.5, 3.2, 1.8);
        }

        // ---- arms: shoulder → (bezier) fist, with an elbow bulge.
        // Fist anchors for the three key poses:
        const hangY = 7 - lift * 0.6;
        for (const side of [-1, 1]) {
            const sx = side * 9 + leanX * 0.7;
            const sy = shoulderY + 1 + roll * side;
            // hang → overhead (big outward arc), overhead → ground (inner fast)
            const hx0 = side * 12.5 + (isMoving ? armSwing * side : 0);
            const hy0 = hangY;
            const ox = side * 4.6 + leanX;
            const oy = shoulderY - 13.5;
            const gx = side * 7 + leanX;
            const gy = 9.8;
            let fx: number, fy: number;
            if (recover >= 0) {
                // Straighten: knuckles drag out of the dirt and swing directly
                // back to the hang — never retracing the overhead arc.
                const t = recover;
                const cx = side * 14, cy = 10.5; // low outward control — fists stay heavy
                fx = (1 - t) * (1 - t) * gx + 2 * (1 - t) * t * cx + t * t * hx0;
                fy = (1 - t) * (1 - t) * gy + 2 * (1 - t) * t * cy + t * t * hy0;
            } else if (slam > 0) {
                const t = slam;
                const cx = side * 10 + leanX, cy = -6; // inner control point
                fx = (1 - t) * (1 - t) * ox + 2 * (1 - t) * t * cx + t * t * gx;
                fy = (1 - t) * (1 - t) * oy + 2 * (1 - t) * t * cy + t * t * gy;
            } else {
                const t = armT;
                const cx = side * 16.5, cy = shoulderY - 5; // outward control point
                fx = (1 - t) * (1 - t) * hx0 + 2 * (1 - t) * t * cx + t * t * ox;
                fy = (1 - t) * (1 - t) * hy0 + 2 * (1 - t) * t * cy + t * t * oy;
            }
            // Elbow bows outward from the straight line.
            const mx = (sx + fx) / 2 + side * 2.6 * (1 - armT * 0.55);
            const my = (sy + fy) / 2 + (0.8 - 1.8 * armT);
            TroopRenderer.hLimb(g, skin, sx, sy, mx, my, 4.4);
            TroopRenderer.hLimb(g, skin, mx, my, fx, fy, 3.7);
            // Wrist wrap
            const wx = mx + (fx - mx) * 0.72, wy = my + (fy - my) * 0.72;
            TroopRenderer.hLimb(g, rope, wx - 1.4, wy - 1, wx + 1.4, wy + 1, 2.6);
            // Fist
            g.fillStyle(skinDark, 1);
            g.fillCircle(fx, fy, 3.8);
            g.fillStyle(skin, 1);
            g.fillCircle(fx - side * 0.7, fy - 0.8, 3);
            g.fillStyle(skinDark, 0.8);
            for (let k = -1; k <= 1; k++) g.fillCircle(fx + k * 1.6, fy - 2.2, 0.8);
            if (troopLevel >= 3) {
                g.fillStyle(0xdaa520, 0.95);
                for (let k = -1; k <= 1; k++) g.fillCircle(fx + k * 1.7, fy - 2.3, 0.6);
            }
            // Shoulder boulder on top of the arm root.
            g.fillStyle(skin, 1);
            g.fillCircle(side * 8.8 + leanX * 0.7, shoulderY + 0.6 + roll * side, 4.4);
            g.lineStyle(1, skinDark, 0.5);
            g.beginPath();
            g.arc(side * 8.8 + leanX * 0.7, shoulderY + 0.6 + roll * side, 3.6, Math.PI * 1.15, Math.PI * 1.85, false);
            g.strokePath();
            if (troopLevel >= 2 && side < 0) {
                // Iron pauldron on the left shoulder.
                g.fillStyle(0x565b64, 1);
                g.beginPath();
                g.arc(side * 8.8 + leanX * 0.7, shoulderY + 0.2 + roll * side, 4.6, Math.PI * 0.95, Math.PI * 2.05, false);
                g.closePath();
                g.fillPath();
                g.fillStyle(0x8a8f99, 1);
                g.fillCircle(side * 8.8 + leanX * 0.7, shoulderY - 2.6 + roll * side, 1);
            }
        }

        // ---- head: small skull, heavy jaw, sunk between the shoulders
        // (drops right down into them on the impact).
        const hy = shoulderY - 4.6 + crunch * 2.2;
        const hx = leanX;
        g.fillStyle(skin, 1);
        g.fillCircle(hx, hy, 4.4);
        // Jaw slab
        g.fillStyle(skin, 1);
        g.fillRect(hx - 3.4, hy + 1.4, 6.8, 2.8);
        g.fillStyle(skinDark, 0.5);
        g.fillRect(hx - 2.6, hy + 3.4, 5.2, 0.9);
        // Ears
        g.fillStyle(skinDark, 1);
        g.fillCircle(hx - 4.2, hy + 0.6, 1);
        g.fillCircle(hx + 4.2, hy + 0.6, 1);
        // Brow — drops lower the angrier he gets.
        const browDrop = atk.inCombat ? 0.7 : 0;
        g.fillStyle(skinDark, 1);
        g.fillRect(hx - 3.5, hy - 1.8 + browDrop, 7, 1.6);
        // Eyes
        g.fillStyle(0x140e08, 0.9);
        g.fillCircle(hx - 1.9, hy + 0.3, 0.9);
        g.fillCircle(hx + 1.9, hy + 0.3, 0.9);
        // Grim mouth
        g.lineStyle(1, 0x4a3018, 0.8);
        g.lineBetween(hx - 1.6, hy + 2.9, hx + 1.6, hy + 2.9);
        if (troopLevel < 2) {
            // Bald with a short back-tuft.
            g.fillStyle(0x3a2a1a, 1);
            g.beginPath();
            g.arc(hx, hy - 2.2, 3.4, Math.PI * 1.1, Math.PI * 1.7, false);
            g.closePath();
            g.fillPath();
        } else {
            // Iron skullcap; L3 adds horns + a gold rivet.
            g.fillStyle(0x565b64, 1);
            g.beginPath();
            g.arc(hx, hy - 1.2, 4.6, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
            g.fillStyle(0x8a8f99, 1);
            g.beginPath();
            g.arc(hx, hy - 1.6, 3.7, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
            g.fillStyle(0x565b64, 1);
            g.fillCircle(hx - 2.6, hy - 2.6, 0.7);
            g.fillCircle(hx + 2.6, hy - 2.6, 0.7);
            if (troopLevel >= 3) {
                g.fillStyle(0xe3dcc6, 1);
                g.fillTriangle(hx - 3.8, hy - 3.4, hx - 7.2, hy - 8.2, hx - 5.4, hy - 3.2);
                g.fillTriangle(hx + 3.8, hy - 3.4, hx + 7.2, hy - 8.2, hx + 5.4, hy - 3.2);
                g.fillStyle(0xcfc5a8, 1);
                g.fillCircle(hx - 7.2, hy - 8.2, 0.9);
                g.fillCircle(hx + 7.2, hy - 8.2, 0.9);
                g.fillStyle(0xdaa520, 1);
                g.fillCircle(hx, hy - 5.4, 1);
            }
        }

        // ---- impact: a rolling dust shockwave + arcing pebbles + low puffs.
        if (!isMoving && atk.inCombat && atk.age <= 700 && slam > 0.95) {
            const p = clamp01(atk.age / 650);
            if (p < 1) {
                g.lineStyle(2.5, 0xbfae8e, 0.55 * (1 - p));
                g.strokeEllipse(0, 12, 18 + p * 46, (18 + p * 46) * 0.42);
                g.lineStyle(1.5, 0xa8987a, 0.35 * (1 - p));
                g.strokeEllipse(0, 12.5, 10 + p * 30, (10 + p * 30) * 0.4);
            }
            const pp = clamp01(atk.age / 560);
            if (pp < 1) {
                g.fillStyle(0x9a8f78, 0.9 * (1 - pp));
                for (let k = 0; k < 6; k++) {
                    const A = k * 1.047 + 0.35;
                    const d = 9 + pp * 17;
                    g.fillCircle(
                        Math.cos(A) * d,
                        12 + Math.sin(A) * 0.5 * d - 6 * Math.sin(pp * Math.PI),
                        1.5
                    );
                }
                // Low dust puffs rolling out along the ground line.
                g.fillStyle(0xbfae8e, 0.32 * (1 - pp));
                for (let k = 0; k < 3; k++) {
                    const A = k * 2.09 + 0.9;
                    const d = 10 + pp * 16;
                    g.fillCircle(Math.cos(A) * d, 11.4 + Math.sin(A) * 0.5 * d, 2.2 + pp * 3);
                }
            }
        }
    }

    // ============================== RAM ==============================
    // The trunk stays a massive machine; its two carriers are villager-scale
    // people. Attack: the crew drags the trunk back through the wind-up and
    // drives it forward on the damage tick (MainScene adds the body lunge).
    private static drawRam(g: G, isPlayer: boolean, isMoving: boolean, facingAngle: number, troopLevel: number, time: number, attackAge: number, attackDelay: number): void {
        const graphics = g;
        const atk = TroopRenderer.attackAnim(time, attackAge, attackDelay || 1100, 320, 160);

        const cos = Math.cos(facingAngle);
        const sin = Math.sin(facingAngle);

        const runPhase = isMoving ? (time % 300) / 300 : 0;
        const runBob = isMoving ? Math.sin(runPhase * Math.PI * 2) * 1.6 : 0;
        let chargeForward = isMoving ? Math.abs(Math.sin(runPhase * Math.PI)) * 3 : 0;
        if (!isMoving && atk.inCombat) {
            if (atk.strike > 0) chargeForward = 4 * easeOut(1 - clamp01(atk.age / 160)) + 0.5;
            else if (atk.windup > 0) chargeForward = -3 * easeIn(atk.windup);
            else if (atk.age <= 500) chargeForward = 4 * (1 - clamp01((atk.age - 160) / 340));
        }

        // Trunk dimensions — lower than before so villager-scale arms reach it.
        const ramLength = 46;
        const ramWidth = 13;
        const ramHeight = 13;

        const backX = -cos * (ramLength / 2) - cos * chargeForward;
        const backY = -sin * (ramLength / 2) * 0.5 + runBob - sin * chargeForward * 0.5;
        const frontX = cos * (ramLength / 2) + cos * chargeForward;
        const frontY = sin * (ramLength / 2) * 0.5 + runBob + sin * chargeForward * 0.5;

        const perpX = -sin * (ramWidth / 2);
        const perpY = cos * (ramWidth / 2) * 0.5;

        // Ground shadow under the whole rig.
        graphics.fillStyle(0x000000, 0.35);
        graphics.fillEllipse(cos * 3, 10 + sin * 2, 42, 16);

        // ---- the two carriers (villager scale, arms up under the trunk).
        const skin = isPlayer ? 0xdeb887 : 0xc9a66b;
        const tunic = isPlayer ? 0x8b5a2b : 0x6b4a30;
        const tunicDark = isPlayer ? 0x5c3a1c : 0x47311d;

        const carriers: Array<[number, number]> = [[-0.35, 0], [0.1, 0.5]];
        for (const [wOffset, phOff] of carriers) {
            const wx = backX + (frontX - backX) * (wOffset + 0.5);
            const wy = backY + (frontY - backY) * (wOffset + 0.5) + 6;
            const ph = isMoving ? ((time + phOff * 150) % 300) / 300 : 0;
            const swing = isMoving ? Math.sin(ph * Math.PI * 2) * 2.2 : 0;
            const lift = isMoving ? Math.abs(Math.sin(ph * Math.PI * 2)) * 1 : 0;

            // small contact shadow
            graphics.fillStyle(0x000000, 0.18);
            graphics.fillEllipse(wx, wy + 9.4, 8, 3);
            // legs
            graphics.fillStyle(tunicDark, 1);
            graphics.fillRect(wx - 2.4 - swing, wy + 3.5 - lift, 1.9, 5.3 + lift);
            graphics.fillRect(wx + 0.5 + swing, wy + 3.5 - lift, 1.9, 5.3 + lift);
            graphics.fillStyle(0x2a211a, 1);
            graphics.fillEllipse(wx - 1.5 - swing, wy + 9, 2.8, 1.5);
            graphics.fillEllipse(wx + 1.5 + swing, wy + 9, 2.8, 1.5);
            // torso
            graphics.fillStyle(tunic, 1);
            graphics.fillCircle(wx, wy - 1 - lift, 4.1);
            graphics.fillStyle(tunicDark, 1);
            graphics.fillRect(wx - 3.6, wy + 1 - lift, 7.2, 1.6);
            // arms straight up, hands gripping the trunk's belly
            const gripY = wy - ramHeight + 8 - 6; // just under the trunk line
            TroopRenderer.hLimb(graphics, skin, wx - 2.5, wy - 2.6 - lift, wx - 2.9, gripY, 1.7);
            TroopRenderer.hLimb(graphics, skin, wx + 2.5, wy - 2.6 - lift, wx + 2.9, gripY, 1.7);
            graphics.fillStyle(skin, 1);
            graphics.fillCircle(wx - 2.9, gripY, 1.15);
            graphics.fillCircle(wx + 2.9, gripY, 1.15);
            // head + simple helm
            graphics.fillStyle(skin, 1);
            graphics.fillCircle(wx, wy - 7 - lift, 2.9);
            graphics.fillStyle(0x565b64, 1);
            graphics.beginPath();
            graphics.arc(wx, wy - 7.6 - lift, 3, Math.PI, 0, false);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(0x6a6f78, 1);
            graphics.fillRect(wx - 0.6, wy - 11.6 - lift, 1.2, 1.8);
        }
        // === MASSIVE TREE TRUNK ===
        // Dark bark base layer
        graphics.fillStyle(0x3d2817, 1);
        graphics.beginPath();
        graphics.moveTo(backX + perpX * 1.1, backY + perpY * 1.1 - ramHeight + 2);
        graphics.lineTo(frontX + perpX * 0.9, frontY + perpY * 0.9 - ramHeight + 2);
        graphics.lineTo(frontX - perpX * 0.9, frontY - perpY * 0.9 - ramHeight + 2);
        graphics.lineTo(backX - perpX * 1.1, backY - perpY * 1.1 - ramHeight + 2);
        graphics.closePath();
        graphics.fillPath();

        // Main trunk body - rich brown wood
        graphics.fillStyle(0x5d3a1a, 1);
        graphics.beginPath();
        graphics.moveTo(backX + perpX, backY + perpY - ramHeight);
        graphics.lineTo(frontX + perpX * 0.85, frontY + perpY * 0.85 - ramHeight);
        graphics.lineTo(frontX - perpX * 0.85, frontY - perpY * 0.85 - ramHeight);
        graphics.lineTo(backX - perpX, backY - perpY - ramHeight);
        graphics.closePath();
        graphics.fillPath();

        // Wood highlight - top surface
        graphics.fillStyle(0x7a4a2a, 1);
        graphics.beginPath();
        graphics.moveTo(backX + perpX * 0.8, backY + perpY * 0.8 - ramHeight - 4);
        graphics.lineTo(frontX + perpX * 0.7, frontY + perpY * 0.7 - ramHeight - 4);
        graphics.lineTo(frontX - perpX * 0.4, frontY - perpY * 0.4 - ramHeight - 3);
        graphics.lineTo(backX - perpX * 0.4, backY - perpY * 0.4 - ramHeight - 3);
        graphics.closePath();
        graphics.fillPath();

        // Bark texture - deep grooves running lengthwise
        graphics.lineStyle(2, 0x2a1a0a, 0.7);
        for (let i = 0; i < 5; i++) {
            const offset = (i - 2) * 0.15;
            const gx1 = backX + perpX * offset;
            const gy1 = backY + perpY * offset - ramHeight - 1;
            const gx2 = frontX + perpX * offset * 0.8;
            const gy2 = frontY + perpY * offset * 0.8 - ramHeight - 1;
            graphics.lineBetween(gx1, gy1, gx2, gy2);
        }

        // Knots and wood details
        graphics.fillStyle(0x4a2a15, 1);
        const knot1T = 0.3;
        const knot1X = backX + (frontX - backX) * knot1T + perpX * 0.3;
        const knot1Y = backY + (frontY - backY) * knot1T + perpY * 0.3 - ramHeight - 2;
        graphics.fillCircle(knot1X, knot1Y, 3);
        graphics.fillStyle(0x3a1a0a, 1);
        graphics.fillCircle(knot1X, knot1Y, 1.5);

        const knot2T = 0.65;
        const knot2X = backX + (frontX - backX) * knot2T - perpX * 0.2;
        const knot2Y = backY + (frontY - backY) * knot2T - perpY * 0.2 - ramHeight - 1;
        graphics.fillStyle(0x4a2a15, 1);
        graphics.fillCircle(knot2X, knot2Y, 2.5);
        graphics.fillStyle(0x3a1a0a, 1);
        graphics.fillCircle(knot2X, knot2Y, 1);

        if (troopLevel >= 2) {
            // === IRON REINFORCEMENT RINGS (L2+) ===
            graphics.fillStyle(0x3a3a3a, 1);
            for (let i = 0; i < 5; i++) {
                const t = (i + 1) / 6;
                const bx = backX + (frontX - backX) * t;
                const by = backY + (frontY - backY) * t - ramHeight;
                graphics.beginPath();
                graphics.moveTo(bx + perpX * 1.15, by + perpY * 1.15 + 2);
                graphics.lineTo(bx - perpX * 1.15, by - perpY * 1.15 + 2);
                graphics.lineTo(bx - perpX * 1.15, by - perpY * 1.15 - 4);
                graphics.lineTo(bx + perpX * 1.15, by + perpY * 1.15 - 4);
                graphics.closePath();
                graphics.fillPath();
            }
            graphics.fillStyle(0x5a5a5a, 0.8);
            for (let i = 0; i < 5; i++) {
                const t = (i + 1) / 6;
                const bx = backX + (frontX - backX) * t;
                const by = backY + (frontY - backY) * t - ramHeight - 3;
                graphics.fillRect(bx - perpX * 0.3 - 3, by, 6, 1.5);
            }
            graphics.fillStyle(0x6a6a6a, 1);
            for (let i = 0; i < 5; i++) {
                const t = (i + 1) / 6;
                const bx = backX + (frontX - backX) * t;
                const by = backY + (frontY - backY) * t - ramHeight - 1;
                graphics.fillCircle(bx + perpX * 0.9, by + perpY * 0.9, 1.5);
                graphics.fillCircle(bx - perpX * 0.9, by - perpY * 0.9, 1.5);
            }

            // === MASSIVE IRON RAM HEAD (L2+) ===
            const headLength = 18;
            const tipX = frontX + cos * headLength + cos * chargeForward;
            const tipY = frontY + sin * headLength * 0.5 - ramHeight + sin * chargeForward * 0.5;

            graphics.fillStyle(0x2a2a2a, 1);
            graphics.beginPath();
            graphics.moveTo(frontX + perpX * 1.3, frontY + perpY * 1.3 - ramHeight + 3);
            graphics.lineTo(frontX - perpX * 1.3, frontY - perpY * 1.3 - ramHeight + 3);
            graphics.lineTo(frontX - perpX * 1.3, frontY - perpY * 1.3 - ramHeight - 6);
            graphics.lineTo(frontX + perpX * 1.3, frontY + perpY * 1.3 - ramHeight - 6);
            graphics.closePath();
            graphics.fillPath();

            graphics.fillStyle(0x4a4a4a, 1);
            graphics.beginPath();
            graphics.moveTo(tipX, tipY - 2);
            graphics.lineTo(frontX + perpX * 1.2, frontY + perpY * 1.2 - ramHeight + 2);
            graphics.lineTo(frontX + perpX * 1.2, frontY + perpY * 1.2 - ramHeight - 5);
            graphics.closePath();
            graphics.fillPath();

            graphics.fillStyle(0x3a3a3a, 1);
            graphics.beginPath();
            graphics.moveTo(tipX, tipY - 2);
            graphics.lineTo(frontX - perpX * 1.2, frontY - perpY * 1.2 - ramHeight + 2);
            graphics.lineTo(frontX - perpX * 1.2, frontY - perpY * 1.2 - ramHeight - 5);
            graphics.closePath();
            graphics.fillPath();

            graphics.fillStyle(0x6a6a6a, 1);
            graphics.beginPath();
            graphics.moveTo(tipX + 1, tipY - 4);
            graphics.lineTo(frontX + perpX * 0.3, frontY + perpY * 0.3 - ramHeight - 4);
            graphics.lineTo(frontX + perpX * 0.6, frontY + perpY * 0.6 - ramHeight - 2);
            graphics.closePath();
            graphics.fillPath();

            // Decorative ram horns
            graphics.fillStyle(0x555555, 1);
            graphics.beginPath();
            graphics.moveTo(frontX + perpX * 1.1 + cos * 4, frontY + perpY * 1.1 - ramHeight - 4);
            graphics.lineTo(frontX + perpX * 1.8 + cos * 2, frontY + perpY * 1.8 - ramHeight - 8);
            graphics.lineTo(frontX + perpX * 1.5 + cos * 6, frontY + perpY * 1.5 - ramHeight - 6);
            graphics.closePath();
            graphics.fillPath();
            graphics.beginPath();
            graphics.moveTo(frontX - perpX * 1.1 + cos * 4, frontY - perpY * 1.1 - ramHeight - 4);
            graphics.lineTo(frontX - perpX * 1.8 + cos * 2, frontY - perpY * 1.8 - ramHeight - 8);
            graphics.lineTo(frontX - perpX * 1.5 + cos * 6, frontY - perpY * 1.5 - ramHeight - 6);
            graphics.closePath();
            graphics.fillPath();

            // Menacing eyes
            graphics.fillStyle(0xff3300, 0.9);
            graphics.fillCircle(frontX + perpX * 0.5 + cos * 8, frontY + perpY * 0.5 - ramHeight - 2, 2);
            graphics.fillCircle(frontX - perpX * 0.5 + cos * 8, frontY - perpY * 0.5 - ramHeight - 2, 2);
            graphics.fillStyle(0xffff00, 0.7);
            graphics.fillCircle(frontX + perpX * 0.5 + cos * 8.5, frontY + perpY * 0.5 - ramHeight - 2.5, 0.8);
            graphics.fillCircle(frontX - perpX * 0.5 + cos * 8.5, frontY - perpY * 0.5 - ramHeight - 2.5, 0.8);
        }
        // L3: Gold reinforcement rings + glowing eyes brighter
        if (troopLevel >= 3) {
            graphics.lineStyle(1.5, 0xdaa520, 0.8);
            for (let i = 0; i < 5; i++) {
                const t = (i + 1) / 6;
                const bx = backX + (frontX - backX) * t;
                const by = backY + (frontY - backY) * t - ramHeight - 1;
                graphics.lineBetween(bx + perpX * 1.2, by + perpY * 1.2, bx - perpX * 1.2, by - perpY * 1.2);
            }
        }
        if (troopLevel < 2) {
            // === L1: SIMPLE ROPE BINDINGS ===
            graphics.lineStyle(2, 0x8a7a5a, 1);
            for (let i = 0; i < 3; i++) {
                const t = (i + 1) / 4;
                const bx = backX + (frontX - backX) * t;
                const by = backY + (frontY - backY) * t - ramHeight - 1;
                graphics.lineBetween(bx + perpX * 1.05, by + perpY * 1.05, bx - perpX * 1.05, by - perpY * 1.05);
            }

            // === L1: SIMPLE POINTED WOODEN TIP ===
            const tipLen = 10;
            const tipX = frontX + cos * tipLen + cos * chargeForward;
            const tipY = frontY + sin * tipLen * 0.5 - ramHeight + sin * chargeForward * 0.5;
            // Tapered wood point
            graphics.fillStyle(0x4a2a15, 1);
            graphics.beginPath();
            graphics.moveTo(tipX, tipY - 2);
            graphics.lineTo(frontX + perpX * 0.9, frontY + perpY * 0.9 - ramHeight + 1);
            graphics.lineTo(frontX + perpX * 0.9, frontY + perpY * 0.9 - ramHeight - 4);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(0x3a1a0a, 1);
            graphics.beginPath();
            graphics.moveTo(tipX, tipY - 2);
            graphics.lineTo(frontX - perpX * 0.9, frontY - perpY * 0.9 - ramHeight + 1);
            graphics.lineTo(frontX - perpX * 0.9, frontY - perpY * 0.9 - ramHeight - 4);
            graphics.closePath();
            graphics.fillPath();
        }

        // === BACK END - Rough cut wood ===
        graphics.fillStyle(0x6a4a2a, 1);
        graphics.beginPath();
        graphics.arc(backX, backY - ramHeight - 1, ramWidth * 0.45, 0, Math.PI * 2);
        graphics.closePath();
        graphics.fillPath();
    }

    // ========================== MOBILE MORTAR ==========================
    // The little field mortar stays a machine; its crewman is a villager-
    // scale soldier hauling it by a rope. The tube kicks with the existing
    // mortarRecoil tween; the tick adds a muzzle flash + powder ring.
    private static drawMobileMortar(g: G, isPlayer: boolean, isMoving: boolean, facingAngle: number, mortarRecoil: number, troopLevel: number, time: number, attackAge: number, attackDelay: number): void {
        const atk = TroopRenderer.attackAnim(time, attackAge, attackDelay || 2200, 420, 0);

        const uniform = isPlayer ? 0x455a64 : 0x5d4037;
        const uniformDark = isPlayer ? 0x37474f : 0x4e342e;
        const skin = 0xe8d4b8;
        const metal = troopLevel >= 3 ? 0xdaa520 : 0x565b64;
        const metalDark = troopLevel >= 3 ? 0xb8860b : 0x373b42;
        const wood = 0x8b4513;

        // Soldier leads, mortar trails (flips with travel direction).
        const facingLeft = Math.abs(facingAngle) > Math.PI / 2;
        const flip = facingLeft ? -1 : 1;
        const mortarX = -11 * flip;
        const soldierX = 12 * flip;

        const rig = TroopRenderer.hRig(time, isMoving, 400, 2.2, 6);
        const lift = rig.lift;
        const mortarBob = isMoving ? Math.abs(Math.sin(((time + 80) % 400) / 400 * Math.PI * 2)) * 1.2 : 0;
        const wheelRot = isMoving ? (time % 600) / 600 * Math.PI * 2 : 0;
        const mortarY = mortarBob * -1 + mortarRecoil;

        // ---- mortar cart
        g.fillStyle(0x000000, 0.3);
        g.fillEllipse(mortarX, 9.6, 15, 6.5);
        // wheels
        g.fillStyle(metalDark, 1);
        g.fillCircle(mortarX - 6.5, 4.5 + mortarY, 4.6);
        g.fillCircle(mortarX + 6.5, 4.5 + mortarY, 4.6);
        g.fillStyle(metal, 1);
        g.fillCircle(mortarX - 6.5, 4.5 + mortarY, 3.1);
        g.fillCircle(mortarX + 6.5, 4.5 + mortarY, 3.1);
        g.fillStyle(wood, 1);
        g.fillCircle(mortarX - 6.5, 4.5 + mortarY, 1.1);
        g.fillCircle(mortarX + 6.5, 4.5 + mortarY, 1.1);
        g.lineStyle(0.9, wood, 0.85);
        for (let i = 0; i < 4; i++) {
            const sa = wheelRot + (i * Math.PI / 2);
            for (const wxc of [mortarX - 6.5, mortarX + 6.5]) {
                g.lineBetween(
                    wxc + Math.cos(sa) * 1.1, 4.5 + mortarY + Math.sin(sa) * 1.1,
                    wxc + Math.cos(sa) * 3.1, 4.5 + mortarY + Math.sin(sa) * 3.1
                );
            }
        }
        // axle + base
        g.fillStyle(wood, 1);
        g.fillRect(mortarX - 8.5, 3 + mortarY, 17, 2.4);
        g.fillStyle(metalDark, 1);
        g.fillRect(mortarX - 4.5, -1.5 + mortarY, 9, 5);

        // tube (angled up; widens with level)
        const tubeW = troopLevel >= 3 ? 4.6 : 3.6;
        const tubeTopW = troopLevel >= 3 ? 3.4 : 2.7;
        g.fillStyle(metalDark, 1);
        g.beginPath();
        g.moveTo(mortarX - tubeW, -1.5 + mortarY);
        g.lineTo(mortarX - tubeTopW, -18 + mortarY);
        g.lineTo(mortarX + tubeTopW, -18 + mortarY);
        g.lineTo(mortarX + tubeW, -1.5 + mortarY);
        g.closePath();
        g.fillPath();
        g.fillStyle(troopLevel >= 3 ? 0xc99a18 : 0x4d525c, 1);
        g.beginPath();
        g.moveTo(mortarX - tubeW + 1.1, -1.5 + mortarY);
        g.lineTo(mortarX - tubeTopW + 0.8, -16.5 + mortarY);
        g.lineTo(mortarX + tubeTopW - 0.8, -16.5 + mortarY);
        g.lineTo(mortarX + tubeW - 1.1, -1.5 + mortarY);
        g.closePath();
        g.fillPath();
        // bore
        g.fillStyle(0x14161a, 1);
        g.fillEllipse(mortarX, -18 + mortarY, tubeTopW * 2 - 1, 1.6);
        g.lineStyle(1.4, metal, 1);
        g.strokeEllipse(mortarX, -18 + mortarY, tubeTopW * 2, 2);
        if (troopLevel >= 2) {
            g.lineStyle(1.3, 0xdaa520, 0.9);
            g.strokeEllipse(mortarX, -10 + mortarY, tubeTopW * 2 + 1.4, 2.2);
            g.strokeEllipse(mortarX, -5 + mortarY, tubeW * 2 - 1, 2.2);
            // ammo crate on the cart
            g.fillStyle(0x5a3a1a, 1);
            g.fillRect(mortarX - 7.5, -1 + mortarY, 4, 3.4);
            g.lineStyle(0.8, 0x3c3c3c, 0.6);
            g.strokeRect(mortarX - 7.5, -1 + mortarY, 4, 3.4);
        }
        if (troopLevel >= 3) {
            g.fillStyle(0x5a3a1a, 1);
            g.fillRect(mortarX - 7.5, 2.8 + mortarY, 4, 2.6);
            g.lineStyle(0.8, 0xdaa520, 0.6);
            g.strokeRect(mortarX - 7.5, 2.8 + mortarY, 4, 2.6);
        }

        // ---- the shot: flash at the bore + a rolling powder ring.
        if (!isMoving && atk.inCombat && atk.age <= 520) {
            if (atk.age <= 90) {
                const fl = 1 - atk.age / 90;
                g.fillStyle(0xffd27a, 0.7 * fl);
                g.fillEllipse(mortarX, -19.5 + mortarY, 6.5, 3.2);
                g.fillStyle(0xfff3d0, 0.85 * fl);
                g.fillEllipse(mortarX, -19.5 + mortarY, 3.2, 1.6);
            }
            const p = clamp01(atk.age / 520);
            g.fillStyle(0xd9d4c8, 0.4 * (1 - p));
            g.fillCircle(mortarX - 1.5, -19 + mortarY - p * 7, 1.4 + p * 2.4);
            g.fillCircle(mortarX + 1.8, -18.5 + mortarY - p * 5.5, 1.1 + p * 2);
        }

        // ---- tow rope, sagging in the middle.
        const handX = soldierX - 4.5 * flip;
        const handY = -2.4 - lift;
        const hitchX = mortarX + 4.5 * flip;
        g.lineStyle(1.4, 0x8b7355, 1);
        g.beginPath();
        g.moveTo(hitchX, 1.5 + mortarY);
        g.lineTo((hitchX + handX) / 2, 3.6);
        g.lineTo(handX, handY);
        g.strokePath();

        // ---- the crewman (villager scale), leaning into the haul.
        g.fillStyle(0x000000, 0.22);
        g.fillEllipse(soldierX, 9.4, 8.5, 3.2);
        const lean = isMoving ? 0.9 * flip : 0;
        g.fillStyle(uniformDark, 1);
        g.fillRect(soldierX - 2.4 - rig.swing, 3.5 - lift, 1.9, 5.3 + lift);
        g.fillRect(soldierX + 0.5 + rig.swing, 3.5 - lift, 1.9, 5.3 + lift);
        g.fillStyle(0x23262b, 1);
        g.fillEllipse(soldierX - 1.5 - rig.swing, 9, 2.8, 1.5);
        g.fillEllipse(soldierX + 1.5 + rig.swing, 9, 2.8, 1.5);
        g.fillStyle(uniform, 1);
        g.fillCircle(soldierX + lean, -1 - lift, 4.1);
        g.fillStyle(uniformDark, 1);
        g.fillRect(soldierX + lean - 3.6, 1 - lift, 7.2, 1.6);
        // rope arm + free arm
        TroopRenderer.hLimb(g, skin, soldierX + lean - 2.2 * flip, -2.6 - lift, handX, handY, 1.7);
        g.fillStyle(skin, 1);
        g.fillCircle(handX, handY, 1.15);
        TroopRenderer.hLimb(g, uniform, soldierX + lean + 2.2 * flip, -2.6 - lift, soldierX + (3.6 + rig.swing * 0.4) * flip, 1.2 - lift, 1.8);
        // head + kettle helmet
        g.fillStyle(skin, 1);
        g.fillCircle(soldierX + lean, -6.8 - lift, 2.9);
        g.fillStyle(0x140e08, 0.85);
        g.fillCircle(soldierX + lean - 1 * flip, -7 - lift, 0.55);
        g.fillCircle(soldierX + lean + 0.4 * flip, -7 - lift, 0.55);
        g.fillStyle(uniformDark, 1);
        g.beginPath();
        g.arc(soldierX + lean, -7.6 - lift, 3.1, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillRect(soldierX + lean - 3.4, -7.9 - lift, 6.8, 1.2);
        if (troopLevel >= 3) {
            g.fillStyle(0xdaa520, 1);
            g.fillCircle(soldierX + lean, -9.2 - lift, 0.9);
        }
    }

    // ========================= ROMAN SOLDIER =========================
    // Villager-scale legionary (also the phalanx's building block: sx/sy
    // offset the whole figure, stagger desyncs the march, isTestudo raises
    // the shield overhead). Standalone soldiers thrust on the damage tick;
    // phalanx thrusts arrive via the spearOffset tween.
    static drawRomanSoldier(g: G, isPlayer: boolean, isMoving: boolean, facingAngle: number, isTestudo: boolean, spearOffset: number = 0, sx: number = 0, sy: number = 0, stagger: number = 0, troopLevel: number = 1, time: number = Date.now(), attackAge: number = -1, attackDelay: number = 0): void {
        const atk = TroopRenderer.attackAnim(time, attackAge, attackDelay || 900, 260, 150);
        const marchPhase = isMoving ? ((time % 600) / 600 + stagger) % 1 : 0;
        const marchBob = isMoving ? Math.sin((time / 150) + stagger * 10) * 1.3 : Math.max(0, Math.sin((time + stagger * 900) / 640)) * -0.4;
        const cy = sy + marchBob;

        const shieldMain = isPlayer ? 0xcc3333 : 0x554433;
        const shieldTrim = troopLevel >= 3 ? (isPlayer ? 0xdaa520 : 0xb8960b) : (isPlayer ? 0xd4a84b : 0x8b7355);
        const shieldBoss = isPlayer ? 0xffd700 : 0xaa9977;
        const tunicColor = troopLevel >= 3 ? (isPlayer ? 0x991111 : 0x443322) : (isPlayer ? 0xbb2222 : 0x443322);
        const armorColor = troopLevel >= 3 ? (isPlayer ? 0xdaa520 : 0xb8960b) : (isPlayer ? 0x888899 : 0x777788);
        const skin = 0xd4a574;

        // Standalone thrust keyed to the tick (out fast, back over ~140ms).
        let thrust = spearOffset;
        if (!isTestudo && !isMoving && atk.inCombat) {
            if (atk.strike > 0) thrust = Math.max(thrust, Math.sin(clamp01(atk.age / 150) * Math.PI));
            else if (atk.windup > 0) thrust = Math.min(thrust, 0) - 0.25 * atk.windup; // small pull-back
        }

        // legs + sandals
        const legSpread = isMoving ? Math.sin(marchPhase * Math.PI * 2) * 2.2 : 0;
        g.fillStyle(tunicColor, 1);
        g.fillRect(sx - 2.4 + legSpread, cy + 3.5, 1.8, 5);
        g.fillRect(sx + 0.6 - legSpread, cy + 3.5, 1.8, 5);
        g.fillStyle(0x4a3a2a, 1);
        g.fillRect(sx - 2.9 + legSpread, cy + 8.3, 2.6, 1.4);
        g.fillRect(sx + 0.3 - legSpread, cy + 8.3, 2.6, 1.4);

        // tunic + lorica strips
        g.fillStyle(tunicColor, 1);
        g.fillRect(sx - 3.2, cy - 3.6, 6.4, 7.4);
        g.fillStyle(armorColor, 1);
        for (let strip = 0; strip < 3; strip++) {
            g.fillRect(sx - 3.2, cy - 3 + strip * 2.2, 6.4, 1.3);
        }

        // arms
        g.fillStyle(skin, 1);
        g.fillRect(sx - 4.6, cy - 2.4, 1.6, 4.4);
        g.fillRect(sx + 3, cy - 2.4, 1.6, 4.4);

        // head + helmet + crest
        g.fillStyle(skin, 1);
        g.fillCircle(sx, cy - 6.4, 2.8);
        g.fillStyle(armorColor, 1);
        g.fillRect(sx - 3, cy - 9.4, 6, 2.8);
        g.fillStyle(troopLevel >= 3 ? 0xdaa520 : 0x666677, 1);
        g.fillRect(sx - 0.7, cy - 10.8, 1.4, 1.6);
        g.fillStyle(0xcc2222, 1);
        g.fillRect(sx - 0.7, cy - (troopLevel >= 2 ? 14.4 : 13), 1.4, troopLevel >= 2 ? 3.8 : 2.4);
        if (troopLevel >= 2) {
            g.fillStyle(0xdaa520, 0.85);
            g.fillCircle(sx - 3.6, cy - 3.4, 1.3);
            g.fillCircle(sx + 3.6, cy - 3.4, 1.3);
        }

        // spear
        const spearLen = 15;
        const th = thrust * 6;
        const spX = sx + Math.cos(facingAngle) * th;
        const spY = cy - 4 + Math.sin(facingAngle) * th * 0.5;
        const seX = sx + Math.cos(facingAngle) * (spearLen + th);
        const seY = cy - 4 + Math.sin(facingAngle) * (spearLen + th) * 0.5;
        g.lineStyle(1.3, 0x5d4e37, 1);
        g.lineBetween(spX, spY, seX, seY);
        g.fillStyle(troopLevel >= 3 ? 0xffd700 : 0x555566, 1);
        g.fillTriangle(
            seX + Math.cos(facingAngle) * 3.4, seY + Math.sin(facingAngle) * 1.7,
            seX + Math.cos(facingAngle + 2.5) * 1.7, seY + Math.sin(facingAngle + 2.5) * 0.9,
            seX + Math.cos(facingAngle - 2.5) * 1.7, seY + Math.sin(facingAngle - 2.5) * 0.9
        );

        // shield
        if (isTestudo) {
            const ss = 8;
            g.fillStyle(shieldMain, 1);
            g.fillRect(sx - ss / 2, cy - 11.5 - ss / 2, ss, ss);
            g.lineStyle(1.1, shieldTrim, 1);
            g.strokeRect(sx - ss / 2, cy - 11.5 - ss / 2, ss, ss);
            g.fillStyle(shieldBoss, 1);
            g.fillCircle(sx, cy - 11.5, 2);
            g.fillStyle(0x000000, 0.2);
            g.fillCircle(sx, cy - 11.5, 1);
            if (troopLevel >= 3) {
                g.fillStyle(0xdaa520, 0.7);
                g.fillRect(sx - 0.4, cy - 14.6, 0.8, 3.4);
                g.fillRect(sx - 1.6, cy - 12, 3.2, 0.8);
            }
        } else {
            const shX = sx + Math.cos(facingAngle) * 4.4;
            const shY = cy - 1.6 + Math.sin(facingAngle) * 2;
            g.fillStyle(shieldMain, 1);
            g.fillRect(shX - 2.6, shY - 4.4, 5.2, 8.8);
            g.lineStyle(0.9, shieldTrim, 1);
            g.strokeRect(shX - 2.6, shY - 4.4, 5.2, 8.8);
            g.fillStyle(shieldBoss, 1);
            g.fillCircle(shX, shY, 1.4);
            if (troopLevel >= 3) {
                g.fillStyle(0xdaa520, 0.85);
                g.fillTriangle(shX, shY - 2.6, shX - 1.6, shY - 0.6, shX + 1.6, shY - 0.6);
            }
        }
    }

    // ============================ PHALANX ============================
    // Roman testudo: a 3x3 of villager-scale legionaries under one shield
    // roof, marching in loose step behind the standard.
    static drawPhalanx(graphics: G, isPlayer: boolean, isMoving: boolean, facingAngle: number, spearOffset: number = 0, troopLevel: number = 1, time: number = Date.now()): void {
        graphics.fillStyle(0x000000, 0.38);
        graphics.fillEllipse(0, 7, 40, 19);

        const soldierSpacing = 9;
        const cos = Math.cos(facingAngle);
        const sin = Math.sin(facingAngle);

        const soldiers: Array<{ wx: number; wy: number; row: number; col: number }> = [];
        for (const row of [-1, 0, 1]) {
            for (const col of [-1, 0, 1]) {
                const localX = col * soldierSpacing;
                const localY = row * soldierSpacing;
                const wx = localX * cos - localY * sin;
                const wy = localX * sin * 0.5 + localY * cos * 0.5;
                soldiers.push({ wx, wy, row, col });
            }
        }
        soldiers.sort((a, b) => a.wy - b.wy);

        for (const s of soldiers) {
            const stagger = (s.row + s.col) * 0.15;
            this.drawRomanSoldier(graphics, isPlayer, isMoving, facingAngle, true, spearOffset, s.wx, s.wy, stagger, troopLevel, time);
        }

        // Banner/Standard (center back)
        const bannerX = -Math.cos(facingAngle) * 12;
        const bannerY = -Math.sin(facingAngle) * 6 - 4;
        const bannerPoleTop = troopLevel >= 3 ? bannerY - 27 : bannerY - 19;
        graphics.lineStyle(2, troopLevel >= 3 ? 0xdaa520 : 0x5d4e37, 1);
        graphics.lineBetween(bannerX, bannerY, bannerX, bannerPoleTop);

        if (troopLevel >= 3) {
            // L3: Grand crimson & gold imperial banner
            const bannerColor = isPlayer ? 0xcc3333 : 0x554433;
            const bannerDark = isPlayer ? 0x991111 : 0x3a2a1a;
            const flagWave = isMoving ? Math.sin(time / 300) * 2 : 0;
            const flagWave2 = isMoving ? Math.sin(time / 250 + 1) * 1.5 : 0;

            // === GRAND EAGLE FINIAL (larger, more detailed) ===
            // Eagle body
            graphics.fillStyle(0xffd700, 1);
            graphics.beginPath();
            graphics.moveTo(bannerX, bannerPoleTop - 9);
            graphics.lineTo(bannerX - 3, bannerPoleTop - 4);
            graphics.lineTo(bannerX + 3, bannerPoleTop - 4);
            graphics.closePath();
            graphics.fillPath();
            // Eagle wings spread wide with feather tips
            graphics.lineStyle(2, 0xffd700, 1);
            graphics.lineBetween(bannerX - 3, bannerPoleTop - 6, bannerX - 8, bannerPoleTop - 10);
            graphics.lineBetween(bannerX + 3, bannerPoleTop - 6, bannerX + 8, bannerPoleTop - 10);
            // Wing feather tips
            graphics.lineStyle(1.5, 0xdaa520, 1);
            graphics.lineBetween(bannerX - 8, bannerPoleTop - 10, bannerX - 10, bannerPoleTop - 8);
            graphics.lineBetween(bannerX - 7, bannerPoleTop - 9, bannerX - 9, bannerPoleTop - 6);
            graphics.lineBetween(bannerX + 8, bannerPoleTop - 10, bannerX + 10, bannerPoleTop - 8);
            graphics.lineBetween(bannerX + 7, bannerPoleTop - 9, bannerX + 9, bannerPoleTop - 6);
            // Eagle head
            graphics.fillStyle(0xffd700, 1);
            graphics.fillCircle(bannerX, bannerPoleTop - 9, 2);
            // Eagle eye
            graphics.fillStyle(0xb8860b, 1);
            graphics.fillCircle(bannerX + 0.5, bannerPoleTop - 9.5, 0.5);

            // === MAIN BANNER — large, crimson red ===
            graphics.fillStyle(bannerColor, 1);
            graphics.beginPath();
            graphics.moveTo(bannerX - 1, bannerPoleTop);
            graphics.lineTo(bannerX + 15 + flagWave, bannerPoleTop + 2);
            graphics.lineTo(bannerX + 13 + flagWave * 0.5, bannerPoleTop + 18);
            graphics.lineTo(bannerX - 1, bannerPoleTop + 16);
            graphics.closePath();
            graphics.fillPath();

            // Darker red inner panel
            graphics.fillStyle(bannerDark, 0.5);
            graphics.beginPath();
            graphics.moveTo(bannerX + 1, bannerPoleTop + 3);
            graphics.lineTo(bannerX + 13 + flagWave * 0.8, bannerPoleTop + 4);
            graphics.lineTo(bannerX + 11 + flagWave * 0.4, bannerPoleTop + 15);
            graphics.lineTo(bannerX + 1, bannerPoleTop + 14);
            graphics.closePath();
            graphics.fillPath();

            // Gold border trim (thick)
            graphics.lineStyle(2, 0xdaa520, 1);
            graphics.beginPath();
            graphics.moveTo(bannerX - 1, bannerPoleTop);
            graphics.lineTo(bannerX + 15 + flagWave, bannerPoleTop + 2);
            graphics.lineTo(bannerX + 13 + flagWave * 0.5, bannerPoleTop + 18);
            graphics.lineTo(bannerX - 1, bannerPoleTop + 16);
            graphics.closePath();
            graphics.strokePath();

            // Gold eagle emblem on banner (larger)
            const embX = bannerX + 6 + flagWave * 0.3;
            const embY = bannerPoleTop + 9;
            graphics.fillStyle(0xffd700, 0.9);
            graphics.beginPath();
            graphics.moveTo(embX, embY - 5);
            graphics.lineTo(embX + 3, embY - 2);
            graphics.lineTo(embX + 6, embY - 4);
            graphics.lineTo(embX + 4, embY);
            graphics.lineTo(embX + 3, embY + 4);
            graphics.lineTo(embX, embY + 2);
            graphics.lineTo(embX - 3, embY + 4);
            graphics.lineTo(embX - 4, embY);
            graphics.lineTo(embX - 6, embY - 4);
            graphics.lineTo(embX - 3, embY - 2);
            graphics.closePath();
            graphics.fillPath();
            // Eagle head highlight
            graphics.fillStyle(0xffd700, 1);
            graphics.fillCircle(embX, embY - 4, 1.5);

            // Gold horizontal bar across banner (like a laurel divider)
            graphics.lineStyle(1, 0xdaa520, 0.7);
            graphics.lineBetween(bannerX + 1, bannerPoleTop + 4, bannerX + 13 + flagWave * 0.7, bannerPoleTop + 5);
            graphics.lineBetween(bannerX + 1, bannerPoleTop + 14, bannerX + 11 + flagWave * 0.4, bannerPoleTop + 15);

            // === THREE FLOWING TAILS (crimson with gold tips) ===
            // Left tail
            graphics.fillStyle(bannerColor, 0.9);
            graphics.beginPath();
            graphics.moveTo(bannerX + 1, bannerPoleTop + 16);
            graphics.lineTo(bannerX + 2 + flagWave2 * 0.5, bannerPoleTop + 24);
            graphics.lineTo(bannerX + 5, bannerPoleTop + 16);
            graphics.closePath();
            graphics.fillPath();
            // Center tail
            graphics.beginPath();
            graphics.moveTo(bannerX + 5, bannerPoleTop + 16);
            graphics.lineTo(bannerX + 6 + flagWave2, bannerPoleTop + 26);
            graphics.lineTo(bannerX + 9, bannerPoleTop + 16);
            graphics.closePath();
            graphics.fillPath();
            // Right tail
            graphics.beginPath();
            graphics.moveTo(bannerX + 9, bannerPoleTop + 16);
            graphics.lineTo(bannerX + 10 + flagWave2 * 0.7, bannerPoleTop + 23);
            graphics.lineTo(bannerX + 13 + flagWave * 0.5, bannerPoleTop + 17);
            graphics.closePath();
            graphics.fillPath();

            // Gold tips on tails
            graphics.fillStyle(0xffd700, 0.9);
            graphics.fillCircle(bannerX + 2 + flagWave2 * 0.5, bannerPoleTop + 23, 1.5);
            graphics.fillCircle(bannerX + 6 + flagWave2, bannerPoleTop + 25, 1.5);
            graphics.fillCircle(bannerX + 10 + flagWave2 * 0.7, bannerPoleTop + 22, 1.5);

            // Gold crossbar at top of banner
            graphics.lineStyle(2, 0xdaa520, 1);
            graphics.lineBetween(bannerX - 2, bannerPoleTop, bannerX + 15 + flagWave, bannerPoleTop + 2);
            // Gold ball on crossbar end
            graphics.fillStyle(0xffd700, 1);
            graphics.fillCircle(bannerX + 15 + flagWave, bannerPoleTop + 2, 2);
        } else {
            // L1-L2 banner
            graphics.fillStyle(isPlayer ? 0xcc3333 : 0x554433, 1);
            graphics.fillRect(bannerX - 5, bannerPoleTop, 10, 8);
            graphics.lineStyle(1.5, isPlayer ? 0xd4a84b : 0x8b7355, 1);
            graphics.strokeRect(bannerX - 5, bannerPoleTop, 10, 8);

            // L2: Eagle standard on banner pole + gold trim
            if (troopLevel >= 2) {
                // Eagle finial on banner pole
                graphics.fillStyle(0xffd700, 1);
                graphics.beginPath();
                graphics.moveTo(bannerX, bannerPoleTop - 3);
                graphics.lineTo(bannerX - 3, bannerPoleTop);
                graphics.lineTo(bannerX + 3, bannerPoleTop);
                graphics.closePath();
                graphics.fillPath();
                // Eagle wings
                graphics.lineStyle(1, 0xffd700, 1);
                graphics.lineBetween(bannerX - 3, bannerPoleTop - 2, bannerX - 7, bannerPoleTop - 4);
                graphics.lineBetween(bannerX + 3, bannerPoleTop - 2, bannerX + 7, bannerPoleTop - 4);
                // Gold emblem on banner
                graphics.fillStyle(0xffd700, 0.8);
                graphics.fillCircle(bannerX, bannerPoleTop + 4, 2);
            }
        }
    }
    private static drawGolem(graphics: Phaser.GameObjects.Graphics, isPlayer: boolean, isMoving: boolean, slamOffset: number, troopLevel: number = 1, time: number = Date.now()) {
        // COLOSSAL STONE GOLEM - Massive animated rock titan
        const now = time;

        // Walking animation - heavy, lumbering steps (slow cycle for weight)
        const walkPhase = isMoving ? (now % 2400) / 2400 : 0;

        // Body movement - only when walking
        const stepBob = isMoving ? Math.abs(Math.sin(walkPhase * Math.PI * 2)) * 4 : 0;

        // Body/head slam - adds slamOffset (for ground pound, body/head drop while legs stay)
        const bodySlam = stepBob + slamOffset;

        const armSwing = isMoving ? Math.sin(walkPhase * Math.PI * 2) * 0.3 : 0;
        const shoulderRoll = isMoving ? Math.sin(walkPhase * Math.PI) * 2 : 0;

        // Stone colors with ancient weathering — L3 is darker, more corrupted
        const stoneBase = troopLevel >= 3 ? (isPlayer ? 0x3a4a5a : 0x4a3a3a) : (isPlayer ? 0x5a6a7a : 0x6a5a5a);
        const stoneDark = troopLevel >= 3 ? (isPlayer ? 0x222e3a : 0x2e2222) : (isPlayer ? 0x3a4a5a : 0x4a3a3a);
        const stoneLight = troopLevel >= 3 ? (isPlayer ? 0x5a6a7a : 0x6a5a5a) : (isPlayer ? 0x7a8a9a : 0x8a7a7a);
        const stoneAccent = troopLevel >= 3 ? (isPlayer ? 0x2a3a4a : 0x3a2a2a) : (isPlayer ? 0x4a5a6a : 0x5a4a4a);
        const mossColor = isPlayer ? 0x4a6a3a : 0x5a4a3a;
        const glowColor = isPlayer ? 0x44aaff : 0xff4444;
        const glowColorBright = isPlayer ? 0x88ccff : 0xff8888;
        // L3 gem colors
        const gemColor = isPlayer ? 0x22ddaa : 0xdd22aa;
        const gemBright = isPlayer ? 0x66ffcc : 0xff66cc;
        const gemDark = isPlayer ? 0x118866 : 0x881166;

        // MASSIVE shadow
        graphics.fillStyle(0x000000, 0.45);
        graphics.fillEllipse(0, 18, 40, 20);

        // === LEGS (massive stone pillars) ===
        const legSpread = 12;
        const leftLegPhase = walkPhase;
        const rightLegPhase = (walkPhase + 0.5) % 1;
        // Legs only animate when moving
        const leftLegLift = isMoving ? Math.max(0, Math.sin(leftLegPhase * Math.PI * 2)) * 6 : 0;
        const rightLegLift = isMoving ? Math.max(0, Math.sin(rightLegPhase * Math.PI * 2)) * 6 : 0;

        // Left leg
        graphics.fillStyle(stoneDark, 1);
        graphics.beginPath();
        graphics.moveTo(-legSpread - 6, -5 + stepBob);
        graphics.lineTo(-legSpread - 8, 12 - leftLegLift);
        graphics.lineTo(-legSpread + 4, 14 - leftLegLift);
        graphics.lineTo(-legSpread + 2, -3 + stepBob);
        graphics.closePath();
        graphics.fillPath();
        // Leg highlight
        graphics.fillStyle(stoneBase, 1);
        graphics.beginPath();
        graphics.moveTo(-legSpread - 4, -4 + stepBob);
        graphics.lineTo(-legSpread - 5, 10 - leftLegLift);
        graphics.lineTo(-legSpread, 11 - leftLegLift);
        graphics.lineTo(-legSpread + 1, -3 + stepBob);
        graphics.closePath();
        graphics.fillPath();
        // Left foot (massive stone block)
        graphics.fillStyle(stoneDark, 1);
        graphics.fillRect(-legSpread - 10, 12 - leftLegLift, 16, 6);
        graphics.fillStyle(stoneAccent, 1);
        graphics.fillRect(-legSpread - 8, 11 - leftLegLift, 12, 3);

        // Right leg
        graphics.fillStyle(stoneDark, 1);
        graphics.beginPath();
        graphics.moveTo(legSpread + 6, -5 + stepBob);
        graphics.lineTo(legSpread + 8, 12 - rightLegLift);
        graphics.lineTo(legSpread - 4, 14 - rightLegLift);
        graphics.lineTo(legSpread - 2, -3 + stepBob);
        graphics.closePath();
        graphics.fillPath();
        // Leg highlight
        graphics.fillStyle(stoneBase, 1);
        graphics.beginPath();
        graphics.moveTo(legSpread + 4, -4 + stepBob);
        graphics.lineTo(legSpread + 5, 10 - rightLegLift);
        graphics.lineTo(legSpread, 11 - rightLegLift);
        graphics.lineTo(legSpread - 1, -3 + stepBob);
        graphics.closePath();
        graphics.fillPath();
        // Right foot
        graphics.fillStyle(stoneDark, 1);
        graphics.fillRect(legSpread - 6, 12 - rightLegLift, 16, 6);
        graphics.fillStyle(stoneAccent, 1);
        graphics.fillRect(legSpread - 4, 11 - rightLegLift, 12, 3);

        // === TORSO (massive boulder body) ===
        // Back layer - darker
        graphics.fillStyle(stoneDark, 1);
        graphics.beginPath();
        graphics.moveTo(-22, -8 + bodySlam);
        graphics.lineTo(-18, -28 + bodySlam);
        graphics.lineTo(18, -28 + bodySlam);
        graphics.lineTo(22, -8 + bodySlam);
        graphics.lineTo(16, 2 + bodySlam);
        graphics.lineTo(-16, 2 + bodySlam);
        graphics.closePath();
        graphics.fillPath();

        // Main body
        graphics.fillStyle(stoneBase, 1);
        graphics.beginPath();
        graphics.moveTo(-20, -10 + bodySlam);
        graphics.lineTo(-16, -30 + bodySlam);
        graphics.lineTo(16, -30 + bodySlam);
        graphics.lineTo(20, -10 + bodySlam);
        graphics.lineTo(14, 0 + bodySlam);
        graphics.lineTo(-14, 0 + bodySlam);
        graphics.closePath();
        graphics.fillPath();

        // Chest stone plates
        graphics.fillStyle(stoneLight, 1);
        graphics.beginPath();
        graphics.moveTo(-12, -24 + bodySlam);
        graphics.lineTo(-8, -28 + bodySlam);
        graphics.lineTo(8, -28 + bodySlam);
        graphics.lineTo(12, -24 + bodySlam);
        graphics.lineTo(10, -14 + bodySlam);
        graphics.lineTo(-10, -14 + bodySlam);
        graphics.closePath();
        graphics.fillPath();

        // Glowing rune on chest
        graphics.fillStyle(glowColor, 0.8);
        graphics.beginPath();
        graphics.moveTo(0, -26 + bodySlam);
        graphics.lineTo(-4, -22 + bodySlam);
        graphics.lineTo(0, -18 + bodySlam);
        graphics.lineTo(4, -22 + bodySlam);
        graphics.closePath();
        graphics.fillPath();
        graphics.fillStyle(glowColorBright, 0.6);
        graphics.fillCircle(0, -22 + bodySlam, 2);

        // Stone texture cracks
        graphics.lineStyle(1, stoneDark, 0.6);
        graphics.lineBetween(-15, -20 + bodySlam, -10, -15 + bodySlam);
        graphics.lineBetween(12, -25 + bodySlam, 16, -18 + bodySlam);
        graphics.lineBetween(-8, -8 + bodySlam, -3, -12 + bodySlam);
        graphics.lineBetween(5, -6 + bodySlam, 10, -10 + bodySlam);

        // L3: Many more deep cracks across the body
        if (troopLevel >= 3) {
            graphics.lineStyle(1.5, 0x111111, 0.7);
            // Deep diagonal cracks
            graphics.lineBetween(-18, -14 + bodySlam, -6, -6 + bodySlam);
            graphics.lineBetween(14, -22 + bodySlam, 6, -14 + bodySlam);
            graphics.lineBetween(-12, -28 + bodySlam, -18, -20 + bodySlam);
            graphics.lineBetween(8, -8 + bodySlam, 16, -4 + bodySlam);
            // Branching cracks
            graphics.lineStyle(1, 0x111111, 0.5);
            graphics.lineBetween(-12, -10 + bodySlam, -14, -6 + bodySlam);
            graphics.lineBetween(10, -18 + bodySlam, 14, -14 + bodySlam);
            graphics.lineBetween(-6, -6 + bodySlam, -8, -2 + bodySlam);
            graphics.lineBetween(6, -14 + bodySlam, 4, -10 + bodySlam);
            // Gem veins glowing through cracks
            graphics.lineStyle(1, gemColor, 0.4);
            graphics.lineBetween(-18, -14 + bodySlam, -12, -10 + bodySlam);
            graphics.lineBetween(14, -22 + bodySlam, 10, -18 + bodySlam);

            // Large chest gem (embedded in the rune area)
            graphics.fillStyle(gemDark, 1);
            graphics.beginPath();
            graphics.moveTo(0, -24 + bodySlam);
            graphics.lineTo(-5, -20 + bodySlam);
            graphics.lineTo(0, -15 + bodySlam);
            graphics.lineTo(5, -20 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemColor, 0.9);
            graphics.beginPath();
            graphics.moveTo(0, -23 + bodySlam);
            graphics.lineTo(-3, -20 + bodySlam);
            graphics.lineTo(0, -16 + bodySlam);
            graphics.lineTo(3, -20 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemBright, 0.7);
            graphics.fillCircle(-1, -21 + bodySlam, 1.5);

            // Side body gems
            graphics.fillStyle(gemDark, 1);
            graphics.beginPath();
            graphics.moveTo(-15, -16 + bodySlam);
            graphics.lineTo(-18, -12 + bodySlam);
            graphics.lineTo(-14, -10 + bodySlam);
            graphics.lineTo(-12, -14 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemColor, 0.8);
            graphics.beginPath();
            graphics.moveTo(-15, -15 + bodySlam);
            graphics.lineTo(-17, -12 + bodySlam);
            graphics.lineTo(-14, -11 + bodySlam);
            graphics.lineTo(-13, -14 + bodySlam);
            graphics.closePath();
            graphics.fillPath();

            graphics.fillStyle(gemDark, 1);
            graphics.beginPath();
            graphics.moveTo(13, -10 + bodySlam);
            graphics.lineTo(16, -6 + bodySlam);
            graphics.lineTo(12, -4 + bodySlam);
            graphics.lineTo(10, -8 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemColor, 0.8);
            graphics.beginPath();
            graphics.moveTo(13, -9 + bodySlam);
            graphics.lineTo(15, -6 + bodySlam);
            graphics.lineTo(12, -5 + bodySlam);
            graphics.lineTo(11, -8 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
        }

        // Moss patches (less moss on L3 — replaced by crystals)
        graphics.fillStyle(mossColor, troopLevel >= 3 ? 0.3 : 0.7);
        graphics.fillCircle(-14, -16 + bodySlam, troopLevel >= 3 ? 2 : 3);
        graphics.fillCircle(16, -12 + bodySlam, 2.5);
        graphics.fillCircle(-8, -4 + bodySlam, 2);

        // === ARMS (boulder appendages) ===
        // Arm swing offsets
        const leftArmSwingX = armSwing * 8;
        const leftArmSwingY = Math.abs(armSwing) * 4;
        const rightArmSwingX = -armSwing * 8;
        const rightArmSwingY = Math.abs(armSwing) * 4;

        // Left arm base position
        const lax = -18;
        const lay = -20 + stepBob + shoulderRoll;

        // Left arm - upper
        graphics.fillStyle(stoneDark, 1);
        graphics.beginPath();
        graphics.moveTo(lax - 4, lay);
        graphics.lineTo(lax - 8 + leftArmSwingX, lay + 18 + leftArmSwingY);
        graphics.lineTo(lax + 4 + leftArmSwingX, lay + 20 + leftArmSwingY);
        graphics.lineTo(lax + 4, lay + 2);
        graphics.closePath();
        graphics.fillPath();
        graphics.fillStyle(stoneBase, 1);
        graphics.beginPath();
        graphics.moveTo(lax - 2, lay + 2);
        graphics.lineTo(lax - 4 + leftArmSwingX * 0.5, lay + 16 + leftArmSwingY * 0.5);
        graphics.lineTo(lax + 2 + leftArmSwingX * 0.5, lay + 17 + leftArmSwingY * 0.5);
        graphics.lineTo(lax + 2, lay + 3);
        graphics.closePath();
        graphics.fillPath();

        // Left forearm
        const lfx = lax - 2 + leftArmSwingX;
        const lfy = lay + 18 + leftArmSwingY;
        graphics.fillStyle(stoneAccent, 1);
        graphics.beginPath();
        graphics.moveTo(lfx - 5, lfy);
        graphics.lineTo(lfx - 7 + leftArmSwingX * 0.5, lfy + 17);
        graphics.lineTo(lfx + 5 + leftArmSwingX * 0.5, lfy + 18);
        graphics.lineTo(lfx + 6, lfy + 1);
        graphics.closePath();
        graphics.fillPath();

        // Left fist
        const lfistX = lfx - 1 + leftArmSwingX * 0.5;
        const lfistY = lfy + 22;
        graphics.fillStyle(stoneDark, 1);
        graphics.fillCircle(lfistX, lfistY, 9);
        graphics.fillStyle(stoneBase, 1);
        graphics.fillCircle(lfistX - 1, lfistY - 1, 7);
        graphics.fillStyle(stoneLight, 0.5);
        graphics.fillCircle(lfistX - 4, lfistY - 3, 2);
        graphics.fillCircle(lfistX, lfistY - 4, 2);
        graphics.fillCircle(lfistX + 4, lfistY - 3, 2);

        // Right arm base position
        const rax = 18;
        const ray = -20 + stepBob - shoulderRoll;

        // Right arm - upper
        graphics.fillStyle(stoneDark, 1);
        graphics.beginPath();
        graphics.moveTo(rax + 4, ray);
        graphics.lineTo(rax + 8 + rightArmSwingX, ray + 18 + rightArmSwingY);
        graphics.lineTo(rax - 4 + rightArmSwingX, ray + 20 + rightArmSwingY);
        graphics.lineTo(rax - 4, ray + 2);
        graphics.closePath();
        graphics.fillPath();
        graphics.fillStyle(stoneBase, 1);
        graphics.beginPath();
        graphics.moveTo(rax + 2, ray + 2);
        graphics.lineTo(rax + 4 + rightArmSwingX * 0.5, ray + 16 + rightArmSwingY * 0.5);
        graphics.lineTo(rax - 2 + rightArmSwingX * 0.5, ray + 17 + rightArmSwingY * 0.5);
        graphics.lineTo(rax - 2, ray + 3);
        graphics.closePath();
        graphics.fillPath();

        // Right forearm
        const rfx = rax + 2 + rightArmSwingX;
        const rfy = ray + 18 + rightArmSwingY;
        graphics.fillStyle(stoneAccent, 1);
        graphics.beginPath();
        graphics.moveTo(rfx + 5, rfy);
        graphics.lineTo(rfx + 7 + rightArmSwingX * 0.5, rfy + 17);
        graphics.lineTo(rfx - 5 + rightArmSwingX * 0.5, rfy + 18);
        graphics.lineTo(rfx - 6, rfy + 1);
        graphics.closePath();
        graphics.fillPath();

        // Right fist
        const rfistX = rfx + 1 + rightArmSwingX * 0.5;
        const rfistY = rfy + 22;
        graphics.fillStyle(stoneDark, 1);
        graphics.fillCircle(rfistX, rfistY, 9);
        graphics.fillStyle(stoneBase, 1);
        graphics.fillCircle(rfistX + 1, rfistY - 1, 7);
        graphics.fillStyle(stoneLight, 0.5);
        graphics.fillCircle(rfistX + 4, rfistY - 3, 2);
        graphics.fillCircle(rfistX, rfistY - 4, 2);
        graphics.fillCircle(rfistX - 4, rfistY - 3, 2);

        // === HEAD (craggy boulder with glowing eyes) ===
        // Neck
        graphics.fillStyle(stoneDark, 1);
        graphics.fillRect(-8, -38 + bodySlam, 16, 10);

        // Head base
        graphics.fillStyle(stoneBase, 1);
        graphics.beginPath();
        graphics.moveTo(-14, -36 + bodySlam);
        graphics.lineTo(-16, -48 + bodySlam);
        graphics.lineTo(-10, -54 + bodySlam);
        graphics.lineTo(10, -54 + bodySlam);
        graphics.lineTo(16, -48 + bodySlam);
        graphics.lineTo(14, -36 + bodySlam);
        graphics.closePath();
        graphics.fillPath();

        // Brow ridge
        graphics.fillStyle(stoneDark, 1);
        graphics.beginPath();
        graphics.moveTo(-14, -46 + bodySlam);
        graphics.lineTo(-12, -50 + bodySlam);
        graphics.lineTo(12, -50 + bodySlam);
        graphics.lineTo(14, -46 + bodySlam);
        graphics.lineTo(10, -44 + bodySlam);
        graphics.lineTo(-10, -44 + bodySlam);
        graphics.closePath();
        graphics.fillPath();

        // Eye sockets (dark) — L2 has deeper/darker sockets
        const socketColor = troopLevel >= 2 ? 0x0a0a0a : 0x1a1a1a;
        graphics.fillStyle(socketColor, 1);
        graphics.fillCircle(-6, -45 + bodySlam, 4);
        graphics.fillCircle(6, -45 + bodySlam, 4);

        // Eyes: subtle steady glow when walking, pulsing bright glow when attacking
        const eyeGlow = troopLevel >= 2 ? (isPlayer ? 0x2288dd : 0xdd2222) : glowColor;
        const eyeBright = troopLevel >= 2 ? (isPlayer ? 0x66aaee : 0xee6666) : glowColorBright;
        const eyePulse = !isMoving ? (0.7 + Math.sin(now / 200) * 0.3) : 0.3;
        graphics.fillStyle(eyeGlow, eyePulse);
        graphics.fillCircle(-6, -45 + bodySlam, 3);
        graphics.fillCircle(6, -45 + bodySlam, 3);
        if (!isMoving) {
            // Bright core + outer glow only when attacking
            graphics.fillStyle(eyeBright, eyePulse * 0.8);
            graphics.fillCircle(-6, -45 + bodySlam, 1.5);
            graphics.fillCircle(6, -45 + bodySlam, 1.5);
            graphics.lineStyle(2, eyeGlow, eyePulse * 0.4);
            graphics.strokeCircle(-6, -45 + bodySlam, 5);
            graphics.strokeCircle(6, -45 + bodySlam, 5);
        }

        // Jagged mouth
        graphics.fillStyle(0x2a2a2a, 1);
        graphics.beginPath();
        graphics.moveTo(-8, -40 + bodySlam);
        graphics.lineTo(-5, -38 + bodySlam);
        graphics.lineTo(-2, -40 + bodySlam);
        graphics.lineTo(2, -38 + bodySlam);
        graphics.lineTo(5, -40 + bodySlam);
        graphics.lineTo(8, -38 + bodySlam);
        graphics.lineTo(6, -36 + bodySlam);
        graphics.lineTo(-6, -36 + bodySlam);
        graphics.closePath();
        graphics.fillPath();

        // Head cracks and details
        graphics.lineStyle(1, stoneDark, 0.7);
        graphics.lineBetween(-10, -52 + bodySlam, -8, -46 + bodySlam);
        graphics.lineBetween(12, -50 + bodySlam, 10, -44 + bodySlam);
        graphics.lineBetween(0, -54 + bodySlam, 0, -50 + bodySlam);

        // Ancient runes on forehead
        graphics.lineStyle(2, glowColor, eyePulse * 0.6);
        graphics.lineBetween(-3, -52 + bodySlam, 3, -52 + bodySlam);
        graphics.lineBetween(0, -54 + bodySlam, 0, -50 + bodySlam);

        // Shoulder spikes/crystals
        if (troopLevel >= 3) {
            // L3: Huge gem crystal clusters on shoulders
            // Left shoulder — large main crystal + smaller shards
            graphics.fillStyle(gemDark, 1);
            graphics.beginPath();
            graphics.moveTo(-20, -26 + bodySlam);
            graphics.lineTo(-28, -42 + bodySlam);
            graphics.lineTo(-22, -40 + bodySlam);
            graphics.lineTo(-16, -30 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemColor, 0.9);
            graphics.beginPath();
            graphics.moveTo(-21, -28 + bodySlam);
            graphics.lineTo(-27, -40 + bodySlam);
            graphics.lineTo(-23, -38 + bodySlam);
            graphics.lineTo(-18, -30 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemBright, 0.6);
            graphics.fillCircle(-24, -36 + bodySlam, 1.5);
            // Secondary shard
            graphics.fillStyle(gemDark, 1);
            graphics.beginPath();
            graphics.moveTo(-18, -28 + bodySlam);
            graphics.lineTo(-22, -36 + bodySlam);
            graphics.lineTo(-16, -32 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemColor, 0.8);
            graphics.beginPath();
            graphics.moveTo(-18, -29 + bodySlam);
            graphics.lineTo(-21, -35 + bodySlam);
            graphics.lineTo(-17, -32 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            // Third small shard
            graphics.fillStyle(gemColor, 0.7);
            graphics.beginPath();
            graphics.moveTo(-24, -28 + bodySlam);
            graphics.lineTo(-27, -34 + bodySlam);
            graphics.lineTo(-23, -30 + bodySlam);
            graphics.closePath();
            graphics.fillPath();

            // Right shoulder — large main crystal + smaller shards
            graphics.fillStyle(gemDark, 1);
            graphics.beginPath();
            graphics.moveTo(20, -26 + bodySlam);
            graphics.lineTo(28, -42 + bodySlam);
            graphics.lineTo(22, -40 + bodySlam);
            graphics.lineTo(16, -30 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemColor, 0.9);
            graphics.beginPath();
            graphics.moveTo(21, -28 + bodySlam);
            graphics.lineTo(27, -40 + bodySlam);
            graphics.lineTo(23, -38 + bodySlam);
            graphics.lineTo(18, -30 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemBright, 0.6);
            graphics.fillCircle(24, -36 + bodySlam, 1.5);
            // Secondary shard
            graphics.fillStyle(gemDark, 1);
            graphics.beginPath();
            graphics.moveTo(18, -28 + bodySlam);
            graphics.lineTo(22, -36 + bodySlam);
            graphics.lineTo(16, -32 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemColor, 0.8);
            graphics.beginPath();
            graphics.moveTo(18, -29 + bodySlam);
            graphics.lineTo(21, -35 + bodySlam);
            graphics.lineTo(17, -32 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            // Third small shard
            graphics.fillStyle(gemColor, 0.7);
            graphics.beginPath();
            graphics.moveTo(24, -28 + bodySlam);
            graphics.lineTo(27, -34 + bodySlam);
            graphics.lineTo(23, -30 + bodySlam);
            graphics.closePath();
            graphics.fillPath();

            // Gem glow on shoulder crystals
            graphics.fillStyle(gemBright, eyePulse * 0.5);
            graphics.fillCircle(-24, -35 + bodySlam, 3);
            graphics.fillCircle(24, -35 + bodySlam, 3);

            // === FALLING CRYSTAL DEBRIS (only while moving) ===
            if (isMoving) {
                const debrisCount = 4;
                for (let i = 0; i < debrisCount; i++) {
                    // Each debris has its own phase offset
                    const debrisPhase = ((now + i * 370) % 1200) / 1200;
                    const debrisAlpha = 1 - debrisPhase; // fade out as they fall
                    if (debrisAlpha > 0.1) {
                        // Scatter from shoulder areas, fall downward
                        const side = i % 2 === 0 ? -1 : 1;
                        const baseX = side * (16 + (i * 3));
                        const debrisX = baseX + Math.sin(debrisPhase * 4 + i) * 3;
                        const debrisY = -26 + bodySlam + debrisPhase * 40; // fall from shoulders to ground
                        const size = 1.5 + (1 - debrisPhase) * 1.5; // shrink as they fall

                        graphics.fillStyle(gemColor, debrisAlpha * 0.8);
                        // Small crystal shard shape
                        graphics.beginPath();
                        graphics.moveTo(debrisX, debrisY - size);
                        graphics.lineTo(debrisX - size * 0.7, debrisY);
                        graphics.lineTo(debrisX, debrisY + size * 0.5);
                        graphics.lineTo(debrisX + size * 0.7, debrisY);
                        graphics.closePath();
                        graphics.fillPath();
                    }
                }
            }
        } else {
            // L1/L2: Original stone spikes
            graphics.fillStyle(stoneLight, 1);
            // Left spike
            graphics.beginPath();
            graphics.moveTo(-20, -26 + bodySlam);
            graphics.lineTo(-26, -34 + bodySlam);
            graphics.lineTo(-18, -30 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            // Right spike
            graphics.beginPath();
            graphics.moveTo(20, -26 + bodySlam);
            graphics.lineTo(26, -34 + bodySlam);
            graphics.lineTo(18, -30 + bodySlam);
            graphics.closePath();
            graphics.fillPath();

            // Glowing crystal cores in spikes
            graphics.fillStyle(glowColor, eyePulse * 0.7);
            graphics.fillCircle(-22, -30 + bodySlam, 2);
            graphics.fillCircle(22, -30 + bodySlam, 2);
        }

        // L3: Gems embedded in head
        if (troopLevel >= 3) {
            // Forehead gem
            graphics.fillStyle(gemDark, 1);
            graphics.beginPath();
            graphics.moveTo(0, -53 + bodySlam);
            graphics.lineTo(-3, -50 + bodySlam);
            graphics.lineTo(0, -48 + bodySlam);
            graphics.lineTo(3, -50 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemColor, 0.9);
            graphics.beginPath();
            graphics.moveTo(0, -52.5 + bodySlam);
            graphics.lineTo(-2, -50 + bodySlam);
            graphics.lineTo(0, -48.5 + bodySlam);
            graphics.lineTo(2, -50 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemBright, 0.7);
            graphics.fillCircle(0, -50.5 + bodySlam, 1);

            // Small gem shards on jaw
            graphics.fillStyle(gemColor, 0.6);
            graphics.beginPath();
            graphics.moveTo(-10, -38 + bodySlam);
            graphics.lineTo(-12, -42 + bodySlam);
            graphics.lineTo(-8, -40 + bodySlam);
            graphics.closePath();
            graphics.fillPath();
            graphics.fillStyle(gemColor, 0.6);
            graphics.beginPath();
            graphics.moveTo(10, -38 + bodySlam);
            graphics.lineTo(12, -42 + bodySlam);
            graphics.lineTo(8, -40 + bodySlam);
            graphics.closePath();
            graphics.fillPath();

            // Head cracks glow with gem color
            graphics.lineStyle(1, gemColor, 0.3);
            graphics.lineBetween(-10, -52 + bodySlam, -8, -46 + bodySlam);
            graphics.lineBetween(12, -50 + bodySlam, 10, -44 + bodySlam);
        }
    }
    private static drawRecursion(graphics: Phaser.GameObjects.Graphics, isPlayer: boolean, isMoving: boolean = false, troopLevel: number = 1, time: number = Date.now(), attackAge: number = -1, attackDelay: number = 0) {
        // Fractal/geometric entity that splits on death
        const bodyColor = isPlayer ? 0x00ffaa : 0xaa00ff;
        const innerColor = isPlayer ? 0x00aa77 : 0x7700aa;
        const now = time;

        // Hover bob when moving
        const hoverBob = isMoving ? Math.sin(now / 200) * 2 : 0;

        // Attack animation: expands and contracts with energy burst.
        // Cycle locks to the real attack cadence when combat state is known.
        const cycle = attackDelay > 0 ? attackDelay : 850;
        const inCombat = attackAge >= 0;
        const attackPhase = (!isMoving && (!inCombat || attackAge <= cycle + 600)) ? ((inCombat ? Math.min(attackAge, cycle - 1) : now % cycle) / cycle) : 0;
        let attackPulse = 0;
        let burstAlpha = 0;
        if (!isMoving) {
            if (attackPhase < 0.15) {
                // Contract inward
                attackPulse = -(attackPhase / 0.15) * 3;
            } else if (attackPhase < 0.35) {
                // Expand outward with burst
                const t = (attackPhase - 0.15) / 0.2;
                attackPulse = -3 + 7 * t;
                burstAlpha = t;
            } else if (attackPhase < 0.5) {
                // Hold expanded
                attackPulse = 4;
                burstAlpha = 1 - (attackPhase - 0.35) / 0.15;
            } else {
                // Return to normal
                const t = (attackPhase - 0.5) / 0.5;
                attackPulse = 4 * (1 - t);
            }
        }

        const outerRadius = 10 + attackPulse;
        const innerRadius = 5 + attackPulse * 0.4;

        // Shadow
        graphics.fillStyle(0x000000, 0.3);
        graphics.fillEllipse(0, 5, 14, 6);

        // Energy burst rings during attack
        if (burstAlpha > 0) {
            graphics.lineStyle(2, bodyColor, burstAlpha * 0.6);
            graphics.strokeCircle(0, -2 + hoverBob, outerRadius + 5);
            graphics.lineStyle(1, 0xffffff, burstAlpha * 0.4);
            graphics.strokeCircle(0, -2 + hoverBob, outerRadius + 8);
        }

        // Outer hexagonal shell (rotating slowly, faster when attacking)
        const rotSpeed = !isMoving ? 800 : 2000;
        const rot = now / rotSpeed;
        graphics.fillStyle(bodyColor, 0.9);
        graphics.beginPath();
        for (let i = 0; i < 6; i++) {
            const angle = rot + (i / 6) * Math.PI * 2;
            const px = Math.cos(angle) * outerRadius;
            const py = Math.sin(angle) * outerRadius * 0.6 - 2 + hoverBob;
            if (i === 0) graphics.moveTo(px, py);
            else graphics.lineTo(px, py);
        }
        graphics.closePath();
        graphics.fillPath();

        // Inner hexagon (counter-rotating)
        graphics.fillStyle(innerColor, 1);
        graphics.beginPath();
        for (let i = 0; i < 6; i++) {
            const angle = -rot * 1.5 + (i / 6) * Math.PI * 2;
            const px = Math.cos(angle) * innerRadius;
            const py = Math.sin(angle) * innerRadius * 0.6 - 2 + hoverBob;
            if (i === 0) graphics.moveTo(px, py);
            else graphics.lineTo(px, py);
        }
        graphics.closePath();
        graphics.fillPath();

        // Central core with split symbol
        graphics.fillStyle(0xffffff, 0.9);
        graphics.fillCircle(0, -2 + hoverBob, 2.5);
        graphics.lineStyle(1, bodyColor, 1);
        graphics.lineBetween(-1.5, -2 + hoverBob, 1.5, -2 + hoverBob);
        graphics.lineBetween(0, -3.5 + hoverBob, 0, -0.5 + hoverBob);

        // Energy wisps when attacking
        if (!isMoving) {
            for (let i = 0; i < 3; i++) {
                const wAngle = (now / 150 + i * 2.1) % (Math.PI * 2);
                const wDist = outerRadius + 3 + Math.sin(now / 100 + i) * 2;
                const wx = Math.cos(wAngle) * wDist;
                const wy = Math.sin(wAngle) * wDist * 0.6 - 2 + hoverBob;
                graphics.fillStyle(bodyColor, 0.4 + Math.sin(now / 60 + i) * 0.3);
                graphics.fillCircle(wx, wy, 1.5);
            }
        }

        // L2: Extra outer ring + gold core
        if (troopLevel >= 2) {
            graphics.lineStyle(1.5, 0xdaa520, 0.6);
            graphics.beginPath();
            for (let i = 0; i < 6; i++) {
                const angle = rot * 0.5 + (i / 6) * Math.PI * 2;
                const px = Math.cos(angle) * (outerRadius + 4);
                const py = Math.sin(angle) * (outerRadius + 4) * 0.6 - 2 + hoverBob;
                if (i === 0) graphics.moveTo(px, py);
                else graphics.lineTo(px, py);
            }
            graphics.closePath();
            graphics.strokePath();
            // Gold core accent
            graphics.fillStyle(0xffd700, 0.5);
            graphics.fillCircle(0, -2 + hoverBob, 1.5);
        }
        // L3: Brighter core + extra orbiting particles
        if (troopLevel >= 3) {
            graphics.fillStyle(0xffffff, 0.4);
            graphics.fillCircle(0, -2 + hoverBob, 2.5);
            for (let i = 0; i < 4; i++) {
                const pAngle = rot * 1.5 + (i / 4) * Math.PI * 2;
                const px = Math.cos(pAngle) * (outerRadius + 6);
                const py = Math.sin(pAngle) * (outerRadius + 6) * 0.6 - 2 + hoverBob;
                graphics.fillStyle(bodyColor, 0.5);
                graphics.fillCircle(px, py, 1);
            }
        }
    }
    static drawDaVinciTank(graphics: Phaser.GameObjects.Graphics, isPlayer: boolean, _isMoving: boolean, isDeactivated: boolean = false, facingAngle: number = 0, troopLevel: number = 1, time: number = Date.now()) {
        // LEONARDO DA VINCI'S ARMORED WAR MACHINE
        // Conical wooden tank with cannons all around the base - NO rotation when moving
        // Rotation only happens after each shot (controlled by facingAngle from MainScene)

        // Use facingAngle for rotation - only changes when shooting
        const rotation = facingAngle;

        // Colors - warm wood tones
        const woodMain = isDeactivated ? 0x6a5040 : (isPlayer ? 0xc9a07a : 0xb8956e);
        const woodDark = isDeactivated ? 0x4a3530 : (isPlayer ? 0x9a7050 : 0x8a6548);
        const woodLight = isDeactivated ? 0x8a7060 : (isPlayer ? 0xdab898 : 0xd0a080);
        const woodPlank = isDeactivated ? 0x5a4535 : (isPlayer ? 0xb08560 : 0xa57852);
        const metalColor = isDeactivated ? 0x3a3a3a : (troopLevel >= 3 ? 0xdaa520 : 0x4a4a4a);
        const metalDark = isDeactivated ? 0x2a2a2a : (troopLevel >= 3 ? 0xb8860b : 0x333333);
        const cannonColor = isDeactivated ? 0x2a2a2a : (troopLevel >= 3 ? 0xc99a18 : 0x1a1a1a);

        // Deactivation visual - darker, no glow
        const alpha = isDeactivated ? 0.7 : 1;

        // Giant shadow
        graphics.fillStyle(0x000000, 0.4 * alpha);
        graphics.fillEllipse(0, 15, 50, 25);

        // === BASE PLATFORM ===
        graphics.fillStyle(woodDark, alpha);
        graphics.beginPath();
        graphics.moveTo(-28, 10);
        graphics.lineTo(28, 10);
        graphics.lineTo(22, 18);
        graphics.lineTo(-22, 18);
        graphics.closePath();
        graphics.fillPath();

        graphics.fillStyle(woodPlank, alpha);
        graphics.beginPath();
        graphics.moveTo(-26, 8);
        graphics.lineTo(26, 8);
        graphics.lineTo(22, 14);
        graphics.lineTo(-22, 14);
        graphics.closePath();
        graphics.fillPath();

        // === CANNON RING (8 cannons around the base) ===
        const numCannons = 8;
        const cannonRingRadius = 26;
        const cannonLength = 12;

        for (let i = 0; i < numCannons; i++) {
            const angle = rotation + (i / numCannons) * Math.PI * 2;
            const cx = Math.cos(angle) * cannonRingRadius;
            const cy = Math.sin(angle) * cannonRingRadius * 0.5 + 2; // Flatten for iso

            // Cannon mount (dark rectangle)
            graphics.fillStyle(metalDark, alpha);
            const mountSize = 5;
            graphics.fillRect(cx - mountSize / 2, cy - mountSize / 2, mountSize, mountSize);

            // Cannon barrel
            const barrelEndX = cx + Math.cos(angle) * cannonLength;
            const barrelEndY = cy + Math.sin(angle) * cannonLength * 0.5;

            graphics.lineStyle(troopLevel >= 3 ? 5.5 : 4, cannonColor, alpha);
            graphics.lineBetween(cx, cy, barrelEndX, barrelEndY);

            // Cannon muzzle ring
            graphics.fillStyle(metalColor, alpha);
            graphics.fillCircle(barrelEndX, barrelEndY, troopLevel >= 3 ? 4 : 3);
            graphics.fillStyle(0x000000, alpha);
            graphics.fillCircle(barrelEndX, barrelEndY, troopLevel >= 3 ? 2 : 1.5);
        }

        // === LOWER CONE (sloped wooden armor) ===
        // Draw as polygonal cone with wood planks
        const coneSegments = 16;
        const coneBaseRadius = 24;
        const coneMidRadius = 18;
        const coneBaseY = 5;
        const coneMidY = -15;

        // Draw cone sides as trapezoids (wood planks)
        for (let i = 0; i < coneSegments; i++) {
            const angle1 = rotation + (i / coneSegments) * Math.PI * 2;
            const angle2 = rotation + ((i + 1) / coneSegments) * Math.PI * 2;

            // Base points
            const bx1 = Math.cos(angle1) * coneBaseRadius;
            const by1 = Math.sin(angle1) * coneBaseRadius * 0.5 + coneBaseY;
            const bx2 = Math.cos(angle2) * coneBaseRadius;
            const by2 = Math.sin(angle2) * coneBaseRadius * 0.5 + coneBaseY;

            // Mid-cone points
            const mx1 = Math.cos(angle1) * coneMidRadius;
            const my1 = Math.sin(angle1) * coneMidRadius * 0.5 + coneMidY;
            const mx2 = Math.cos(angle2) * coneMidRadius;
            const my2 = Math.sin(angle2) * coneMidRadius * 0.5 + coneMidY;

            // Alternate plank colors for texture
            const plankColor = i % 2 === 0 ? woodMain : woodPlank;
            graphics.fillStyle(plankColor, alpha);
            graphics.beginPath();
            graphics.moveTo(bx1, by1);
            graphics.lineTo(bx2, by2);
            graphics.lineTo(mx2, my2);
            graphics.lineTo(mx1, my1);
            graphics.closePath();
            graphics.fillPath();

            // Plank line (groove between planks)
            graphics.lineStyle(1, woodDark, alpha * 0.6);
            graphics.lineBetween(bx1, by1, mx1, my1);
        }

        // === UPPER CONE (steeper slope to turret) ===
        const coneTopRadius = 8;
        const coneTopY = -32;

        for (let i = 0; i < coneSegments; i++) {
            const angle1 = rotation + (i / coneSegments) * Math.PI * 2;
            const angle2 = rotation + ((i + 1) / coneSegments) * Math.PI * 2;

            // Mid-cone points
            const mx1 = Math.cos(angle1) * coneMidRadius;
            const my1 = Math.sin(angle1) * coneMidRadius * 0.5 + coneMidY;
            const mx2 = Math.cos(angle2) * coneMidRadius;
            const my2 = Math.sin(angle2) * coneMidRadius * 0.5 + coneMidY;

            // Top points
            const tx1 = Math.cos(angle1) * coneTopRadius;
            const ty1 = Math.sin(angle1) * coneTopRadius * 0.5 + coneTopY;
            const tx2 = Math.cos(angle2) * coneTopRadius;
            const ty2 = Math.sin(angle2) * coneTopRadius * 0.5 + coneTopY;

            const plankColor = i % 2 === 0 ? woodLight : woodMain;
            graphics.fillStyle(plankColor, alpha);
            graphics.beginPath();
            graphics.moveTo(mx1, my1);
            graphics.lineTo(mx2, my2);
            graphics.lineTo(tx2, ty2);
            graphics.lineTo(tx1, ty1);
            graphics.closePath();
            graphics.fillPath();

            graphics.lineStyle(1, woodDark, alpha * 0.5);
            graphics.lineBetween(mx1, my1, tx1, ty1);
        }

        // === TURRET RIM (metal band) - Only draw FRONT arc to avoid layering issues ===
        graphics.lineStyle(3, metalColor, alpha);
        // Draw front half of ellipse only (from -PI/2 to PI/2 relative to view)
        graphics.beginPath();
        for (let t = 0; t <= Math.PI; t += 0.1) {
            const px = Math.cos(t) * coneMidRadius;
            const py = Math.sin(t) * coneMidRadius * 0.5 + coneMidY;
            if (t === 0) graphics.moveTo(px, py);
            else graphics.lineTo(px, py);
        }
        graphics.strokePath();

        // === TOP TURRET (viewing platform with smaller cone) ===
        const turretRadius = 10;
        const turretY = coneTopY;

        // Turret base ring
        graphics.fillStyle(metalDark, alpha);
        graphics.fillEllipse(0, turretY + 2, turretRadius * 2 + 2, turretRadius + 1);
        graphics.fillStyle(woodDark, alpha);
        graphics.fillEllipse(0, turretY, turretRadius * 2, turretRadius);

        // Small top cone
        const topConeRadius = 6;
        const topConeY = coneTopY - 12;

        for (let i = 0; i < 8; i++) {
            const angle1 = rotation + (i / 8) * Math.PI * 2;
            const angle2 = rotation + ((i + 1) / 8) * Math.PI * 2;

            const bx1 = Math.cos(angle1) * coneTopRadius;
            const by1 = Math.sin(angle1) * coneTopRadius * 0.5 + turretY;
            const bx2 = Math.cos(angle2) * coneTopRadius;
            const by2 = Math.sin(angle2) * coneTopRadius * 0.5 + turretY;

            const tx1 = Math.cos(angle1) * topConeRadius * 0.3;
            const ty1 = Math.sin(angle1) * topConeRadius * 0.3 * 0.5 + topConeY;
            const tx2 = Math.cos(angle2) * topConeRadius * 0.3;
            const ty2 = Math.sin(angle2) * topConeRadius * 0.3 * 0.5 + topConeY;

            const topPlankColor = i % 2 === 0 ? woodLight : woodMain;
            graphics.fillStyle(topPlankColor, alpha);
            graphics.beginPath();
            graphics.moveTo(bx1, by1);
            graphics.lineTo(bx2, by2);
            graphics.lineTo(tx2, ty2);
            graphics.lineTo(tx1, ty1);
            graphics.closePath();
            graphics.fillPath();
        }

        // Top finial (metal spike)
        graphics.fillStyle(metalColor, alpha);
        graphics.beginPath();
        graphics.moveTo(0, topConeY - 8);
        graphics.lineTo(-3, topConeY);
        graphics.lineTo(3, topConeY);
        graphics.closePath();
        graphics.fillPath();
        graphics.fillStyle(metalDark, alpha);
        graphics.fillCircle(0, topConeY, 3);

        // === VIEWING SLITS (between lower and upper cone) - Only FRONT half ===
        for (let i = 0; i < 8; i++) {
            const angle = rotation + (i / 8) * Math.PI * 2 + Math.PI / 8;
            const slitY = Math.sin(angle) * (coneMidRadius - 2) * 0.5 + coneMidY + 3;

            // Only draw if on FRONT side (positive Y relative to center means front)
            if (Math.sin(angle) > -0.2) {
                const slitX = Math.cos(angle) * (coneMidRadius - 2);
                graphics.fillStyle(0x000000, alpha * 0.8);
                graphics.fillRect(slitX - 3, slitY - 1, 6, 2);
            }
        }

        // === RIVETS along the metal bands - Only FRONT half ===
        graphics.fillStyle(metalColor, alpha);
        for (let i = 0; i < 12; i++) {
            const angle = rotation + (i / 12) * Math.PI * 2;

            // Only draw if on FRONT side
            if (Math.sin(angle) > -0.2) {
                const rx = Math.cos(angle) * (coneMidRadius + 1);
                const ry = Math.sin(angle) * (coneMidRadius + 1) * 0.5 + coneMidY;
                graphics.fillCircle(rx, ry, 1.5);
            }
        }

        // === DEACTIVATION EFFECT ===
        if (isDeactivated) {
            // Smoke wisps from deactivated tank
            const now = time;
            for (let i = 0; i < 3; i++) {
                const smokePhase = ((now / 2000) + i * 0.33) % 1;
                // Deterministic drift (iron rule: no Math.random() per frame).
                const smokeX = Math.sin(now / 900 + i * 2.1) * 5;
                const smokeY = -35 - smokePhase * 30;
                const smokeAlpha = (1 - smokePhase) * 0.3;
                graphics.fillStyle(0x333333, smokeAlpha);
                graphics.fillCircle(smokeX, smokeY, 3 + smokePhase * 4);
            }

            // Damage marks
            graphics.fillStyle(0x2a1a0a, 0.6);
            graphics.fillCircle(-8, -5, 4);
            graphics.fillCircle(10, -18, 3);
            graphics.fillCircle(-5, -28, 2);
        }

        // L2: Gold finial, decorative eagle emblem, gold rivet accents
        if (troopLevel >= 2 && !isDeactivated) {
            // Gold top finial instead of metal
            graphics.fillStyle(0xffd700, alpha);
            graphics.beginPath();
            graphics.moveTo(0, topConeY - 10);
            graphics.lineTo(-2, topConeY - 2);
            graphics.lineTo(2, topConeY - 2);
            graphics.closePath();
            graphics.fillPath();
            // Gold band around mid-cone
            graphics.lineStyle(2, 0xdaa520, alpha * 0.8);
            graphics.beginPath();
            for (let t = 0; t <= Math.PI; t += 0.1) {
                const px = Math.cos(t) * (coneMidRadius + 1);
                const py = Math.sin(t) * (coneMidRadius + 1) * 0.5 + coneMidY + 3;
                if (t === 0) graphics.moveTo(px, py);
                else graphics.lineTo(px, py);
            }
            graphics.strokePath();
        }
        // L3: Second gold band at base + golden glow around top finial
        if (troopLevel >= 3 && !isDeactivated) {
            graphics.lineStyle(2, 0xdaa520, alpha * 0.8);
            graphics.beginPath();
            for (let t = 0; t <= Math.PI; t += 0.1) {
                const px = Math.cos(t) * (coneBaseRadius + 1);
                const py = Math.sin(t) * (coneBaseRadius + 1) * 0.5 + coneBaseY;
                if (t === 0) graphics.moveTo(px, py);
                else graphics.lineTo(px, py);
            }
            graphics.strokePath();
            // Golden glow halo on finial
            graphics.fillStyle(0xffd700, 0.3);
            graphics.fillCircle(0, topConeY - 6, 5);
        }
    }
}
