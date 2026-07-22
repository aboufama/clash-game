import type { ReplayPresentationEvent } from './ReplayPresentationEvents';

/**
 * Once discovery drops a terminal battle, an already-authorized Watchtower
 * viewer gets this long to fetch and drain its final correction/impact chunks.
 * The server re-checks current sight and plot fencing throughout the grace.
 */
export const LIVE_REPLAY_SPECTATOR_GRACE_MS = 15_000;

/** Three 24 Hz presentation ticks between authoritative correction samples. */
export const REPLAY_CORRECTION_INTERVAL_MS = 125;

/** Default live attack length used to prove correction sampling stays bounded. */
export const REPLAY_DEFAULT_MAX_DURATION_MS = 15 * 60_000;

/**
 * Count ceiling shared by both replay stores. It retains every 125 ms sample
 * across the default 15-minute battle while leaving headroom for forced
 * deployment, destruction, and terminal correction frames.
 */
export const REPLAY_CORRECTION_FRAME_BUDGET = 8_192;

export function replayCorrectionFrameCount(durationMs: number): number {
    return Math.ceil(Math.max(0, durationMs) / REPLAY_CORRECTION_INTERVAL_MS) + 1;
}

/** Canonical client presentation-event envelope and payload union. */
export type { ReplayPresentationEvent } from './ReplayPresentationEvents';

/**
 * Generic replay-v2 wire aliases used by the pure timeline. The production
 * presentation stream specializes TEvent to ReplayPresentationEvent, while
 * tests and future protocol readers may retain a narrower payload type.
 */
export interface ReplayV2EventChunk<TEvent = ReplayPresentationEvent> {
    sequence: number;
    t: number;
    kind: 'event';
    event: TEvent;
}

export interface ReplayV2KeyframeChunk<TFrame> {
    sequence: number;
    t: number;
    kind: 'keyframe';
    terminal?: boolean;
    frame: TFrame;
}

export type ReplayV2Chunk<TFrame, TEvent = ReplayPresentationEvent> =
    | ReplayV2EventChunk<TEvent>
    | ReplayV2KeyframeChunk<TFrame>;
