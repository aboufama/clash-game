import type Phaser from 'phaser';

/**
 * QUARTERMASTER — design C: "The Drum-Bearer".
 *
 * A stout supply-officer marching with a big kettle drum on a chest harness,
 * skin facing UP, beaten with two cream-headed mallets. The war-drum rhythm
 * is the design: every hit lands a mallet on the skin (flash), kicks a chunky
 * shock ring across the ground and throws sound-arc ticks up off the rim, so
 * the support aura reads even in a still frame. Non-combatant kit everywhere:
 * bedroll across the pack, supply pouches swinging at his hips, a standard
 * pole with a company pennant instead of any weapon.
 *
 * SILHOUETTE: villager-scale stout human (~21 px head-to-toe, ground +9.5),
 * WIDE not tall — the space-8 presence is the drum (±9 px), the pack and the
 * pennant pole (top ≈ −27). Distinct from casters: no robe, no staff — an
 * apron-and-harness porter with a giant drum.
 *
 * ANIMATION (all deterministic f(time), exact 250 ms-multiple harmonics):
 *  - IDLE, 2000 ms master loop (TROOP_PARAMS idleMs): alternating taps —
 *    left mallet hits at +600 ms, right at +1600 ms → one hit every 1000 ms,
 *    locked to MainScene's 1000 ms aura beat ring. Breath on 2000 ms,
 *    pennant wave on 1000 ms, shock ring life 350 ms per hit.
 *  - WALK, 500 ms stride: both mallets slam ONE big BOOM per stride at the
 *    footfall (phase 0) — the beat that drives the march. Shock ring life
 *    300 ms. The whole envelope is stride-periodic so the bake loop closes.
 *  - NO attack sequence (damage 0, TROOP_PARAMS attack:false).
 *
 * LEVELS: L1 wooden supply-barrel drum, rope lacing, plain gold pennant.
 * L2 brass kettle, iron band + studs, owner-colour heraldic drape, feather.
 * L3 polished brass with a GOLD rim hoop, gold roundel on the drape, gilt
 * finial, cream plume — gold/cream as small accents only (iron rule 5).
 *
 * Bake-safety: every element drawn over empty canvas keeps alpha ≥ 0.55
 * (shock ring 0.80→0.58, sound ticks 0.75 gated) so the 50% alpha snap never
 * erases the rhythm FX; the contact shadow (0.22) exists for the vector
 * fallback only — the baked path uses the carrier shadow sprite.
 */

type G = Phaser.GameObjects.Graphics;

const TAU = Math.PI * 2;
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeIn = (t: number): number => t * t;
const wrap = (v: number, m: number): number => ((v % m) + m) % m;

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Thick line as a filled quad (flat caps — reads cleaner than stroke). */
function limb(g: G, x1: number, y1: number, x2: number, y2: number, w: number, color: number, alpha = 1): void {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(x1 + nx, y1 + ny);
    g.lineTo(x2 + nx, y2 + ny);
    g.lineTo(x2 - nx, y2 - ny);
    g.lineTo(x1 - nx, y1 - ny);
    g.closePath();
    g.fillPath();
}

/**
 * Mallet stroke envelope over one beat period. u ∈ [0,1), hit at u = 0.
 * Returns k (0 = head on the skin, 1 = fully raised) and f (contact flash
 * 1→0 during the contact window). Piecewise in u — exactly periodic.
 */
function stroke(u: number, contact: number, bounceEnd: number, rest: number, riseStart: number, riseEnd: number): { k: number; f: number } {
    if (u < contact) return { k: 0, f: 1 - u / contact };
    if (u < bounceEnd) return { k: rest * easeOut((u - contact) / (bounceEnd - contact)), f: 0 };
    if (u < riseStart) return { k: rest, f: 0 };
    if (u < riseEnd) return { k: rest + (1 - rest) * easeIn((u - riseStart) / (riseEnd - riseStart)), f: 0 };
    return { k: Math.max(0, 1 - (u - riseEnd) / (1 - riseEnd)), f: 0 }; // whip down into the next hit
}

