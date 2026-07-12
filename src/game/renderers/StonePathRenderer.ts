import Phaser from 'phaser';
import { BUILDING_DEFINITIONS, type BuildingType } from '../config/GameDefinitions';
import { PathfindingSystem } from './../systems/PathfindingSystem';
import { IsoUtils } from '../utils/IsoUtils';
import type { PlacedBuilding } from '../types/GameTypes';

/**
 * The village's stone lanes, shared by every renderer that shows a village:
 * the LIVE home village (VillageLifeSystem drives maturity per-lane with
 * laying crews) and neighbour POSTCARDS (one static bake at the server's
 * maturity). One stone kit, one stride, one hash order — the same village
 * always shows the same lanes at the same age, wherever it is drawn.
 */

const STONE_DARK = 0x6e685c;   // set-in shadow
const STONE = 0x9a948a;        // the slab
const STONE_LIGHT = 0xb2aca0;  // worn top

interface RouteBuilding {
    type?: string;
    gridX?: number;
    gridY?: number;
    level?: number;
    health?: number;
}

/** The paved network: town hall to the nearest of each working building.
 *  Identical to the home village's route choice, run on any serialized
 *  layout (plot-local coordinates). */
export function computeStoneRoutes(
    serialized: ReadonlyArray<RouteBuilding>
): Array<{ key: string; points: Phaser.Math.Vector2[] }> {
    const buildings = serialized
        .filter(b => BUILDING_DEFINITIONS[b.type as BuildingType])
        .map(b => ({
            id: `${b.type}:${b.gridX},${b.gridY}`,
            type: String(b.type),
            gridX: Number(b.gridX) || 0,
            gridY: Number(b.gridY) || 0,
            level: Number(b.level) || 1,
            health: 1
        }));
    const hall = buildings.find(b => b.type === 'town_hall');
    if (!hall) return [];
    const routes: Array<{ key: string; points: Phaser.Math.Vector2[] }> = [];
    const hallInfo = BUILDING_DEFINITIONS.town_hall;
    const from = { x: hall.gridX + (hallInfo?.width ?? 3) / 2, y: hall.gridY + (hallInfo?.height ?? 3) + 0.4 };
    for (const type of ['barracks', 'storage', 'mine', 'farm'] as const) {
        let best: (typeof buildings)[number] | null = null;
        let bestD = Infinity;
        for (const b of buildings) {
            if (b.type !== type) continue;
            const d = Math.hypot(b.gridX - hall.gridX, b.gridY - hall.gridY);
            if (d < bestD) { bestD = d; best = b; }
        }
        if (!best) continue;
        const info = BUILDING_DEFINITIONS[type];
        // A door-side tile beside the target (S/E faces the viewer).
        const spot = openTileNear(best, buildings);
        if (!spot) continue;
        const path = PathfindingSystem.findAmbientPath(
            from.x, from.y,
            { gridX: spot.x, gridY: spot.y },
            buildings as unknown as PlacedBuilding[]
        );
        if (!path || path.length < 2) continue;
        const pts = [new Phaser.Math.Vector2(from.x, from.y), ...path];
        const c = new Phaser.Math.Vector2(best.gridX + (info?.width ?? 1) / 2, best.gridY + (info?.height ?? 1) / 2);
        const last = pts[pts.length - 1];
        const toward = c.clone().subtract(last);
        const len = toward.length() || 1;
        pts.push(last.clone().add(toward.scale((len - 0.9) / len)));
        routes.push({ key: type, points: pts });
    }
    return routes;
}

function openTileNear(
    b: { type: string; gridX: number; gridY: number },
    buildings: ReadonlyArray<{ type: string; gridX: number; gridY: number }>
): { x: number; y: number } | null {
    const info = BUILDING_DEFINITIONS[b.type as BuildingType];
    const w = info?.width ?? 1;
    const h = info?.height ?? 1;
    const blocked = (x: number, y: number) => buildings.some(o => {
        const oi = BUILDING_DEFINITIONS[o.type as BuildingType];
        if (!oi) return false;
        return x >= o.gridX && x < o.gridX + oi.width && y >= o.gridY && y < o.gridY + oi.height;
    });
    const candidates: Array<{ x: number; y: number }> = [];
    for (let k = 0; k < w; k++) candidates.push({ x: b.gridX + k, y: b.gridY + h });
    for (let k = 0; k < h; k++) candidates.push({ x: b.gridX + w, y: b.gridY + k });
    for (const c of candidates) {
        if (c.x >= 0 && c.y >= 0 && c.x < 25 && c.y < 25 && !blocked(c.x, c.y)) return c;
    }
    return null;
}

/**
 * Lay one lane's stones along a polyline: fixed stride, half-tile lane,
 * hash-ordered appearance so a lane visibly fills in as maturity grows.
 * `offX/offY` shift the projection for postcard plots; `occluded` skips
 * stones buried under a roof.
 */
export function drawStoneLane(
    g: Phaser.GameObjects.Graphics,
    pts: ReadonlyArray<{ x: number; y: number }>,
    maturity: number,
    opts: {
        mapSize?: number;
        offX?: number;
        offY?: number;
        occluded?: (x: number, y: number) => boolean;
    } = {}
) {
    if (maturity <= 0.02 || pts.length < 2) return;
    const m = opts.mapSize ?? 25;
    const offX = opts.offX ?? 0;
    const offY = opts.offY ?? 0;
    let carry = 0;
    for (let s = 0; s < pts.length - 1; s++) {
        const a = pts[s];
        const b = pts[s + 1];
        const segLen = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
        if (segLen < 0.01) continue;
        const dirX = (b.x - a.x) / segLen;
        const dirY = (b.y - a.y) / segLen;
        const perpX = -dirY;
        const perpY = dirX;
        for (let d = carry; d < segLen; d += 0.42) {
            const gx = a.x + dirX * d;
            const gy = a.y + dirY * d;
            if (gx < 0.5 || gy < 0.5 || gx > m - 0.5 || gy > m - 0.5) continue;
            const stepIx = Math.round((gx * 53 + gy * 91) * 7);
            for (let side = 0; side < 2; side++) {
                const h = (Math.imul(stepIx + side * 7919, 2654435761) >>> 0) % 1000;
                if (h / 1000 > maturity) continue; // not laid yet
                const laneOff = ((side === 0 ? -1 : 1) * (0.08 + ((h >> 3) % 40) / 400));
                const sx = gx + perpX * laneOff;
                const sy = gy + perpY * laneOff;
                if (opts.occluded?.(sx, sy)) continue; // buried under a building
                const pos = IsoUtils.cartToIso(offX + sx, offY + sy);
                const w = 5.4 + (h % 4);
                const hgt = w * 0.52;
                g.fillStyle(STONE_DARK, 0.9);
                g.fillEllipse(pos.x, pos.y + 1, w + 1.6, hgt + 0.8);
                g.fillStyle(STONE, 1);
                g.fillEllipse(pos.x, pos.y, w, hgt);
                g.fillStyle(STONE_LIGHT, 0.75);
                g.fillEllipse(pos.x - w * 0.14, pos.y - hgt * 0.16, w * 0.55, hgt * 0.5);
            }
        }
        carry = ((segLen - carry) % 0.42);
        carry = carry === 0 ? 0 : 0.42 - carry;
    }
}
