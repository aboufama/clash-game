import type Phaser from 'phaser';

/**
 * WAR ELEPHANT — clean-room design C: "THE BREACHMAKER".
 *
 * Identity: mass and momentum. The bull carries its armored head LOW like a
 * battering ram and never stops walking; everything soft on the body (ears,
 * trunk, tail, head) trails the skeleton with inertia so the tonnage reads in
 * motion, not just in silhouette. The gait is the elephant amble — SAME-SIDE
 * leg pairs — which produces the heavy lateral sway no other troop has.
 *
 * The trample: during the windup the forequarters REAR UP (front feet leave
 * the ground, trunk curls high, ears flare), and on the damage tick the whole
 * front end piledrives DOWN through the wall line — body squashes, trunk is
 * thrown forward, a ground shock-ring and rubble chunks burst from the brow.
 *
 * Authored periods (the bake pipeline must use these):
 *   walk stride 1200 ms  ·  idle loop 2000 ms (terms at 2000/1000 ms)
 *   trample windup 900 ms  ·  strike 500 ms
 *
 * All motion is a deterministic f(time)/f(attackAge) — no randomness. Idle
 * terms are exact harmonics of the 2000 ms loop (a 250 ms multiple) with
 * ≥1.5 px amplitude on ears/trunk so they survive bake quantization. Walk
 * terms are exact harmonics of the 1200 ms stride so the baked loop closes.
 *
 * Level language (art guide §3): L1 leather + rope war-beast, L2 riveted
 * iron chanfron, L3 warm sandstone chanfron with SMALL gold accents (ridge,
 * boss, tusk rings, banner finial) — never large white/gold masses.
 * Owner read: player = royal-blue caparison, enemy = crimson + darkened hide.
 */

type G = Phaser.GameObjects.Graphics;

interface Pt {
    x: number;
    y: number;
}

const GROUND = 9.5;
const STRIDE_MS = 1200;
const IDLE_MS = 2000;
const WINDUP_MS = 900;
const STRIKE_MS = 500;

const easeIn = (t: number): number => t * t;

function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): stride
 *  1200 / windup 900 / strike 500 match the TROOP_PARAMS row, but the idle
 *  loop closes on IDLE_MS = 2000 (ear fan/trunk/breath at 2000, tail +
 *  L3 pennant at 1000) and the bake must sample attack ages against delay
 *  2000 = the runtime TroopDefinitions attackDelay (the table's 3000 would
 *  bake windup ages ~2100..2955 that runtime ages 1100..2000 mis-pair with
 *  strike frames under nearest-value matching). */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    warelephant: { delay: 2000, idleMs: 2000 },
};

