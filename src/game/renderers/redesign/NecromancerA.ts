import type Phaser from 'phaser';

/**
 * NECROMANCER + SKELETON — clean-room design A: "THE TATTERED CATHEDRAL".
 *
 * Necromancer: a tall, gaunt silhouette that never touches the ground — a
 * bell of deep-purple robe (0x6a4c93) flaring to a tattered, swaying hem
 * with a void of darkness beneath it; a high hood peak leaning toward the
 * heading; a pale rib-slat stole across the chest; a femur staff crowned
 * with a horned ram skull. The ONLY light he owns is grave-green: eyes in
 * the hooded void, ember pits in the staff skull, and 1–3 orbiting
 * grave-light wisps. Rust ties him to his summon.
 *
 * Skeleton: a romanwarrior-scale servant in the same vocabulary — bone
 * 0xd8d8c8, grave-green eye pinpricks + a green soul-gleam on the sternum,
 * a notched RUSTY blade (L2+: rust pauldron + battered scrap shield,
 * L3: rusted half-helm with a single gold rivet).
 *
 * Levels are MATERIAL progression: L1 humble (bare robe / bare bones),
 * L2 pale bone trim + iron + rust scraps, L3 refined (parchment trim,
 * thin gold circlet / collar / gilded horn tips / one gold rivet — accents
 * only, never masses).
 *
 * MOTION CONTRACT (all deterministic f(time)):
 *  - Necromancer walk = ONE exact 480 ms glide-step: smooth 1-cycle float
 *    bob, hem trailing the heading + swaying, staff tip planting once per
 *    stride. Idle = ONE exact 2000 ms period: wisp orbit (harmonic 1),
 *    float breath (h1), ember/eye colour pulse (h2), hem flutter (h2).
 *  - Skeleton walk = ONE exact 300 ms rattle-march (scissor h1, judder h2,
 *    skull rattle h3). Idle = ONE exact 1000 ms period: sway h1, jaw drop
 *    h1 (1.5 px), rattle h2, ember pulse h2.
 *  - Attacks key off attackAge per the TroopRenderer contract (windup
 *    peaks ON the damage tick). Necromancer: 700 ms windup gathers a dark
 *    orb over the staff skull, 400 ms strike flings it along facingAngle
 *    (the engine draws no projectile — the bolt is painted here, readable
 *    at the strike). The summon flourish reuses this same silhouette.
 *    Skeleton: 260 ms windup coils the rusty blade, 150 ms slash.
 *  - NO translucent body paint: every glow is an opaque inner-light shape
 *    (colour-pulsed via mixA), so the bake's alpha snap keeps all of it.
 */

type G = Phaser.GameObjects.Graphics;

// ---------- pure helpers (hoisted, zero module-level side effects) ----------

