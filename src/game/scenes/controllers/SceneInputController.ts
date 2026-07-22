import Phaser from 'phaser';
import { Backend } from '../../backend/GameBackend';
import { BUILDING_DEFINITIONS, type BuildingType, type TroopType } from '../../config/GameDefinitions';
import { gameManager } from '../../GameManager';
import { soundSystem } from '../../systems/SoundSystem';
import { depthForBuilding, depthForGroundPlane } from '../../systems/DepthSystem';
import { cssPixelsToBacking, toBackingZoom, toLogicalZoom } from '../../utils/DisplayResolution';
import { pixelLine } from '../../render/PixelDraw';
import { IsoUtils } from '../../utils/IsoUtils';
import { MobileUtils } from '../../utils/MobileUtils';
import type { MainScene } from '../MainScene';

const BUILDINGS = BUILDING_DEFINITIONS as any;

export class SceneInputController {
    private scene: MainScene;
    private lastWallDragTile: { x: number; y: number } | null = null;
    /** Spawn counter for the current hold-to-deploy stream (reset per hold). */
    private deployStreamIndex = 0;
    /** Local gate for the forbidden-deploy dud (see playForbiddenDenied). */
    private lastForbiddenDeniedMs = 0;
    /** Tiles painted by the CURRENT wall drag — thins the per-tile thud. */
    private wallPaintCount = 0;

    // Touch/pinch state
    private isPinching: boolean = false;
    private pinchStartDistance: number = 0;
    private pinchStartZoom: number = 1;
    private lastPinchCenter: { x: number; y: number } | null = null;
    private lastTouchCount: number = 0;
    private touchStartTime: number = 0;
    private lastTapTime: number = 0;
    private isTouchDragging: boolean = false;
    /** From the moment a gesture goes multi-touch until EVERY finger lifts,
     *  gameplay pointer handling stays dead — the finger surviving a pinch
     *  must never turn into a deploy stream or a wall-paint drag. */
    private suppressPointerUntilAllUp: boolean = false;
    /** Tap recognition stays disarmed for a short window after a pinch ends
     *  so a quick pinch is never half of a double-tap. */
    private lastPinchEndTime: number = 0;
    /** Live invalid-drop shake (proxy-driven) + the transform it restores. */
    private ghostNudgeTween: Phaser.Tweens.Tween | null = null;
    private ghostNudgeBaseX = 0;

    constructor(scene: MainScene) {
        this.scene = scene;
        this.setupTouchHandlers();
    }

