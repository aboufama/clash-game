import type Phaser from 'phaser';

/**
 * CLOCKWORK BEETLE — design C: the da Vinci wind-up scarab.
 *
 * A low, domed wood-and-brass beetle the size of a fist: six ticking iron
 * legs on a strict tripod gait, a big two-lobed butterfly key spinning on its
 * back as the spring unwinds, and a glowing seam down the middle of the shell
 * — the bomb inside always shows as a faint ember line, so even one beetle in
 * a swarm reads as "that one explodes".
 *
 * Detonation telegraph (the brief demands it): in the last 240 ms before the
 * damage tick the legs PLANT and splay, the body crouches, the two shell
 * halves crack apart over the core, the key spins frantically and the seam
 * blinks up from ember to white-hot. Post-tick (ages 1/40 ms) the halves are
 * blown open around a compact white flash core — the frame MainScene's real
 * explosion grows out of.
 *
 * Authored periods (the bake uses these — TROOP_PARAMS clockworkbeetle):
 *   stride 240 ms  — leg tripod + body bob close exactly on 240; the key
 *                    makes one full turn per 480 ms but is 2-fold symmetric,
 *                    so its POSE also loops on 240. Mandible chitter 120 ms.
 *   windup 240 ms  — plant + crack-open + blink telegraph before the tick.
 *   strike   0 ms  — suicide unit: no strike sweep, only the burst frames.
 *   idle  2000 ms  — breath (2000), seam/eye ember pulse (1000), key ratchet
 *                    half-turn (2000) with a 250 ms tick wobble — all exact
 *                    harmonics of a 250 ms-multiple period (iron rule 3).
 *
 * Palette: L1 walnut + copper, L2 bronze + iron studs, L3 polished brass with
 * GOLD key/band as subtle accents (never white masses). Enemy palette darkens
 * the metals and swaps the elytra accent stripes teal → crimson.
 *
 * Facing: `facingAngle` is a screen-space heading; the whole body is built in
 * a facing-local (d = along, w = across) frame projected with the 0.5 iso
 * squash, so all 8 baked headings foreshorten correctly. Far-side legs and
 * the far key lobe draw before the shell, near-side legs after it; the head
 * assembly draws behind the dome when the beetle points up-screen (sin < 0).
 */

type G = Phaser.GameObjects.Graphics;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shadeC(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): stride/
 *  delay/windup/strike/dirs all match the TROOP_PARAMS row (240/500/240/0/8),
 *  but the idle loop closes on 2000 ms (breath 2000, ember 1000, ratchet
 *  half-turn 2000, tick wobble 250) — not the default 4021 ms breath window. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    clockworkbeetle: { idleMs: 2000 },
};