function clamp01A(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function easeOutA(t: number): number { return 1 - (1 - t) * (1 - t); }

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shadeA(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Linear blend a→b by t (0..1) — the opaque-glow pulse primitive. */
function mixA(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
    const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
}

/** One limb segment drawn as a thick quad from (x0,y0) to (x1,y1). */
function limbA(g: G, color: number, x0: number, y0: number, x1: number, y1: number, w: number): void {
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

/** Attack-cycle state — the exact TroopRenderer contract (windup peaks on
 *  the damage tick; stale replay ages free-run on time % delay). */
interface AtkA { windup: number; strike: number; age: number; inCombat: boolean }
function atkA(time: number, attackAge: number, attackDelay: number, windupMs: number, strikeMs: number): AtkA {
    if (attackAge < 0 || attackDelay <= 0) return { windup: 0, strike: 0, age: Infinity, inCombat: false };
    let age = attackAge;
    if (age > attackDelay + 600) age = time % attackDelay;
    const remaining = attackDelay - age;
    let windup = 0;
    if (remaining <= 0) windup = 1;
    else if (remaining <= windupMs) windup = 1 - remaining / windupMs;
    const strike = strikeMs > 0 && age <= strikeMs ? 1 - age / strikeMs : 0;
    return { windup, strike, age, inCombat: true };
}

/** One grave-light wisp: opaque teardrop of layered greens, core pulsed by
 *  colour (never alpha — the bake's alpha snap would erase it). */
function wispA(g: G, x: number, y: number, s: number, pulse: number): void {
    g.fillStyle(0x2e7d4f, 1);
    g.fillEllipse(x, y, 3.0 * s, 3.4 * s);
    g.fillStyle(0x5fd98a, 1);
    g.fillTriangle(x - 1.05 * s, y - 0.4 * s, x + 1.05 * s, y - 0.4 * s, x, y - 2.7 * s);
    g.fillEllipse(x, y, 2.0 * s, 2.4 * s);
    g.fillStyle(mixA(0x5fd98a, 0xd6ffe6, pulse), 1);
    g.fillCircle(x, y - 0.2 * s, 0.8 * s);
}

// ============================ NECROMANCER ============================

export function drawNecromancerA(
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
    const STRIDE = 480;  // glide-step period — bake TROOP_PARAMS.stride
    const IDLE = 2000;   // declared idle period (exact 250 ms multiple)

    const fa = facingAngle || 0;
    const hdgX = Math.cos(fa);          // heading, screen x
    const hdgY = Math.sin(fa);          // heading, screen y (× 0.5 iso squash)
    const sideX = hdgX >= 0 ? 1 : -1;   // staff-hand mirror

    // ---- palette (owner via isPlayer; grave-green is the unit identity)
    const robe = isPlayer ? 0x6a4c93 : 0x7d3b52;
    const robeDark = shadeA(robe, 0.6);
    const robeLit = shadeA(robe, 1.3);
    const trim = troopLevel >= 3 ? 0xdcd3ba : (isPlayer ? 0xcfc6b8 : 0xb5a894);
    const bone = 0xd8d8c8;
    const boneDark = shadeA(bone, 0.72);
    const voidC = 0x120b18;
    const gDeep = 0x2e7d4f, gMid = 0x5fd98a, gBright = 0x9cffc0;
    const gold = 0xdaa520;

    // ---- rig: glide-step (480 ms) or float breath (2000 ms)
    let glide = 0, lift = 1.8, hemSway = 0, tatFlut = 0, plant = 0, breathe = 0, pulse = 0.5;
    if (isMoving) {
        const ph = (time % STRIDE) / STRIDE;
        const s1 = Math.sin(ph * Math.PI * 2);
        glide = s1;
        lift = 2.1 + s1 * 0.7;                        // smooth float bob, h1
        hemSway = s1 * 1.5;
        tatFlut = Math.sin(ph * Math.PI * 4) * 0.9;   // h2 rag flutter
        plant = Math.max(0, -s1);                     // staff taps once/stride
        pulse = 0.5 + s1 * 0.5;
    } else {
        const iph = (time % IDLE) / IDLE;
        breathe = Math.sin(iph * Math.PI * 2);        // h1
        lift = 1.8 + breathe * 0.9;                   // ±0.9 px float (≥1.5 p-p)
        hemSway = breathe * 0.8;
        tatFlut = Math.sin(iph * Math.PI * 4) * 0.6;  // h2
        pulse = 0.5 + Math.sin(iph * Math.PI * 4) * 0.5; // h2 ember pulse
    }

    const atk = atkA(time, attackAge, attackDelay || 1600, 700, 400);
    const wu = (!isMoving && atk.inCombat) ? atk.windup : 0;
    const st = (!isMoving && atk.inCombat) ? atk.strike : 0;
    pulse = Math.max(pulse, wu);                      // eyes flare with the charge
    const lean = (st * 1.6 - wu * 0.8) * hdgX;        // rock back, then into the throw

    // ---- wisp positions (computed first: far ones draw behind the robe)
    const wisps: Array<{ x: number; y: number; s: number; far: boolean }> = [];
    const nW = Math.max(1, Math.min(3, troopLevel));
    for (let i = 0; i < nW; i++) {
        if (isMoving) {
            const ph = (time % STRIDE) / STRIDE;
            const bob = Math.sin(ph * Math.PI * 4 + i * 2.1) * 1.0;   // h2
            const d = 5.5 + i * 2.6;
            wisps.push({
                x: -hdgX * d + Math.cos(i * 2.4) * 1.5,
                y: -3.5 - lift + i * 1.4 - hdgY * 0.5 * d + bob,
                s: 1 - i * 0.16,
                far: false
            });
        } else {
            const a = ((time % IDLE) / IDLE) * Math.PI * 2 + (i * Math.PI * 2) / nW;
            wisps.push({
                x: Math.cos(a) * 8,
                y: -3.2 - lift + Math.sin(a) * 3.4,
                s: 1 - i * 0.12,
                far: Math.sin(a) < -0.15
            });
        }
    }

    // 1 ---- detached contact shadow (he floats; shrinks as he rises)
    g.fillStyle(0x000000, 0.2);
    g.fillEllipse(0, 9.6, 11.5 - lift * 0.9, 4.4 - lift * 0.35);

    // far wisps occlude correctly behind the body
    for (const w of wisps) if (w.far) wispA(g, w.x, w.y, w.s, pulse);

    // 2 ---- the void beneath the hem — sells the float
    g.fillStyle(0x160d20, 1);
    g.fillEllipse(hemSway * 0.4, 8.1, 6.6 - lift * 0.5, 2.1);

    // 3 ---- robe bell (NW light: lit sliver left, dark panel right)
    const yHem = 6.4 - lift;
    const hemOx = (isMoving ? -hdgX * 1.4 : 0) + hemSway;   // hem trails the heading
    g.fillStyle(robe, 1);
    g.beginPath();
    g.moveTo(-3.4 + lean * 0.4, -4.6 - lift);
    g.lineTo(3.4 + lean * 0.4, -4.6 - lift);
    g.lineTo(6.3 + hemOx * 0.7, yHem);
    g.lineTo(-6.3 + hemOx * 0.7, yHem);
    g.closePath();
    g.fillPath();
    g.fillStyle(robeDark, 1);
    g.beginPath();
    g.moveTo(0.6 + lean * 0.4, -4.6 - lift);
    g.lineTo(3.4 + lean * 0.4, -4.6 - lift);
    g.lineTo(6.3 + hemOx * 0.7, yHem);
    g.lineTo(1.4 + hemOx * 0.7, yHem);
    g.closePath();
    g.fillPath();
    g.fillStyle(robeLit, 1);
    g.beginPath();
    g.moveTo(-3.4 + lean * 0.4, -4.6 - lift);
    g.lineTo(-2.1 + lean * 0.4, -4.6 - lift);
    g.lineTo(-4.6 + hemOx * 0.7, yHem);
    g.lineTo(-6.3 + hemOx * 0.7, yHem);
    g.closePath();
    g.fillPath();

    // 4 ---- tattered hem: five swaying rags
    for (let i = 0; i < 5; i++) {
        const bx = -5.2 + i * 2.6 + hemOx * 0.7;
        const sway = tatFlut * (i % 2 === 0 ? 1 : -0.7) + hemOx * 0.45;
        g.fillStyle(i % 2 === 0 ? robeDark : robe, 1);
        g.fillTriangle(bx - 1.2, yHem - 0.2, bx + 1.2, yHem - 0.2, bx + sway, yHem + 2.3);
    }
    if (troopLevel >= 2) {          // pale bone-trim hem band
        g.lineStyle(1, trim, 1);
        g.lineBetween(-6.1 + hemOx * 0.7, yHem - 0.5, 6.1 + hemOx * 0.7, yHem - 0.5);
    }
    if (troopLevel >= 3) {          // gold stitch — a thread, not a mass
        g.lineStyle(0.7, gold, 0.95);
        g.lineBetween(-5.6 + hemOx * 0.7, yHem - 1.6, 5.6 + hemOx * 0.7, yHem - 1.6);
    }

    // 5 ---- chest + rib-slat stole + rope belt
    g.fillStyle(robe, 1);
    g.fillCircle(lean * 0.5, -5.4 - lift, 3.2);
    g.fillStyle(robeLit, 1);
    g.fillEllipse(-1.1 + lean * 0.5, -6.6 - lift, 2.6, 1.7);
    if (troopLevel >= 2) {          // the ribcage stole — bone slats
        g.fillStyle(trim, 1);
        g.fillRect(-2.7 + lean * 0.5, -7.0 - lift, 5.4, 0.95);
        g.fillRect(-2.3 + lean * 0.5, -5.4 - lift, 4.6, 0.95);
        g.fillRect(-1.9 + lean * 0.5, -3.8 - lift, 3.8, 0.95);
    }
    g.fillStyle(0x7a6a4c, 1);       // rope belt
    g.fillRect(-2.7 + lean * 0.4, -2.2 - lift, 5.4, 1.2);
    if (troopLevel >= 2) {          // bone toggle charm
        g.fillStyle(bone, 1);
        g.fillCircle(1.6 + lean * 0.4, -1.4 - lift, 0.8);
    }
    if (troopLevel >= 3) {          // small gold buckle plate
        g.fillStyle(gold, 1);
        g.fillRect(-0.6 + lean * 0.4, -2.1 - lift, 1.2, 1.0);
    }

    // 6 ---- free arm (off the staff side): hangs, gathers on windup, flings
    const oS = -sideX;
    let fhx = oS * 4.3 + lean * 0.4, fhy = -1.2 - lift;
    if (wu > 0) { fhx = oS * (4.2 - wu * 0.6); fhy = -1.2 - lift - 4.6 * wu; }
    if (st > 0) { fhx = hdgX * 5.4; fhy = -4.5 - lift + hdgY * 2; }
    limbA(g, robe, oS * 2.6 + lean * 0.5, -5.2 - lift, fhx, fhy, 2.3);
    g.fillStyle(robeLit, 1);        // lit cuff
    g.fillCircle(fhx, fhy, 1.0);
    g.fillStyle(bone, 1);           // gaunt bone-pale hand
    g.fillCircle(fhx + (st > 0 ? hdgX * 0.8 : 0), fhy + 0.7, 0.8);
    if (wu > 0.3) {                 // soul-light gathers in the open palm
        g.fillStyle(mixA(gDeep, gBright, wu), 1);
        g.fillCircle(fhx, fhy - 0.6, 1.0);
    }

    // 7 ---- hooded head: shadow void + grave-green eyes + leaning peak
    const hdX = lean * 0.7;
    g.fillStyle(robeDark, 1);
    g.fillEllipse(hdX, -9.3 - lift, 8.2, 6.4);
    g.fillStyle(voidC, 1);
    g.fillCircle(hdX + hdgX * 0.7, -9.4 - lift, 2.45);
    const eye = mixA(gDeep, gBright, clamp01A(pulse));
    g.fillStyle(eye, 1);
    g.fillEllipse(hdX + hdgX * 0.7 - 1.0, -9.7 - lift, 1.15, 1.4);
    g.fillEllipse(hdX + hdgX * 0.7 + 1.0, -9.7 - lift, 1.15, 1.4);
    if (troopLevel >= 2) {          // pale trim framing the hood opening
        g.lineStyle(0.9, trim, 1);
        g.beginPath();
        g.arc(hdX + hdgX * 0.7, -9.2 - lift, 2.95, Math.PI * 0.15, Math.PI * 0.85, false);
        g.strokePath();
    }
    const peak = hdX + hdgX * 1.7 + (isMoving ? glide * 0.5 : breathe * 0.5);
    g.fillStyle(robe, 1);
    g.fillTriangle(hdX - 3.7, -10.6 - lift, hdX + 3.7, -10.6 - lift, peak, -17.6 - lift);
    g.fillStyle(robeDark, 1);
    g.fillTriangle(hdX + 0.5, -10.6 - lift, hdX + 3.7, -10.6 - lift, peak + 0.4, -16.4 - lift);
    g.fillStyle(robeLit, 1);
    g.fillTriangle(hdX - 3.7, -10.6 - lift, hdX - 2.2, -10.6 - lift, peak - 0.5, -15.6 - lift);
    if (troopLevel >= 3) {          // thin gold circlet around the peak
        g.fillStyle(gold, 1);
        g.fillRect(hdX - 2.2 + (peak - hdX) * 0.3, -12.7 - lift, 4.4, 0.8);
    }

    // 8 ---- the bone staff: planted on the glide, raised for the cast.
    // Slim — the staff is a servant of the silhouette, never its master.
    const raise = wu * 3.2;
    const stfX = sideX * 5.3 + lean * 0.5 + (isMoving ? glide * 0.4 : 0) + hdgX * st * 1.4;
    const tipY = 7.2 - lift * 0.3 + plant * 2.2 - raise * 1.4;
    const topY = -12.3 - lift - raise;
    const botX = stfX - sideX * 1.0;
    limbA(g, boneDark, stfX, topY, botX, tipY, 1.5);
    limbA(g, bone, stfX - 0.25, topY, botX - 0.25, tipY, 0.8);
    g.fillStyle(bone, 1);           // one femur knuckle
    g.fillCircle(stfX + (botX - stfX) * 0.52, topY + (tipY - topY) * 0.52, 0.9);
    if (troopLevel >= 2) {          // iron ferrule near the tip
        g.fillStyle(0x4a4442, 1);
        g.fillCircle(stfX + (botX - stfX) * 0.88, topY + (tipY - topY) * 0.88, 1.05);
    }
    // staff hand + sleeve
    const grabY = -3.2 - lift - raise * 0.75;
    limbA(g, robe, sideX * 2.7 + lean * 0.5, -5.0 - lift, stfX - sideX * 0.4, grabY, 2.3);
    g.fillStyle(robeLit, 1);
    g.fillCircle(stfX - sideX * 0.4, grabY, 1.0);
    g.fillStyle(bone, 1);
    g.fillCircle(stfX - sideX * 0.1, grabY + 0.3, 0.8);

    // 9 ---- horned skull crown: tight ram crescents, ember pits pulse,
    // L3 gilds only the tip segment
    const skX = stfX, skY = topY - 1.6;
    const hornExt = troopLevel >= 3 ? 0.9 : troopLevel >= 2 ? 0.5 : 0;
    for (const dir of [-1, 1]) {
        const mx = skX + dir * 2.4, my = skY - 1.7;
        limbA(g, boneDark, skX + dir * 1.2, skY - 0.5, mx, my, 1.5);
        limbA(g, troopLevel >= 3 ? gold : bone, mx, my, skX + dir * 2.7, skY - 3.0 - hornExt, 0.9);
    }
    g.fillStyle(bone, 1);
    g.fillCircle(skX, skY, 1.9);
    g.fillStyle(boneDark, 1);
    g.fillRect(skX - 1.0, skY + 1.1, 2.0, 1.1);       // jaw block
    g.fillStyle(voidC, 1);
    g.fillRect(skX - 1.0, skY + 1.3, 2.0, 0.4);       // tooth gap
    const ember = mixA(gDeep, gBright, clamp01A(0.25 + pulse * 0.75));
    g.fillStyle(voidC, 1);
    g.fillCircle(skX - 0.7, skY - 0.25, 0.65);
    g.fillCircle(skX + 0.7, skY - 0.25, 0.65);
    g.fillStyle(ember, 1);
    g.fillCircle(skX - 0.7, skY - 0.25, 0.42);
    g.fillCircle(skX + 0.7, skY - 0.25, 0.42);
    if (troopLevel >= 3) {          // gold collar under the skull
        g.fillStyle(gold, 1);
        g.fillRect(skX - 1.3, skY + 2.3, 2.6, 0.9);
    }

    // 10 ---- the cast: dark orb gathers on the windup, flings on the tick
    if (wu > 0.04) {
        const obX = skX + hdgX * (1.6 + wu * 1.2);
        const obY = skY - 3.2 - wu * 2.4 + hdgY * 0.7;
        const r = 0.9 + 2.5 * wu;
        g.fillStyle(0x241233, 1);
        g.fillCircle(obX, obY, r);
        g.fillStyle(gDeep, 1);
        g.fillCircle(obX, obY, r * 0.66);
        g.fillStyle(gBright, 1);
        g.fillCircle(obX - r * 0.2, obY - r * 0.2, r * 0.34);
        for (let i = 0; i < 3; i++) {   // soul motes spiral in (combat keyframes)
            const ma = time / 120 + i * 2.094;
            const mr = (1 - wu) * 6.5 + 2.6;
            g.fillStyle(i === 0 ? gBright : gMid, 1);
            g.fillCircle(obX + Math.cos(ma) * mr, obY + Math.sin(ma) * mr * 0.6, 0.7);
        }
    }
    if (st > 0) {
        const t = clamp01A(atk.age / 400);
        const d = easeOutA(t) * 17;
        const obX = skX + hdgX * (2.6 + d);
        const obY = skY - 4.6 + hdgY * 0.5 * d - Math.sin(t * Math.PI) * 1.6;
        const r = (1 - t * 0.4) * 2.6;
        if (atk.age < 130) {            // release flash ring — opaque, brief
            g.lineStyle(1.2, gBright, 1);
            g.strokeCircle(skX + hdgX * 2.6, skY - 4.6, 2.2 + atk.age * 0.035);
        }
        g.fillStyle(0x241233, 1);
        g.fillCircle(obX, obY, r);
        g.fillStyle(gDeep, 1);
        g.fillCircle(obX, obY, r * 0.66);
        g.fillStyle(gBright, 1);
        g.fillCircle(obX - r * 0.2, obY - r * 0.2, r * 0.36);
        g.fillStyle(gMid, 1);           // sparks trailing the bolt
        g.fillCircle(obX - hdgX * (2.2 + r), obY - hdgY * 0.5 * (2.2 + r), 0.85);
        g.fillCircle(obX - hdgX * (4.4 + r), obY - hdgY * 0.5 * (4.4 + r), 0.55);
    }

    // 11 ---- near wisps drift in front
    for (const w of wisps) if (!w.far) wispA(g, w.x, w.y, w.s, pulse);
}

// ============================= SKELETON =============================

export function drawSkeletonA(
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
    const STRIDE = 300;  // rattle-march — bake TROOP_PARAMS.stride
    const IDLE = 1000;   // declared idle period (exact 250 ms multiple)

    const fa = facingAngle || 0;
    const hdgX = Math.cos(fa);
    const sideX = hdgX >= 0 ? 1 : -1;   // blade-hand mirror

    const bone = isPlayer ? (troopLevel >= 3 ? 0xe2e2d4 : 0xd8d8c8) : 0xbcb8a7;
    const boneDk = shadeA(bone, 0.72);
    const voidC = 0x1c1222;
    const rust = 0x9b5a2f, rustDk = 0x63381c, rustLt = 0xc07a45;
    const gDeep = 0x2e7d4f, gBright = 0x9cffc0;
    const gold = 0xffd700;

    // ---- rig: 300 ms scissor-march with h2 judder + h3 skull rattle
    let swing = 0, cy = 0, jit = 0, jaw = 0, sway = 0, rattle = 0, pulse = 0.5;
    if (isMoving) {
        const ph = (time % STRIDE) / STRIDE;
        const s1 = Math.sin(ph * Math.PI * 2);
        swing = s1 * 2.4;
        cy = -Math.abs(s1) * 1.1;
        jit = Math.sin(ph * Math.PI * 4) * 0.55;
        rattle = Math.sin(ph * Math.PI * 6) * 0.5;
        jaw = Math.abs(Math.sin(ph * Math.PI * 4)) * 0.7;
        pulse = 0.5 + s1 * 0.5;
    } else {
        const iph = (time % IDLE) / IDLE;
        const s1 = Math.sin(iph * Math.PI * 2);
        sway = s1 * 1.2;                              // h1 body sway
        jaw = Math.max(0, s1) * 1.5;                  // h1 jaw drop (≥1.5 px)
        rattle = Math.sin(iph * Math.PI * 4) * 0.4;   // h2
        pulse = 0.5 + Math.sin(iph * Math.PI * 4) * 0.5; // h2 ember pulse
        cy = Math.max(0, s1) * -0.5;
    }

    const atk = atkA(time, attackAge, attackDelay || 900, 260, 150);
    const wu = (!isMoving && atk.inCombat) ? atk.windup : 0;
    const st = (!isMoving && atk.inCombat) ? atk.strike : 0;
    pulse = Math.max(pulse, wu);
    const lean = (st > 0 ? easeOutA(clamp01A(atk.age / 60)) * 1.7 : -wu * 1.2) * hdgX;

    // 1 ---- contact shadow
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(0, 9.6, 9, 3.4);

    const bx = sway + jit;

    // 2 ---- bone legs scissoring, knee knobs, bony feet, pelvis
    g.fillStyle(bone, 1);
    g.fillRect(bx - 2.4 - swing, 3.6 + cy, 1.4, 5.6 - cy);
    g.fillRect(bx + 1.0 + swing, 3.6 + cy, 1.4, 5.6 - cy);
    g.fillStyle(shadeA(bone, 0.55), 1);               // knee knobs
    g.fillCircle(bx - 1.7 - swing, 6.2 + cy * 0.5, 0.8);
    g.fillCircle(bx + 1.7 + swing, 6.2 + cy * 0.5, 0.8);
    g.fillStyle(bone, 1);
    g.fillEllipse(bx - 1.7 - swing, 9.2, 2.6, 1.3);
    g.fillEllipse(bx + 1.7 + swing, 9.2, 2.6, 1.3);
    g.fillStyle(boneDk, 1);
    g.fillRect(bx - 1.9, 2.2 + cy, 3.8, 1.5);

    // 3 ---- off arm (far side) + L2 battered scrap shield
    const oS = -sideX;
    let ox = bx + oS * 4.3, oy = 0.4 + cy;
    if (wu > 0) { ox = bx + oS * (4.3 + wu); oy = 0.4 + cy - wu * 1.6; }
    limbA(g, boneDk, bx + oS * 2.4, -3.4 + cy, ox, oy, 1.3);
    g.fillStyle(boneDk, 1);
    g.fillCircle(ox, oy, 0.8);
    if (troopLevel >= 2) {
        g.fillStyle(rustDk, 1);
        g.beginPath();
        g.moveTo(ox - 2.4, oy - 2.6); g.lineTo(ox + 2.2, oy - 2.9); g.lineTo(ox + 2.6, oy + 0.6);
        g.lineTo(ox + 0.4, oy + 3.0); g.lineTo(ox - 2.1, oy + 1.7);
        g.closePath();
        g.fillPath();
        g.fillStyle(rust, 1);
        g.beginPath();
        g.moveTo(ox - 1.7, oy - 2.0); g.lineTo(ox + 1.6, oy - 2.2); g.lineTo(ox + 1.9, oy + 0.4);
        g.lineTo(ox + 0.3, oy + 2.2); g.lineTo(ox - 1.5, oy + 1.2);
        g.closePath();
        g.fillPath();
        g.fillStyle(bone, 1);
        g.fillCircle(ox + 0.1, oy - 0.2, 0.7);        // bone boss
        g.lineStyle(0.6, rustDk, 1);
        g.lineBetween(ox - 1.2, oy + 1.6, ox + 0.6, oy - 1.4);
    }

    // 4 ---- ribcage over a dark core, spine, clavicle
    g.fillStyle(voidC, 1);
    g.fillRect(bx - 2.7, -4.6 + cy, 5.4, 5.8);
    g.fillStyle(bone, 1);
    g.fillRect(bx - 2.7, -4.9 + cy, 5.4, 0.8);        // clavicle
    g.fillRect(bx - 2.7, -4.0 + cy, 5.4, 1.0);
    g.fillRect(bx - 2.4, -2.3 + cy, 4.8, 0.95);
    g.fillRect(bx - 2.0, -0.7 + cy, 4.0, 0.9);
    g.fillRect(bx - 0.5, 0.3 + cy, 1.0, 2.1);         // spine
    // grave-green soul-gleam on the sternum — matches the summoner
    g.fillStyle(mixA(gDeep, gBright, clamp01A(pulse)), 1);
    g.fillCircle(bx, -2.9 + cy, 0.85);

    // 5 ---- L2 rusty pauldron on the blade shoulder (under the arm)
    if (troopLevel >= 2) {
        g.fillStyle(rustDk, 1);
        g.fillCircle(bx + sideX * 2.7, -3.9 + cy, 2.0);
        g.fillStyle(rust, 1);
        g.fillCircle(bx + sideX * 2.7, -4.1 + cy, 1.55);
        g.fillStyle(bone, 1);
        g.fillCircle(bx + sideX * 2.7, -4.2 + cy, 0.5);
    }

    // 6 ---- skull: sockets, pinprick eyes, nose slit, rattling jaw, L3 helm
    const skx = bx + rattle + lean, sky = -6.7 + cy;
    g.fillStyle(bone, 1);
    g.fillCircle(skx, sky, 2.7);
    g.fillStyle(boneDk, 1);
    g.fillRect(skx - 2.0, sky - 1.0, 4.0, 0.5);       // brow line
    g.fillStyle(voidC, 1);
    g.fillCircle(skx - 1.0, sky - 0.2, 0.95);
    g.fillCircle(skx + 1.0, sky - 0.2, 0.95);
    g.fillStyle(mixA(gDeep, gBright, clamp01A(pulse)), 1);
    g.fillCircle(skx - 1.0, sky - 0.2, 0.5);
    g.fillCircle(skx + 1.0, sky - 0.2, 0.5);
    g.fillStyle(voidC, 1);
    g.fillTriangle(skx - 0.4, sky + 1.0, skx + 0.4, sky + 1.0, skx, sky + 0.4);
    g.fillRect(skx - 1.4, sky + 1.4, 2.8, 0.6 + jaw); // mouth gap grows
    g.fillStyle(bone, 1);
    g.fillRect(skx - 1.5, sky + 1.9 + jaw, 3.0, 1.2); // the jaw itself
    g.fillStyle(boneDk, 1);
    g.fillRect(skx - 0.9, sky + 1.9 + jaw, 0.5, 0.5); // tooth nicks
    g.fillRect(skx + 0.4, sky + 1.9 + jaw, 0.5, 0.5);
    if (troopLevel >= 3) {          // rusted half-helm, one gold rivet
        g.fillStyle(rust, 1);
        g.beginPath();
        g.arc(skx, sky - 0.5, 2.95, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(rustDk, 1);
        g.fillRect(skx - 2.95, sky - 0.75, 5.9, 0.75);
        g.fillStyle(gold, 1);
        g.fillCircle(skx, sky - 2.6, 0.55);
    }

    // 7 ---- the rusty blade (warrior grammar, mirrored by heading)
    let swordA = -0.45;
    let arcSweep = 0, showArc = false;
    if (!isMoving && atk.inCombat) {
        if (st > 0) {
            const sweep = clamp01A(atk.age / 60);
            swordA = -1.5 + 2.9 * easeOutA(sweep);
            arcSweep = sweep;
            showArc = atk.age < 115;
        } else if (wu > 0) {
            swordA = -0.45 - 1.05 * easeOutA(wu);
        } else if (atk.age <= 400) {
            const t = clamp01A((atk.age - 150) / 250);
            swordA = 1.4 - 1.85 * easeOutA(t);
        }
    } else if (isMoving) {
        swordA = -0.45 + Math.sin(((time % STRIDE) / STRIDE) * Math.PI * 2) * 0.14;
    } else {
        swordA = -0.45 + Math.sin(((time % IDLE) / IDLE) * Math.PI * 2) * 0.12;
    }

    const shX = bx + sideX * 2.5, shY = -3.6 + cy;
    const handA = 0.45 + (swordA + 0.45) * 0.75;
    const hx1 = shX + sideX * Math.sin(handA) * 3.5;
    const hy1 = shY + Math.cos(handA) * 3.5;
    limbA(g, bone, shX, shY, hx1, hy1, 1.35);
    g.fillStyle(boneDk, 1);
    g.fillCircle((shX + hx1) / 2, (shY + hy1) / 2, 0.7);  // elbow knob

    const ux = sideX * Math.sin(swordA), uy = -Math.cos(swordA);
    const px = -uy, py = ux;
    g.fillStyle(0x3a2f26, 1);                             // grip
    g.fillRect(hx1 - ux * 1.2 - 0.7, hy1 - uy * 1.2 - 0.7, 1.4, 1.4);
    limbA(g, 0x4a4038, hx1 - px * 1.5, hy1 - py * 1.5, hx1 + px * 1.5, hy1 + py * 1.5, 1.0);
    if (troopLevel >= 3) {                                // gold pommel dot
        g.fillStyle(gold, 1);
        g.fillCircle(hx1 - ux * 1.6, hy1 - uy * 1.6, 0.6);
    }
    const bl = 7.6;
    const tipX = hx1 + ux * bl, tipY = hy1 + uy * bl;
    g.fillStyle(rust, 1);
    g.beginPath();
    g.moveTo(hx1 - px * 1.0, hy1 - py * 1.0);
    g.lineTo(tipX, tipY);
    g.lineTo(hx1 + px * 1.0, hy1 + py * 1.0);
    g.closePath();
    g.fillPath();
    g.lineStyle(0.65, rustLt, 0.9);                       // worn bright edge
    g.lineBetween(hx1 + px * 0.28, hy1 + py * 0.28, tipX, tipY);
    g.fillStyle(rustDk, 1);                               // rust-eaten notches
    for (const t of [0.42, 0.72]) {
        const nx = hx1 + ux * bl * t + px * (0.95 - t * 0.5);
        const ny = hy1 + uy * bl * t + py * (0.95 - t * 0.5);
        g.fillTriangle(nx, ny, nx - ux * 0.9, ny - uy * 0.9, nx - px * 0.9, ny - py * 0.9);
    }
    g.fillStyle(bone, 1);                                 // bone fist
    g.fillCircle(hx1, hy1, 1.15);

    // slash streak — opaque rusty arc, gone within ~115 ms of the tick
    if (showArc) {
        const sw = 2.9 * easeOutA(arcSweep);
        g.lineStyle(1.3, 0xd9a06a, 1);
        g.beginPath();
        if (sideX > 0) {
            const a0 = -1.5 - Math.PI / 2;
            g.arc(hx1, hy1, 6.0, a0, a0 + sw, false);
        } else {
            const a0 = Math.PI + 1.5 + Math.PI / 2;
            g.arc(hx1, hy1, 6.0, a0, a0 - sw, true);
        }
        g.strokePath();
    }
}
