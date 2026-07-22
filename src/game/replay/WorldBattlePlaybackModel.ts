import type {
    ReplayBuildingSnapshot,
    ReplayFrameSnapshot,
    ReplayTroopSnapshot
} from '../backend/GameBackend';
import {
    interpolateReplayPose,
    type ReplayTimelineSample
} from './ReplayTimeline';
import type {
    CombatAttackPayload,
    ReplayAttackStyle
} from './ReplayPresentationEvents';
import type { ReplayV2Chunk } from './ReplayPresentationStream';

export interface WorldBattleBuildingState extends ReplayBuildingSnapshot {
    maxHealth: number;
}

export interface WorldBattleTroopState extends ReplayTroopSnapshot {
    /** Exact replay time of the latest authored attack event. */
    lastAttackT?: number;
    /** Exact authored spawn time, used when the preceding keyframe did not yet
     * contain this troop (prevents joining partway along its first segment). */
    spawnT?: number;
    /** Last authored attack style, used to reproduce driven baked poses. */
    lastAttackStyle?: ReplayAttackStyle;
    /** Persistent/explicit authored pose drivers. Transient attack poses are
     * derived from lastAttackT so seek, late join, and frame rate agree. */
    slamOffset?: number;
    mortarRecoil?: number;
    parked01?: number;
    phalanxSpearOffset?: number;
    tankSpin01?: number;
}

const POSE_FIELDS = [
    'lastAttackT',
    'spawnT',
    'lastAttackStyle',
    'slamOffset',
    'mortarRecoil',
    'parked01',
    'phalanxSpearOffset',
    'tankSpin01'
] as const satisfies readonly (keyof WorldBattleTroopState)[];

export interface WorldBattleFrameTransition {
    destroyedChanged: boolean;
    newlyDestroyedBuildingIds: readonly string[];
    restoredBuildingIds: readonly string[];
    removedTroopIds: readonly string[];
}

/**
 * Stepwise authoritative state for an in-world battle postcard. Positions are
 * sampled separately from ReplayTimeline; health is deliberately NEVER
 * interpolated toward a future keyframe, because that would make a bar fall
 * before the corresponding recorded impact event.
 */
export class WorldBattlePlaybackModel {
    readonly buildings = new Map<string, WorldBattleBuildingState>();
    readonly troops = new Map<string, WorldBattleTroopState>();
    readonly destroyedBuildingIds = new Set<string>();
    frameT = -1;
    destruction = 0;

    constructor(buildingMaxHealth: ReadonlyMap<string, number> = new Map()) {
        for (const [id, maxHealth] of buildingMaxHealth) {
            const normalizedMax = Math.max(1, Number(maxHealth) || 1);
            this.buildings.set(id, {
                id,
                health: normalizedMax,
                maxHealth: normalizedMax,
                isDestroyed: false
            });
        }
    }

