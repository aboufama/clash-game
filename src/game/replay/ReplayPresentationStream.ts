import {
    REPLAY_PRESENTATION_EVENT_VERSION,
    type ReplayPresentationEvent,
    type ReplayPresentationEventDraft,
    type ReplayPresentationEventOf,
    type ReplayPresentationEventPayloadMap,
    type ReplayPresentationEventType
} from './ReplayPresentationEvents';
import type {
    ReplayV2Chunk as ReplayV2WireChunk,
    ReplayV2EventChunk,
    ReplayV2KeyframeChunk
} from './ReplayTypes';

export type ReplayPresentationEventChunk = ReplayV2EventChunk<ReplayPresentationEvent>;

export type ReplayPresentationKeyframeChunk<TFrame> = ReplayV2KeyframeChunk<TFrame>;

/** Exact replay-v2 wire shape. Chunks are globally ordered by sequence. */
export type ReplayV2Chunk<TFrame> = ReplayV2WireChunk<TFrame, ReplayPresentationEvent>;

export interface ReplayPresentationRecorderOptions {
    streamId: string;
    initialSequence?: number;
    maxChunks?: number;
    maxApproxBytes?: number;
    maxAgeMs?: number;
}

const DEFAULT_MAX_CHUNKS = 2_048;
const DEFAULT_MAX_APPROX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;

function requireNonNegativeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${label} must be a non-negative safe integer`);
    }
    return value;
}

function requirePositiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer`);
    }
    return value;
}

function normalizeReplayTime(t: number): number {
    if (!Number.isFinite(t) || t < 0) {
        throw new RangeError('Replay chunk time must be a finite non-negative number');
    }
    return Math.floor(t);
}

/** Stable FNV-1a over UTF-16 code units; identical in browser and Node. */
export function replayPresentationHash(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        const code = input.charCodeAt(i);
        hash ^= code & 0xff;
        hash = Math.imul(hash, 0x01000193);
        hash ^= code >>> 8;
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export function replayPresentationEventIdentity(
    streamId: string,
    sequence: number,
    t: number,
    type: ReplayPresentationEventType
): { id: string; seed: number } {
    const identity = `${streamId}\u0000${sequence}\u0000${t}\u0000${type}`;
    const idHash = replayPresentationHash(identity);
    const seed = replayPresentationHash(`${identity}\u0000seed`) || 0x6d2b79f5;
    return {
        id: `pe_${sequence.toString(36)}_${idHash.toString(16).padStart(8, '0')}`,
        seed
    };
}

/** Small deterministic PRNG for every jitter/debris branch owned by an event. */
export function createReplayPresentationRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
}

function approximateJsonBytes(value: unknown): number {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : serialized.length * 2;
}

export class ReplayPresentationRecorder<TFrame> {
    private readonly streamId: string;
    private readonly maxChunks: number;
    private readonly maxApproxBytes: number;
    private readonly maxAgeMs: number;
    private readonly chunks: ReplayV2Chunk<TFrame>[] = [];
    private readonly chunkBytes: number[] = [];
    private nextSequence: number;
    private totalApproxBytes = 0;
    private lastT = -1;

    constructor(options: ReplayPresentationRecorderOptions) {
        if (!options.streamId) throw new Error('Replay presentation streamId is required');
        this.streamId = options.streamId;
        // The wire protocol reserves sequence 0 as the "nothing acknowledged"
        // cursor; real replay-v2 chunks are one-based.
        this.nextSequence = requirePositiveInteger(options.initialSequence ?? 1, 'initialSequence');
        this.maxChunks = requirePositiveInteger(options.maxChunks ?? DEFAULT_MAX_CHUNKS, 'maxChunks');
        this.maxApproxBytes = requirePositiveInteger(
            options.maxApproxBytes ?? DEFAULT_MAX_APPROX_BYTES,
            'maxApproxBytes'
        );
        this.maxAgeMs = requirePositiveInteger(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, 'maxAgeMs');
    }

    recordEvent(t: number, draft: ReplayPresentationEventDraft): ReplayPresentationEventChunk {
        const normalizedT = this.prepareAppend(t);
        const sequence = this.allocateSequence();
        const identity = replayPresentationEventIdentity(this.streamId, sequence, normalizedT, draft.type);
        const event = {
            version: REPLAY_PRESENTATION_EVENT_VERSION,
            id: identity.id,
            seed: identity.seed,
            type: draft.type,
            payload: draft.payload
        } as ReplayPresentationEvent;
        const chunk: ReplayPresentationEventChunk = {
            sequence,
            t: normalizedT,
            kind: 'event',
            event
        };
        this.append(chunk);
        return chunk;
    }

