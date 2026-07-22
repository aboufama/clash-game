import Phaser from 'phaser';
import { pixelEllipse, PIXEL_CELL } from '../render/PixelDraw';

/**
 * Owner-tuned ordinary screen-shake level. Every routine combat shake routes
 * through `screenShake` below, keeping per-event proportions intact while
 * making the camera response compact and subtle.
 */
export const SHAKE_SCALE = 0.3;

/** Town Hall collapse is the one deliberately large, preserved impact. */
export const TOWN_HALL_SHAKE_SCALE = 0.6;

/** The sole Phaser camera-shake boundary; callers choose an authored profile. */
function applyScreenShake(scene: Phaser.Scene, durationMs: number, intensity: number, scale: number, force: boolean) {
    scene.cameras.main.shake(durationMs, intensity * scale, force);
}

/** Routine combat profile: same event signature, globally reduced intensity. */
export function screenShake(scene: Phaser.Scene, durationMs: number, intensity: number) {
    applyScreenShake(scene, durationMs, intensity, SHAKE_SCALE, false);
}

/** Preserve the marquee Town Hall drop and replace any minor shake in flight. */
export function townHallScreenShake(scene: Phaser.Scene, durationMs: number, intensity: number) {
    applyScreenShake(scene, durationMs, intensity, TOWN_HALL_SHAKE_SCALE, true);
}

/**
 * PixelFx — the one-shot effects vocabulary, consolidated.
 *
 * Every quick effect in the game speaks the same three words:
 *
 *  - `burst`  — N chunky particles ('particle_circle'/'particle_square'
 *               images, tinted) scattered from a point, drifting and fading.
 *  - `flash`  — a single transient pixel-cell dot/oval that fades (and may
 *               grow or shrink) in place.
 *  - `ring`   — an expanding hollow cell ring redrawn per frame, so the
 *               cells stay crisp instead of scaling up.
 *
 * These replace the dozens of near-identical inline image+tween blocks that
 * grew around the pixel-cell conversion. Signature set-pieces (mortar crater,
 * golem death, dragon pod…) stay bespoke but may reuse
 * `stampRing`/`burst` internally where they are drop-ins.
 *
 * One-shot FX are allowed `Math.random()` — iron rule 3 governs AMBIENT
 * animation, not fire-and-forget bursts. Pass `opts.rng` to make one
 * deterministic. Textures come from ParticleManager.generateTextures (16px
 * canvases, NEAREST); radius r maps to image scale as (r * 2) / 16.
 */

export interface FxBurstOpts {
    /** Particle count (default 6). */
    count?: number;
    /** Tint palette; single entry = flat tint, several = rng-picked (default white). */
    colors?: readonly number[];
    /** Cycle `colors` in order (i % len) instead of picking at random. */
    cycle?: boolean;
    /** Use 'particle_square' instead of 'particle_circle'. */
    square?: boolean;
    /** Particle radius in world px → scale (r*2)/16 (default 1.4). */
    r?: number;
    /** + rng()*rJitter extra radius per particle. */
    rJitter?: number;
    /** scaleY = scaleX * squash (confetti rectangles etc., default 1). */
    squash?: number;
    /** Start alpha (default 1); every particle fades to 0. */
    alpha?: number;
    /** Initial x scatter width, centered on x (default 0). */
    spread?: number;
    /** Initial y scatter height, centered on y (default 0). */
    spreadY?: number;
    /** Random x drift width over the particle's life (centered, default 20). */
    speed?: number;
    /** Random y drift height over the particle's life (centered, default 0). */
    speedY?: number;
    /** Upward drift bias in px over life; NEGATIVE values fall (default 0). */
    up?: number;
    /** + rng()*upJitter extra rise (negative = extra fall). */
    upJitter?: number;
    /** Radial throw distance: particles fly outward from the origin. */
    radial?: number;
    /** + rng()*radialJitter extra throw. */
    radialJitter?: number;
    /** Evenly spaced throw angles (i/count * 2π) instead of random ones. */
    ringAngles?: boolean;
    /** Multiplies the y component of the radial throw (iso ground squash). */
    ySquash?: number;
    /** Life in ms (default 500). */
    life?: number;
    /** + rng()*lifeJitter extra life per particle. */
    lifeJitter?: number;
    /** Tween start delay in ms. */
    delay?: number;
    /** End-scale multiplier: 1.7 puffs grow, 0.2 sparks die small (default 1). */
    scaleTo?: number;
    /** Initial rotation = rng()*rot0 (radians). */
    rot0?: number;
    /** Random extra rotation width over life (centered). */
    spin?: number;
    /** 0..1 fraction of life before the alpha fade begins (confetti falls in
     *  full colour, then fades through the remainder). Default 0. */
    fadeDelay?: number;
    /** Tween ease for the whole motion (default 'Linear'). */
    ease?: string;
    depth?: number;
    blend?: Phaser.BlendModes;
    /** Deterministic source when an effect must not roll Math.random(). */
    rng?: () => number;
}

