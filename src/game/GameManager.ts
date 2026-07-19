import type { BuildingType } from './config/GameDefinitions';
import type { GameMode } from './types/GameMode';
import type { MerchantOffer } from './systems/VillageLifeSystem';

export type BuildingSelection = { id: string; type: BuildingType; level: number; gridX?: number; gridY?: number; upgradeEndsAt?: number } | null;

/** One row on the world-map neighbour sheet. `kind` lets the UI gate attacks. */
export interface PlotPanelAction {
    label: string;
    kind: 'attack' | 'scout' | 'watch' | 'settle' | 'info';
    run: () => void;
}
export interface PlotPanelInfo {
    title: string;
    /** Shown as a trophy pixel icon + count under the title. */
    trophies?: number;
    /** World-space point the bubble hangs above (the plot's centre). */
    anchor?: { x: number; y: number };
    /** World-space point the bubble flips below when it can't fit above. */
    anchorBelow?: { x: number; y: number };
    actions: PlotPanelAction[];
}

type UIHandlers = {
    showCloudOverlay: () => void;
    hideCloudOverlay: () => void;
    setGameMode: (mode: GameMode) => void;
    updateBattleStats: (destruction: number, gold: number, ore?: number, food?: number) => void;
    onBuildingSelected: (data: BuildingSelection) => void;
    onPlacementCancelled: () => void;
    /** `applied` carries authoritative settlement metadata. A
     *  `settlementDelayed` result must not animate a false zero payout; the
     *  server will reconcile the resource chips when banking completes. */
    onRaidEnded: (goldLooted: number, applied?: { ore?: number; food?: number; settlementDelayed?: boolean }) => void | Promise<void>;
    /** A mid-raid retreat settled: pass confirmed partial loot to the home
     *  resource-chip animation. Never starts another transition — goHome is
     *  already running inside one. */
    onRetreatEnded: (results: {
        destruction: number;
        goldLooted: number;
        oreLooted: number;
        foodLooted: number;
        trophyDelta?: number;
        settlementDelayed?: boolean;
    }) => void;
    getArmy: () => Record<string, number>;
    getResources: () => { gold: number; ore: number; food: number };
    getSelectedTroopType: () => string | null;
    deployTroop: (type: string) => void;
    refreshCampCapacity: (campLevels: number[]) => void;
    onBuildingPlaced: (type: string, isFree?: boolean) => void;
    closeMenus: () => void;
    /** Baseline economy: eggs and hauled rocks turn into food/ore. */
    collectResource: (kind: 'ore' | 'food', amount: number) => void;
    /** Open the jukebox track list (jukebox building selected). */
    openJukebox: () => void;
    /** Open the village banner picker (own town hall selected). */
    openBannerPicker: () => void;
    /** Open the traveling merchant's trade sheet. */
    openMerchant: (offers: MerchantOffer[]) => void;
    /** Open/close the world-map neighbour action sheet. */
    openPlotPanel: (info: PlotPanelInfo) => void;
    closePlotPanel: () => void;
    /** Route world-map actions through React so its mode-specific UI state stays in sync. */
    requestScoutOnUser: (userId: string, username: string) => void;
    requestWatchLiveAttack: (attackId: string, attackerName: string) => void;
    /** Transient banner (track unlocks, merchant arrivals...). */
    showToast: (message: string) => void;
};

type SceneCommands = {
    selectBuilding: (type: string | null) => void;
    startAttack: () => void;
    startPracticeAttack: () => void;
    startOnlineAttack: () => void;
    startAttackOnUser: (userId: string, username: string) => void;
    startScoutOnUser: (userId: string, username: string) => void;
    watchLiveAttack: (attackId: string) => void;
    watchReplay: (attackId: string) => void;
    findNewMap: () => void;
    deleteSelectedBuilding: () => boolean;
    /** Drop the in-world selection (ring + range indicator) and tell the UI. */
    deselectBuilding: () => void;
    moveSelectedBuilding: () => void;
    upgradeSelectedBuilding: () => number | null;
    loadBase: () => Promise<boolean>;
    /** Live raid against the player's own base started/ended: villagers hide in / come out of the town hall. */
    setUnderAttack: (underAttack: boolean, attackId?: string | null) => void;
    dismissSiegeBanner: () => void;
    /** Debug: jump the day/night cycle to its next milestone (N key). */
    advanceDayNight: () => void;
    /** Send the dragon's shadow sweeping over the village (D key). */
    summonDragon: () => void;
    /** Toggle between the live village and its rendered world-map neighbourhood. */
    showNeighborhood: () => void;
    /** Server population changed: births arrive as children at the town hall. */
    syncPopulation: (count: number) => void;
};

class GameManager {
    private uiHandlers: Partial<UIHandlers> = {};
    private sceneCommands: Partial<SceneCommands> = {};