    recordKeyframe(t: number, frame: TFrame, terminal?: boolean): ReplayPresentationKeyframeChunk<TFrame> {
        const normalizedT = this.prepareAppend(t);
        const chunk: ReplayPresentationKeyframeChunk<TFrame> = {
            sequence: this.allocateSequence(),
            t: normalizedT,
            kind: 'keyframe',
            ...(terminal === undefined ? {} : { terminal }),
            frame
        };
        this.append(chunk);
        return chunk;
    }

    /** Buffered chunks after a server acknowledgement, in global sequence order. */
    chunksAfter(sequence: number): readonly ReplayV2Chunk<TFrame>[] {
        requireNonNegativeInteger(sequence, 'sequence');
        return this.chunks.filter(chunk => chunk.sequence > sequence);
    }

    snapshot(): readonly ReplayV2Chunk<TFrame>[] {
        return this.chunks.slice();
    }

    get firstBufferedSequence(): number | undefined {
        return this.chunks[0]?.sequence;
    }

    get lastSequence(): number {
        return this.nextSequence - 1;
    }

    get bufferedApproxBytes(): number {
        return this.totalApproxBytes;
    }

    private prepareAppend(t: number): number {
        const normalizedT = normalizeReplayTime(t);
        if (normalizedT < this.lastT) {
            throw new RangeError(`Replay chunk time ${normalizedT} precedes ${this.lastT}`);
        }
        this.lastT = normalizedT;
        return normalizedT;
    }

    private allocateSequence(): number {
        if (!Number.isSafeInteger(this.nextSequence)) {
            throw new RangeError('Replay presentation sequence overflow');
        }
        const sequence = this.nextSequence;
        this.nextSequence += 1;
        return sequence;
    }

    private append(chunk: ReplayV2Chunk<TFrame>): void {
        const bytes = approximateJsonBytes(chunk);
        this.chunks.push(chunk);
        this.chunkBytes.push(bytes);
        this.totalApproxBytes += bytes;
        this.prune(chunk.t);
    }

    private prune(headT: number): void {
        const oldestAllowedT = Math.max(0, headT - this.maxAgeMs);
        while (this.chunks.length > 1) {
            const exceedsCount = this.chunks.length > this.maxChunks;
            const exceedsBytes = this.totalApproxBytes > this.maxApproxBytes;
            const exceedsAge = (this.chunks[0]?.t ?? headT) < oldestAllowedT;
            if (!exceedsCount && !exceedsBytes && !exceedsAge) break;
            this.chunks.shift();
            this.totalApproxBytes -= this.chunkBytes.shift() ?? 0;
        }
    }
}

export interface ReplayPresentationDispatchContext<TFrame> {
    chunk: ReplayPresentationEventChunk;
    random: () => number;
    /** Latest keyframe observed before this event, if the caller retained it. */
    latestKeyframe?: ReplayPresentationKeyframeChunk<TFrame>;
}

export type ReplayPresentationHandlerMap<TFrame> = Partial<{
    [K in ReplayPresentationEventType]: (
        event: ReplayPresentationEventOf<K>,
        context: ReplayPresentationDispatchContext<TFrame>
    ) => void;
}>;

export interface ReplayPresentationDispatcherOptions<TFrame> {
    handlers?: ReplayPresentationHandlerMap<TFrame>;
    onEvent?: (
        event: ReplayPresentationEvent,
        context: ReplayPresentationDispatchContext<TFrame>
    ) => void;
    /** Runs immediately before each due chunk. Replay surfaces use this to
     * drain presentation callbacks whose recorded contact time precedes the
     * authoritative damage/death chunk at the same timestamp. */
    beforeChunk?: (chunk: ReplayV2Chunk<TFrame>) => void;
    onKeyframe?: (chunk: ReplayPresentationKeyframeChunk<TFrame>) => void;
    initialSequence?: number;
    maxPendingChunks?: number;
    maxRememberedEventIds?: number;
}

export interface ReplayPresentationDispatchResult {
    dispatchedEvents: number;
    appliedKeyframes: number;
    nextSequence?: number;
}

/**
 * Ordered, duplicate-safe playback seam. Network batches may overlap or
 * arrive out of order; dispatch waits for the next global sequence and the
 * replay playhead before invoking presentation handlers.
 */
export class ReplayPresentationDispatcher<TFrame> {
    private readonly handlers: ReplayPresentationHandlerMap<TFrame>;
    private readonly onEvent?: ReplayPresentationDispatcherOptions<TFrame>['onEvent'];
    private readonly beforeChunk?: ReplayPresentationDispatcherOptions<TFrame>['beforeChunk'];
    private readonly onKeyframe?: ReplayPresentationDispatcherOptions<TFrame>['onKeyframe'];
    private readonly maxPendingChunks: number;
    private readonly maxRememberedEventIds: number;
    private readonly pending = new Map<number, ReplayV2Chunk<TFrame>>();
    private readonly rememberedEventIds = new Set<string>();
    private readonly rememberedEventIdOrder: string[] = [];
    private nextSequence: number | undefined;
    private latestKeyframe: ReplayPresentationKeyframeChunk<TFrame> | undefined;