export function drawWarelephantC(
    g: G,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number,
    troopLevel: number,
    time: number,
    attackAge: number = -1,
    attackDelay: number = 0,
    _driver: number = 0
): void {
    const lvl = Math.max(1, Math.min(3, Math.floor(troopLevel)));
    const ca = Math.cos(facingAngle);
    const sa = Math.sin(facingAngle);
    // Ground-plane mapping (art guide §6): d = along heading, w = across
    // (positive to the heading's right), h = world-vertical height. The iso
    // squash (0.5) applies only to ground-plane y.
    const X = (d: number, w: number): number => ca * d - sa * w;
    const Y = (d: number, w: number): number => (sa * d + ca * w) * 0.5;

    // ---------------- palette ----------------
    const hm = isPlayer ? 1 : 0.86; // enemy hide darkens (troop palette convention)
    const hideHi = shade(0xa0a1ad, hm);
    const hideMid = shade(0x81828e, hm);
    const hideLo = shade(0x60616b, hm);
    const hideDeep = shade(0x4a4b54, hm);
    const tuskCol = shade(0xeae2c9, isPlayer ? 1 : 0.92);
    const tuskLo = shade(0xc9be9e, isPlayer ? 1 : 0.92);
    const cloth = isPlayer ? 0x31518c : 0x8c2b2b;
    const clothLo = shade(cloth, 0.68);
    const clothHi = shade(cloth, 1.3);
    const gold = 0xdaa520;
    const goldHi = 0xffd700;
    // Chanfron material by level: leather → iron → warm sandstone.
    const plate = lvl === 1 ? 0x6f4c30 : lvl === 2 ? 0x7b818b : 0xc9c2ae;
    const plateHi = lvl === 1 ? 0x8a6242 : lvl === 2 ? 0x9ba1ab : 0xdcd3ba;
    const plateLo = lvl === 1 ? 0x54371f : lvl === 2 ? 0x565b64 : 0xa79f88;

    // ---------------- attack (trample) phases ----------------
    const delay = attackDelay > 0 ? attackDelay : 2000;
    let w01 = 0; // windup: 0→1 rear-up during the last WINDUP_MS before the tick
    let s01 = 0; // strike: 1→0 impact decay in the first STRIKE_MS after the tick
    let trampleProg = -1; // 0→1 through the strike window (drives shock/dust)
    if (attackAge >= 0) {
        let age = attackAge;
        // Stale ages (replays never refresh lastAttackTime) free-run.
        if (age > delay + 600) age = time % delay;
        const remaining = delay - age;
        if (remaining >= 0 && remaining < WINDUP_MS) w01 = easeIn(1 - remaining / WINDUP_MS);
        if (age >= 0 && age < STRIKE_MS) {
            trampleProg = age / STRIKE_MS;
            s01 = (1 - trampleProg) * (1 - trampleProg);
        }
    }
    const gaitMul = 1 - Math.max(w01, s01 * 0.7); // gait fades while trampling

    // ---------------- gait / idle drivers ----------------
    // Moving: everything closes on the 1200 ms stride (same-side amble).
    // Idle: everything closes on the exact 2000 ms loop (1000 ms harmonics OK).
    let legSwingL = 0;
    let legSwingR = 0;
    let liftL = 0;
    let liftR = 0;
    let roll = 0; // across-heading weight shift
    let bob = 0; // whole-body vertical
    let earFlap = 0; // ear fan amount (px, outward)
    let trunkSwayD = 0; // trunk pendulum, along heading
    let trunkSwayW = 0; // trunk pendulum, across heading
    let headDip = 0; // head momentum lag (vertical)
    let tailSway = 0;
    let pennantWave = 0;
    if (isMoving) {
        const th = ((time % STRIDE_MS) / STRIDE_MS) * Math.PI * 2;
        legSwingL = Math.sin(th) * 2.6 * gaitMul;
        legSwingR = Math.sin(th + Math.PI) * 2.6 * gaitMul;
        liftL = Math.max(0, Math.cos(th)) * 2.4 * gaitMul;
        liftR = Math.max(0, Math.cos(th + Math.PI)) * 2.4 * gaitMul;
        // Weight rolls over the planted side while the other side swings.
        roll = Math.cos(th) * 1.2 * gaitMul;
        bob = Math.abs(Math.sin(th)) * 0.8;
        headDip = Math.sin(th - 0.7) * 0.9; // lags the shoulders — inertia
        earFlap = Math.abs(Math.sin(th - 0.9)) * 1.7;
        trunkSwayD = Math.sin(th - 1.2) * 2.4;
        trunkSwayW = Math.sin(th - 1.9) * 1.1;
        tailSway = Math.sin(th + 0.6) * 1.9;
        pennantWave = Math.sin(((time % 600) / 600) * Math.PI * 2) * 1.8; // 1200/2
    } else {
        const ti = ((time % IDLE_MS) / IDLE_MS) * Math.PI * 2;
        bob = (Math.sin(ti) * 0.5 + 0.5) * 0.9; // slow breath rise
        roll = Math.sin(ti) * 0.55; // weight shifting foot to foot
        earFlap = (Math.sin(ti) * 0.5 + 0.5) * 2.0; // lazy ear fanning ≥1.5 px
        trunkSwayW = Math.sin(ti) * 1.7; // trunk tip sway ≥1.5 px
        trunkSwayD = Math.sin(ti + Math.PI * 0.5) * 0.8;
        headDip = Math.sin(ti) * 0.5;
        tailSway = Math.sin(ti * 2) * 1.3; // 1000 ms harmonic
        pennantWave = Math.sin(((time % 1000) / 1000) * Math.PI * 2) * 1.8;
    }

    // ---------------- pose (momentum, rear-up, piledrive) ----------------
    // pitch: +up at the brow, pivoting near the hips. Charging lean keeps the
    // head slightly low; windup rears the front 6 px up; the strike slams it
    // 3.4 px below neutral.
    const lean = isMoving ? -1.3 : 0;
    const pitch = lean + w01 * 6.2 - s01 * 3.4;
    const bx = -w01 * 1.8 + s01 * 1.7; // body lunges back then forward
    const bw = roll;
    const hMul = 1 - 0.09 * s01; // impact squash (body/blanket heights)
    const wMul = 1 + 0.07 * s01; // impact bulge
    const H = (d: number, h: number): number => h + pitch * ((d + 2) / 14);
    // Body-space point (follows shift/roll/pitch/bob).
    const pt = (d: number, w: number, h: number): Pt => ({
        x: X(d + bx, w + bw),
        y: GROUND + Y(d + bx, w + bw) - H(d, h) - bob
    });
    // Ground point (feet, shadow, dust — never shifted by the body).
    const gp = (d: number, w: number): Pt => ({ x: X(d, w), y: GROUND + Y(d, w) });
    const squash = (h: number): number => 4.8 + (h - 4.8) * hMul;

    // ---------------- ground shadow (ONE closed polygon — §8) ----------------
    const shPts: Pt[] = [];
    for (let k = 0; k < 18; k++) {
        const a2 = (k / 18) * Math.PI * 2;
        shPts.push({
            x: X(2.2 + 13.4 * Math.cos(a2), 7.1 * Math.sin(a2)),
            y: GROUND + Y(2.2 + 13.4 * Math.cos(a2), 7.1 * Math.sin(a2)) + 0.2
        });
    }
    g.fillStyle(0x000000, 0.2);
    g.fillPoints(shPts, true);

    // Trample shock-ring + breach cracks bursting forward from the brow.
    if (trampleProg >= 0) {
        const rr = 4.5 + trampleProg * 11;
        const ring: Pt[] = [];
        for (let k = 0; k < 16; k++) {
            const a2 = (k / 16) * Math.PI * 2;
            const p = gp(16.5 + rr * Math.cos(a2), rr * 0.95 * Math.sin(a2));
            ring.push(p);
        }
        g.lineStyle(1.8, 0x9c8768, 0.6 * (1 - trampleProg));
        g.strokePoints(ring, true);
        // ground fractures fanning out along the charge line
        g.lineStyle(1.3, 0x4d4d40, 0.55 * (1 - trampleProg * 0.8));
        for (const [aw, len] of [[-0.55, 7.5], [0.05, 9.5], [0.6, 7]] as const) {
            const a = gp(14.6, aw * 2);
            const b = gp(14.6 + len * (1 + trampleProg * 0.4), aw * (2 + len * 0.9));
            g.lineBetween(a.x, a.y, b.x, b.y);
        }
    }

    // ================= part painters =================

    const drawTail = (): void => {
        const segs = [
            { d: -10.2, w: 0, h: 13.0, r: 1.3 },
            { d: -11.3, w: tailSway * 0.4, h: 10.4, r: 1.1 },
            { d: -12.2, w: tailSway * 0.8, h: 8.0, r: 1.0 }
        ];
        g.fillStyle(hideLo, 1);
        for (const s of segs) {
            const p = pt(s.d, s.w, s.h);
            g.fillEllipse(p.x, p.y, s.r * 2, s.r * 2.4);
        }
        const tip = pt(-12.7, tailSway, 6.6);
        g.fillStyle(hideDeep, 1);
        g.fillEllipse(tip.x, tip.y, 2.2, 2.8);
    };

    interface Leg {
        d: number;
        s: number;
        front: boolean;
    }
    const legDefs: Leg[] = [
        { d: 5.4, s: -1, front: true },
        { d: 5.4, s: 1, front: true },
        { d: -6.6, s: -1, front: false },
        { d: -6.6, s: 1, front: false }
    ];
    const legDepth = (l: Leg): number => Y(l.d, l.s * (l.front ? 4.1 : 3.9));
    const sortedLegs = [...legDefs].sort((a, b) => legDepth(a) - legDepth(b));

    const drawLeg = (l: Leg, near: boolean): void => {
        const w = l.s * (l.front ? 4.1 : 3.9);
        const width = l.front ? 3.7 : 3.4;
        const swing = l.s < 0 ? legSwingL : legSwingR;
        let lift = l.s < 0 ? liftL : liftR;
        let footD = l.d + swing;
        let footW = w;
        if (l.front) {
            // Windup: front feet leave the ground, tucked back.
            lift += w01 * 5.2;
            footD += -w01 * 1.6 + s01 * 2.0; // then planted forward on impact
            footW = w * (1 + s01 * 0.22); // braced wide
        } else {
            // Hindquarters compress under the reared mass.
            footW = w * (1 + w01 * 0.18);
        }
        const hip = pt(l.d * 0.92, l.s * 3.4, 9.0 - (l.front ? 0 : w01 * 1.2));
        const foot = gp(footD, footW);
        foot.y -= lift;
        const col = near ? hideMid : hideLo;
        const hw = width / 2;
        g.fillStyle(shade(col, 0.94), 1);
        g.beginPath();
        g.moveTo(hip.x - hw, hip.y);
        g.lineTo(hip.x + hw, hip.y);
        g.lineTo(foot.x + hw * 0.92, foot.y - 0.6);
        g.lineTo(foot.x - hw * 0.92, foot.y - 0.6);
        g.closePath();
        g.fillPath();
        // Broad round foot + toenail band (near legs only — far ones vanish).
        g.fillStyle(shade(col, 0.8), 1);
        g.fillEllipse(foot.x, foot.y - 0.4, width * 1.3, width * 0.62);
        if (near) {
            const nx = foot.x + ca * width * 0.32;
            g.fillStyle(0xcac3ae, 0.85);
            g.fillEllipse(nx, foot.y - 0.15, width * 0.55, 0.8);
        }
    };

    const drawBody = (): void => {
        // Barrel: overlapping ellipse cluster along the heading (union reads
        // as one silhouette). Widths blend along-length ↔ across-width so the
        // mass stays believable at every heading.
        const segW = 10.8 * Math.abs(ca) + 11.3 * Math.abs(sa);
        const segs = [
            { d: -7.2, top: 13.4 },
            { d: -2.5, top: 14.4 },
            { d: 2.0, top: 15.0 },
            { d: 5.8, top: 15.7 }
        ];
        g.fillStyle(hideMid, 1);
        for (const s of segs) {
            const top = squash(s.top);
            const c = pt(s.d, 0, (top + 4.6) / 2);
            g.fillEllipse(c.x, c.y, segW * wMul, (top - 4.6) + Math.abs(ca) * 1.4);
        }
        // NW light on the back line, deep shade under the belly (fixed screen
        // directions — light never rotates with the heading).
        for (const s of [segs[1], segs[2]]) {
            const top = squash(s.top);
            const hSeg = (top - 4.6) + Math.abs(ca) * 1.4;
            const c = pt(s.d, 0, (top + 4.6) / 2);
            g.fillStyle(hideLo, 1);
            g.fillEllipse(c.x + 1.3, c.y + hSeg * 0.27, segW * 0.8, hSeg * 0.42);
            g.fillStyle(hideHi, 1);
            g.fillEllipse(c.x - 1.5, c.y - hSeg * 0.3, segW * 0.68, hSeg * 0.36);
        }

        // ---- caparison: soft saddle-cloth draped over the barrel ----
        // Ellipse cluster that follows the back curve (no hard box edges):
        // a darker, slightly larger under-pass reads as the hanging hem.
        const bWf = lvl === 1 ? 0.66 : 0.8; // cloth width vs body
        const clothSegs = lvl === 1
            ? [{ d: -4.6, top: 14.0 }, { d: -0.8, top: 14.7 }]
            : [{ d: -5.6, top: 13.9 }, { d: -1.2, top: 14.6 }, { d: 2.6, top: 15.1 }];
        for (const pass of [0, 1] as const) {
            g.fillStyle(pass === 0 ? clothLo : cloth, 1);
            for (const s of clothSegs) {
                const top = squash(s.top);
                const c = pt(s.d, 0, top - 2.6);
                const wEll = segW * bWf * wMul + (pass === 0 ? 1.2 : 0);
                const hEll = (top - 4.6) * 0.62 + (pass === 0 ? 1.6 : 0);
                g.fillEllipse(c.x, c.y + (pass === 0 ? 1.0 : 0), wEll, hEll);
            }
        }
        // Spine stripe along the ridge — a slim woven band, not a bar.
        const sA = pt(2.4, 0, squash(14.9) - 0.4);
        const sB = pt(-5.4, 0, squash(13.8) - 0.4);
        g.lineStyle(1.1, lvl === 3 ? 0xdcd3ba : clothHi, 1);
        g.lineBetween(sA.x, sA.y, sB.x, sB.y);
        if (lvl === 3) {
            // gold tassels swinging at the near hem — small accents only
            const nearS = ca >= 0 ? 1 : -1;
            g.fillStyle(gold, 1);
            for (const s of clothSegs) {
                const p = pt(s.d, nearS * 4.6, squash(s.top) - 5.4);
                g.fillEllipse(p.x, p.y, 1.3, 1.7);
            }
        }

        // L3: small back-banner — pole, gold finial, waving pennant.
        if (lvl === 3) {
            const base = pt(-5.8, 0, squash(12.6));
            const top = pt(-5.8, 0, squash(12.6) + 9.4);
            g.fillStyle(0x4a3a28, 1);
            g.fillRect(top.x - 0.55, top.y, 1.1, base.y - top.y);
            g.fillStyle(cloth, 1);
            g.beginPath();
            g.moveTo(top.x, top.y + 0.4);
            g.lineTo(top.x + 6.2, top.y + 1.8 + pennantWave);
            g.lineTo(top.x, top.y + 3.6);
            g.closePath();
            g.fillPath();
            g.fillStyle(goldHi, 1);
            g.fillEllipse(top.x, top.y - 0.6, 1.7, 1.7);
        }
    };

    const drawEar = (s: number): void => {
        // Ears fan with the gait/breath and flare wide during the windup.
        // Offset shading (rim below, fold crease inside) — concentric rings
        // read as a bullseye and were rejected on screenshots.
        const flare = earFlap + w01 * 1.8;
        const c = pt(9.4 + s01 * 1.4, s * (5.7 + flare * 0.55), 11.6 + w01 * 1.0 + headDip * 0.4);
        const ew = (5.0 + flare * 0.5) * (1 + 0.2 * w01);
        const eh = (6.6 + flare * 0.35) * (1 + 0.16 * w01);
        g.fillStyle(hideLo, 1);
        g.fillEllipse(c.x + 0.4, c.y + 0.5, ew + 0.9, eh + 0.9);
        g.fillStyle(hideHi, 1);
        g.fillEllipse(c.x - 0.3, c.y - 0.4, ew, eh);
        g.fillStyle(hideMid, 1);
        g.fillEllipse(c.x + 0.8, c.y + 1.1, ew * 0.6, eh * 0.6);
    };

    const drawDome = (): void => {
        const hd = headDip;
        // skull
        g.fillStyle(hideMid, 1);
        const dome = pt(11.6, 0, 10.3 + hd);
        g.fillEllipse(dome.x, dome.y, 8.6, 8.0 * hMul);
        const brow = pt(12.8, 0, 12.1 + hd);
        g.fillEllipse(brow.x, brow.y, 6.6, 5.6 * hMul);
        // under-jaw shade + crown light (fixed NW light)
        g.fillStyle(hideLo, 1);
        const jaw = pt(12.2, 0, 7.7 + hd);
        g.fillEllipse(jaw.x + 1.1, jaw.y + 0.8, 6.0, 3.2);
        g.fillStyle(hideHi, 1);
        g.fillEllipse(brow.x - 1.3, brow.y - 1.4, 4.4, 2.6);
    };

    const drawPlate = (): void => {
        const hd = headDip;
        // Chanfron plate over the brow (leather board → iron → sandstone).
        const c = pt(13.1, 0, 11.3 + hd);
        const pw = lvl === 1 ? 5.2 : 6.2;
        const ph = (lvl === 1 ? 4.4 : 5.2) * hMul;
        g.fillStyle(plateLo, 1);
        g.fillEllipse(c.x + 0.7, c.y + 0.7, pw, ph);
        g.fillStyle(plate, 1);
        g.fillEllipse(c.x, c.y, pw, ph);
        // center ridge running down the brow
        const rA = pt(10.9, 0, 14.3 + hd);
        const rB = pt(15.3, 0, 9.6 + hd);
        const rxw = -sa * 0.8;
        const ryw = ca * 0.4;
        g.fillStyle(plateHi, 1);
        g.beginPath();
        g.moveTo(rA.x - rxw, rA.y - ryw);
        g.lineTo(rA.x + rxw, rA.y + ryw);
        g.lineTo(rB.x + rxw, rB.y + ryw);
        g.lineTo(rB.x - rxw, rB.y - ryw);
        g.closePath();
        g.fillPath();
        // brow boss: wooden knot → iron rivet → gold roundel (small!)
        const boss = pt(14.5, 0, 10.5 + hd);
        g.fillStyle(lvl === 3 ? gold : lvl === 2 ? 0x3c4046 : 0x54371f, 1);
        g.fillEllipse(boss.x, boss.y, 2.3, 2.3);
        if (lvl === 3) {
            g.fillStyle(goldHi, 1);
            g.fillEllipse(boss.x - 0.4, boss.y - 0.4, 1.0, 1.0);
        }
        if (lvl === 2) {
            // two subtle rivet studs flanking the ridge (more read as measles)
            g.fillStyle(plateLo, 1);
            for (const [rd, rw] of [[12.4, -1.9], [12.4, 1.9]] as const) {
                const p = pt(rd, rw, 11.7 + hd);
                g.fillEllipse(p.x, p.y, 0.9, 0.9);
            }
        }
    };

    const drawCrest = (): void => {
        const hd = headDip;
        if (lvl === 2) {
            const a = pt(10.6, 0, 15.0 + hd);
            const b = pt(12.8, 0, 12.9 + hd);
            g.fillStyle(0x565b64, 1);
            g.beginPath();
            g.moveTo(a.x, a.y);
            g.lineTo(b.x, b.y);
            g.lineTo(b.x, b.y - 1.6);
            g.lineTo(a.x, a.y - 1.6);
            g.closePath();
            g.fillPath();
        } else if (lvl === 3) {
            // three small gilded points along the ridge crown
            g.fillStyle(gold, 1);
            for (const [cd, chh] of [[10.4, 15.2], [11.5, 14.2], [12.6, 13.1]] as const) {
                const b = pt(cd, 0, chh + hd);
                g.beginPath();
                g.moveTo(b.x - 1.1, b.y);
                g.lineTo(b.x + 1.1, b.y);
                g.lineTo(b.x, b.y - 2.2);
                g.closePath();
                g.fillPath();
            }
        }
    };

    const drawEye = (): void => {
        if (Math.abs(ca) < 0.25) return; // head-on/away: eyes hidden by plate
        const s = ca > 0 ? 1 : -1;
        const p = pt(12.5, 4.1 * s, 9.9 + headDip);
        g.fillStyle(0x26262c, 1);
        g.fillEllipse(p.x, p.y, 1.3, 1.5);
    };

    const drawTusks = (): void => {
        // Slim curved sweeps — fat ivory blobs merged with the trunk into a
        // single mass on screenshots, so keep radii tight.
        const hd = headDip;
        for (const s of [-1, 1]) {
            const keys = [
                { d: 13.0, w: 2.6 * s, h: 6.2 + hd, r: 1.3 },
                { d: 15.4, w: 3.2 * s, h: 4.2 + hd, r: 1.05 },
                { d: 16.9, w: 3.3 * s, h: 4.1 + hd, r: 0.9 },
                { d: 18.0, w: 3.0 * s, h: 5.1 + hd, r: 0.72 }
            ];
            // Interleave midpoints so the sweep stays continuous even when
            // the attack pitch stretches it (pearls-on-a-string bug).
            const segs: typeof keys = [];
            for (let i = 0; i < keys.length; i++) {
                segs.push(keys[i]);
                if (i < keys.length - 1) {
                    segs.push({
                        d: (keys[i].d + keys[i + 1].d) / 2,
                        w: (keys[i].w + keys[i + 1].w) / 2,
                        h: (keys[i].h + keys[i + 1].h) / 2,
                        r: (keys[i].r + keys[i + 1].r) / 2
                    });
                }
            }
            g.fillStyle(tuskLo, 1);
            for (const t of segs) {
                const p = pt(t.d, t.w, t.h);
                g.fillEllipse(p.x + 0.35, p.y + 0.4, t.r * 2, t.r * 2);
            }
            g.fillStyle(tuskCol, 1);
            for (const t of segs) {
                const p = pt(t.d, t.w, t.h);
                g.fillEllipse(p.x - 0.15, p.y - 0.25, t.r * 2, t.r * 2);
            }
            if (lvl === 2) {
                const tip = pt(18.0, 3.0 * s, 5.1 + hd);
                g.fillStyle(0x565b64, 1);
                g.fillEllipse(tip.x, tip.y, 1.5, 1.5);
            } else if (lvl === 3) {
                const band = pt(15.4, 3.2 * s, 4.2 + hd);
                g.fillStyle(gold, 1);
                g.fillRect(band.x - 1.2, band.y - 1.4, 2.4, 1.2);
            }
        }
    };

    const drawTrunk = (): void => {
        // Pendulum at the walk, curls HIGH in the windup, thrown forward-down
        // on the impact. Heights ride the body pitch automatically.
        const curl = w01;
        const throwF = s01;
        const n = 6;
        const segs: { p: Pt; r: number }[] = [];
        for (let i = 0; i < n; i++) {
            const t = i / (n - 1);
            const d = 13.7 + t * (3.2 + throwF * 3.0 - curl * 2.8) + trunkSwayD * t;
            const h = 8.4 + headDip - t * 7.6 + curl * (t * t * 10.6) + throwF * t * 0.4;
            const w = trunkSwayW * t * t;
            segs.push({ p: pt(d, w, h), r: 1.55 - t * 0.8 });
        }
        g.fillStyle(hideLo, 1);
        for (const s of segs) g.fillEllipse(s.p.x + 0.4, s.p.y + 0.45, s.r * 2, s.r * 2.2);
        g.fillStyle(hideMid, 1);
        for (const s of segs) g.fillEllipse(s.p.x - 0.15, s.p.y - 0.25, s.r * 2, s.r * 2.2);
    };

    const drawHead = (): void => {
        const farS = ca >= 0 ? -1 : 1; // across side pointing up-screen
        if (sa >= 0) {
            // head is the NEAR end: ears root behind the dome, plate/tusks/
            // trunk reach toward the viewer.
            drawEar(farS);
            drawDome();
            drawEar(-farS);
            drawPlate();
            drawCrest();
            drawEye();
            drawTusks();
            drawTrunk();
        } else {
            // seen from behind: trunk/tusks/plate are beyond the skull; the
            // crest still peeks above the dome, ears swing nearer than it.
            drawTrunk();
            drawTusks();
            drawPlate();
            drawDome();
            drawCrest();
            drawEye();
            drawEar(farS);
            drawEar(-farS);
        }
    };

    // ================= paint, back to front =================
    const tailFar = sa > 0;
    if (sa < 0) drawHead();
    if (tailFar) drawTail();
    drawLeg(sortedLegs[0], false);
    drawLeg(sortedLegs[1], false);
    drawBody();
    drawLeg(sortedLegs[2], true);
    drawLeg(sortedLegs[3], true);
    if (!tailFar) drawTail();
    if (sa >= 0) drawHead();

    // Trample rubble: deterministic chunky debris fanning out of the brow
    // line — the wall-breach moment. Seeded by index, driven only by age.
    if (trampleProg >= 0) {
        const cols = [0x8b7355, 0x6f5b44, 0x8a8a8f];
        for (let k = 0; k < 8; k++) {
            const phi = k * 2.39996 + 0.7;
            const dist = 2.5 + trampleProg * 7.5;
            const rise = Math.sin(Math.min(1, trampleProg * 1.15) * Math.PI) * (2.6 + (k % 3));
            const size = 1.9 - trampleProg * 0.7;
            const p = gp(15.2 + Math.cos(phi) * dist * 0.85, Math.sin(phi) * dist * 0.8);
            g.fillStyle(cols[k % 3], 0.9 * (1 - trampleProg * 0.75));
            g.fillRect(p.x - size / 2, p.y - rise - size / 2, size, size);
        }
    }
}
