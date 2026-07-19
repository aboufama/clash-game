import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Expand, LoaderCircle, Minus, Plus, RotateCcw } from 'lucide-react'
import Phaser from 'phaser'

import type { JsonRecord } from './api'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import {
  renderVillageSnapshotPreview,
  type VillageSnapshotPreview,
} from '../game/renderers/VillageSnapshotPreviewRenderer'

interface PreviewController {
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  pan: (deltaX: number, deltaY: number) => void
}

interface VillagePreviewSceneOptions {
  world: VillageSnapshotPreview
  expanded: boolean
  hostElement: HTMLDivElement
  controllerRef: { current: PreviewController | null }
  onReady: () => void
  onError: () => void
}

class VillagePreviewScene extends Phaser.Scene {
  private readonly options: VillagePreviewSceneOptions

  constructor(options: VillagePreviewSceneOptions) {
    super({ key: `admin-village-preview-${options.expanded ? 'expanded' : 'card'}` })
    this.options = options
  }

  async create() {
    const {
      world,
      hostElement,
      controllerRef,
      onReady,
      onError,
    } = this.options

    try {
      const { bounds, ready } = renderVillageSnapshotPreview(this, world)
      const camera = this.cameras.main
      camera.setBackgroundColor('#dfe9d7')
      const fitVillage = () => {
        const zoom = Math.min(
          this.scale.width / (bounds.width + 96),
          this.scale.height / (bounds.height + 96),
        )
        camera.setZoom(Phaser.Math.Clamp(zoom, 0.2, 2.4))
        camera.centerOn(bounds.centerX, bounds.centerY)
      }
      fitVillage()
      this.scale.on(Phaser.Scale.Events.RESIZE, fitVillage)

      let dragging = false
      let priorX = 0
      let priorY = 0
      this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
        dragging = true
        priorX = pointer.x
        priorY = pointer.y
        hostElement.dataset.dragging = 'true'
      })
      this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
        if (!dragging) return
        camera.scrollX -= (pointer.x - priorX) / camera.zoom
        camera.scrollY -= (pointer.y - priorY) / camera.zoom
        priorX = pointer.x
        priorY = pointer.y
      })
      const release = () => {
        dragging = false
        delete hostElement.dataset.dragging
      }
      this.input.on('pointerup', release)
      this.input.on('pointerupoutside', release)
      this.input.on(
        'wheel',
        (_pointer: Phaser.Input.Pointer, _objects: Phaser.GameObjects.GameObject[], _dx: number, dy: number) => {
          camera.setZoom(Phaser.Math.Clamp(camera.zoom * (dy > 0 ? 0.9 : 1.1), 0.2, 3.5))
        },
      )

      controllerRef.current = {
        zoomIn: () => camera.setZoom(Phaser.Math.Clamp(camera.zoom * 1.2, 0.2, 3.5)),
        zoomOut: () => camera.setZoom(Phaser.Math.Clamp(camera.zoom / 1.2, 0.2, 3.5)),
        reset: fitVillage,
        pan: (deltaX, deltaY) => {
          camera.scrollX += deltaX / camera.zoom
          camera.scrollY += deltaY / camera.zoom
        },
      }
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        this.scale.off(Phaser.Scale.Events.RESIZE, fitVillage)
        controllerRef.current = null
        delete hostElement.dataset.dragging
      })
      await ready
      onReady()
    } catch (error) {
      console.error('Admin village preview failed to render', error)
      onError()
    }
  }
}

function snapshotFrom(raw: JsonRecord): VillageSnapshotPreview | null {
  if (!Array.isArray(raw.buildings)) return null
  const ownerId = typeof raw.ownerId === 'string' ? raw.ownerId : ''
  const id = typeof raw.id === 'string' ? raw.id : ownerId ? `world_${ownerId}` : ''
  if (!id || !ownerId) return null
  return {
    ...raw,
    id,
    ownerId,
    buildings: raw.buildings as VillageSnapshotPreview['buildings'],
    obstacles: Array.isArray(raw.obstacles)
      ? raw.obstacles as VillageSnapshotPreview['obstacles']
      : [],
    lastSaveTime: Number(raw.lastSaveTime ?? 0),
    stoneMaturity: Number(raw.stoneMaturity ?? 1),
  } as VillageSnapshotPreview
}

