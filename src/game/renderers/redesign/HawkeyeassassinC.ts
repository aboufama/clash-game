import type Phaser from 'phaser';

/**
 * HAWK-EYE ASSASSIN — design C: "the Veiled Falconer".
 *
 * A hero-scale (space 10) stealth duelist read as a single bold silhouette:
 * a tall tattered slate mantle flaring to a bell hem, a falcon-beak hood, and
 * ONE glowing hawk-eye scanning under the hood. Out of combat he is VEILED —
 * arms wrapped inside the cloak, the tall recurve bow stowed edge-on across
 * his back, smoke tufts breathing off the hem (the stealth read; the engine
 * layers its 0.55-alpha carrier shimmer on top during the untargetable
 * window). In combat the cloak parts: the body-height hawk-bow comes up
 * perpendicular to `facingAngle`, the string draws through the 420 ms windup,
 * a gold lock-on glint sparks at the arrowhead at full draw (the precision
 * read), and the string snaps straight exactly on the damage tick.
 *
 * Motion contract (bake-safe, iron rule 3 — everything is f(time)/f(attackAge)):
 *  - walk stride closes on exactly STRIDE_MS = 340 ms (all walk terms are
 *    harmonics of the stride phase, including the hem sway and smoke tufts);
 *  - idle closes on exactly IDLE_MS = 2000 ms (a 250 ms multiple; breath k=1,
 *    eye-scan k=1, eye-glint k=1 pulse, hem tufts k=1/k=2 — exact harmonics);
 *  - attack pose is a pure function of attackAge via the shared windup/strike
 *    grammar (WINDUP_MS = 420 before the tick, STRIKE_MS = 140 after).
 *
 * Levels (materials only — silhouette never changes): L1 slate + leather,
 * L2 iron bow tips + hood clasp, L3 gilded tips + gold eye ring + a thin gold
 * hem thread (accents only, per the max-level rule). Enemy palette: the same
 * figure in charcoal-plum with a maroon collar and a crimson eye.
 */

type G = Phaser.GameObjects.Graphics;

const STRIDE_MS = 340;
const IDLE_MS = 2000;
const WINDUP_MS = 420;
const STRIKE_MS = 140;
const TAU = Math.PI * 2;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** One limb/stave segment drawn as a thick quad from (x0,y0) to (x1,y1). */
function limb(g: G, color: number, x0: number, y0: number, x1: number, y1: number, w: number, alpha: number = 1): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(x0 + nx, y0 + ny);
    g.lineTo(x1 + nx, y1 + ny);
    g.lineTo(x1 - nx, y1 - ny);
    g.lineTo(x0 - nx, y0 - ny);
    g.closePath();
    g.fillPath();
}

