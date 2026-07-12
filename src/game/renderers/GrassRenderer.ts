import Phaser from 'phaser';
import {
    normalizeWorldNatureSeedVersion,
    wildernessGrassPatternSample,
    wildernessGrassPresentationSeed,
    type WildernessGrassPatternSample
} from './WorldNatureSeed';

/**
 * ONE grass, everywhere. The live battlefield bake (MainScene) and the world
 * map's neighbour postcards (WorldMapSystem) both draw their lawns through
 * this module, so a village's grass looks IDENTICAL as a postcard and as the
 * ground you fight on — the seamless-invasion contract.
 *
 * Every village also gets its own slight, deterministic tint (seeded by its
 * identity: bot seed / owner id), so lawns vary subtly across the world and
 * you can tell your neighbour's meadow from your own at a glance.
 */

const BASE_COLORS = [0x4a9c3d, 0x52a844, 0x48943a, 0x5bb34d, 0x4fa041];

function hashKey(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export interface GrassPalette {
    /** The five tinted base tones this village's checker samples from. */
    colors: number[];
    /** Cached bright/dark checker variants per base tone. */
    bright: number[];
    dark: number[];
    detail: number[];
    /** Zero for player lawns; the shared server epoch for wilderness. */
    presentationSeedVersion: number;
}

const paletteCache = new Map<string, GrassPalette>();
const wildernessPaletteCache = new Map<number, GrassPalette>();

/** The village's lawn tint: subtle hue/brightness shifts, still clearly grass. */
export function grassPaletteFor(key: string): GrassPalette {
    const cached = paletteCache.get(key);
    if (cached) return cached;
    const h = hashKey(`grass:${key}`);
    // Shift channels a touch: greener, yellower, cooler or deeper per village.
    const dr = ((h % 21) - 10);              // -10..+10
    const dg = (((h >> 5) % 17) - 8);        // -8..+8
    const db = (((h >> 9) % 15) - 7);        // -7..+7
    const clampByte = (v: number) => Math.max(0, Math.min(255, v));
    const tint = (color: number, extra: number) => {
        const r = clampByte(((color >> 16) & 0xff) + dr + extra);
        const g = clampByte(((color >> 8) & 0xff) + dg + extra);
        const b = clampByte((color & 0xff) + db + Math.floor(extra / 2));
        return (r << 16) | (g << 8) | b;
    };
    const colors = BASE_COLORS.map(c => tint(c, 0));
    const palette: GrassPalette = {
        colors,
        bright: colors.map(c => Phaser.Display.Color.IntegerToColor(c).brighten(5).color),
        dark: colors.map(c => Phaser.Display.Color.IntegerToColor(c).darken(3).color),
        detail: colors.map(c => Phaser.Display.Color.IntegerToColor(c).darken(15).color),
        presentationSeedVersion: 0
    };
    paletteCache.set(key, palette);
    return palette;
}

/** Wild-country ground: the SAME meadow as the village lawns — untinted
 * base tones with the full checker contrast — so empty parcels read as
 * more of the world's one continuous grass, not a different material.
 * (Joined parcels still tile seamlessly: the checker keys off absolute
 * world tiles.) */
export function wildernessGrassPalette(seedVersion: unknown = 0): GrassPalette {
    const version = normalizeWorldNatureSeedVersion(seedVersion);
    const cached = wildernessPaletteCache.get(version);
    if (cached) return cached;
    const seed = wildernessGrassPresentationSeed(version);
    const clampByte = (value: number) => Math.max(0, Math.min(255, value));
    // The pattern shift does most of the visual work. This restrained global
    // tint keeps the lawn continuous and recognizably part of the same game.
    const dr = seed === 0 ? 0 : (seed & 7) - 3;
    const dg = seed === 0 ? 0 : ((seed >>> 4) & 7) - 2;
    const db = seed === 0 ? 0 : ((seed >>> 8) & 7) - 3;
    const colors = BASE_COLORS.map(color => {
        const r = clampByte(((color >> 16) & 0xff) + dr);
        const g = clampByte(((color >> 8) & 0xff) + dg);
        const b = clampByte((color & 0xff) + db);
        return (r << 16) | (g << 8) | b;
    });
    const palette: GrassPalette = {
        colors,
        bright: colors.map(c => Phaser.Display.Color.IntegerToColor(c).brighten(5).color),
        dark: colors.map(c => Phaser.Display.Color.IntegerToColor(c).darken(3).color),
        detail: colors.map(c => Phaser.Display.Color.IntegerToColor(c).darken(15).color),
        presentationSeedVersion: version
    };
    wildernessPaletteCache.set(version, palette);
    if (wildernessPaletteCache.size > 8) {
        const oldest = wildernessPaletteCache.keys().next().value as number | undefined;
        if (oldest !== undefined && oldest !== version) wildernessPaletteCache.delete(oldest);
    }
    return palette;
}

export function grassTilePatternAt(
    worldTileX: number,
    worldTileY: number,
    palette: GrassPalette
): WildernessGrassPatternSample {
    return wildernessGrassPatternSample(
        worldTileX,
        worldTileY,
        palette.presentationSeedVersion,
        palette.colors.length
    );
}

export function grassTileColorAt(worldTileX: number, worldTileY: number, palette: GrassPalette): number {
    const pattern = grassTilePatternAt(worldTileX, worldTileY, palette);
    return pattern.bright ? palette.bright[pattern.colorIndex] : palette.dark[pattern.colorIndex];
}

/** Which CART-space corner of a tile is rounded off (plot corner tiles). */
export type GrassCornerCut = 'nw' | 'ne' | 'se' | 'sw';

/** Radius (in tiles) of a plot's rounded lawn corner. */
export const GRASS_CORNER_CUT_RADIUS = 0.9;

/** The road-shoulder colour the cut arc is stroked with (see WorldMapSystem's
 *  ROAD_SHOULDER — the arc must read as the same continuous road edge). */
const CUT_SHOULDER = 0x77674e;

/**
 * Draw one lawn tile. `localX/localY` are the tile's coordinates WITHIN its
 * village (0..24) — the checker and detail patterns key off them, so the same
 * tile of the same village renders identically in every context.
 *
 * `cornerCut` rounds one cart-space corner of the tile off with a quarter
 * arc (used on the four corner tiles of a plot, where the roads cross): the
 * cut area is left unpainted for the junction's packed-earth bed below, and
 * the arc is stroked as the road's shoulder line.
 */
export function drawGrassTile(
    graphics: Phaser.GameObjects.Graphics,
    isoX: number,
    isoY: number,
    tileWidth: number,
    tileHeight: number,
    localX: number,
    localY: number,
    palette: GrassPalette,
    withDetail: boolean,
    cornerCut?: GrassCornerCut
) {
    const halfW = tileWidth / 2;
    const halfH = tileHeight / 2;
    const pattern = grassTilePatternAt(localX, localY, palette);
    const colorIndex = pattern.colorIndex;
    const tileColor = pattern.bright ? palette.bright[colorIndex] : palette.dark[colorIndex];

    const points = [
        new Phaser.Math.Vector2(isoX, isoY),
        new Phaser.Math.Vector2(isoX + halfW, isoY + halfH),
        new Phaser.Math.Vector2(isoX, isoY + tileHeight),
        new Phaser.Math.Vector2(isoX - halfW, isoY + halfH)
    ];

    if (cornerCut) {
        // Rebuild the diamond in tile-local cart space [0,1]² so the cut is a
        // true quarter-circle before projection.
        const toIso = (u: number, v: number) =>
            new Phaser.Math.Vector2(isoX + (u - v) * halfW, isoY + (u + v) * halfH);
        const ring = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
        const cutIndex = { nw: 0, ne: 1, se: 2, sw: 3 }[cornerCut];
        const R = GRASS_CORNER_CUT_RADIUS;
        const outline: Phaser.Math.Vector2[] = [];
        let arcIso: Phaser.Math.Vector2[] = [];
        for (let i = 0; i < 4; i++) {
            const c = ring[i];
            if (i !== cutIndex) {
                outline.push(toIso(c.x, c.y));
                continue;
            }
            const prev = ring[(i + 3) % 4];
            const next = ring[(i + 1) % 4];
            const tPrev = { x: c.x - (c.x - prev.x) * R, y: c.y - (c.y - prev.y) * R };
            const tNext = { x: c.x + (next.x - c.x) * R, y: c.y + (next.y - c.y) * R };
            const centre = { x: tPrev.x + tNext.x - c.x, y: tPrev.y + tNext.y - c.y };
            const arc: Phaser.Math.Vector2[] = [];
            for (let step = 0; step <= 8; step++) {
                const a = step / 8 * Math.PI * 0.5;
                arc.push(toIso(
                    centre.x + (tPrev.x - centre.x) * Math.cos(a) + (tNext.x - centre.x) * Math.sin(a),
                    centre.y + (tPrev.y - centre.y) * Math.cos(a) + (tNext.y - centre.y) * Math.sin(a)
                ));
            }
            outline.push(...arc);
            arcIso = arc;
        }
        graphics.fillStyle(tileColor, 1);
        graphics.fillPoints(outline, true);
        // The road's shoulder line carries around the rounded corner — one
        // continuous edge with the straight shoulders it meets tangentially.
        graphics.lineStyle(1.4, CUT_SHOULDER, 1);
        graphics.strokePoints(arcIso, false);
        return;
    }

    graphics.fillStyle(tileColor, 1);
    graphics.fillPoints(points, true);

    if (!withDetail) return;

    // Sun-side highlight and shade-side edge.
    graphics.lineStyle(1, 0xffffff, 0.15);
    graphics.lineBetween(points[3].x, points[3].y, points[0].x, points[0].y);
    graphics.lineBetween(points[0].x, points[0].y, points[1].x, points[1].y);
    graphics.lineStyle(1, 0x000000, 0.12);
    graphics.lineBetween(points[1].x, points[1].y, points[2].x, points[2].y);
    graphics.lineBetween(points[2].x, points[2].y, points[3].x, points[3].y);

    // Occasional darker grass tuft.
    if (pattern.detail) {
        graphics.fillStyle(palette.detail[colorIndex], 0.4);
        graphics.fillCircle(
            isoX + pattern.detailOffsetX,
            isoY + halfH + pattern.detailOffsetY,
            2
        );
    }
}