    /**
     * Setup native touch handlers for pinch-to-zoom
     */
    private setupTouchHandlers(): void {
        if (!MobileUtils.isTouchDevice()) return;

        const canvas = this.scene.game.canvas;

        canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
        canvas.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });
    }

    /** (Re-)anchor the pinch on the CURRENT finger set. Called when the pinch
     *  starts and again whenever the set changes (third finger joins, or a
     *  three-finger gesture drops back to two) — continuing against the old
     *  anchors lurches zoom/pan. */
    private anchorPinch(touches: TouchList): void {
        this.isPinching = true;
        this.isTouchDragging = false;
        this.pinchStartDistance = MobileUtils.getTouchDistance(touches[0], touches[1]);
        this.pinchStartZoom = toLogicalZoom(this.scene.cameras.main.zoom);
        this.lastPinchCenter = MobileUtils.getTouchCenter(touches[0], touches[1], this.scene.game.canvas);
    }

    /** A gesture just went multi-touch: whatever the first finger was doing
     *  (deploy stream, wall paint, camera drag, pending tap) is over. */
    private resetPointerGameplayState(): void {
        const scene = this.scene;
        scene.isDragging = false;
        scene.isLockingDragForTroops = false;
        this.lastWallDragTile = null;
        this.isTouchDragging = false;
        this.lastTapTime = 0;
    }

    private onTouchStart(e: TouchEvent): void {
        this.touchStartTime = Date.now();
        this.lastTouchCount = e.touches.length;

        if (e.touches.length >= 2) {
            // Any multi-touch is a camera gesture: kill live gameplay state
            // and keep pointer handling suppressed until every finger lifts.
            e.preventDefault();
            if (!this.suppressPointerUntilAllUp) this.resetPointerGameplayState();
            this.suppressPointerUntilAllUp = true;
            this.lastTapTime = 0; // a pinch is never half of a double-tap
            this.anchorPinch(e.touches);
        } else if (e.touches.length === 1) {
            this.isTouchDragging = false;
            this.lastPinchCenter = null;
        }
    }

    private onTouchMove(e: TouchEvent): void {
        if (e.touches.length >= 2 && this.isPinching) {
            e.preventDefault();

            const camera = this.scene.cameras.main;
            const canvas = this.scene.game.canvas;

            // Get current pinch center
            const pinchCenter = MobileUtils.getTouchCenter(e.touches[0], e.touches[1], canvas);

            // Handle panning (movement of pinch center)
            if (this.lastPinchCenter) {
                const panDeltaX = this.lastPinchCenter.x - pinchCenter.x;
                const panDeltaY = this.lastPinchCenter.y - pinchCenter.y;

                // Convert screen delta to world delta using current zoom
                camera.scrollX += panDeltaX / camera.zoom;
                camera.scrollY += panDeltaY / camera.zoom;
                this.scene.hasUserMovedCamera = true;
            }

            // Handle zooming
            const currentDistance = MobileUtils.getTouchDistance(e.touches[0], e.touches[1]);
            const scale = currentDistance / this.pinchStartDistance;
            let newZoom = this.pinchStartZoom * scale;

            // Clamp zoom. The floor is the village-and-clouds fit; a pinch that
            // began below it (world view) may zoom in but never further out.
            const minZoom = Math.min(this.scene.minGestureZoom(), this.pinchStartZoom);
            const maxZoom = MobileUtils.getMaxZoom();
            newZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));

            const oldBackingZoom = camera.zoom;
            const newBackingZoom = toBackingZoom(newZoom);

            if (newBackingZoom !== oldBackingZoom) {
                this.scene.hasUserMovedCamera = true;
                // In Phaser, camera.scrollX/Y is where the CENTER of the camera view is in world space
                const viewportCenterX = camera.width / 2;
                const viewportCenterY = camera.height / 2;

                // Calculate the world point under the pinch center with current zoom
                const worldX = camera.scrollX + (pinchCenter.x - viewportCenterX) / oldBackingZoom;
                const worldY = camera.scrollY + (pinchCenter.y - viewportCenterY) / oldBackingZoom;

                // Apply new zoom
                camera.setZoom(newBackingZoom);

                // Calculate new scroll so the same world point stays under the pinch center
                camera.scrollX = worldX - (pinchCenter.x - viewportCenterX) / newBackingZoom;
                camera.scrollY = worldY - (pinchCenter.y - viewportCenterY) / newBackingZoom;
            }

            // Store current center for next frame
            this.lastPinchCenter = pinchCenter;
        } else if (e.touches.length === 1 && !this.isPinching) {
            this.isTouchDragging = true;
        }
    }

    private onTouchEnd(e: TouchEvent): void {
        const touchDuration = Date.now() - this.touchStartTime;

        if (this.isPinching) {
            if (e.touches.length >= 2) {
                // 3 fingers dropped back to 2: still pinching — re-anchor on
                // the survivors so the next move doesn't lurch against the
                // lifted finger's stale anchors.
                this.anchorPinch(e.touches);
            } else {
                this.isPinching = false;
                this.lastPinchEndTime = Date.now();
                // Once per pinch, when the second touch lifts (no-op outside 'snap' mode)
                this.scene.settleZoomAfterGesture();
            }
        }
        if (e.touches.length < 2) {
            this.lastPinchCenter = null;
        }
        if (e.touches.length === 0) {
            // Every finger is up: the next touch is a fresh gesture.
            this.suppressPointerUntilAllUp = false;
        }

        // Detect double-tap for quick zoom. A qualifying tap is: single-finger,
        // short, not dragged, outside the post-pinch window, and landing on
        // non-interactive HOME ground — battle deploy taps and building taps
        // must never toggle the camera.
        if (e.touches.length === 0 && this.lastTouchCount === 1 && touchDuration < 200 && !this.isTouchDragging
            && Date.now() - this.lastPinchEndTime > 400
            && this.isNonInteractiveGroundTap(e.changedTouches[0])) {
            const now = Date.now();
            if (now - this.lastTapTime < 300) {
                // Double tap - toggle zoom
                const camera = this.scene.cameras.main;
                const defaultZoom = MobileUtils.getDefaultZoom();
                if (toLogicalZoom(camera.zoom) > defaultZoom + 0.3) {
                    camera.setZoom(toBackingZoom(defaultZoom));
                } else {
                    camera.setZoom(toBackingZoom(Math.min(MobileUtils.getMaxZoom(), defaultZoom + 0.6)));
                }
                // Deliberate camera intent — the next resize must not snap
                // the camera back to the fit view.
                this.scene.hasUserMovedCamera = true;
                this.scene.settleZoomAfterGesture();
                this.lastTapTime = 0; // Reset to prevent triple tap
            } else {
                this.lastTapTime = now;
            }
        } else if (e.touches.length === 0) {
            // A release that cannot be a tap breaks the double-tap chain: a
            // building tap followed by a quick ground tap is not a double-tap.
            this.lastTapTime = 0;
        }

        this.lastTouchCount = e.touches.length;
        this.isTouchDragging = false;
    }

    /** Double-tap zoom only fires from taps that could not have meant
     *  anything else: HOME mode, nothing in hand, open ground. */
    private isNonInteractiveGroundTap(touch: Touch | undefined): boolean {
        const scene = this.scene;
        if (!touch) return false;
        if (scene.mode !== 'HOME') return false;
        if (scene.selectedBuildingType || scene.isMoving) return false;
        // Native TouchEvent coords are CSS pixels; Phaser cameras live in
        // drawing-buffer pixels — cross the boundary exactly once, the same
        // way MobileUtils.getTouchCenter does.
        const canvas = scene.game.canvas;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / Math.max(1, rect.width);
        const scaleY = canvas.height / Math.max(1, rect.height);
        const worldPoint = scene.cameras.main.getWorldPoint(
            (touch.clientX - rect.left) * scaleX,
            (touch.clientY - rect.top) * scaleY
        );
        const cart = IsoUtils.isoToCart(worldPoint.x, worldPoint.y);
        const gx = Math.floor(cart.x);
        const gy = Math.floor(cart.y);
        return !scene.buildings.some(b => {
            const info = BUILDINGS[b.type];
            return info && gx >= b.gridX && gx < b.gridX + info.width &&
                gy >= b.gridY && gy < b.gridY + info.height;
        });
    }

    /**
     * Check if currently in a pinch gesture (used to prevent other interactions)
     */
    isPinchGesture(): boolean {
        return this.isPinching;
    }

    /** Gameplay listens to the mouse and the FIRST touch pointer only.
     *  With multi-touch enabled (activePointers), extra fingers get their own
     *  Phaser pointers whose down/move/up would otherwise deploy troops or
     *  paint walls — they exist purely for the pinch gesture. */
    private isGameplayPointer(pointer: Phaser.Input.Pointer): boolean {
        const input = this.scene.input;
        return pointer === input.mousePointer || pointer === input.pointer1;
    }

    /** Phaser deliberately mirrors pointer downs from the whole browser
     *  window into the scene so an off-canvas release cannot leave a held
     *  pointer stuck. The native down target is therefore the authoritative
     *  boundary between a world gesture and React/DOM UI. */
    private startedOnGameCanvas(pointer: Phaser.Input.Pointer): boolean {
        return pointer.downElement === this.scene.game.canvas;
    }

    /** A canvas gesture released over DOM UI is finished, but it is not a
     *  world click/drop. Clear every hold/drag latch before returning. */
    private endedOnGameCanvas(pointer: Phaser.Input.Pointer): boolean {
        return pointer.upElement === this.scene.game.canvas;
    }

    /** True while gameplay pointer events must be ignored: mid-pinch, extra
     *  fingers, and the tail of a multi-touch gesture (until all fingers up). */
    private isPointerSuppressed(pointer: Phaser.Input.Pointer): boolean {
        return this.isPinching || this.suppressPointerUntilAllUp || !this.isGameplayPointer(pointer);
    }

    /** THE tracked gameplay pointer: the mouse or the FIRST touch, whichever
     *  acted most recently. Never `input.activePointer` — that can be a
     *  pinch's second finger parked over the map. */
    public getGameplayPointer(): Phaser.Input.Pointer {
        const input = this.scene.input;
        const mouse = input.mousePointer;
        const touch = input.pointer1;
        if (!touch) return mouse;
        const touchT = Math.max(touch.moveTime, touch.downTime, touch.upTime);
        const mouseT = Math.max(mouse.moveTime, mouse.downTime, mouse.upTime);
        return touchT > mouseT ? touch : mouse;
    }

    private getWallPlacementTile(pointer: Phaser.Input.Pointer): { x: number; y: number } {
        const worldPoint = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const cart = IsoUtils.isoToCart(worldPoint.x, worldPoint.y);
        return {
            x: Math.round(cart.x - 0.5),
            y: Math.round(cart.y - 0.5)
        };
    }

    private getWallOccupantAt(scene: MainScene, x: number, y: number): 'EMPTY' | 'WALL' | 'BLOCKED' {
        for (const building of scene.buildings) {
            const info = BUILDINGS[building.type];
            if (!info) continue;
            const inside = x >= building.gridX && x < building.gridX + info.width &&
                y >= building.gridY && y < building.gridY + info.height;
            if (!inside) continue;
            if (building.type === 'wall') return 'WALL';
            return 'BLOCKED';
        }
        return 'EMPTY';
    }

    private buildWallPath(from: { x: number; y: number }, to: { x: number; y: number }): Array<{ x: number; y: number }> {
        const points: Array<{ x: number; y: number }> = [];
        let x = from.x;
        let y = from.y;

        while (x !== to.x || y !== to.y) {
            const dx = to.x - x;
            const dy = to.y - y;
            const stepX = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
            const stepY = dy === 0 ? 0 : (dy > 0 ? 1 : -1);

            if (stepX !== 0 && stepY !== 0) {
                if (Math.abs(dx) >= Math.abs(dy)) {
                    x += stepX;
                    points.push({ x, y });
                    y += stepY;
                    points.push({ x, y });
                } else {
                    y += stepY;
                    points.push({ x, y });
                    x += stepX;
                    points.push({ x, y });
                }
                continue;
            }

            if (stepX !== 0) x += stepX;
            if (stepY !== 0) y += stepY;
            points.push({ x, y });
        }

        return points;
    }

    private paintWallPath(scene: MainScene, from: { x: number; y: number }, to: { x: number; y: number }) {
        const path = this.buildWallPath(from, to);
        let lastReachable = from;

        for (const tile of path) {
            const status = this.getWallOccupantAt(scene, tile.x, tile.y);
            if (status === 'BLOCKED') {
                break;
            }
            if (status === 'WALL') {
                lastReachable = tile;
                continue;
            }
            if (!scene.isPositionValid(tile.x, tile.y, 'wall')) {
                break;
            }
            // Thin the drag-paint thud to every 2nd tile — even with the
            // central 60ms limiter, a fast drag at one thud per tile reads
            // as a machine gun rather than laying bricks.
            const muteSfx = (this.wallPaintCount++ % 2) !== 0;
            void scene.placeBuilding(tile.x, tile.y, 'wall', 'PLAYER', false, muteSfx);
            lastReachable = tile;
        }

        this.lastWallDragTile = lastReachable;
    }

    private handleWallDragPaint(pointer: Phaser.Input.Pointer) {
        const scene = this.scene;
        if (!pointer.isDown || scene.selectedBuildingType !== 'wall') return;
        if (scene.worldMap.inBattleFrame()) return; // retreat window: read-only
        const target = this.getWallPlacementTile(pointer);
        const start = this.lastWallDragTile ?? target;
        this.paintWallPath(scene, start, target);
    }

    onPointerDown(pointer: Phaser.Input.Pointer) {
        if (this.isPointerSuppressed(pointer)) return;
        if (!this.startedOnGameCanvas(pointer)) {
            this.resetPointerGameplayState();
            return;
        }

        const scene = this.scene;
        if (pointer.button === 0 && scene.selectedBuildingType === 'wall' && !scene.worldMap.inBattleFrame()) {
            this.wallPaintCount = 0; // fresh drag: first painted tile sounds
            this.lastWallDragTile = this.getWallPlacementTile(pointer);
            if (this.lastWallDragTile) {
                const startStatus = this.getWallOccupantAt(scene, this.lastWallDragTile.x, this.lastWallDragTile.y);
                if (startStatus === 'EMPTY' && scene.isPositionValid(this.lastWallDragTile.x, this.lastWallDragTile.y, 'wall')) {
                    void scene.placeBuilding(this.lastWallDragTile.x, this.lastWallDragTile.y, 'wall', 'PLAYER');
                }
            }
        } else if (pointer.button === 0) {
            this.lastWallDragTile = null;
        }
        if (pointer.button === 0) {
            // Just set up for potential drag
            scene.isDragging = false;
            // A new gesture never inherits the previous drag's camera lock —
            // a pointerup swallowed by a pinch could otherwise leave it
            // latched and make every later pan drag inert.
            scene.isLockingDragForTroops = false;
            scene.dragOrigin.set(pointer.x, pointer.y);

            // Anchor for robust panning
            scene.dragStartCam.set(scene.cameras.main.scrollX, scene.cameras.main.scrollY);
            scene.dragStartScreen.set(pointer.position.x, pointer.position.y);

            // Start deployment timer and spawn first troop immediately for responsiveness
            if (scene.mode === 'ATTACK' && !scene.isScouting) {
                scene.deployStartTime = scene.time.now;
                this.deployStreamIndex = 0;
                const worldPoint = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
                const gridPosFloat = IsoUtils.isoToCart(worldPoint.x, worldPoint.y);
                const margin = 2;
                const isInsideMap = gridPosFloat.x >= -margin && gridPosFloat.x < scene.mapSize + margin &&
                    gridPosFloat.y >= -margin && gridPosFloat.y < scene.mapSize + margin;
                const isForbidden = scene.isDeployForbidden(gridPosFloat.x, gridPosFloat.y);

                // A tap on forbidden ground must never be silent: light the
                // red zone so the player sees WHY nothing spawned. (The
                // hold-stream path below refreshes it for held gestures.)
                if (isInsideMap && isForbidden) {
                    scene.lastForbiddenInteractionTime = scene.time.now;
                    this.playForbiddenDenied();
                }

                if (isInsideMap && !isForbidden) {
                    const army = gameManager.getArmy();
                    const selectedType = gameManager.getSelectedTroopType();
                    // Lock camera panning ONLY when this drag can actually
                    // deploy — with no troop selected/remaining the lock made
                    // open-ground drags neither pan nor deploy.
                    const canDeploy = !!selectedType && (army[selectedType] ?? 0) > 0;
                    scene.isLockingDragForTroops = canDeploy;
                    if (canDeploy && selectedType) {
                        scene.spawnTroop(gridPosFloat.x, gridPosFloat.y, selectedType as TroopType, 'PLAYER');
                        gameManager.deployTroop(selectedType);
                        scene.lastDeployTime = scene.time.now;
                        this.deployStreamIndex = 1;
                    }
                }
            }
        }
    }

    async onPointerUp(pointer: Phaser.Input.Pointer) {
        if (this.isPointerSuppressed(pointer)) return;
        if (!this.startedOnGameCanvas(pointer) || !this.endedOnGameCanvas(pointer)) {
            this.resetPointerGameplayState();
            return;
        }

        this.lastWallDragTile = null;

        const scene = this.scene;
        // Calculate drag distance
        const dist = Phaser.Math.Distance.Between(pointer.downX, pointer.downY, pointer.upX, pointer.upY);

        // If this gesture ever crossed the drag threshold it stays a drag —
        // a camera pan that wanders and ends near its origin must not be
        // misread as a tap (deselecting/poking whatever sat under it).
        if (scene.isDragging || dist > cssPixelsToBacking(10)) {
            scene.isDragging = false;
            scene.isLockingDragForTroops = false;
            if (scene.selectedInWorld && (scene.selectedInWorld as any).type === 'prism') {
                scene.cleanupPrismLaser(scene.selectedInWorld);
            }
            return;
        }

        // --- CLICK HANDLING (Previously in onPointerDown) ---
        if (pointer.button === 0) {
            const worldPoint = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
            const gridPosFloat = IsoUtils.isoToCart(worldPoint.x, worldPoint.y);
            const gridPosSnap = new Phaser.Math.Vector2(Math.floor(gridPosFloat.x), Math.floor(gridPosFloat.y));

            // Purely additive: a tap near a villager/dog/chicken delights it,
            // and a tapped rock gets hauled off to the storehouse for ore.
            scene.pokeVillageLife(gridPosFloat.x, gridPosFloat.y);
            if (scene.tryOpenMerchant(gridPosSnap.x, gridPosSnap.y)) return;
            scene.tryStartRockHaul(gridPosSnap.x, gridPosSnap.y);
            scene.tryPickMushrooms(gridPosSnap.x, gridPosSnap.y);

            if (scene.mode === 'ATTACK') {
                // Check if clicking on an enemy building to show its range
                const clickedBuilding = scene.buildings.find(b => {
                    if (b.owner !== 'ENEMY' || b.health <= 0) return false;
                    const info = BUILDINGS[b.type];
                    return gridPosSnap.x >= b.gridX && gridPosSnap.x < b.gridX + info.width &&
                        gridPosSnap.y >= b.gridY && gridPosSnap.y < b.gridY + info.height;
                });

                if (clickedBuilding) {
                    // Toggle range indicator: If already active, clear it. Else show it.
                    if (clickedBuilding.rangeIndicator) {
                        scene.clearBuildingRangeIndicator();
                    } else {
                        scene.showBuildingRangeIndicator(clickedBuilding);
                    }
                    scene.lastForbiddenInteractionTime = scene.time.now;
                    return;
                }

                // Clear any existing range indicator when clicking elsewhere
                scene.clearBuildingRangeIndicator();
                return;
            }

            // The retreat window: mode is already HOME but the local grid
            // still shows the battlefield until the caravan swap lands.
            // Look, don't touch — no selecting or building on their village.
            if (scene.worldMap.inBattleFrame()) return;

            if (scene.isMoving && scene.selectedInWorld) {
                // Calculate centered position for the building being moved
                const info = BUILDINGS[scene.selectedInWorld.type];
                const targetX = Math.round(gridPosFloat.x - info.width / 2);
                const targetY = Math.round(gridPosFloat.y - info.height / 2);

                if (scene.isPositionValid(targetX, targetY, scene.selectedInWorld.type, scene.selectedInWorld.id)) {
                    // Move drop lands: the rounder cousin of the new-build thud.
                    soundSystem.play('place');
                    // Clear any obstacles at the new position
                    scene.removeOverlappingObstacles(targetX, targetY, info.width, info.height);

                    // Store old position before updating (needed for wall neighbor refresh)
                    const oldGridX = scene.selectedInWorld.gridX;
                    const oldGridY = scene.selectedInWorld.gridY;
                    const isWall = scene.selectedInWorld.type === 'wall';

                    scene.selectedInWorld.gridX = targetX;
                    scene.selectedInWorld.gridY = targetY;
                    scene.selectedInWorld.graphics.clear();
                    // The carry hid the carrier (baked shadow sprites follow
                    // carrier visibility) — restore it before the redraw.
                    scene.selectedInWorld.graphics.setVisible(true);
                    if (scene.selectedInWorld.baseGraphics) {
                        scene.selectedInWorld.baseGraphics.clear();
                        scene.selectedInWorld.baseGraphics.setVisible(true);
                    }
                    scene.drawBuildingVisuals(
                        scene.selectedInWorld.graphics,
                        targetX,
                        targetY,
                        scene.selectedInWorld.type,
                        1,
                        null,
                        scene.selectedInWorld,
                        scene.selectedInWorld.baseGraphics,
                        true  // skipBase=true since base is baked to ground texture
                    );
                    const depth = depthForBuilding(targetX, targetY, scene.selectedInWorld.type as BuildingType);
                    scene.selectedInWorld.graphics.setDepth(depth);
                    if (scene.selectedInWorld.baseGraphics) {
                        scene.selectedInWorld.baseGraphics.setDepth(depthForGroundPlane());
                    }
                    if (scene.selectedInWorld.barrelGraphics) {
                        scene.selectedInWorld.barrelGraphics.setDepth(scene.selectedInWorld.graphics.depth + 1);
                    }
                    scene.updateHealthBar(scene.selectedInWorld);
                    if (scene.selectedInWorld.rangeIndicator) {
                        scene.showBuildingRangeIndicator(scene.selectedInWorld);
                    }
                    // Bake the building's base to the ground texture at new position
                    (scene as any).bakeBuildingToGround(scene.selectedInWorld);

                    // Update wall neighbor connections at both old and new positions
                    if (isWall) {
                        scene.refreshWallNeighbors(oldGridX, oldGridY, scene.selectedInWorld.owner);
                        scene.refreshWallNeighbors(targetX, targetY, scene.selectedInWorld.owner);
                    }

                    scene.isMoving = false;
                    scene.ghostBuilding.setVisible(false);
                    scene.villageLife.onBuildingPlaced(scene.selectedInWorld);
                    // The popup was hidden for the carry — bring it back at
                    // the building's new spot.
                    gameManager.onBuildingSelected({
                        id: scene.selectedInWorld.id,
                        type: scene.selectedInWorld.type as BuildingType,
                        level: scene.selectedInWorld.level || 1,
                        gridX: targetX,
                        gridY: targetY,
                        upgradeEndsAt: scene.selectedInWorld.upgradeEndsAt
                    });
                    if (scene.selectedInWorld.owner === 'PLAYER') {
                        await Backend.moveBuilding(scene.userId, scene.selectedInWorld.id, targetX, targetY);
                    }
                } else {
                    // Refused drop: the tap must never be silent.
                    this.nudgeInvalidDrop();
                }
                return;
            }

            // (No right-button handling here: this branch only runs for
            // button===0 pointerups, so rightButtonDown() was always false.
            // Right-click cancel lives in MainScene's pointerdown handler.)

            if (scene.selectedBuildingType) {
                // Calculate centered position for new placement
                const info = BUILDINGS[scene.selectedBuildingType];
                const targetX = Math.round(gridPosFloat.x - info.width / 2);
                const targetY = Math.round(gridPosFloat.y - info.height / 2);

                if (scene.isPositionValid(targetX, targetY, scene.selectedBuildingType)) {
                    const type = scene.selectedBuildingType;
                    const success = await scene.placeBuilding(targetX, targetY, type, 'PLAYER');

                    if (success) {
                        const pos = IsoUtils.cartToIso(targetX + info.width / 2, targetY + info.height / 2);
                        scene.createSmokeEffect(pos.x, pos.y);

                        if (type !== 'wall') {
                            scene.selectedBuildingType = null;
                            scene.ghostBuilding.setVisible(false);
                            gameManager.onPlacementCancelled();
                        }
                    } else {
                        this.nudgeInvalidDrop();
                    }
                } else if (scene.selectedBuildingType !== 'wall') {
                    // Invalid tile tapped with a ghost in hand — flash the
                    // refusal instead of doing nothing (the red ghost tint
                    // explains why). Walls are exempt: they paint on pointer-
                    // DOWN, so by the time this up-handler runs the tile is
                    // legitimately occupied by the wall just placed.
                    this.nudgeInvalidDrop();
                }
                return;
            }

            const clicked = scene.buildings.find(b => {
                const info = BUILDINGS[b.type];
                return gridPosSnap.x >= b.gridX && gridPosSnap.x < b.gridX + info.width &&
                    gridPosSnap.y >= b.gridY && gridPosSnap.y < b.gridY + info.height && b.owner === 'PLAYER';
            });
            if (clicked) {
                if (scene.selectedInWorld === clicked) {
                    if (clicked.type === 'jukebox') {
                        // Second tap on the selected jukebox: SWAP the
                        // building panel for the track list — one surface
                        // at a time, never both stacked.
                        scene.selectedInWorld = null;
                        gameManager.onBuildingSelected(null);
                        scene.clearBuildingRangeIndicator();
                        // openJukebox's App handler voices uiOpen — one sound
                        // on every open path, no stacked click.
                        gameManager.openJukebox();
                        return;
                    }
                    scene.selectedInWorld = null;
                    gameManager.onBuildingSelected(null);
                    scene.clearBuildingRangeIndicator();
                    soundSystem.play('uiTap'); // soft deselect on the 2nd tap
                    if (clicked.type === 'prism') {
                        scene.cleanupPrismLaser(clicked);
                    }
                } else {
                    if (scene.selectedInWorld !== clicked) {
                        scene.clearBuildingRangeIndicator();
                    }
                    scene.selectedInWorld = clicked;
                    soundSystem.play('click');
                    // The jukebox opens its track list on a SECOND tap; the
                    // first tap shows the normal building panel like any
                    // other building (upgrades stay reachable).
                    gameManager.onBuildingSelected({ id: clicked.id, type: clicked.type as BuildingType, level: clicked.level || 1, gridX: clicked.gridX, gridY: clicked.gridY, upgradeEndsAt: clicked.upgradeEndsAt });
                    scene.showBuildingRangeIndicator(clicked);
                }
                return;
            } else {
                if (scene.selectedInWorld && scene.selectedInWorld.type === 'prism') {
                    scene.cleanupPrismLaser(scene.selectedInWorld);
                }
                scene.selectedInWorld = null;
                gameManager.onBuildingSelected(null);
                scene.clearBuildingRangeIndicator();
            }
        }

        // Final cleanup for interactions that rely on holding mouse down (like prism)
        scene.isDragging = false;
        scene.isLockingDragForTroops = false;
        if (scene.selectedInWorld && (scene.selectedInWorld as any).type === 'prism') {
            scene.cleanupPrismLaser(scene.selectedInWorld);
        }
    }

    /** Dud thunk for a deploy attempt on forbidden ground. Locally gated to
     *  once per ~400ms — the central limiter (80ms) alone would still let a
     *  held press machine-gun duds. Voices only when a deploy was actually
     *  possible: with no troop selected or the army spent, the press is not
     *  a thwarted deploy and only the red-zone visual responds. */
    private playForbiddenDenied(): void {
        const army = gameManager.getArmy();
        const selectedType = gameManager.getSelectedTroopType();
        if (!selectedType || !((army[selectedType] ?? 0) > 0)) return;
        const now = Date.now();
        if (now - this.lastForbiddenDeniedMs < 400) return;
        this.lastForbiddenDeniedMs = now;
        soundSystem.play('denied');
    }

    /** Refused placement/move: a quick side-to-side shake of the ghost so an
     *  invalid tap is never silent. The baked-sprite body follows the carrier
     *  through its shadow binding, so the nudge reads on both render paths.
     *
     *  The shake drives a PROXY value, never the live transform, and any
     *  previous shake is stopped and its base restored before re-arming — so
     *  no interrupt (second nudge, external tween kill) can capture a
     *  mid-shake offset as the new base and latch it onto the shared ghost. */
    private nudgeInvalidDrop() {
        const scene = this.scene;
        // Every refused drop/placement voices the refusal alongside the shake.
        soundSystem.play('denied');
        const ghost = scene.ghostBuilding;
        if (this.ghostNudgeTween) {
            const previous = this.ghostNudgeTween;
            this.ghostNudgeTween = null;
            previous.stop();
            ghost.x = this.ghostNudgeBaseX; // deterministic reset before re-arm
        }
        this.ghostNudgeBaseX = ghost.x;
        const shake = { offset: 0 };
        const tween = scene.tweens.add({
            targets: shake,
            offset: 5,
            duration: 50,
            yoyo: true,
            repeat: 3,
            onUpdate: () => {
                if (ghost.active) ghost.x = this.ghostNudgeBaseX + shake.offset;
            },
            onComplete: () => {
                if (this.ghostNudgeTween === tween) this.ghostNudgeTween = null;
                if (ghost.active) ghost.x = this.ghostNudgeBaseX;
            },
            onStop: () => {
                // Fires on ANY external interrupt path too (tween kill) —
                // the ghost always lands back on its base transform.
                if (this.ghostNudgeTween === tween) this.ghostNudgeTween = null;
                if (ghost.active) ghost.x = this.ghostNudgeBaseX;
            }
        });
        this.ghostNudgeTween = tween;
    }

    /**
     * Per-frame tick from the scene's update loop. Drives the hold-to-deploy
     * stream on the CLOCK instead of pointermove events — a perfectly still
     * hold used to deploy exactly one troop because nothing ever moved.
     *
     * Only for a hold that STARTED as a deploy (camera lock taken at
     * pointerdown). A hold that began as a pan — forbidden zone, no troop
     * selected, or a pinch survivor — must not turn into a turbo spray, and
     * the multi-touch suppression rules apply exactly as they do to events.
     */
    update() {
        const scene = this.scene;
        if (scene.mode !== 'ATTACK' || scene.isScouting) return;
        const pointer = this.getGameplayPointer();
        if (!pointer.isDown || this.isPointerSuppressed(pointer) || !this.startedOnGameCanvas(pointer)) return;

        const now = scene.time.now;
        const worldPoint = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const gridPosFloat = IsoUtils.isoToCart(worldPoint.x, worldPoint.y);
        const isForbidden = scene.isDeployForbidden(gridPosFloat.x, gridPosFloat.y);

        // ANY held pointer over the base keeps the red zone lit — including
        // holds that STARTED on forbidden ground (no camera lock taken), which
        // previously gave zero feedback for the whole press.
        if (isForbidden) {
            scene.lastForbiddenInteractionTime = now;
            // A held press parked on forbidden ground keeps voicing the dud —
            // gated to ~2.5/s below, and never during a camera pan (a drag
            // sweeping across the base is navigation, not a deploy attempt).
            if (!scene.isDragging) this.playForbiddenDenied();
        }

        if (!scene.isLockingDragForTroops) return;

        const holdDuration = now - scene.deployStartTime;

        // Ramping fire rate: Start slow (500ms), speed up (250ms), then turbo (100ms)
        let interval = 500;
        if (holdDuration > 1000) interval = 100;
        else if (holdDuration > 500) interval = 250;

        if (now - scene.lastDeployTime <= interval) return;

        const margin = 2;
        const isInsideMap = gridPosFloat.x >= -margin && gridPosFloat.x < scene.mapSize + margin &&
            gridPosFloat.y >= -margin && gridPosFloat.y < scene.mapSize + margin;

        if (!isInsideMap || isForbidden) return;

        const army = gameManager.getArmy();
        const selectedType = gameManager.getSelectedTroopType();
        if (!selectedType || !(army[selectedType] > 0)) return;

        // Fan the stream: successive spawns land on a small
        // deterministic golden-angle spiral instead of one
        // identical point (which force-fed the rim pile-up).
        const index = this.deployStreamIndex++;
        const fanAngle = index * 2.399963229728653;
        const fanRadius = index === 0 ? 0 : 0.26 + 0.14 * Math.sqrt(index % 9);
        const fanX = gridPosFloat.x + Math.cos(fanAngle) * fanRadius;
        const fanY = gridPosFloat.y + Math.sin(fanAngle) * fanRadius;
        const fanInside = fanX >= -margin && fanX < scene.mapSize + margin &&
            fanY >= -margin && fanY < scene.mapSize + margin;
        const fanForbidden = scene.isDeployForbidden(fanX, fanY);
        const useFan = fanInside && !fanForbidden;
        scene.spawnTroop(
            useFan ? fanX : gridPosFloat.x,
            useFan ? fanY : gridPosFloat.y,
            selectedType as TroopType,
            'PLAYER'
        );
        gameManager.deployTroop(selectedType);
        scene.lastDeployTime = now;
    }

    onPointerMove(pointer: Phaser.Input.Pointer) {
        if (this.isPointerSuppressed(pointer)) return;
        // A drag that began on a DOM control stays UI-owned even if it later
        // crosses onto the canvas while still held.
        if (pointer.isDown && !this.startedOnGameCanvas(pointer)) return;

        const scene = this.scene;
        // 1. Calculate common coordinate data immediately to avoid redundancy and shadowing
        const worldPoint = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const cartFloat = IsoUtils.isoToCart(worldPoint.x, worldPoint.y);
        const gridPosSnap = new Phaser.Math.Vector2(Math.floor(cartFloat.x), Math.floor(cartFloat.y));
        const gridPosFloat = cartFloat;

        scene.hoverGrid.set(gridPosSnap.x, gridPosSnap.y);

        // Critters notice a cursor gliding past them (not while dragging the camera).
        if (!pointer.isDown) {
            scene.hoverVillageLife(cartFloat.x, cartFloat.y);
        }

        // Drag detection threshold
        if (pointer.isDown) {
            if (!scene.isDragging) {
                // Check if moved enough to start drag
                const dist = Phaser.Math.Distance.Between(pointer.downX, pointer.downY, pointer.x, pointer.y);
                if (dist > cssPixelsToBacking(10)) {
                    scene.isDragging = true;
                    // Optional: Reset anchor here to avoid 'jump', but keeping it means we SNAP to the cursor, which feels tighter.
                    // To avoid snap, we would do:
                    // scene.dragStartCam.set(scene.cameras.main.scrollX, scene.cameras.main.scrollY);
                    // scene.dragStartScreen.set(pointer.position.x, pointer.position.y);
                    // Reset the anchor to prevent the "jump" artifact when drag starts
                    scene.dragStartCam.set(scene.cameras.main.scrollX, scene.cameras.main.scrollY);
                    scene.dragStartScreen.set(pointer.position.x, pointer.position.y);
                }
            }

            if (scene.isDragging) {
                // Camera Drag Logic - Anchor Based for 1:1 movement
                // Fix: explicit exception for walls to prevent panning while painting walls
                const isWallPlacement = scene.selectedBuildingType === 'wall';

                // Fix: explicit exception for troops to prevent panning while deploying army
                // BUT: if dragging on red area (forbidden), we SHOULD pan


                // Determine if we are hovering a valid deployment zone
                // We reuse the pre-calculated coordinates
                const isForbidden = scene.isDeployForbidden(cartFloat.x, cartFloat.y);

                // Is strictly placing troops (Attack mode, troop selected, AND in valid spot OR already locked)
                const isTroopPlacement = scene.mode === 'ATTACK' && scene.isLockingDragForTroops && !isForbidden;

                if (!isWallPlacement && !isTroopPlacement && (scene.mode === 'ATTACK' || (!scene.selectedBuildingType && !scene.selectedInWorld) || (scene.selectedInWorld && !scene.isMoving))) {
                    // formula: currentScroll = startScroll + (startScreen - currentScreen) / zoom
                    const diffX = scene.dragStartScreen.x - pointer.position.x;
                    const diffY = scene.dragStartScreen.y - pointer.position.y;

                    scene.cameras.main.scrollX = scene.dragStartCam.x + diffX / scene.cameras.main.zoom;
                    scene.cameras.main.scrollY = scene.dragStartCam.y + diffY / scene.cameras.main.zoom;
                    scene.hasUserMovedCamera = true;
                }
            }

        }

        // Drag to build walls
        this.handleWallDragPaint(pointer);

        // (Hold-to-deploy no longer ticks here: the stream is CLOCK-driven
        // from update() below, so a perfectly still hold keeps deploying.)

        scene.ghostBuilding.clear();
        if (scene.selectedBuildingType || (scene.isMoving && scene.selectedInWorld)) {
            const type = scene.selectedBuildingType || scene.selectedInWorld?.type;
            if (type) {
                const info = BUILDINGS[type];
                // Calculate ghost position centered on cursor
                const ghostX = Math.round(gridPosFloat.x - info.width / 2);
                const ghostY = Math.round(gridPosFloat.y - info.height / 2);

                // Footprint-aware edge handling: keep the ghost visible while
                // ANY part of the footprint still overlaps the map. The old
                // origin-only check vanished multi-tile ghosts at the west/
                // north edges and never showed the "can't go here" state.
                if (ghostX + info.width > 0 && ghostX < scene.mapSize && ghostY + info.height > 0 && ghostY < scene.mapSize) {
                    scene.ghostBuilding.setVisible(true);

                    // Determine Ghost Level for accurate preview
                    let level = 1;
                    if (scene.selectedInWorld) {
                        level = scene.selectedInWorld.level || 1;
                    } else if (type === 'wall') {
                        level = Math.max(1, scene.preferredWallLevel || 1);
                    }

                    const ghostObj = { type: type as BuildingType, level: level, gridX: ghostX, gridY: ghostY };
                    // Live validity feedback through the existing tint path
                    // (works on both the baked-sprite and vector ghost):
                    // green = this drop will land, red = it will be refused.
                    const ignoreId = scene.isMoving && scene.selectedInWorld ? scene.selectedInWorld.id : null;
                    let ghostValid = scene.isPositionValid(ghostX, ghostY, type, ignoreId);
                    if (!ghostValid && type === 'wall' && !scene.isMoving) {
                        // Wall paint treats an existing own wall as a quiet
                        // no-op, not a refusal — don't flash red over the
                        // segment the drag just placed.
                        ghostValid = scene.buildings.some(b =>
                            b.type === 'wall' && b.owner === 'PLAYER' && b.gridX === ghostX && b.gridY === ghostY);
                    }
                    // Ghost alpha 0.85 (was 0.5) and a NEAR-WHITE cast (was a
                    // saturated multiply): the old 50%-alpha sprite under a
                    // full green/red multiply crushed the art into a camo
                    // smudge against grass. The verdict color lives on the
                    // footprint diamond below; the sprite keeps its own
                    // colors with only a light green/red cast.
                    const ghostTint = ghostValid ? 0xd8ffdc : 0xffb4ab;
                    scene.drawBuildingVisuals(scene.ghostBuilding, ghostX, ghostY, type, 0.85, ghostTint, ghostObj as any);

                    // Validity footprint under the ghost: a filled diamond +
                    // crisp edges in the drop verdict's color (green = will
                    // land, red = refused). The tinted sprite alone
                    // camouflaged against grass/occupied pads; the diamond is
                    // the unambiguous signal, mirroring the selection
                    // outline's pixel-line style.
                    const fpColor = ghostValid ? 0x37e05a : 0xff4a3a;
                    const f1 = IsoUtils.cartToIso(ghostX, ghostY);
                    const f2 = IsoUtils.cartToIso(ghostX + info.width, ghostY);
                    const f3 = IsoUtils.cartToIso(ghostX + info.width, ghostY + info.height);
                    const f4 = IsoUtils.cartToIso(ghostX, ghostY + info.height);
                    scene.ghostBuilding.fillStyle(fpColor, 0.16);
                    scene.ghostBuilding.beginPath();
                    scene.ghostBuilding.moveTo(f1.x, f1.y);
                    scene.ghostBuilding.lineTo(f2.x, f2.y);
                    scene.ghostBuilding.lineTo(f3.x, f3.y);
                    scene.ghostBuilding.lineTo(f4.x, f4.y);
                    scene.ghostBuilding.closePath();
                    scene.ghostBuilding.fillPath();
                    pixelLine(scene.ghostBuilding, f1.x, f1.y, f2.x, f2.y, 3, fpColor, 0.95);
                    pixelLine(scene.ghostBuilding, f2.x, f2.y, f3.x, f3.y, 3, fpColor, 0.95);
                    pixelLine(scene.ghostBuilding, f3.x, f3.y, f4.x, f4.y, 3, fpColor, 0.95);
                    pixelLine(scene.ghostBuilding, f4.x, f4.y, f1.x, f1.y, 3, fpColor, 0.95);

                    // Ghost depth should be on top of everything for visibility
                    scene.ghostBuilding.setDepth(200000);

                    // Track ghost position so selection outline & range indicator follow
                    const prevGhost = scene.ghostGridPos;
                    scene.ghostGridPos = { x: ghostX, y: ghostY };

                    // Update range indicator to follow ghost. Redraw on the
                    // ORIGINAL building object, never a spread copy: the
                    // clear inside showBuildingRangeIndicator nulls the
                    // previous holder's rangeIndicator handle, so a copy
                    // strands the real building without one and this follow
                    // condition never fires again (ring frozen at the lift
                    // position for the whole carry). Coordinates are swapped
                    // in just for the draw. Only redraw on a tile change —
                    // per-pointer-event redraws restart the pulse tween.
                    if (scene.isMoving && scene.selectedInWorld?.rangeIndicator
                        && (!prevGhost || prevGhost.x !== ghostX || prevGhost.y !== ghostY)) {
                        const carried = scene.selectedInWorld;
                        const homeX = carried.gridX;
                        const homeY = carried.gridY;
                        carried.gridX = ghostX;
                        carried.gridY = ghostY;
                        scene.showBuildingRangeIndicator(carried);
                        carried.gridX = homeX;
                        carried.gridY = homeY;
                    }
                } else { scene.ghostBuilding.setVisible(false); }
            }
        } else {
            scene.ghostGridPos = null;
        }
    }
}
