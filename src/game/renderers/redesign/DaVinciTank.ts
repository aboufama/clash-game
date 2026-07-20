import type Phaser from 'phaser';

/**
 * DA VINCI TANK — clean-room rebuild (2026-07-19): "THE TESTUDO".
 *
 * Leonardo's famous covered war machine, played straight: a low, wide,
 * two-pitch conical shell of radial wooden plank facets (the sloped armor
 * from the Codex sketch), a ring of eight iron bombards poking out of ports
 * around the skirt, an observation cupola with viewing slits on the crown,
 * and armored rollers hidden under the rim that only peek out at the
 * diagonals. It fights like a giant revolver: the forward bombard fires,
 * kicks hard into its port, and the whole machine indexes 45 degrees to
 * bring the next loaded barrel to bear.
 *
 * MECHANICAL CONTRACT (do not break):
 *   - The machine is EXACTLY 8-fold rotationally symmetric. The runtime
 *     commits `facing += PI/4` after every shot and the bake gate demands
 *     the spin01=1 frame be byte-identical to the next direction's idle
 *     frame 0. Every repeating feature (facets, ports, studs, slits,
 *     wheels, seams) therefore exists once per bay with no per-bay
 *     variation; anything time-driven that singles out one bay (the stud
 *     glint) selects by ABSOLUTE world angle so the choice survives the
 *     45-degree re-labelling of bays at the seam.
 *   - The ONLY angle ever used is effAngle = facingAngle + spin01 * PI/4.
 *   - Geometry pins consumed by MainScene's muzzle math: cannon ring
 *     radius 29, barrel protrusion 16 (tips at 45), hub 2 px below the
 *     anchor (ring height 7 over ground line +9).
 *   - RECOIL (owner ask 2026-07-19): during the post-shot index the just
 *     fired bay-0 bombard is rammed back into its port and runs back out —
 *     rec = 7 * (1 - spin01/0.8)^1.5 px, muzzle sooted on the same curve.
 *     Both are exactly zero from spin01 >= 0.8, so the seam law holds, and
 *     both are gated on spin01 > 0 so idle/walk (spin01 = 0) never recoil.
 *   - ENGINE EXHAUST (owner ask 2026-07-19): the machine is crank-engine
 *     powered — a CENTERED iron smokestack rises through the cap apex (the
 *     banner flies from a crossarm on it) and chuffs steam puffs ONLY while
 *     moving. Center placement is what keeps the stack legal under the
 *     8-fold seam law; the puff cycle closes exactly over one 480 ms stride
 *     and walk frames never participate in the spin seam anyway.
 *
 * ANIMATION CONTRACT (all deterministic f(time), iron rule 3):
 *   - idle loop 2000 ms EXACT (250 ms multiples only): banner wave
 *     (2000/1000 ms harmonics, ~2.6 px tip travel — the quantization
 *     carrier) + a stud glint stepping one bay per 250 ms (8 studs = one
 *     exact 2000 ms circuit).
 *   - walk stride 480 ms: hull bob at 240 ms, upper-works sway at 480 ms,
 *     roller treads churn one peg pitch per 480 ms, all wheels in phase
 *     (in-phase is both physically true and required by the symmetry law).
 *   - deactivated husk: every time term gated to zero — banner hangs dead,
 *     no glint, hull settled 1.6 px, three port lids ajar and soot-streaked
 *     (asymmetry is allowed here: the husk never enters the spin seam).
 *
 * Levels: L1 pale ash + hemp lashings x-tied on every facet · L2 oak +
 * iron edge straps, bronze port rings, studded hoops · L3 dark walnut +
 * a sandstone waist band with gold strictly as accents (finial ball, port
 * rings, hoop studs, bombard hoop edges). Owner tells: the crown banner
 * (player blue / enemy crimson) and slightly darker enemy timber.
 */

type G = Phaser.GameObjects.Graphics;
type P2 = readonly [number, number];

const TAU = Math.PI * 2;
const BAY = Math.PI / 4;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

function mix(a: number, b: number, t: number): number {
    const tt = clamp01(t);
    const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
    const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
    return (Math.round(ar + (br - ar) * tt) << 16)
        | (Math.round(ag + (bg - ag) * tt) << 8)
        | Math.round(ab + (bb - ab) * tt);
}