export interface FxFlashOpts {
    /** Radius in world px (default 6). */
    r?: number;
    /** ry = r * squash for iso ground ovals (default 1 = circle). */
    squash?: number;
    color?: number;
    /** Fill alpha; fades from here to 0 (default 1). */
    alpha?: number;
    /** Fade duration in ms (default 200). */
    life?: number;
    /** Tween start delay in ms (the flash is visible while it waits). */
    delay?: number;
    /** End-scale multiplier tweened alongside the fade (default 1 = none). */
    scaleTo?: number;
    /** Tween ease (default 'Linear'). */
    ease?: string;
    depth?: number;
    blend?: Phaser.BlendModes;
}

export interface FxRingOpts {
    /** Start radius (world px). */
    r0: number;
    /** End radius (world px). */
    r1: number;
    /** ry = rx * squash for iso ground rings (default 1 = circle). */
    squash?: number;
    /** Ring thickness in cells at r0 (default 1). */
    thick0?: number;
    /** Thickness at r1 (default thick0) — decaying shockwave fronts. */
    thick1?: number;
    color?: number;
    /** Start alpha; fades to 0 over life (default 0.8). */
    alpha?: number;
    /** Expansion duration in ms (default 400). */
    life?: number;
    delay?: number;
    /** Tween ease driving BOTH the growth and the fade (default 'Linear'). */
    ease?: string;
    /** Fade curve exponent: alpha = a0*(1-p)^fadePow. The old inline shock
     *  rings multiplied a GO-alpha tween with a redraw fade — that compound
     *  quadratic is fadePow 2. Default 1 (plain linear-in-eased-p). */
    fadePow?: number;
    depth?: number;
    blend?: Phaser.BlendModes;
}

export class PixelFx {
    /**
     * Stroked-ellipse ring rasterized as whole pixel cells: walk the perimeter
     * and stamp a thick×thick block of cells at each step (deduped), so pure
     * rings (shockwaves, range outlines) stay hollow AND chunky. rx/ry are
     * RADII. `thick` is in cells (≈ old lineWidth / 1.35, min 1). Draws into
     * an EXISTING graphics — the primitive under `ring` and MainScene's
     * pixelRing wrapper.
     */
    static stampRing(g: Phaser.GameObjects.Graphics, cx: number, cy: number, rx: number, ry: number, thick: number, color: number, alpha = 1) {
        if (rx <= 0 || ry <= 0) return;
        const cell = PIXEL_CELL;
        // Oversample the perimeter so the cell ring stays gap-free at any
        // radius; consecutive duplicates are skipped.
        const steps = Math.max(16, Math.ceil(((rx + ry) * 4.8) / cell));
        const half = ((thick - 1) / 2) * cell;
        g.fillStyle(color, alpha);
        let px = NaN, py = NaN;
        for (let i = 0; i < steps; i++) {
            const a = (i / steps) * Math.PI * 2;
            const bx = Math.floor((cx + Math.cos(a) * rx - half) / cell) * cell;
            const by = Math.floor((cy + Math.sin(a) * ry - half) / cell) * cell;
            if (bx === px && by === py) continue;
            px = bx; py = by;
            g.fillRect(bx, by, thick * cell, thick * cell);
        }
    }

    /** N one-shot tinted particles scattered from (x, y); each destroys itself. */
    static burst(scene: Phaser.Scene, x: number, y: number, opts: FxBurstOpts = {}) {
        const rng = opts.rng ?? Math.random;
        const count = opts.count ?? 6;
        const colors = opts.colors ?? [0xffffff];
        const key = opts.square ? 'particle_square' : 'particle_circle';
        const squash = opts.squash ?? 1;
        const fadeDelay = opts.fadeDelay ?? 0;
        const delay = opts.delay ?? 0;
        for (let i = 0; i < count; i++) {
            const r = (opts.r ?? 1.4) + (opts.rJitter ? rng() * opts.rJitter : 0);
            const sx = (r * 2) / 16;
            const sy = sx * squash;
            const color = colors.length === 1
                ? colors[0]
                : opts.cycle ? colors[i % colors.length] : colors[Math.floor(rng() * colors.length)];
            const img = scene.add.image(
                x + (opts.spread ? (rng() - 0.5) * opts.spread : 0),
                y + (opts.spreadY ? (rng() - 0.5) * opts.spreadY : 0),
                key
            ).setTint(color).setAlpha(opts.alpha ?? 1).setScale(sx, sy);
            if (opts.depth !== undefined) img.setDepth(opts.depth);
            if (opts.blend !== undefined) img.setBlendMode(opts.blend);
            if (opts.rot0) img.setRotation(rng() * opts.rot0);

            let dx = (rng() - 0.5) * (opts.speed ?? 20);
            let dy = (opts.speedY ? (rng() - 0.5) * opts.speedY : 0)
                - ((opts.up ?? 0) + (opts.upJitter ? rng() * opts.upJitter : 0));
            if (opts.radial) {
                const a = opts.ringAngles ? (i / count) * Math.PI * 2 : rng() * Math.PI * 2;
                const d = opts.radial + (opts.radialJitter ? rng() * opts.radialJitter : 0);
                dx += Math.cos(a) * d;
                dy += Math.sin(a) * d * (opts.ySquash ?? 1);
            }

            const life = (opts.life ?? 500) + (opts.lifeJitter ? rng() * opts.lifeJitter : 0);
            const scaleTo = opts.scaleTo ?? 1;
            const props: Record<string, number> = { x: img.x + dx, y: img.y + dy };
            if (scaleTo !== 1) { props.scaleX = sx * scaleTo; props.scaleY = sy * scaleTo; }
            if (opts.spin) props.rotation = img.rotation + (rng() - 0.5) * opts.spin;
            if (fadeDelay <= 0) props.alpha = 0;
            scene.tweens.add({
                targets: img,
                ...props,
                duration: life,
                delay,
                ease: opts.ease ?? 'Linear',
                onComplete: () => img.destroy()
            });
            if (fadeDelay > 0) {
                // Full colour first, fade only through the tail of the life.
                scene.tweens.add({ targets: img, alpha: 0, delay: delay + life * fadeDelay, duration: life * (1 - fadeDelay) });
            }
        }
    }

