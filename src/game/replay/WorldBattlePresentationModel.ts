import type {
    DefenseChargePayload,
    DefenseFirePayload,
    ProjectileImpactPayload,
    ProjectileLaunchPayload,
    ReplayAbilityPayload,
    ReplayEntityRef,
    ReplayFxPayload,
    ReplayFxPreset,
    ReplayPresentationPoint,
    ReplayStatusPayload
} from './ReplayPresentationEvents';
import { createReplayPresentationRandom } from './ReplayPresentationStream';

export interface WorldBattleTeslaCharge {
    defense: ReplayEntityRef;
    target?: ReplayEntityRef;
    phase: 'charging' | 'charged';
    startT: number;
    endT: number;
    seed: number;
}

export interface WorldBattleFrozenBuilding {
    building: ReplayEntityRef;
    at: ReplayPresentationPoint;
    startT: number;
    endT: number;
    seed: number;
}

export interface WorldBattlePrismBeam {
    defense: ReplayEntityRef;
    target?: ReplayEntityRef;
    source: ReplayPresentationPoint;
    targetPoint?: ReplayPresentationPoint;
    startT: number;
    endT: number;
    hue: number;
    seed: number;
}

export interface WorldBattleSpikeZone {
    id: string;
    actorId?: string;
    at: ReplayPresentationPoint;
    owner: 'PLAYER' | 'ENEMY';
    radiusTiles: number;
    startT: number;
    endT: number;
    seed: number;
}

export interface WorldBattleDragonRocket {
    id: string;
    source: ReplayPresentationPoint;
    target: ReplayPresentationPoint;
    startT: number;
    endT: number;
    seed: number;
}

export interface WorldBattleLightning {
    id: string;
    points: readonly ReplayPresentationPoint[];
    startT: number;
    endT: number;
    color: number;
    width: number;
    alpha: number;
    seed: number;
}

export interface WorldBattleRing {
    id: string;
    at: ReplayPresentationPoint;
    startT: number;
    endT: number;
    radiusFrom: number;
    radiusTo: number;
    squash: number;
    thicknessFrom: number;
    thicknessTo: number;
    color: number;
    alpha: number;
    ground: boolean;
}

export interface WorldBattleFlash {
    id: string;
    at: ReplayPresentationPoint;
    startT: number;
    endT: number;
    radius: number;
    squash: number;
    color: number;
    alpha: number;
    scaleTo: number;
    ground: boolean;
}

export interface WorldBattleBurst {
    id: string;
    at: ReplayPresentationPoint;
    startT: number;
    endT: number;
    count: number;
    colors: readonly number[];
    radius: number;
    spreadX: number;
    spreadY: number;
    radial: number;
    up: number;
    alpha: number;
    square: boolean;
    ground: boolean;
    seed: number;
}

export interface WorldBattleContinuousProjectile {
    id: string;
    source: ReplayPresentationPoint;
    target: ReplayPresentationPoint;
    targetEntity?: ReplayEntityRef;
    startT: number;
    endT: number;
    color: number;
    seed: number;
}

export interface WorldBattleProjectile {
    id: string;
    launchEventId: string;
    payload: ProjectileLaunchPayload;
    startT: number;
    endT: number;
    seed: number;
    /** Synthetic combat.attack/defense.fire projectile used only until the
     * explicit projectile.launch for the same release reaches the stream. */
    fallback: boolean;
}

export interface WorldBattleProjectileImpact {
    id: string;
    launchEventId?: string;
    payload: ProjectileImpactPayload;
    startT: number;
    endT: number;
    seed: number;
}

export interface WorldBattleProjectileSample {
    point: ReplayPresentationPoint;
    ground: { gridX: number; gridY: number };
    progress: number;
    rotation: number;
    scale: number;
}

export type WorldBattleEntityPointResolver = (
    entity: ReplayEntityRef
) => ReplayPresentationPoint | undefined;

