import type Phaser from 'phaser';

/**
 * Phaser 3.90 does not have a game-level `resolution` setting. Its RESIZE
 * scale mode deliberately makes the drawing buffer the same size as the CSS
 * parent, which leaves Retina displays under-sampled. We instead run the
 * Scale Manager in NONE mode with a physical-pixel game size and its public
 * CSS zoom set to the inverse render scale.
 *
 * This module is the one boundary between CSS pixels and Phaser backing
 * pixels. World coordinates stay unchanged; camera and Pointer coordinates
 * are backing-pixel values, while React/DOM overlays continue to use CSS px.
 */

export const DESKTOP_DPR_CAP = 2;
export const MOBILE_DPR_CAP = 1.5;
export const DESKTOP_BACKING_PIXEL_BUDGET = 3840 * 2160;
export const MOBILE_BACKING_PIXEL_BUDGET = 3_000_000;

export interface DisplayMetrics {
    cssWidth: number;
    cssHeight: number;
    backingWidth: number;
    backingHeight: number;
    renderScale: number;
}

export interface DisplayMetricOptions {
    isMobile: boolean;
    devicePixelRatio?: number;
    desktopDprCap?: number;
    mobileDprCap?: number;
    desktopPixelBudget?: number;
    mobilePixelBudget?: number;
}

const finitePositive = (value: number, fallback: number): number =>
    Number.isFinite(value) && value > 0 ? value : fallback;

/** Pure policy function, exported so the memory/performance cap is testable. */
export function computeDisplayMetrics(
    cssWidth: number,
    cssHeight: number,
    options: DisplayMetricOptions
): DisplayMetrics {
    const width = Math.max(1, Math.round(finitePositive(cssWidth, 1)));
    const height = Math.max(1, Math.round(finitePositive(cssHeight, 1)));
    const deviceScale = Math.max(1, finitePositive(options.devicePixelRatio ?? 1, 1));
    const deviceCap = finitePositive(
        options.isMobile ? options.mobileDprCap ?? MOBILE_DPR_CAP : options.desktopDprCap ?? DESKTOP_DPR_CAP,
        1
    );
    const pixelBudget = finitePositive(
        options.isMobile
            ? options.mobilePixelBudget ?? MOBILE_BACKING_PIXEL_BUDGET
            : options.desktopPixelBudget ?? DESKTOP_BACKING_PIXEL_BUDGET,
        width * height
    );
    const budgetScale = Math.sqrt(pixelBudget / (width * height));
    const renderScale = Math.max(1, Math.min(deviceScale, deviceCap, budgetScale));

    return {
        cssWidth: width,
        cssHeight: height,
        backingWidth: Math.max(1, Math.round(width * renderScale)),
        backingHeight: Math.max(1, Math.round(height * renderScale)),
        renderScale
    };
}

let activeRenderScale = 1;

/** Called before Phaser boots so scenes use the same camera scale as config. */
export function adoptInitialDisplayMetrics(metrics: DisplayMetrics): DisplayMetrics {
    activeRenderScale = metrics.renderScale;
    return metrics;
}

export function getRenderScale(): number {
    return activeRenderScale;
}

/** Camera zooms are physical; game design values exposed by MobileUtils are logical. */
export function toBackingZoom(logicalZoom: number, renderScale = activeRenderScale): number {
    return logicalZoom * renderScale;
}

export function toLogicalZoom(backingZoom: number, renderScale = activeRenderScale): number {
    return backingZoom / Math.max(0.0001, renderScale);
}

export function cssPixelsToBacking(cssPixels: number, renderScale = activeRenderScale): number {
    return cssPixels * renderScale;
}

export function cameraCssWidth(camera: Phaser.Cameras.Scene2D.Camera): number {
    return camera.width / Math.max(0.0001, activeRenderScale);
}

export function cameraCssHeight(camera: Phaser.Cameras.Scene2D.Camera): number {
    return camera.height / Math.max(0.0001, activeRenderScale);
}

/**
 * Actual backing-to-CSS ratios from Phaser's Scale Manager. Using these for
 * DOM projection also absorbs the sub-pixel rounding of integer canvas sizes.
 */
export function cameraDisplayScale(camera: Phaser.Cameras.Scene2D.Camera): { x: number; y: number } {
    const displayScale = camera.scene?.scale?.displayScale;
    const x = finitePositive(displayScale?.x ?? activeRenderScale, activeRenderScale);
    const y = finitePositive(displayScale?.y ?? activeRenderScale, activeRenderScale);
    return { x, y };
}

interface CameraResizeSnapshot {
    camera: Phaser.Cameras.Scene2D.Camera;
    centerX: number;
    centerY: number;
    logicalZoomX: number;
    logicalZoomY: number;
    zoomEffectSource?: number;
    zoomEffectDestination?: number;
}

