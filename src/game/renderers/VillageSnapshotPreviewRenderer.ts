import Phaser from 'phaser'

import { BUILDING_DEFINITIONS } from '../config/definitions/BuildingDefinitions'
import {
  OBSTACLE_DEFINITIONS,
  type ObstacleType,
} from '../config/definitions/ObstacleDefinitions'
import { MAP_SIZE } from '../config/definitions/MapDefinitions'
import type {
  SerializedBuilding,
  SerializedObstacle,
  VillageBanner,
} from '../data/Models'
import { SpriteBank } from '../render/SpriteBank'
import { depthForBuilding, depthForObstacle } from '../systems/DepthSystem'
import { IsoUtils, TILE_HEIGHT, TILE_WIDTH } from '../utils/IsoUtils'
import { drawBuildingVisual } from './BuildingVisualDispatcher'
import { townHallApexLift } from './BuildingRenderer'
import { drawGrassTile, grassPaletteFor } from './GrassRenderer'
import { ObstacleRenderer } from './ObstacleRenderer'
import { computeStoneRoutes, drawStoneLane } from './StonePathRenderer'
import { registerPixelSurface } from './TextureRenderPolicy'
import { bannerDesignFor, drawVillageFlag } from './VillageFlagRenderer'

export interface VillageSnapshotPreview {
  id: string
  ownerId: string
  username?: string
  buildings: SerializedBuilding[]
  obstacles?: SerializedObstacle[]
  banner?: VillageBanner
  stoneMaturity?: number
  lastSaveTime: number
  revision?: number | string
}

export interface VillageSnapshotPreviewResult {
  texture: Phaser.GameObjects.RenderTexture
  bounds: Phaser.Geom.Rectangle
  ready: Promise<void>
}

const HEADROOM = 112
const SNAPSHOT_SCALE = 1

/**
 * Render one read-only village through the same static postcard vocabulary as
 * the world map: shared grass, stone routes, building dispatcher, wall
 * topology, obstacle art, painter-depth ordering, heraldry, and final pixel
 * quantization. The result is presentation-only and never instantiates combat
 * or accepts input that can mutate the authoritative layout.
 */