const PRESET_STYLE = {
    'deploy-dust': { color: 0xd8b878, radius: 8, durationMs: 280, ground: false },
    'heal-ring': { color: 0x72ec9a, radius: 34, durationMs: 460, ground: true },
    'heal-number': { color: 0x72ec9a, radius: 7, durationMs: 500, ground: false },
    'summon-flourish': { color: 0xb08aff, radius: 26, durationMs: 420, ground: true },
    'siege-ramp-dust': { color: 0xb69b74, radius: 18, durationMs: 420, ground: true },
    'slam-cracks': { color: 0x7a6348, radius: 30, durationMs: 700, ground: true },
    'golem-hit': { color: 0xc7b69a, radius: 10, durationMs: 260, ground: false },
    'ice-golem-hit': { color: 0xa9ecff, radius: 11, durationMs: 300, ground: false },
    'freeze-burst': { color: 0x8edfff, radius: 38, durationMs: 620, ground: true },
    'freeze-dressing': { color: 0xbcefff, radius: 18, durationMs: 900, ground: false },
    'freeze-thaw': { color: 0xd8f7ff, radius: 22, durationMs: 420, ground: false },
    'building-collapse': { color: 0xff8c42, radius: 18, durationMs: 650, ground: false },
    'troop-death': { color: 0xcfc8b8, radius: 10, durationMs: 420, ground: false },
    'arrow-hit': { color: 0xffd27a, radius: 6, durationMs: 220, ground: false },
    'tracer-hit': { color: 0xffd27a, radius: 6, durationMs: 220, ground: false },
    'grave-orb-burst': { color: 0xb08aff, radius: 12, durationMs: 340, ground: false },
    'mobile-mortar-explosion': { color: 0xff9d4d, radius: 16, durationMs: 480, ground: false },
    'trebuchet-explosion': { color: 0xe6b66f, radius: 20, durationMs: 560, ground: false },
    'ornithopter-explosion': { color: 0xffa04b, radius: 15, durationMs: 420, ground: false },
    'da-vinci-impact': { color: 0xffb85c, radius: 14, durationMs: 360, ground: false },
    'cannon-impact': { color: 0xffa04b, radius: 12, durationMs: 340, ground: false },
    'mortar-explosion': { color: 0xff9d4d, radius: 18, durationMs: 500, ground: false },
    'ballista-impact': { color: 0xd8bd83, radius: 8, durationMs: 260, ground: false },
    'xbow-impact': { color: 0xe0c58a, radius: 7, durationMs: 220, ground: false },
    'tesla-impact': { color: 0x87edff, radius: 11, durationMs: 300, ground: false },
    'storm-lightning-impact': { color: 0x71efff, radius: 12, durationMs: 300, ground: false },
    'prism-impact': { color: 0xff7cf4, radius: 10, durationMs: 220, ground: false },
    'dragon-rocket-explosion': { color: 0xff7b32, radius: 22, durationMs: 560, ground: false },
    'spike-zone-impact': { color: 0xd8b878, radius: 18, durationMs: 420, ground: true }
} as const satisfies Record<ReplayFxPreset, {
    color: number;
    radius: number;
    durationMs: number;
    ground: boolean;
}>;

export function worldBattleImpactVisual(style: ProjectileImpactPayload['style']): {
    color: number;
    radius: number;
    durationMs: number;
    ground: boolean;
} {
    return PRESET_STYLE[style];
}

function assertNeverAbility(value: never): never {
    throw new Error(`Unhandled world-battle ability: ${JSON.stringify(value)}`);
}

function assertNeverFx(value: never): never {
    throw new Error(`Unhandled world-battle fx: ${JSON.stringify(value)}`);
}

function shiftedPoint(
    point: ReplayPresentationPoint,
    gridDX: number,
    gridDY: number
): ReplayPresentationPoint {
    return {
        gridX: point.gridX + gridDX,
        gridY: point.gridY + gridDY,
        worldX: point.worldX + (gridDX - gridDY) * 32,
        worldY: point.worldY + (gridDX + gridDY) * 16
    };
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function trajectoryDuration(payload: ProjectileLaunchPayload): number {
    return payload.trajectory.kind === 'continuous'
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Number(payload.trajectory.durationMs) || 0);
}

