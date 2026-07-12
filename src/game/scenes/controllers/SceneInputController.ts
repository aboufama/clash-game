import Phaser from 'phaser';
import { Backend } from '../../backend/GameBackend';
import { BUILDING_DEFINITIONS, type BuildingType, type TroopType } from '../../config/GameDefinitions';
import { gameManager } from '../../GameManager';
import { soundSystem } from '../../systems/SoundSystem';
import { depthForBuilding, depthForGroundPlane } from '../../systems/DepthSystem';
import { cssPixelsToBacking, toBackingZoom, toLogicalZoom } from '../../utils/DisplayResolution';
import { IsoUtils } from '../../utils/IsoUtils';
import { MobileUtils } from '../../utils/MobileUtils';
import type { MainScene } from '../MainScene';

const BUILDINGS = BUILDING_DEFINITIONS as any;

export class SceneInputController {
    private scene: MainScene;
    private lastWallDragTile: { x: number; y: number } | null = null;

    // Touch/pinch state
    private isPinching: boolean = false;
    private pinchStartDistance: number = 0;
    private pinchStartZoom: number = 1;
    private lastPinchCenter: { x: number; y: number } | null = null;
    private lastTouchCount: number = 0;
    private touchStartTime: number = 0;
    private lastTapTime: number = 0;
    private isTouchDragging: boolean = false;

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

    private onTouchStart(e: TouchEvent): void {
        this.touchStartTime = Date.now();
        this.lastTouchCount = e.touches.length;

        if (e.touches.length === 2) {
            // Start pinch gesture
            e.preventDefault();
            this.isPinching = true;
            this.isTouchDragging = false;
            this.pinchStartDistance = MobileUtils.getTouchDistance(e.touches[0], e.touches[1]);
            this.pinchStartZoom = toLogicalZoom(this.scene.cameras.main.zoom);
            // Store initial pinch center for pan tracking
            const canvas = this.scene.game.canvas;
            this.lastPinchCenter = MobileUtils.getTouchCenter(e.touches[0], e.touches[1], canvas);
        } else if (e.touches.length === 1) {
            this.isTouchDragging = false;
            this.lastPinchCenter = null;
        }
    }

    private onTouchMove(e: TouchEvent): void {
        if (e.touches.length === 2 && this.isPinching) {
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

        if (e.touches.length < 2) {
            this.isPinching = false;
            this.lastPinchCenter = null;
        }

        // Detect double-tap for quick zoom (only if not pinching and short touch)
        if (e.touches.length === 0 && this.lastTouchCount === 1 && touchDuration < 200 && !this.isTouchDragging) {
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
                this.lastTapTime = 0; // Reset to prevent triple tap
            } else {
                this.lastTapTime = now;
            }
        }

        this.lastTouchCount = e.touches.length;
        this.isTouchDragging = false;
    }

    /**
     * Check if currently in a pinch gesture (used to prevent other interactions)
     */
    isPinchGesture(): boolean {
        return this.isPinching;
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
            void scene.placeBuilding(tile.x, tile.y, 'wall', 'PLAYER');
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
        // Skip if pinching
        if (this.isPinching) return;

        const scene = this.scene;
        if (pointer.button === 0 && scene.selectedBuildingType === 'wall' && !scene.worldMap.inBattleFrame()) {
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
            scene.dragOrigin.set(pointer.x, pointer.y);

            // Anchor for robust panning
            scene.dragStartCam.set(scene.cameras.main.scrollX, scene.cameras.main.scrollY);
            scene.dragStartScreen.set(pointer.position.x, pointer.position.y);

            // Start deployment timer and spawn first troop immediately for responsiveness
            if (scene.mode === 'ATTACK' && !scene.isScouting) {
                scene.deployStartTime = scene.time.now;
                const worldPoint = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
                const gridPosFloat = IsoUtils.isoToCart(worldPoint.x, worldPoint.y);
                const bounds = scene.getBuildingsBounds('ENEMY');
                const margin = 2;
                const isInsideMap = gridPosFloat.x >= -margin && gridPosFloat.x < scene.mapSize + margin &&
                    gridPosFloat.y >= -margin && gridPosFloat.y < scene.mapSize + margin;
                const isForbidden = bounds && gridPosFloat.x >= bounds.minX && gridPosFloat.x <= bounds.maxX &&
                    gridPosFloat.y >= bounds.minY && gridPosFloat.y <= bounds.maxY;

                if (isInsideMap && !isForbidden) {
                    const army = gameManager.getArmy();
                    const selectedType = gameManager.getSelectedTroopType();
                    scene.isLockingDragForTroops = true; // Lock camera panning for this drag
                    if (selectedType && army[selectedType] > 0) {
                        scene.spawnTroop(gridPosFloat.x, gridPosFloat.y, selectedType as TroopType, 'PLAYER');
                        gameManager.deployTroop(selectedType);
                        scene.lastDeployTime = scene.time.now;
                    }
                }
            }
        }
    }