/** Chunky beat shock ring rolling across the ground (iso 0.42 squash). */
function shockRing(g: G, age: number, life: number, color: number): void {
    if (age < 0 || age >= life) return;
    const t = age / life;
    const rx = 6.5 + 14.5 * easeOut(t); // 6.5 → 21 px — inside the ±32 bake bounds
    const ry = rx * 0.42;
    const size = 2.3 - 1.1 * t;
    const alpha = 0.8 - 0.22 * t; // ends 0.58 — survives the bake alpha snap
    g.fillStyle(color, alpha);
    const n = 12;
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + 0.26;
        g.fillRect(Math.cos(a) * rx - size / 2, 8.7 + Math.sin(a) * ry - size * 0.36, size, size * 0.72);
    }
}

/** Sound-arc ticks popping up-outward off the struck rim (side s = ±1). */
function soundTicks(g: G, s: number, f: number, color: number): void {
    if (f <= 0.2) return; // gated, not faded — alpha stays ≥ 0.55 over empty canvas
    const push = 1 - f; // ticks travel outward as the flash decays
    g.fillStyle(color, 0.85);
    const cx = s * 3.4, cy = -2.5; // the strike point on the skin
    for (const [r0, sz] of [[4.0, 2.3], [6.6, 1.8]] as const) {
        const r = r0 + 2.2 * push;
        const base = -Math.PI / 2 + s * 0.55; // up, tilted to the struck side
        for (const da of [-0.5, 0, 0.5]) {
            const px = cx + Math.cos(base + da) * r;
            const py = cy + Math.sin(base + da) * r * 0.75;
            g.fillRect(px - sz / 2, py - sz * 0.4, sz, sz * 0.8);
        }
    }
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): the
 *  authored walk period is 500 ms (one double-mallet BOOM per stride) — the
 *  TROOP_PARAMS row pins 450. Idle already matches (idleMs 2000). */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    quartermaster: { stride: 500 },
};

