import Phaser from 'phaser';
import { BUILDING_DEFINITIONS, MAP_SIZE } from '../config/GameDefinitions';
import type { PlacedBuilding } from '../types/GameTypes';

export class PathfindingSystem {

    // Ambient village movement only. Combat uses CombatNavigationSystem.
    private static readonly COST_DEFAULT = 10;
    private static readonly COST_IMPASSABLE = 999999;

    // Scratch buffers reused across ambient calls. Single-threaded/non-reentrant.
    private static readonly NODE_COUNT = MAP_SIZE * MAP_SIZE;
    private static readonly gridScratch = new Int32Array(PathfindingSystem.NODE_COUNT);
    private static readonly closedScratch = new Uint8Array(PathfindingSystem.NODE_COUNT);
    private static readonly gScoreScratch = new Float64Array(PathfindingSystem.NODE_COUNT);
    private static readonly cameFromScratch = new Int32Array(PathfindingSystem.NODE_COUNT);
    // Binary min-heap over f (lazy-deletion duplicates allowed), parallel arrays.
    private static readonly heapNode = new Int32Array(PathfindingSystem.NODE_COUNT * 16);
    private static readonly heapF = new Float64Array(PathfindingSystem.NODE_COUNT * 16);
    private static heapSize = 0;


    /**
     * Path for ambient village life (villagers, dogs, camp recruits). Every
     * healthy building blocks movement except `throughId`, which may be walked
     * into — used to enter the town hall during a panic or to join an army
     * camp. No troop-avoidance or danger costs; shares the A* scratch buffers.
     */
    static findAmbientPath(
        sx: number,
        sy: number,
        target: { gridX: number; gridY: number; type?: string },
        buildings: PlacedBuilding[],
        throughId?: string
    ): Phaser.Math.Vector2[] | null {
        const width = MAP_SIZE;
        const height = MAP_SIZE;
        const grid = PathfindingSystem.gridScratch;
        grid.fill(PathfindingSystem.COST_DEFAULT);

        // Walls are hoppable for the little folk: pricey enough that a nearby gap
        // always wins, but never a dead end — they'll jump the wall if they must.
        const WALL_HOP_COST = 90;
        for (const b of buildings) {
            if (b.health <= 0 || b.isDestroyed) continue;
            if (throughId && b.id === throughId) continue;
            const info = BUILDING_DEFINITIONS[b.type as keyof typeof BUILDING_DEFINITIONS];
            if (!info) continue;
            // Gates are the door villagers actually use; a bare wall stays
            // hoppable only as a last resort (someone bricked themselves in
            // mid-edit) at four times the old reluctance.
            const cost = b.type === 'wall'
                ? (b.isGate ? 3 : WALL_HOP_COST * 4)
                : PathfindingSystem.COST_IMPASSABLE;
            for (let x = b.gridX; x < b.gridX + info.width; x++) {
                for (let y = b.gridY; y < b.gridY + info.height; y++) {
                    if (x >= 0 && x < width && y >= 0 && y < height) {
                        grid[y * width + x] = cost;
                    }
                }
            }
        }

        let rect = { x: Math.floor(target.gridX), y: Math.floor(target.gridY), w: 1, h: 1 };
        const targetInfo = target.type ? BUILDING_DEFINITIONS[target.type as keyof typeof BUILDING_DEFINITIONS] : undefined;
        if (targetInfo) {
            rect = { x: Math.floor(target.gridX), y: Math.floor(target.gridY), w: targetInfo.width, h: targetInfo.height };
        }

        const startX = Phaser.Math.Clamp(Math.floor(sx), 0, width - 1);
        const startY = Phaser.Math.Clamp(Math.floor(sy), 0, height - 1);
        // An entity standing inside a footprint (building placed on top of it)
        // must still be able to walk out.
        if (grid[startY * width + startX] >= PathfindingSystem.COST_IMPASSABLE) {
            grid[startY * width + startX] = PathfindingSystem.COST_DEFAULT;
        }
        return this.calculateAStar(startX, startY, rect, grid, width, height);
    }


