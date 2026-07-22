import type { ReplayPresentationEvent } from './ReplayPresentationEvents';
import type { ReplayV2Chunk } from './ReplayTypes';

export type ReplayClockMode = 'paused' | 'recorded' | 'live';
export type ReplayTimestampMode = 'legacy' | 'v2-relative' | 'v2-absolute';

export interface ReplayTimelineOptions {
    timestampMode?: ReplayTimestampMode;
    /** Fixed origin for absolute v2 timestamps or an explicitly pinned legacy origin. */
    originMs?: number;
    clockMode?: ReplayClockMode;
    playbackRate?: number;
    minimumLiveDelayMs?: number;
    maximumLiveDelayMs?: number;
    liveGapPercentile?: number;
    liveGapMarginMs?: number;
    liveGapMarginRatio?: number;
    observedGapWindow?: number;
    liveCatchupWindowMs?: number;
    liveMinimumRate?: number;
    liveMaximumRate?: number;
    liveDryBufferMs?: number;
}

export interface ReplayTimelineKeyframe<TFrame> {
    readonly t: number;
    readonly rawT: number;
    readonly sequence?: number;
    readonly terminal: boolean;
    readonly frame: TFrame;
}

export interface ReplayTimelineEvent<TEvent> {
    readonly t: number;
    readonly rawT: number;
    readonly sequence: number;
    readonly event: TEvent;
}

export interface ReplayTimelineSample<TFrame> {
    readonly t: number;
    readonly previous?: ReplayTimelineKeyframe<TFrame>;
    readonly next?: ReplayTimelineKeyframe<TFrame>;
    /** 0..1 position between previous and next. */
    readonly alpha: number;
}

export interface ReplayTimelineStep<TFrame, TEvent> {
    readonly fromT: number;
    readonly toT: number;
    readonly effectiveRate: number;
    readonly sample: ReplayTimelineSample<TFrame>;
    /** Ordered events crossed in (fromT, toT]. */
    readonly events: readonly ReplayTimelineEvent<TEvent>[];
    readonly complete: boolean;
}

export interface ReplayIngestResult {
    readonly accepted: number;
    readonly duplicates: number;
    readonly lastV2Sequence: number;
    readonly headT: number;
}

export interface LiveJitterDelayOptions {
    minimumDelayMs?: number;
    maximumDelayMs?: number;
    percentile?: number;
    marginMs?: number;
    marginRatio?: number;
}

export interface ReplayGridPose {
    gridX: number;
    gridY: number;
    facingAngle?: number;
}

export interface ReplayPoseInterpolationOptions {
    /** Optional prior rendered facing for exponential, frame-rate-independent damping. */
    currentFacing?: number;
    deltaMs?: number;
    facingHalfLifeMs?: number;
}

const DEFAULT_MINIMUM_LIVE_DELAY_MS = 1500;
const DEFAULT_MAXIMUM_LIVE_DELAY_MS = 10_000;
const DEFAULT_GAP_PERCENTILE = 0.95;
const DEFAULT_GAP_MARGIN_MS = 350;
const DEFAULT_GAP_MARGIN_RATIO = 0.25;
const DEFAULT_GAP_WINDOW = 32;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function finiteNumber(value: number, label: string): number {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
    return value;
}

function validSequence(sequence: number): number {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error('Replay-v2 sequence must be a non-negative safe integer');
    }
    return sequence;
}

/**
 * Recommended live delay from capture-time gaps. The safety margin is always
 * above the selected gap, preventing a 2 s producer cadence from running a
 * 1.5 s buffer dry even before network jitter is considered.
 */
export function computeLiveJitterDelay(
    observedGapsMs: readonly number[],
    options: LiveJitterDelayOptions = {}
): number {
    const minimum = Math.max(0, options.minimumDelayMs ?? DEFAULT_MINIMUM_LIVE_DELAY_MS);
    const maximum = Math.max(minimum, options.maximumDelayMs ?? DEFAULT_MAXIMUM_LIVE_DELAY_MS);
    const percentile = clamp(options.percentile ?? DEFAULT_GAP_PERCENTILE, 0, 1);
    const marginMs = Math.max(0, options.marginMs ?? DEFAULT_GAP_MARGIN_MS);
    const marginRatio = Math.max(0, options.marginRatio ?? DEFAULT_GAP_MARGIN_RATIO);
    const gaps = observedGapsMs
        .filter(gap => Number.isFinite(gap) && gap > 0)
        .slice()
        .sort((a, b) => a - b);
    if (gaps.length === 0) return minimum;

    const index = Math.max(0, Math.ceil(percentile * gaps.length) - 1);
    const selectedGap = gaps[index];
    const margin = Math.max(marginMs, selectedGap * marginRatio);
    return clamp(selectedGap + margin, minimum, maximum);
}