    private async waitForSceneLoadCommand(timeoutMs = 1500): Promise<(() => Promise<boolean>) | null> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const handler = this.sceneCommands.loadBase;
            if (handler) return handler;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return null;
    }

    registerUI(handlers: Partial<UIHandlers>) {
        this.uiHandlers = { ...this.uiHandlers, ...handlers };
    }

    registerScene(handlers: Partial<SceneCommands>) {
        this.sceneCommands = { ...this.sceneCommands, ...handlers };
    }

    clearUI() {
        this.uiHandlers = {};
    }

    clearScene() {
        this.sceneCommands = {};
    }

    showCloudOverlay() {
        this.uiHandlers.showCloudOverlay?.();
    }

    hideCloudOverlay() {
        this.uiHandlers.hideCloudOverlay?.();
    }


    setGameMode(mode: GameMode) {
        this.uiHandlers.setGameMode?.(mode);
    }

    updateBattleStats(destruction: number, gold: number, ore = 0, food = 0) {
        this.uiHandlers.updateBattleStats?.(destruction, gold, ore, food);
    }

    onBuildingSelected(data: BuildingSelection) {
        this.uiHandlers.onBuildingSelected?.(data);
    }

    onPlacementCancelled() {
        this.uiHandlers.onPlacementCancelled?.();
    }

    onRaidEnded(goldLooted: number, applied?: { ore?: number; food?: number; settlementDelayed?: boolean }) {
        if (this.uiHandlers.onRaidEnded) {
            this.uiHandlers.onRaidEnded(goldLooted, applied);
            return true;
        }
        return false;
    }

    onRetreatEnded(results: {
        destruction: number;
        goldLooted: number;
        oreLooted: number;
        foodLooted: number;
        trophyDelta?: number;
        settlementDelayed?: boolean;
    }) {
        this.uiHandlers.onRetreatEnded?.(results);
    }

    getArmy() {
        return this.uiHandlers.getArmy?.() ?? {};
    }

    getResources() {
        return this.uiHandlers.getResources?.() ?? null;
    }

    getSelectedTroopType() {
        return this.uiHandlers.getSelectedTroopType?.() ?? null;
    }

    deployTroop(type: string) {
        this.uiHandlers.deployTroop?.(type);
    }

    refreshCampCapacity(campLevels: number[]) {
        this.uiHandlers.refreshCampCapacity?.(campLevels);
    }

    onBuildingPlaced(type: string, isFree: boolean = false) {
        this.uiHandlers.onBuildingPlaced?.(type, isFree);
    }

    selectBuilding(type: string | null) {
        this.sceneCommands.selectBuilding?.(type);
    }

    startAttack() {
        this.sceneCommands.startAttack?.();
    }

    startPracticeAttack() {
        this.sceneCommands.startPracticeAttack?.();
    }

    startOnlineAttack() {
        this.sceneCommands.startOnlineAttack?.();
    }

    startAttackOnUser(userId: string, username: string) {
        this.sceneCommands.startAttackOnUser?.(userId, username);
    }

    startScoutOnUser(userId: string, username: string) {
        this.sceneCommands.startScoutOnUser?.(userId, username);
    }

    watchLiveAttack(attackId: string) {
        this.sceneCommands.watchLiveAttack?.(attackId);
    }

    watchReplay(attackId: string) {
        this.sceneCommands.watchReplay?.(attackId);
    }

    findNewMap() {
        this.sceneCommands.findNewMap?.();
    }

    deleteSelectedBuilding() {
        return this.sceneCommands.deleteSelectedBuilding?.() ?? false;
    }

    deselectBuilding() {
        this.sceneCommands.deselectBuilding?.();
    }

    moveSelectedBuilding() {
        this.sceneCommands.moveSelectedBuilding?.();
    }

    upgradeSelectedBuilding() {
        return this.sceneCommands.upgradeSelectedBuilding?.() ?? null;
    }

    setUnderAttack(underAttack: boolean, attackId?: string | null) {
        this.sceneCommands.setUnderAttack?.(underAttack, attackId ?? null);
    }

    dismissSiegeBanner() {
        this.sceneCommands.dismissSiegeBanner?.();
    }

    advanceDayNight() {
        this.sceneCommands.advanceDayNight?.();
    }

    summonDragon() {
        this.sceneCommands.summonDragon?.();
    }

    showNeighborhood() {
        this.sceneCommands.showNeighborhood?.();
    }

    syncPopulation(count: number) {
        this.sceneCommands.syncPopulation?.(count);
    }

    closeMenus() {
        this.uiHandlers.closeMenus?.();
    }

    collectResource(kind: 'ore' | 'food', amount: number) {
        this.uiHandlers.collectResource?.(kind, amount);
    }

    openJukebox() {
        // One surface at a time: the scene must drop its selection ring too.
        // The InfoPanel TRACKS button path would otherwise leave the ring
        // pulsing under the modal (the in-scene double-tap path has already
        // deselected — this is a no-op there).
        this.sceneCommands.deselectBuilding?.();
        this.uiHandlers.openJukebox?.();
    }

    openBannerPicker() {
        // Same surface discipline as the jukebox: the selection ring under
        // the town hall drops before the modal takes the screen.
        this.sceneCommands.deselectBuilding?.();
        this.uiHandlers.openBannerPicker?.();
    }

    openMerchant(offers: MerchantOffer[]) {
        this.uiHandlers.openMerchant?.(offers);
    }

    openPlotPanel(info: PlotPanelInfo) {
        this.uiHandlers.openPlotPanel?.(info);
    }

    closePlotPanel() {
        this.uiHandlers.closePlotPanel?.();
    }

    requestScoutOnUser(userId: string, username: string) {
        this.uiHandlers.requestScoutOnUser?.(userId, username);
    }

    requestWatchLiveAttack(attackId: string, attackerName: string) {
        this.uiHandlers.requestWatchLiveAttack?.(attackId, attackerName);
    }

    showToast(message: string) {
        this.uiHandlers.showToast?.(message);
    }

    async loadBase() {
        const handler = this.sceneCommands.loadBase ?? await this.waitForSceneLoadCommand();
        if (!handler) return false;
        return await handler();
    }
}

export const gameManager = new GameManager();