    private static heapPush(nodeIdx: number, f: number) {
        const nodes = PathfindingSystem.heapNode;
        const fs = PathfindingSystem.heapF;
        let i = PathfindingSystem.heapSize++;
        nodes[i] = nodeIdx;
        fs[i] = f;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (fs[parent] <= fs[i]) break;
            const tn = nodes[i]; nodes[i] = nodes[parent]; nodes[parent] = tn;
            const tf = fs[i]; fs[i] = fs[parent]; fs[parent] = tf;
            i = parent;
        }
    }

    private static heapPop(): number {
        const nodes = PathfindingSystem.heapNode;
        const fs = PathfindingSystem.heapF;
        const top = nodes[0];
        const last = --PathfindingSystem.heapSize;
        nodes[0] = nodes[last];
        fs[0] = fs[last];
        let i = 0;
        for (;;) {
            const left = i * 2 + 1;
            if (left >= last) break;
            const right = left + 1;
            const smallest = (right < last && fs[right] < fs[left]) ? right : left;
            if (fs[i] <= fs[smallest]) break;
            const tn = nodes[i]; nodes[i] = nodes[smallest]; nodes[smallest] = tn;
            const tf = fs[i]; fs[i] = fs[smallest]; fs[smallest] = tf;
            i = smallest;
        }
        return top;
    }

    private static calculateAStar(sx: number, sy: number, targetRect: { x: number, y: number, w: number, h: number }, grid: Int32Array, width: number, height: number): Phaser.Math.Vector2[] | null {
        const closed = PathfindingSystem.closedScratch;
        const gScore = PathfindingSystem.gScoreScratch;
        const cameFrom = PathfindingSystem.cameFromScratch;
        closed.fill(0);
        gScore.fill(Number.POSITIVE_INFINITY);
        cameFrom.fill(-1);
        PathfindingSystem.heapSize = 0;

        const heapCapacity = PathfindingSystem.heapNode.length;
        const targetX = targetRect.x + targetRect.w / 2;
        const targetY = targetRect.y + targetRect.h / 2;
        const octile = (x: number, y: number) => {
            const dx = Math.abs(x - targetX);
            const dy = Math.abs(y - targetY);
            const diag = Math.min(dx, dy);
            return (diag * 14) + ((Math.max(dx, dy) - diag) * 10);
        };

        const startIdx = sy * width + sx;
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) return null;
        gScore[startIdx] = 0;
        PathfindingSystem.heapPush(startIdx, octile(sx, sy));

        // Neighbor deltas: 4 cardinals (step 10) then 4 diagonals (step 14).
        const NEIGHBOR_DX = [1, -1, 0, 0, 1, 1, -1, -1];
        const NEIGHBOR_DY = [0, 0, 1, -1, 1, -1, 1, -1];

        while (PathfindingSystem.heapSize > 0) {
            const currIdx = PathfindingSystem.heapPop();
            if (closed[currIdx]) continue; // stale duplicate from lazy decrease-key
            closed[currIdx] = 1;

            const cx = currIdx % width;
            const cy = (currIdx - cx) / width;

            if (cx >= targetRect.x && cx < targetRect.x + targetRect.w &&
                cy >= targetRect.y && cy < targetRect.y + targetRect.h) {
                const path: Phaser.Math.Vector2[] = [];
                let p = currIdx;
                while (cameFrom[p] !== -1) {
                    path.push(new Phaser.Math.Vector2(p % width, Math.floor(p / width)));
                    p = cameFrom[p];
                }
                return path.reverse();
            }

            for (let k = 0; k < 8; k++) {
                const nx = cx + NEIGHBOR_DX[k];
                const ny = cy + NEIGHBOR_DY[k];
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

                if (k >= 4) {
                    // No corner cutting: if either cardinal side is blocked, skip this diagonal step.
                    const sideA = cy * width + nx;
                    const sideB = ny * width + cx;
                    if (grid[sideA] >= PathfindingSystem.COST_IMPASSABLE || grid[sideB] >= PathfindingSystem.COST_IMPASSABLE) {
                        continue;
                    }
                }

                const nIdx = ny * width + nx;
                if (closed[nIdx]) continue;

                const cellCost = grid[nIdx];
                if (cellCost >= PathfindingSystem.COST_IMPASSABLE) continue;

                const step = k >= 4 ? 14 : 10;
                const tentativeG = gScore[currIdx] + ((cellCost * step) / 10);
                if (tentativeG >= gScore[nIdx]) continue;

                gScore[nIdx] = tentativeG;
                cameFrom[nIdx] = currIdx;
                if (PathfindingSystem.heapSize < heapCapacity) {
                    PathfindingSystem.heapPush(nIdx, tentativeG + octile(nx, ny));
                }
            }
        }

        return null;
    }
}