/** Normalize an angle to [-PI, PI). */
export function wrapFacingAngle(angle: number): number {
    const tau = Math.PI * 2;
    return ((angle + Math.PI) % tau + tau) % tau - Math.PI;
}

/** Shortest-arc facing interpolation. */
export function interpolateWrappedFacing(from: number, to: number, alpha: number): number {
    return wrapFacingAngle(from + wrapFacingAngle(to - from) * clamp(alpha, 0, 1));
}

/**
 * Exponential facing damping expressed as a half-life, so 30/60/120 FPS
 * converge to the same angle after the same elapsed time.
 */
export function dampWrappedFacing(
    current: number,
    target: number,
    deltaMs: number,
    halfLifeMs = 70
): number {
    finiteNumber(deltaMs, 'deltaMs');
    if (deltaMs <= 0) return wrapFacingAngle(current);
    if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return wrapFacingAngle(target);
    const alpha = 1 - Math.pow(0.5, deltaMs / halfLifeMs);
    return interpolateWrappedFacing(current, target, alpha);
}

/** Position interpolation plus a single, wrapped facing driver. */
export function interpolateReplayPose(
    previous: Readonly<ReplayGridPose>,
    next: Readonly<ReplayGridPose>,
    alpha: number,
    options: ReplayPoseInterpolationOptions = {}
): ReplayGridPose {
    const amount = clamp(alpha, 0, 1);
    const previousFacing = previous.facingAngle;
    const nextFacing = next.facingAngle;
    let facingAngle: number | undefined;
    if (previousFacing !== undefined && nextFacing !== undefined) {
        facingAngle = interpolateWrappedFacing(previousFacing, nextFacing, amount);
    } else {
        facingAngle = nextFacing ?? previousFacing;
    }
    if (facingAngle !== undefined && options.currentFacing !== undefined) {
        facingAngle = dampWrappedFacing(
            options.currentFacing,
            facingAngle,
            options.deltaMs ?? 0,
            options.facingHalfLifeMs
        );
    }
    return {
        gridX: previous.gridX + (next.gridX - previous.gridX) * amount,
        gridY: previous.gridY + (next.gridY - previous.gridY) * amount,
        ...(facingAngle === undefined ? {} : { facingAngle })
    };
}

interface StoredLegacyFrame<TFrame> {
    rawT: number;
    frame: TFrame;
}

interface StoredV2Chunk<TFrame, TEvent> {
    rawT: number;
    chunk: ReplayV2Chunk<TFrame, TEvent>;
}

/**
 * Pure replay-v2 ordering, clock, and interpolation core. It has no Phaser or
 * transport dependency; callers feed legacy frames or additive v2 chunks.
 */
export class ReplayTimeline<TFrame, TEvent = ReplayPresentationEvent> {
    private readonly timestampMode: ReplayTimestampMode;
    private readonly fixedOriginMs?: number;
    private legacyOriginMs?: number;
    private readonly legacyFramesByRawT = new Map<number, StoredLegacyFrame<TFrame>>();
    private readonly v2ChunksBySequence = new Map<number, StoredV2Chunk<TFrame, TEvent>>();
    private orderedKeyframes: ReplayTimelineKeyframe<TFrame>[] = [];
    private orderedEvents: ReplayTimelineEvent<TEvent>[] = [];
    private clockMode: ReplayClockMode;
    private playbackRate: number;
    private clockT = 0;

    private readonly minimumLiveDelayMs: number;
    private readonly maximumLiveDelayMs: number;
    private readonly liveGapPercentile: number;
    private readonly liveGapMarginMs: number;
    private readonly liveGapMarginRatio: number;
    private readonly observedGapWindow: number;
    private readonly liveCatchupWindowMs: number;
    private readonly liveMinimumRate: number;
    private readonly liveMaximumRate: number;
    private readonly liveDryBufferMs: number;

