import type { SerializedBuilding, SerializedWorld } from '../data/Models';
import {
  BUILDING_DEFINITIONS,
  TROOP_DEFINITIONS,
  type BuildingType,
  type PlayerTroopType
} from './GameDefinitions';

export const INTRO_BATTLE_WORLD_ID = 'sir-andre-intro';

/** A deliberately readable heavy roster: no tiny disposable troops or
 * support units. Every body on the field looks consequential. */
export const INTRO_BATTLE_ARMY: Readonly<Record<PlayerTroopType, number>> = Object.freeze({
  warrior: 0,
  archer: 0,
  physicianscart: 0,
  phalanx: 0,
  goblinplunderer: 0,
  wallbreaker: 0,
  stormmage: 0,
  necromancer: 0,
  warelephant: 2,
  golem: 2,
  icegolem: 0,
  clockworkbeetle: 0,
  ram: 0,
  mobilemortar: 0,
  siegetower: 2,
  trebuchet: 4,
  ornithopter: 2,
  davincitank: 3
});

export const INTRO_BATTLE_ARMY_SPACE = Object.entries(INTRO_BATTLE_ARMY).reduce(
  (sum, [type, count]) => sum + (TROOP_DEFINITIONS[type as PlayerTroopType]?.space ?? 0) * count,
  0
);

type Ring = { x0: number; y0: number; x1: number; y1: number };

const OUTER_CURTAIN: Ring = { x0: 2, y0: 2, x1: 22, y1: 22 };
const INNER_KEEP: Ring = { x0: 7, y0: 7, x1: 17, y1: 17 };

function ringCells({ x0, y0, x1, y1 }: Ring): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let x = x0; x <= x1; x += 1) cells.push([x, y0], [x, y1]);
  for (let y = y0 + 1; y < y1; y += 1) cells.push([x0, y], [x1, y]);
  return cells;
}

/** Broad gates keep the tutorial winnable without throwaway wall breakers
 * while an exact legal 100-wall double curtain gives Siege Towers real work. */
function isGate([x, y]: [number, number], ring: Ring): boolean {
  const midX = Math.floor((ring.x0 + ring.x1) / 2);
  const midY = Math.floor((ring.y0 + ring.y1) / 2);
  const horizontalGate = (y === ring.y0 || y === ring.y1) && Math.abs(x - midX) <= 1;
  const verticalHalfWidth = ring === OUTER_CURTAIN ? 1 : 0;
  const verticalGate = (x === ring.x0 || x === ring.x1)
    && Math.abs(y - midY) <= verticalHalfWidth;
  return horizontalGate || verticalGate;
}

const WALL_CELLS = [
  ...ringCells(OUTER_CURTAIN).filter(cell => !isGate(cell, OUTER_CURTAIN)),
  ...ringCells(INNER_KEEP).filter(cell => !isGate(cell, INNER_KEEP))
];

const FORTRESS_BUILDINGS: ReadonlyArray<{ type: BuildingType; x: number; y: number }> = [
  // The keep: every defense is at its authored maximum level.
  { type: 'town_hall', x: 11, y: 11 },
  { type: 'mortar', x: 8, y: 8 },
  { type: 'ballista', x: 15, y: 8 },
  { type: 'xbow', x: 8, y: 15 },
  { type: 'spike_launcher', x: 15, y: 15 },
  { type: 'cannon', x: 10, y: 8 },
  { type: 'prism', x: 13, y: 8 },
  { type: 'tesla', x: 10, y: 16 },
  { type: 'cannon', x: 14, y: 16 },
  { type: 'cannon', x: 8, y: 11 },
  { type: 'tesla', x: 16, y: 11 },
  { type: 'cannon', x: 8, y: 14 },
  { type: 'cannon', x: 16, y: 14 },

  // The ward between both wall lines gives the base a full high-level
  // military silhouette instead of reading as a defense test grid.
  { type: 'dragons_breath', x: 3, y: 8 },
  { type: 'mortar', x: 18, y: 8 },
  { type: 'mortar', x: 8, y: 3 },
  { type: 'ballista', x: 15, y: 3 },
  { type: 'xbow', x: 8, y: 19 },
  { type: 'spike_launcher', x: 15, y: 19 },
  { type: 'watchtower', x: 3, y: 4 },
  { type: 'xbow', x: 20, y: 4 },
  { type: 'storage', x: 3, y: 14 },
  { type: 'lab', x: 5, y: 14 },
  { type: 'barracks', x: 18, y: 14 },
  { type: 'mystic_barracks', x: 20, y: 14 },
  { type: 'storage', x: 3, y: 18 },
  { type: 'farm', x: 18, y: 18 }
];

function building(type: BuildingType, gridX: number, gridY: number): SerializedBuilding {
  return {
    id: `intro-${type}-${gridX}-${gridY}`,
    type,
    gridX,
    gridY,
    level: BUILDING_DEFINITIONS[type]?.maxLevel ?? 1
  };
}

/** A pure factory so every retry gets full-health entities and a fresh world
 * timestamp without any mutation leaking between tutorial attempts. */
export function createSirAndreIntroWorld(now = Date.now()): SerializedWorld {
  return {
    id: INTRO_BATTLE_WORLD_ID,
    ownerId: 'scenario_iron_crown',
    username: 'Iron Crown Citadel',
    buildings: [
      ...FORTRESS_BUILDINGS.map(item => building(item.type, item.x, item.y)),
      ...WALL_CELLS.map(([x, y]) => building('wall', x, y))
    ],
    obstacles: [],
    resources: { gold: 0, ore: 0, food: 0 },
    population: { count: 48, capacity: 48, workersNeeded: 0, staffing: 1 },
    banner: { palette: 3, emblem: 5, pattern: 2 },
    army: {},
    wallLevel: BUILDING_DEFINITIONS.wall.maxLevel,
    lastSaveTime: now,
    revision: 1
  };
}
