import Phaser from 'phaser';

export type CameraFrameFn = (cam: Phaser.Cameras.Scene2D.Camera) => void;

/**
 * The one sync point for DOM that tracks the world (speech bubbles, nameplates).
 *
 * Phaser recomputes `camera.worldView` in its RENDER pass — after the scene's
 * update() has already run. So anything that projects world → screen during
 * update(), or in its own requestAnimationFrame loop, reads the PREVIOUS
 * frame's camera and visibly trails the canvas by a frame while dragging.
 *
 * Subscribers here run on the game's POST_RENDER instead: same rAF slice the
 * canvas was drawn in, with the exact camera the renderer just used. The DOM
 * writes land in the same browser paint as the canvas frame, so anchored
 * elements stay glued to the world through any pan or zoom.
 */
const subscribers = new Set<CameraFrameFn>();
let hookedGame: Phaser.Game | null = null;

function resolveGame(): Phaser.Game | undefined {
    return (window as unknown as { __clashGame?: Phaser.Game }).__clashGame;
}

function mainCamera(game: Phaser.Game): Phaser.Cameras.Scene2D.Camera | undefined {
    const scene = game.scene?.keys?.MainScene as Phaser.Scene | undefined;
    return scene?.cameras?.main ?? undefined;
}

function ensureHooked() {
    const game = resolveGame();
    if (!game || game === hookedGame) return;
    hookedGame = game;
    game.events.on(Phaser.Core.Events.POST_RENDER, () => {
        const cam = mainCamera(game);
        if (!cam) return;
        for (const fn of [...subscribers]) fn(cam);
    });
}

/**
 * Run `fn` right after every rendered frame — and once immediately (from the
 * last-drawn camera) so a freshly mounted element never flashes unpositioned.
 * Returns the unsubscribe function.
 */
export function onCameraFrame(fn: CameraFrameFn): () => void {
    subscribers.add(fn);
    ensureHooked();
    const game = resolveGame();
    const cam = game && mainCamera(game);
    if (cam) fn(cam);
    return () => {
        subscribers.delete(fn);
    };
}
