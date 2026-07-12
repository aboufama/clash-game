import Phaser from 'phaser';
import { BUILDING_DEFINITIONS, getTroopStats } from '../config/GameDefinitions';
import type { Troop, PlacedBuilding } from '../types/GameTypes';

export class TargetingSystem {

    static findTarget(troop: Troop, buildings: PlacedBuilding[]): PlacedBuilding | null {
        const def = getTroopStats(troop.type, troop.level || 1);

        const enemies = buildings.filter(b => {
            if (b.owner === troop.owner || b.health <= 0) return false;
            return !!BUILDING_DEFINITIONS[b.type as keyof typeof BUILDING_DEFINITIONS];
        });
        if (enemies.length === 0) return null;

        const isWall = (b: PlacedBuilding) => b.type === 'wall';
        const isDefense = (b: PlacedBuilding) => {
            const def = BUILDING_DEFINITIONS[b.type as keyof typeof BUILDING_DEFINITIONS];
            return def ? def.category === 'defense' : false;
        };

        const nonWalls = enemies.filter(b => !isWall(b));

        let candidates: PlacedBuilding[] = [];

        // 1. Check Priority Targets
        if (def.targetPriority === 'defense') {
            // Prioritize Defenses
            const defenses = enemies.filter(b => !isWall(b) && isDefense(b));
            if (defenses.length > 0) {
                candidates = defenses;
            }
        } else if (def.targetPriority === 'town_hall') {
            // Prioritize Town Hall
            const th = enemies.find(b => b.type === 'town_hall');
            if (th) candidates = [th];
        } else if (def.targetPriority === 'wall') {
            // Prioritize Walls
            const walls = enemies.filter(b => isWall(b));
            if (walls.length > 0) {
                candidates = walls;
            }
        }

        // 2. Fallback to General Targets (Non-Walls for non-wall-targeting, all for wall-targeting)
        if (candidates.length === 0) {
            candidates = nonWalls;
        }

        // 3. Fallback: If only walls remain, return null (battle over) — unless troop targets walls.
        if (candidates.length === 0) {
            if (def.targetPriority === 'wall') {
                candidates = enemies; // walls included
            }
            if (candidates.length === 0) return null;
        }

        // 4. Find Nearest Candidate
        let nearest: PlacedBuilding | null = null;
        let minDist = Infinity;

        candidates.forEach(b => {
            const info = BUILDING_DEFINITIONS[b.type as keyof typeof BUILDING_DEFINITIONS];
            if (!info) return;
            const centerX = b.gridX + info.width / 2;
            const centerY = b.gridY + info.height / 2;

            const dist = Phaser.Math.Distance.Between(troop.gridX, troop.gridY, centerX, centerY);
            if (dist < minDist) {
                minDist = dist;
                nearest = b;
            }
        });

        return nearest;
    }
}