function trajectoryLaunchDelay(payload: ProjectileLaunchPayload): number {
    return payload.trajectory.kind === 'parabolic'
        ? Math.max(0, Number(payload.trajectory.launchDelayMs) || 0)
        : 0;
}

function easeProgress(progress: number, ease: 'Linear' | 'Quad.easeIn' | 'Sine.easeInOut'): number {
    const p = clamp01(progress);
    if (ease === 'Quad.easeIn') return p * p;
    if (ease === 'Sine.easeInOut') return -(Math.cos(Math.PI * p) - 1) / 2;
    return p;
}

/** Translate an authored impact point by the target's replay-time movement.
 * Homing launches store the body-surface contact in world space while their
 * grid position remains the target's feet. Resolving the entity returns its
 * current feet/pose anchor, so replacing the authored point outright would
 * make cannon and bolt impacts visibly dive to the ground. */
function trackAuthoredTargetPoint(
    authored: ReplayPresentationPoint,
    tracked: ReplayPresentationPoint
): ReplayPresentationPoint {
    const authoredAnchorWorldX = (authored.gridX - authored.gridY) * 32;
    const authoredAnchorWorldY = (authored.gridX + authored.gridY) * 16;
    return {
        gridX: tracked.gridX,
        gridY: tracked.gridY,
        worldX: tracked.worldX + authored.worldX - authoredAnchorWorldX,
        worldY: tracked.worldY + authored.worldY - authoredAnchorWorldY
    };
}

export function worldBattleProjectileEndT(payload: ProjectileLaunchPayload, startT: number): number {
    const duration = trajectoryDuration(payload);
    return Number.isFinite(duration)
        ? startT + trajectoryLaunchDelay(payload) + duration
        : Number.POSITIVE_INFINITY;
}

/** Deterministic trajectory sampler shared by the renderer and regressions.
 * `resolvePoint` supplies the cached, once-per-tick troop pose for homing and
 * continuous shots so tracking never snaps to the next keyframe early. */
export function sampleWorldBattleProjectile(
    projectile: Readonly<WorldBattleProjectile>,
    replayT: number,
    resolvePoint: WorldBattleEntityPointResolver
): WorldBattleProjectileSample {
    const payload = projectile.payload;
    const trajectory = payload.trajectory;
    const source = payload.source;
    const trackedTarget = payload.targetEntity ? resolvePoint(payload.targetEntity) : undefined;
    const target = trajectory.kind === 'homing'
        ? trackedTarget ? trackAuthoredTargetPoint(payload.target, trackedTarget) : payload.target
        : trajectory.kind === 'continuous'
            ? trackedTarget ?? payload.target
            : payload.target;
    const delay = trajectoryLaunchDelay(payload);
    const duration = trajectoryDuration(payload);
    const raw = Number.isFinite(duration) && duration > 0
        ? clamp01((replayT - projectile.startT - delay) / duration)
        : replayT >= projectile.startT + delay ? 1 : 0;

    let motionProgress = raw;
    let worldX = source.worldX + (target.worldX - source.worldX) * raw;
    let worldY = source.worldY + (target.worldY - source.worldY) * raw;
    let rotation = Number(payload.rotation) || 0;

    if (trajectory.kind === 'linear' || trajectory.kind === 'homing') {
        motionProgress = easeProgress(raw, trajectory.ease);
        worldX = source.worldX + (target.worldX - source.worldX) * motionProgress;
        worldY = source.worldY + (target.worldY - source.worldY) * motionProgress;
        if (trajectory.kind === 'homing') {
            rotation = Math.atan2(target.worldY - source.worldY, target.worldX - source.worldX);
        }
    } else if (trajectory.kind === 'parabolic') {
        // Two-phase authored lobs use a literal rise duration (mobile mortar,
        // trebuchet, ornithopter). Defense mortar/spike shots use one
        // quadratic Bezier and therefore omit riseMs.
        const riseMs = Math.max(0, Number(trajectory.riseMs) || 0);
        if (riseMs > 0 && duration > 0 && riseMs < duration) {
            const split = riseMs / duration;
            if (raw <= split) {
                const p = clamp01(raw / split);
                const eased = 1 - (1 - p) * (1 - p);
                worldY = source.worldY + (trajectory.apexWorldY - source.worldY) * eased;
            } else {
                const p = clamp01((raw - split) / (1 - split));
                worldY = trajectory.apexWorldY + (target.worldY - trajectory.apexWorldY) * p * p;
            }
        } else {
            const inv = 1 - raw;
            worldY = inv * inv * source.worldY
                + 2 * inv * raw * trajectory.apexWorldY
                + raw * raw * target.worldY;
        }
        rotation += trajectory.spinRadians * raw;
    }

    let scale = Math.max(0.01, Number(payload.scale) || 1);
    const arcScale = Math.sin(Math.PI * raw);
    if (payload.projectile === 'mortar-shell') scale *= 0.5 + arcScale * 0.6;
    else if (payload.projectile === 'spike-ball') scale *= 0.7 + arcScale * 0.4;

    return {
        point: {
            gridX: source.gridX + (target.gridX - source.gridX) * motionProgress,
            gridY: source.gridY + (target.gridY - source.gridY) * motionProgress,
            worldX,
            worldY
        },
        ground: {
            gridX: source.gridX + (target.gridX - source.gridX) * motionProgress,
            gridY: source.gridY + (target.gridY - source.gridY) * motionProgress
        },
        progress: raw,
        rotation,
        scale
    };
}

