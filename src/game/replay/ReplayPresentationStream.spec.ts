import type { ReplayBuildingRef, ReplayPresentationPoint } from './ReplayPresentationEvents';
import {
    ReplayPresentationDispatcher,
    ReplayPresentationRecorder,
    createReplayPresentationRandom,
    replayPresentationEvent,
    replayPresentationEventIdentity
} from './ReplayPresentationStream';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

const point: ReplayPresentationPoint = { gridX: 2, gridY: 3, worldX: -32, worldY: 80 };
const building: ReplayBuildingRef = {
    kind: 'building',
    id: 'building-1',
    type: 'cannon',
    owner: 'ENEMY',
    level: 2
};

const firstIdentity = replayPresentationEventIdentity('attack-1', 7, 120, 'fx');
const repeatedIdentity = replayPresentationEventIdentity('attack-1', 7, 120, 'fx');
assert(firstIdentity.id === repeatedIdentity.id, 'event IDs must be deterministic');
assert(firstIdentity.seed === repeatedIdentity.seed, 'event seeds must be deterministic');
assert(/^[a-zA-Z0-9_.:-]+$/.test(firstIdentity.id), 'event IDs must satisfy the server safe-id contract');

const randomA = createReplayPresentationRandom(firstIdentity.seed);
const randomB = createReplayPresentationRandom(firstIdentity.seed);
assert(randomA() === randomB() && randomA() === randomB(), 'seeded FX random must replay exactly');

const recorder = new ReplayPresentationRecorder<{ health: number }>({
    streamId: 'attack-1',
    maxChunks: 3,
    maxApproxBytes: 100_000,
    maxAgeMs: 10_000
});

const keyframe = recorder.recordKeyframe(0, { health: 100 });
const eventOne = recorder.recordEvent(50, replayPresentationEvent('fx', {
    fx: 'screen-shake',
    durationMs: 50,
    intensity: 0.001,
    townHall: false
}));
const eventTwo = recorder.recordEvent(100, replayPresentationEvent('building.destroy', {
    building,
    at: point,
    footprint: { width: 2, height: 2 },
    style: 'defense',
    silent: false,
    createRubble: true,
    shake: { durationMs: 175, intensity: 0.0035, townHall: false }
}));
const terminal = recorder.recordKeyframe(120, { health: 0 }, true);

assert(keyframe.sequence === 1 && eventOne.sequence === 2, 'event and keyframe chunks share one sequence');
assert(eventTwo.kind === 'event' && terminal.kind === 'keyframe' && terminal.terminal === true, 'wire kinds must match replay v2');
assert(recorder.snapshot().length === 3, 'recorder must enforce its chunk bound');
assert(recorder.firstBufferedSequence === 2, 'bounded pruning must preserve global sequence numbers');

const dispatchLog: string[] = [];
const dispatcher = new ReplayPresentationDispatcher<{ health: number }>({
    initialSequence: 2,
    handlers: {
        fx: (event, context) => {
            dispatchLog.push(`${event.type}:${context.chunk.sequence}:${context.random().toFixed(6)}`);
        },
        'building.destroy': event => dispatchLog.push(`${event.type}:${event.payload.building.id}`)
    },
    onKeyframe: chunk => dispatchLog.push(`keyframe:${chunk.frame.health}`)
});

// Deliberately ingest out of order and with a duplicate network chunk.
dispatcher.ingest([terminal, eventTwo, eventOne, eventOne]);
const beforeImpact = dispatcher.dispatchThrough(75);
assert(beforeImpact.dispatchedEvents === 1, 'only due events should dispatch');
assert(dispatchLog[0]?.startsWith('fx:2:'), 'first global sequence should dispatch first');

const throughTerminal = dispatcher.dispatchThrough(120);
assert(throughTerminal.dispatchedEvents === 1, 'later event should dispatch exactly once');
assert(throughTerminal.appliedKeyframes === 1, 'terminal keyframe should dispatch in sequence');
assert(dispatchLog[1] === 'building.destroy:building-1', 'typed handler must receive its narrowed payload');
assert(dispatchLog[2] === 'keyframe:0', 'keyframes must remain ordered with events');

const gapLog: number[] = [];
const gapDispatcher = new ReplayPresentationDispatcher<{ health: number }>({
    onEvent: (_event, context) => gapLog.push(context.chunk.sequence)
});
gapDispatcher.ingest([eventOne]);
assert(gapDispatcher.dispatchThrough(100).dispatchedEvents === 0, 'dispatcher must wait for a missing sequence');
gapDispatcher.ingest([keyframe]);
const closedGap = gapDispatcher.dispatchThrough(100);
assert(closedGap.appliedKeyframes === 1 && closedGap.dispatchedEvents === 1, 'dispatcher must resume when a sequence gap closes');
assert(gapLog[0] === 2, 'event after a keyframe must keep global sequence order');

let presentationAttempts = 0;
const retryDispatcher = new ReplayPresentationDispatcher<{ health: number }>({
    initialSequence: eventOne.sequence,
    onEvent: () => {
        presentationAttempts += 1;
        if (presentationAttempts === 1) throw new Error('synthetic presenter failure');
    }
});
retryDispatcher.ingest([eventOne]);
let presenterFailed = false;
try {
    retryDispatcher.dispatchThrough(eventOne.t);
} catch {
    presenterFailed = true;
}
assert(presenterFailed, 'a presenter exception must be observable to the replay surface');
const retriedEvent = retryDispatcher.dispatchThrough(eventOne.t);
assert(retriedEvent.dispatchedEvents === 1, 'a failed presenter must leave its chunk retryable');
assert(presentationAttempts === 2, 'a retry must invoke the failed presenter again');

let rejectedBackwardsTime = false;
try {
    recorder.recordEvent(119, replayPresentationEvent('sound', { sound: 'destroy', source: building, at: point }));
} catch {
    rejectedBackwardsTime = true;
}
assert(rejectedBackwardsTime, 'recorder must reject backwards timeline writes');