    /** One transient pixel-cell dot/oval at (x, y): fade (± grow/shrink) and
     *  destroy. Growth is a STEPPED REDRAW at the interpolated radius — never
     *  a scale tween, so the cells stay 1.35px at every size. */
    static flash(scene: Phaser.Scene, x: number, y: number, opts: FxFlashOpts = {}): Phaser.GameObjects.Graphics {
        const g = scene.add.graphics();
        const r = opts.r ?? 6;
        const squash = opts.squash ?? 1;
        const color = opts.color ?? 0xffffff;
        const a0 = opts.alpha ?? 1;
        const scaleTo = opts.scaleTo ?? 1;
        const draw = (p: number) => {
            g.clear();
            const rr = r * (1 + (scaleTo - 1) * p);
            pixelEllipse(g, 0, 0, rr, rr * squash, color, a0 * (1 - p));
        };
        draw(0);
        g.setPosition(x, y);
        if (opts.depth !== undefined) g.setDepth(opts.depth);
        if (opts.blend !== undefined) g.setBlendMode(opts.blend);
        // The progress property lives ON the graphics (not a loose state
        // object) so the tween is reachable through killTweensOf(g) — the
        // battle-FX registry sweeps exactly that way, and a loose-target
        // tween would outlive clearBattleFx by up to its whole life.
        const carrier = g as Phaser.GameObjects.Graphics & { fxProgress: number };
        carrier.fxProgress = 0;
        scene.tweens.add({
            targets: carrier,
            fxProgress: 1,
            duration: opts.life ?? 200,
            delay: opts.delay ?? 0,
            ease: opts.ease ?? 'Linear',
            onUpdate: () => { if (g.active) draw(carrier.fxProgress); },
            onComplete: () => g.destroy()
        });
        return g;
    }

    /**
     * Expanding hollow shockwave: a transient graphics REDRAWN each frame from
     * r0→r1 (never scaled — the cells stay 1.35px crisp at any radius), with
     * optional thickness decay, fading out, then destroyed.
     */
    static ring(scene: Phaser.Scene, x: number, y: number, opts: FxRingOpts): Phaser.GameObjects.Graphics {
        const g = scene.add.graphics();
        g.setPosition(x, y);
        if (opts.depth !== undefined) g.setDepth(opts.depth);
        if (opts.blend !== undefined) g.setBlendMode(opts.blend);
        const squash = opts.squash ?? 1;
        const thick0 = opts.thick0 ?? 1;
        const thick1 = opts.thick1 ?? thick0;
        const color = opts.color ?? 0xffffff;
        const a0 = opts.alpha ?? 0.8;
        const fadePow = opts.fadePow ?? 1;
        const draw = (p: number) => {
            g.clear();
            const rx = opts.r0 + (opts.r1 - opts.r0) * p;
            const thick = Math.max(1, Math.round(thick0 + (thick1 - thick0) * p));
            PixelFx.stampRing(g, 0, 0, rx, rx * squash, thick, color, a0 * Math.pow(1 - p, fadePow));
        };
        draw(0);
        // Progress rides ON the graphics so killTweensOf(g) — and therefore
        // the battle-FX sweep — reaches this tween (see flash above).
        const carrier = g as Phaser.GameObjects.Graphics & { fxProgress: number };
        carrier.fxProgress = 0;
        scene.tweens.add({
            targets: carrier,
            fxProgress: 1,
            duration: opts.life ?? 400,
            delay: opts.delay ?? 0,
            ease: opts.ease ?? 'Linear',
            onUpdate: () => { if (g.active) draw(carrier.fxProgress); },
            onComplete: () => g.destroy()
        });
        return g;
    }
}