/** Stateful, deterministic presentation facts which keyframes intentionally
 * do not carry. Keeping this pure makes late-join reconstruction testable. */
export class WorldBattlePresentationModel {
    readonly teslaCharges = new Map<string, WorldBattleTeslaCharge>();
    readonly frozenBuildings = new Map<string, WorldBattleFrozenBuilding>();
    readonly prismBeams = new Map<string, WorldBattlePrismBeam>();
    readonly spikeZones = new Map<string, WorldBattleSpikeZone>();
    readonly dragonRockets: WorldBattleDragonRocket[] = [];
    readonly lightning: WorldBattleLightning[] = [];
    readonly rings: WorldBattleRing[] = [];
    readonly flashes: WorldBattleFlash[] = [];
    readonly bursts: WorldBattleBurst[] = [];
    readonly continuousProjectiles = new Map<string, WorldBattleContinuousProjectile>();
    readonly projectiles = new Map<string, WorldBattleProjectile>();
    readonly projectileImpacts: WorldBattleProjectileImpact[] = [];

    reset(): void {
        this.teslaCharges.clear();
        this.frozenBuildings.clear();
        this.prismBeams.clear();
        this.spikeZones.clear();
        this.dragonRockets.length = 0;
        this.lightning.length = 0;
        this.rings.length = 0;
        this.flashes.length = 0;
        this.bursts.length = 0;
        this.continuousProjectiles.clear();
        this.projectiles.clear();
        this.projectileImpacts.length = 0;
    }

    applyDefenseCharge(payload: DefenseChargePayload, eventT: number, seed: number): void {
        switch (payload.phase) {
            case 'start':
                this.teslaCharges.set(payload.defense.id, {
                    defense: payload.defense,
                    target: payload.target,
                    phase: 'charging',
                    startT: eventT,
                    endT: eventT + payload.chargeMs,
                    seed
                });
                break;
            case 'complete':
                this.teslaCharges.set(payload.defense.id, {
                    defense: payload.defense,
                    target: payload.target,
                    phase: 'charged',
                    startT: eventT,
                    endT: eventT + payload.chargedVisualMs,
                    seed
                });
                break;
            case 'cancel':
            case 'visual-clear':
                this.teslaCharges.delete(payload.defense.id);
                break;
        }
    }

