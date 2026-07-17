import Phaser from 'phaser';
import { TROOP_DEFINITIONS, type TroopType } from '../config/GameDefinitions';
import { drawGolemC } from './redesign/GolemC';
import { drawIceGolem as drawIceGolemArt } from './redesign/IceGolem';
import { activeDesign, type DesignUnit } from './redesign/DesignRegistry';

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
 * but any human crew on them uses this same villager scale.
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
    static drawTroopVisual(
        graphics: G,
        type: TroopType,
        owner: 'PLAYER' | 'ENEMY',
        facingAngle: number = 0,
        isMoving: boolean = true,
        slamOffset: number = 0,
        mortarRecoil: number = 0,
        // Boolean for the da-vinci husk; the siege tower rides the same slot
        // as its continuous parked01 driver (0 rolling → 1 parked).
        isDeactivated: boolean | number = false,
        phalanxSpearOffset: number = 0,
        troopLevel: number = 1,
        // Callers MUST pass sim/scene time; the default is a deterministic
        // static pose (never Date.now() — wall-clock varies per render and
        // poisons bakes/postcards).
        time: number = 0,
        attackAge: number = -1,
        attackDelay: number = 0
    ) {
        const isPlayer = owner === 'PLAYER';

        switch (type) {
            case 'warrior':
                TroopRenderer.drawWarrior(graphics, isPlayer, isMoving, troopLevel, time, attackAge, attackDelay);
                break;
            case 'archer':
                TroopRenderer.drawArcher(graphics, isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay);
                break;
            case 'golem':
                TroopRenderer.drawGolem(graphics, isPlayer, isMoving, slamOffset, troopLevel, time);
                break;
            case 'icegolem':
                TroopRenderer.drawIceGolem(graphics, isPlayer, isMoving, slamOffset, troopLevel, time);
                break;
            case 'mobilemortar':
                TroopRenderer.drawMobileMortar(graphics, isPlayer, isMoving, facingAngle, mortarRecoil, troopLevel, time, attackAge, attackDelay);
                break;
            case 'ram':
                TroopRenderer.drawRam(graphics, isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay);
                break;
            case 'stormmage':
                TroopRenderer.drawStormMage(graphics, isPlayer, isMoving, troopLevel, time, attackAge, attackDelay);
                break;
            case 'davincitank':
                TroopRenderer.drawDaVinciTank(graphics, isPlayer, isMoving, !!isDeactivated, facingAngle, troopLevel, time);
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
            // ===== 2026-07 troop-overhaul units: tournament slot when filled,
            // neutral placeholder until then (art phase pending) =====
            case 'goblinplunderer':
                TroopRenderer.drawNewTroop(graphics, 'goblinplunderer', isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay, 0);
                break;
            case 'clockworkbeetle':
                TroopRenderer.drawNewTroop(graphics, 'clockworkbeetle', isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay, 0);
                break;
            case 'physicianscart':
                TroopRenderer.drawNewTroop(graphics, 'physicianscart', isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay, 0);
                break;
            case 'quartermaster':
                TroopRenderer.drawNewTroop(graphics, 'quartermaster', isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay, 0);
                break;
            case 'siegetower':
                // driver = parked01 (the davincitank isDeactivated plumbing);
                // MainScene tweens it 0→1 through the redraw path on parking.
                TroopRenderer.drawNewTroop(graphics, 'siegetower', isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay,
                    typeof isDeactivated === 'number' ? Math.max(0, Math.min(1, isDeactivated)) : (isDeactivated ? 1 : 0));
                break;
            case 'necromancer':
                TroopRenderer.drawNewTroop(graphics, 'necromancer', isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay, 0);
                break;
            case 'trebuchet':
                TroopRenderer.drawNewTroop(graphics, 'trebuchet', isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay, 0);
                break;
            case 'warelephant':
                TroopRenderer.drawNewTroop(graphics, 'warelephant', isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay, 0);
                break;
            case 'ornithopter':
                TroopRenderer.drawNewTroop(graphics, 'ornithopter', isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay, 0);
                break;
            case 'skeleton': {
                // Generated-only summon: art ships inside the winning
                // necromancer design (skeleton slots mirror necromancer's).
                const skeletonDesign = activeDesign('skeleton');
                if (skeletonDesign) {
                    skeletonDesign(graphics, isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay, 0);
                } else {
                    TroopRenderer.drawPlaceholder(graphics, 'skeleton', isPlayer, isMoving, time);
                }
                break;
            }
        }
    }

    /** New-troop dispatch: the live tournament design when a slot is filled,
     *  else the neutral placeholder. `driver` = the unit's bespoke tweened
     *  driver (parked01 for siegetower), 0 when unused. */
    private static drawNewTroop(
        g: G,
        unit: Exclude<DesignUnit, 'frostfall'>,
        isPlayer: boolean,
        isMoving: boolean,
        facingAngle: number,
        troopLevel: number,
        time: number,
        attackAge: number,
        attackDelay: number,
        driver: number
    ): void {
        const design = activeDesign(unit);
        if (design) {
            design(g, isPlayer, isMoving, facingAngle, troopLevel, time, attackAge, attackDelay, driver);
            return;
        }
        TroopRenderer.drawPlaceholder(g, unit, isPlayer, isMoving, time);
    }

    /** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
    private static shade(c: number, m: number): number {
        const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
        const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
        const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
        return (r << 16) | (g << 8) | b;
    }

    /**
     * Neutral tournament placeholder — a readable capsule figure in the
     * troop's definition colour, bulk scaled by housing space (space 1 ≈ the
     * villager-scale humanoid) so battle silhouettes stay honest before the
     * real art lands. All motion is a deterministic f(time): the walk bounce
     * closes on a 500 ms stride and the idle bob on an exact 2000 ms period
     * (250 ms harmonics — bake-safe, iron rule 3). Air units hover with a
     * detached ground shadow. Safe at every level and for both owners.
     */
    private static drawPlaceholder(g: G, type: TroopType, isPlayer: boolean, isMoving: boolean, time: number): void {
        const def = TROOP_DEFINITIONS[type];
        const color = def?.color ?? 0x9a9a9a;
        const space = def?.space ?? 1;
        const air = def?.movementType === 'air';
        const s = 0.85 + Math.sqrt(space) * 0.32; // space 1 ≈ ~19 px tall
        const bodyW = 6.6 * s;
        const bodyH = 13.5 * s;
        const bob = isMoving
            ? Math.abs(Math.sin(((time % 500) / 500) * Math.PI * 2)) * 1.1
            : (Math.sin(((time % 2000) / 2000) * Math.PI * 2) * 0.5 + 0.5) * 0.8;
        const hover = air ? 7 + Math.sin(((time % 2000) / 2000) * Math.PI * 2) * 1.2 : 0;
        const groundY = 9.5;
        const top = groundY - bodyH - bob - hover;
        const owner = isPlayer ? 1 : 0.7; // enemies darken (palette convention)

        // Contact shadow stays on the ground (air units cast it detached).
        g.fillStyle(0x000000, air ? 0.14 : 0.22);
        g.fillEllipse(0, groundY + 0.1, bodyW * (air ? 0.9 : 1.25), bodyW * 0.45);

        // Capsule body with a darker rim for silhouette read.
        g.fillStyle(TroopRenderer.shade(color, 0.55 * owner), 1);
        g.fillRoundedRect(-bodyW / 2 - 0.7, top - 0.7, bodyW + 1.4, bodyH + 1.4, (bodyW + 1.4) / 2);
        g.fillStyle(TroopRenderer.shade(color, owner), 1);
        g.fillRoundedRect(-bodyW / 2, top, bodyW, bodyH, bodyW / 2);
        // NW-light cap highlight + visor band so the figure reads as a unit.
        g.fillStyle(TroopRenderer.shade(color, 1.35 * owner), 1);
        g.fillEllipse(-bodyW * 0.14, top + bodyH * 0.18, bodyW * 0.52, bodyH * 0.2);
        g.fillStyle(TroopRenderer.shade(color, 0.4 * owner), 1);
        g.fillRect(-bodyW * 0.32, top + bodyH * 0.32, bodyW * 0.64, 1.4);
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
            // Ambient idle: breathe + a slow roll of the wrist — exactly one
            // roll per 2π·640 ms idle loop so the baked breath closes.
            swordA = -0.5 + Math.sin(time / 640) * 0.12;
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
        // Crystal glow closes on whichever loop is playing: one cycle per
        // 480 ms stride while walking, harmonic 2 of the idle breath at rest.
        const pulse = 0.75 + Math.sin(isMoving ? time * (Math.PI * 2) / 480 : time * 2 / 640) * 0.15;
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

        // Ambient: one lazy mote orbiting the crystal when nothing else is
        // on — idle only (it can't close over the walk stride), one orbit
        // per 2π·640 ms idle loop.
        if (!isMoving && wu === 0 && st === 0) {
            const ma = time / 640;
            g.fillStyle(glow, 0.3 + Math.max(0, rig.breathe) * 0.15);
            g.fillCircle(cX + Math.cos(ma) * 3.6, cY + Math.sin(ma) * 2.2, 0.8);
        }
        // L3: a thin arc crackles between hat tip and crystal at full charge.
        if (troopLevel >= 3 && wu > 0.5) {
            g.lineStyle(0.8, glow, 0.35 * wu);
            g.lineBetween(tipSway, -14.6 - lift, cX, cY);
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
        // Fuse sputter closes on the active loop: frantic near the blow
        // (combat keyframes, not looped), 2 cycles per 260 ms stride while
        // running, harmonic 7 of the idle breath (~575 ms) at rest.
        const sp = 0.6 + Math.sin(
            brace > 0 ? time / 45 : isMoving ? time * (Math.PI * 4) / 260 : time * 7 / 640
        ) * 0.4;
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

        // Soldier stride, cart bob and wheel rotation all share ONE 600 ms
        // walk period (they used to run at 400/400/600 and never co-repeat).
        const rig = TroopRenderer.hRig(time, isMoving, 600, 2.2, 6);
        const lift = rig.lift;
        const mortarBob = isMoving ? Math.abs(Math.sin(((time + 80) % 600) / 600 * Math.PI * 2)) * 1.2 : 0;
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
    static drawRomanSoldier(g: G, isPlayer: boolean, isMoving: boolean, facingAngle: number, isTestudo: boolean, spearOffset: number = 0, sx: number = 0, sy: number = 0, stagger: number = 0, troopLevel: number = 1, time: number = 0, attackAge: number = -1, attackDelay: number = 0): void {
        const atk = TroopRenderer.attackAnim(time, attackAge, attackDelay || 900, 260, 150);
        const marchPhase = isMoving ? ((time % 600) / 600 + stagger) % 1 : 0;
        // Bob at exactly 2 cycles per 600 ms march loop (the old sin(time/150)
        // period ~942 ms never co-repeated with the stride, so walk loops
        // could not close).
        const marchBob = isMoving ? Math.sin(time * (Math.PI * 2 * 2) / 600 + stagger * 10) * 1.3 : Math.max(0, Math.sin((time + stagger * 900) / 640)) * -0.4;
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
    static drawPhalanx(graphics: G, isPlayer: boolean, isMoving: boolean, facingAngle: number, spearOffset: number = 0, troopLevel: number = 1, time: number = 0): void {
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
            // Exact harmonics of the 600 ms march loop (1 and 2 cycles).
            const flagWave = isMoving ? Math.sin(time * (Math.PI * 2) / 600) * 2 : 0;
            const flagWave2 = isMoving ? Math.sin(time * (Math.PI * 2 * 2) / 600 + 1) * 1.5 : 0;

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
    /** Stone golem — tournament winner: design C ("The Runebound Cairn") is
     *  the canonical implementation (GolemC.ts stays the authoring source). */
    private static drawGolem(graphics: Phaser.GameObjects.Graphics, isPlayer: boolean, isMoving: boolean, slamOffset: number, troopLevel: number = 1, time: number = 0) {
        drawGolemC(graphics, isPlayer, isMoving, slamOffset, troopLevel, time);
    }
    /** Ice golem — "The Glacial Warden": the tournament's GolemB body
     *  (Cromlech Warden masonry) reskinned as glacial ice (IceGolem.ts is
     *  the authoring source). Same contract as drawGolem: slam driven only
     *  by slamOffset, facing resolved carrier-level inside the design fn. */
    private static drawIceGolem(graphics: Phaser.GameObjects.Graphics, isPlayer: boolean, isMoving: boolean, slamOffset: number, troopLevel: number = 1, time: number = 0) {
        drawIceGolemArt(graphics, isPlayer, isMoving, slamOffset, troopLevel, time);
    }
    static drawDaVinciTank(graphics: Phaser.GameObjects.Graphics, isPlayer: boolean, _isMoving: boolean, isDeactivated: boolean = false, facingAngle: number = 0, troopLevel: number = 1, time: number = 0) {
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