    async onPointerUp(pointer: Phaser.Input.Pointer) {
        // Skip if pinching
        if (this.isPinching) return;

        this.lastWallDragTile = null;

        const scene = this.scene;
        // Calculate drag distance
        const dist = Phaser.Math.Distance.Between(pointer.downX, pointer.downY, pointer.upX, pointer.upY);

        // If moved significantly, treat as drag and do nothing else
        if (dist > cssPixelsToBacking(10)) {
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
                    // Clear any obstacles at the new position
                    scene.removeOverlappingObstacles(targetX, targetY, info.width, info.height);

                    // Store old position before updating (needed for wall neighbor refresh)
                    const oldGridX = scene.selectedInWorld.gridX;
                    const oldGridY = scene.selectedInWorld.gridY;
                    const isWall = scene.selectedInWorld.type === 'wall';

                    scene.selectedInWorld.gridX = targetX;
                    scene.selectedInWorld.gridY = targetY;
                    scene.selectedInWorld.graphics.clear();
                    if (scene.selectedInWorld.baseGraphics) {
                        scene.selectedInWorld.baseGraphics.clear();
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
                }
                return;
            }

            if (pointer.rightButtonDown()) {
                scene.cancelPlacement();
                return;
            }

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
                        scene.tweens.add({
                            targets: scene.ghostBuilding,
                            x: scene.ghostBuilding.x + 5,
                            duration: 50,
                            yoyo: true,
                            repeat: 3
                        });
                    }
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
                    scene.selectedInWorld = null;
                    gameManager.onBuildingSelected(null);
                    scene.clearBuildingRangeIndicator();
                    if (clicked.type === 'prism') {
                        scene.cleanupPrismLaser(clicked);
                    }
                } else {
                    if (scene.selectedInWorld !== clicked) {
                        scene.clearBuildingRangeIndicator();
                    }
                    scene.selectedInWorld = clicked;
                    soundSystem.play('click');
                    gameManager.onBuildingSelected({ id: clicked.id, type: clicked.type as BuildingType, level: clicked.level || 1, gridX: clicked.gridX, gridY: clicked.gridY, upgradeEndsAt: clicked.upgradeEndsAt });
                    if (clicked.type === 'jukebox') gameManager.openJukebox();
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

    onPointerMove(pointer: Phaser.Input.Pointer) {
        // Skip if pinching
        if (this.isPinching) return;

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
                const bounds = scene.getBuildingsBounds('ENEMY');
                const isForbidden = bounds && cartFloat.x >= bounds.minX && cartFloat.x <= bounds.maxX &&
                    cartFloat.y >= bounds.minY && cartFloat.y <= bounds.maxY;

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

        if (scene.mode === 'ATTACK' && !scene.isScouting && pointer.isDown) {
            const now = scene.time.now;
            const holdDuration = now - scene.deployStartTime;

            // Ramping fire rate: Start slow (500ms), speed up (250ms), then turbo (100ms)
            let interval = 500;
            if (holdDuration > 1000) interval = 100;
            else if (holdDuration > 500) interval = 250;

            if (now - scene.lastDeployTime > interval) {
                const bounds = scene.getBuildingsBounds('ENEMY');
                const margin = 2;
                const isInsideMap = gridPosFloat.x >= -margin && gridPosFloat.x < scene.mapSize + margin &&
                    gridPosFloat.y >= -margin && gridPosFloat.y < scene.mapSize + margin;
                const isForbidden = bounds && gridPosFloat.x >= bounds.minX && gridPosFloat.x <= bounds.maxX &&
                    gridPosFloat.y >= bounds.minY && gridPosFloat.y <= bounds.maxY;

                if (isForbidden) {
                    scene.lastForbiddenInteractionTime = now;
                }

                if (isInsideMap && !isForbidden) {
                    const army = gameManager.getArmy();
                    const selectedType = gameManager.getSelectedTroopType();
                    if (selectedType && army[selectedType] > 0) {
                        scene.spawnTroop(gridPosFloat.x, gridPosFloat.y, selectedType as TroopType, 'PLAYER');
                        gameManager.deployTroop(selectedType);
                        scene.lastDeployTime = now;
                        return;
                    }
                }
            }
        }


        scene.ghostBuilding.clear();
        if (scene.selectedBuildingType || (scene.isMoving && scene.selectedInWorld)) {
            const type = scene.selectedBuildingType || scene.selectedInWorld?.type;
            if (type) {
                const info = BUILDINGS[type];
                // Calculate ghost position centered on cursor
                const ghostX = Math.round(gridPosFloat.x - info.width / 2);
                const ghostY = Math.round(gridPosFloat.y - info.height / 2);

                if (ghostX >= 0 && ghostX < scene.mapSize && ghostY >= 0 && ghostY < scene.mapSize) {
                    scene.ghostBuilding.setVisible(true);

                    // Determine Ghost Level for accurate preview
                    let level = 1;
                    if (scene.selectedInWorld) {
                        level = scene.selectedInWorld.level || 1;
                    } else if (type === 'wall') {
                        level = Math.max(1, scene.preferredWallLevel || 1);
                    }

                    const ghostObj = { type: type as BuildingType, level: level, gridX: ghostX, gridY: ghostY };
                    scene.drawBuildingVisuals(scene.ghostBuilding, ghostX, ghostY, type, 0.5, null, ghostObj as any);

                    // Ghost depth should be on top of everything for visibility
                    scene.ghostBuilding.setDepth(200000);

                    // Track ghost position so selection outline & range indicator follow
                    scene.ghostGridPos = { x: ghostX, y: ghostY };

                    // Update range indicator to follow ghost
                    if (scene.isMoving && scene.selectedInWorld?.rangeIndicator) {
                        scene.showBuildingRangeIndicator(
                            { ...scene.selectedInWorld, gridX: ghostX, gridY: ghostY } as any
                        );
                    }
                } else { scene.ghostBuilding.setVisible(false); }
            }
        } else {
            scene.ghostGridPos = null;
        }
    }
}