    applyDefenseFire(
        payload: DefenseFirePayload,
        eventId: string,
        eventT: number,
        seed: number,
        impactT: number
    ): void {
        if (payload.weapon === 'tesla') this.teslaCharges.delete(payload.defense.id);
        if (payload.weapon === 'prism') {
            this.prismBeams.set(payload.defense.id, {
                defense: payload.defense,
                target: payload.target,
                source: payload.source,
                targetPoint: payload.targetPoint,
                startT: eventT,
                // A stop ability is canonical. This finite guard also cleans
                // up a truncated live stream after more than two missed ticks.
                endT: eventT + Math.max(250, payload.fireRateMs * 2.5),
                hue: (eventT / 10) % 360,
                seed
            });
        }
        if (payload.weapon === 'spike-launcher') {
            const level = Math.max(1, payload.defense.level || 1);
            this.spikeZones.set(`fallback:${eventId}`, {
                id: `fallback:${eventId}`,
                actorId: payload.defense.id,
                at: payload.targetPoint,
                owner: payload.defense.owner,
                radiusTiles: level >= 2 ? 2.4 : 2.1,
                startT: impactT,
                endT: impactT + 3_600 + level * 400,
                seed
            });
        }
    }

    applyProjectileLaunch(
        payload: ProjectileLaunchPayload,
        eventT: number,
        seed: number,
        opts: { eventId?: string; fallback?: boolean } = {}
    ): void {
        const fallback = opts.fallback === true;
        if (!fallback) {
            // A combat.attack/defense.fire fallback can precede the explicit
            // launch by its authored windup. Retire only the matching actor,
            // target and projectile family inside that bounded release window.
            for (const [id, candidate] of this.projectiles) {
                if (!candidate.fallback) continue;
                const sameActor = candidate.payload.sourceEntity.id === payload.sourceEntity.id;
                const sameTarget = candidate.payload.targetEntity?.id === payload.targetEntity?.id;
                const sameKind = candidate.payload.projectile === payload.projectile;
                if (sameActor && sameTarget && sameKind
                    && eventT >= candidate.startT && eventT - candidate.startT <= 1_500) {
                    this.projectiles.delete(id);
                }
            }
        }
        const launchEventId = opts.eventId ?? payload.projectileId;
        this.projectiles.set(payload.projectileId, {
            id: payload.projectileId,
            launchEventId,
            payload,
            startT: eventT,
            endT: worldBattleProjectileEndT(payload, eventT),
            seed,
            fallback
        });
        if (payload.trajectory.kind === 'continuous') {
            this.continuousProjectiles.set(payload.projectileId, {
                id: payload.projectileId,
                source: payload.source,
                target: payload.target,
                targetEntity: payload.targetEntity,
                startT: eventT,
                endT: Number.POSITIVE_INFINITY,
                color: payload.projectile === 'prism-beam' ? 0xff7cf4 : 0x87edff,
                seed
            });
        }
    }

    applyProjectileImpact(payload: ProjectileImpactPayload, eventT: number, seed: number): void {
        const projectile = this.projectiles.get(payload.projectileId);
        // Some authored hits are immediate but leave a short-lived visual in
        // flight state (the 160 ms generic tracer). Keep finite projectiles
        // through their declared lifetime; ordinary shots impact at endT and
        // still retire in this exact event bucket.
        if (!projectile
            || projectile.payload.trajectory.kind === 'continuous'
            || eventT >= projectile.endT) {
            this.projectiles.delete(payload.projectileId);
        }
        this.continuousProjectiles.delete(payload.projectileId);
        const style = PRESET_STYLE[payload.style];
        this.projectileImpacts.push({
            id: `${payload.projectileId}:impact:${eventT}`,
            launchEventId: projectile?.launchEventId,
            payload,
            startT: eventT,
            endT: eventT + style.durationMs,
            seed
        });
    }

    hasImpactForLaunch(launchEventId: string | undefined, eventT: number): boolean {
        if (!launchEventId) return false;
        return this.projectileImpacts.some(impact => impact.launchEventId === launchEventId
            && Math.abs(impact.startT - eventT) <= 1);
    }