    applyFrame(frame: ReplayFrameSnapshot): WorldBattleFrameTransition {
        const beforeDestroyed = new Set(this.destroyedBuildingIds);
        const incomingBuildings = new Map(frame.buildings.map(building => [building.id, building]));

        // Replay frames are complete snapshots. A known building omitted from
        // one is terminal, matching MainScene.applyReplayFrame.
        for (const [id, existing] of this.buildings) {
            const incoming = incomingBuildings.get(id);
            if (!incoming) {
                existing.health = 0;
                existing.isDestroyed = true;
                this.destroyedBuildingIds.add(id);
                continue;
            }
            existing.health = Math.max(0, Math.min(existing.maxHealth, Number(incoming.health) || 0));
            existing.isDestroyed = Boolean(incoming.isDestroyed || existing.health <= 0);
            // Legacy frames omit aim. Preserve the last committed heading
            // until a newer correction or authored defense event replaces it.
            if (Number.isFinite(incoming.ballistaAngle)) {
                existing.ballistaAngle = Number(incoming.ballistaAngle);
            }
            if (existing.isDestroyed) this.destroyedBuildingIds.add(id);
            else this.destroyedBuildingIds.delete(id);
            incomingBuildings.delete(id);
        }
        for (const incoming of incomingBuildings.values()) {
            const maxHealth = Math.max(1, Number(incoming.health) || 1);
            const state: WorldBattleBuildingState = {
                ...incoming,
                health: Math.max(0, Number(incoming.health) || 0),
                maxHealth,
                isDestroyed: Boolean(incoming.isDestroyed || Number(incoming.health) <= 0)
            };
            this.buildings.set(state.id, state);
            if (state.isDestroyed) this.destroyedBuildingIds.add(state.id);
        }

        const previousTroops = new Map(this.troops);
        this.troops.clear();
        for (const snapshot of frame.troops) {
            const previous = previousTroops.get(snapshot.id);
            const next: WorldBattleTroopState = {
                ...snapshot,
                health: Math.max(0, Number(snapshot.health) || 0),
                maxHealth: Math.max(1, Number(snapshot.maxHealth) || 1)
            };
            if (previous) {
                for (const field of POSE_FIELDS) {
                    const value = previous[field];
                    if (next[field] === undefined && value !== undefined) {
                        (next as unknown as Record<string, unknown>)[field] = value;
                    }
                }
            }
            this.troops.set(snapshot.id, next);
            previousTroops.delete(snapshot.id);
        }

        this.frameT = Math.max(0, Number(frame.t) || 0);
        this.destruction = Math.max(0, Math.min(100, Number(frame.destruction) || 0));
        return this.transitionFrom(beforeDestroyed, [...previousTroops.keys()]);
    }

    spawnTroop(snapshot: ReplayTroopSnapshot, atT?: number): void {
        this.troops.set(snapshot.id, {
            ...snapshot,
            health: Math.max(0, Number(snapshot.health) || 0),
            maxHealth: Math.max(1, Number(snapshot.maxHealth) || 1),
            ...(Number.isFinite(atT) ? { spawnT: Math.max(0, Number(atT)) } : {})
        });
    }

    markTroopAttack(
        id: string,
        atT: number,
        style?: ReplayAttackStyle,
        facingAngle?: number,
        pose?: CombatAttackPayload['pose']
    ): void {
        const troop = this.troops.get(id);
        if (!troop) return;
        troop.lastAttackT = Math.max(0, Number(atT) || 0);
        if (style) troop.lastAttackStyle = style;
        if (Number.isFinite(facingAngle)) troop.facingAngle = facingAngle;
        if (pose) {
            for (const field of ['slamOffset', 'mortarRecoil', 'parked01', 'phalanxSpearOffset', 'tankSpin01'] as const) {
                const value = pose[field];
                if (Number.isFinite(value)) troop[field] = Number(value);
            }
            if (Number.isFinite(pose.visualOffsetY)) troop.visualOffsetY = Number(pose.visualOffsetY);
        }
    }

    damageEntity(
        kind: 'building' | 'troop',
        id: string,
        healthAfter: number,
        maxHealth: number
    ): WorldBattleFrameTransition {
        const beforeDestroyed = new Set(this.destroyedBuildingIds);
        if (kind === 'building') {
            const existing = this.buildings.get(id);
            const normalizedMax = Math.max(1, Number(maxHealth) || existing?.maxHealth || 1);
            const state = existing ?? { id, health: normalizedMax, maxHealth: normalizedMax, isDestroyed: false };
            state.maxHealth = normalizedMax;
            state.health = Math.max(0, Math.min(normalizedMax, Number(healthAfter) || 0));
            // Zero health and the authored collapse are distinct adjacent
            // chunks. Keep the building visible until building.destroy lands.
            this.buildings.set(id, state);
        } else {
            const troop = this.troops.get(id);
            if (troop) {
                troop.maxHealth = Math.max(1, Number(maxHealth) || troop.maxHealth);
                troop.health = Math.max(0, Math.min(troop.maxHealth, Number(healthAfter) || 0));
            }
        }
        return this.transitionFrom(beforeDestroyed, []);
    }

    healTroop(id: string, healthAfter: number, maxHealth: number): void {
        const troop = this.troops.get(id);
        if (!troop) return;
        troop.maxHealth = Math.max(1, Number(maxHealth) || troop.maxHealth);
        troop.health = Math.max(0, Math.min(troop.maxHealth, Number(healthAfter) || 0));
    }