function VillageCanvas({ world, expanded = false }: {
  world: VillageSnapshotPreview
  expanded?: boolean
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<PreviewController | null>(null)
  const helpId = useId()
  const renderKey = `${world.id}:${String(world.revision ?? world.lastSaveTime)}:${expanded}`
  const [renderState, setRenderState] = useState<{
    key: string
    state: 'ready' | 'error'
  } | null>(null)
  const state = renderState?.key === renderKey ? renderState.state : 'loading'

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const hostElement = host
    let disposed = false
    let game: Phaser.Game | null = null
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: hostElement,
      width: 960,
      height: expanded ? 640 : 480,
      backgroundColor: '#dfe9d7',
      antialias: true,
      pixelArt: false,
      roundPixels: false,
      render: {
        antialias: true,
        antialiasGL: true,
        pixelArt: false,
        roundPixels: false,
      },
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: new VillagePreviewScene({
        world,
        expanded,
        hostElement,
        controllerRef,
        onReady: () => {
          if (!disposed) setRenderState({ key: renderKey, state: 'ready' })
        },
        onError: () => {
          if (!disposed) setRenderState({ key: renderKey, state: 'error' })
        },
      }),
      audio: { noAudio: true },
      banner: false,
    })

    return () => {
      disposed = true
      controllerRef.current = null
      game?.destroy(true)
    }
  }, [expanded, renderKey, world])

  return (
    <div className="relative overflow-hidden rounded-md border bg-muted/30">
      <div
        ref={hostRef}
        className={`${expanded ? 'h-[min(68vh,46rem)]' : 'aspect-[16/9] min-h-64'} w-full cursor-grab touch-none select-none [&[data-dragging=true]]:cursor-grabbing [&>canvas]:!h-full [&>canvas]:!w-full`}
        aria-label={`Read-only isometric preview of ${world.username ?? 'player village'}`}
        aria-describedby={helpId}
        role="img"
        tabIndex={0}
        onKeyDown={event => {
          const distance = event.shiftKey ? 96 : 48
          const delta = event.key === 'ArrowLeft'
            ? [-distance, 0]
            : event.key === 'ArrowRight'
              ? [distance, 0]
              : event.key === 'ArrowUp'
                ? [0, -distance]
                : event.key === 'ArrowDown'
                  ? [0, distance]
                  : null
          if (!delta) return
          event.preventDefault()
          controllerRef.current?.pan(delta[0], delta[1])
        }}
      />
      {state === 'loading' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background text-sm text-muted-foreground">
          <LoaderCircle className="mr-2 size-4 animate-spin" /> Rendering authoritative village…
        </div>
      ) : null}
      {state === 'error' ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <Alert variant="destructive" className="max-w-md">
            <AlertTitle>Preview unavailable</AlertTitle>
            <AlertDescription>The saved village could not be rendered on this device.</AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div className="absolute right-2 top-2 flex items-center gap-1 rounded-md border bg-background/90 p-1 shadow-sm backdrop-blur">
        <Button size="icon-sm" variant="ghost" type="button" aria-label="Zoom village out" onClick={() => controllerRef.current?.zoomOut()}><Minus /></Button>
        <Button size="icon-sm" variant="ghost" type="button" aria-label="Reset village view" onClick={() => controllerRef.current?.reset()}><RotateCcw /></Button>
        <Button size="icon-sm" variant="ghost" type="button" aria-label="Zoom village in" onClick={() => controllerRef.current?.zoomIn()}><Plus /></Button>
      </div>
      <div id={helpId} className="pointer-events-none absolute bottom-2 left-2 rounded-md border bg-background/85 px-2 py-1 text-[0.625rem] text-muted-foreground shadow-sm backdrop-blur">
        Drag or arrow keys to pan · Scroll to zoom
      </div>
    </div>
  )
}

export default function PlayerVillagePreview({ village, playerName }: {
  village: JsonRecord
  playerName: string
}) {
  const [expanded, setExpanded] = useState(false)
  const snapshot = useMemo(() => snapshotFrom(village), [village])

  if (!snapshot) {
    return (
      <Alert>
        <AlertTitle>No village snapshot</AlertTitle>
        <AlertDescription>This account does not currently own a complete persisted village.</AlertDescription>
      </Alert>
    )
  }

  const savedAt = snapshot.lastSaveTime > 0
    ? new Date(snapshot.lastSaveTime).toLocaleString()
    : 'Unknown save time'

  return (
    <>
      <Card size="sm" className="overflow-hidden">
        <CardHeader className="border-b">
          <div>
            <CardTitle>Village preview</CardTitle>
            <CardDescription>The authoritative saved layout, rendered with the game’s isometric visual pipeline.</CardDescription>
          </div>
          <Button variant="outline" size="sm" type="button" onClick={() => setExpanded(true)}>
            <Expand /> Expand
          </Button>
        </CardHeader>
        <CardContent className="p-3">
          <VillageCanvas world={snapshot} />
        </CardContent>
        <CardFooter className="justify-between border-t text-xs text-muted-foreground">
          <span>{snapshot.buildings.length} buildings · {snapshot.obstacles?.length ?? 0} obstacles</span>
          <Badge variant="outline">Saved {savedAt}</Badge>
        </CardFooter>
      </Card>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="w-[min(96vw,80rem)] max-w-none sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>{playerName}’s village</DialogTitle>
            <DialogDescription>Read-only authoritative layout preview. Drag to pan and use the controls or wheel to zoom.</DialogDescription>
          </DialogHeader>
          <VillageCanvas world={snapshot} expanded />
        </DialogContent>
      </Dialog>
    </>
  )
}