/** Closed polygon fill from a flat point list. */
function poly(g: G, pts: number[][], color: number, alpha: number = 1): void {
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

/** The shared attack grammar — windup ramps over the last WINDUP_MS of the
 *  cooldown, strike decays over STRIKE_MS after the damage tick; a stale age
 *  (replay playback) free-runs the cycle off the clock. */
function atkAnim(time: number, attackAge: number, attackDelay: number): { windup: number; strike: number; age: number; inCombat: boolean } {
    if (attackAge < 0 || attackDelay <= 0) return { windup: 0, strike: 0, age: Infinity, inCombat: false };
    let age = attackAge;
    if (age > attackDelay + 600) age = time % attackDelay;
    const remaining = attackDelay - age;
    let windup = 0;
    if (remaining <= 0) windup = 1;
    else if (remaining <= WINDUP_MS) windup = 1 - remaining / WINDUP_MS;
    const strike = age <= STRIKE_MS ? 1 - age / STRIKE_MS : 0;
    return { windup, strike, age, inCombat: true };
}

export function drawHawkeyeassassinC(
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
    const lv = Math.max(1, Math.min(3, Math.round(troopLevel || 1)));
    const atk = atkAnim(time, attackAge, attackDelay || 1300);

    // ---------------- palette (owner + level materials) ----------------
    const cloak = isPlayer ? 0x394b59 : 0x443746;
    const cloakDark = shade(cloak, 0.68);
    const cloakDeep = shade(cloak, 0.46);
    const cloakLit = shade(cloak, 1.34);
    const eyeCol = isPlayer ? 0xffc76a : 0xff6b55;
    const leather = 0x2e2620;
    const strap = 0x4a3b2c;
    const boot = 0x201b16;
    const skin = 0x8a6f58;
    const feather = 0xcfc7b4;
    const featherTip = 0x35302a;
    const bowWood = 0x4a3a28;
    const bowDark = 0x33281b;
    const stringCol = 0xd8d2c2;
    const tipCol = lv >= 3 ? 0xdaa520 : lv === 2 ? 0x9aa4ad : bowDark;

    // ---------------- rig (stride / breath — exact periods) ----------------
    const strider = ((time % STRIDE_MS) + STRIDE_MS) % STRIDE_MS / STRIDE_MS; // 0..1, closes on 340 ms
    const idler = ((time % IDLE_MS) + IDLE_MS) % IDLE_MS / IDLE_MS;           // 0..1, closes on 2000 ms
    const sSwing = Math.sin(strider * TAU);
    const lift = isMoving ? Math.abs(sSwing) * 0.9 : (Math.sin(idler * TAU) * 0.5 + 0.5) * 0.6;
    // Hem tufts follow the stride while walking, the 2000 ms breath at rest,
    // and freeze neutral in combat (attack frames bake at pinned time).
    const tuftPh = isMoving ? strider : (atk.inCombat ? 0.25 : idler);

    // ---------------- aim frame (screen-space, iso squash) ----------------
    const ca = Math.cos(facingAngle), sa = Math.sin(facingAngle);
    const vlen = Math.hypot(ca, sa * 0.5) || 1;
    const vx = ca / vlen, vy = (sa * 0.5) / vlen; // unit screen aim vector
    const px = -vy, py = vx;                      // unit screen perpendicular
    const upScreen = sa < -0.12;                  // aiming away → weapon behind body
    const backView = sa < -0.3;                   // looking well up-screen → hood back

    const kneel = atk.inCombat ? atk.windup * 1.1 : 0;
    const leanX = (isMoving ? vx * 1.4 : 0) + (atk.inCombat ? vx * 1.5 * atk.windup : 0);
    const baseY = -lift + kneel;                  // vertical offset for the whole body

    // ---------------- ground contact shadow ----------------
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(0, 9.6, 13, 5);

    // ================= weapon (bow + arms), layered by aim =================
    const drawWeapon = (): void => {
        if (!atk.inCombat) return;
        const hx = leanX + vx * 5.5, hy = -8 + baseY + vy * 5.5; // grip hand
        const L = 10;                                            // half-span
        const t1x = hx + px * L, t1y = hy + py * L;
        const t2x = hx - px * L, t2y = hy - py * L;
        // Belly bulges toward the target; on release it springs slightly flat.
        const bulge = 1.7 - atk.strike * 1.1;
        const m1x = hx + px * L * 0.55 + vx * bulge, m1y = hy + py * L * 0.55 + vy * bulge;
        const m2x = hx - px * L * 0.55 + vx * bulge, m2y = hy - py * L * 0.55 + vy * bulge;
        // Draw point: string pulled back through the windup, snapping forward
        // past rest exactly on the tick.
        const draw = atk.strike > 0 ? -0.8 * atk.strike : 1.1 + clamp01(atk.windup) * 4.6;
        const dxp = hx - vx * draw, dyp = hy - vy * draw;

        // Arms first (they sit between body and bow on the near side).
        const shBX = leanX + vx * 1.6, shBY = -8.6 + baseY;      // bow-arm shoulder
        const shDX = leanX - vx * 1.2, shDY = -8.2 + baseY;      // draw-arm shoulder
        limb(g, cloakDark, shBX, shBY, hx, hy, 2.1);
        limb(g, cloakDark, shDX, shDY, dxp, dyp, 2.1);

        // Bow limbs: two recurve segments per side + beak-curl tips.
        limb(g, bowWood, t1x, t1y, m1x, m1y, 1.7);
        limb(g, bowWood, m1x, m1y, hx, hy, 2.0);
        limb(g, bowWood, t2x, t2y, m2x, m2y, 1.7);
        limb(g, bowWood, m2x, m2y, hx, hy, 2.0);
        limb(g, tipCol, t1x, t1y, t1x + vx * 1.8 + px * 0.6, t1y + vy * 1.8 + py * 0.6, 1.5);
        limb(g, tipCol, t2x, t2y, t2x + vx * 1.8 - px * 0.6, t2y + vy * 1.8 - py * 0.6, 1.5);

        // String (two straight runs tip → draw point).
        g.lineStyle(1.4, stringCol, 0.95);
        g.beginPath();
        g.moveTo(t1x, t1y);
        g.lineTo(dxp, dyp);
        g.lineTo(t2x, t2y);
        g.strokePath();

        // Nocked arrow (gone the instant it looses).
        if (atk.strike <= 0) {
            const ax2 = hx + vx * 8.5, ay2 = hy + vy * 8.5; // head
            limb(g, 0x6b5a42, dxp, dyp, ax2, ay2, 1.4);
            // hawk fletching at the nock
            limb(g, feather, dxp - vx * 0.4 + px * 1.5, dyp - vy * 0.4 + py * 1.5, dxp + vx * 1.6, dyp + vy * 1.6, 1.3);
            limb(g, feather, dxp - vx * 0.4 - px * 1.5, dyp - vy * 0.4 - py * 1.5, dxp + vx * 1.6, dyp + vy * 1.6, 1.3);
            // arrowhead
            poly(g, [
                [ax2 + vx * 2.2, ay2 + vy * 2.2],
                [ax2 + px * 1.2, ay2 + py * 1.2],
                [ax2 - px * 1.2, ay2 - py * 1.2]
            ], lv >= 3 ? 0xdaa520 : 0xb9c2c9);
            // LOCK-ON: a gold spark at the head once fully drawn (the
            // precision read — pops on the last ~60 ms before the tick).
            if (atk.windup > 0.85) {
                const s = 1.2 + (atk.windup - 0.85) * 6;
                g.fillStyle(0xffd700, 0.95);
                g.fillRect(ax2 + vx * 2.2 - s / 2, ay2 + vy * 2.2 - 0.55, s, 1.1);
                g.fillRect(ax2 + vx * 2.2 - 0.55, ay2 + vy * 2.2 - s / 2, 1.1, s);
            }
        } else {
            // Release flash at the rest point, decaying over STRIKE_MS.
            g.fillStyle(0xfff3d0, 0.9);
            g.fillCircle(hx + vx * 2, hy + vy * 2, 1.2 + atk.strike * 1.6);
        }

        // Hands last so they read on top of grip and string.
        g.fillStyle(skin, 1);
        g.fillCircle(hx, hy, 1.2);
        g.fillCircle(dxp, dyp, 1.2);
    };

    // Stowed bow (out of combat): a slim edge-on stave across the back.
    const drawStowed = (): void => {
        if (atk.inCombat) return;
        limb(g, bowDark, leanX - 4.2, -13 + baseY, leanX + 2.6, 6.2 + baseY, 1.5);
        limb(g, tipCol, leanX - 4.2, -13 + baseY, leanX - 5.0, -14.4 + baseY, 1.4);
    };

    // Weapon behind the body when aiming up-screen.
    drawStowed();
    if (upScreen) drawWeapon();

    // ================= quiver (right back shoulder) =================
    limb(g, leather, leanX + 3.4, -10.2 + baseY, leanX + 5.2, -4.6 + baseY, 2.6);
    for (let i = 0; i < 3; i++) {
        const fx = leanX + 3.0 + i * 1.3, fy = -11.4 - (i === 1 ? 0.9 : 0) + baseY;
        limb(g, feather, fx, fy, fx + 0.9, fy + 2.2, 1.3);
        g.fillStyle(i === 1 && lv >= 3 ? 0xdaa520 : featherTip, 1);
        g.fillRect(fx - 0.2, fy + 1.2, 1.5, 0.9);
    }

    // ================= legs (scissor under the hem while walking) =========
    if (isMoving) {
        const f1 = sSwing * 2.4, f2 = -sSwing * 2.4;
        limb(g, 0x232028, leanX - 1.6, 5.2 + baseY, vx * f1 - 1.7, 9.0 + vy * f1 * 0.4, 2.0);
        limb(g, 0x232028, leanX + 1.6, 5.2 + baseY, vx * f2 + 1.7, 9.0 + vy * f2 * 0.4, 2.0);
        g.fillStyle(boot, 1);
        g.fillEllipse(vx * f1 - 1.7, 9.2 + vy * f1 * 0.4, 3.2, 1.7);
        g.fillEllipse(vx * f2 + 1.7, 9.2 + vy * f2 * 0.4, 3.2, 1.7);
    } else {
        g.fillStyle(boot, 1);
        g.fillEllipse(-2.1, 9.2, 3.2, 1.7);
        g.fillEllipse(2.1, 9.2, 3.2, 1.7);
    }

    // ================= the mantle (bell silhouette + tattered hem) ========
    const sway = isMoving ? Math.sin(strider * TAU - 0.9) * 1.1 : Math.sin(idler * TAU) * 0.5;
    const hemY = 7.4 + baseY * 0.3;
    const hem: number[][] = [];
    // zigzag tatters left → right (7 points), swaying as one cloth.
    for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const x = -6.6 + t * 12.4 + sway * (0.4 + 0.6 * (1 - Math.abs(t - 0.5) * 2));
        hem.push([x, hemY - (i % 2 === 1 ? 1.6 : 0)]);
    }
    const cloakPts: number[][] = [
        [leanX - 4.4, -9.6 + baseY],                    // left shoulder
        [leanX + 4.4, -9.6 + baseY],                    // right shoulder
        [6.9 + sway * 0.5, 3.6 + baseY * 0.5],          // right flare
        ...hem.slice().reverse(),                       // hem right → left
        [-6.9 + sway * 0.5, 3.6 + baseY * 0.5]          // left flare
    ];
    poly(g, cloakPts, cloak);
    // SE (screen-right) shadow fold — one clean dark panel.
    poly(g, [
        [leanX + 1.4, -9.2 + baseY],
        [leanX + 4.4, -9.6 + baseY],
        [6.9 + sway * 0.5, 3.6 + baseY * 0.5],
        [hem[6][0], hem[6][1]],
        [hem[5][0], hem[5][1]],
        [leanX + 2.4, -1 + baseY]
    ], cloakDark);
    // NW-lit edge strip (light from the NW, guide §3).
    limb(g, cloakLit, leanX - 4.2, -9.4 + baseY, -6.3 + sway * 0.4, 3.4 + baseY * 0.5, 1.5);
    // Deep inner hem shadow keeps the boots tucked.
    poly(g, [[hem[1][0], hem[1][1]], [hem[3][0], hem[3][1]], [hem[2][0] + 0.2, hemY + 0.9]], cloakDeep, 0.9);
    // L3: one thin gold thread following the hem line (accent, never mass).
    if (lv >= 3) {
        g.lineStyle(1.1, 0xdaa520, 0.85);
        g.beginPath();
        g.moveTo(hem[0][0], hem[0][1] - 0.8);
        for (let i = 1; i <= 6; i++) g.lineTo(hem[i][0], hem[i][1] - 0.8);
        g.strokePath();
    }

    // Smoke tufts breathing off the hem — the veiled/stealth read. Solid
    // near-cloak tones (no low alphas: they must survive the alpha snap).
    for (let i = 0; i < 3; i++) {
        const side = i === 1 ? 1 : -1;
        const phase = tuftPh * TAU * (i === 2 ? 2 : 1) + i * 2.1;
        const tx = side * (6.2 + i * 0.5) + Math.sin(phase) * 1.4;
        const ty = 6.4 - i * 1.5 + Math.cos(phase) * 0.5;
        g.fillStyle(cloakDeep, 0.8);
        g.fillEllipse(tx, ty, 2.8 - i * 0.4, 1.9 - i * 0.3);
    }

    // ================= belt + feather collar =================
    g.fillStyle(strap, 1);
    g.fillRect(leanX - 4.1, -1.6 + baseY, 8.2, 1.6);
    if (lv >= 2) { g.fillStyle(0x9aa4ad, 1); g.fillRect(leanX - 0.9, -1.7 + baseY, 1.8, 1.8); }
    // hawk-feather collar chevrons on each shoulder
    for (const side of [-1, 1]) {
        for (let i = 0; i < 2; i++) {
            const bx = leanX + side * (2.6 + i * 1.5), by = -8.6 + i * 0.9 + baseY;
            poly(g, [[bx, by], [bx + side * 2.2, by + 1.1], [bx + side * 0.4, by + 2.2]], feather);
            poly(g, [[bx + side * 2.2, by + 1.1], [bx + side * 0.4, by + 2.2], [bx + side * 1.6, by + 2.0]], featherTip);
        }
    }

    // ================= hood + the hawk-eye =================
    const hx0 = leanX + vx * 0.6, hy0 = -12.3 + baseY;
    g.fillStyle(cloakDark, 1);
    g.fillCircle(hx0, hy0 + 0.4, 3.8);                     // hood back mass
    g.fillStyle(cloak, 1);
    g.fillCircle(hx0 - 0.4, hy0 - 0.2, 3.6);               // hood crown (NW lit side)
    // falcon-beak brim pointing along the aim
    const brimS = backView ? 0.35 : 1;
    poly(g, [
        [hx0 + vx * 2.2, hy0 - 2.2],
        [hx0 + vx * (2.2 + 3.4 * brimS), hy0 - 0.4 + vy * 1.2],
        [hx0 + vx * 2.0, hy0 + 1.6]
    ], cloakLit);
    if (lv >= 2) { // hood clasp under the chin
        g.fillStyle(lv >= 3 ? 0xdaa520 : 0x9aa4ad, 1);
        g.fillRect(hx0 - 0.9, hy0 + 2.6, 1.8, 1.2);
    }
    if (!backView) {
        // face in shadow; ONE scanning hawk-eye (exact 2000 ms loop).
        g.fillStyle(0x0d0f12, 1);
        g.fillEllipse(hx0 + vx * 1.3, hy0 + 0.7, 4.4, 3.4);
        g.fillStyle(skin, 1);
        g.fillEllipse(hx0 + vx * 1.5, hy0 + 2.2, 1.8, 1.0); // chin sliver
        const scan = atk.inCombat ? vx * 0.9 : Math.sin(idler * TAU) * 0.9;
        const exx = hx0 + vx * 1.4 + scan, eyy = hy0 + 0.3;
        if (lv >= 3) { g.fillStyle(0xdaa520, 0.9); g.fillEllipse(exx, eyy, 3.0, 2.2); }
        g.fillStyle(eyeCol, 1);
        g.fillEllipse(exx, eyy, 2.2, 1.5);
        // glint pulse — a sharp harmonic bump once per 2000 ms cycle (or
        // pinned bright while aiming).
        const blink = atk.inCombat ? atk.windup : Math.pow(Math.max(0, Math.sin(idler * TAU + 2.1)), 6);
        if (blink > 0.45) {
            g.fillStyle(0xfff6dd, 0.95);
            g.fillRect(exx - 0.5, eyy - 0.5, 1.2, 1.0);
        }
    } else {
        // back of the hood: one seam line keeps it reading as cloth.
        g.lineStyle(1.1, cloakDeep, 0.9);
        g.beginPath();
        g.moveTo(hx0, hy0 - 3.2);
        g.lineTo(hx0 + 0.4, hy0 + 2.6);
        g.strokePath();
    }

    // Weapon in front of the body when aiming down-screen.
    if (!upScreen) drawWeapon();
}