    constructor(options: ReplayTimelineOptions = {}) {
        this.timestampMode = options.timestampMode ?? 'v2-relative';
        if (options.originMs !== undefined) finiteNumber(options.originMs, 'originMs');
        if (this.timestampMode === 'v2-absolute' && options.originMs === undefined) {
            throw new Error('v2-absolute replay timestamps require originMs');
        }
        this.fixedOriginMs = options.originMs;
        this.legacyOriginMs = this.timestampMode === 'legacy' ? options.originMs : undefined;
        this.clockMode = options.clockMode ?? 'recorded';
        this.playbackRate = Math.max(0, finiteNumber(options.playbackRate ?? 1, 'playbackRate'));

        this.minimumLiveDelayMs = Math.max(0, options.minimumLiveDelayMs ?? DEFAULT_MINIMUM_LIVE_DELAY_MS);
        this.maximumLiveDelayMs = Math.max(
            this.minimumLiveDelayMs,
            options.maximumLiveDelayMs ?? DEFAULT_MAXIMUM_LIVE_DELAY_MS
        );
        this.liveGapPercentile = clamp(options.liveGapPercentile ?? DEFAULT_GAP_PERCENTILE, 0, 1);
        this.liveGapMarginMs = Math.max(0, options.liveGapMarginMs ?? DEFAULT_GAP_MARGIN_MS);
        this.liveGapMarginRatio = Math.max(0, options.liveGapMarginRatio ?? DEFAULT_GAP_MARGIN_RATIO);
        this.observedGapWindow = Math.max(1, Math.floor(options.observedGapWindow ?? DEFAULT_GAP_WINDOW));
        this.liveCatchupWindowMs = Math.max(1, options.liveCatchupWindowMs ?? 4000);
        this.liveMinimumRate = Math.max(0, options.liveMinimumRate ?? 0.85);
        this.liveMaximumRate = Math.max(this.liveMinimumRate, options.liveMaximumRate ?? 1.15);
        this.liveDryBufferMs = Math.max(1, options.liveDryBufferMs ?? 350);
    }

    get mode(): ReplayClockMode {
        return this.clockMode;
    }

    get time(): number {
        return this.clockT;
    }

    get headT(): number {
        const keyframeHead = this.orderedKeyframes.at(-1)?.t ?? 0;
        const eventHead = this.orderedEvents.at(-1)?.t ?? 0;
        return Math.max(keyframeHead, eventHead);
    }

    get keyframeHeadT(): number {
        return this.orderedKeyframes.at(-1)?.t ?? this.headT;
    }

    get lastV2Sequence(): number {
        let last = 0;
        for (const sequence of this.v2ChunksBySequence.keys()) last = Math.max(last, sequence);
        return last;
    }

    get terminalT(): number | undefined {
        let terminal: number | undefined;
        for (const keyframe of this.orderedKeyframes) {
            if (keyframe.terminal) terminal = keyframe.t;
        }
        return terminal;
    }

    get complete(): boolean {
        const terminal = this.terminalT;
        return terminal !== undefined && this.clockT >= terminal && this.clockT >= this.headT;
    }

    get keyframes(): readonly ReplayTimelineKeyframe<TFrame>[] {
        return this.orderedKeyframes;
    }

    get events(): readonly ReplayTimelineEvent<TEvent>[] {
        return this.orderedEvents;
    }

    get observedKeyframeGapsMs(): readonly number[] {
        const gaps: number[] = [];
        const start = Math.max(1, this.orderedKeyframes.length - this.observedGapWindow);
        for (let index = start; index < this.orderedKeyframes.length; index++) {
            const gap = this.orderedKeyframes[index].t - this.orderedKeyframes[index - 1].t;
            if (gap > 0) gaps.push(gap);
        }
        return gaps;
    }

    get recommendedLiveDelayMs(): number {
        return computeLiveJitterDelay(this.observedKeyframeGapsMs, {
            minimumDelayMs: this.minimumLiveDelayMs,
            maximumDelayMs: this.maximumLiveDelayMs,
            percentile: this.liveGapPercentile,
            marginMs: this.liveGapMarginMs,
            marginRatio: this.liveGapMarginRatio
        });
    }

    setMode(mode: ReplayClockMode): void {
        this.clockMode = mode;
    }

    setPlaybackRate(rate: number): void {
        this.playbackRate = Math.max(0, finiteNumber(rate, 'playbackRate'));
    }