    applyAbility(
        payload: ReplayAbilityPayload,
        eventId: string,
        eventT: number,
        seed: number,
        resolvePoint: WorldBattleEntityPointResolver
    ): void {
        switch (payload.ability) {
            case 'physician-heal-pulse':
                this.addRing(eventId, payload.at, eventT, 460, 8, payload.radiusTiles * 32,
                    0.5, 3, 1, 0x8ef5b6, 0.85, true);
                break;
            case 'necromancer-summon':
                this.addRing(eventId, payload.at, eventT, 420 + payload.staggerMs * payload.summonCount,
                    5, 26, 0.5, 3, 1, 0xb08aff, 0.85, true);
                break;
            case 'siege-tower-park':
            case 'siege-tower-ramp-open':
            case 'siege-tower-ramp-close':
                this.addRing(eventId, payload.at, eventT, payload.durationMs, 5, 20,
                    0.5, 2, 1, 0xb69b74, 0.65, true);
                break;
            case 'siege-tower-ramp-hop':
                this.addFlash(eventId, payload.at, eventT, 300, 8, 0.5, 0xd8c49a, 0.65, 1.8, false);
                break;
            case 'clockwork-beetle-latch':
                this.addFlash(eventId, payload.at, eventT, Math.max(180, payload.leapMs),
                    7, 0.65, 0xffd169, 0.85, 1.7, false);
                break;
            case 'clockwork-beetle-detonate':
                this.addFlash(eventId, payload.at, eventT, 420, 15, 0.55, 0xff9a42, 0.9, 2.1, false);
                break;
            case 'stone-golem-slam':
            case 'ice-golem-slam':
                this.addRing(eventId, payload.at, eventT + payload.windupMs,
                    Math.max(300, payload.recoveryMs), 5, payload.radiusTiles * 22,
                    0.5, 3, 1,
                    payload.ability === 'ice-golem-slam' ? 0xa9ecff : 0x8c7658,
                    0.82, true);
                break;
            case 'ice-golem-freeze-burst':
                this.addRing(eventId, payload.at, eventT, 620, 6, payload.radiusTiles * 30,
                    0.5, 3, 1, 0x8edfff, 0.82, true);
                for (const target of payload.targets) {
                    this.frozenBuildings.set(target.id, {
                        building: target,
                        at: resolvePoint(target) ?? payload.at,
                        startT: eventT,
                        endT: eventT + payload.durationMs,
                        seed
                    });
                }
                break;
            case 'storm-chain': {
                const points = [payload.at, ...payload.targets.map(resolvePoint).filter(
                    (point): point is ReplayPresentationPoint => Boolean(point)
                )];
                for (let index = 1; index < points.length; index++) {
                    const startT = eventT + (index - 1) * payload.hopDelayMs;
                    this.lightning.push({
                        id: `${eventId}:${index}`,
                        points: [points[index - 1], points[index]],
                        startT,
                        endT: startT + 180,
                        color: index === 1 ? 0x00ffff : 0x00ccff,
                        width: 2,
                        alpha: 0.95,
                        seed: (seed + index) >>> 0
                    });
                }
                break;
            }
            case 'war-elephant-trample':
            case 'battering-ram-punch':
            case 'phalanx-thrust':
                this.addFlash(eventId, payload.at, eventT, payload.durationMs,
                    Math.max(7, payload.distancePx * 0.45), 0.55, 0xffb66b, 0.75, 1.5, false);
                break;
            case 'da-vinci-recoil':
            case 'da-vinci-ring-spin':
                this.addFlash(eventId, payload.at, eventT, payload.durationMs,
                    9, 0.65, 0xffd27a, 0.7, 1.6, false);
                break;
            case 'prism-beam-start':
            case 'prism-beam-tick':
                this.prismBeams.set(payload.actor.id, {
                    defense: payload.actor,
                    target: payload.target,
                    source: payload.at,
                    targetPoint: payload.target ? resolvePoint(payload.target) : undefined,
                    startT: eventT,
                    endT: Number.POSITIVE_INFINITY,
                    hue: payload.hue,
                    seed
                });
                break;
            case 'prism-beam-stop':
                this.prismBeams.delete(payload.actor.id);
                break;
            case 'dragons-breath-salvo': {
                const targets = payload.targets.map(resolvePoint).filter(
                    (point): point is ReplayPresentationPoint => Boolean(point)
                );
                if (targets.length === 0) break;
                const rng = createReplayPresentationRandom(seed);
                for (let index = 0; index < payload.salvoSize; index++) {
                    const target = targets[index % targets.length];
                    const jittered = shiftedPoint(target, (rng() - 0.5) * 2, (rng() - 0.5) * 2);
                    const launchT = eventT + index * payload.staggerMs;
                    const distance = Math.hypot(
                        jittered.worldX - payload.at.worldX,
                        jittered.worldY - (payload.at.worldY - 52)
                    );
                    this.dragonRockets.push({
                        id: `${eventId}:${index}`,
                        source: payload.at,
                        target: jittered,
                        startT: launchT,
                        endT: launchT + 230 + distance / 0.4 + rng() * 100,
                        seed: (seed + index * 0x9e3779b9) >>> 0
                    });
                }
                break;
            }
            case 'spike-zone-create': {
                for (const [id, zone] of this.spikeZones) {
                    if (id.startsWith('fallback:') && Math.abs(zone.startT - eventT) < 1_500
                        && Math.hypot(zone.at.gridX - payload.at.gridX, zone.at.gridY - payload.at.gridY) < 0.25) {
                        this.spikeZones.delete(id);
                    }
                }
                this.spikeZones.set(payload.zoneId, {
                    id: payload.zoneId,
                    actorId: payload.actor?.id,
                    at: payload.at,
                    owner: payload.owner,
                    radiusTiles: payload.radiusTiles,
                    startT: eventT,
                    endT: eventT + payload.durationMs,
                    seed
                });
                break;
            }
            case 'spike-zone-tick':
                this.addFlash(`${eventId}:tick`, payload.at, eventT, 220,
                    7, 0.6, 0xff584e, 0.8, 1.5, false);
                break;
            case 'spike-zone-expire':
                this.spikeZones.delete(payload.zoneId);
                break;
            default:
                assertNeverAbility(payload);
        }
    }

