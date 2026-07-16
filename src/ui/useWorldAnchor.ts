import { useEffect, type RefObject } from 'react';
import { cameraDisplayScale } from '../game/utils/DisplayResolution';
import { onCameraFrame } from './cameraFrame';

/**
 * Pin a DOM element to a WORLD-space point: after every rendered frame the
 * element is translated to the point's screen position (subtract the camera's
 * worldView origin, scale by zoom — the same math the neighbour nameplates
 * use). Positioning runs on the game's POST_RENDER via onCameraFrame, never
 * in a separate rAF loop, so the element moves in the same paint as the
 * canvas instead of trailing it. The element should be absolutely positioned
 * at 0,0 inside a full-screen layer; the transform does the rest. Fixed
 * on-screen size by design: a bubble stays readable at any zoom.
 *
 * By default the element hangs ABOVE the anchor (translate -100%). When
 * `flipBelowY` (a world Y for the subject's underside) is given and the
 * element would poke past the top of the screen — e.g. the [i] stat sheet
 * expanding on a building near the viewport top — it flips to hang BELOW
 * that point instead, and the element gets a `below` class so the CSS can
 * mirror its speech-bubble tail. The chosen side sticks with a little slack
 * before flipping back, so it never flaps at the boundary.
 */
export function useWorldAnchor(
    ref: RefObject<HTMLElement | null>,
    world: { x: number; y: number } | null,
    opts: { clampMargin?: { x: number; top: number; bottom: number }; flipBelowY?: number } = {}
) {
    const wx = world?.x;
    const wy = world?.y;
    const flipY = opts.flipBelowY;
    useEffect(() => {
        if (wx === undefined || wy === undefined) return;
        const unsubscribe = onCameraFrame(cam => {
            const el = ref.current;
            if (!el) return;
            const wv = cam.worldView;
            const display = cameraDisplayScale(cam);
            const viewportWidth = cam.width / display.x;
            const viewportHeight = cam.height / display.y;
            const PAD = 10;
            let sx = (wx - wv.x) * cam.zoom / display.x;
            const syAbove = (wy - wv.y) * cam.zoom / display.y;
            const h = el.offsetHeight;

            let below = false;
            if (flipY !== undefined) {
                const syBelow = (flipY - wv.y) * cam.zoom / display.y;
                const fitsAbove = syAbove - h >= PAD;
                const fitsBelow = syBelow + h <= viewportHeight - PAD;
                below = el.dataset.waSide === 'below';
                if (below) {
                    // 24px of slack before unflipping stops boundary flapping.
                    if (!fitsBelow || syAbove - h >= PAD + 24) below = false;
                } else if (!fitsAbove && fitsBelow) {
                    below = true;
                }
                el.dataset.waSide = below ? 'below' : 'above';
                if (el.classList.contains('below') !== below) el.classList.toggle('below', below);
            }

            let sy = below && flipY !== undefined ? (flipY - wv.y) * cam.zoom / display.y : syAbove;
            if (opts.clampMargin) {
                // Keep the whole bubble (and its buttons) on screen at any
                // zoom/pan — clamp the rect, not just the anchor point.
                sx = Math.max(opts.clampMargin.x, Math.min(viewportWidth - opts.clampMargin.x, sx));
                sy = below
                    ? Math.max(PAD, Math.min(viewportHeight - h - PAD, sy))
                    : Math.max(Math.max(opts.clampMargin.top, h + PAD), Math.min(viewportHeight - opts.clampMargin.bottom, sy));
            }
            el.style.transform = `translate(-50%, ${below ? '0' : '-100%'}) translate(${Math.round(sx)}px, ${Math.round(sy)}px)`;
        });
        return () => {
            unsubscribe();
            // The inline transform (and flip state) must not outlive the
            // anchor: an element that switches anchored → centered would
            // otherwise keep the stale transform, which beats its class
            // rule (e.g. .plot-bubble.centered). Harmless mid-switch —
            // onCameraFrame repositions a re-anchored element immediately.
            const el = ref.current;
            if (el) {
                el.style.transform = '';
                delete el.dataset.waSide;
                el.classList.remove('below');
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wx, wy, flipY]);
}
