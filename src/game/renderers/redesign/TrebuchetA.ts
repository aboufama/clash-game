import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * TREBUCHET — DESIGN A: "THE LONGSHOT"
 *
 * A low-slung timber sled (base wood 0x8a6d4a) on four iron-shod wheels
 * carrying a tall A-frame trebuchet. The tapered throwing arm and the iron
 * counterweight box hanging off its short end on chains ARE the silhouette:
 * stowed low and long on the march, cocked back with the box hoisted high
 * through the crank, whipping vertical on the damage tick. Two villager-scale
 * siege engineers crew it — a windlass cranker at the rear drum and a sling
 * loader who seats the stone and raises an arm to call the shot.
 *
 * MOTION CONTRACT (bake TROOP_PARAMS must sync to these):
 *  - walk : ONE exact 800 ms stride — crew haul, wheel spokes, sled bob and
 *           the counterweight's travel-sway all share it.
 *  - idle : ONE exact 2000 ms loop (250 ms multiple). Terms are exact
 *           harmonics: counterweight sway ±2.4 px @2000, pennant wave @1000,
 *           loader foot tap @500, cranker weight shift @2000.
 *  - attack (attackAge 0..attackDelay 4000, firstAttackDelay 1500):
 *           whip 0–150 ms (arm releases and swings vertical; the sling reads
 *           EMPTY — the engine spawns the projectile), settle wobble to
 *           650 ms, crank 650 → delay−350 (windlass turns, rope reels the arm
 *           down, counterweight rises, stone seated at ~75%), loaded HOLD for
 *           the final 350 ms (loader's arm up) — the damage tick IS the
 *           release. Stale ages free-run on time % delay (replay contract).
 *
 * All motion is deterministic f(time)/f(attackAge); no per-frame randomness,
 * no translucent body paint (contact shadows only).
 */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const gg = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (gg << 8) | b;
}

// ---- rhythm (the bake syncs to these) ----
const STRIDE_MS = 800;   // one exact walk period
const IDLE_MS = 2000;    // idle loop, 250 ms multiple
const WHIP_MS = 150;     // arm release whip
const WOBBLE_END_MS = 650;
const HOLD_MS = 350;     // loaded, cocked, waiting on the tick

// ---- geometry (u = along aim, w = across, h = height above ground) ----
const BED_U0 = -21, BED_U1 = 16;  // sled extent
const BED_W = 6.5;                // sled half width
const BED_TOP = 6.2, BED_BOT = 3.2; // deck / skirt heights
const PIV_U = 3, PIV_H = 25;      // arm pivot (A-frame apex)
const ARM_L = 29;                 // long (sling) arm
const ARM_S = 10.5;               // short (counterweight) arm
// arm angle from vertical-up, positive = long end toward the rear
const TH_FIRED = -0.40;           // just after release: tall, tipped forward
const TH_COCKED = 2.08;           // long end down at the rear trough
const TH_STOWED = 2.02;           // march: arm lashed low along the bed
const CHAIN = 4.2;                // counterweight chain drop