export function drawQuartermasterC(
    graphics: G,
    isPlayer: boolean,
    isMoving: boolean,
    _facingAngle: number,
    troopLevel: number,
    time: number,
    _attackAge: number,
    _attackDelay: number,
    _driver: number
): void {
    const g = graphics;
    const level = Math.max(1, Math.min(3, troopLevel || 1));

    // ---------------- palette (player vs enemy) ----------------
    const mul = isPlayer ? 1 : 0.84;
    const cloth = isPlayer ? 0x41639e : 0x9c4034; // tunic: royal blue vs rust red
    const clothLit = shade(cloth, 1.22);
    const clothDark = shade(cloth, 0.68);
    const skin = shade(0xe2b68c, mul);
    const skinDark = shade(0xb98f68, mul);
    const trouser = shade(0x5d4c38, mul);
    const boot = shade(0x30251b, mul);
    const leather = shade(0x5a4228, mul);
    const leatherLit = shade(0x7a5a38, mul);
    const canvasRoll = shade(0x9a8560, mul);
    const rope = shade(0xc9ad7a, mul);
    const wood = shade(0x8a6134, mul);
    const woodLit = shade(0xa87c46, mul);
    const woodDark = shade(0x66471f, mul);
    const brass = shade(level >= 3 ? 0xc2903f : 0xb9843c, mul);
    const brassLit = shade(level >= 3 ? 0xe6b75e : 0xd8a44e, mul);
    const brassDark = shade(0x7d5626, mul);
    const iron = shade(0x565662, mul);
    const stud = shade(0xcfcfda, mul);
    const drumhead = shade(0xe6d3ac, mul);
    const drumheadDark = shade(0xc4b28c, mul);
    const flashCol = 0xfff3cf;
    const gold = shade(0xdaa520, mul);
    const goldBright = shade(0xffd700, mul);
    const cream = shade(0xdcd3ba, mul);
    const pennantBody = level >= 3 ? cream : shade(0xd4a017, mul);
    const pennantEdge = level >= 3 ? gold : shade(0x8f6c10, mul);
    const tickCol = shade(0xffe9a8, mul);
    const ringCol = level >= 3 ? shade(0xf0c85a, mul) : shade(0xe0b23e, mul);

    // ---------------- rhythm state ----------------
    // WALK: 500 ms stride, one double-mallet BOOM at phase 0 (the footfall).
    // IDLE: 2000 ms loop, left hit at +600 ms, right at +1600 ms (t=0 rests).
    let kL: number, kR: number, fL: number, fR: number;
    let ringAge: number, ringLife: number;
    let legSwing = 0, lift = 0, breathe = 0;
    if (isMoving) {
        const ph = wrap(time, 500) / 500;
        legSwing = Math.sin(ph * TAU) * 2.6;
        lift = Math.abs(Math.sin(ph * TAU)) * 1.2;
        const both = stroke(ph, 0.10, 0.30, 0.30, 0.62, 0.92);
        const rSide = stroke(wrap(ph + 0.04, 1), 0.10, 0.30, 0.30, 0.62, 0.92); // hair offset — still stride-periodic
        kL = both.k; fL = both.f;
        kR = rSide.k; fR = rSide.f;
        ringAge = wrap(time, 500);
        ringLife = 300;
    } else {
        breathe = Math.sin((wrap(time, 2000) / 2000) * TAU) * 0.55;
        const uL = wrap(time - 600, 2000) / 2000;
        const uR = wrap(time - 1600, 2000) / 2000;
        const sL = stroke(uL, 0.05, 0.18, 0.32, 0.80, 0.96);
        const sR = stroke(uR, 0.05, 0.18, 0.32, 0.80, 0.96);
        kL = sL.k; fL = sL.f;
        kR = sR.k; fR = sR.f;
        ringAge = wrap(time - 600, 1000); // a hit every 1000 ms
        ringLife = 350;
    }
    const flash = Math.max(fL, fR);
    const dy = -lift * 0.8 - breathe; // everything carried above the hips

    // ---------------- ground ----------------
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(0, 9.6, 21, 7.6);
    shockRing(g, ringAge, ringLife, ringCol);

    // ---------------- standard pole + pennant (behind everything) ----------
    const poleX = -1.6;
    limb(g, poleX, -6.2 + dy, poleX, -26.5 + dy, 1.2, woodDark);
    if (level >= 3) { // gilt finial — a small accent
        g.fillStyle(goldBright, 1);
        g.fillCircle(poleX, -27.3 + dy, 1.3);
    }
    {
        // Pennant flies +x; waves on a 1000 ms harmonic and snaps on each beat.
        const wavePh = (wrap(time, 1000) / 1000) * TAU;
        const snapAge = isMoving ? wrap(time, 500) : wrap(time - 600, 1000);
        const snap = Math.max(0, 1 - snapAge / 220) * 1.8;
        const w1 = Math.sin(wavePh) * 1.1 - snap;
        const w2 = Math.sin(wavePh + 1.4) * 0.9 - snap * 0.6;
        const hx = poleX + 0.5, top = -26.2 + dy, mid = -24.0 + dy, bot = -22.0 + dy;
        g.fillStyle(pennantBody, 1);
        g.fillTriangle(hx, top, 8.4, mid + w1, hx, mid + 0.4);
        if (level >= 2) { // swallowtail: shorter lower tongue
            g.fillTriangle(hx, mid - 0.4, 6.6, mid + 1.2 + w2, hx, bot);
        } else {
            g.fillTriangle(hx, mid - 0.4, 8.4, mid + w1, hx, bot);
        }
        g.fillStyle(pennantEdge, 1); // trim along the fly
        g.fillTriangle(hx, top, 8.4, mid + w1, hx, top + 0.9);
        // hoist stripe in the owner colour so the flag reads the team
        g.fillStyle(cloth, 1);
        g.fillRect(hx - 0.4, top, 1.2, 4.2);
    }

    // ---------------- pack: bedroll + swinging supply pouches ---------------
    g.fillStyle(canvasRoll, 1);
    g.fillRoundedRect(-8.0, -9.2 + dy, 16.0, 3.3, 1.6);
    g.fillStyle(shade(canvasRoll, 0.72), 1); // tie straps on the roll
    g.fillRect(-4.6, -9.2 + dy, 1.1, 3.3);
    g.fillRect(3.5, -9.2 + dy, 1.1, 3.3);
    const pouchSway = isMoving
        ? Math.sin((wrap(time, 500) / 500) * TAU) * 0.9
        : Math.sin((wrap(time, 2000) / 2000) * TAU) * 0.5;
    for (const s of [-1, 1] as const) {
        const px = s * 9.2 + pouchSway * 0.6;
        limb(g, s * 7.8, -6.4 + dy, px, -4.2 + dy, 1.0, leather); // hanger strap
        g.fillStyle(leather, 1);
        g.fillRoundedRect(px - 1.4, -4.4 + dy, 2.8, 3.1, 1.0);
        g.fillStyle(leatherLit, 1);
        g.fillRect(px - 1.4, -4.4 + dy, 2.8, 1.1); // flap
    }

    // ---------------- legs ----------------
    const spread = 2.4;
    g.fillStyle(trouser, 1);
    g.fillRect(-spread - 1.3 - legSwing, 3.4 - lift, 2.6, 6.2 + lift);
    g.fillRect(spread - 1.3 + legSwing, 3.4 - lift, 2.6, 6.2 + lift);
    g.fillStyle(boot, 1);
    g.fillEllipse(-spread - legSwing, 9.3, 3.8, 1.9);
    g.fillEllipse(spread + legSwing, 9.3, 3.8, 1.9);

    // ---------------- torso (broad barrel chest) ----------------
    g.fillStyle(clothDark, 1);
    g.fillRoundedRect(-6.8, -6.8 + dy, 13.6, 10.8, 4);
    g.fillStyle(cloth, 1);
    g.fillRoundedRect(-6.8, -6.8 + dy, 11.2, 10.8, 4);
    g.fillStyle(clothLit, 0.9);
    g.fillRoundedRect(-6.8, -6.8 + dy, 4.6, 10.4, 4); // NW-lit flank
    g.fillStyle(leather, 1);
    g.fillRect(-6.8, 2.0 + dy, 13.6, 1.6); // belt peeking past the drum

    // ---------------- head + cap ----------------
    const hy = -9.6 + dy;
    g.fillStyle(clothDark, 1); // collar — separates the chin from the drumhead
    g.fillRect(-2.4, hy + 2.4, 4.8, 1.4);
    g.fillStyle(skin, 1);
    g.fillCircle(0, hy, 3.1);
    g.fillStyle(skinDark, 1);
    g.fillEllipse(1.5, hy + 0.4, 2.4, 4.4); // SE cheek shade
    g.fillStyle(0x2c2018, 1); // eyes
    g.fillRect(-1.7, hy - 0.7, 1.0, 1.0);
    g.fillRect(0.7, hy - 0.7, 1.0, 1.0);
    g.fillStyle(shade(0x5a3a22, mul), 1); // the quartermaster's moustache
    g.fillRect(-1.8, hy + 0.9, 3.6, 1.1);
    g.fillStyle(leather, 1); // leather field cap
    g.fillEllipse(0, hy - 2.4, 7.2, 3.4);
    g.fillStyle(leatherLit, 1);
    g.fillRect(-3.6, hy - 1.6, 7.2, 1.2); // cap band
    if (level >= 2) { // bandsman feather: cloth at L2, cream plume at L3
        g.fillStyle(level >= 3 ? cream : clothLit, 1);
        g.fillRect(2.2, hy - 5.2, 1.2, 3.2);
        g.fillRect(2.9, hy - 6.2, 1.2, 2.2);
        if (level >= 3) {
            g.fillStyle(goldBright, 1);
            g.fillRect(2.4, hy - 3.0, 1.4, 1.0); // gilt socket
        }
    }

    // ---------------- harness straps shoulders → rim ----------------
    limb(g, -4.6, -5.6 + dy, -7.6, -2.8 + dy, 1.5, leather);
    limb(g, 4.6, -5.6 + dy, 7.6, -2.8 + dy, 1.5, leather);

    // ---------------- the kettle drum ----------------
    const rimY = -2.2 + dy;
    // bowl (NW-lit trio); L1 is a wooden supply-barrel, L2+ a brass kettle
    const bowlBody = level >= 2 ? brass : wood;
    const bowlLit = level >= 2 ? brassLit : woodLit;
    const bowlDark = level >= 2 ? brassDark : woodDark;
    g.fillStyle(bowlDark, 1);
    g.fillEllipse(0, 1.6 + dy, 17.2, 9.2);
    g.fillStyle(bowlBody, 1);
    g.fillEllipse(-0.9, 1.2 + dy, 14.8, 8.2);
    g.fillStyle(bowlLit, 0.95);
    g.fillEllipse(-2.4, 0.4 + dy, 9.0, 5.2);
    if (level === 1) {
        // barrel staves + rope lacing
        g.lineStyle(1, woodDark, 0.85);
        for (const sx of [-5.4, -1.8, 1.8, 5.4]) {
            g.beginPath();
            g.moveTo(sx, 0.4 + dy);
            g.lineTo(sx, 5.4 + dy);
            g.strokePath();
        }
        g.lineStyle(1.1, rope, 1);
        g.beginPath();
        for (let i = 0; i <= 6; i++) {
            const zx = -7.2 + i * 2.4;
            const zy = (i % 2 === 0 ? 1.0 : 3.6) + dy;
            if (i === 0) g.moveTo(zx, zy); else g.lineTo(zx, zy);
        }
        g.strokePath();
    } else {
        // iron band + studs
        g.fillStyle(iron, 1);
        g.fillRect(-7.8, 1.8 + dy, 15.6, 1.7);
        g.fillStyle(stud, 1);
        for (const sx of [-6.0, -2.0, 2.0, 6.0]) g.fillRect(sx - 0.5, 2.2 + dy, 1.0, 1.0);
    }
    // rim hoop + the skin (the stage for the beat)
    g.fillStyle(level >= 3 ? gold : (level >= 2 ? brassDark : woodDark), 1);
    g.fillEllipse(0, rimY, 17.6, 6.6);
    g.fillStyle(drumhead, 1);
    g.fillEllipse(0, rimY - 0.2, 14.6, 5.0);
    g.fillStyle(drumheadDark, 0.9);
    g.fillEllipse(2.0, rimY + 0.5, 8.4, 2.8); // skin shade toward SE
    if (flash > 0) { // the hit lights the skin (over opaque paint — any alpha is safe)
        g.fillStyle(flashCol, 0.9 * flash);
        g.fillEllipse(0, rimY - 0.2, 14.6, 5.0);
    }
    if (level >= 3) { // gold roundel on the bowl front — small accent
        g.fillStyle(goldBright, 1);
        g.fillCircle(0, 3.6 + dy, 1.7);
        g.fillStyle(shade(0x8f6c10, mul), 1);
        g.fillCircle(0, 3.6 + dy, 0.8);
    }
    // heraldic drape below the bowl (L2+): the owner colour on parade
    if (level >= 2) {
        const swayD = pouchSway * 0.5;
        g.fillStyle(cloth, 1); // two-point valance
        g.fillTriangle(-5.2, 4.0 + dy, 0.2, 4.0 + dy, -2.6 + swayD, 8.3 + dy);
        g.fillTriangle(-0.2, 4.0 + dy, 5.2, 4.0 + dy, 2.6 + swayD, 8.3 + dy);
        g.fillStyle(clothLit, 1);
        g.fillRect(-5.2, 4.0 + dy, 10.4, 1.0);
        if (level >= 3) {
            g.fillStyle(gold, 1); // gold points on the valance tips
            g.fillRect(-3.3 + swayD, 7.2 + dy, 1.4, 1.2);
            g.fillRect(1.9 + swayD, 7.2 + dy, 1.4, 1.2);
        }
    }

    // ---------------- arms + mallets (over the drum) ----------------
    for (const [s, k, f] of [[-1, kL, fL], [1, kR, fR]] as const) {
        // Stroke arc: raised = mallet held HIGH above the shoulder, strike =
        // head sweeping down-inward onto the skin (never resting beside the
        // face — the pom-pom-ears bug of the first pass).
        const handX = s * (7.0 + 0.5 * k);
        const handY = -4.6 - 6.9 * k + dy;
        const headX = handX + s * (-3.5 + 3.1 * k);
        const headY = handY + 2.4 - 7.6 * k;
        limb(g, s * 5.6, -5.4 + dy, handX, handY, 2.4, s < 0 ? clothLit : clothDark); // sleeve
        limb(g, handX, handY, headX, headY, 1.6, shade(0x6e4f2f, mul)); // mallet shaft
        g.fillStyle(skin, 1);
        g.fillCircle(handX, handY, 1.4);
        g.fillStyle(shade(0x8a4a2e, mul), 1); // leather-bound mallet head
        g.fillCircle(headX, headY, 1.8);
        g.fillStyle(shade(0x5e2f1c, mul), 1);
        g.fillEllipse(headX + 0.5, headY + 0.6, 1.8, 1.3);
        g.fillStyle(shade(0xe8dcc0, mul), 1); // cream binding band
        g.fillRect(headX - 1.3, headY - 0.5, 2.6, 0.9);
        soundTicks(g, s, f, tickCol);
    }
}