export function renderVillageSnapshotPreview(
  scene: Phaser.Scene,
  world: VillageSnapshotPreview,
): VillageSnapshotPreviewResult {
  const buildings = Array.isArray(world.buildings) ? world.buildings : []
  const obstacles = Array.isArray(world.obstacles) ? world.obstacles : []
  const ground = scene.make.graphics({ x: 0, y: 0 }, false)
  const palette = grassPaletteFor(world.ownerId || world.id)
  const last = MAP_SIZE - 1

  for (let gridY = 0; gridY < MAP_SIZE; gridY += 1) {
    for (let gridX = 0; gridX < MAP_SIZE; gridX += 1) {
      const point = IsoUtils.cartToIso(gridX, gridY)
      const cut = gridX === 0 && gridY === 0
        ? 'nw'
        : gridX === last && gridY === 0
          ? 'ne'
          : gridX === last && gridY === last
            ? 'se'
            : gridX === 0 && gridY === last
              ? 'sw'
              : undefined
      drawGrassTile(ground, point.x, point.y, TILE_WIDTH, TILE_HEIGHT, gridX, gridY, palette, true, cut)
    }
  }

  const stoneMaturity = Math.min(1, Math.max(0, Number(world.stoneMaturity ?? 1)))
  const stoneOccluded = (x: number, y: number) => {
    const padding = 0.12
    return buildings.some(building => {
      const definition = BUILDING_DEFINITIONS[building.type]
      if (!definition) return false
      return x > building.gridX - padding
        && x < building.gridX + definition.width + padding
        && y > building.gridY - padding
        && y < building.gridY + definition.height + padding
    })
  }
  for (const route of computeStoneRoutes(buildings)) {
    drawStoneLane(ground, route.points, stoneMaturity, { offX: 0, offY: 0, occluded: stoneOccluded })
  }

  const wallAt = new Set(
    buildings
      .filter(building => building.type === 'wall')
      .map(building => `${building.gridX},${building.gridY}`),
  )
  const drawBuilding = (
    graphics: Phaser.GameObjects.Graphics,
    building: SerializedBuilding,
    skipBase: boolean,
    onlyBase: boolean,
  ) => {
    if (!BUILDING_DEFINITIONS[building.type]) return
    drawBuildingVisual({
      graphics,
      gridX: building.gridX,
      gridY: building.gridY,
      type: building.type,
      building: {
        ...building,
        owner: 'PLAYER',
      },
      skipBase,
      onlyBase,
      time: 0,
      jukeboxPlaying: false,
      wallNeighbors: building.type === 'wall'
        ? {
            nN: wallAt.has(`${building.gridX},${building.gridY - 1}`),
            nS: wallAt.has(`${building.gridX},${building.gridY + 1}`),
            nE: wallAt.has(`${building.gridX + 1},${building.gridY}`),
            nW: wallAt.has(`${building.gridX - 1},${building.gridY}`),
            owner: 'PLAYER',
          }
        : undefined,
      recoverFromRendererError: true,
    })
  }

  for (const building of buildings) drawBuilding(ground, building, false, true)

  const raised: Array<{
    depth: number
    object: Phaser.GameObjects.Graphics | Phaser.GameObjects.Image
  }> = []
  for (const building of buildings) {
    if (!BUILDING_DEFINITIONS[building.type]) continue
    const layer = scene.make.graphics({ x: 0, y: 0 }, false)
    drawBuilding(layer, building, true, false)
    raised.push({
      depth: depthForBuilding(building.gridX, building.gridY, building.type),
      object: layer,
    })
  }

  for (const obstacle of obstacles) {
    const definition = OBSTACLE_DEFINITIONS[obstacle.type as ObstacleType]
    if (!definition) continue
    const depth = depthForObstacle(obstacle.gridX, obstacle.gridY, definition.width, definition.height)
    const baked = SpriteBank.pickObstacleFrame(
      obstacle.type,
      obstacle.id,
      obstacle.gridX,
      obstacle.gridY,
      0,
    )
    if (baked) {
      const image = scene.make.image({ key: baked.atlasKey, frame: baked.meta.file }, false)
      image.setOrigin(baked.meta.originX, baked.meta.originY)
      image.setScale(baked.meta.cellWorldPx)
      const point = IsoUtils.cartToIso(obstacle.gridX + 0.5, obstacle.gridY + 0.5)
      image.setPosition(point.x, point.y)
      raised.push({ depth, object: image })
      continue
    }
    const layer = scene.make.graphics({ x: 0, y: 0 }, false)
    ObstacleRenderer.drawObstacle(layer, { ...obstacle, animOffset: 0 }, 0)
    raised.push({ depth, object: layer })
  }

  const hall = buildings.find(building => building.type === 'town_hall')
  if (hall && world.banner) {
    const definition = BUILDING_DEFINITIONS.town_hall
    const apex = IsoUtils.cartToIso(
      hall.gridX + definition.width / 2,
      hall.gridY + definition.height / 2,
    )
    const flag = scene.make.graphics({ x: 0, y: 0 }, false)
    drawVillageFlag(
      flag,
      apex.x,
      apex.y - townHallApexLift(hall.level ?? 1),
      0,
      bannerDesignFor(world.ownerId, world.banner),
      1,
      { poleH: 32, clothW: 30, clothH: 19, amp: 2 },
    )
    raised.push({
      depth: depthForBuilding(hall.gridX, hall.gridY, 'town_hall') + 1,
      object: flag,
    })
  }

  raised.sort((left, right) => left.depth - right.depth)

  const top = IsoUtils.cartToIso(0, 0)
  const right = IsoUtils.cartToIso(MAP_SIZE, 0)
  const bottom = IsoUtils.cartToIso(MAP_SIZE, MAP_SIZE)
  const left = IsoUtils.cartToIso(0, MAP_SIZE)
  const bounds = new Phaser.Geom.Rectangle(
    left.x,
    top.y - HEADROOM,
    right.x - left.x,
    bottom.y - top.y + HEADROOM,
  )
  const texture = scene.add.renderTexture(
    bounds.x,
    bounds.y,
    Math.ceil(bounds.width * SNAPSHOT_SCALE),
    Math.ceil(bounds.height * SNAPSHOT_SCALE),
  )
  registerPixelSurface(texture.texture)
  texture.setOrigin(0, 0)
  texture.setScale(1 / SNAPSHOT_SCALE)
  ground.setScale(SNAPSHOT_SCALE)
  texture.draw(ground, -bounds.x * SNAPSHOT_SCALE, -bounds.y * SNAPSHOT_SCALE)
  for (const item of raised) {
    const layer = item.object
    layer.setScale(layer.scaleX * SNAPSHOT_SCALE, layer.scaleY * SNAPSHOT_SCALE)
    if (layer instanceof Phaser.GameObjects.Image) {
      texture.draw(
        layer,
        (layer.x - bounds.x) * SNAPSHOT_SCALE,
        (layer.y - bounds.y) * SNAPSHOT_SCALE,
      )
    } else {
      texture.draw(layer, -bounds.x * SNAPSHOT_SCALE, -bounds.y * SNAPSHOT_SCALE)
    }
  }
  ground.destroy()
  for (const item of raised) item.object.destroy()
  texture.setVisible(false)
  const ready = new Promise<void>(resolve => {
    SpriteBank.quantizeRenderTexture(scene, texture, 1.35 * SNAPSHOT_SCALE, 0, () => {
      if (texture.scene) texture.setVisible(true)
      resolve()
    })
  })

  return { texture, bounds, ready }
}
