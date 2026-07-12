import { BUILDING_DEFINITIONS, OBSTACLE_DEFINITIONS, type BuildingType } from '../config/GameDefinitions';
import type { SerializedBuilding, SerializedObstacle, SerializedWorld } from '../data/Models';

/** Bump when the canonical seeded village projection changes. */
export const BOT_WORLD_GENERATION_VERSION = 2;

function randomId(prefix = 'b_') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}${crypto.randomUUID()}`;
  }
  return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Procedural bot worlds are shared by the client and game server. The seeded
 * variant backs global-map and cloud bot-raid sessions: the same seed always
 * builds the same village, ids and loot on both sides.
 * The seeded RNG and id factory are passed into the generator explicitly;
 * never replace global Math.random, even briefly.
 */
export function generateBotWorldFromSeed(seed: number): SerializedWorld {
    const normalizedSeed = (seed >>> 0) || 1;
    let state = normalizedSeed;
    const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const world = generateEnemyWorld(random, normalizedSeed);
    world.id = `bot_${normalizedSeed}`;
    world.ownerId = `bot_${normalizedSeed}`;
    world.lastSaveTime = 0;
    world.revision = BOT_WORLD_GENERATION_VERSION;
    return world;
}

export function generateEnemyWorld(random: () => number = Math.random, deterministicSeed?: number): SerializedWorld {
    const mapSize = 25;
    const margin = 1;
    const centerX = Math.floor(mapSize / 2);
    const centerY = Math.floor(mapSize / 2);
    let deterministicIdCounter = 0;
    const makeId = (prefix = 'b_') => deterministicSeed === undefined
      ? randomId(prefix)
      : `${prefix}${deterministicSeed.toString(36)}_${(deterministicIdCounter++).toString(36)}`;

    const randInt = (min: number, max: number) => {
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      return lo + Math.floor(random() * (hi - lo + 1));
    };

    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const chance = (probability: number) => random() < probability;
    const tileKey = (x: number, y: number) => `${x},${y}`;

    const shuffle = <T,>(items: readonly T[]) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = randInt(0, i);
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    };

    type Difficulty = 'easy' | 'intermediate' | 'hard' | 'crazy';
    type Rect = { minX: number; minY: number; maxX: number; maxY: number };
    type Zone = Rect & { minRadius?: number; maxRadius?: number };
    type LevelFactory = number | (() => number);

    const difficultyRoll = random();
    const difficulty: Difficulty =
      difficultyRoll < 0.40 ? 'easy' :
      difficultyRoll < 0.85 ? 'intermediate' :
      difficultyRoll < 0.95 ? 'hard' :
      'crazy'; // Keep "insane" (crazy) at 5%.

    const botNameByDifficulty: Record<Difficulty, string> = {
      easy: 'Bot Easy Base',
      intermediate: 'Bot Intermediate Base',
      hard: 'Bot Hard Fortress',
      crazy: 'Bot Crazy Max Base'
    };

    const lootByDifficulty: Record<Difficulty, { base: number; variance: number; perBuilding: number }> = {
      easy: { base: 9000, variance: 8000, perBuilding: 140 },
      intermediate: { base: 23000, variance: 18000, perBuilding: 220 },
      hard: { base: 52000, variance: 42000, perBuilding: 320 },
      crazy: { base: 110000, variance: 90000, perBuilding: 500 }
    };

    const buildings: SerializedBuilding[] = [];
    const occupied = new Set<string>();
    const structureOccupied = new Set<string>();
    const wallIndexByTile = new Map<string, number>();
    const placedCount = new Map<BuildingType, number>();
    let wallLevel = 1;
    const enforceStructureGap = difficulty !== 'crazy';

    const getPlacedCount = (type: BuildingType) => placedCount.get(type) ?? 0;
    const bumpPlacedCount = (type: BuildingType) => {
      placedCount.set(type, getPlacedCount(type) + 1);
    };

    const maxLevelFor = (type: BuildingType) => BUILDING_DEFINITIONS[type].maxLevel ?? 1;
    const normalizeLevel = (type: BuildingType, level: number) => clamp(level, 1, maxLevelFor(type));
    const isDefenseType = (type: BuildingType) => {
      const info = BUILDING_DEFINITIONS[type];
      return info.category === 'defense' && type !== 'wall';
    };
    const advancedDefenseTypes = new Set<BuildingType>([
      'prism',
      'dragons_breath',
      'spike_launcher'
    ]);
    const clampRect = (rect: Rect): Rect => {
      const minX = clamp(rect.minX, margin, mapSize - margin - 3);
      const minY = clamp(rect.minY, margin, mapSize - margin - 3);
      const maxX = clamp(rect.maxX, minX + 2, mapSize - margin - 1);
      const maxY = clamp(rect.maxY, minY + 2, mapSize - margin - 1);
      return { minX, minY, maxX, maxY };
    };
    const insetRect = (rect: Rect, inset: number): Rect => {
      const safeInset = Math.max(0, Math.floor(inset));
      return clampRect({
        minX: rect.minX + safeInset,
        minY: rect.minY + safeInset,
        maxX: rect.maxX - safeInset,
        maxY: rect.maxY - safeInset
      });
    };
    const defenseLevelFactory = (type: BuildingType): (() => number) => {
      const max = maxLevelFor(type);
      if (!isDefenseType(type) || max <= 1) return () => 1;

      return () => {
        let minLevel = 1;
        let maxLevel = max;

        if (difficulty === 'easy') {
          maxLevel = Math.min(max, 2);
        } else if (difficulty === 'intermediate') {
          maxLevel = Math.min(max, 3);
          minLevel = maxLevel >= 2 && chance(0.55) ? 2 : 1;
        } else if (difficulty === 'hard') {
          maxLevel = Math.min(max, 4);
          minLevel = Math.max(1, Math.min(maxLevel, 2));
        } else {
          minLevel = Math.max(1, max - 1);
          maxLevel = max;
        }

        if (advancedDefenseTypes.has(type)) {
          if (difficulty === 'intermediate') {
            minLevel = Math.max(minLevel, Math.max(1, maxLevel - 1));
          } else if (difficulty === 'hard') {
            minLevel = Math.max(minLevel, Math.max(1, maxLevel - 1));
            if (chance(0.35)) return maxLevel;
          } else if (difficulty === 'crazy') {
            minLevel = Math.max(minLevel, maxLevel - 1);
            if (chance(0.7)) return maxLevel;
          }
        }

        return randInt(minLevel, maxLevel);
      };
    };

    const inBounds = (x: number, y: number, width: number, height: number) => {
      return x >= margin && y >= margin && x + width <= mapSize - margin && y + height <= mapSize - margin;
    };

    const canPlaceRect = (x: number, y: number, width: number, height: number) => {
      for (let dx = 0; dx < width; dx++) {
        for (let dy = 0; dy < height; dy++) {
          if (occupied.has(tileKey(x + dx, y + dy))) return false;
        }
      }
      return true;
    };

    const occupyRect = (x: number, y: number, width: number, height: number) => {
      for (let dx = 0; dx < width; dx++) {
        for (let dy = 0; dy < height; dy++) {
          occupied.add(tileKey(x + dx, y + dy));
        }
      }
    };

    const canPlaceWithStructureGap = (x: number, y: number, width: number, height: number) => {
      if (!enforceStructureGap) return true;
      const gapTiles = 1;
      for (let dx = -gapTiles; dx < width + gapTiles; dx++) {
        for (let dy = -gapTiles; dy < height + gapTiles; dy++) {
          const tx = x + dx;
          const ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= mapSize || ty >= mapSize) continue;
          if (structureOccupied.has(tileKey(tx, ty))) return false;
        }
      }
      return true;
    };

    const occupyStructureRect = (x: number, y: number, width: number, height: number) => {
      if (!enforceStructureGap) return;
      for (let dx = 0; dx < width; dx++) {
        for (let dy = 0; dy < height; dy++) {
          structureOccupied.add(tileKey(x + dx, y + dy));
        }
      }
    };

    const distanceToCenter = (x: number, y: number, width: number, height: number) => {
      const px = x + width / 2;
      const py = y + height / 2;
      return Math.hypot(px - centerX, py - centerY);
    };

    const placeBuilding = (type: BuildingType, x: number, y: number, level: number): boolean => {
      const definition = BUILDING_DEFINITIONS[type];
      if (getPlacedCount(type) >= definition.maxCount) return false;

      if (type === 'wall' && wallIndexByTile.has(tileKey(x, y))) {
        return true;
      }

      const normalizedLevel = normalizeLevel(type, level);
      if (!inBounds(x, y, definition.width, definition.height)) return false;
      if (!canPlaceRect(x, y, definition.width, definition.height)) return false;
      if (type !== 'wall' && !canPlaceWithStructureGap(x, y, definition.width, definition.height)) return false;

      const idx = buildings.push({
        id: makeId(),
        type,
        gridX: x,
        gridY: y,
        level: normalizedLevel
      }) - 1;

      occupyRect(x, y, definition.width, definition.height);
      if (type !== 'wall') {
        occupyStructureRect(x, y, definition.width, definition.height);
      }
      bumpPlacedCount(type);
      if (type === 'wall') {
        wallIndexByTile.set(tileKey(x, y), idx);
      }
      return true;
    };

    const tryPlaceInZones = (
      type: BuildingType,
      level: number,
      zones: Zone[],
      attempts = 260
    ) => {
      const definition = BUILDING_DEFINITIONS[type];
      if (zones.length === 0) return false;

      for (let attempt = 0; attempt < attempts; attempt++) {
        const zone = zones[randInt(0, zones.length - 1)];
        const minX = zone.minX;
        const maxX = zone.maxX - definition.width + 1;
        const minY = zone.minY;
        const maxY = zone.maxY - definition.height + 1;
        if (maxX < minX || maxY < minY) continue;

        const x = randInt(minX, maxX);
        const y = randInt(minY, maxY);
        const dist = distanceToCenter(x, y, definition.width, definition.height);
        if (typeof zone.minRadius === 'number' && dist < zone.minRadius) continue;
        if (typeof zone.maxRadius === 'number' && dist > zone.maxRadius) continue;
        if (placeBuilding(type, x, y, level)) return true;
      }

      return false;
    };

    const resolveLevel = (type: BuildingType, levelFactory: LevelFactory) => {
      const rawLevel = typeof levelFactory === 'number' ? levelFactory : levelFactory();
      return normalizeLevel(type, rawLevel);
    };

    const addWallRing = (
      rect: Rect,
      gateCount: number,
      gateSpan = 2
    ) => {
      if (rect.maxX - rect.minX < 2 || rect.maxY - rect.minY < 2) return;

      type Edge = 'top' | 'bottom' | 'left' | 'right';
      const gateTiles = new Set<string>();
      const edges: Edge[] = ['top', 'bottom', 'left', 'right'];

      for (let i = 0; i < gateCount; i++) {
        const edge = edges[randInt(0, edges.length - 1)];

        if (edge === 'top' || edge === 'bottom') {
          const y = edge === 'top' ? rect.minY : rect.maxY;
          const startX = randInt(rect.minX + 1, rect.maxX - 1);
          for (let offset = 0; offset < gateSpan; offset++) {
            const x = clamp(startX + offset, rect.minX + 1, rect.maxX - 1);
            gateTiles.add(tileKey(x, y));
          }
        } else {
          const x = edge === 'left' ? rect.minX : rect.maxX;
          const startY = randInt(rect.minY + 1, rect.maxY - 1);
          for (let offset = 0; offset < gateSpan; offset++) {
            const y = clamp(startY + offset, rect.minY + 1, rect.maxY - 1);
            gateTiles.add(tileKey(x, y));
          }
        }
      }

      for (let x = rect.minX; x <= rect.maxX; x++) {
        if (!gateTiles.has(tileKey(x, rect.minY))) placeBuilding('wall', x, rect.minY, wallLevel);
        if (!gateTiles.has(tileKey(x, rect.maxY))) placeBuilding('wall', x, rect.maxY, wallLevel);
      }

      for (let y = rect.minY + 1; y <= rect.maxY - 1; y++) {
        if (!gateTiles.has(tileKey(rect.minX, y))) placeBuilding('wall', rect.minX, y, wallLevel);
        if (!gateTiles.has(tileKey(rect.maxX, y))) placeBuilding('wall', rect.maxX, y, wallLevel);
      }
    };

    // ================= anatomy-driven layout =================
    // Every bot base reads as a REAL village: a walled core holds the town
    // hall and its defenses, a farming quarter and an army quarter sit
    // outside the gates (each gate faces its quarter), and guard posts watch
    // the yards. Difficulty scales the ring, the roster and the levels —
    // never the anatomy. All placement is collision-checked (occupied set +
    // one-tile structure gap), so nothing ever overlaps.

    const ringHalfByDifficulty: Record<Difficulty, number> = { easy: 4, intermediate: 6, hard: 7, crazy: 7 };
    const ringHalf = ringHalfByDifficulty[difficulty] + randInt(0, 1);
    const ring = clampRect({
      minX: centerX - ringHalf,
      minY: centerY - ringHalf,
      maxX: centerX + ringHalf,
      maxY: centerY + ringHalf
    });
    const coreYard = insetRect(ring, 1);

    wallLevel =
      difficulty === 'easy' ? 1 :
      difficulty === 'intermediate' ? 2 :
      difficulty === 'hard' ? (chance(0.5) ? 4 : 3) : 4;

    // The hall at the heart of the core.
    const townHallDef = BUILDING_DEFINITIONS.town_hall;
    placeBuilding(
      'town_hall',
      centerX - Math.floor(townHallDef.width / 2),
      centerY - Math.floor(townHallDef.height / 2),
      difficulty === 'crazy' ? maxLevelFor('town_hall') : difficulty === 'easy' ? 1 : 2
    );

    /** Spiral outward from an anchor until the building fits (optionally boxed into a rect). */
    const placeNear = (type: BuildingType, ax: number, ay: number, level: number, within?: Rect): boolean => {
      const def = BUILDING_DEFINITIONS[type];
      for (let radius = 0; radius <= 5; radius++) {
        const offsets: Array<[number, number]> = [];
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dy = -radius; dy <= radius; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            offsets.push([dx, dy]);
          }
        }
        for (const [dx, dy] of shuffle(offsets)) {
          const x = ax + dx - Math.floor(def.width / 2);
          const y = ay + dy - Math.floor(def.height / 2);
          if (within && (x < within.minX || y < within.minY || x + def.width - 1 > within.maxX || y + def.height - 1 > within.maxY)) continue;
          if (placeBuilding(type, x, y, level)) return true;
        }
      }
      return false;
    };

    // ---- the quarters: gates face them, so the village reads connected ----
    type Side = 'N' | 'E' | 'S' | 'W';
    const econSide = shuffle(['N', 'E', 'S', 'W'] as Side[])[0];
    const armySide: Side = econSide === 'N' ? 'S' : econSide === 'S' ? 'N' : econSide === 'E' ? 'W' : 'E';
    const anchorFor = (side: Side, dist: number) =>
      side === 'N' ? { x: centerX, y: ring.minY - dist } :
      side === 'S' ? { x: centerX, y: ring.maxY + dist } :
      side === 'W' ? { x: ring.minX - dist, y: centerY } :
      { x: ring.maxX + dist, y: centerY };

    // ---- wall ring with a two-tile gate toward each quarter ----
    const gateTiles = new Set<string>();
    for (const side of [econSide, armySide] as Side[]) {
      if (side === 'N' || side === 'S') {
        const y = side === 'N' ? ring.minY : ring.maxY;
        gateTiles.add(tileKey(centerX, y));
        gateTiles.add(tileKey(centerX + 1, y));
      } else {
        const x = side === 'W' ? ring.minX : ring.maxX;
        gateTiles.add(tileKey(x, centerY));
        gateTiles.add(tileKey(x, centerY + 1));
      }
    }
    const wantsWalls = difficulty !== 'easy' || chance(0.7);
    if (wantsWalls) {
      for (let x = ring.minX; x <= ring.maxX; x++) {
        if (!gateTiles.has(tileKey(x, ring.minY))) placeBuilding('wall', x, ring.minY, wallLevel);
        if (!gateTiles.has(tileKey(x, ring.maxY))) placeBuilding('wall', x, ring.maxY, wallLevel);
      }
      for (let y = ring.minY + 1; y <= ring.maxY - 1; y++) {
        if (!gateTiles.has(tileKey(ring.minX, y))) placeBuilding('wall', ring.minX, y, wallLevel);
        if (!gateTiles.has(tileKey(ring.maxX, y))) placeBuilding('wall', ring.maxX, y, wallLevel);
      }
    }
    // Hard/crazy keep a second ring around the hall itself.
    if (difficulty === 'hard' || difficulty === 'crazy') {
      addWallRing(insetRect(ring, 3), 1, 2);
    }

    // ---- core defenses ring the hall inside the walls ----
    const aR = Math.max(3, ringHalf - 2);
    const coreAnchors = shuffle([
      { x: centerX - aR, y: centerY - aR }, { x: centerX + aR, y: centerY - aR },
      { x: centerX - aR, y: centerY + aR }, { x: centerX + aR, y: centerY + aR },
      { x: centerX, y: centerY - aR - 1 }, { x: centerX, y: centerY + aR + 1 },
      { x: centerX - aR - 1, y: centerY }, { x: centerX + aR + 1, y: centerY }
    ]);
    const coreDefenses: BuildingType[] =
      difficulty === 'easy'
        ? (['cannon', 'cannon', ...(chance(0.55) ? ['mortar'] : []), ...(chance(0.35) ? ['tesla'] : [])] as BuildingType[])
        : difficulty === 'intermediate'
          ? (['cannon', 'cannon', 'cannon', 'mortar', 'tesla', ...(chance(0.6) ? ['ballista'] : []), ...(chance(0.45) ? ['xbow'] : [])] as BuildingType[])
          : difficulty === 'hard'
            ? (['cannon', 'cannon', 'mortar', 'mortar', 'tesla', 'ballista', 'ballista', 'xbow', 'xbow', ...(chance(0.6) ? ['prism'] : []), ...(chance(0.5) ? ['dragons_breath'] : ['spike_launcher'])] as BuildingType[])
            : (['dragons_breath', 'prism', 'xbow', 'xbow', 'ballista', 'ballista', 'mortar', 'mortar', 'tesla', 'tesla', 'spike_launcher', 'spike_launcher', 'cannon', 'cannon'] as BuildingType[]);
    coreDefenses.forEach((type, i) => {
      const anchor = coreAnchors[i % coreAnchors.length];
      const level = resolveLevel(type, defenseLevelFactory(type));
      if (!placeNear(type, anchor.x, anchor.y, level, coreYard)) {
        tryPlaceInZones(type, level, [{ ...coreYard }], 400);
      }
    });

    // ---- the farming quarter: storehouse, mine(s) and field(s) by the gate ----
    const econLevel = () =>
      difficulty === 'easy' ? 1 :
      difficulty === 'intermediate' ? randInt(1, 2) :
      difficulty === 'hard' ? randInt(2, 3) : 3;
    const econAnchor = anchorFor(econSide, 4);
    const econPlan: BuildingType[] =
      difficulty === 'easy' ? ['mine', 'farm'] :
      difficulty === 'intermediate' ? ['storage', 'mine', 'farm', 'farm'] :
      difficulty === 'hard' ? ['storage', 'mine', 'mine', 'farm', 'farm'] :
      ['storage', 'storage', 'mine', 'mine', 'mine', 'farm', 'farm', 'farm'];
    const anywhere: Rect = { minX: margin, minY: margin, maxX: mapSize - margin - 1, maxY: mapSize - margin - 1 };
    for (const type of econPlan) {
      const level = econLevel();
      if (!placeNear(type, econAnchor.x + randInt(-2, 2), econAnchor.y + randInt(-2, 2), level)) {
        // Cramped map edge: the quarter spills wherever there is room.
        tryPlaceInZones(type, level, [{ ...anywhere }], 600);
      }
    }

    // ---- the army quarter: barracks drilling ground by the other gate ----
    const armyAnchor = anchorFor(armySide, 4);
    const barracksLevel =
      difficulty === 'easy' ? 5 : difficulty === 'intermediate' ? 8 :
      difficulty === 'hard' ? 11 : maxLevelFor('barracks');
    if (!placeNear('barracks', armyAnchor.x, armyAnchor.y, barracksLevel)) {
      tryPlaceInZones('barracks', barracksLevel, [{ ...anywhere }], 600);
    }
    const campCount = difficulty === 'easy' ? 1 : difficulty === 'intermediate' ? 2 : difficulty === 'hard' ? 3 : BUILDING_DEFINITIONS.army_camp.maxCount;
    const campLevel = difficulty === 'easy' ? 1 : difficulty === 'intermediate' ? 2 : 3;
    for (let i = 0; i < campCount; i++) {
      if (!placeNear('army_camp', armyAnchor.x + randInt(-3, 3), armyAnchor.y + randInt(-3, 3), campLevel)) {
        tryPlaceInZones('army_camp', campLevel, [{ ...anywhere }], 600);
      }
    }
    if (difficulty !== 'easy') {
      placeNear('lab', armyAnchor.x + randInt(-3, 3), armyAnchor.y + randInt(-3, 3),
        difficulty === 'intermediate' ? 1 : difficulty === 'hard' ? 2 : maxLevelFor('lab'));
    }

    // Settled clans keep a watch: intermediate and up raise the tower.
    if (difficulty !== 'easy') {
      placeNear('watchtower', ring.maxX - 1, ring.minY - 3, difficulty === 'intermediate' ? 1 : 2);
    }

    // ---- guard posts watching the yards (hard+) ----
    if (difficulty === 'hard' || difficulty === 'crazy') {
      const guardLevel = defenseLevelFactory('cannon');
      placeNear('cannon', econAnchor.x + randInt(-2, 2), econAnchor.y + randInt(-2, 2), resolveLevel('cannon', guardLevel));
      placeNear('cannon', armyAnchor.x + randInt(-2, 2), armyAnchor.y + randInt(-2, 2), resolveLevel('cannon', guardLevel));
      if (difficulty === 'crazy') {
        placeNear('tesla', econAnchor.x, econAnchor.y, resolveLevel('tesla', defenseLevelFactory('tesla')));
        placeNear('tesla', armyAnchor.x, armyAnchor.y, resolveLevel('tesla', defenseLevelFactory('tesla')));
      }
    }

    const hasNonWallBuilding = buildings.some(building => building.type !== 'wall');
    if (!hasNonWallBuilding) {
      // Absolute guard: ensure generated bot bases always have playable structures.
      buildings.length = 0;
      const cx = centerX - 1;
      const cy = centerY - 1;
      buildings.push(
        { id: makeId(), type: 'town_hall', gridX: cx, gridY: cy, level: 1 },
        { id: makeId(), type: 'cannon', gridX: cx - 3, gridY: cy, level: 1 },
        { id: makeId(), type: 'barracks', gridX: cx + 4, gridY: cy, level: 1 },
        { id: makeId(), type: 'army_camp', gridX: cx, gridY: cy + 4, level: 1 }
      );
    }

    const lootConfig = lootByDifficulty[difficulty];
    const resourceGold = Math.floor(
      lootConfig.base +
      random() * lootConfig.variance +
      buildings.length * lootConfig.perBuilding
    );

    // Generated camps are villages, not bare combat puzzles. Keep their
    // environmental dressing in the canonical seeded world so postcards,
    // scouting and local attacks all render the exact same rocks, trees and
    // grass patches. Nothing here is simulated per frame or stored server-side:
    // the seed recreates this compact manifest on demand on every machine.
    const obstacles: SerializedObstacle[] = [];
    const placeObstacle = (
      type: SerializedObstacle['type'],
      x: number,
      y: number
    ): boolean => {
      const definition = OBSTACLE_DEFINITIONS[type];
      if (!inBounds(x, y, definition.width, definition.height)) return false;
      if (!canPlaceRect(x, y, definition.width, definition.height)) return false;
      obstacles.push({ id: makeId('o_'), type, gridX: x, gridY: y });
      occupyRect(x, y, definition.width, definition.height);
      return true;
    };
    const scatter = (
      type: SerializedObstacle['type'],
      count: number,
      edgeBiased: boolean
    ) => {
      let placed = 0;
      for (let attempt = 0; attempt < count * 80 && placed < count; attempt++) {
        let x = randInt(margin, mapSize - margin - 1);
        let y = randInt(margin, mapSize - margin - 1);
        if (edgeBiased) {
          const edge = randInt(0, 3);
          if (edge === 0) y = randInt(margin, 4);
          else if (edge === 1) x = randInt(mapSize - 5, mapSize - margin - 1);
          else if (edge === 2) y = randInt(mapSize - 5, mapSize - margin - 1);
          else x = randInt(margin, 4);
        }
        if (placeObstacle(type, x, y)) placed++;
      }
    };

    const environmentByDifficulty: Record<Difficulty, {
      grass: number;
      smallRocks: number;
      largeRocks: number;
      oaks: number;
      pines: number;
    }> = {
      easy: { grass: 24, smallRocks: 7, largeRocks: 2, oaks: 3, pines: 4 },
      intermediate: { grass: 20, smallRocks: 6, largeRocks: 2, oaks: 3, pines: 3 },
      hard: { grass: 16, smallRocks: 5, largeRocks: 2, oaks: 2, pines: 3 },
      crazy: { grass: 12, smallRocks: 4, largeRocks: 1, oaks: 2, pines: 2 }
    };
    const environment = environmentByDifficulty[difficulty];
    scatter('tree_oak', environment.oaks, true);
    scatter('tree_pine', environment.pines, true);
    scatter('rock_large', environment.largeRocks, true);
    scatter('rock_small', environment.smallRocks, true);
    scatter('grass_patch', environment.grass, false);

    // A compact authority record gives every generated settlement a real,
    // stable census. NeighborLifeSim samples these residents directly from
    // shared wall time, so increasing the visible crowd does not create
    // server entities, network updates or offscreen simulation work.
    const nonWallBuildings = buildings.filter(building => building.type !== 'wall').length;
    const population = clamp(7 + Math.floor(nonWallBuildings * 0.65), 8, 24);
    const botIdentity = deterministicSeed === undefined
      ? `bot:${makeId('life_')}`
      : `bot:${deterministicSeed >>> 0}`;

    return {
      id: `bot_${makeId('world_')}`,
      ownerId: 'bot',
      username: botNameByDifficulty[difficulty],
      buildings,
      obstacles,
      life: {
        version: 1,
        identity: botIdentity,
        population,
        bornAt: [],
        simulatedThrough: 0
      },
      resources: { gold: resourceGold },
      lastSaveTime: Date.now(),
      revision: BOT_WORLD_GENERATION_VERSION
    };
  }