function poly(g: G, pts: readonly P2[], color: number, alpha = 1): void {
    if (pts.length < 3) return;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

function seg(g: G, a: P2, b: P2, w: number, color: number, alpha = 1): void {
    g.lineStyle(w, color, alpha);
    g.lineBetween(a[0], a[1], b[0], b[1]);
}

/** Shared shell geometry (world px). MainScene's muzzle math and the death
 *  renderer both key off these — change them only together. */
export const DAVINCI_GEOM = {
    GROUND: 9,      // ground line below the anchor
    HUB_H: 7,       // cannon-ring height → hub 2 px below anchor
    RING_R: 29,     // port ring radius (MainScene: ring 29 + barrel 16)
    BARREL_OUT: 16, // seated protrusion beyond the ring → tips at 45
    RIM_R: 32, RIM_H: 4,        // skirt rim
    WAIST_R: 17, WAIST_H: 22,   // skirt→roof break (steep, not flat)
    CROWN_R: 7, CROWN_H: 31,    // roof→deck
    CUP_R: 5.4, CUP_H: 38.5,    // cupola top
    APEX_H: 44,                 // cap apex
    STACK_TOP: 52               // smokestack crown (banner arm at 50)
} as const;

export interface DaVinciPal {
    wood: number; woodDk: number; woodHi: number; line: number;
    iron: number; ironDk: number; ironHi: number;
    barrel: number; bore: number;
    ring: number;            // port ring / hoop accent metal (iron/bronze/gold)
    hemp: number | null;     // L1 lashings
    sand: number | null;     // L3 waist band
    gold: number | null; goldHi: number | null;
    cloth: number; clothDk: number;
    soot: number;
}

export function davinciTankPalette(level: number, isPlayer: boolean): DaVinciPal {
    const L = Math.max(1, Math.min(3, Math.round(level)));
    const woodBase = L === 1 ? 0xb5946a : L === 2 ? 0xa07f52 : 0x8a6844;
    const dim = isPlayer ? 1 : 0.92;
    const wood = shade(woodBase, dim);
    return {
        wood,
        woodDk: shade(wood, 0.76),
        woodHi: shade(wood, 1.16),
        line: shade(wood, 0.5),
        iron: 0x565661, ironDk: 0x3e3e47, ironHi: 0x8a8a96,
        barrel: 0x46464f, bore: 0x26262b,
        ring: L === 1 ? 0x565661 : L === 2 ? 0xa2793d : 0xd4af37,
        hemp: L === 1 ? 0xc9b389 : null,
        sand: L === 3 ? 0xd9c49a : null,
        gold: L === 3 ? 0xd4af37 : null,
        goldHi: L === 3 ? 0xf0d878 : null,
        cloth: isPlayer ? 0x3f74b3 : 0xb63f34,
        clothDk: isPlayer ? 0x2d5486 : 0x8c2f27,
        soot: 0x241f1c
    };
}

const GG = DAVINCI_GEOM;

/** A point on the machine: absolute plan angle a, plan radius r, height h. */
function pt(a: number, r: number, h: number): P2 {
    return [Math.cos(a) * r, Math.sin(a) * r * 0.5 + GG.GROUND - h];
}

/** Skirt cone radius at height h (rim → waist). */
function skirtR(h: number): number {
    const t = (h - GG.RIM_H) / (GG.WAIST_H - GG.RIM_H);
    return GG.RIM_R + (GG.WAIST_R - GG.RIM_R) * clamp01(t);
}

/** Screen-light for a facet whose outward normal points at plan angle m.
 *  Sun sits up-left; roof facets tilt toward the sky and read brighter. */
function facetLight(m: number, roof: boolean): number {
    const sx = Math.cos(m), sy = Math.sin(m) * 0.5;
    const len = Math.hypot(sx, sy) || 1;
    const cosToSun = (sx * -0.707 + sy * -0.707) / len;
    return (roof ? 0.9 : 0.8) + 0.26 * cosToSun;
}

function drawBombard(
    g: G, pal: DaVinciPal, a: number, protrusion: number, soot: number, dim: number
): void {
    const baseR = 25.5, tipR = GG.RING_R + protrusion;
    const ux = Math.cos(a), uy = Math.sin(a) * 0.5;
    let px = -Math.sin(a), py = Math.cos(a) * 0.5;
    const pl = Math.hypot(px, py) || 1;
    px /= pl; py /= pl;
    const bx = ux * baseR, by = uy * baseR + GG.GROUND - GG.HUB_H;
    const tx = ux * tipR, ty = uy * tipR + GG.GROUND - GG.HUB_H;
    const wB = 3.4, wT = 2.6;
    const body = shade(pal.barrel, dim);
    poly(g, [
        [bx + px * wB, by + py * wB], [tx + px * wT, ty + py * wT],
        [tx - px * wT, ty - py * wT], [bx - px * wB, by - py * wB]
    ], body);
    // lengthwise light: up-left flank catches the sun, lower flank falls off
    seg(g, [bx - px * 1.6, by - py * 1.6], [tx - px * 1.2, ty - py * 1.2], 1.1, shade(pal.ironHi, dim * 0.92), 0.85);
    seg(g, [bx + px * 2.1, by + py * 2.1], [tx + px * 1.7, ty + py * 1.7], 1.2, shade(pal.ironDk, dim), 0.9);
    // two classic bombard reinforcing hoops, riding out with the barrel
    for (const along of [0.34, 0.66]) {
        const hoopT = baseR + (tipR - baseR) * along;
        const hx = ux * hoopT, hy = uy * hoopT + GG.GROUND - GG.HUB_H;
        const hw = wB + (wT - wB) * along + 0.9;
        seg(g, [hx + px * hw, hy + py * hw], [hx - px * hw, hy - py * hw], 2.1, shade(pal.ironDk, dim));
        if (pal.gold !== null) {
            seg(g, [hx + px * hw, hy + py * hw], [hx - px * hw, hy - py * hw], 0.7, shade(pal.gold, dim), 0.9);
        }
    }
    // muzzle: flared end ring + deep bore, blackened by fresh fire
    const mzRing = mix(shade(pal.ironHi, dim), pal.soot, soot);
    g.fillStyle(mzRing, 1);
    g.fillEllipse(tx, ty, wT * 2 + 1.4, wT * 1.5 + 1);
    g.fillStyle(mix(pal.bore, pal.soot, soot * 0.6), 1);
    g.fillEllipse(tx + ux * 0.5, ty + uy * 0.5, wT * 1.6, wT * 1.2);
}

export function drawDaVinciTank(
    g: G,
    isPlayer: boolean,
    isMoving: boolean,
    isDeactivated: boolean = false,
    facingAngle: number = 0,
    troopLevel: number = 1,
    time: number = 0,
    tankSpin01: number = 0
): void {
    const pal = davinciTankPalette(troopLevel, isPlayer);
    const L = Math.max(1, Math.min(3, Math.round(troopLevel)));
    const spin = clamp01(tankSpin01);
    const eff = facingAngle + spin * BAY;

    // post-shot recoil + soot on the fired (bay 0) bombard — spin frames only
    const firing = spin > 0.001;
    const recCurve = firing ? Math.pow(Math.max(0, 1 - spin / 0.8), 1.5) : 0;
    const rec = 7 * recCurve;
    const soot = firing ? Math.max(0, 1 - spin / 0.8) : 0;

    const moving = isMoving && !isDeactivated;
    const bob = moving ? 0.9 * Math.sin(TAU * time / 240) : 0;
    const sway = moving ? 1.3 * Math.sin(TAU * time / 480) : 0;
    const settle = isDeactivated ? 2 : 0;

    // ========================================================== 1. shadow ==
    g.fillStyle(0x1a130c, 0.3);
    g.fillEllipse(0, GG.GROUND + 1.5, 82, 30);
    g.fillStyle(0x1a130c, 0.18);
    g.fillEllipse(0, GG.GROUND + 1.5, 58, 21);

    g.save();
    g.translateCanvas(0, bob + settle);

    // ===================================================== 2. far bombards ==
    for (let k = 0; k < 8; k++) {
        const a = eff + k * BAY;
        if (Math.sin(a) < -0.1) {
            drawBombard(g, pal, a, GG.BARREL_OUT - (k === 0 ? rec : 0), k === 0 ? soot : 0, 0.82);
        }
    }

    // ====================================================== 3. skirt cone ==
    const facets = Array.from({ length: 8 }, (_, k) => k)
        .sort((ka, kb) => Math.sin(eff + ka * BAY) - Math.sin(eff + kb * BAY));
    for (const k of facets) {
        const mid = eff + k * BAY;
        const a0 = mid - BAY / 2, a1 = mid + BAY / 2;
        const light = facetLight(mid, false);
        poly(g, [
            pt(a0, GG.RIM_R, GG.RIM_H), pt(mid, GG.RIM_R + 0.7, GG.RIM_H - 0.2), pt(a1, GG.RIM_R, GG.RIM_H),
            pt(a1, GG.WAIST_R, GG.WAIST_H), pt(mid, GG.WAIST_R + 0.5, GG.WAIST_H - 0.1), pt(a0, GG.WAIST_R, GG.WAIST_H)
        ], shade(pal.wood, light));
        // plank seams: facet borders strong, two inner boards faint, plus
        // horizontal course lines — stacked boards read as HEIGHT
        seg(g, pt(a0, GG.RIM_R, GG.RIM_H), pt(a0, GG.WAIST_R, GG.WAIST_H), 1, pal.line, 0.85);
        for (const s of [-1, 1]) {
            const sa = mid + s * BAY / 6;
            seg(g, pt(sa, GG.RIM_R - 0.4, GG.RIM_H + 0.4), pt(sa, GG.WAIST_R + 0.3, GG.WAIST_H - 0.3),
                0.7, shade(pal.wood, light * 0.82), 0.7);
        }
        for (const ch of [10, 16]) {
            seg(g, pt(a0 + 0.05, skirtR(ch), ch), pt(a1 - 0.05, skirtR(ch), ch),
                0.6, shade(pal.wood, light * 0.86), 0.65);
        }
        if (pal.hemp !== null && Math.sin(mid) > -0.35) {
            // L1: hemp lashings x-tied across the lower boards of every facet
            const rA = skirtR(8), rB = skirtR(15);
            seg(g, pt(mid - 0.1, rA, 8), pt(mid + 0.1, rB, 15), 0.8, pal.hemp, 0.85);
            seg(g, pt(mid + 0.1, rA, 8), pt(mid - 0.1, rB, 15), 0.8, pal.hemp, 0.85);
        }
        if (L >= 2) {
            // L2+: iron edge strap on every facet border, studded mid-run
            seg(g, pt(a0, GG.RIM_R - 0.3, GG.RIM_H + 0.3), pt(a0, GG.WAIST_R + 0.4, GG.WAIST_H - 0.4), 1.5, pal.ironDk, 0.9);
            const sp = pt(a0, skirtR(13), 13);
            g.fillStyle(pal.ironHi, 0.9);
            g.fillCircle(sp[0], sp[1], 0.9);
        }
    }

    // ============================================ 4. under-rim + rollers ==
    // dark running gap under the shell, then the armored rollers, then the
    // rim lip drawn over their tops so only the lower treads peek out
    for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        if (Math.sin(a) < 0.05) continue;
        const p0 = pt(a, GG.RIM_R - 2, 2), p1 = pt(a + TAU / 16, GG.RIM_R - 2, 2);
        poly(g, [p0, p1, pt(a + TAU / 16, GG.RIM_R - 6, 0), pt(a, GG.RIM_R - 6, 0)], shade(pal.woodDk, 0.42));
    }
    const treadPhase = moving ? (time % 480) / 480 : 0;
    for (let k = 0; k < 8; k++) {
        const a = eff + (k + 0.5) * BAY;
        if (Math.sin(a) < 0.25) continue;
        const c = pt(a, GG.RING_R - 1, 0);
        const cy = c[1] - 3.1;
        g.fillStyle(pal.ironDk, 1);
        g.fillEllipse(c[0], cy, 9.2, 7.8);
        g.fillStyle(shade(pal.iron, 0.9), 1);
        g.fillEllipse(c[0], cy, 6.9, 5.7);
        // tread pegs churn one pitch per stride, all rollers in phase
        for (let peg = 0; peg < 3; peg++) {
            const px = ((peg + treadPhase) % 3) * 2.9 - 2.9;
            g.fillStyle(pal.ironHi, 0.95);
            g.fillRect(c[0] + px - 0.6, c[1] - 1.4, 1.3, 1.7);
        }
    }
    for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        if (Math.sin(a) < -0.02) continue;
        const p0 = pt(a, GG.RIM_R, GG.RIM_H), p1 = pt(a + TAU / 16, GG.RIM_R, GG.RIM_H);
        poly(g, [p0, p1, pt(a + TAU / 16, GG.RIM_R - 0.6, 1.6), pt(a, GG.RIM_R - 0.6, 1.6)], shade(pal.woodDk, 0.62));
    }

    // ================================================= 5. hoop + glint ==
    const hoopR = skirtR(6);
    g.lineStyle(1.7, pal.ironDk, 0.95);
    g.strokeEllipse(0, GG.GROUND - 6, hoopR * 2, hoopR);
    const glintSlot = Math.floor(time / 250) % 8; // 8 × 250 ms = exact 2000 ms circuit
    const glintAbs = glintSlot * BAY;
    for (let k = 0; k < 8; k++) {
        const a = eff + k * BAY;
        const sp = pt(a, hoopR, 6);
        const lit = !isDeactivated && Math.cos(a - glintAbs) > 0.981;
        g.fillStyle(pal.gold !== null ? pal.gold : pal.iron, 1);
        g.fillCircle(sp[0], sp[1], 0.9);
        if (lit) {
            g.fillStyle(pal.goldHi !== null ? pal.goldHi : 0xd9d9e2, 0.95);
            g.fillCircle(sp[0], sp[1], 1.2);
        }
    }

    // ======================================== 6. ports + near bombards ==
    for (let k = 0; k < 8; k++) {
        const a = eff + k * BAY;
        const sinA = Math.sin(a);
        const ajar = isDeactivated && (k === 1 || k === 4 || k === 6);
        const c = pt(a, GG.RING_R + 0.3, GG.HUB_H);
        if (sinA >= -0.1) {
            drawBombard(g, pal, a, GG.BARREL_OUT - (k === 0 ? rec : 0), k === 0 ? soot : 0, 1);
        }
        if (sinA > -0.55) {
            g.lineStyle(1.4, pal.ring, 0.95);
            g.strokeEllipse(c[0], c[1], 7.4, 3.7);
        }
        // port lid: a plank shutter hinged above the ring (hangs ajar on the husk)
        if (sinA > -0.2) {
            let tx = -Math.sin(a), ty = Math.cos(a) * 0.5;
            const tl = Math.hypot(tx, ty) || 1;
            tx = (tx / tl) * 2.5; ty = (ty / tl) * 2.5;
            const up = pt(a, GG.RING_R + 1.8, GG.HUB_H + 3.8);
            const dn = pt(a, GG.RING_R + 2.5, GG.HUB_H + 1);
            if (!ajar) {
                poly(g, [
                    [up[0] + tx, up[1] + ty], [up[0] - tx, up[1] - ty],
                    [dn[0] - tx, dn[1] - ty], [dn[0] + tx, dn[1] + ty]
                ], pal.woodDk, 0.95);
                seg(g, [up[0] + tx, up[1] + ty], [up[0] - tx, up[1] - ty], 0.7, pal.ironDk, 0.9);
            } else {
                const drop: P2 = [dn[0] + 1.2, dn[1] + 3.4];
                poly(g, [
                    [up[0] + tx * 0.9, up[1] + ty * 0.9], [up[0] - tx * 0.9, up[1] - ty * 0.9],
                    [drop[0] - tx * 0.8, drop[1] - ty * 0.8], [drop[0] + tx * 0.8, drop[1] + ty * 0.8]
                ], shade(pal.woodDk, 0.85), 0.95);
                // soot licks up the boards over the dead port
                poly(g, [
                    [c[0] - 1.6, c[1] - 1], [c[0] + 1.4, c[1] - 1.4],
                    [c[0] + 0.7, c[1] - 5.2], [c[0] - 0.6, c[1] - 4.6]
                ], pal.soot, 0.5);
            }
        }
    }

    // ======================================================= 7. roof cone ==
    if (pal.sand !== null) {
        g.lineStyle(2.2, pal.sand, 1);
        g.strokeEllipse(0, GG.GROUND - GG.WAIST_H, GG.WAIST_R * 2, GG.WAIST_R);
        g.lineStyle(0.7, pal.gold as number, 0.9);
        g.strokeEllipse(0, GG.GROUND - GG.WAIST_H - 0.8, GG.WAIST_R * 1.94, GG.WAIST_R * 0.97);
    } else {
        g.lineStyle(1.6, pal.ironDk, 0.95);
        g.strokeEllipse(0, GG.GROUND - GG.WAIST_H, GG.WAIST_R * 2, GG.WAIST_R);
    }
    for (const k of facets) {
        const mid = eff + k * BAY;
        const a0 = mid - BAY / 2, a1 = mid + BAY / 2;
        const light = facetLight(mid, true);
        poly(g, [
            pt(a0, GG.WAIST_R, GG.WAIST_H), pt(mid, GG.WAIST_R + 0.4, GG.WAIST_H), pt(a1, GG.WAIST_R, GG.WAIST_H),
            pt(a1, GG.CROWN_R, GG.CROWN_H), pt(a0, GG.CROWN_R, GG.CROWN_H)
        ], shade(pal.wood, light));
        seg(g, pt(a0, GG.WAIST_R, GG.WAIST_H), pt(a0, GG.CROWN_R, GG.CROWN_H), 0.9, pal.line, 0.8);
    }

    // ============================================== 8. crown + cupola ==
    const sx = (h: number): number => sway * clamp01((h - GG.WAIST_H) / (GG.APEX_H - GG.WAIST_H));
    g.fillStyle(shade(pal.wood, 1.08), 1);
    g.fillEllipse(sx(GG.CROWN_H), GG.GROUND - GG.CROWN_H, GG.CROWN_R * 2, GG.CROWN_R);
    g.lineStyle(1.3, pal.ironDk, 0.9);
    g.strokeEllipse(sx(GG.CROWN_H), GG.GROUND - GG.CROWN_H, GG.CROWN_R * 2, GG.CROWN_R);

    const cupTopY = GG.GROUND - GG.CUP_H;
    const cupBotY = GG.GROUND - GG.CROWN_H + 1;
    const cupX = sx((GG.CROWN_H + GG.CUP_H) / 2);
    poly(g, [
        [cupX - GG.CUP_R, cupTopY], [cupX + GG.CUP_R, cupTopY],
        [cupX + GG.CUP_R, cupBotY], [cupX - GG.CUP_R, cupBotY]
    ], pal.wood);
    poly(g, [
        [cupX - GG.CUP_R, cupTopY], [cupX - GG.CUP_R + 1.7, cupTopY],
        [cupX - GG.CUP_R + 1.7, cupBotY], [cupX - GG.CUP_R, cupBotY]
    ], pal.woodDk, 0.85);
    poly(g, [
        [cupX + GG.CUP_R - 1.5, cupTopY], [cupX + GG.CUP_R, cupTopY],
        [cupX + GG.CUP_R, cupBotY], [cupX + GG.CUP_R - 1.5, cupBotY]
    ], pal.woodDk, 0.6);
    // eight viewing slits riding the ring — near-side ones show
    for (let k = 0; k < 8; k++) {
        const a = eff + k * BAY;
        if (Math.sin(a) <= 0.15) continue;
        const slitX = cupX + Math.cos(a) * (GG.CUP_R - 0.7);
        g.fillStyle(0x1f1c18, 0.95);
        g.fillRect(slitX - 0.8, cupTopY + 2, 1.6, 3.6);
    }
    // cap: smooth cone with eight rib seams, brim overhanging the cupola
    const brimY = cupTopY - 0.4;
    g.fillStyle(shade(pal.wood, 0.9), 1);
    g.fillEllipse(sx(GG.CUP_H), brimY, 13.6, 6.2);
    const apex: P2 = [sx(GG.APEX_H), GG.GROUND - GG.APEX_H];
    poly(g, [[sx(GG.CUP_H) - 6.3, brimY], [sx(GG.CUP_H) + 6.3, brimY], apex], shade(pal.wood, 1.05));
    for (let k = 0; k < 8; k++) {
        const a = eff + k * BAY;
        if (Math.sin(a) < 0.05) continue;
        seg(g, apex, [sx(GG.CUP_H) + Math.cos(a) * 6.1, brimY + Math.sin(a) * 2.7], 0.6, pal.line, 0.7);
    }

    // ============================================ 9. smokestack + banner ==
    // The engine breathes through a centered iron stack rising out of the
    // cap apex (centered = legal under the 8-fold seam law). The banner
    // flies from a crossarm just under its crown.
    const huskLean = isDeactivated ? 1.1 : 0;
    const stackAt = (h: number): P2 => [
        sx(h) + huskLean * clamp01((h - GG.APEX_H) / (GG.STACK_TOP - GG.APEX_H)),
        GG.GROUND - h
    ];
    const sBase = stackAt(GG.APEX_H - 1.5), sTop = stackAt(GG.STACK_TOP);
    poly(g, [
        [sBase[0] - 1.5, sBase[1]], [sTop[0] - 1.4, sTop[1]],
        [sTop[0] + 1.4, sTop[1]], [sBase[0] + 1.5, sBase[1]]
    ], pal.iron);
    seg(g, [sBase[0] - 1.1, sBase[1]], [sTop[0] - 1, sTop[1]], 0.7, pal.ironHi, 0.8);
    seg(g, [sBase[0] + 1.2, sBase[1]], [sTop[0] + 1.1, sTop[1]], 0.8, pal.ironDk, 0.9);
    // crown lip + collar band where the stack meets the cap
    g.fillStyle(pal.ironDk, 1);
    g.fillRect(sTop[0] - 2.2, sTop[1] - 1.4, 4.4, 1.9);
    g.fillStyle(0x17140f, 1);
    g.fillRect(sTop[0] - 1.3, sTop[1] - 1.1, 2.6, 1);
    g.fillStyle(pal.gold !== null ? pal.gold : pal.ironDk, 1);
    g.fillRect(sBase[0] - 1.9, sBase[1] - 0.4, 3.8, 1.3);

    const armH = GG.STACK_TOP - 2;
    const arm = stackAt(armH);
    seg(g, [arm[0], arm[1]], [arm[0] + 3.4, arm[1]], 1, pal.ironDk);
    if (!isDeactivated) {
        // pixel-column cloth: 2000/1000 ms harmonics, ~2.8 px tip travel
        const cols = 5, colW = 2.5, clothH = 8;
        for (let ci = 0; ci < cols; ci++) {
            const amp = 2.8 * (ci / (cols - 1));
            const wobble = amp * Math.sin(TAU * time / 2000 - ci * 0.9)
                + 0.4 * amp * Math.sin(TAU * time / 1000 - ci * 1.3);
            const x0 = arm[0] + 1.6 + ci * colW;
            const y0 = arm[1] + 0.3 + wobble;
            const h = clothH - ci * 0.4;
            g.fillStyle(pal.cloth, 1);
            g.fillRect(x0, y0, colW + 0.35, h * 0.55);
            g.fillStyle(pal.clothDk, 1);
            g.fillRect(x0, y0 + h * 0.55, colW + 0.35, h * 0.45);
        }
    } else {
        // dead banner: hangs limp off the arm of the cold, leaning stack
        g.fillStyle(pal.clothDk, 1);
        g.fillRect(arm[0] + 2.2, arm[1] + 0.4, 2.6, 9);
        g.fillStyle(shade(pal.clothDk, 0.8), 1);
        g.fillRect(arm[0] + 4.6, arm[1] + 0.4, 1.5, 6.2);
    }

    // ======================================================= 10. exhaust ==
    // Engine steam, ONLY while rolling: three chuffs per cycle, one full
    // puff train per 480 ms stride, drifting downwind (screen-right, the
    // same wind the banner flies). Deterministic f(time); walk frames never
    // enter the spin seam, so the off-cycle asymmetry is legal.
    if (moving) {
        // NOTE: the bake alpha-snaps at 50% — steam must stay above that or
        // it quantizes away entirely (the owl/dragon translucency lesson).
        for (let k = 0; k < 3; k++) {
            const ph = ((time / 480) + k / 3) % 1;
            const px = sTop[0] + ph * 5 + Math.sin(TAU * ph + k * 2.1) * 1.2;
            const py = sTop[1] - 2.5 - ph * 13;
            const r = 2 + ph * 3.4;
            const fade = 1 - ph * 0.8;
            g.fillStyle(0xb9b2a4, 0.58 * fade);
            g.fillEllipse(px, py, r * 2.5, r * 2);
            g.fillStyle(0xe9e3d6, 0.8 * fade);
            g.fillEllipse(px - r * 0.2, py - r * 0.2, r * 1.6, r * 1.3);
        }
    }

    g.restore();
}