    applyStatus(payload: ReplayStatusPayload, eventT: number, seed: number): void {
        if (payload.phase === 'remove') {
            this.frozenBuildings.delete(payload.target.id);
            return;
        }
        this.frozenBuildings.set(payload.target.id, {
            building: payload.target,
            at: payload.at,
            startT: eventT,
            endT: Math.max(eventT, payload.untilT, eventT + payload.durationMs),
            seed
        });
    }

    applyFx(payload: ReplayFxPayload, eventId: string, eventT: number, seed: number): void {
        switch (payload.fx) {
            case 'preset': {
                const style = PRESET_STYLE[payload.preset];
                const duration = Math.max(1, payload.durationMs ?? style.durationMs);
                if (style.ground) {
                    this.addRing(eventId, payload.at, eventT, duration, 4,
                        payload.radius ?? style.radius, 0.5, 3, 1,
                        style.color, 0.8, true);
                } else {
                    this.addFlash(eventId, payload.at, eventT, duration,
                        payload.radius ?? style.radius, 0.6, style.color, 0.85, 1.8, false);
                }
                break;
            }
            case 'flash':
                this.addFlash(eventId, payload.at, eventT + payload.delayMs,
                    payload.durationMs, payload.radius, payload.squash,
                    payload.color, payload.alpha, payload.scaleTo, payload.depth < 1_000);
                break;
            case 'ring':
                this.addRing(eventId, payload.at, eventT + payload.delayMs,
                    payload.durationMs, payload.radiusFrom, payload.radiusTo,
                    payload.squash, payload.thicknessFrom, payload.thicknessTo,
                    payload.color, payload.alpha, payload.depth < 1_000);
                break;
            case 'burst':
                this.bursts.push({
                    id: eventId,
                    at: payload.at,
                    startT: eventT,
                    endT: eventT + payload.durationMs,
                    count: payload.count,
                    colors: payload.colors,
                    radius: payload.radius,
                    spreadX: payload.spreadX,
                    spreadY: payload.spreadY,
                    radial: payload.radial,
                    up: payload.up,
                    alpha: payload.alpha,
                    square: payload.square,
                    ground: payload.depth < 1_000,
                    seed
                });
                break;
            case 'lightning':
                this.lightning.push({
                    id: eventId,
                    points: payload.points,
                    startT: eventT,
                    endT: eventT + payload.durationMs,
                    color: payload.color,
                    width: payload.width,
                    alpha: payload.alpha,
                    seed
                });
                break;
            case 'screen-shake':
                // Ambient postcard combat never shakes the viewer's main base
                // camera. The causal impact itself is still rendered.
                break;
            default:
                assertNeverFx(payload);
        }
    }

