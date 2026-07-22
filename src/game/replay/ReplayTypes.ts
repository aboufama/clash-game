import type { ReplayPresentationEvent } from './ReplayPresentationEvents';

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
