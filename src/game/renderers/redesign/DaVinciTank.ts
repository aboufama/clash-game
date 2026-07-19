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
 *     radius 26, barrel protrusion 12 (tips at 38), hub 2 px below the
 *     anchor (ring height 7 over ground line +9).
 *   - RECOIL (owner ask 2026-07-19): during the post-shot index the just
 *     fired bay-0 bombard is rammed back into its port and runs back out —
 *     rec = 5 * (1 - spin01/0.8)^1.5 px, muzzle sooted on the same curve.
 *     Both are exactly zero from spin01 >= 0.8, so the seam law holds, and
 *     both are gated on spin01 > 0 so idle/walk (spin01 = 0) never recoil.
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
    RING_R: 26,     // port ring radius (MainScene: ring 26 + barrel 12)
    BARREL_OUT: 12, // seated protrusion beyond the ring → tips at 38
    RIM_R: 30, RIM_H: 3.5,      // skirt rim
    WAIST_R: 16.5, WAIST_H: 16, // skirt→roof break
    CROWN_R: 6.5, CROWN_H: 23,  // roof→deck
    CUP_R: 4.6, CUP_H: 29.5,    // cupola top
    APEX_H: 34                  // cap apex
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
    const baseR = 24, tipR = GG.RING_R + protrusion;
    const ux = Math.cos(a), uy = Math.sin(a) * 0.5;
    let px = -Math.sin(a), py = Math.cos(a) * 0.5;
    const pl = Math.hypot(px, py) || 1;
    px /= pl; py /= pl;
    const bx = ux * baseR, by = uy * baseR + GG.GROUND - GG.HUB_H;
    const tx = ux * tipR, ty = uy * tipR + GG.GROUND - GG.HUB_H;
    const wB = 2.4, wT = 1.8;
    const body = shade(pal.barrel, dim);
    poly(g, [
        [bx + px * wB, by + py * wB], [tx + px * wT, ty + py * wT],
        [tx - px * wT, ty - py * wT], [bx - px * wB, by - py * wB]
    ], body);
    // lengthwise light: up-left flank catches the sun, lower flank falls off
    seg(g, [bx - px * 1.1, by - py * 1.1], [tx - px * 0.9, ty - py * 0.9], 0.9, shade(pal.ironHi, dim * 0.92), 0.85);
    seg(g, [bx + px * 1.5, by + py * 1.5], [tx + px * 1.2, ty + py * 1.2], 1, shade(pal.ironDk, dim), 0.9);
    // the classic bombard reinforcing hoop, riding out with the barrel
    const hoopT = baseR + (tipR - baseR) * 0.58;
    const hx = ux * hoopT, hy = uy * hoopT + GG.GROUND - GG.HUB_H;
    const hw = wB + (wT - wB) * 0.58 + 0.7;
    seg(g, [hx + px * hw, hy + py * hw], [hx - px * hw, hy - py * hw], 1.7, shade(pal.ironDk, dim));
    if (pal.gold !== null) {
        seg(g, [hx + px * hw, hy + py * hw], [hx - px * hw, hy - py * hw], 0.6, shade(pal.gold, dim), 0.9);
    }
    // muzzle: end ring + dark bore, blackened by fresh fire
    const mzRing = mix(shade(pal.ironHi, dim), pal.soot, soot);
    g.fillStyle(mzRing, 1);
    g.fillEllipse(tx, ty, wT * 2 + 0.8, wT * 1.5 + 0.6);
    g.fillStyle(mix(pal.bore, pal.soot, soot * 0.6), 1);
    g.fillEllipse(tx + ux * 0.4, ty + uy * 0.4, wT * 1.4, wT * 1.05);
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
    const rec = 5 * recCurve;
    const soot = firing ? Math.max(0, 1 - spin / 0.8) : 0;

    const moving = isMoving && !isDeactivated;
    const bob = moving ? 0.9 * Math.sin(TAU * time / 240) : 0;
    const sway = moving ? 1.3 * Math.sin(TAU * time / 480) : 0;
    const settle = isDeactivated ? 1.6 : 0;

    // ========================================================== 1. shadow ==
    g.fillStyle(0x1a130c, 0.3);
    g.fillEllipse(0, GG.GROUND + 1.5, 74, 27);
    g.fillStyle(0x1a130c, 0.18);
    g.fillEllipse(0, GG.GROUND + 1.5, 52, 18);

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
        // plank seams: facet borders strong, two inner boards faint
        seg(g, pt(a0, GG.RIM_R, GG.RIM_H), pt(a0, GG.WAIST_R, GG.WAIST_H), 1, pal.line, 0.85);
        for (const s of [-1, 1]) {
            const sa = mid + s * BAY / 6;
            seg(g, pt(sa, GG.RIM_R - 0.4, GG.RIM_H + 0.4), pt(sa, GG.WAIST_R + 0.3, GG.WAIST_H - 0.3),
                0.7, shade(pal.wood, light * 0.82), 0.7);
        }
        if (pal.hemp !== null && Math.sin(mid) > -0.35) {
            // L1: hemp lashings x-tied across the lower boards of every facet
            const rA = skirtR(6), rB = skirtR(11);
            seg(g, pt(mid - 0.1, rA, 6), pt(mid + 0.1, rB, 11), 0.8, pal.hemp, 0.85);
            seg(g, pt(mid + 0.1, rA, 6), pt(mid - 0.1, rB, 11), 0.8, pal.hemp, 0.85);
        }
        if (L >= 2) {
            // L2+: iron edge strap on every facet border, studded mid-run
            seg(g, pt(a0, GG.RIM_R - 0.3, GG.RIM_H + 0.3), pt(a0, GG.WAIST_R + 0.4, GG.WAIST_H - 0.4), 1.3, pal.ironDk, 0.9);
            const sp = pt(a0, skirtR(9.5), 9.5);
            g.fillStyle(pal.ironHi, 0.9);
            g.fillCircle(sp[0], sp[1], 0.7);
        }
    }

    // ============================================ 4. under-rim + rollers ==
    // dark running gap under the shell, then the armored rollers, then the
    // rim lip drawn over their tops so only the lower treads peek out
    for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        if (Math.sin(a) < 0.05) continue;
        const p0 = pt(a, GG.RIM_R - 2, 1.6), p1 = pt(a + TAU / 16, GG.RIM_R - 2, 1.6);
        poly(g, [p0, p1, pt(a + TAU / 16, GG.RIM_R - 5, 0), pt(a, GG.RIM_R - 5, 0)], shade(pal.woodDk, 0.42));
    }
    const treadPhase = moving ? (time % 480) / 480 : 0;
    for (let k = 0; k < 8; k++) {
        const a = eff + (k + 0.5) * BAY;
        if (Math.sin(a) < 0.25) continue;
        const c = pt(a, GG.RING_R, 0);
        const cy = c[1] - 2.6;
        g.fillStyle(pal.ironDk, 1);
        g.fillEllipse(c[0], cy, 7.6, 6.4);
        g.fillStyle(shade(pal.iron, 0.9), 1);
        g.fillEllipse(c[0], cy, 5.6, 4.6);
        // tread pegs churn one pitch per stride, all rollers in phase
        for (let peg = 0; peg < 3; peg++) {
            const px = ((peg + treadPhase) % 3) * 2.4 - 2.4;
            g.fillStyle(pal.ironHi, 0.95);
            g.fillRect(c[0] + px - 0.5, c[1] - 1.1, 1.1, 1.4);
        }
    }
    for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        if (Math.sin(a) < -0.02) continue;
        const p0 = pt(a, GG.RIM_R, GG.RIM_H), p1 = pt(a + TAU / 16, GG.RIM_R, GG.RIM_H);
        poly(g, [p0, p1, pt(a + TAU / 16, GG.RIM_R - 0.6, 1.2), pt(a, GG.RIM_R - 0.6, 1.2)], shade(pal.woodDk, 0.62));
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
            g.lineStyle(1.1, pal.ring, 0.95);
            g.strokeEllipse(c[0], c[1], 6, 3);
        }
        // port lid: a plank shutter hinged above the ring (hangs ajar on the husk)
        if (sinA > -0.2) {
            let tx = -Math.sin(a), ty = Math.cos(a) * 0.5;
            const tl = Math.hypot(tx, ty) || 1;
            tx = (tx / tl) * 2.1; ty = (ty / tl) * 2.1;
            const up = pt(a, GG.RING_R + 1.6, GG.HUB_H + 3.2);
            const dn = pt(a, GG.RING_R + 2.2, GG.HUB_H + 0.9);
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
        const slitX = cupX + Math.cos(a) * (GG.CUP_R - 0.6);
        g.fillStyle(0x1f1c18, 0.95);
        g.fillRect(slitX - 0.7, cupTopY + 1.6, 1.4, 3);
    }
    // cap: smooth cone with eight rib seams, brim overhanging the cupola
    const brimY = cupTopY - 0.4;
    g.fillStyle(shade(pal.wood, 0.9), 1);
    g.fillEllipse(sx(GG.CUP_H), brimY, 11.6, 5.4);
    const apex: P2 = [sx(GG.APEX_H), GG.GROUND - GG.APEX_H];
    poly(g, [[sx(GG.CUP_H) - 5.4, brimY], [sx(GG.CUP_H) + 5.4, brimY], apex], shade(pal.wood, 1.05));
    for (let k = 0; k < 8; k++) {
        const a = eff + k * BAY;
        if (Math.sin(a) < 0.05) continue;
        seg(g, apex, [sx(GG.CUP_H) + Math.cos(a) * 5.2, brimY + Math.sin(a) * 2.3], 0.6, pal.line, 0.7);
    }
    g.fillStyle(pal.gold !== null ? pal.gold : pal.iron, 1);
    g.fillCircle(apex[0], apex[1] - 1, 1.5);
    if (pal.goldHi !== null) {
        g.fillStyle(pal.goldHi, 0.9);
        g.fillCircle(apex[0] - 0.4, apex[1] - 1.4, 0.6);
    }

    // ========================================================= 9. banner ==
    const poleBase: P2 = [apex[0], apex[1] - 1.6];
    const poleTop: P2 = [sx(41) + (isDeactivated ? 1.1 : 0), GG.GROUND - 41 + (isDeactivated ? 0.8 : 0)];
    seg(g, poleBase, poleTop, 1.1, pal.ironDk);
    if (!isDeactivated) {
        // pixel-column cloth: 2000/1000 ms harmonics, ~2.6 px tip travel
        const cols = 5, colW = 2.3, clothH = 7;
        for (let ci = 0; ci < cols; ci++) {
            const amp = 2.6 * (ci / (cols - 1));
            const wobble = amp * Math.sin(TAU * time / 2000 - ci * 0.9)
                + 0.4 * amp * Math.sin(TAU * time / 1000 - ci * 1.3);
            const x0 = poleTop[0] + 0.6 + ci * colW;
            const y0 = poleTop[1] + 0.4 + wobble;
            const h = clothH - ci * 0.35;
            g.fillStyle(pal.cloth, 1);
            g.fillRect(x0, y0, colW + 0.35, h * 0.55);
            g.fillStyle(pal.clothDk, 1);
            g.fillRect(x0, y0 + h * 0.55, colW + 0.35, h * 0.45);
        }
    } else {
        // dead banner: hangs straight off the tilted pole, two limp folds
        g.fillStyle(pal.clothDk, 1);
        g.fillRect(poleTop[0] - 0.4, poleTop[1] + 0.4, 2.4, 8.2);
        g.fillStyle(shade(pal.clothDk, 0.8), 1);
        g.fillRect(poleTop[0] + 2.0, poleTop[1] + 0.4, 1.4, 5.6);
    }

    g.restore();
}
