/**
 * Shared dragon-pod flight plan — the ONE source of truth for the
 * dragons_breath rocket's waypoint path and its CONSTANT-SPEED clock.
 *
 * MainScene.shootDragonPod flies the visible rocket off this plan (boost
 * tween + arc tween; the trail and ground shadow ride the same boostAt /
 * flightAt samplers), and WorldBattlePresentationModel mirrors the impact
 * clock for world-map spectate parity by building the IDENTICAL plan from
 * the recorded event seed (its start point is the battery footprint center
 * rather than the exact tube mouth — the model's established fidelity).
 *
 * CONSTANT SCREEN SPEED (owner 2026-07-22): the whole flight — straight
 * boost, carry, veer kinks, homing zigzag — covers equal distance in equal
 * clock. The arc waypoints keep their authored SHAPE (same hash tags as
 * ever) but their t values are re-timed by cumulative arc length, and the
 * total flight clock is TOTAL ARC LENGTH / DRAGON_POD_SPEED_PX_MS: the old
 * boost-phase pace is now the pace everywhere, so the veer/homing no
 * longer dawdle. The only concession is a tiny hash-derived acceleration
 * snap (~40-60 ms) at the very start of the straight; half the snap is
 * added to the boost clock so the post-snap cruise runs exactly at speed.
 *
 * Everything here is a pure function of (volleySeed, podIndex, geometry) —
 * hashString only, ZERO battleRandom draws. The ONE rnd fold on the flight
 * duration (× DRAGON_POD_DURATION_RND_MS) stays with the CALLERS, drawn
 * from their own streams, so recorded draw count/order are untouched.
 *
 * Damage stays presentational on the client (applyLocalTroopDamage at arc
 * completion); AUTHORITATIVE settlement is the server's statistical
 * credit/DPS model (server/attack-domain/simulation.ts), which never
 * consumes any of these clocks.
 */
import { hashString } from '../config/Economy';

/** One constant cruise speed for the whole flight (px/ms) — the old
 *  boost-phase pace, matching the retired chord clock's 0.6. */
export const DRAGON_POD_SPEED_PX_MS = 0.6;
/** The slim rnd fold on the arc clock (ms) — exactly ONE caller draw. */
export const DRAGON_POD_DURATION_RND_MS = 40;

const clamp = (value: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, value));

/** The salvo-fan launch bearing for pod i — MainScene's fan walk (±65°
 *  ordered sweep around the volley-start facing, ±8° per-pod jitter),
 *  shared so the world-map mirror derives the same bearings. */
export function dragonPodBearing(
    volleySeed: number,
    podIndex: number,
    salvoSize: number,
    baseFacing: number
): number {
    const volleyHash01 = (tag: string) =>
        (hashString(`${volleySeed}:dragons:${tag}`) >>> 0) / 0xffffffff;
    const fanHalf = Math.PI * (65 / 180);
    const sweepSign = volleyHash01('sweep-dir') < 0.5 ? -1 : 1;
    const walk01 = salvoSize > 1 ? podIndex / (salvoSize - 1) : 0.5;
    const jitter = (volleyHash01(`fan:${podIndex}`) - 0.5) * Math.PI * (16 / 180);
    return baseFacing + sweepSign * (walk01 * 2 - 1) * fanHalf + jitter;
}

export interface DragonPodFlightInput {
    volleySeed: number;
    podIndex: number;
    /** Salvo-fan launch bearing (radians, screen space). */
    bearing: number;
    /** Launch point (battery mouth / tube exit, iso px). */
    startX: number;
    startY: number;
    /** Recorded landing point (iso px). */
    endX: number;
    endY: number;
    /** Grid-space launch→target distance (tiles) — drives chaosScale. */
    targetDistTiles: number;
}

export interface DragonPodWaypoint {
    x: number;
    y: number;
    /** Flight-clock fraction — RE-TIMED by cumulative arc length, so equal
     *  t = equal distance. */
    t: number;
}

export interface DragonPodFlightPlan {
    /** Boost-line direction (radians) — the nose lock during the burn. */
    boostAngle: number;
    /** Boost-line length (px). */
    boostRun: number;
    /** Accel-snap window (ms) at the very start of the straight. */
    snapMs: number;
    /** Boost clock (ms): boostRun at cruise speed + half the accel snap. */
    boostMs: number;
    /** Boost sampler over u∈[0,1] of the boost clock — quadratic through
     *  the snap, then EXACTLY the cruise speed to the boost tip. */
    boostAt: (u: number) => { x: number; y: number };
    /** Arc waypoints p0→end (p0 = boost tip), t re-timed by arc length. */
    waypoints: DragonPodWaypoint[];
    /** Total arc path length p0→end (px). */
    arcLen: number;
    /** Deterministic arc clock (ms) BEFORE the caller's one rnd fold:
     *  arcLen / DRAGON_POD_SPEED_PX_MS. */
    arcMs: number;
    /** Re-timed t of the last veer waypoint (the behind-box depth gate). */
    veerEndT: number;
    /** Piecewise-linear sampler — the sharp corners ARE the firework read.
     *  seg = active segment index for nose rotation. */
    flightAt: (t: number) => { x: number; y: number; seg: number };
}