    constructor(options: ReplayPresentationDispatcherOptions<TFrame> = {}) {
        this.handlers = options.handlers ?? {};
        this.onEvent = options.onEvent;
        this.beforeChunk = options.beforeChunk;
        this.onKeyframe = options.onKeyframe;
        this.nextSequence = requirePositiveInteger(options.initialSequence ?? 1, 'initialSequence');
        this.maxPendingChunks = requirePositiveInteger(options.maxPendingChunks ?? 4_096, 'maxPendingChunks');
        this.maxRememberedEventIds = requirePositiveInteger(
            options.maxRememberedEventIds ?? 8_192,
            'maxRememberedEventIds'
        );
    }

    ingest(chunks: readonly ReplayV2Chunk<TFrame>[]): void {
        let minimumNewSequence: number | undefined;
        for (const chunk of chunks) {
            requireNonNegativeInteger(chunk.sequence, 'chunk.sequence');
            normalizeReplayTime(chunk.t);
            if (this.nextSequence !== undefined && chunk.sequence < this.nextSequence) continue;
            if (!this.pending.has(chunk.sequence)) {
                this.pending.set(chunk.sequence, chunk);
                minimumNewSequence = minimumNewSequence === undefined
                    ? chunk.sequence
                    : Math.min(minimumNewSequence, chunk.sequence);
            }
        }
        if (this.nextSequence === undefined && minimumNewSequence !== undefined) {
            this.nextSequence = minimumNewSequence;
        }
        if (this.pending.size > this.maxPendingChunks) {
            throw new RangeError(`Replay presentation pending buffer exceeded ${this.maxPendingChunks} chunks`);
        }
    }

    dispatchThrough(playheadT: number): ReplayPresentationDispatchResult {
        const normalizedPlayheadT = normalizeReplayTime(playheadT);
        let dispatchedEvents = 0;
        let appliedKeyframes = 0;

        while (this.nextSequence !== undefined) {
            const chunk = this.pending.get(this.nextSequence);
            if (!chunk || chunk.t > normalizedPlayheadT) break;
            this.beforeChunk?.(chunk);

            if (chunk.kind === 'keyframe') {
                this.latestKeyframe = chunk;
                this.onKeyframe?.(chunk);
                appliedKeyframes += 1;
            } else if (!this.rememberedEventIds.has(chunk.event.id)) {
                const context: ReplayPresentationDispatchContext<TFrame> = {
                    chunk,
                    random: createReplayPresentationRandom(chunk.event.seed),
                    ...(this.latestKeyframe === undefined ? {} : { latestKeyframe: this.latestKeyframe })
                };
                this.dispatchTyped(chunk.event, context);
                this.onEvent?.(chunk.event, context);
                // Commit dedupe state only after every handler succeeds. A
                // thrown presenter leaves the chunk pending for a safe retry.
                this.rememberEventId(chunk.event.id);
                dispatchedEvents += 1;
            }

            this.pending.delete(this.nextSequence);
            this.nextSequence += 1;
        }

        return {
            dispatchedEvents,
            appliedKeyframes,
            ...(this.nextSequence === undefined ? {} : { nextSequence: this.nextSequence })
        };
    }

    /** Reset ordering/dedupe state when seeking to an authoritative keyframe. */
    reset(nextSequence?: number): void {
        this.pending.clear();
        this.rememberedEventIds.clear();
        this.rememberedEventIdOrder.length = 0;
        this.latestKeyframe = undefined;
        this.nextSequence = requirePositiveInteger(nextSequence ?? 1, 'nextSequence');
    }

    private dispatchTyped(
        event: ReplayPresentationEvent,
        context: ReplayPresentationDispatchContext<TFrame>
    ): void {
        const handler = this.handlers[event.type] as
            | ((typedEvent: ReplayPresentationEvent, typedContext: ReplayPresentationDispatchContext<TFrame>) => void)
            | undefined;
        handler?.(event, context);
    }

    private rememberEventId(id: string): void {
        this.rememberedEventIds.add(id);
        this.rememberedEventIdOrder.push(id);
        while (this.rememberedEventIdOrder.length > this.maxRememberedEventIds) {
            const oldest = this.rememberedEventIdOrder.shift();
            if (oldest !== undefined) this.rememberedEventIds.delete(oldest);
        }
    }
}

/** Convenience helper for callers that want a type-narrowed event draft. */
export function replayPresentationEvent<K extends ReplayPresentationEventType>(
    type: K,
    payload: ReplayPresentationEventPayloadMap[K]
): ReplayPresentationEventDraft {
    return { type, payload } as ReplayPresentationEventDraft;
}
