import type Phaser from 'phaser';

/**
 * HAWK-EYE ASSASSIN — design B: "The Falconer".
 *
 * A hooded sharpshooter in a slate storm-cloak with a live hawk perched on
 * the off-shoulder. Stealth reads through the silhouette itself: a deep
 * peaked hood over a shadow-void face (one gold eye-glint), a lower-face
 * scarf, and a cloak that swallows the body — the engine's 0.55-alpha cloak
 * shimmer rides on top while untargetable. Precision reads through the
 * weapon: a long shoulder arbalest whose string cranks back through the
 * 420 ms windup while a gold sight-glint charges on the rail; the hawk
 * flares its wings to "spot" the target at full draw (the deadliest-defense
 * hunt made visible), then the string snaps forward with a muzzle spark on
 * the damage tick.
 *
 * ANIMATION CONTRACT (all deterministic in `time`):
 *  - walk stride closes exactly over 340 ms (TROOP_PARAMS stride);
 *  - idle loop closes exactly over 2000 ms (250 ms harmonic): breath,
 *    hood scan, eye-glint blink, hawk head-scan + one wing-flick window;
 *  - attack pose is a pure function of attackAge/attackDelay (windup
 *    420 ms before the tick, release recoil ~140 ms after); stale ages
 *    (> delay + 600) free-run on time % delay so replays stay alive.
 *
 * Scale: villager rule — feet at y=+9.5, hood peak (a "hat") to ~-12.5.
 * facingAngle is SCREEN-SPACE (atan2 of iso-projected deltas), so the aim
 * unit vector is used directly with no extra squash. 8 baked headings.
 */

type G = Phaser.GameObjects.Graphics;

const IDLE_MS = 2000; // exact 250 ms harmonic
const STRIDE_MS = 340; // must match TROOP_PARAMS.hawkeyeassassin.stride
const WINDUP_MS = 420; // must match TROOP_PARAMS.hawkeyeassassin.windup
const TAU = Math.PI * 2;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): stride/
 *  delay/windup/strike/dirs all match the TROOP_PARAMS row (340/1300/420/0/8),
 *  but the idle loop closes on IDLE_MS = 2000 — without this the default
 *  2π·640 ≈ 4021 ms window would NOT close the loop. Release reads via the
 *  post-tick ages (muzzle spark < 25 ms on the age-1 frame, string-settle
 *  decay on age-40), so strike stays 0. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    hawkeyeassassin: { idleMs: 2000 },
};