    removeBuilding(id: string): void {
        this.teslaCharges.delete(id);
        this.frozenBuildings.delete(id);
        this.prismBeams.delete(id);
    }

    removeTroop(id: string): void {
        for (const [defenseId, beam] of this.prismBeams) {
            if (beam.target?.id === id) this.prismBeams.delete(defenseId);
        }
        for (const [projectileId, projectile] of this.continuousProjectiles) {
            if (projectile.targetEntity?.id === id) this.continuousProjectiles.delete(projectileId);
        }
    }

    prune(replayT: number): void {
        for (const [id, state] of this.teslaCharges) if (replayT > state.endT) this.teslaCharges.delete(id);
        for (const [id, state] of this.frozenBuildings) if (replayT > state.endT) this.frozenBuildings.delete(id);
        for (const [id, state] of this.prismBeams) if (replayT > state.endT) this.prismBeams.delete(id);
        for (const [id, state] of this.spikeZones) if (replayT > state.endT + 500) this.spikeZones.delete(id);
        this.pruneArray(this.dragonRockets, replayT, state => state.endT + 420);
        this.pruneArray(this.lightning, replayT, state => state.endT);
        this.pruneArray(this.rings, replayT, state => state.endT);
        this.pruneArray(this.flashes, replayT, state => state.endT);
        this.pruneArray(this.bursts, replayT, state => state.endT);
        this.pruneArray(this.projectileImpacts, replayT, state => state.endT);
        for (const [id, state] of this.projectiles) {
            if (replayT > state.endT) this.projectiles.delete(id);
        }
        for (const [id, state] of this.continuousProjectiles) {
            if (replayT > state.endT) this.continuousProjectiles.delete(id);
        }
    }

    private addRing(
        id: string,
        at: ReplayPresentationPoint,
        startT: number,
        durationMs: number,
        radiusFrom: number,
        radiusTo: number,
        squash: number,
        thicknessFrom: number,
        thicknessTo: number,
        color: number,
        alpha: number,
        ground: boolean
    ): void {
        this.rings.push({
            id, at, startT, endT: startT + Math.max(1, durationMs),
            radiusFrom, radiusTo, squash, thicknessFrom, thicknessTo,
            color, alpha, ground
        });
    }

    private addFlash(
        id: string,
        at: ReplayPresentationPoint,
        startT: number,
        durationMs: number,
        radius: number,
        squash: number,
        color: number,
        alpha: number,
        scaleTo: number,
        ground: boolean
    ): void {
        this.flashes.push({
            id, at, startT, endT: startT + Math.max(1, durationMs),
            radius, squash, color, alpha, scaleTo, ground
        });
    }

    private pruneArray<T>(items: T[], replayT: number, endT: (item: T) => number): void {
        for (let index = items.length - 1; index >= 0; index--) {
            if (replayT > endT(items[index])) items.splice(index, 1);
        }
    }
}
