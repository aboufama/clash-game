
import { useCallback, useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { createGameConfig } from './game/GameConfig';
import { installDisplayResolution } from './game/utils/DisplayResolution';
import type { GameMode } from './game/types/GameMode';
import { BUILDING_DEFINITIONS, FACTION_BARRACKS, PLAYER_TROOP_TYPES, TROOP_DEFINITIONS, TROOP_FACTIONS, type ArmyCampUnlockProgress, type BuildingType, type PlayerTroopType, type TroopFaction, type TroopType, armyCampUnlockProgress, getBuildingStats, upgradeOreCostOf, troopFoodCostOf } from './game/config/GameDefinitions';
import { armySpaceUsed, campCapacityOf, campHousingAtLevel, effectiveTroopLevel, factionBarracksLevels, labUpgradeInFlight, placementCharge, productionRatesPerSecond, resourceCapacity, type FactionBarracksLevels } from './game/config/Economy';
import { Backend, type IncomingAttackSession } from './game/backend/GameBackend';
import { sanitizeVillageBanner, type SerializedWorld } from './game/data/Models';
import { Auth, type AuthUser } from './game/backend/Auth';
import { AuthGate } from './components/AuthGate';
import { gameManager, type PlotPanelInfo, type PlotPanelAction } from './game/GameManager';
import { PlotPanel } from './components/PlotPanel';
import { MapAtlasModal } from './components/MapAtlasModal';
import { ReplayTheatreModal } from './components/ReplayTheatreModal';
import { MobileUtils } from './game/utils/MobileUtils';
import { CloudOverlay, CLOUD_OPEN_TOTAL_MS } from './components/CloudOverlay';
import { TrainingModal } from './components/TrainingModal';
import { BuildingShopModal } from './components/BuildingShopModal';
import { Hud } from './components/Hud';
import { DebugMenu } from './components/DebugMenu';
import { NotificationsPanel } from './components/NotificationsPanel';
import { LeaderboardPanel } from './components/LeaderboardPanel';
import { AccountModal } from './components/AccountModal';
import { JukeboxModal } from './components/JukeboxModal';
import { BannerPickerModal } from './components/BannerPickerModal';
import { MerchantModal } from './components/MerchantModal';
import { soundSystem } from './game/systems/SoundSystem';
import { musicSystem } from './game/systems/MusicSystem';
import type { MerchantOffer } from './game/systems/VillageLifeSystem';
import './App.css';

// Initialize mobile support
MobileUtils.setupMobileViewport();
MobileUtils.preventDefaultTouchBehaviors();

function hasRenderableWorldPayload(world: unknown): world is { buildings: unknown[] } {
  if (!world || typeof world !== 'object') return false;
  const maybe = world as { buildings?: unknown };
  return Array.isArray(maybe.buildings) && maybe.buildings.length > 0;
}

// Static shop/troop catalogs — derived once from the definitions instead of being
// rebuilt (and re-sorted) on every App render.
const DEFENSE_SHOP_ORDER: BuildingType[] = ['wall', 'cannon', 'ballista', 'mortar', 'tesla', 'xbow', 'prism', 'spike_launcher', 'dragons_breath'];
const DEFENSE_ORDER_INDEX = new Map(DEFENSE_SHOP_ORDER.map((type, index) => [type, index]));
const CATEGORY_ORDER: Record<string, number> = {
  defense: 0,
  military: 1,
  resource: 2,
  other: 3,
  army: 1
};

const buildingList = Object.values(BUILDING_DEFINITIONS).sort((a, b) => {
  const categoryRankA = CATEGORY_ORDER[a.category || 'other'] ?? 99;
  const categoryRankB = CATEGORY_ORDER[b.category || 'other'] ?? 99;
  if (categoryRankA !== categoryRankB) return categoryRankA - categoryRankB;

  if (a.category === 'defense' && b.category === 'defense') {
    const orderA = DEFENSE_ORDER_INDEX.get(a.id as BuildingType) ?? 999;
    const orderB = DEFENSE_ORDER_INDEX.get(b.id as BuildingType) ?? 999;
    if (orderA !== orderB) return orderA - orderB;
  }

  if (a.cost !== b.cost) return a.cost - b.cost;
  return a.name.localeCompare(b.name);
});
// Canonical training order (scenario-only units excluded by construction).
const troopList = PLAYER_TROOP_TYPES.map(id => TROOP_DEFINITIONS[id]);
const emptyFactionBarracksLevels = (): FactionBarracksLevels => Object.fromEntries(
  TROOP_FACTIONS.map(faction => [faction, 0])
) as FactionBarracksLevels;
const emptyFactionUpgradeState = (): Record<TroopFaction, boolean> => Object.fromEntries(
  TROOP_FACTIONS.map(faction => [faction, false])
) as Record<TroopFaction, boolean>;
const EMPTY_ARMY_CAMP_PROGRESS: ArmyCampUnlockProgress = Object.freeze({
  completedLevel: 0,
  upgradingToLevel: null,
  upgrading: false
});
const INFINITE_SPENDABLE_RESOURCES = Object.freeze({
  gold: Number.MAX_SAFE_INTEGER,
  ore: Number.MAX_SAFE_INTEGER,
  food: Number.MAX_SAFE_INTEGER
});

/** Expand a sparse server army into the one stable player-roster shape React
 * uses. Unknown/generated-only units never leak into the trainable HUD. */
function playerArmySnapshot(source: Record<string, number> | null | undefined): Record<PlayerTroopType, number> {
  return Object.fromEntries(PLAYER_TROOP_TYPES.map(type => [
    type,
    Math.max(0, Math.floor(Number(source?.[type]) || 0))
  ])) as Record<PlayerTroopType, number>;
}

function TestModePopup({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay test-mode-overlay" onClick={onClose} role="presentation">
      <section
        className="test-mode-popup pixel-cut"
        role="dialog"
        aria-modal="true"
        aria-labelledby="test-mode-title"
        aria-describedby="test-mode-description"
        onClick={event => event.stopPropagation()}
      >
        <div className="test-mode-sigil" aria-hidden="true">
          <span className="test-mode-sigil-crown">◆</span>
          <strong>∞</strong>
        </div>
        <p className="test-mode-kicker">Royal Proving Grounds</p>
        <h2 id="test-mode-title">TEST MODE ENABLED</h2>
        <p id="test-mode-description" className="test-mode-description">
          The realm keeper has opened every workshop and war room for testing.
        </p>
        <div className="test-mode-benefits" aria-label="Test mode benefits">
          <div className="test-mode-benefit">
            <span className="test-mode-feature-mark" aria-hidden="true">∞</span>
            <span><strong>Infinite resources</strong><small>Build and train without spending</small></span>
          </div>
          <div className="test-mode-benefit">
            <span className="test-mode-feature-mark sym sym-castle" aria-hidden="true" />
            <span><strong>Instant upgrades</strong><small>Every level completes immediately</small></span>
          </div>
          <div className="test-mode-benefit">
            <span className="test-mode-feature-mark sym sym-swords" aria-hidden="true" />
            <span><strong>All troops unlocked</strong><small>Train from the complete roster</small></span>
          </div>
        </div>
        <button className="test-mode-enter" type="button" onClick={onClose} autoFocus>
          ENTER THE VILLAGE
        </button>
        <small className="test-mode-footnote">Test access is controlled by the realm administrator.</small>
      </section>
    </div>
  );
}


function App() {
  const gameRef = useRef<Phaser.Game | null>(null);
  const displayResolutionCleanupRef = useRef<(() => void) | null>(null);

  type UserProfile = { id: string; username: string; trophies: number; registered: boolean; lastLogin: number };
  const [user, setUser] = useState<UserProfile | null>(null);
  // Primitive identity for effect deps: profile-only changes (rename, register)
  // must NOT tear down and recreate the Phaser game or reload the world.
  const userId = user?.id ?? null;
  const userRef = useRef<UserProfile | null>(null);
  useEffect(() => {
    userRef.current = user;
  }, [user]);
  const [authReady, setAuthReady] = useState(false);
  const [isOnline, setIsOnline] = useState(false);
  const [infiniteResources, setInfiniteResources] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [isTestModePopupOpen, setIsTestModePopupOpen] = useState(false);
  const testModeAnnouncementShownRef = useRef(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Production registration wall: the server granted no identity, so the
  // account gate (username + password) is all this device may see.
  const [needsAccount, setNeedsAccount] = useState(false);
  const [worldReady, setWorldReady] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isJukeboxOpen, setIsJukeboxOpen] = useState(false);
  const [isBannerPickerOpen, setIsBannerPickerOpen] = useState(false);
  const [isBannerRequired, setIsBannerRequired] = useState(false);
  const [merchantOffers, setMerchantOffers] = useState<MerchantOffer[] | null>(null);
  const [plotPanel, setPlotPanel] = useState<PlotPanelInfo | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const merchantTradesInFlightRef = useRef(new Set<number>());
  const showToast = useCallback((message: string) => {
    // The ONE toast surface: every banner (scene or React) lands here, so the
    // notify chime lives here too. SoundSystem rate-limits repeats.
    soundSystem.play('notify');
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  }, []);
  // The game only boots when a live session exists (the Phaser-creation effect
  // requires user && isOnline), so the lockout screen must cover the offline
  // case too — otherwise a returning player with a cached identity but an
  // unreachable server would see an empty page with no overlay and no retry.
  const isLockedOut = sessionExpired || !user || !isOnline;

  const [loading, setLoading] = useState(true);
  const [showCloudOverlay, setShowCloudOverlay] = useState(true);
  const [cloudOpening, setCloudOpening] = useState(false);
  const [cloudOverlayLoading, setCloudOverlayLoading] = useState(true);
  const [cloudLoadingProgress, setCloudLoadingProgress] = useState(4);
  const [cloudTransitionReward, setCloudTransitionReward] = useState<number | null>(null);
  const [lootAnimating, setLootAnimating] = useState<{ amount: number } | null>(null);
  // Mirror for timer callbacks: reading the reward through a ref keeps the
  // count-up side effect OUT of state updaters (StrictMode double-invokes
  // updaters, which used to restart the animation).
  const cloudTransitionRewardRef = useRef<number | null>(null);
  useEffect(() => {
    cloudTransitionRewardRef.current = cloudTransitionReward;
  }, [cloudTransitionReward]);
  const cloudOpenTimerRef = useRef<number | null>(null);
  const cloudHideTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!testMode) {
      // A later false -> true transition is a new enablement and deserves a
      // fresh announcement. Repeated home heartbeats while true stay silent.
      testModeAnnouncementShownRef.current = false;
      setIsTestModePopupOpen(false);
      return;
    }
    if (
      testModeAnnouncementShownRef.current
      || !worldReady
      || showCloudOverlay
      || isLockedOut
      || isBannerRequired
      || isBannerPickerOpen
    ) return;
    testModeAnnouncementShownRef.current = true;
    setIsTestModePopupOpen(true);
  }, [testMode, worldReady, showCloudOverlay, isLockedOut, isBannerRequired, isBannerPickerOpen]);
  const [resources, setResources] = useState({ gold: 0, ore: 0, food: 0 });
  // Server-authoritative village population — a core mechanic later; display-only today.
  const [population, setPopulation] = useState({ count: 0, capacity: 0, workersNeeded: 0, staffing: 1 });
  const resourcesRef = useRef(resources);
  // Ticking HUD values: base balances + predicted accrual (see the predictive block below).
  const [displayResources, setDisplayResources] = useState(resources);
  const spendableResources = infiniteResources ? INFINITE_SPENDABLE_RESOURCES : displayResources;
  // Derived from the canonical tuple — never restate the troop list.
  const [army, setArmy] = useState<Record<PlayerTroopType, number>>(
    () => Object.fromEntries(PLAYER_TROOP_TYPES.map(type => [type, 0])) as Record<PlayerTroopType, number>
  );
  const [isMobile, setIsMobile] = useState(() => MobileUtils.isMobile());
  // MobileUtils re-evaluates the heuristic on resize/orientation and keeps
  // the body class fresh; mirror those flips into React so `.hud.mobile`
  // (and every isMobile prop) tracks reality instead of latching at mount.
  useEffect(() => MobileUtils.onMobileChange(setIsMobile), []);

  useEffect(() => {
    let cancelled = false;
    Auth.ensureUser()
      .then(({ user: authUser, online, world, registrationRequired }) => {
        if (cancelled) return;
        setNeedsAccount(Boolean(registrationRequired) && online);
        if (authUser) {
          if (hasRenderableWorldPayload(world)) {
            Backend.primeWorldCache(authUser.id, world);
          }
          if (online) {
            // A reload can interrupt a server-registered raid after the id was
            // issued. Reconcile it in the background so army/world locks do
            // not linger for minutes, without holding the boot screen open.
            void Backend.reconcileInterruptedBattle().catch(error => {
              console.warn('Interrupted battle reconciliation is still pending:', error);
            });
          }
          setUser({
            id: authUser.id,
            username: authUser.username,
            trophies: authUser.trophies ?? 0,
            registered: Boolean(authUser.registered),
            lastLogin: Date.now()
          });
        } else {
          setUser(null);
        }
        const features = Auth.getFeatures();
        setInfiniteResources(online && features.infiniteResources);
        setTestMode(online && features.testMode);
        setIsOnline(online);
      })
      .catch(error => {
        console.warn('Auth init failed:', error);
        if (!cancelled) {
          setUser(null);
          setIsOnline(false);
          setInfiniteResources(false);
          setTestMode(false);
          setNeedsAccount(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAuthReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyGoldDelta = useCallback(async (delta: number, reason: string, refId?: string) => {
    if (!user) return { applied: false, gold: resourcesRef.current.gold };

    const userId = user.id || 'default_player';
    const currentSol = resourcesRef.current.gold;
    if (delta < 0 && currentSol + delta < 0) {
      return { applied: false, gold: currentSol };
    }

    const optimisticSol = Math.max(0, currentSol + delta);
    resourcesRef.current = { ...resourcesRef.current, gold: optimisticSol };
    setResources(prev => ({ ...prev, gold: optimisticSol }));

    if (!isOnline) {
      return { applied: true, gold: optimisticSol };
    }

    const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    void Backend.applyResourceDelta(userId, delta, reason, refId, requestId)
      // Backend emits one revision-gated world sync. Do not independently
      // apply this response here: a newer poll may already have landed.
      .then(() => undefined)
      .catch(async error => {
        console.warn('Resource sync failed, reconciling from server:', error);
        try {
          await Backend.calculateOfflineProduction(userId);
          const cached = Backend.getCachedWorld(userId);
          if (cached) {
            const reconciledSol = Math.max(0, cached.resources.gold);
            resourcesRef.current = { ...resourcesRef.current, gold: reconciledSol };
            setResources(prev => ({ ...prev, gold: reconciledSol }));
            return;
          }
        } catch (reconcileError) {
          console.warn('Resource reconcile failed:', reconcileError);
        }

        resourcesRef.current = { ...resourcesRef.current, gold: currentSol };
        setResources(prev => ({ ...prev, gold: currentSol }));
      });

    return { applied: true, gold: optimisticSol };
  }, [user, isOnline]);

  // Stable handle for long-lived closures (Phaser UI handlers) so they never go stale
  // and the game-lifecycle effect doesn't need applyGoldDelta in its deps.
  const applyGoldDeltaRef = useRef(applyGoldDelta);
  useEffect(() => {
    applyGoldDeltaRef.current = applyGoldDelta;
  }, [applyGoldDelta]);

  // One merchant deal: the server re-derives today's offers from the same
  // shared generator and prices the trade itself. Resources do not move
  // optimistically: the returned authoritative snapshot is adopted by Backend,
  // so a dropped/failed response can never trigger an arithmetic resource mint.
  const handleMerchantTrade = useCallback(async (offer: MerchantOffer) => {
    if (offer.done || merchantTradesInFlightRef.current.has(offer.id) || spendableResources[offer.give.kind] < offer.give.amount) return;
    // Storage-cap guard: the server silently CAPS an overflowing gain
    // (storedResourceAfterDelta), so warn before anything vanishes. A deal
    // whose entire yield would evaporate is blocked (friendlier than letting
    // the player pay for nothing); a partial overflow proceeds with a toast.
    if (!infiniteResources && (offer.get.kind === 'ore' || offer.get.kind === 'food')) {
      const cap = storageCapsRef.current?.[offer.get.kind];
      if (typeof cap === 'number' && cap > 0) {
        const stored = Math.max(0, Math.floor(Number(resourcesRef.current[offer.get.kind] ?? 0)));
        const headroom = Math.max(0, cap - stored);
        if (headroom <= 0) {
          showToast(`Storage full — the ${offer.get.amount} ${offer.get.kind.toUpperCase()} would be lost. Make room first.`);
          return;
        }
        if (headroom < offer.get.amount) {
          showToast(`Storage almost full — ${offer.get.amount - headroom} ${offer.get.kind.toUpperCase()} of this deal will be lost.`);
        }
      }
    }
    merchantTradesInFlightRef.current.add(offer.id);
    offer.done = true;
    setMerchantOffers(prev => prev ? [...prev] : prev);
    try {
      const result = await Backend.merchantTrade(offer.id);
      if (!result?.applied) throw new Error('The merchant refused the deal');
      soundSystem.play('trade');
      if (soundSystem.unlockTrack('merchants_tune')) {
        showToast("New track unlocked: Merchant's Tune!");
      }
      // Every deal taken: no reason to linger on an empty trade sheet — close
      // it and send the merchant packing, same as if he'd left on his own.
      if (merchantOffers?.every(o => o.done)) {
        setMerchantOffers(null);
        gameManager.merchantSoldOut();
      }
    } catch (error) {
      console.warn('Merchant trade failed:', error);
      offer.done = false;
      setMerchantOffers(prev => prev ? [...prev] : prev);
      if (userId) await Backend.forceLoadFromCloud(userId).catch(() => null);
      showToast('That deal fell through — nothing was traded.');
    } finally {
      merchantTradesInFlightRef.current.delete(offer.id);
    }
  }, [spendableResources, showToast, userId, infiniteResources, merchantOffers]);


  useEffect(() => {
    return () => {
      gameManager.clearUI();
    };
  }, []);

  // Safety net: flush any pending save when the user navigates away or reloads.
  // Uses keepalive fetch so the request survives page unload.
  useEffect(() => {
    const handleBeforeUnload = () => {
      Backend.flushBeforeUnload();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const clearCloudTimers = useCallback(() => {
    if (cloudOpenTimerRef.current) {
      window.clearTimeout(cloudOpenTimerRef.current);
      cloudOpenTimerRef.current = null;
    }
    if (cloudHideTimerRef.current) {
      window.clearTimeout(cloudHideTimerRef.current);
      cloudHideTimerRef.current = null;
    }
  }, []);

  const beginVillageLoadCloud = useCallback((progress: number) => {
    clearCloudTimers();
    setCloudOpening(false);
    setCloudOverlayLoading(true);
    setCloudLoadingProgress(Math.max(0, Math.min(100, Math.floor(progress))));
    cloudTransitionRewardRef.current = null;
    setCloudTransitionReward(null);
    setShowCloudOverlay(true);
  }, [clearCloudTimers]);

  const updateVillageLoadCloud = useCallback((progress: number) => {
    setCloudLoadingProgress(Math.max(0, Math.min(100, Math.floor(progress))));
  }, []);

  const revealVillageFromCloud = useCallback(() => {
    clearCloudTimers();
    setCloudLoadingProgress(100);

    cloudOpenTimerRef.current = window.setTimeout(() => {
      setCloudOverlayLoading(false);
      setCloudOpening(true);
      cloudHideTimerRef.current = window.setTimeout(() => {
        setShowCloudOverlay(false);
        setCloudOpening(false);
      }, CLOUD_OPEN_TOTAL_MS + 40); // slowest cloud layer finishes at OPEN_MS × 1.2; hiding earlier strands a haze band on wide windows
    }, 220);
  }, [clearCloudTimers]);

  const wait = useCallback(async (ms: number) => {
    await new Promise(resolve => setTimeout(resolve, ms));
  }, []);

  const waitForMainSceneReady = useCallback(async () => {
    const timeoutMs = 5000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const sceneReady = Boolean((gameRef.current?.scene as { keys?: Record<string, unknown> } | undefined)?.keys?.MainScene);
      if (sceneReady) return true;
      await wait(50);
    }
    return false;
  }, [wait]);

  const ensureSceneBaseLoaded = useCallback(async () => {
    const sceneReady = await waitForMainSceneReady();
    if (!sceneReady) return false;

    const maxAttempts = 24;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // SpriteBank loads independently inside Phaser. Mirror its real
      // progress into the final 10% of the boot clouds while loadBase awaits
      // both world hydration and the baked atlas bank.
      const spriteProgressTimer = window.setInterval(() => {
        const scene = gameRef.current?.scene.getScene('MainScene') as { getSpriteBankLoadProgress?: () => number } | undefined;
        const spriteProgress = Number(scene?.getSpriteBankLoadProgress?.() ?? 0);
        if (Number.isFinite(spriteProgress)) {
          updateVillageLoadCloud(88 + Math.floor(Math.max(0, Math.min(1, spriteProgress)) * 10));
        }
      }, 80);
      try {
        const ok = await gameManager.loadBase();
        if (ok) {
          const scene = gameRef.current?.scene.getScene('MainScene') as { getHomePlayableBuildingCount?: () => number } | undefined;
          const playableCount = Number(scene?.getHomePlayableBuildingCount?.() ?? 0);
          if (playableCount > 0) {
            return true;
          }
          console.warn('Scene reported successful load but rendered no playable buildings. Retrying.', { attempt, playableCount });
        }
      } catch (error) {
        console.warn('Scene base load attempt failed', { attempt, error });
      } finally {
        window.clearInterval(spriteProgressTimer);
      }
      await wait(180);
    }
    return false;
  }, [updateVillageLoadCloud, wait, waitForMainSceneReady]);

  const loadCloudWorldWithRetry = useCallback(async (userId: string) => {
    const maxAttempts = 8;
    let lastWorld: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const world = await Backend.forceLoadFromCloud(userId);
        lastWorld = world;
        if (world && Array.isArray(world.buildings) && world.buildings.length > 0) {
          return world;
        }
      } catch (error) {
        console.warn('Cloud world load attempt failed', { attempt, error });
      }
      if (attempt < maxAttempts) {
        await wait(240 * attempt);
      }
    }
    return lastWorld;
  }, [wait]);

  useEffect(() => {
    return () => {
      clearCloudTimers();
    };
  }, [clearCloudTimers]);

  // Load World & Resources once user is known
  useEffect(() => {
    if (!authReady) return;

    if (!userId || !isOnline) {
      setWorldReady(false);
      clearCloudTimers();
      setLoading(false);
      setCloudOverlayLoading(false);
      setShowCloudOverlay(false);
      setCloudOpening(false);
      return;
    }

    const init = async () => {
      let loaded = false;
      try {
        setWorldReady(false);
        setLoading(true);
        beginVillageLoadCloud(8);

        // Hydrate from a known-good cached snapshot first (primed by auth/session when available).
        const cachedWorld = Backend.getCachedWorld(userId);
        updateVillageLoadCloud(24);
        let world = hasRenderableWorldPayload(cachedWorld)
          ? cachedWorld
          : (isOnline ? await loadCloudWorldWithRetry(userId) : cachedWorld);

        if (!world && hasRenderableWorldPayload(cachedWorld)) {
          world = cachedWorld;
        }

        if (!world || !Array.isArray(world.buildings)) {
          console.error('Failed to load a valid world payload from cloud. Aborting init to avoid destructive fallback.');
          return;
        }

        if (world.buildings.length === 0) {
          console.error('Cloud world is empty. Refusing automatic bootstrap/default creation to avoid overwrite.');
          return;
        }

        // Session/world reads already materialize elapsed production on the
        // server. A second calculateOfflineProduction request repeated that
        // same authority read and held the first village reveal open.
        updateVillageLoadCloud(58);
        if (!world) {
          console.error('Failed to initialize base.');
          return;
        }

        updateVillageLoadCloud(72);
        setResources({
          gold: Math.max(0, world.resources.gold),
          ore: Math.max(0, world.resources.ore ?? 0),
          food: Math.max(0, world.resources.food ?? 0)
        });
        if (world.population) {
          setPopulation({
            count: Math.max(0, world.population.count),
            capacity: Math.max(0, world.population.capacity),
            workersNeeded: Math.max(0, world.population.workersNeeded ?? 0),
            staffing: Math.min(1, Math.max(0, world.population.staffing ?? 1))
          });
        }

        // Load Army from storage and sync capacity
        if (world.army) {
          setArmy(prev => ({ ...prev, ...world.army }));

          // Calculate capacity.current from loaded army
          const totalSpace = Object.entries(world.army).reduce((sum, [type, count]) => {
            const def = TROOP_DEFINITIONS[type as keyof typeof TROOP_DEFINITIONS];
            return sum + (def ? def.space * (count as number) : 0);
          }, 0);
          setCapacity(prev => ({ ...prev, current: totalSpace }));
        }

        // Force scene to update username now that we have user and world
        updateVillageLoadCloud(88);
        const scene = gameRef.current?.scene.getScene('MainScene') as any;
        if (scene && scene.updateUsername) {
          scene.updateUsername(userRef.current?.username ?? '');
        }

        // IMPORTANT: Trigger Phaser to reload the base using the now-known userId.
        // Retry to avoid races where scene commands are not ready yet.
        let sceneLoaded = await ensureSceneBaseLoaded();
        if (!sceneLoaded) {
          console.warn('Scene base load did not confirm success after retries. Forcing one hard refresh path.');
          Backend.clearCacheForUser(userId);
          await loadCloudWorldWithRetry(userId);
          sceneLoaded = await ensureSceneBaseLoaded();
        }
        if (!sceneLoaded) {
          console.warn('Scene base load failed after hard refresh retry.');
          setWorldReady(false);
        }
        updateVillageLoadCloud(98);
        loaded = sceneLoaded;
        setWorldReady(sceneLoaded);

      } catch (error) {
        console.error('Error initializing game:', error);
        setWorldReady(false);
      } finally {
        setLoading(false);
        if (!loaded) {
          setCloudLoadingProgress(100);
        }
        revealVillageFromCloud();
      }
    };

    init();
  }, [authReady, userId, isOnline, beginVillageLoadCloud, updateVillageLoadCloud, revealVillageFromCloud, clearCloudTimers, ensureSceneBaseLoaded, loadCloudWorldWithRetry]);

  // A loaded village is not playable until it owns complete, explicit
  // heraldry. Missing and legacy partial banners both enter the same blocking
  // picker; complete banners remain editable later from the town hall.
  useEffect(() => {
    if (!userId || !worldReady) {
      setIsBannerRequired(false);
      return;
    }
    const requiresBanner = !sanitizeVillageBanner(Backend.getCachedWorld(userId)?.banner);
    setIsBannerRequired(requiresBanner);
    if (requiresBanner) setIsBannerPickerOpen(true);
  }, [userId, worldReady]);

  // Persist resources & army
  useEffect(() => {
    if (user && !loading && worldReady) {
      try {
        const userId = user.id || 'default_player';
        Backend.updateResources(userId, resources.gold);
        // During an attack the cached own-world army is the server reservation
        // (usually {}). The visible battle roster is deliberately pinned out
        // of band and must never be written back over that authority snapshot.
        if (!gameManager.hasPinnedAttackArmy()) Backend.updateArmy(userId, army);
      } catch (error) {
        console.error('Error saving game state:', error);
      }
    }
  }, [resources, army, user, loading, worldReady]);

  const [capacity, setCapacity] = useState({ current: 0, max: 30 });
  const [selectedTroopType, setSelectedTroopType] = useState<PlayerTroopType>('warrior');
  const [visibleTroops, setVisibleTroops] = useState<string[]>([]);
  const [isTrainingOpen, setIsTrainingOpen] = useState(false);
  const [isBuildingOpen, setIsBuildingOpen] = useState(false);
  const [view, setView] = useState<GameMode>('HOME');
  const [selectedInMap, setSelectedInMap] = useState<string | null>(null);
  const [selectedBuildingInfo, setSelectedBuildingInfo] = useState<{ id: string; type: BuildingType; level: number; gridX?: number; gridY?: number; upgradeEndsAt?: number } | null>(null);
  const [showAtlas, setShowAtlas] = useState(false);
  const [showTheatre, setShowTheatre] = useState(false);
  const [battleStats, setBattleStats] = useState({ destruction: 0, goldLooted: 0, oreLooted: 0, foodLooted: 0 });
  const [battleStarted, setBattleStarted] = useState(false); // Track if first troop deployed
  const [isExiting, setIsExiting] = useState(false);
  const [buildingCounts, setBuildingCounts] = useState<Record<BuildingType, number>>({} as Record<BuildingType, number>);
  const [shopWallLevel, setShopWallLevel] = useState(1);
  const [troopLevel, setTroopLevel] = useState(1);
  const [barracksLevels, setBarracksLevels] = useState<FactionBarracksLevels>(emptyFactionBarracksLevels);
  // Per path: a present barracks under upgrade cannot train, while unrelated
  // faction trees remain independently available.
  const [barracksUpgrading, setBarracksUpgrading] = useState<Record<TroopFaction, boolean>>(emptyFactionUpgradeState);
  // Core troop access follows the highest completed Army Camp. A camp under
  // upgrade is offline until the server finishes the shared upgrade clock.
  const [armyCampProgress, setArmyCampProgress] = useState<ArmyCampUnlockProgress>(EMPTY_ARMY_CAMP_PROGRESS);
  // True while a lab upgrade is running: the server treats troops as level 1
  // for the duration, so the UI must show that (with an upgrading hint).
  const [troopLevelUpgrading, setTroopLevelUpgrading] = useState(false);
  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const [scoutTarget, setScoutTarget] = useState<{ userId: string; username: string } | null>(null);
  const [incomingAttack, setIncomingAttack] = useState<IncomingAttackSession | null>(null);
  const [dismissedIncomingAttackId, setDismissedIncomingAttackId] = useState<string | null>(null);
  const [activeReplay, setActiveReplay] = useState<{ attackId: string; attackerName: string; live: boolean } | null>(null);
  const selectedInMapRef = useRef<string | null>(null);
  const armyRef = useRef(army);
  const selectedTroopTypeRef = useRef(selectedTroopType);
  const populationRef = useRef(population);
  useEffect(() => {
    populationRef.current = population;
  }, [population]);

  // ONE adoption gate for every server-authoritative world state (session
  // load, save responses, settlements, trades, polls). Revision-ordered so an
  // older snapshot can never clobber a newer one.
  const lastAdoptedRevRef = useRef(0);
  useEffect(() => {
    lastAdoptedRevRef.current = 0;
  }, [userId]);
  const storageCapsRef = useRef<{ ore: number; food: number } | null>(null);
  const adoptWorld = useCallback((world: SerializedWorld | null | undefined) => {
    if (!world) return;
    const rev = Number(world.revision ?? 0);
    if ((rev === 0 && lastAdoptedRevRef.current > 0) || (rev !== 0 && rev < lastAdoptedRevRef.current)) return;
    if (rev > 0) lastAdoptedRevRef.current = rev;
    storageCapsRef.current = world.storage
      ? { ore: world.storage.ore, food: world.storage.food }
      : resourceCapacity(world.buildings ?? []);
    if (world.resources) {
      setResources(prev => ({
        gold: Math.max(0, Math.floor(world.resources.gold ?? prev.gold)),
        ore: Math.max(0, Math.floor(world.resources.ore ?? prev.ore)),
        food: Math.max(0, Math.floor(world.resources.food ?? prev.food))
      }));
    }
    if (world.population) {
      setPopulation({
        count: Math.max(0, world.population.count),
        capacity: Math.max(0, world.population.capacity),
        workersNeeded: Math.max(0, world.population.workersNeeded ?? 0),
        staffing: Math.min(1, Math.max(0, world.population.staffing ?? 1))
      });
      gameManager.syncPopulation(world.population.count);
    }
    // Attack start atomically moves the home army into a reservation, so the
    // next own-world heartbeat correctly advertises army={}. Keep adopting
    // every other authority field, but do not let that HOME response erase
    // the reserved roster while focus/assets are still loading (or in battle).
    if (world.army && !gameManager.hasPinnedAttackArmy()) {
      const serverArmy = world.army;
      const nextArmy = playerArmySnapshot(serverArmy);
      armyRef.current = nextArmy;
      setArmy(nextArmy);
      const totalSpace = armySpaceUsed(nextArmy);
      setCapacity(prev => ({ ...prev, current: totalSpace }));
    }
  }, []);

  // ---- predictive HUD counters ----
  // The displayed balances tick forward between authoritative syncs using the
  // SAME production math the server runs (shared Economy code): base value +
  // staffed rate x elapsed, ore/food production capped by storage. Every server response
  // re-anchors the base, so the counter is honest to the second.
  const resourcesSyncedAtRef = useRef(Date.now());
  useEffect(() => {
    resourcesRef.current = resources;
    resourcesSyncedAtRef.current = Date.now();
  }, [resources]);
  useEffect(() => {
    const tick = () => {
      const base = resourcesRef.current;
      const world = userId ? Backend.getCachedWorld(userId) : null;
      if (!world || !isOnline) {
        setDisplayResources(prev => (
          prev.gold === base.gold && prev.ore === base.ore && prev.food === base.food ? prev : { ...base }
        ));
        return;
      }
      const rates = productionRatesPerSecond(world.buildings);
      const staffing = Math.min(1, Math.max(0, populationRef.current.staffing ?? 1));
      const elapsed = Math.max(0, (Date.now() - resourcesSyncedAtRef.current) / 1000);
      const caps = storageCapsRef.current;
      const predictStored = (stored: number, rate: number, capacity: number) => (
        stored >= capacity ? stored : Math.min(capacity, Math.floor(stored + rate * staffing * elapsed))
      );
      const next = {
        gold: Math.floor(base.gold + rates.gold * elapsed),
        ore: predictStored(base.ore, rates.ore, caps?.ore ?? Number.MAX_SAFE_INTEGER),
        food: predictStored(base.food, rates.food, caps?.food ?? Number.MAX_SAFE_INTEGER)
      };
      setDisplayResources(prev => (
        prev.gold === next.gold && prev.ore === next.ore && prev.food === next.food ? prev : next
      ));
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [userId, isOnline]);

  // Read through a ref so dismissing a popup doesn't tear down and restart the
  // polling interval (which also fired an extra immediate request each time).
  const dismissedIncomingAttackRef = useRef<string | null>(null);
  useEffect(() => {
    dismissedIncomingAttackRef.current = dismissedIncomingAttackId;
  }, [dismissedIncomingAttackId]);

  // A dead session (401 anywhere) announces itself exactly once.
  useEffect(() => {
    const onExpired = () => {
      // Stop the writable-looking game immediately. Keeping an expired token
      // alive lets optimistic layout edits accumulate even though none can save.
      setSessionExpired(true);
      setInfiniteResources(false);
      setTestMode(false);
      setWorldReady(false);
      setShowCloudOverlay(false);
      setPlotPanel(null);
      setIsTrainingOpen(false);
      setIsBuildingOpen(false);
      // EVERY modal closes: an open surface would sit above (or keep polling
      // under) the lockout — the atlas alone re-hits the dead session every 5s.
      setShowAtlas(false);
      setShowTheatre(false);
      setIsAccountOpen(false);
      setIsJukeboxOpen(false);
      setIsBannerPickerOpen(false);
      setMerchantOffers(null);
      setIsDebugOpen(false);
      setIncomingAttack(null);
      setSelectedInMap(null);
      setSelectedBuildingInfo(null);
      showToast('Session expired — reconnect before making more changes.');
      void Auth.logout().finally(() => {
        Backend.clearAllCaches();
        setUser(null);
        setIsOnline(false);
      });
    };
    window.addEventListener('clash:session-expired', onExpired);
    return () => window.removeEventListener('clash:session-expired', onExpired);
  }, [showToast]);

  useEffect(() => {
    const onActiveElsewhere = () => {
      showToast('A raid is still active on another tab or device. Starting a new raid will take it over.');
    };
    window.addEventListener('clash:active-battle-elsewhere', onActiveElsewhere);
    return () => window.removeEventListener('clash:active-battle-elsewhere', onActiveElsewhere);
  }, [showToast]);

  // A rejected save (the server refused the bill) reverts balances AND
  // reloads the scene from the reverted truth; ordinary syncs re-anchor
  // the predictive counters through the same adoption gate.
  useEffect(() => {
    const onSynced = (event: Event) => {
      adoptWorld((event as CustomEvent<{ world?: SerializedWorld }>).detail?.world);
    };
    const onRejected = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string; world?: SerializedWorld }>).detail;
      adoptWorld(detail?.world);
      void gameManager.loadBase().catch(() => undefined);
      showToast(`${detail?.message ?? 'Not enough resources'} — changes reverted.`);
    };
    const onTrophies = (event: Event) => {
      const trophies = Number((event as CustomEvent<{ trophies?: number }>).detail?.trophies);
      if (!Number.isFinite(trophies)) return;
      setUser(prev => prev ? { ...prev, trophies: Math.max(0, Math.floor(trophies)) } : prev);
    };
    const onArmySyncFailed = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      showToast(`${message ?? 'Army update failed'} — camp restored from the server.`);
    };
    window.addEventListener('clash:world-synced', onSynced);
    window.addEventListener('clash:save-rejected', onRejected);
    window.addEventListener('clash:trophies-synced', onTrophies);
    window.addEventListener('clash:army-sync-failed', onArmySyncFailed);
    return () => {
      window.removeEventListener('clash:world-synced', onSynced);
      window.removeEventListener('clash:save-rejected', onRejected);
      window.removeEventListener('clash:trophies-synced', onTrophies);
      window.removeEventListener('clash:army-sync-failed', onArmySyncFailed);
    };
  }, [adoptWorld, showToast]);

  // One lightweight home heartbeat replaces the former independent incoming
  // attack (2.5s) and full-world (45s) polls. The summary endpoint tells us
  // when a heavier world read is actually necessary, and hidden tabs make no
  // requests until they become visible again.
  useEffect(() => {
    if (!userId || !isOnline || view !== 'HOME') {
      setIncomingAttack(null);
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const refreshHome = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const sync = await Backend.fetchHomeSync();
        if (cancelled || !sync) return;

        const features = Auth.getFeatures();
        setInfiniteResources(features.infiniteResources);
        setTestMode(features.testMode);
        gameManager.syncHomeStatus(sync.serverNow, sync.shieldUntil);

        const latest: IncomingAttackSession | null = sync.incomingAttack
          ? { ...sync.incomingAttack, victimId: userId }
          : null;
        // Even a dismissed popup keeps the villagers hiding — the raid is still live.
        // The heartbeat is the ONE siege detector and drives the in-scene banner.
        gameManager.setUnderAttack(Boolean(latest), latest?.attackId ?? null);
        if (!latest) {
          setIncomingAttack(null);
          setDismissedIncomingAttackId(null);
        } else if (latest.attackId === dismissedIncomingAttackRef.current) {
          setIncomingAttack(null);
        } else {
          setIncomingAttack(latest);
        }

        const cached = Backend.getCachedWorld(userId);
        const localRevision = Math.max(
          lastAdoptedRevRef.current,
          Number(cached?.revision ?? 0) || 0
        );
        const localLastSaveTime = Number(cached?.lastSaveTime ?? 0) || 0;
        const remoteRevision = Number(sync.world.revision ?? 0) || 0;
        const remoteLastSaveTime = Number(sync.world.lastSaveTime ?? 0) || 0;
        const worldIsStale = remoteRevision > localRevision
          || remoteLastSaveTime > localLastSaveTime;

        if (
          worldIsStale
          && !Backend.hasPendingSave(userId)
          && !Backend.hasPendingArmy(userId)
        ) {
          const world = await Backend.fetchWorldSnapshot();
          if (!cancelled && world) adoptWorld(world);
        }
      } catch (error) {
        if (!cancelled) console.warn('Failed to synchronize home status:', error);
      } finally {
        inFlight = false;
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden) void refreshHome();
    };

    void refreshHome();
    const interval = window.setInterval(() => void refreshHome(), 12_000);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [userId, isOnline, view, adoptWorld]);

  useEffect(() => {
    selectedInMapRef.current = selectedInMap;
    armyRef.current = army;
    selectedTroopTypeRef.current = selectedTroopType;
    resourcesRef.current = resources;
  }, [selectedInMap, army, selectedTroopType, resources]);

  const handleRenameAccount = async (name: string) => {
    await Backend.flushAllPending();
    const renamed = await Auth.rename(name);
    if (userId) await Backend.forceLoadFromCloud(userId);
    setUser(prev => (prev ? { ...prev, username: renamed.username } : prev));
    const scene = gameRef.current?.scene.getScene('MainScene') as { updateUsername?: (name: string) => void } | null;
    scene?.updateUsername?.(renamed.username);
  };

  const handleRegisterAccount = async (username: string, password: string) => {
    await Backend.flushAllPending();
    const player = await Auth.register(username, password);
    if (userId) await Backend.forceLoadFromCloud(userId);
    setUser(prev => (prev ? { ...prev, username: player.username, registered: true } : prev));
    const scene = gameRef.current?.scene.getScene('MainScene') as { updateUsername?: (name: string) => void } | null;
    scene?.updateUsername?.(player.username);
  };

  // Login/logout swap the whole identity, so the cleanest correct path is a full
  // reload: flush pending saves, switch the stored session, boot fresh.
  const handleLoginAccount = async (username: string, password: string) => {
    // Do not abandon unsaved edits just because the account switch was
    // requested; a failed flush leaves the current session fully intact.
    await Backend.flushAllPending();
    await Auth.login(username, password);
    Backend.clearAllCaches();
    window.location.reload();
  };

  const handleLogoutAccount = async () => {
    await Backend.flushAllPending().catch(() => undefined);
    await Auth.logout();
    Backend.clearAllCaches();
    window.location.reload();
  };

  // Account-gate success (required registration wall): this device had NO
  // identity and no booted game, so the fresh session is adopted in place —
  // the exact states the initial ensureUser path sets, which lets the normal
  // world-load and game-boot effects take over from here.
  const adoptGateSession = useCallback((authUser: AuthUser, world: SerializedWorld | null) => {
    if (hasRenderableWorldPayload(world)) {
      Backend.primeWorldCache(authUser.id, world);
    }
    // A logged-into account can have a raid interrupted on another device.
    void Backend.reconcileInterruptedBattle().catch(error => {
      console.warn('Interrupted battle reconciliation is still pending:', error);
    });
    setNeedsAccount(false);
    const features = Auth.getFeatures();
    setInfiniteResources(features.infiniteResources);
    setTestMode(features.testMode);
    setUser({
      id: authUser.id,
      username: authUser.username,
      trophies: authUser.trophies ?? 0,
      registered: Boolean(authUser.registered),
      lastLogin: Date.now()
    });
    setIsOnline(true);
  }, []);

  const handleGateLogin = useCallback(async (username: string, password: string) => {
    const session = await Auth.login(username, password);
    adoptGateSession(session.player, session.world ?? null);
  }, [adoptGateSession]);

  const handleGateCreate = useCallback(async (username: string, password: string) => {
    const { user: created, world } = await Auth.createAccount(username, password);
    adoptGateSession(created, world);
  }, [adoptGateSession]);

  const handleReseedWorld = async () => {
    await Backend.flushAllPending();
    const result = await Auth.reseedWorld();
    Backend.clearAllCaches();
    // Leave the success notice visible briefly, then rebuild every world-map
    // cache from the server's newly seeded authoritative state.
    window.setTimeout(() => window.location.reload(), 1_200);
    return result;
  };

  const handleRetryConnection = () => {
    window.location.reload();
  };

  useEffect(() => {
    // Ensure game is destroyed to clean up state
    if (!userId || !isOnline) {
      gameManager.clearUI();
      displayResolutionCleanupRef.current?.();
      displayResolutionCleanupRef.current = null;
      if (gameRef.current) {
        try {
          gameRef.current.destroy(true);
        } catch (error) {
          console.error('Error destroying game:', error);
        }
        gameRef.current = null;
      }
      return;
    }

    // If game already running, don't recreate
    if (gameRef.current) return;

    // Start new game instance
    try {
      // Ensure game container exists
      const container = document.getElementById('game-container');
      if (!container) {
        console.error('Game container not found!');
        return;
      }
      const game = new Phaser.Game(createGameConfig(container));
      gameRef.current = game;
      displayResolutionCleanupRef.current = installDisplayResolution(game, container, {
        isMobile: MobileUtils.isMobile()
      });
      // Debug/tooling handles (harmless in production; used by screenshot tests)
      (window as unknown as { __clashGame?: Phaser.Game }).__clashGame = gameRef.current;
      (window as unknown as { __clashGM?: typeof gameManager }).__clashGM = gameManager;
      console.log('Phaser game initialized successfully');
    } catch (error) {
      console.error('Error creating Phaser game:', error);
      return;
    }

    gameManager.registerUI({
      showCloudOverlay: () => {
        clearCloudTimers();
        setCloudOverlayLoading(false);
        setCloudLoadingProgress(0);
        setCloudOpening(false);
        setShowCloudOverlay(true);
      },
      hideCloudOverlay: () => {
        clearCloudTimers();
        setCloudOverlayLoading(false);
        setCloudOpening(true); // Start opening animation
        cloudHideTimerRef.current = window.setTimeout(() => {
          setShowCloudOverlay(false);
          setCloudOpening(false);
          // The clouds have parted on home. Release any confirmed raid payout
          // directly into the resource-chip count-up; there is intentionally
          // no separate end-of-battle results screen.
          const reward = cloudTransitionRewardRef.current;
          cloudTransitionRewardRef.current = null;
          setCloudTransitionReward(null);
          if (reward && reward > 0) {
            setLootAnimating({ amount: reward });
          }
        }, CLOUD_OPEN_TOTAL_MS + 40); // slowest cloud layer finishes at OPEN_MS × 1.2; hiding earlier strands a haze band on wide windows
      },
      setGameMode: (mode: GameMode) => {
        setView(mode);
        if (mode === 'HOME') {
          setScoutTarget(null);
          setActiveReplay(null);
          setBattleStarted(false);
          setIncomingAttack(null);
          setSelectedInMap(null);
          setSelectedBuildingInfo(null);
          // Practice is a sandbox: troops deployed in a drill come home.
          const drill = practiceArmyRef.current;
          if (drill) {
            practiceArmyRef.current = null;
            setArmy(drill.army);
            setCapacity(drill.capacity);
          }
        }
        if (mode === 'ATTACK') {
          setActiveReplay(null);
          setBattleStats({ destruction: 0, goldLooted: 0, oreLooted: 0, foodLooted: 0 });
          setBattleStarted(false); // Reset when entering attack mode

          // Auto-select first available troop
          const availableTroops = PLAYER_TROOP_TYPES;
          const currentArmy = gameManager.getArmy();
          const firstAvailable = availableTroops.find(type => currentArmy[type] > 0);
          if (firstAvailable) {
            setSelectedTroopType(firstAvailable);
          }
          // Snapshot troops for Battle Bar stability
          const battleTroops = availableTroops.filter(t => currentArmy[t] > 0);
          setVisibleTroops(battleTroops);
        }
        if (mode === 'REPLAY') {
          setScoutTarget(null);
          setVisibleTroops([]);
          setBattleStats({ destruction: 0, goldLooted: 0, oreLooted: 0, foodLooted: 0 });
          setBattleStarted(true);
        }
      },
      updateBattleStats: (destruction: number, gold: number, ore = 0, food = 0) => {
        // Fired per damage event during raids — bail out when nothing changed
        // so React doesn't re-render the whole HUD subtree on every hit.
        setBattleStats(prev => (
          prev.destruction === destruction && prev.goldLooted === gold && prev.oreLooted === ore && prev.foodLooted === food
            ? prev
            : { destruction, goldLooted: gold, oreLooted: ore, foodLooted: food }
        ));
      },
      onBuildingSelected: (data: { id: string; type: BuildingType; level: number; gridX?: number; gridY?: number } | null) => {
        // Handle legacy calls that might strictly pass a string ID (just in case) or the new object
        const id = data && typeof data === 'object' ? data.id : (typeof data === 'string' ? data : null);

        if (selectedInMapRef.current && id && selectedInMapRef.current !== id) {
          // Switching selection
          setIsExiting(true);
          setTimeout(() => {
            setSelectedInMap(id);
            if (data && typeof data === 'object') setSelectedBuildingInfo(data);
            setIsExiting(false);
          }, 200);
        } else if (selectedInMapRef.current && id === null) {
          // Deselecting - Animate out
          setIsExiting(true);
          setTimeout(() => {
            setSelectedInMap(null);
            setSelectedBuildingInfo(null);
            setIsExiting(false);
          }, 200);
        } else {
          // Selecting new (from nothing)
          setSelectedInMap(id);
          if (data && typeof data === 'object') setSelectedBuildingInfo(data);
          else if (id === null) setSelectedBuildingInfo(null);
          setIsExiting(false);
        }
      },
      onPlacementCancelled: () => {
        setSelectedInMap(null);
        setSelectedBuildingInfo(null);
      },
      onRaidEnded: async (goldLooted: number, applied?: { ore?: number; food?: number; settlementDelayed?: boolean }) => {
        const scene = gameRef.current?.scene.getScene('MainScene') as any;
        const enemyWorld = scene?.currentEnemyWorld;
        let lootWon = Math.max(0, goldLooted);

        if (enemyWorld && isOnline && !enemyWorld.isBot && enemyWorld.id !== 'practice' && enemyWorld.attackId) {
          // MainScene owns the one authoritative settlement request and passes
          // its applied payout here. Issuing /attacks/end again doubled finish
          // traffic and let a second network failure hide a successful payout.
        } else if (enemyWorld?.isBot) {
          // Bot raids settle server-side in MainScene (world-map camps pay on
          // a cooldown; practice drills pay nothing). The number arriving here
          // is already the settled loot — never grant it again.
          lootWon = Math.max(0, Math.floor(goldLooted));
        } else if (!isOnline) {
          // Offline sandbox: local-only credit.
          const delta = await applyGoldDeltaRef.current(goldLooted, 'battle_loot');
          if (!delta.applied) {
            lootWon = 0;
          }
        } else {
          lootWon = 0;
        }

        // Return home immediately. Confirmed loot animates beside the resource
        // icon after the clouds open; a transport-delayed settlement never
        // pretends that the payout was zero.
        if (applied?.settlementDelayed) {
          gameManager.showToast('Raid settlement is still pending — your loot will appear when it is banked.');
        }
        // The loot chime queues behind the victory/defeat jingle that MainScene
        // just started (MusicSystem chains stingers) — confirmed loot only.
        if (!applied?.settlementDelayed && lootWon > 0) musicSystem.stinger('loot');
        transitionHome(applied?.settlementDelayed ? 0 : lootWon);
      },
      onRetreatEnded: (results) => {
        // goHome is already running behind the clouds. Feed confirmed partial
        // loot into the same resource-chip animation used by natural endings.
        if (results.settlementDelayed) {
          cloudTransitionRewardRef.current = null;
          setCloudTransitionReward(null);
          gameManager.showToast('Raid settlement is still pending — your loot will appear when it is banked.');
        } else if (results.goldLooted > 0) {
          const reward = Math.floor(results.goldLooted);
          // The cloud-open callback runs from a timer, so write the mirror
          // synchronously as well as state; it must never observe the zero
          // reward that started a retreat transition.
          cloudTransitionRewardRef.current = reward;
          setCloudTransitionReward(reward);
        }
      },
      onAttackArmyPinned: (reservedArmy: Record<string, number>) => {
        // This callback runs in the same stack as the attack-start response,
        // before MainScene awaits focus or sprite assets. Update the ref first:
        // getArmy() and ATTACK-mode setup must never wait for a React commit.
        const pinned = playerArmySnapshot(reservedArmy);
        armyRef.current = pinned;
        setArmy(pinned);
        setCapacity(prev => ({ ...prev, current: armySpaceUsed(pinned) }));
      },
      onAttackArmyReleased: () => {
        // Settlement updates Backend's cache while the pin intentionally
        // shields React from army={}. Adopt that cached home truth now that
        // the reservation is closed, before the ordinary home reload lands.
        const authorityArmy = userId ? Backend.getCachedWorld(userId)?.army : null;
        if (!authorityArmy) return;
        const restored = playerArmySnapshot(authorityArmy);
        armyRef.current = restored;
        setArmy(restored);
        setCapacity(prev => ({ ...prev, current: armySpaceUsed(restored) }));
      },
      getArmy: () => armyRef.current,
      getResources: () => resourcesRef.current,
      getSelectedTroopType: () => selectedTroopTypeRef.current,
      deployTroop: (type: string, pinnedArmy?: Record<string, number>) => {
        const def = TROOP_DEFINITIONS[type as TroopType];
        if (!def) return;
        setBattleStarted(true); // Battle has started!
        setCapacity(prev => ({ ...prev, current: Math.max(0, prev.current - def.space) }));
        if (pinnedArmy) {
          // GameManager decremented its synchronous reservation first; mirror
          // that exact snapshot instead of racing a functional state update.
          const next = playerArmySnapshot(pinnedArmy);
          armyRef.current = next;
          setArmy(next);
        } else {
          setArmy(prev => ({
            ...prev,
            [type]: Math.max(0, (prev[type as keyof typeof prev] ?? 0) - 1)
          }));
        }
      },
      refreshCampCapacity: (campLevels: number[]) => {
        const totalCapacity = 30 + campLevels.reduce((sum, level) => sum + campHousingAtLevel(level), 0);
        setCapacity(prev => ({ ...prev, max: Math.min(150, totalCapacity) }));
      },
      closeMenus: () => {
        setIsTrainingOpen(false);
        setIsBuildingOpen(false);
        setSelectedInMap(null);
        setSelectedBuildingInfo(null);
      },
      openJukebox: () => {
        // One surface at a time: the track list replaces the building panel.
        // The open chime lives here (not on the TRACKS button) because the
        // scene can open the jukebox directly too — one sound, every path.
        soundSystem.play('uiOpen');
        setSelectedBuildingInfo(null);
        setIsJukeboxOpen(true);
      },
      openBannerPicker: () => {
        // Same discipline: the banner picker replaces the building panel.
        soundSystem.play('uiOpen');
        setSelectedBuildingInfo(null);
        setIsBannerPickerOpen(true);
      },
      openMerchant: (offers: MerchantOffer[]) => {
        soundSystem.play('uiOpen');
        setMerchantOffers(offers);
      },
      openPlotPanel: (info: PlotPanelInfo) => {
        soundSystem.play('uiOpen');
        setPlotPanel(info);
      },
      closePlotPanel: () => {
        setPlotPanel(null);
      },
      requestScoutOnUser: (targetUserId: string, username: string) => {
        setIsTrainingOpen(false);
        setIsBuildingOpen(false);
        setPlotPanel(null);
        setScoutTarget({ userId: targetUserId, username });
        setActiveReplay(null);
        gameManager.startScoutOnUser(targetUserId, username);
      },
      requestWatchLiveAttack: (attackId: string, attackerName: string) => {
        if (!attackId) return;
        setPlotPanel(null);
        setDismissedIncomingAttackId(attackId);
        setIncomingAttack(null);
        setActiveReplay({ attackId, attackerName, live: true });
        gameManager.watchLiveAttack(attackId);
      },
      showToast: (message: string) => {
        showToast(message);
      },
      collectResource: (kind: 'ore' | 'food', amount: number) => {
        // Optimistic bump; the server clamps to storage capacity and the
        // cached world reconciles us right after.
        setResources(prev => ({ ...prev, [kind]: Math.max(0, prev[kind] + amount) }));
        const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        void Backend.applyResourceDelta(userId ?? 'default_player', amount, kind === 'food' ? 'egg_collect' : 'rock_haul', undefined, requestId, kind)
          .then(() => {
            const cached = Backend.getCachedWorld(userId ?? 'default_player');
            if (cached) {
              setResources(prev => ({
                ...prev,
                ore: Math.max(0, cached.resources.ore ?? prev.ore),
                food: Math.max(0, cached.resources.food ?? prev.food)
              }));
            }
          })
          .catch(error => console.warn('Resource collect sync failed:', error));
      }
    });

    // 'M' moves the selected building; the other keys drive visual debug tools.
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      const key = e.key.toLowerCase();
      if (e.repeat) return;

      // Debug tools are dev-only: players typing d/n/p must not summon
      // dragons, jump the clock or open the debug menu in production.
      if (import.meta.env.DEV) {
        if (key === 'd') {
          // Summon the dragon's shadow for a flyover.
          gameManager.summonDragon();
          return;
        }
        if (key === 'p') {
          setIsDebugOpen(prev => !prev);
          return;
        }
        if (key === 'n') {
          // Debug: step the day/night cycle to its next phase.
          gameManager.advanceDayNight();
          return;
        }
      }
      // The ONE move-building hotkey path (MainScene no longer binds its own
      // M handler with divergent side effects).
      if (key === 'm' && selectedInMapRef.current) {
        gameManager.moveSelectedBuilding();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      // Drop the UI handlers registered above so no stale closures survive
      // between this teardown and a potential re-register.
      gameManager.clearUI();
      displayResolutionCleanupRef.current?.();
      displayResolutionCleanupRef.current = null;
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }
    };
  }, [userId, isOnline, clearCloudTimers]);


  const refreshBuildingCounts = useCallback(async () => {
    if (!user) return;
    try {
      const counts = await Backend.getBuildingCounts(user.id || 'default_player');
      setBuildingCounts(counts);
    } catch (error) {
      console.error('Error refreshing building counts:', error);
    }
  }, [user]);

  useEffect(() => {
    if (isBuildingOpen && user) {
      refreshBuildingCounts();
    }
  }, [isBuildingOpen, user]);

  // Derive barracks level and troop level (from lab) when training modal opens
  useEffect(() => {
    if (!isTrainingOpen || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const world = await Backend.getWorld(user.id || 'default_player');
        if (!world || cancelled) return;
        // Mirror the server's faction-specific gate exactly. Each path reads
        // only its matching completed barracks; another path may upgrade or
        // remain absent without locking this one.
        const trainableBarracksLevels = factionBarracksLevels(world.buildings);
        const upgradingByFaction = Object.fromEntries(TROOP_FACTIONS.map(faction => {
          const matching = world.buildings.filter((b: any) => b.type === FACTION_BARRACKS[faction]);
          return [faction, trainableBarracksLevels[faction] === 0 && matching.some((b: any) => Boolean(b.upgradingTo))];
        })) as Record<TroopFaction, boolean>;
        const campProgress = armyCampUnlockProgress(world.buildings);
        if (!cancelled) {
          setBarracksLevels(trainableBarracksLevels);
          setBarracksUpgrading(upgradingByFaction);
          setArmyCampProgress(campProgress);
          // Server-effective level (shared rule): a lab mid-upgrade is offline
          // and troops read as level 1 until the work lands.
          setTroopLevel(effectiveTroopLevel(world.buildings));
          setTroopLevelUpgrading(labUpgradeInFlight(world.buildings));
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [isTrainingOpen, user]);

  useEffect(() => {
    let cancelled = false;

    const loadShopWallLevel = async () => {
      if (!isBuildingOpen || !user) return;
      try {
        const world = await Backend.getWorld(user.id || 'default_player');
        if (!world || cancelled) return;
        const walls = world.buildings.filter((w: any) => w.type === 'wall');
        const maxPlacedLevel = walls.length > 0 ? Math.max(...walls.map((w: any) => w.level || 1)) : 1;
        const storedWallLevel = Number((world as any).wallLevel ?? 0);
        const level = Number.isFinite(storedWallLevel) && storedWallLevel > 0
          ? Math.max(maxPlacedLevel, Math.floor(storedWallLevel))
          : maxPlacedLevel;
        if (!cancelled) setShopWallLevel(level);
      } catch (error) {
        console.error('Error checking wall level:', error);
      }
    };

    loadShopWallLevel();
    return () => {
      cancelled = true;
    };
  }, [isBuildingOpen, user]);

  useEffect(() => {
    if (!user) return;

    gameManager.registerUI({
      onBuildingPlaced: async (type: string, isFree: boolean = false) => {
        if (isFree) {
          refreshBuildingCounts();
          return;
        }
        const def = (BUILDING_DEFINITIONS as any)[type];
        if (def) {
          let placementLevel = 1;
          if (type === 'wall') {
            try {
              const world = await Backend.getWorld(user.id || 'default_player');
              if (world) {
                const walls = world.buildings.filter((b: any) => b.type === 'wall');
                const maxPlacedLevel = walls.length > 0 ? Math.max(...walls.map((w: any) => w.level || 1)) : 1;
                const storedWallLevel = Number((world as any).wallLevel ?? 0);
                const wallLevel = Number.isFinite(storedWallLevel) && storedWallLevel > 0
                  ? Math.max(maxPlacedLevel, Math.floor(storedWallLevel))
                  : maxPlacedLevel;
                placementLevel = wallLevel;
              }
            } catch (error) {
              console.error('Error calculating wall cost:', error);
            }
          }
          const charge = placementCharge(type as BuildingType, placementLevel);
          // Optimistic display only: the debounced save is the actual purchase
          // (the server prices the layout diff), and a rejected save reverts
          // everything through clash:save-rejected.
          if (!infiniteResources) {
            setResources(prev => ({
              ...prev,
              gold: Math.max(0, prev.gold - charge.gold),
              ore: Math.max(0, prev.ore - charge.ore)
            }));
          }
        }
        refreshBuildingCounts();
      }
    });
  }, [user, refreshBuildingCounts, infiniteResources]);

  const handleSelect = (type: string) => {
    gameManager.selectBuilding(type);
    // Close the modal after selection
    setIsBuildingOpen(false);
  };

  const handleTrainTroop = (type: string) => {
    const def = TROOP_DEFINITIONS[type as keyof typeof TROOP_DEFINITIONS];
    if (!def) return;
    const cost = def.cost;
    const space = def.space;

    const foodCost = troopFoodCostOf(type as TroopType);
    // Pixel toasts, never alert(): a native dialog freezes the game loop and
    // breaks the aesthetic.
    if (spendableResources.gold < cost) {
      showToast('Not enough gold!');
      return;
    }
    if (spendableResources.food < foodCost) {
      showToast('Not enough food! Harvest the farm, collect eggs or trade for more.');
      return;
    }
    if (capacity.current + space > capacity.max) {
      showToast('Not enough housing space! Build more Army Camps!');
      return;
    }

    // Optimistic: the tile fills instantly; the server (which owns the army,
    // checks the barracks unlock, housing and the bill) reconciles right after.
    if (!infiniteResources) {
      setResources(prev => ({
        ...prev,
        gold: Math.max(0, prev.gold - cost),
        food: Math.max(0, prev.food - foodCost)
      }));
    }
    setArmy(prev => {
      const key = type as keyof typeof prev;
      return { ...prev, [key]: (prev[key] ?? 0) + 1 };
    });
    setCapacity(prev => ({ ...prev, current: prev.current + space }));

    if (!isOnline) return;
    if (!Backend.queueArmyOperation('train', type, 1)) {
      showToast('Training could not be queued. Reconnect and try again.');
    }
  };

  const handleUntrainTroop = (type: string) => {
    if (army[type as keyof typeof army] <= 0) return;
    const def = TROOP_DEFINITIONS[type as keyof typeof TROOP_DEFINITIONS];
    if (!def) return;
    const cost = def.cost;
    const space = def.space;

    // Optimistic dismissal; the server refunds the full training bill.
    // The food half of the refund is capped by storage server-side
    // (storedResourceAfterDelta): mirror the cap here and SAY what was lost —
    // dismissal itself is never blocked (stranding troops would be worse).
    const foodRefund = troopFoodCostOf(type as TroopType);
    const foodCap = storageCapsRef.current?.food;
    const foodLost = !infiniteResources && typeof foodCap === 'number' && foodCap > 0
      ? Math.max(0, Math.min(foodRefund, Math.floor(Number(resourcesRef.current.food ?? 0)) + foodRefund - foodCap))
      : 0;
    const foodRefundApplied = foodRefund - foodLost;
    if (!infiniteResources) {
      if (foodLost > 0) showToast(`Storage full — ${foodLost} FOOD of the refund was lost.`);
      setResources(prev => ({ ...prev, gold: prev.gold + cost, food: prev.food + foodRefundApplied }));
    }
    setArmy(prev => {
      const key = type as keyof typeof prev;
      return { ...prev, [key]: (prev[key] ?? 0) - 1 };
    });
    setCapacity(prev => ({ ...prev, current: prev.current - space }));

    if (!isOnline) return;
    if (!Backend.queueArmyOperation('untrain', type, 1)) {
      showToast('Dismissal could not be queued. Reconnect and try again.');
    }
  };

  const transitionHome = useCallback((rewardAmount: number = 0) => {
    const scene = gameRef.current?.scene.getScene('MainScene') as any;
    // Every retreat — battles-in-place included — goes home behind the
    // clouds: end battle, clouds close, clouds open on the home village.
    const reward = rewardAmount > 0 ? Math.floor(rewardAmount) : null;
    cloudTransitionRewardRef.current = reward;
    setCloudTransitionReward(reward);
    if (scene) {
      scene.showCloudTransition(async () => {
        await scene.goHome();
        setView('HOME');
        setSelectedInMap(null);
        setScoutTarget(null);
      });
    } else {
      gameManager.releaseAttackArmy();
      cloudTransitionRewardRef.current = null;
      setCloudTransitionReward(null);
      if (reward) setLootAnimating({ amount: reward });
      setView('HOME');
      setSelectedInMap(null);
      setScoutTarget(null);
    }
  }, []);

  const handleExitReplay = useCallback(() => {
    transitionHome();
  }, [transitionHome]);



  const handleGoHome = () => {
    transitionHome();
  };

  const handleNextMap = () => {
    if (scoutTarget) return;
    gameManager.findNewMap();
  };

  const handleRaidNow = () => {
    if (capacity.current === 0) return;
    gameManager.startAttack();
  };

  // Drills cost nothing: snapshot the army going in, restore it coming home.
  const practiceArmyRef = useRef<{ army: typeof army; capacity: typeof capacity } | null>(null);

  const handleStartPractice = () => {
    if (capacity.current === 0) return;
    practiceArmyRef.current = { army: { ...army }, capacity: { ...capacity } };
    gameManager.startPracticeAttack();
    setIsTrainingOpen(false);
  };

  const handleFindMatch = () => {
    if (capacity.current === 0) return;
    if (isOnline) {
      gameManager.startOnlineAttack();
    } else {
      handleRaidNow();
    }
    setIsTrainingOpen(false);
  };

  const handleScoutUser = (userId: string, username: string) => {
    // Close any open modals
    setIsTrainingOpen(false);
    setScoutTarget({ userId, username });
    gameManager.startScoutOnUser(userId, username);
  };

  // World-map neighbour sheet: every attack path funnels through here, so an
  // empty army can never launch a raid — it opens the barracks instead.
  const handlePlotAction = (action: PlotPanelAction) => {
    setPlotPanel(null);
    if (action.kind === 'attack' && capacity.current === 0) {
      // Refusal path: the toast's notify chime carries the feedback.
      showToast('Train some troops first!');
      setIsTrainingOpen(true);
      return;
    }
    soundSystem.play(action.kind === 'attack' ? 'confirm' : 'uiTap');
    action.run();
  };

  const handleDirectUserAttack = (targetUserId: string, username: string) => {
    if (capacity.current === 0) {
      showToast('Train some troops first!');
      setIsTrainingOpen(true);
      return false;
    }
    // Confirm here (not on each button): scout ATTACK and REVENGE both land
    // on this gate, and a refused launch must not sound like a confirmed one.
    soundSystem.play('confirm');
    setScoutTarget(null);
    gameManager.startAttackOnUser(targetUserId, username);
    return true;
  };

  const handleAttackScouted = () => {
    if (!scoutTarget) return;
    handleDirectUserAttack(scoutTarget.userId, scoutTarget.username);
  };

  const handleWatchLiveAttack = useCallback((attackId: string, attackerName: string) => {
    if (!attackId) return;
    // One confirm for every React watch entry point (popup, bell, theatre).
    soundSystem.play('confirm');
    setDismissedIncomingAttackId(attackId);
    setIncomingAttack(null);
    setActiveReplay({ attackId, attackerName, live: true });
    gameManager.watchLiveAttack(attackId);
  }, []);

  const handleWatchReplay = useCallback((attackId: string, attackerName: string) => {
    if (!attackId) return;
    soundSystem.play('confirm');
    setActiveReplay({ attackId, attackerName, live: false });
    gameManager.watchReplay(attackId);
  }, []);

  const handleDeleteBuilding = () => {
    if (selectedInMap && selectedBuildingInfo) {
      if (selectedBuildingInfo.type === 'town_hall') return;
      if (campSaleBlocked) {
        showToast('Dismiss troops before selling this camp. Your army needs its housing.');
        return;
      }
      const deleted = gameManager.deleteSelectedBuilding();
      if (!deleted) return;
      // The scene's delete command already voices 'sell' — one coin-pour only.
      if (!infiniteResources) {
        // Optimistic display — the save's layout diff carries the real refund.
        const stats = getBuildingStats(selectedBuildingInfo.type, selectedBuildingInfo.level);
        const refund = Math.floor(stats.cost * 0.8);
        setResources(prev => ({ ...prev, gold: prev.gold + refund }));
      }
      setSelectedInMap(null);
      setSelectedBuildingInfo(null);
    }
  };

  const campSaleBlocked = (() => {
    if (selectedBuildingInfo?.type !== 'army_camp') return false;
    const world = userId ? Backend.getCachedWorld(userId) : null;
    if (!world) {
      const removedHousing = campHousingAtLevel(selectedBuildingInfo.level);
      return capacity.current > Math.max(30, capacity.max - removedHousing);
    }
    const remaining = world.buildings.filter(building => building.id !== selectedBuildingInfo.id);
    return armySpaceUsed(world.army ?? army) > campCapacityOf(remaining);
  })();

  const upgradeInProgressRef = useRef(false);

  const handleUpgradeBuilding = async () => {
    // Serialize upgrade requests, but don't wait for save round-trips.
    if (upgradeInProgressRef.current) return;
    if (selectedInMap && selectedBuildingInfo) {
      const def = BUILDING_DEFINITIONS[selectedBuildingInfo.type];
      const maxLevel = def.maxLevel || 1;

      if (selectedBuildingInfo.level < maxLevel) {
        upgradeInProgressRef.current = true;
        try {
          const nextLevelStats = getBuildingStats(selectedBuildingInfo.type, selectedBuildingInfo.level + 1);
          let upgradeCost = nextLevelStats.cost;

          // Wall Logic: Cost is multiplied by the number of walls being upgraded
          if (selectedBuildingInfo.type === 'wall') {
            try {
              const world = await Backend.getWorld(user?.id || 'default_player');
              if (world) {
                const count = world.buildings.filter((b: any) => b.type === 'wall' && (b.level || 1) === selectedBuildingInfo.level).length;
                upgradeCost = nextLevelStats.cost * count;
              }
            } catch (error) {
              console.error('Error calculating wall upgrade cost:', error);
            }
          }

          const upgradeOre = upgradeOreCostOf(upgradeCost);
          if (spendableResources.gold >= upgradeCost && spendableResources.ore >= upgradeOre) {
            // The upgrade is actually starting — hammer taps + rising ping.
            soundSystem.play('upgradeStart');
            // Optimistic display only. The save that follows IS the purchase:
            // the server prices the level diff and charges it; a rejection
            // reverts everything (scene + balances) via clash:save-rejected.
            if (!infiniteResources) {
              setResources(prev => ({
                ...prev,
                gold: Math.max(0, prev.gold - upgradeCost),
                ore: Math.max(0, prev.ore - upgradeOre)
              }));
            }

            // Start the save immediately (returns a promise).
            // upgradeBuilding updates the cache synchronously, then fires
            // saveWorldDirect which sends the fetch without queuing.
            const savePromise = Backend.upgradeBuilding(user?.id || 'default_player', selectedInMap);

            // Visual update happens instantly — don't wait for network
            const newLevel = gameManager.upgradeSelectedBuilding();
            if (newLevel) {
              setSelectedBuildingInfo(prev => prev ? { ...prev, level: newLevel } : null);
            }

            // The tap did its work — close the card and let the scaffold
            // (and its progress bubble) take over the storytelling.
            (gameRef.current?.scene.getScene('MainScene') as { cancelPlacement?: () => void } | undefined)?.cancelPlacement?.();

            void savePromise.catch(error => {
              // Transport failures retry on the next save cycle; a server
              // rejection has already reverted local state via clash:save-rejected.
              console.warn('Upgrade save failed:', error);
            });
          } else {
            // Reachable despite the disabled button: the wall bulk-upgrade
            // recount can outgrow the displayed price between click and here.
            soundSystem.play('denied');
          }
        } finally {
          upgradeInProgressRef.current = false;
        }
      }
    }
  };

  // Pre-calculation for UI: Wall Bulk Upgrade Cost
  const [wallUpgradeCostOverride, setWallUpgradeCostOverride] = useState<number | undefined>();

  useEffect(() => {
    const calcWallCost = async () => {
      if (selectedBuildingInfo?.type === 'wall' && view === 'HOME') {
        try {
          const world = await Backend.getWorld(user?.id || 'default_player');
          if (world) {
            const count = world.buildings.filter(b => b.type === 'wall' && (b.level || 1) === selectedBuildingInfo.level).length;
            const nextStats = getBuildingStats('wall', selectedBuildingInfo.level + 1);
            setWallUpgradeCostOverride(nextStats.cost * count);
          }
        } catch (error) {
          console.error('Error calculating wall cost:', error);
        }
      } else {
        setWallUpgradeCostOverride(undefined);
      }
    };
    calcWallCost();
  }, [selectedBuildingInfo, view]);

  // Wait for the initial session check before rendering game/login UI.
  if (!authReady) {
    return (
      <div className="app-container">
        <CloudOverlay
          show={true}
          opening={false}
          loading={true}
          loadingProgress={20}
        />
      </div>
    );
  }

  return (
    <div className="app-container">
      <div id="game-container" style={{ display: isLockedOut ? 'none' : 'block' }} />

      <Hud
        view={view}
        resources={displayResources}
        spendableResources={spendableResources}
        infiniteResources={infiniteResources}
        storageCaps={storageCapsRef.current}
        population={population}
        battleStats={battleStats}
        battleStarted={battleStarted}
        visibleTroops={visibleTroops}
        selectedTroopType={selectedTroopType}
        army={army}
        armyCapacity={capacity.max}
        selectedBuildingInfo={selectedBuildingInfo}
        isExiting={isExiting}
        wallUpgradeCostOverride={wallUpgradeCostOverride}
        isMobile={isMobile}
        isScouting={Boolean(scoutTarget)}
        pendingLoot={cloudTransitionReward}
        lootAnimating={lootAnimating}
        onLootAnimationDone={() => setLootAnimating(null)}
        onOpenSettings={() => setIsAccountOpen(true)}
        onOpenBuild={() => setIsBuildingOpen(true)}
        onOpenTrain={() => setIsTrainingOpen(true)}
        onSelectTroop={(type) => setSelectedTroopType(type as typeof selectedTroopType)}
        onNextMap={handleNextMap}
        onGoHome={handleGoHome}
        onDeleteBuilding={handleDeleteBuilding}
        deleteBuildingDisabled={campSaleBlocked}
        deleteBuildingDisabledReason={campSaleBlocked ? 'Dismiss troops before selling this camp' : undefined}
        onUpgradeBuilding={handleUpgradeBuilding}
        onMoveBuilding={() => gameManager.moveSelectedBuilding()}
        onOpenMap={() => setShowAtlas(true)}
        troopLevel={troopLevel}
      />

      {view === 'ATTACK' && scoutTarget && (
        <div className="scout-action-panel">
          <div className="scout-label">SCOUTING {scoutTarget.username.toUpperCase()}</div>
          <button className="action-btn scout-attack" onClick={handleAttackScouted}>
            ATTACK
          </button>
        </div>
      )}

      {/* Keep the social controls mounted through a raid so returning HOME
          does not remount both panels and immediately refetch leaderboard +
          notification state. They remain visually/inertly absent off HOME. */}
      {isOnline && user && (
        <div
          className="top-right-btns"
          style={view === 'HOME' ? undefined : { display: 'none' }}
          aria-hidden={view !== 'HOME'}
        >
          <button className="atlas-btn" title="Replay theatre" onClick={() => { soundSystem.play('uiOpen'); setShowTheatre(true); }}>
            <span className="sym sym-watch" />
          </button>
          <LeaderboardPanel
            currentUserId={user.id}
            isOnline={isOnline}
            onScoutUser={handleScoutUser}
          />
          <NotificationsPanel
            userId={user.id}
            isOnline={isOnline}
            incomingAttack={incomingAttack}
            onWatchLive={handleWatchLiveAttack}
            onWatchReplay={handleWatchReplay}
            onRevenge={handleDirectUserAttack}
          />
        </div>
      )}

      {showAtlas && <MapAtlasModal onClose={() => setShowAtlas(false)} />}
      {showTheatre && user && (
        <ReplayTheatreModal
          userId={user.id}
          onWatch={handleWatchReplay}
          onClose={() => setShowTheatre(false)}
        />
      )}

      {/* ONE EVENT, ONE SURFACE; history goes to the bell. This card is THE
          incoming-attack surface: while it shows, nothing else pops — the
          scene raises no duplicate siege bubble and no toast echoes the
          attack (WorldMapSystem.onSiegeStarted/onSiegeEnded keep only the
          horn + villager panic, which are diegetic, not chrome). The
          defense-log notification still lands silently in the bell (badge
          increments, LIVE row inside the dropdown) for history. */}
      {view === 'HOME' && incomingAttack && (
        <div className="incoming-attack-popup">
          <div className="title">YOUR BASE IS UNDER ATTACK</div>
          <div className="incoming-attack-meta">
            <span className="incoming-attack-name">{incomingAttack.attackerName}</span>
            <span className="incoming-attack-tag">
              {incomingAttack.attackerId?.startsWith('bot') ? 'BOT' : 'PLAYER'}
            </span>
          </div>
          <div className="incoming-attack-actions">
            <button
              className="watch-btn"
              onClick={() => handleWatchLiveAttack(incomingAttack.attackId, incomingAttack.attackerName)}
            >
              WATCH
            </button>
            <button
              className="dismiss-btn"
              onClick={() => {
                soundSystem.play('uiTap');
                setDismissedIncomingAttackId(incomingAttack.attackId);
                setIncomingAttack(null);
                gameManager.dismissSiegeBanner();
              }}
            >
              DISMISS
            </button>
          </div>
        </div>
      )}

      {/* ONE EVENT, ONE SURFACE; history goes to the bell. Spectating stacks
          no status chrome: this single card carries who-vs-who + LIVE/REPLAY
          + destruction + exit, and the Hud's separate battle-stats row stays
          ATTACK-only (see Hud.tsx) so it never doubles this surface. */}
      {view === 'REPLAY' && activeReplay && (
        <div className="replay-status-overlay">
          <div className="replay-badge">
            <span className="replay-icon">{activeReplay.live ? '\u25C9' : '\u25B6'}</span>
            <span className="replay-mode">{activeReplay.live ? 'LIVE' : 'REPLAY'}</span>
          </div>
          <div className="replay-info">
            <span className="replay-title">{activeReplay.live ? 'Defense Watch' : 'Attack Replay'}</span>
            <span className="replay-attacker">
              {activeReplay.attackerName} vs {user?.username ?? 'you'}
            </span>
          </div>
          <span className="replay-destruction">{battleStats.destruction}%</span>
          <button className="replay-exit-btn" onClick={() => { soundSystem.play('uiTap'); handleExitReplay(); }}>RETREAT</button>
        </div>
      )}

      <DebugMenu isOpen={isDebugOpen} />

      <JukeboxModal isOpen={isJukeboxOpen} onClose={() => setIsJukeboxOpen(false)} />
      <BannerPickerModal
        isOpen={isBannerPickerOpen}
        userId={userId ?? 'default_player'}
        required={isBannerRequired}
        onSaved={() => setIsBannerRequired(false)}
        onClose={() => setIsBannerPickerOpen(false)}
      />

      <MerchantModal
        offers={merchantOffers}
        resources={spendableResources}
        onTrade={handleMerchantTrade}
        onClose={() => setMerchantOffers(null)}
      />

      <PlotPanel info={plotPanel} onAction={handlePlotAction} onClose={() => setPlotPanel(null)} />

      {toast && <div className="toast-banner">{toast}</div>}

      <AccountModal
        isOpen={isAccountOpen}
        currentUser={user}
        isOnline={isOnline}
        onClose={() => setIsAccountOpen(false)}
        onRename={handleRenameAccount}
        onRegister={handleRegisterAccount}
        onLogin={handleLoginAccount}
        onLogout={handleLogoutAccount}
        onReseedWorld={handleReseedWorld}
      />

      {needsAccount && !sessionExpired && !user ? (
        // The required registration wall — a fresh device gets no village
        // until it creates an account or logs in. Replaces (and outranks)
        // the generic lockout card, same full-screen bury.
        <AuthGate onLogin={handleGateLogin} onCreate={handleGateCreate} />
      ) : isLockedOut && (
        <div className="auth-lock-overlay">
          <div className="auth-lock-panel">
            <h2>{sessionExpired ? 'SESSION EXPIRED' : "CAN'T REACH THE GAME SERVER"}</h2>
            <p>{sessionExpired
              ? 'Your session was closed before any more local changes could be lost. Reconnect to continue.'
              : 'Your village lives on the game server. Start it (npm run dev) and try again.'}</p>
            {/* Own class, NOT .action-btn: that styles the square HUD-bar
                icon buttons (80×90px) and squashed this CTA into a tiny
                left-aligned square. */}
            <button className="auth-lock-btn" onClick={() => { soundSystem.play('uiTap'); handleRetryConnection(); }}>
              {sessionExpired ? 'RECONNECT' : 'RETRY'}
            </button>
          </div>
        </div>
      )}

      <TrainingModal
        isOpen={isTrainingOpen}
        showCloudOverlay={showCloudOverlay}
        capacity={capacity}
        resources={spendableResources}
        army={army}
        troops={troopList}
        troopLevel={troopLevel}
        troopLevelUpgrading={troopLevelUpgrading}
        barracksLevels={barracksLevels}
        barracksUpgrading={barracksUpgrading}
        armyCampLevel={armyCampProgress.completedLevel}
        armyCampUpgrading={armyCampProgress.upgrading}
        armyCampUpgradingToLevel={armyCampProgress.upgradingToLevel}
        testMode={testMode}
        onClose={() => setIsTrainingOpen(false)}
        onStartPractice={handleStartPractice}
        onFindMatch={handleFindMatch}
        onTrainTroop={handleTrainTroop}
        onUntrainTroop={handleUntrainTroop}
      />

      <BuildingShopModal
        isOpen={isBuildingOpen}
        showCloudOverlay={showCloudOverlay}
        buildingList={buildingList}
        buildingCounts={buildingCounts}
        resources={spendableResources}
        shopWallLevel={shopWallLevel}
        onClose={() => setIsBuildingOpen(false)}
        onSelect={handleSelect}
      />

      {isTestModePopupOpen && (
        <TestModePopup
          onClose={() => {
            soundSystem.play('confirm');
            setIsTestModePopupOpen(false);
          }}
        />
      )}

      <CloudOverlay
        show={showCloudOverlay}
        opening={cloudOpening}
        loading={cloudOverlayLoading}
        loadingProgress={cloudLoadingProgress}
      />

    </div>
  );
}



export default App;