function snapshotCameras(game: Phaser.Game, oldScale: number): CameraResizeSnapshot[] {
    const snapshots: CameraResizeSnapshot[] = [];
    for (const scene of game.scene.getScenes(false)) {
        for (const camera of scene.cameras?.cameras ?? []) {
            const effect = camera.zoomEffect;
            snapshots.push({
                camera,
                // Phaser scroll is the unzoomed viewport origin. Its own
                // preRender computes the midpoint with this exact formula.
                centerX: camera.scrollX + camera.width / 2,
                centerY: camera.scrollY + camera.height / 2,
                logicalZoomX: camera.zoomX / oldScale,
                logicalZoomY: camera.zoomY / oldScale,
                zoomEffectSource: effect?.isRunning ? effect.source / oldScale : undefined,
                zoomEffectDestination: effect?.isRunning ? effect.destination / oldScale : undefined
            });
        }
    }
    return snapshots;
}

function applyDisplayMetrics(game: Phaser.Game, metrics: DisplayMetrics): void {
    const oldScale = Math.max(0.0001, activeRenderScale);
    const cameras = snapshotCameras(game, oldScale);
    const nextScale = metrics.renderScale;

    // Set this before ScaleManager emits RESIZE so any scene callback sees the
    // new CSS/backing relationship. Both API calls are synchronous; there is
    // no browser paint between the temporary CSS size and final inverse zoom.
    activeRenderScale = nextScale;
    game.scale.resize(metrics.backingWidth, metrics.backingHeight);
    // Always apply zoom after resize, even when its numeric value is unchanged.
    // Phaser's resize() intentionally skips writing CSS size at zoom === 1;
    // without this refresh, returning from a Retina monitor can leave the old
    // explicit 2x CSS width on the canvas.
    game.scale.setZoom(1 / nextScale);

    // CameraManager has now resized each full-canvas viewport. Restore the
    // same world-space lens and logical zoom instead of letting a DPR change
    // look like a pan/zoom. Preserve an in-flight world-view zoom as well.
    for (const snapshot of cameras) {
        const { camera } = snapshot;
        camera.setZoom(snapshot.logicalZoomX * nextScale, snapshot.logicalZoomY * nextScale);
        camera.centerOn(snapshot.centerX, snapshot.centerY);
        if (snapshot.zoomEffectSource !== undefined && snapshot.zoomEffectDestination !== undefined) {
            camera.zoomEffect.source = snapshot.zoomEffectSource * nextScale;
            camera.zoomEffect.destination = snapshot.zoomEffectDestination * nextScale;
        }
    }
}

function sameMetrics(a: DisplayMetrics | null, b: DisplayMetrics): boolean {
    return Boolean(a)
        && a!.cssWidth === b.cssWidth
        && a!.cssHeight === b.cssHeight
        && a!.backingWidth === b.backingWidth
        && a!.backingHeight === b.backingHeight
        && Math.abs(a!.renderScale - b.renderScale) < 1e-6;
}

export interface DisplayResolutionOptions {
    isMobile: boolean;
}

/**
 * Keep the physical drawing buffer synchronized with the CSS parent, browser
 * zoom and monitor DPR. Returns a disposer that must run before game.destroy.
 */
export function installDisplayResolution(
    game: Phaser.Game,
    parent: HTMLElement,
    options: DisplayResolutionOptions
): () => void {
    let disposed = false;
    let applyQueued = false;
    let lastMetrics: DisplayMetrics | null = null;
    let dprMedia: MediaQueryList | null = null;

    const measure = (): DisplayMetrics => {
        const rect = parent.getBoundingClientRect();
        const cssWidth = parent.clientWidth || rect.width || window.innerWidth;
        const cssHeight = parent.clientHeight || rect.height || window.innerHeight;
        return computeDisplayMetrics(cssWidth, cssHeight, {
            isMobile: options.isMobile,
            devicePixelRatio: window.devicePixelRatio || 1
        });
    };

    const apply = () => {
        applyQueued = false;
        if (disposed || !game.isBooted || !game.canvas) return;
        const metrics = measure();
        if (sameMetrics(lastMetrics, metrics)) return;

        const alreadyConfigured = game.scale.width === metrics.backingWidth
            && game.scale.height === metrics.backingHeight
            && Math.abs(game.scale.zoom - 1 / metrics.renderScale) < 1e-6;
        if (alreadyConfigured) activeRenderScale = metrics.renderScale;
        else applyDisplayMetrics(game, metrics);
        lastMetrics = metrics;
    };

    const schedule = () => {
        if (disposed || applyQueued) return;
        applyQueued = true;
        // A microtask runs before Phaser's next requestAnimationFrame. Using
        // another rAF can resize (and clear) the canvas after Phaser rendered
        // that frame, producing a one-frame flash during window resizing.
        queueMicrotask(apply);
    };

    const onDprChange = () => {
        armDprWatcher();
        schedule();
    };

    const armDprWatcher = () => {
        dprMedia?.removeEventListener('change', onDprChange);
        dprMedia = typeof window.matchMedia === 'function'
            ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
            : null;
        dprMedia?.addEventListener('change', onDprChange);
    };

    const resizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(schedule)
        : null;
    resizeObserver?.observe(parent);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    armDprWatcher();

    const onReady = () => schedule();
    if (game.isBooted) schedule();
    else game.events.once('ready', onReady);

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        resizeObserver?.disconnect();
        window.removeEventListener('resize', schedule);
        window.visualViewport?.removeEventListener('resize', schedule);
        dprMedia?.removeEventListener('change', onDprChange);
        game.events.off('ready', onReady);
    };

    return dispose;
}