export function drawHawkeyeassassinB(
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
    const lvl = Math.max(1, Math.min(3, troopLevel | 0));

    // ---------------- aim frame (screen space) ----------------
    const f = Number.isFinite(facingAngle) ? facingAngle : 0;
    const ux = Math.cos(f), uy = Math.sin(f);   // along-aim
    const px = -uy, py = ux;                    // across-aim

    // ---------------- palette ----------------
    const cloak = isPlayer ? 0x3d4d5c : 0x4e3e44;      // slate blue vs slate maroon
    const cloakLt = shade(cloak, 1.22);
    const cloakDk = shade(cloak, 0.72);
    const hemDk = shade(cloak, 0.58);
    const hood = shade(cloak, 0.9);
    const hoodDk = shade(cloak, 0.62);
    const faceVoid = 0x10161c;
    const team = isPlayer ? 0x3f6fae : 0xa53f34;
    const teamLt = isPlayer ? 0x6f9fd6 : 0xc9705e;
    const leather = 0x4a3a2b;
    const leatherDk = 0x33291e;
    const boot = 0x241f1a;
    const gold = 0xdaa520;
    const goldLt = 0xffd700;
    const steel = 0x9aa4ad;
    const iron = 0x5c636b;
    const stockCol = lvl === 1 ? 0x5d4835 : lvl === 2 ? 0x473a2c : 0x6b5138;
    const railCol = lvl === 1 ? 0x565d66 : 0x848f99;
    const tipCol = lvl === 1 ? iron : lvl === 2 ? steel : gold; // gold = accent only
    const trimCol = lvl === 2 ? 0xb4bcc4 : gold;
    const hawkBody = 0x5a4936;   // warm feather brown — reads against the slate cloak
    const hawkWing = 0x382d23;
    const hawkBreast = 0xd9ccb0;

    // ---------------- motion state ----------------
    const inCombat = attackAge >= 0 && attackDelay > 0 && !isMoving;
    let age = attackAge;
    if (inCombat && age > attackDelay + 600) {
        // Replay troops never update lastAttackTime — free-run the cycle.
        age = ((time % attackDelay) + attackDelay) % attackDelay;
    }

    let draw01 = 0;      // string crank through the windup
    let fired01 = 0;     // recoil decay right after the tick
    let spark = false;   // muzzle spark on the very tick
    let spot01 = 0;      // hawk wing flare ("target spotted")
    if (inCombat) {
        const remaining = attackDelay - age;
        if (remaining >= 0 && remaining <= WINDUP_MS) {
            const t = clamp01(1 - remaining / WINDUP_MS);
            draw01 = t * t * (3 - 2 * t); // smoothstep crank
            spot01 = clamp01((t - 0.6) / 0.32);
        } else if (age >= 0 && age < 140) {
            fired01 = 1 - age / 140;
            spark = age < 25;
            spot01 = 0.55 * fired01; // wings settling after the call
        }
    }

    // Walk cycle — closes exactly over STRIDE_MS.
    const wPh = isMoving ? ((time % STRIDE_MS) / STRIDE_MS) * TAU : 0;
    const legA = Math.sin(wPh);
    const bodyBob = isMoving ? 0.8 * Math.abs(Math.cos(wPh)) : 0;

    // Idle loop — closes exactly over IDLE_MS (harmonics only).
    const idling = !isMoving && !inCombat;
    const iph = (TAU * time) / IDLE_MS;
    const breath = idling ? 0.7 * Math.sin(iph) : 0;
    const yaw = idling ? 1.1 * Math.sin(iph) : 0;                 // hood scan, across-aim
    const blinkHot = Math.sin(iph) > 0;                            // 2000 ms glint square wave
    const wingFlick = idling && Math.sin(iph) > 0.86 ? 0.7 : 0;    // one-frame preen window

    // Upper-body vertical: walk bob / idle breath lift, combat crouch drop.
    const dy = -(bodyBob + Math.max(0, breath)) + (inCombat ? 1.2 : 0);
    const lean = isMoving ? 1.0 : inCombat ? 0.8 : 0; // px along aim
    const hemSway = isMoving ? 1.0 * Math.sin(wPh) : idling ? 0.5 * Math.sin(iph) : 0;

    const GROUND = 9.5;
    const weaponBehind = uy < -0.1; // aiming up-screen: rail goes behind the body
    const hawkBehind = uy > 0.05;   // facing camera: the perch shoulder is up-screen

    // ================= paint helpers =================

    const drawHawk = () => {
        // facing the camera, the perch slides off one shoulder so the hawk
        // peeks beside the hood instead of poking wing-tips over it
        const peek = 2.6 * clamp01((uy - 0.05) / 0.6);
        const hx = -ux * 4.2 + px * (yaw * 0.6 + peek);
        const hy = -5.2 + dy - uy * 1.0;
        const squash = isMoving ? 0.88 : 1;
        const raise = Math.max(spot01, wingFlick);
        // tail wedge (points away from the aim)
        g.fillStyle(hawkWing, 1);
        g.fillTriangle(
            hx - ux * 1.0 - px * 1.0, hy + 0.8 - py * 1.0,
            hx - ux * 1.0 + px * 1.0, hy + 0.8 + py * 1.0,
            hx - ux * 3.8, hy + 2.0
        );
        // wings — two clean upswept wedges when spotting/preening
        if (raise > 0.05) {
            const lift = 3.6 + 2.6 * raise;
            g.fillStyle(hawkWing, 1);
            g.fillTriangle(hx - 0.4, hy - 0.8 * squash, hx - 2.2, hy + 1.0, hx - 3.6, hy - lift);
            g.fillTriangle(hx + 0.4, hy - 0.8 * squash, hx + 2.2, hy + 1.0, hx + 3.6, hy - lift);
            g.lineStyle(0.8, shade(hawkBody, 1.3), 1); // lit leading edges
            g.lineBetween(hx - 0.4, hy - 0.8 * squash, hx - 3.6, hy - lift);
            g.lineBetween(hx + 0.4, hy - 0.8 * squash, hx + 3.6, hy - lift);
        }
        // body
        g.fillStyle(hawkBody, 1);
        g.fillEllipse(hx, hy, 3.8, 4.8 * squash);
        // breast
        g.fillStyle(hawkBreast, 1);
        g.fillEllipse(hx + ux * 0.7, hy + 0.9 * squash, 2.0, 2.6 * squash);
        // folded wing patch at rest
        if (raise <= 0.05) {
            g.fillStyle(hawkWing, 1);
            g.fillEllipse(hx - ux * 0.9, hy - 0.4 * squash, 2.0, 2.8 * squash);
        }
        // head scans in idle, locks along the aim in combat
        const hYaw = idling ? 1.2 * Math.sin(iph + 1.0) : 0;
        const hdx = hx + ux * 0.8 + px * hYaw;
        const hdy = hy - 2.8 * squash - 1.0 * spot01;
        g.fillStyle(hawkBody, 1);
        g.fillCircle(hdx, hdy, 1.6);
        g.fillStyle(hawkBreast, 1); // pale cheek so the head reads
        g.fillCircle(hdx + ux * 0.5, hdy + 0.5, 0.8);
        g.fillStyle(gold, 1); // beak, small and attached
        g.fillTriangle(hdx + ux * 1.2, hdy - 0.5, hdx + ux * 1.2, hdy + 0.5, hdx + ux * 2.1, hdy + 0.1);
        // jess — the team-coloured falconry strap at the perch
        g.fillStyle(team, 1);
        g.fillRect(hx - 0.7, hy + 2.1 * squash, 1.4, 1.0);
        if (lvl === 3) { // gold tail band, a max-level accent
            g.fillStyle(gold, 1);
            g.fillRect(hx - ux * 2.2 - 0.6, hy + 1.2, 1.2, 0.9);
        }
    };

    /** The long arbalest. axis (ax,ay) unit; anchored at (Ax,Ay). */
    const drawArbalest = (axRaw: number, ayRaw: number, Ax: number, Ay: number, aimed: boolean) => {
        // iso foreshortening: along-aim distances compress as the weapon
        // pitches up/down the screen (otherwise a down-aim rail hits the feet)
        const kd = 1 - 0.4 * Math.abs(ayRaw);
        const ax = axRaw * kd, ay = ayRaw * kd;
        const bx = -ayRaw, by = axRaw; // across-weapon (unsquashed)
        const kick = 1.2 * fired01;
        const ox = Ax - ax * kick, oy = Ay - ay * kick - 1.0 * fired01 * (aimed ? 1 : 0);
        const L = aimed ? 10.5 : 8.2;
        const A = (d: number, w = 0, h = 0) => ({ x: ox + ax * d + bx * w, y: oy + ay * d + by * w + h });
        const butt = A(-3.2), tip = A(L);
        // stock (shoulder block)
        g.fillStyle(stockCol, 1);
        g.fillPoints([A(-3.2, -1.1), A(0.6, -0.9), A(0.6, 1.1), A(-3.2, 1.5)], true);
        g.fillStyle(shade(stockCol, 0.7), 1);
        g.fillPoints([A(-3.2, 0.6), A(0.6, 0.4), A(0.6, 1.1), A(-3.2, 1.5)], true);
        // rail
        g.lineStyle(1.4, railCol, 1);
        g.lineBetween(butt.x + ax * 2.4, butt.y + ay * 2.4, tip.x, tip.y);
        g.lineStyle(0.7, shade(railCol, 0.62), 1);
        const u1 = A(0, 0.7), u2 = A(L - 0.4, 0.7);
        g.lineBetween(u1.x, u1.y, u2.x, u2.y);
        // limbs — tapered strips across the muzzle, swept slightly back
        const lb = A(L - 1.5);
        g.lineStyle(1.3, stockCol, 1);
        for (const s of [1, -1]) {
            const mid = A(L - 2.0, s * 2.6);
            const tp = A(L - 3.1, s * 4.6);
            g.lineBetween(lb.x + bx * s * 0.8, lb.y + by * s * 0.8, mid.x, mid.y);
            g.lineStyle(1.0, stockCol, 1);
            g.lineBetween(mid.x, mid.y, tp.x, tp.y);
            g.fillStyle(tipCol, 1);
            g.fillCircle(tp.x, tp.y, 0.8);
            g.lineStyle(1.3, stockCol, 1);
        }
        // string: rest near the limbs; cranked back toward the stock in windup
        const nut = A(L - 2.0 - 5.8 * draw01);
        g.lineStyle(0.7, 0xd8d8d8, 1);
        for (const s of [1, -1]) {
            const tp = A(L - 3.1, s * 4.6);
            g.lineBetween(tp.x, tp.y, nut.x, nut.y);
        }
        // bolt seats while cranking, vanishes on release
        if (draw01 > 0.05) {
            g.lineStyle(0.9, steel, 1);
            const bt = A(L + 1.0);
            g.lineBetween(nut.x, nut.y, bt.x, bt.y);
            g.fillStyle(teamLt, 1); // team fletching
            const fl = A(L - 2.0 - 5.8 * draw01 + 0.7);
            g.fillCircle(fl.x, fl.y, 0.7);
        }
        // sight ring above the rail (vertical offset — perpendicular to ground);
        // only mounted-up when shouldered — the low carry stays a clean line
        const sc = A(2.8, 0, -1.6);
        if (aimed) {
            g.lineStyle(0.8, lvl === 3 ? gold : iron, 1);
            g.strokeCircle(sc.x, sc.y, 1.1);
        }
        if (aimed && draw01 > 0.55) {
            // hawk-eye focus: the gold glint charging down the rail to the muzzle
            g.fillStyle(goldLt, 1);
            g.fillCircle(sc.x, sc.y, 0.6);
            const gl = A(3.6 + (L - 4.6) * draw01);
            g.lineStyle(0.6, goldLt, 1);
            g.lineBetween(gl.x - ax * 1.4, gl.y - ay * 1.4, gl.x + ax * 1.4, gl.y + ay * 1.4);
        }
        // muzzle spark exactly on the tick
        if (spark) {
            const mz = A(L + 1.4);
            g.fillStyle(goldLt, 1);
            g.fillCircle(mz.x, mz.y, 1.3);
            g.lineStyle(0.7, goldLt, 1);
            g.lineBetween(mz.x - ax * 2.8, mz.y - ay * 2.8, mz.x + ax * 3.2, mz.y + ay * 3.2);
            g.lineBetween(mz.x - bx * 2.2, mz.y - by * 2.2, mz.x + bx * 2.2, mz.y + by * 2.2);
        }
        // hands: lead hand on the rail, trigger hand at the stock
        g.fillStyle(leather, 1);
        g.fillCircle(ox + ax * 4.6, oy + ay * 4.6, 1.0);
        g.fillCircle(ox - ax * 0.8, oy - ay * 0.8, 1.0);
    };

    const drawWeapon = () => {
        if (inCombat) {
            drawArbalest(ux, uy, ux * 1.6, -4.6 + dy, true);
        } else {
            // low-ready carry: always slung diagonal-DOWN on the leading side,
            // whatever the heading — never crossing the head or the ankles
            const a2 = ux >= 0 ? 0.98 : Math.PI - 0.98;
            drawArbalest(Math.cos(a2), Math.sin(a2), ux * 0.8 - px * 0.5, 0.2 + dy, false);
        }
    };

    // ================= paint order =================

    // contact shadow (alpha-snaps to a hard pixel ellipse in the bake)
    g.fillStyle(0x1d2a14, 0.55);
    g.fillEllipse(0, GROUND - 0.2, 13, 4);

    if (weaponBehind) drawWeapon();
    if (hawkBehind) drawHawk();

    // quiver peeking from behind the shoulder when facing the camera
    if (uy >= -0.15) {
        const qx = -ux * 1.5 - px * 2.0, qy = -2.0 + dy;
        g.fillStyle(leather, 1);
        g.fillRect(qx - 1.0, qy - 2.4, 2.0, 4.2);
        g.fillStyle(teamLt, 1);
        g.fillCircle(qx - 0.5, qy - 2.8, 0.6);
        g.fillCircle(qx + 0.5, qy - 3.1, 0.6);
    }

    // legs + boots — prowling scissor along the heading; at rest the stance
    // spreads screen-horizontally so the figure never collapses to a stem
    const stepAlong = isMoving ? 2.6 * legA : 0;
    // the SWINGING foot lifts (velocity = cos), the extended foot stays planted
    const liftA = isMoving ? 1.1 * Math.max(0, Math.cos(wPh)) : 0;
    const liftB = isMoving ? 1.1 * Math.max(0, -Math.cos(wPh)) : 0;
    const spread = isMoving ? 1.0 : 1.8; // screen-x stance width
    const bAx = ux * stepAlong + spread, bBx = -ux * stepAlong - spread;
    const trouser = 0x333d47;
    g.fillStyle(trouser, 1); // shin slivers tie the hem to the boots
    g.fillRect(bAx - 0.7, 6.6, 1.4, GROUND - 8.3 - liftA);
    g.fillRect(bBx - 0.7, 6.6, 1.4, GROUND - 8.3 - liftB);
    g.fillStyle(boot, 1);
    g.fillRect(bAx - 1.2, GROUND - 2.1 - liftA, 2.4, 2.1);
    g.fillRect(bBx - 1.2, GROUND - 2.1 - liftB, 2.4, 2.1);

    // cloak — lower flare (hem grounded, sways as one cloth)
    const leanX = ux * lean;
    g.fillStyle(cloak, 1);
    g.fillPoints([
        { x: -4.2 + leanX, y: 1.5 + dy }, { x: 4.2 + leanX, y: 1.5 + dy },
        { x: 5.4 + hemSway, y: 7.2 }, { x: -5.4 + hemSway, y: 7.2 }
    ], true);
    g.fillStyle(hemDk, 1);
    g.fillPoints([
        { x: -5.0 + hemSway * 0.9, y: 6.1 }, { x: 5.0 + hemSway * 0.9, y: 6.1 },
        { x: 5.4 + hemSway, y: 7.2 }, { x: -5.4 + hemSway, y: 7.2 }
    ], true);
    if (lvl >= 2) { // hem trim: silver at L2, gold accent line at L3
        g.lineStyle(0.7, trimCol, 1);
        g.lineBetween(-4.9 + hemSway * 0.9, 6.1, 4.9 + hemSway * 0.9, 6.1);
    }

    // torso column
    g.fillStyle(cloak, 1);
    g.fillPoints([
        { x: -3.6 + leanX, y: -4.4 + dy }, { x: 3.6 + leanX, y: -4.4 + dy },
        { x: 4.2 + leanX, y: 1.6 + dy }, { x: -4.2 + leanX, y: 1.6 + dy }
    ], true);
    // SE-dark / NW-light modelling (light from the NW)
    g.fillStyle(cloakDk, 1);
    g.fillPoints([
        { x: 1.9 + leanX, y: -4.4 + dy }, { x: 3.6 + leanX, y: -4.4 + dy },
        { x: 4.2 + leanX, y: 1.6 + dy }, { x: 2.4 + leanX, y: 1.6 + dy }
    ], true);
    g.fillStyle(cloakLt, 1);
    g.fillPoints([
        { x: -3.6 + leanX, y: -4.4 + dy }, { x: -2.5 + leanX, y: -4.4 + dy },
        { x: -3.0 + leanX, y: 1.6 + dy }, { x: -4.2 + leanX, y: 1.6 + dy }
    ], true);
    // team sash, shoulder to hip
    g.fillStyle(team, 1);
    g.fillPoints([
        { x: -2.8 + leanX, y: -3.9 + dy }, { x: -1.5 + leanX, y: -4.2 + dy },
        { x: 3.4 + leanX, y: 1.3 + dy }, { x: 2.1 + leanX, y: 1.6 + dy }
    ], true);
    // belt
    g.fillStyle(leatherDk, 1);
    g.fillRect(-4.2 + leanX, 1.2 + dy, 8.4, 1.2);
    if (lvl === 3) {
        g.fillStyle(gold, 1);
        g.fillRect(-0.7 + leanX, 1.3 + dy, 1.4, 1.0);
    }

    // shoulder mantle (the hood's cape)
    g.fillStyle(hood, 1);
    g.fillEllipse(leanX, -3.4 + dy, 8.6, 3.6);
    if (lvl >= 2) { // iron pauldron on the weapon shoulder; gold-rimmed at L3
        g.fillStyle(iron, 1);
        g.fillEllipse(leanX + ux * 2.6, -4.0 + dy, 3.2, 2.2);
        g.lineStyle(0.7, lvl === 3 ? gold : steel, 1);
        g.strokeEllipse(leanX + ux * 2.6, -4.0 + dy, 3.2, 2.2);
    }

    // quiver worn ON the back when facing away
    if (uy < -0.15) {
        const qx = leanX - px * 2.2, qy = -1.6 + dy;
        g.fillStyle(leather, 1);
        g.fillRect(qx - 1.1, qy - 2.6, 2.2, 5.0);
        g.lineStyle(0.7, leatherDk, 1);
        g.lineBetween(qx - 1.1, qy - 0.4, qx + 1.1, qy - 0.4);
        g.fillStyle(teamLt, 1);
        g.fillCircle(qx - 0.5, qy - 3.0, 0.6);
        g.fillCircle(qx + 0.6, qy - 3.3, 0.6);
    }

    // hood — teardrop with a wind-blown peak drifting off the aim
    const hx = leanX + px * yaw;
    const hoodY = -8 + dy;
    g.fillStyle(hood, 1);
    g.fillCircle(hx, hoodY, 3.3);
    g.fillTriangle(
        hx - 2.3, hoodY - 0.4,
        hx + 2.3, hoodY - 0.4,
        hx - ux * 1.3, hoodY - 4.5
    );
    g.fillStyle(hoodDk, 1); // SE shade crescent
    g.fillEllipse(hx + 1.5, hoodY + 0.6, 2.2, 3.6);
    if (uy > -0.2) {
        // face: shadow void + the single gold hawk-eye + the scarf wrap
        g.fillStyle(faceVoid, 1);
        g.fillEllipse(hx + ux * 1.1, hoodY + 0.7, 2.8, 2.4);
        const hot = inCombat ? true : blinkHot;
        g.fillStyle(hot ? goldLt : shade(gold, 0.45), 1);
        g.fillCircle(hx + ux * 1.3 + px * 0.5, hoodY + 0.4, draw01 > 0.55 ? 0.9 : 0.7);
        g.fillStyle(team, 1);
        g.fillRect(hx + ux * 1.1 - 1.4, hoodY + 1.7, 2.8, 1.1);
    } else {
        // back view: hood seam
        g.lineStyle(0.7, hoodDk, 1);
        g.lineBetween(hx - ux * 1.3, hoodY - 4.3, hx, hoodY + 2.6);
    }
    if (lvl === 3) { // gold feather clasp at the mantle throat
        g.fillStyle(gold, 1);
        g.fillCircle(hx + ux * 0.6, hoodY + 2.9, 0.8);
    }

    if (!weaponBehind) drawWeapon();
    if (!hawkBehind) drawHawk();
}