export function drawClockworkbeetleC(
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
    const lvl = Math.max(1, Math.min(3, Math.floor(troopLevel || 1)));

    // ============================ palette ============================
    // L1 walnut + copper → L2 bronze + iron → L3 polished brass + gold.
    let shellMid: number, shellHi: number, shellLo: number, band: number, keyMetal: number;
    let studs: number | null = null;
    if (lvl === 1) {
        shellMid = 0x7a5a2e; shellHi = 0x96713a; shellLo = 0x52401f;
        band = 0xa5622c; keyMetal = 0x878d96;
    } else if (lvl === 2) {
        shellMid = 0x8f6c2e; shellHi = 0xac8840; shellLo = 0x5c451c;
        band = 0x767d88; keyMetal = 0xc09a3e; studs = 0x6e747e;
    } else {
        shellMid = 0xa07c34; shellHi = 0xc29c48; shellLo = 0x644c1e;
        band = 0xd9a520; keyMetal = 0xe0b52f; studs = 0xd9a520;
    }
    const own = isPlayer ? 1 : 0.78;
    shellMid = shadeC(shellMid, own); shellHi = shadeC(shellHi, own);
    shellLo = shadeC(shellLo, own); band = shadeC(band, own);
    keyMetal = shadeC(keyMetal, own);
    if (studs !== null) studs = shadeC(studs, own);
    const accent = isPlayer ? 0x2f9184 : 0xb23530; // elytra stripes: owner tell
    const legCol = shadeC(0x584e3e, own);
    const legDark = shadeC(0x342d22, own);
    const EMBER = 0xff8c30, EMBER_HI = 0xffd27a;

    // ========================= attack state =========================
    // Locked to the damage tick: windup ramps over the last 240 ms before the
    // tick; burst covers ages 0..90 ms just after it (the detonation frame).
    // Gated on !isMoving: a marching beetle NEVER telegraphs (spawn seeds
    // lastAttackTime at age=delay, which would otherwise read remaining<=0 →
    // full crack-open crouch on the walk off the deploy point); the real
    // detonation always happens stationary, adjacent to the target.
    const WINDUP = 240;
    let windup = 0, burst = 0, ageMs = 1e9;
    if (attackAge >= 0 && attackDelay > 0 && !isMoving) {
        let age = attackAge;
        if (age > attackDelay + 600) age = time % attackDelay; // stale tick: free-run
        ageMs = age;
        const remaining = attackDelay - age;
        if (remaining <= 0) windup = 1;
        else if (remaining <= WINDUP) windup = 1 - remaining / WINDUP;
        if (windup === 0 && age <= 90) burst = 1 - age / 90;
    }

    // ============================ rigs ============================
    const STRIDE = 240;
    const wph = (time % STRIDE) / STRIDE;                    // walk phase 0..1
    const iph = (time % 2000) / 2000;                        // idle phase 0..1
    const breath = Math.sin(iph * Math.PI * 2);              // 2000 ms
    const ember01 = 0.5 + 0.5 * Math.sin(iph * Math.PI * 4); // 1000 ms pulse
    const walking = isMoving && windup <= 0 && burst <= 0;
    const bob = walking ? Math.abs(Math.sin(wph * Math.PI * 2)) * 0.6 : 0;
    const crouch = windup * 1.4 + burst * 0.6;
    const hBody = (walking ? bob : Math.max(0, breath) * 0.45) - crouch;

    // ====================== facing-local frame ======================
    const ca = Math.cos(facingAngle), sa = Math.sin(facingAngle);
    const G0 = 8.8; // ground line (feet), matches the villager-scale rows
    const PX = (d: number, w: number): number => ca * d - sa * w;
    const PY = (d: number, w: number, h: number): number => G0 + (sa * d + ca * w) * 0.5 - h;

    const poly = (pts: Array<[number, number, number]>, color: number, alpha: number, ox: number = 0, oy: number = 0): void => {
        g.fillStyle(color, alpha);
        g.beginPath();
        g.moveTo(PX(pts[0][0], pts[0][1]) + ox, PY(pts[0][0], pts[0][1], pts[0][2]) + oy);
        for (let i = 1; i < pts.length; i++) g.lineTo(PX(pts[i][0], pts[i][1]) + ox, PY(pts[i][0], pts[i][1], pts[i][2]) + oy);
        g.closePath();
        g.fillPath();
    };
    /** Thick screen-space segment (the limb grammar). */
    const limb = (x0: number, y0: number, x1: number, y1: number, w: number, color: number, alpha: number = 1): void => {
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
    };

    // Shell rim outline in the facing frame (front = +d, slightly tapered).
    const RIM: Array<[number, number]> = [
        [7, 0], [5, 3.6], [1.5, 4.8], [-3, 4.6], [-6, 3],
        [-7.2, 0], [-6, -3], [-3, -4.6], [1.5, -4.8], [5, -3.6]
    ];

    // ====================== contact shadow ======================
    // ONE closed polygon at uniform alpha (art guide §8) — never stacked.
    poly(RIM.map(([d, w]) => [d * 1.08, w * 1.22, -0.35] as [number, number, number]), 0x000000, 0.2);

    // ============================ legs ============================
    // 3 per side; tripod gait: side +1 slots 0/2 + side −1 slot 1 in phase A,
    // the rest half a stride behind. Windup/burst: plant + splay outward.
    const drawLeg = (slotD: number, s: number, k: number): void => {
        let footD = slotD, footW = s * 6.6, lift = 0;
        if (burst > 0) {
            footD = slotD * 1.12; footW = s * (6.6 + 2.2 * burst);
        } else if (windup > 0) {
            footD = slotD * 1.08; footW = s * (6.6 + 1.6 * windup);
        } else if (walking) {
            const grp = ((k + (s > 0 ? 0 : 1)) % 2) * 0.5;
            const lph = (wph + grp) % 1;
            footD = slotD + Math.cos(lph * Math.PI * 2) * 2.2;
            lift = Math.max(0, Math.sin(lph * Math.PI * 2)) * 1.7;
        }
        const hipX = PX(slotD * 0.85, s * 4.2), hipY = PY(slotD * 0.85, s * 4.2, 3.0 + Math.max(0, hBody));
        const kneeX = PX((slotD * 0.9 + footD) / 2, s * 7.1);
        const kneeY = PY((slotD * 0.9 + footD) / 2, s * 7.1, 3.6 + Math.max(0, hBody) * 0.6 + lift * 0.6);
        const footX = PX(footD, footW), footY = PY(footD, footW, lift);
        limb(hipX, hipY, kneeX, kneeY, 1.25, legCol);
        limb(kneeX, kneeY, footX, footY, 1.0, legCol);
        g.fillStyle(legDark, 1);
        g.fillCircle(footX, footY, 0.65);
        g.fillCircle(kneeX, kneeY, 0.55); // knee rivet — reads "machine"
    };
    const LEG_D = [4.2, 0, -4.2];
    // Far side first (the side whose across-offset projects up-screen);
    // the near side draws AFTER the shell so its legs come out from under it.
    const farSide = ca >= 0 ? -1 : 1;
    for (let k = 0; k < 3; k++) drawLeg(LEG_D[k], farSide, k);

    // ====================== head assembly (far?) ======================
    // Head plate + eyes + mandibles sit past the front rim; when the beetle
    // points up-screen the dome occludes them, so draw them first then.
    const chitter = walking ? 0.22 * Math.sin(((time % 120) / 120) * Math.PI * 2) : 0.05 * breath;
    const mandOpen = clamp01(0.3 + chitter + windup * 0.55 + burst * 0.6);
    const blink = 0.5 + 0.5 * Math.sin(ageMs * (Math.PI * 2) / 125);
    const drawHead = (): void => {
        poly([[7.8, 0, 3.0 + hBody], [6.2, 2.1, 3.1 + hBody], [4.8, 0, 3.3 + hBody], [6.2, -2.1, 3.1 + hBody]], band, 1);
        for (const s of [-1, 1]) {
            limb(PX(7.0, s * 0.9), PY(7.0, s * 0.9, 2.4 + hBody),
                PX(8.4, s * (0.9 + 2.0 * mandOpen)), PY(8.4, s * (0.9 + 2.0 * mandOpen), 2.1 + hBody),
                0.85, shadeC(band, 0.72));
        }
        // Ember eyes — soft idle pulse, hard red blink in the windup.
        const eyeCol = windup > 0 || burst > 0 ? 0xff5040 : 0xffb050;
        const eyeA = burst > 0 ? 1 : windup > 0 ? 0.45 + 0.55 * blink : 0.55 + 0.35 * ember01;
        for (const s of [-1, 1]) {
            const ex = PX(6.4, s * 1.5), ey = PY(6.4, s * 1.5, 3.8 + hBody);
            g.fillStyle(legDark, 1);
            g.fillCircle(ex, ey, 0.95);
            g.fillStyle(eyeCol, eyeA);
            g.fillCircle(ex, ey, 0.68);
        }
    };
    const headFar = sa < -0.05; // pointing up-screen → head behind the dome
    if (headFar) drawHead();

    // ======================= under-body belly =======================
    poly(RIM.map(([d, w]) => [d * 0.9, w * 0.86, 1.5 + hBody] as [number, number, number]), shadeC(shellLo, 0.62), 1);

    // ==================== shell halves + core gap ====================
    // The elytra split along d; windup/burst shift the halves ±open across.
    const open = burst > 0 ? 1.2 + 1.0 * burst : windup * 1.2;
    const HALF: Array<[number, number]> = [[7, 0.18], [5, 3.6], [1.5, 4.8], [-3, 4.6], [-6, 3], [-7.2, 0.18]];
    const NWX = -0.35, NWY = -0.22; // fixed NW-light nudge for raised layers
    const drawHalf = (s: number): void => {
        const sh = s * open;
        // dome side wall
        poly(HALF.map(([d, w]) => [d, s * w + sh, 2.7 + hBody] as [number, number, number]), shellMid, 1);
        // raised mid plate (NW light: nudged in screen space)
        poly(HALF.map(([d, w]) => [d * 0.78, s * w * 0.74 + sh, 4.6 + hBody] as [number, number, number]), shellHi, 1, NWX, NWY);
        // dome cap
        poly(HALF.map(([d, w]) => [d * 0.5, s * w * 0.44 + sh, 5.8 + hBody] as [number, number, number]), shadeC(shellHi, 1.13), 1, NWX * 1.6, NWY * 1.6);
        // owner accent stripe along the elytron
        limb(PX(-4.4, s * 2.5 + sh) + NWX, PY(-4.4, s * 2.5 + sh, 4.7 + hBody) + NWY,
            PX(3.2, s * 2.3 + sh) + NWX, PY(3.2, s * 2.3 + sh, 4.8 + hBody) + NWY,
            0.9, accent, 0.92);
        // rim studs (L2 iron, L3 gold) — riveted machine read
        if (studs !== null) {
            g.fillStyle(studs, 1);
            for (const [d, w] of [[4.6, 3.3], [-0.6, 4.35], [-5.2, 2.8]] as Array<[number, number]>) {
                g.fillCircle(PX(d, s * w + sh), PY(d, s * w + sh, 3.1 + hBody), 0.48);
            }
        }
    };
    const farHalf = ca >= 0 ? -1 : 1;
    drawHalf(farHalf);
    drawHalf(-farHalf);

    // Near-side legs come out from under the near rim.
    for (let k = 0; k < 3; k++) drawLeg(LEG_D[k], -farSide, k);

    // Exposed core between the cracked halves (on top — no occlusion games).
    if (open > 0.08) {
        const ow = Math.min(open, 1.6) * 0.95;
        poly([
            [5.6, 0, 3.5 + hBody], [2, ow, 3.5 + hBody], [-3, ow, 3.5 + hBody],
            [-5.4, 0, 3.5 + hBody], [-3, -ow, 3.5 + hBody], [2, -ow, 3.5 + hBody]
        ], burst > 0 ? 0xffc46a : 0xe25b18, 0.95);
        if (burst > 0) {
            // Flash: ember ring UNDER a white-hot core (order matters — the
            // scene's real explosion takes over from this frame).
            g.fillStyle(EMBER, 0.4 * burst);
            g.fillCircle(PX(0, 0), PY(0, 0, 3.8 + hBody), 3.4 + 2.0 * burst);
            g.fillStyle(0xfff6d8, 0.95 * burst);
            g.fillCircle(PX(0, 0), PY(0, 0, 3.8 + hBody), 1.9 + 1.5 * burst);
        }
    }

    // Seam — the bomb tell. Dark groove + ember glow: faint pulse at idle,
    // blinking bright through the windup, washed out in the burst.
    if (burst <= 0) {
        limb(PX(6, 0), PY(6, 0, 5.0 + hBody), PX(-5.6, 0), PY(-5.6, 0, 4.6 + hBody), 1.0, shadeC(shellLo, 0.5));
        const glowA = windup > 0 ? 0.45 + 0.55 * blink : 0.2 + 0.18 * ember01;
        limb(PX(5.6, 0), PY(5.6, 0, 5.05 + hBody), PX(-5.2, 0), PY(-5.2, 0, 4.65 + hBody), 0.55, windup > 0.55 ? EMBER_HI : EMBER, glowA);
    }

    // Dome sheen (NW light) — fades as the shell opens.
    g.fillStyle(shadeC(shellHi, 1.22), 0.42 * Math.max(0, 1 - open * 0.5));
    g.fillEllipse(PX(0.8, 0) - 1.5, PY(0.8, 0, 6.0 + hBody) - 0.3, 3.4, 1.6);

    // ========================= wind-up key =========================
    // Butterfly key on the rear dome. Walking: one turn per 480 ms (2-fold
    // symmetric → pose loops on the 240 ms stride). Idle: slow half-turn
    // ratchet over 2000 ms with a 250 ms tick wobble. Windup/burst: frantic
    // 120 ms spin as the spring lets go.
    const KD = -2.6; // key post position (rear of the dome)
    let theta: number;
    if (windup > 0 || burst > 0) theta = ((time % 120) / 120) * Math.PI * 2;
    else if (walking) theta = ((time % 480) / 480) * Math.PI * 2;
    else theta = ((time % 2000) / 2000) * Math.PI + 0.09 * Math.sin(((time % 250) / 250) * Math.PI * 2);
    const keyBaseH = 5.7 + hBody, keyTopH = 8.4 + hBody - windup * 0.4;
    const shaftX = PX(KD, 0), shaftTopY = PY(KD, 0, keyTopH), shaftBaseY = PY(KD, 0, keyBaseH);
    const R = 3.0;
    const lobe = (sign: number): void => {
        const ld = Math.cos(theta) * R * sign, lw = Math.sin(theta) * R * sign;
        const ex = PX(KD + ld, lw), ey = PY(KD + ld, lw, keyTopH);
        limb(shaftX, shaftTopY, ex, ey, 0.95, keyMetal);
        g.fillStyle(keyMetal, 1);
        g.fillCircle(ex, ey, 1.3);             // key bow
        g.fillStyle(shadeC(keyMetal, 0.42), 1);
        g.fillCircle(ex, ey, 0.55);            // bow hole
    };
    // Far lobe (projects up-screen) first, then shaft, then near lobe.
    const lobeScreenY = (sa * Math.cos(theta) + ca * Math.sin(theta)) * 0.5;
    const nearSign = lobeScreenY >= 0 ? 1 : -1;
    lobe(-nearSign);
    limb(shaftX, shaftBaseY, shaftX, shaftTopY, 1.05, keyMetal);
    g.fillStyle(shadeC(keyMetal, 0.7), 1);
    g.fillCircle(shaftX, shaftBaseY, 0.95);    // collar where the key seats
    lobe(nearSign);

    // ====================== head assembly (near) ======================
    if (!headFar) drawHead();
}