    /** Current normalized time for a raw legacy/v2 timestamp. */
    normalizeTimestamp(rawT: number): number {
        finiteNumber(rawT, 'Replay timestamp');
        if (this.timestampMode === 'v2-relative') return Math.max(0, rawT);
        const origin = this.timestampMode === 'v2-absolute'
            ? this.fixedOriginMs
            : (this.fixedOriginMs ?? this.legacyOriginMs ?? rawT);
        return Math.max(0, rawT - (origin ?? 0));
    }

    /** Adapter for existing ReplayFrameSnapshot[] payloads. */
    ingestLegacyKeyframes<TLegacyFrame extends TFrame & { t: number }>(
        frames: readonly TLegacyFrame[]
    ): ReplayIngestResult {
        if (frames.length === 0) return this.ingestResult(0, 0);
        const rawTimes = frames.map(frame => finiteNumber(frame.t, 'Legacy replay timestamp'));
        this.observeLegacyOrigin(rawTimes);

        let accepted = 0;
        let duplicates = 0;
        frames.forEach((frame, index) => {
            const rawT = rawTimes[index];
            if (this.legacyFramesByRawT.has(rawT)) {
                duplicates++;
                return;
            }
            this.legacyFramesByRawT.set(rawT, { rawT, frame });
            accepted++;
        });
        if (accepted > 0) this.rebuildOrderedEntries();
        return this.ingestResult(accepted, duplicates);
    }

    /** Direct adapter for GET replayVersion:2 `v2Chunks`. */
    ingestV2Chunks(chunks: readonly ReplayV2Chunk<TFrame, TEvent>[]): ReplayIngestResult {
        let accepted = 0;
        let duplicates = 0;
        for (const chunk of chunks) {
            const sequence = validSequence(chunk.sequence);
            const rawT = finiteNumber(chunk.t, 'Replay-v2 timestamp');
            const existing = this.v2ChunksBySequence.get(sequence);
            if (existing) {
                if (existing.rawT !== rawT || existing.chunk.kind !== chunk.kind) {
                    throw new Error(`Conflicting replay-v2 chunk sequence ${sequence}`);
                }
                duplicates++;
                continue;
            }
            this.v2ChunksBySequence.set(sequence, { rawT, chunk });
            accepted++;
        }
        if (accepted > 0) this.rebuildOrderedEntries();
        return this.ingestResult(accepted, duplicates);
    }

    seek(t: number): ReplayTimelineSample<TFrame> {
        this.clockT = clamp(finiteNumber(t, 'Replay seek time'), 0, this.headT);
        return this.sample(this.clockT);
    }

    /** Join the latest safely buffered point rather than racing replay head. */
    seekLiveEdge(): ReplayTimelineSample<TFrame> {
        this.clockT = Math.max(0, this.keyframeHeadT - this.recommendedLiveDelayMs);
        return this.sample(this.clockT);
    }

    sample(t = this.clockT): ReplayTimelineSample<TFrame> {
        const sampleT = clamp(finiteNumber(t, 'Replay sample time'), 0, this.headT);
        const upper = this.upperBoundKeyframe(sampleT);
        const previous = upper > 0 ? this.orderedKeyframes[upper - 1] : undefined;
        const next = upper < this.orderedKeyframes.length ? this.orderedKeyframes[upper] : undefined;
        let alpha = 0;
        if (previous && next && next.t > previous.t) {
            alpha = clamp((sampleT - previous.t) / (next.t - previous.t), 0, 1);
        } else if (previous && !next) {
            alpha = 1;
        }
        return { t: sampleT, previous, next, alpha };
    }

    eventsBetween(fromExclusive: number, toInclusive: number): readonly ReplayTimelineEvent<TEvent>[] {
        finiteNumber(fromExclusive, 'Replay event range start');
        finiteNumber(toInclusive, 'Replay event range end');
        if (toInclusive <= fromExclusive) return [];
        const start = this.upperBoundEvent(fromExclusive);
        const result: ReplayTimelineEvent<TEvent>[] = [];
        for (let index = start; index < this.orderedEvents.length; index++) {
            const event = this.orderedEvents[index];
            if (event.t > toInclusive) break;
            result.push(event);
        }
        return result;
    }

