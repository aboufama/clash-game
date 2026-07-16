/**
 * Node-only test seam for PathfindingSystem. Production still imports Phaser;
 * the pathing regression aliases that dependency to this tiny compatible math
 * surface so it exercises the real A* implementation without starting a DOM.
 */
class Vector2 {
    constructor(public x = 0, public y = 0) {}
}

export default {
    Math: {
        Vector2,
        Clamp(value: number, min: number, max: number) {
            return Math.max(min, Math.min(max, value));
        }
    }
};