    destroyBuilding(id: string): WorldBattleFrameTransition {
        const beforeDestroyed = new Set(this.destroyedBuildingIds);
        const existing = this.buildings.get(id);
        if (existing) {
            existing.health = 0;
            existing.isDestroyed = true;
        }
        this.destroyedBuildingIds.add(id);
        return this.transitionFrom(beforeDestroyed, []);
    }

    removeTroop(id: string): void {
        this.troops.delete(id);
    }

    private transitionFrom(
        beforeDestroyed: ReadonlySet<string>,
        removedTroopIds: readonly string[]
    ): WorldBattleFrameTransition {
        const newlyDestroyedBuildingIds = [...this.destroyedBuildingIds]
            .filter(id => !beforeDestroyed.has(id));
        const restoredBuildingIds = [...beforeDestroyed]
            .filter(id => !this.destroyedBuildingIds.has(id));
        return {
            destroyedChanged: newlyDestroyedBuildingIds.length > 0 || restoredBuildingIds.length > 0,
            newlyDestroyedBuildingIds,
            restoredBuildingIds,
            removedTroopIds
        };
    }
}

export interface SampledWorldBattleTroop extends WorldBattleTroopState {
    visualOffsetY: number;
    moving: boolean;
}

export interface WorldBattleTroopPoseDrivers {
    slamOffset: number;
    mortarRecoil: number;
    parked01: number;
    phalanxSpearOffset: number;
    tankSpin01: number;
}

/** Deterministic pose drivers for the small set of attacks whose baked shape
 * is not fully described by generic attackAge. Persistent Siege Tower parking
 * intentionally remains at 1 forever after its 700 ms ramp descent. */
export function worldBattleTroopPoseAt(
    troop: Readonly<WorldBattleTroopState>,
    replayT: number
): WorldBattleTroopPoseDrivers {
    const age = troop.lastAttackT === undefined
        ? -1
        : Math.max(0, replayT - troop.lastAttackT);
    let slamOffset = Number(troop.slamOffset) || 0;
    let parked01 = Number(troop.parked01) || 0;
    let phalanxSpearOffset = Number(troop.phalanxSpearOffset) || 0;
    if (age >= 0) {
        if (troop.lastAttackStyle === 'siege-tower-park') {
            parked01 = Math.max(parked01, Math.min(1, age / 700));
        } else if (troop.lastAttackStyle === 'stone-golem-slam'
            || troop.lastAttackStyle === 'ice-golem-slam') {
            if (age <= 200) slamOffset = 12 * (age / 200);
            else if (age < 600) {
                const release = (age - 200) / 400;
                slamOffset = troop.lastAttackStyle === 'ice-golem-slam'
                    ? 12 + 12 * release
                    : 12 * (1 - release);
            } else slamOffset = 0;
        } else if (troop.lastAttackStyle === 'phalanx-thrust' && age < 300) {
            phalanxSpearOffset = age <= 150 ? age / 150 : 1 - (age - 150) / 150;
        }
    }
    return {
        slamOffset,
        mortarRecoil: Number(troop.mortarRecoil) || 0,
        parked01,
        phalanxSpearOffset,
        tankSpin01: Number(troop.tankSpin01) || 0
    };
}