export function planDragonPodFlight(input: DragonPodFlightInput): DragonPodFlightPlan {
    const { volleySeed, podIndex, bearing, startX, startY, endX, endY, targetDistTiles } = input;
    const h01 = (tag: string) =>
        (hashString(`${volleySeed}:pod:${podIndex}:${tag}`) >>> 0) / 0xffffffff;
    const hSign = (tag: string) => (h01(tag) < 0.5 ? -1 : 1);

    // PHASE 1 — BOOST: one CONSTANT screen direction (the bearing,
    // iso-foreshortened 0.5, with a slight climb folded into the same line
    // so the fan rises as it clears the box).
    //
    // CLOSE-RANGE STRAIGHT SHOTS: inside ~4.5 tiles the firework detour
    // reads absurd, so chaosScale fades the WHOLE detour continuously
    // (0 at ≤4.5 tiles → 1 at ≥9): the boost bearing blends toward the
    // landing line, and every arc waypoint below lerps onto the p0→end
    // chord by the same factor — at 0 the rocket flies tube→landing in one
    // straight line. Path shape only: the landing point never moves.
    const boostLen = 78 + h01('boost-len') * 26;
    const boostLift = 15 + h01('boost-lift') * 9;
    const fanDX = Math.cos(bearing) * boostLen;
    const fanDY = Math.sin(bearing) * 0.5 * boostLen - boostLift;
    const fanAngle = Math.atan2(fanDY, fanDX);
    const fanNorm = Math.hypot(fanDX, fanDY);
    const chaosScale = clamp((targetDistTiles - 4.5) / 4.5, 0, 1);
    const lineAngle = Math.atan2(endY - startY, endX - startX);
    const lineLen = Math.hypot(endX - startX, endY - startY);
    let fanOff = fanAngle - lineAngle;
    while (fanOff > Math.PI) fanOff -= Math.PI * 2;
    while (fanOff < -Math.PI) fanOff += Math.PI * 2;
    const boostAngle = lineAngle + fanOff * chaosScale;
    // chaosScale 1 reproduces the fan vector exactly; 0 aims the burn at
    // the landing point (capped so short lines keep room to fly).
    const boostRun = fanNorm + (Math.min(fanNorm, lineLen * 0.45) - fanNorm) * (1 - chaosScale);
    const boostDX = Math.cos(boostAngle) * boostRun;
    const boostDY = Math.sin(boostAngle) * boostRun;

    // BOOST CLOCK — the straight runs at cruise speed after a tiny accel
    // snap: v ramps linearly over snapMs then holds, so distance covered is
    // v·(T − snapMs/2); adding snapMs/2 to the clock keeps the cruise at
    // exactly DRAGON_POD_SPEED_PX_MS.
    const snapMs = 40 + h01('boost-snap') * 20;
    const boostMs = Math.max(1, boostRun / DRAGON_POD_SPEED_PX_MS + snapMs / 2);
    const snap01 = Math.min(1, snapMs / boostMs);
    const boostAt = (u: number) => {
        const uu = clamp(u, 0, 1);
        const w = uu <= snap01
            ? (uu * uu) / (snap01 * (2 - snap01))
            : (2 * uu - snap01) / (2 - snap01);
        return { x: startX + boostDX * w, y: startY + boostDY * w };
    };

    // -- Waypoint script: hold the line, then veer, then find the target --
    // The authored t values below are SHAPE parameters only (they place the
    // kinks and drive the chaosScale chord fade exactly as before); the
    // flight clock re-times every waypoint by arc length afterwards.
    // chaosReach keeps its historical scale reference: the mouth column at
    // the old riseY (startY − 52) to the landing point.
    const distRef = Math.hypot(endX - startX, endY - (startY - 52));
    // PHASE 1 tail — STRAIGHT CARRY: the boost track continues unbroken
    // into the arc, so launch reads as ONE straight line before anything
    // bends.
    const p0 = boostAt(1);
    const carry01 = 0.06 + h01('carry') * 0.04;
    const carryLen = 30 + h01('carry-len') * 16;
    const waypoints: DragonPodWaypoint[] = [{ x: p0.x, y: p0.y, t: 0 }];
    let wx = p0.x + Math.cos(boostAngle) * carryLen;
    let wy = p0.y + Math.sin(boostAngle) * carryLen;
    waypoints.push({ x: wx, y: wy, t: carry01 });
    // PHASE 2 — the VEER: 1-2 kinks off the line, 20°-52° snaps over a
    // short reach.
    const chaosEnd01 = carry01 + 0.14 + h01('chaos-end') * 0.12;
    const chaosKinks = 1 + Math.floor(h01('chaos-kinks') * 2); // 1-2 veer kinks
    const chaosReach = Math.min(64, 20 + distRef * 0.08);
    let wDir = boostAngle;
    for (let k = 0; k < chaosKinks; k++) {
        wDir += hSign(`ck-s:${k}`) * (0.35 + h01(`ck:${k}`) * 0.55); // 20°-52° snap
        const seg = (chaosReach / chaosKinks) * (0.5 + h01(`cl:${k}`) * 0.5);
        wx += Math.cos(wDir) * seg;
        // Iso-foreshortened lateral, still climbing a touch — the veer
        // happens in the air, not on the lawn.
        wy += Math.sin(wDir) * 0.5 * seg - (6 + h01(`cc:${k}`) * 10);
        waypoints.push({
            x: wx, y: wy,
            t: carry01 + (chaosEnd01 - carry01) * ((k + 1) / chaosKinks)
        });
    }
    const veerEndIndex = waypoints.length - 1;
    // Homing run-in: 2-3 decaying zigzag kinks, arriving EXACTLY at end
    // (the damage point) — the swarm converging on the enemy.
    const zigzagKinks = 2 + Math.floor(h01('zig-n') * 2);
    const homeDX = endX - wx;
    const homeDY = endY - wy;
    const homeLen = Math.hypot(homeDX, homeDY) || 1;
    const perpX = -homeDY / homeLen;
    const perpY = homeDX / homeLen;
    let zigSide = hSign('zig-s');
    for (let k = 0; k < zigzagKinks; k++) {
        const f = (k + 1) / (zigzagKinks + 1);
        const amp = Math.min(34, 10 + homeLen * 0.10)
            * (0.7 + h01(`za:${k}`) * 0.6) * (1 - f * 0.6);
        waypoints.push({
            x: wx + homeDX * f + perpX * amp * zigSide,
            y: wy + homeDY * f + perpY * amp * zigSide,
            t: chaosEnd01 + (1 - chaosEnd01) * f
        });
        zigSide = -zigSide;
    }
    waypoints.push({ x: endX, y: endY, t: 1 });

    // CLOSE/MID-RANGE: fade the whole detour onto the p0→end chord by
    // chaosScale (each waypoint lerps toward the chord point at its own
    // authored clock fraction). p0 and end are already ON the chord, so
    // phase seams stay continuous.
    if (chaosScale < 1) {
        for (const wp of waypoints) {
            const lx = p0.x + (endX - p0.x) * wp.t;
            const ly = p0.y + (endY - p0.y) * wp.t;
            wp.x = lx + (wp.x - lx) * chaosScale;
            wp.y = ly + (wp.y - ly) * chaosScale;
        }
    }

    // === ARC-LENGTH RE-TIME — equal clock = equal distance ===
    // Cumulative segment lengths replace the authored t values, and the
    // arc clock is the total length at cruise speed: the whole flight now
    // holds one screen pace through carry, veer and homing alike.
    let arcLen = 0;
    const cumLen: number[] = [0];
    for (let k = 1; k < waypoints.length; k++) {
        arcLen += Math.hypot(
            waypoints[k].x - waypoints[k - 1].x,
            waypoints[k].y - waypoints[k - 1].y
        );
        cumLen.push(arcLen);
    }
    if (arcLen > 1e-6) {
        for (let k = 0; k < waypoints.length; k++) {
            waypoints[k].t = cumLen[k] / arcLen;
        }
    }
    const arcMs = arcLen / DRAGON_POD_SPEED_PX_MS;
    const veerEndT = waypoints[veerEndIndex].t;

    /** Piecewise-linear flight sampler — returns the active segment for
     *  nose rotation. */
    const flightAt = (t: number): { x: number; y: number; seg: number } => {
        if (t <= 0) return { x: waypoints[0].x, y: waypoints[0].y, seg: 1 };
        for (let k = 1; k < waypoints.length; k++) {
            if (t <= waypoints[k].t || k === waypoints.length - 1) {
                const a = waypoints[k - 1];
                const b = waypoints[k];
                const span = Math.max(1e-6, b.t - a.t);
                const f = clamp((t - a.t) / span, 0, 1);
                return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, seg: k };
            }
        }
        const last = waypoints[waypoints.length - 1];
        return { x: last.x, y: last.y, seg: waypoints.length - 1 };
    };

    return {
        boostAngle,
        boostRun,
        snapMs,
        boostMs,
        boostAt,
        waypoints,
        arcLen,
        arcMs,
        veerEndT,
        flightAt
    };
}