export function drawTrebuchetA(
    g: G,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number,
    troopLevel: number,
    time: number,
    attackAge: number,
    attackDelay: number,
    _driver: number
): void {
    const fa = facingAngle || 0;
    const ca = Math.cos(fa), sa = Math.sin(fa);
    const nearSign = ca >= 0 ? 1 : -1; // across side closer to the camera

    // ---- palettes (enemies darken; accents split by owner) ----
    const wood = isPlayer ? 0x8a6d4a : 0x71583c;
    const woodDark = shade(wood, 0.62);
    const armWood = shade(wood, troopLevel >= 3 ? 1.12 : 1.04);
    const iron = 0x43474e, ironDark = 0x33363c, ironLight = 0x6f747d;
    const boxBase = troopLevel >= 2 ? 0x43474e : 0x4c443a; // rusted at L1
    const ropeC = 0x8b7355;
    const uniform = isPlayer ? 0x455a64 : 0x5d4037;
    const uniformDark = isPlayer ? 0x37474f : 0x4e342e;
    const skin = isPlayer ? 0xe8d4b8 : 0xc9a66b;
    const flagC = isPlayer ? 0x2e7d32 : 0xa03028;
    const gold = 0xdaa520;
    const stoneC = 0x9298a0;

    // ---- attack timeline ----
    const D = attackDelay > 0 ? attackDelay : 4000;
    const inCombat = attackAge >= 0 && !isMoving;
    let age = attackAge;
    if (inCombat && age > D + 600) age = ((time % D) + D) % D; // replay free-run

    let theta = TH_STOWED;
    let crank01 = 0;      // 0 = fired → 1 = cocked
    let holding = false;
    let whipping = false;
    let whipP = 0;
    let postRelease = false; // wobble window right after the whip
    let stoneLoaded = false;
    let ropeOn = false;
    let cwSwing = 0;      // counterweight pendulum offset (u units)

    if (inCombat) {
        const crankSpan = D - HOLD_MS - WOBBLE_END_MS;
        if (age < WHIP_MS) {
            whipping = true;
            whipP = clamp01(age / WHIP_MS);
            const k = 1 - Math.pow(1 - whipP, 3);
            theta = lerp(TH_COCKED, TH_FIRED, k);
            cwSwing = -2.2 * whipP; // box kicked rearward as it drops
        } else if (age < WOBBLE_END_MS) {
            postRelease = true;
            const t = age - WHIP_MS;
            theta = TH_FIRED + 0.1 * Math.sin(t / 62) * Math.exp(-t / 210);
            cwSwing = -2.2 * Math.cos(t / 150) * Math.exp(-t / 300);
        } else {
            crank01 = smooth(clamp01((age - WOBBLE_END_MS) / crankSpan));
            holding = age >= D - HOLD_MS;
            if (holding) crank01 = 1;
            theta = lerp(TH_FIRED, TH_COCKED, crank01);
            ropeOn = true;
            stoneLoaded = crank01 > 0.75;
        }
    } else if (isMoving) {
        cwSwing = Math.sin(((time % STRIDE_MS) / STRIDE_MS) * Math.PI * 2) * 1.3;
    } else {
        // idle: the box sways on the exact 2000 ms loop
        cwSwing = Math.sin(((time % IDLE_MS) / IDLE_MS) * Math.PI * 2) * 2.4;
    }

    // ---- march rhythm ----
    const ph = (time % STRIDE_MS) / STRIDE_MS;
    const mb = isMoving ? Math.abs(Math.sin((ph + 0.15) * Math.PI * 2)) * 0.8 : 0;
    const wheelRot = isMoving ? ph * Math.PI * 2 : 0;

    // ---- projection: u,w,h -> screen (iso squash 0.5; ground plane y=9.5) ----
    const X = (u: number, w: number): number => u * ca - w * sa;
    const Yg = (u: number, w: number, h: number): number => 9.5 + (u * sa + w * ca) * 0.5 - h;
    const Y = (u: number, w: number, h: number): number => Yg(u, w, h) - mb;

    const quad = (pts: number[][], color: number): void => {
        g.fillStyle(color, 1);
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.closePath();
        g.fillPath();
    };
    const strut = (x0: number, y0: number, x1: number, y1: number, w0: number, w1: number, color: number): void => {
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        quad([
            [x0 + nx * w0 / 2, y0 + ny * w0 / 2],
            [x1 + nx * w1 / 2, y1 + ny * w1 / 2],
            [x1 - nx * w1 / 2, y1 - ny * w1 / 2],
            [x0 - nx * w0 / 2, y0 - ny * w0 / 2]
        ], color);
    };

    // ---- arm endpoints (vertical plane through the aim axis) ----
    const st = Math.sin(theta), ct = Math.cos(theta);
    const TLu = PIV_U - st * ARM_L, TLv = PIV_H + ct * ARM_L; // long (sling) tip
    const TSu = PIV_U + st * ARM_S, TSv = PIV_H - ct * ARM_S; // short (box) tip
    const Px = X(PIV_U, 0), Py = Y(PIV_U, 0, PIV_H);
    const TLx = X(TLu, 0), TLy = Y(TLu, 0, TLv);
    const TSx = X(TSu, 0), TSy = Y(TSu, 0, TSv);

    // counterweight box center (hangs plumb from the short tip + swing)
    const bcU = TSu + cwSwing;
    const bcV = TSv - 0.6 - CHAIN - 3.3;

    // sling pouch: dangles under the tip when the arm is up, rests in the
    // rear trough when cocked/stowed. During the whip the empty straps fly
    // outward past the tip (the stone is the ENGINE's projectile, never ours).
    const outLen = Math.hypot(TLx - Px, TLy - Py) || 1;
    const outX = (TLx - Px) / outLen, outY = (TLy - Py) / outLen;
    const troughX = X(TLu + 3.6, 0), troughY = Y(TLu + 3.6, 0, BED_TOP + 0.9);
    const hangX = TLx, hangY = TLy + 6.5;
    let pouchX: number, pouchY: number;
    if (whipping) {
        const k = 1 - Math.pow(1 - whipP, 2);
        pouchX = lerp(troughX, TLx + outX * 7.5, k);
        pouchY = lerp(troughY, TLy + outY * 7.5, k);
    } else if (!inCombat) {
        pouchX = troughX; pouchY = troughY;
    } else if (postRelease) {
        // straps swing back to plumb as the arm settles
        const t = clamp01((age - WHIP_MS) / 260);
        pouchX = lerp(TLx + outX * 7.5, hangX, smooth(t));
        pouchY = lerp(TLy + outY * 7.5, hangY, smooth(t));
    } else {
        const m = smooth(clamp01((crank01 - 0.45) / 0.35));
        pouchX = lerp(hangX, troughX, m);
        pouchY = lerp(hangY, troughY, m);
    }

    // windlass drum + crank handle (rear, across the frame)
    const drumU = 13, drumH = 8.5;
    const eta = ropeOn && !holding ? (crank01 * Math.PI * 6) % (Math.PI * 2) : 0;
    const handleU = drumU + Math.cos(eta) * 3.4;
    const handleH = drumH + Math.sin(eta) * 3.4;
    const handleX = X(handleU, nearSign * 5.6);
    const handleY = Y(handleU, nearSign * 5.6, handleH);

    // ================= crew (villager scale, screen-billboarded) ==========
    interface FigOpt {
        swing?: number; lift?: number; leanX?: number;
        armL?: [number, number] | null; armR?: [number, number] | null;
        raiseR?: boolean;
    }
    const figDraw = (fx: number, fy: number, o: FigOpt): void => {
        const swing = o.swing ?? 0, lift = o.lift ?? 0, lean = o.leanX ?? 0;
        const oy = fy - 9.3;
        g.fillStyle(0x000000, 0.18);
        g.fillEllipse(fx, fy, 7.6, 2.9);
        g.fillStyle(uniformDark, 1);
        g.fillRect(fx - 2.4 - swing, oy + 3.5 - lift, 1.9, 5.4 + lift);
        g.fillRect(fx + 0.5 + swing, oy + 3.5 - lift, 1.9, 5.4 + lift);
        g.fillStyle(0x23262b, 1);
        g.fillEllipse(fx - 1.5 - swing, oy + 9, 2.8, 1.5);
        g.fillEllipse(fx + 1.5 + swing, oy + 9, 2.8, 1.5);
        g.fillStyle(uniform, 1);
        g.fillCircle(fx + lean, oy - 1 - lift, 4);
        g.fillStyle(uniformDark, 1);
        g.fillRect(fx + lean - 3.4, oy + 1 - lift, 6.8, 1.5);
        const shY = oy - 2.6 - lift;
        const arm = (sx: number, target: [number, number] | null | undefined, defDx: number): void => {
            const t: [number, number] = target ?? [sx + defDx + swing * 0.4, shY + 4.6];
            strut(sx, shY, t[0], t[1], 1.8, 1.5, skin);
            g.fillStyle(skin, 1);
            g.fillCircle(t[0], t[1], 1.1);
        };
        arm(fx + lean - 2.3, o.armL, -1.2);
        arm(fx + lean + 2.3, o.raiseR ? [fx + lean + 3.1, shY - 8.2] : o.armR, 1.2);
        g.fillStyle(skin, 1);
        g.fillCircle(fx + lean, oy - 6.8 - lift, 2.9);
        g.fillStyle(uniformDark, 1);
        g.beginPath();
        g.arc(fx + lean, oy - 7.4 - lift, 3.1, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillRect(fx + lean - 3.4, oy - 7.7 - lift, 6.8, 1.2);
        if (troopLevel >= 3) {
            g.fillStyle(gold, 1);
            g.fillCircle(fx + lean, oy - 9.1 - lift, 0.8);
        }
    };

    const figs: Array<{ fy: number; draw: () => void }> = [];
    const addFig = (u: number, w: number, opt: FigOpt): void => {
        const fx = X(u, w), fy = Yg(u, w, 0);
        figs.push({ fy, draw: () => figDraw(fx, fy, opt) });
    };

    // tow ropes (walk) get drawn with the machine; remember the hand points
    const towRopes: Array<[number, number, number, number]> = [];

    if (isMoving) {
        // both engineers haul at the front, opposite stride phases
        const hitches: Array<[number, number]> = [[16, 4.5], [16, -4.5]];
        const spots: Array<[number, number]> = [[22, 7.2], [25.5, -7.2]];
        for (let i = 0; i < 2; i++) {
            const fph = (ph + (i === 0 ? 0 : 0.45)) % 1;
            const s = Math.sin(fph * Math.PI * 2);
            const swing = s * 2.2;
            const lift = Math.abs(s) * 1.0;
            const [u, w] = spots[i];
            const fx = X(u, w), fy = Yg(u, w, 0);
            const shX = fx + ca * 1.1 + 2.3, shY = fy - 9.3 - 2.6 - lift;
            const hx = X(hitches[i][0], hitches[i][1]);
            const hy = Y(hitches[i][0], hitches[i][1], 4.5);
            const handX = shX + (hx - shX) * 0.18;
            const handY = shY + (hy - shY) * 0.18;
            towRopes.push([hx, hy, handX, handY]);
            addFig(u, w, { swing, lift, leanX: ca * 1.2, armR: [handX, handY] });
        }
    } else if (inCombat) {
        // cranker at the windlass
        if (ropeOn && !holding) {
            const fx = X(17, nearSign * 9.8);
            addFig(17, nearSign * 9.8, {
                lift: Math.max(0, Math.sin(eta)) * 0.5,
                leanX: (X(drumU, nearSign * 5.6) - fx) * 0.12,
                armL: [handleX - 0.6, handleY + 0.4],
                armR: [handleX + 0.6, handleY - 0.2]
            });
        } else {
            addFig(17, nearSign * 9.8, { leanX: whipping || postRelease ? -nearSign * 0.8 : 0 });
        }
        // loader beside the trough
        const reach = crank01 > 0.7 && crank01 < 0.98; // pouch is at the trough
        addFig(-24, -nearSign * 8.5, {
            leanX: reach ? (pouchX - X(-24, -nearSign * 8.5)) * 0.08 : 0,
            armR: reach ? [pouchX, pouchY - 1] : null,
            raiseR: holding || whipping || (postRelease && age < 400)
        });
    } else {
        // idle fidgets — exact harmonics of the 2000 ms loop
        const w1 = Math.sin(((time % IDLE_MS) / IDLE_MS) * Math.PI * 2 + 1.1) * 1.2;
        addFig(-11, nearSign * 11, {
            leanX: w1,
            armL: [X(-8, nearSign * 6.4), Y(-8, nearSign * 6.4, BED_TOP + 1.5)]
        });
        const tap = Math.max(0, Math.sin(((time % 500) / 500) * Math.PI * 2)) * 0.5;
        addFig(10, -nearSign * 9, {
            lift: tap,
            leanX: Math.sin(((time % IDLE_MS) / IDLE_MS) * Math.PI * 2) * 1.0
        });
    }

    // ======================= paint (painter's order) =======================

    // ground shadow — one soft ellipse sized to the heading
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(X(-2, 0), Yg(-2, 0, 0) + 0.3, 28 + 20 * Math.abs(ca), 12 + 9 * Math.abs(sa));

    // crew standing up-screen of the sled draw behind it
    for (const f of figs) if (f.fy < 9.2) f.draw();

    // ---- wheels (far side first) ----
    const wheelR = 5;
    const wA = Math.hypot(ca, sa * 0.5); // projected wheel roundness
    const drawWheel = (u: number, side: number): void => {
        const cx = X(u, side * (BED_W + 1));
        const cy = Y(u, side * (BED_W + 1), 4.8);
        const rim = troopLevel >= 2 ? ironDark : woodDark;
        g.fillStyle(rim, 1);
        g.fillEllipse(cx, cy, 2 * wheelR * Math.max(wA, 0.28), 2 * wheelR);
        g.fillStyle(shade(wood, side === nearSign ? 0.95 : 0.78), 1);
        g.fillEllipse(cx, cy, 2 * (wheelR - 1.2) * Math.max(wA, 0.24), 2 * (wheelR - 1.2));
        // spokes rotate on the stride (wheel-plane parametric — true at all headings)
        g.lineStyle(1, woodDark, 1);
        for (let i = 0; i < 4; i++) {
            const b = wheelRot + i * Math.PI / 2;
            const rr = wheelR - 1.4;
            g.lineBetween(cx, cy, cx + Math.cos(b) * rr * ca, cy + Math.cos(b) * rr * sa * 0.5 - Math.sin(b) * rr);
        }
        g.fillStyle(troopLevel >= 3 ? gold : woodDark, 1);
        g.fillCircle(cx, cy, 1.1);
    };
    drawWheel(-11.5, -nearSign);
    drawWheel(11.5, -nearSign);

    // ---- sled bed ----
    // near-side skirt
    quad([
        [X(BED_U0, nearSign * BED_W), Y(BED_U0, nearSign * BED_W, BED_TOP)],
        [X(BED_U1, nearSign * BED_W), Y(BED_U1, nearSign * BED_W, BED_TOP)],
        [X(BED_U1, nearSign * BED_W), Y(BED_U1, nearSign * BED_W, BED_BOT)],
        [X(BED_U0, nearSign * BED_W), Y(BED_U0, nearSign * BED_W, BED_BOT)]
    ], shade(wood, 0.74));
    // visible end face
    if (Math.abs(sa) > 0.05) {
        const ue = sa > 0 ? BED_U1 : BED_U0;
        quad([
            [X(ue, -BED_W), Y(ue, -BED_W, BED_TOP)],
            [X(ue, BED_W), Y(ue, BED_W, BED_TOP)],
            [X(ue, BED_W), Y(ue, BED_W, BED_BOT)],
            [X(ue, -BED_W), Y(ue, -BED_W, BED_BOT)]
        ], shade(wood, 0.6));
    }
    // deck
    quad([
        [X(BED_U0, -BED_W), Y(BED_U0, -BED_W, BED_TOP)],
        [X(BED_U1, -BED_W), Y(BED_U1, -BED_W, BED_TOP)],
        [X(BED_U1, BED_W), Y(BED_U1, BED_W, BED_TOP)],
        [X(BED_U0, BED_W), Y(BED_U0, BED_W, BED_TOP)]
    ], wood);
    // plank seams
    g.lineStyle(0.8, woodDark, 1);
    for (const pw of [-2.2, 2.2]) {
        g.lineBetween(X(BED_U0 + 1, pw), Y(BED_U0 + 1, pw, BED_TOP), X(BED_U1 - 1, pw), Y(BED_U1 - 1, pw, BED_TOP));
    }
    if (troopLevel >= 2) {
        // iron corner brackets
        g.fillStyle(iron, 1);
        for (const [cu, cw] of [[BED_U0 + 1.5, -BED_W + 1], [BED_U0 + 1.5, BED_W - 1], [BED_U1 - 1.5, -BED_W + 1], [BED_U1 - 1.5, BED_W - 1]]) {
            g.fillCircle(X(cu, cw), Y(cu, cw, BED_TOP), 1.1);
        }
    }
    if (troopLevel >= 3) {
        // gilded near edge line — a subtle accent, never a mass
        g.lineStyle(0.9, gold, 1);
        g.lineBetween(X(BED_U0, nearSign * BED_W), Y(BED_U0, nearSign * BED_W, BED_TOP), X(BED_U1, nearSign * BED_W), Y(BED_U1, nearSign * BED_W, BED_TOP));
    }

    // tow ropes lie over the deck edge while hauling
    if (towRopes.length) {
        g.lineStyle(1.3, ropeC, 1);
        for (const [hx, hy, ex, ey] of towRopes) {
            g.beginPath();
            g.moveTo(hx, hy);
            g.lineTo((hx + ex) / 2, (hy + ey) / 2 + 1.6);
            g.lineTo(ex, ey);
            g.strokePath();
        }
    }

    // spare stones on the rear deck
    g.fillStyle(shade(stoneC, 0.8), 1);
    g.fillCircle(X(7.5, 2.9), Y(7.5, 2.9, BED_TOP + 1.6), 2.2);
    g.fillStyle(stoneC, 1);
    g.fillCircle(X(9.2, 3.6), Y(9.2, 3.6, BED_TOP + 1.3), 1.8);

    // ---- rear return pulley (the winch rope turns here, up to the tip) ----
    const pulX = X(-20.5, 0), pulY = Y(-20.5, 0, 6.8);
    g.fillStyle(ironDark, 1);
    g.fillCircle(pulX, pulY, 1.4);
    g.fillStyle(ironLight, 1);
    g.fillCircle(pulX, pulY, 0.6);

    // ---- windlass drum (front deck, across the frame) ----
    strut(X(drumU, -4.6), Y(drumU, -4.6, drumH), X(drumU, 4.6), Y(drumU, 4.6, drumH), 3, 3, woodDark);
    g.fillStyle(shade(wood, 0.9), 1);
    g.fillCircle(X(drumU, nearSign * 4.6), Y(drumU, nearSign * 4.6, drumH), 1.8);
    // crank handle (locks level with the drum when idle/held)
    g.lineStyle(1.2, ironDark, 1);
    g.lineBetween(X(drumU, nearSign * 5.6), Y(drumU, nearSign * 5.6, drumH), handleX, handleY);
    g.fillStyle(troopLevel >= 2 ? ironLight : woodDark, 1);
    g.fillCircle(handleX, handleY, 1);

    // ---- far A-frame leg ----
    const leg = (side: number, tone: number): void => {
        const col = shade(wood, tone);
        strut(X(-5.5, side * 6.2), Y(-5.5, side * 6.2, BED_TOP), X(PIV_U, side * 3.6), Y(PIV_U, side * 3.6, PIV_H), 3, 2.1, col);
        strut(X(11, side * 6.2), Y(11, side * 6.2, BED_TOP), X(PIV_U, side * 3.6), Y(PIV_U, side * 3.6, PIV_H), 3, 2.1, col);
        strut(X(-5.5, side * 6.2), Y(-5.5, side * 6.2, BED_TOP + 4.5), X(11, side * 6.2), Y(11, side * 6.2, BED_TOP + 4.5), 1.6, 1.6, shade(wood, tone * 0.85));
    };
    leg(-nearSign, 0.72);

    // cross-brace between the legs (behind the arm)
    strut(X(PIV_U, -3.9), Y(PIV_U, -3.9, 15.5), X(PIV_U, 3.9), Y(PIV_U, 3.9, 15.5), 1.5, 1.5, woodDark);

    // ---- crank rope: drum → rear pulley → long tip (gone on release) ----
    if (ropeOn) {
        g.lineStyle(1.4, ropeC, 1);
        const dxr = X(drumU, 0), dyr = Y(drumU, 0, drumH + 0.8);
        const sag = holding ? 0.2 : (1 - crank01) * 1.8;
        g.beginPath();
        g.moveTo(dxr, dyr);
        g.lineTo((dxr + pulX) / 2, (dyr + pulY) / 2 + sag);
        g.lineTo(pulX, pulY);
        g.lineTo(TLx, TLy);
        g.strokePath();
    }

    // ---- throwing arm (tapered timber, pivot boss, level fittings) ----
    strut(Px, Py, TSx, TSy, 4.6, 3.8, shade(armWood, 0.9)); // short butt
    strut(Px, Py, TLx, TLy, 4.6, 2.2, armWood);             // long arm
    // bands along the long arm
    const bandAt = (t: number, col: number, bw: number): void => {
        const qx = lerp(Px, TLx, t), qy = lerp(Py, TLy, t);
        const half = (4.6 + (2.2 - 4.6) * t) / 2 + 0.8;
        const dlen = Math.hypot(TLx - Px, TLy - Py) || 1;
        const nx = -(TLy - Py) / dlen, ny = (TLx - Px) / dlen;
        g.lineStyle(bw, col, 1);
        g.lineBetween(qx + nx * half, qy + ny * half, qx - nx * half, qy - ny * half);
    };
    if (troopLevel === 1) {
        bandAt(0.3, ropeC, 1.1);
        bandAt(0.62, ropeC, 1.1);
    } else {
        bandAt(0.25, iron, 1.2);
        bandAt(0.5, iron, 1.2);
        bandAt(0.75, iron, 1.2);
    }
    if (troopLevel >= 3) bandAt(0.93, gold, 1.4); // gilded ferrule at the tip
    // pivot boss over the axle
    g.fillStyle(ironDark, 1);
    g.fillCircle(Px, Py, 2.6);
    g.fillStyle(troopLevel >= 3 ? gold : ironLight, 1);
    g.fillCircle(Px, Py, 1.4);

    // ---- counterweight: shackle, chains, riveted iron box ----
    g.fillStyle(ironLight, 1);
    g.fillCircle(TSx, TSy, 1.0);
    g.lineStyle(0.9, ironDark, 1);
    const boxTopL = [X(bcU, -2.8), Y(bcU, -2.8, bcV + 3.3)];
    const boxTopR = [X(bcU, 2.8), Y(bcU, 2.8, bcV + 3.3)];
    g.lineBetween(X(TSu, -1.3), Y(TSu, -1.3, TSv - 0.4), boxTopL[0], boxTopL[1]);
    g.lineBetween(X(TSu, 1.3), Y(TSu, 1.3, TSv - 0.4), boxTopR[0], boxTopR[1]);
    {
        const a = 3.5, b = 3.9, hh = 3.3;
        const bTop = bcV + hh, bBot = bcV - hh;
        const P8 = (du: number, dw: number, h: number): number[] => [X(bcU + du, dw), Y(bcU + du, dw, h)];
        const face = (pts: number[][], normalSx: number): void =>
            quad(pts, shade(boxBase, normalSx < 0 ? 1.0 : 0.72));
        // rotation-proof: draw exactly the side faces whose normals point down-screen
        if (sa > 0.05) face([P8(a, -b, bTop), P8(a, b, bTop), P8(a, b, bBot), P8(a, -b, bBot)], ca);
        if (sa < -0.05) face([P8(-a, -b, bTop), P8(-a, b, bTop), P8(-a, b, bBot), P8(-a, -b, bBot)], -ca);
        if (ca > 0.05) face([P8(-a, b, bTop), P8(a, b, bTop), P8(a, b, bBot), P8(-a, b, bBot)], -sa);
        if (ca < -0.05) face([P8(-a, -b, bTop), P8(a, -b, bTop), P8(a, -b, bBot), P8(-a, -b, bBot)], sa);
        quad([P8(-a, -b, bTop), P8(a, -b, bTop), P8(a, b, bTop), P8(-a, b, bTop)], shade(boxBase, 1.28));
        if (troopLevel >= 2) {
            g.fillStyle(ironLight, 1);
            for (const [du, dw] of [[-a + 0.9, -b + 0.9], [a - 0.9, -b + 0.9], [a - 0.9, b - 0.9], [-a + 0.9, b - 0.9]]) {
                const p = P8(du, dw, bTop);
                g.fillCircle(p[0], p[1], 0.55);
            }
        }
        if (troopLevel >= 3) {
            g.lineStyle(0.8, gold, 1);
            const t1 = P8(-a, -b, bTop), t2 = P8(a, -b, bTop), t3 = P8(a, b, bTop), t4 = P8(-a, b, bTop);
            g.beginPath();
            g.moveTo(t1[0], t1[1]); g.lineTo(t2[0], t2[1]); g.lineTo(t3[0], t3[1]); g.lineTo(t4[0], t4[1]);
            g.closePath();
            g.strokePath();
        }
    }

    // ---- sling: two straps + leather pouch (+ stone only when seated) ----
    g.lineStyle(0.9, 0x4a3826, 1);
    g.lineBetween(TLx - 0.8, TLy, pouchX - 1.1, pouchY);
    g.lineBetween(TLx + 0.8, TLy, pouchX + 1.1, pouchY);
    g.fillStyle(0x4a3826, 1);
    g.fillEllipse(pouchX, pouchY + (whipping ? 0 : 0.8), whipping || postRelease ? 2.8 : 4.2, whipping || postRelease ? 1.6 : 2.6);
    if (stoneLoaded || (!inCombat && !isMoving)) {
        // Idle keeps a stone seated (battle-ready read); it vanishes the
        // instant the arm releases and stays gone until the crew reloads.
        g.fillStyle(stoneC, 1);
        g.fillCircle(pouchX, pouchY - 0.8, 2.5);
        g.fillStyle(shade(stoneC, 1.25), 1);
        g.fillCircle(pouchX - 0.7, pouchY - 1.5, 0.8);
    }

    // ---- near A-frame leg + near wheels ----
    leg(nearSign, 1.0);
    drawWheel(-11.5, nearSign);
    drawWheel(11.5, nearSign);

    // ---- apex axle + pennant ----
    strut(X(PIV_U, -3.6), Y(PIV_U, -3.6, PIV_H), X(PIV_U, 3.6), Y(PIV_U, 3.6, PIV_H), 2, 2, ironDark);
    const poleTopX = X(PIV_U, 0), poleTopY = Y(PIV_U, 0, PIV_H + 7);
    g.lineStyle(1, woodDark, 1);
    g.lineBetween(Px, Py - 1, poleTopX, poleTopY);
    const wavePeriod = isMoving ? STRIDE_MS : 1000; // stride-locked or the 1000 ms idle harmonic
    const wave = Math.sin(((time % wavePeriod) / wavePeriod) * Math.PI * 2 + 0.7) * 1.3;
    const rl = Math.hypot(ca, sa * 0.5) || 1;
    const fdx = -ca / rl, fdy = -sa * 0.5 / rl; // pennant streams rearward
    quad([
        [poleTopX, poleTopY],
        [poleTopX, poleTopY + 2.2],
        [poleTopX + fdx * 7, poleTopY + fdy * 7 + 1.2 + wave]
    ], flagC);
    if (troopLevel >= 3) {
        g.lineStyle(0.7, gold, 1);
        g.lineBetween(poleTopX, poleTopY, poleTopX + fdx * 7, poleTopY + fdy * 7 + 1.2 + wave);
        g.fillStyle(gold, 1);
        g.fillCircle(poleTopX, poleTopY - 0.6, 1); // finial
    }

    // crew standing down-screen of the sled draw over it
    for (const f of figs) if (f.fy >= 9.2) f.draw();
}