/** Pose-only interpolation. Health/type/ownership come from current stepwise state. */
export function sampleWorldBattleTroop(
    troop: Readonly<WorldBattleTroopState>,
    sample: ReplayTimelineSample<ReplayFrameSnapshot>,
    currentFacing?: number,
    deltaMs = 0
): SampledWorldBattleTroop {
    const previous = sample.previous?.frame.troops.find(candidate => candidate.id === troop.id);
    const next = sample.next?.frame.troops.find(candidate => candidate.id === troop.id);
    const from = previous ?? troop;
    const to = next ?? previous ?? troop;
    const amount = previous && next
        ? sample.alpha
        : !previous && next && troop.spawnT !== undefined
            && sample.next !== undefined && sample.next.t > troop.spawnT
            ? Math.max(0, Math.min(1, (sample.t - troop.spawnT) / (sample.next.t - troop.spawnT)))
            : 0;
    const pose = interpolateReplayPose(from, to, amount, {
        currentFacing,
        deltaMs,
        facingHalfLifeMs: 70
    });
    const fromLift = Number(from.visualOffsetY) || 0;
    const toLift = Number(to.visualOffsetY) || 0;
    const motionDistance = next
        ? Math.hypot(next.gridX - from.gridX, next.gridY - from.gridY)
        : 0;
    return {
        ...troop,
        gridX: pose.gridX,
        gridY: pose.gridY,
        facingAngle: pose.facingAngle,
        visualOffsetY: fromLift + (toLift - fromLift) * amount,
        moving: motionDistance > 0.001
    };
}

export interface ReplaySequenceCursor {
    readonly contiguous: number;
    readonly pending: ReadonlySet<number>;
}

export function createReplaySequenceCursor(contiguous = 0): ReplaySequenceCursor {
    return {
        contiguous: Math.max(0, Math.floor(Number(contiguous) || 0)),
        pending: new Set<number>()
    };
}

/** Highest contiguous receipt cursor; gaps remain requestable on the next poll. */
export function observeReplaySequences(
    cursor: ReplaySequenceCursor,
    sequences: readonly number[]
): ReplaySequenceCursor {
    let contiguous = cursor.contiguous;
    const pending = new Set(cursor.pending);
    for (const raw of sequences) {
        const sequence = Math.floor(Number(raw));
        if (Number.isSafeInteger(sequence) && sequence > contiguous) pending.add(sequence);
    }
    while (pending.delete(contiguous + 1)) contiguous += 1;
    for (const sequence of pending) {
        if (sequence <= contiguous) pending.delete(sequence);
    }
    return { contiguous, pending };
}

/** Locate the authoritative terminal correction intentionally preserved after
 * a replay-budget sequence gap. The dispatcher may skip only to this known
 * final keyframe, never across an arbitrary live gap. */
export function terminalReplayGapFrom(
    chunks: readonly ReplayV2Chunk<ReplayFrameSnapshot>[],
    contiguousBefore: number
): Extract<ReplayV2Chunk<ReplayFrameSnapshot>, { kind: 'keyframe' }> | null {
    let contiguous = Math.max(0, Math.floor(Number(contiguousBefore) || 0));
    let sawGap = false;
    let terminal: Extract<ReplayV2Chunk<ReplayFrameSnapshot>, { kind: 'keyframe' }> | null = null;
    for (const chunk of [...chunks].sort((left, right) => left.sequence - right.sequence)) {
        if (chunk.sequence <= contiguous) continue;
        if (!sawGap && chunk.sequence === contiguous + 1) contiguous = chunk.sequence;
        else if (chunk.sequence > contiguous + 1) sawGap = true;
        if (sawGap && chunk.kind === 'keyframe' && chunk.terminal === true) terminal = chunk;
    }
    return terminal;
}

/** Catch-up may suppress expired history, but never an effect still visible at
 * the join point (especially an in-flight projectile whose damage is future). */
export function presentationOverlapsReplayJoin(
    startsAt: number,
    endsAt: number,
    joinT: number
): boolean {
    return Number(endsAt) > Number(joinT) && Number(startsAt) <= Number(joinT);
}

/** Last keyframe at/before the reconstruction horizon. Starting ordered
 * dispatch here ensures launches older than the immediate join bracket can
 * still be rebuilt when their impact is pending. */
export function worldBattlePreRollBaseline<T extends { t: number }>(
    keyframes: readonly T[],
    joinT: number,
    preRollMs: number
): T {
    if (keyframes.length === 0) throw new Error('World battle pre-roll requires a keyframe');
    const threshold = Math.max(keyframes[0].t, joinT - Math.max(0, preRollMs));
    let baseline = keyframes[0];
    for (const candidate of keyframes) {
        if (candidate.t > threshold) break;
        baseline = candidate;
    }
    return baseline;
}