    /**
     * Sequence-aware event reconciliation for baseline seeks and late chunk
     * arrival. Consumers keep the greatest dispatched sequence and ask for all
     * events now due; unlike a time-only cursor this cannot lose an event that
     * arrives exactly at the current replay time.
     */
    eventsDue(atT = this.clockT, afterSequence = -1): readonly ReplayTimelineEvent<TEvent>[] {
        const dueT = clamp(finiteNumber(atT, 'Replay due-event time'), 0, this.headT);
        if (!Number.isSafeInteger(afterSequence) || afterSequence < -1) {
            throw new Error('afterSequence must be a safe integer greater than or equal to -1');
        }
        return this.orderedEvents.filter(event => event.t <= dueT && event.sequence > afterSequence);
    }

    advance(deltaMs: number): ReplayTimelineStep<TFrame, TEvent> {
        finiteNumber(deltaMs, 'Replay delta');
        if (deltaMs < 0) throw new Error('Replay delta must be non-negative');
        const fromT = this.clockT;
        let effectiveRate = 0;

        if (this.clockMode === 'recorded') {
            effectiveRate = this.playbackRate;
            this.clockT = Math.min(this.headT, this.clockT + deltaMs * effectiveRate);
        } else if (this.clockMode === 'live') {
            const head = this.keyframeHeadT;
            const lead = Math.max(0, head - this.clockT);
            const desiredLead = this.recommendedLiveDelayMs;
            const correctedRate = clamp(
                this.playbackRate + (lead - desiredLead) / this.liveCatchupWindowMs,
                this.liveMinimumRate,
                this.liveMaximumRate
            );
            const fuel = clamp(lead / this.liveDryBufferMs, 0, 1);
            const smoothFuel = fuel * fuel * (3 - 2 * fuel);
            effectiveRate = correctedRate * smoothFuel;
            this.clockT = Math.min(head, this.clockT + deltaMs * effectiveRate);
        }

        return {
            fromT,
            toT: this.clockT,
            effectiveRate,
            sample: this.sample(this.clockT),
            events: this.eventsBetween(fromT, this.clockT),
            complete: this.complete
        };
    }

    private observeLegacyOrigin(rawTimes: readonly number[]): void {
        if (this.timestampMode !== 'legacy' || this.fixedOriginMs !== undefined || rawTimes.length === 0) return;
        const candidate = Math.min(...rawTimes);
        const previous = this.legacyOriginMs;
        if (previous !== undefined && candidate >= previous) return;

        // Preserve the same raw playback instant if an older legacy frame is
        // discovered out of order and moves the normalization origin earlier.
        const rawClock = previous === undefined ? candidate : previous + this.clockT;
        this.legacyOriginMs = candidate;
        this.clockT = Math.max(0, rawClock - candidate);
        if (previous !== undefined) this.rebuildOrderedEntries();
    }

    private rebuildOrderedEntries(): void {
        const keyframes: ReplayTimelineKeyframe<TFrame>[] = [];
        const events: ReplayTimelineEvent<TEvent>[] = [];

        for (const stored of this.legacyFramesByRawT.values()) {
            keyframes.push({
                t: this.normalizeTimestamp(stored.rawT),
                rawT: stored.rawT,
                terminal: false,
                frame: stored.frame
            });
        }
        for (const stored of this.v2ChunksBySequence.values()) {
            const { chunk, rawT } = stored;
            const t = this.normalizeTimestamp(rawT);
            if (chunk.kind === 'keyframe') {
                keyframes.push({
                    t,
                    rawT,
                    sequence: chunk.sequence,
                    terminal: Boolean(chunk.terminal),
                    frame: chunk.frame
                });
            } else {
                events.push({ t, rawT, sequence: chunk.sequence, event: chunk.event });
            }
        }
        keyframes.sort((a, b) => a.t - b.t || (a.sequence ?? -1) - (b.sequence ?? -1));
        events.sort((a, b) => a.t - b.t || a.sequence - b.sequence);
        this.orderedKeyframes = keyframes;
        this.orderedEvents = events;
        this.clockT = clamp(this.clockT, 0, this.headT);
    }

    private ingestResult(accepted: number, duplicates: number): ReplayIngestResult {
        return { accepted, duplicates, lastV2Sequence: this.lastV2Sequence, headT: this.headT };
    }

    private upperBoundKeyframe(t: number): number {
        let low = 0;
        let high = this.orderedKeyframes.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (this.orderedKeyframes[mid].t <= t) low = mid + 1;
            else high = mid;
        }
        return low;
    }

    private upperBoundEvent(t: number): number {
        let low = 0;
        let high = this.orderedEvents.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (this.orderedEvents[mid].t <= t) low = mid + 1;
            else high = mid;
        }
        return low;
    }
}
