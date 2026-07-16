import Phaser from 'phaser';
import type { ObstacleType, TroopType } from '../config/GameDefinitions';
import type { CombatNavigationPlan } from '../systems/CombatNavigationSystem';

export interface PlacedBuilding {
    id: string;
    type: string;
    level: number; // Added level property
    /** Server stamp from placement/last upgrade — drives the age patina. */
    builtAt?: number;
    /** A villager is working here right now (mine pulley speeds up...). */
    crewedUntil?: number;
    /** Server-owned upgrade timer (mirrored locally): the target level, and
     *  when it lands. While set the building is offline — defenses hold fire,
     *  production pauses — and its level stays at the old value. */
    upgradingTo?: number;
    upgradeStartedAt?: number;
    upgradeEndsAt?: number;
    gridX: number;
    gridY: number;
    graphics: Phaser.GameObjects.Graphics;
    barrelGraphics?: Phaser.GameObjects.Graphics;
    healthBar: Phaser.GameObjects.Graphics;
    health: number;
    maxHealth: number;
    owner: 'PLAYER' | 'ENEMY';
    // Ballista-specific properties
    ballistaAngle?: number;        // Current angle in radians (0 = facing right/east)
    ballistaTargetAngle?: number;  // Target angle to smoothly rotate towards
    ballistaStringTension?: number; // 0 = relaxed, 1 = fully drawn back
    ballistaBoltLoaded?: boolean;   // Whether a bolt is ready to fire
    lastFireTime?: number;
    isFiring?: boolean;
    // Idle swivel for rotating defenses
    idleSwiveTime?: number;        // Time accumulator for idle swivel
    idleTargetAngle?: number;      // Random idle target angle
    // Cannon barrel recoil (0-1, 0 = normal, 1 = full recoil)
    cannonRecoilOffset?: number;
    // Prism Tower - Continuous laser properties
    prismTarget?: Troop;           // Current target being lasered
    prismLaserGraphics?: Phaser.GameObjects.Graphics; // The continuous laser beam
    prismLaserCore?: Phaser.GameObjects.Graphics;     // Inner core of laser
    // Frostfall Monolith
    frostfallProjectileActive?: boolean; // true when the big crystal has launched and is flying
    // Ice-golem freeze-on-death debuff: while `time < frozenUntil` this
    // defense holds fire entirely (DefenseSystem skips it; client battle
    // sim + presentation only — server settlement ignores debuffs by
    // design). `frostOverlay` is the tracked icy dressing drawn over the
    // building for the freeze window.
    frozenUntil?: number;
    frostOverlay?: Phaser.GameObjects.Graphics;
    // Tesla charge state
    teslaCharging?: boolean;
    teslaChargeStart?: number;
    teslaCharged?: boolean;
    teslaChargeTarget?: Troop;
    lockedTargetId?: string;
    // Range indicator
    rangeIndicator?: Phaser.GameObjects.Graphics;
    prismTrailLastPos?: { x: number, y: number }; // Track last scorch position for connected trail
    prismLastDamageTime?: number;
    lastTrailTime?: number;     // For specialized smoke trails
    baseGraphics?: Phaser.GameObjects.Graphics; // Separate graphics for ground-level base (prevents clipping)
    isDestroyed?: boolean;
    lastHealthBarValue?: number;
    lastHealthChangeTime?: number;
    // Redraw throttling: state captured at the last full visual redraw, so
    // unchanged buildings can skip re-tessellating every frame.
    lastDrawAngle?: number;
    lastDrawAlpha?: number;
    lastDrawHealth?: number;
    drawStagger?: number;
    // Health-bar geometry cache: skip clear+redraw when nothing moved or changed.
    lastBarDrawHealth?: number;
    lastBarDrawX?: number;
    lastBarDrawY?: number;
    // Health-bar anchor: world px from the iso center up to the baked
    // silhouette's top (cached per level; null = not sprite-backed).
    barAnchorTop?: number | null;
    barAnchorLevel?: number;
    // Door animation (town hall / barracks / lab): villagers going in or out
    // hold the door open until doorOpenUntil; doorOpen eases 0..1 toward that.
    doorOpen?: number;
    doorOpenUntil?: number;
    lastDrawDoorOpen?: number;
    // Production fill (mine/farm): crops/ore visibly build up over the cycle
    // and reset when a worker hauls the goods to the storehouse.
    fillLevel?: number;
    lastHarvestAt?: number;
    lastDrawFill?: number;
}

export interface Troop {
    id: string;
    type: TroopType;
    level: number;
    gameObject: Phaser.GameObjects.Graphics;
    healthBar: Phaser.GameObjects.Graphics;
    /** Pre-pixelated level chip (BattleOverlay texture), fixed screen size. */
    levelTag?: Phaser.GameObjects.Image;
    gridX: number;
    gridY: number;
    health: number;
    maxHealth: number;
    owner: 'PLAYER' | 'ENEMY';
    lastAttackTime: number;
    attackDelay: number;
    speedMult: number;
    hasTakenDamage: boolean;
    facingAngle: number;
    path?: Array<{ x: number; y: number }>; // Continuous grid-space waypoints
    /** The building this troop ultimately intends to attack. A temporary wall
     * blocker must never replace this intent. Wards keep this unset while
     * following another troop. */
    strategicTarget?: PlacedBuilding | null;
    /** Versioned combat route. `target` remains the active damage/animation
     * target for legacy render code; this plan retains the strategic intent. */
    navigationPlan?: CombatNavigationPlan;
    nextPathTime?: number;
    velocityX?: number;
    velocityY?: number;
    lastProgressX?: number;
    lastProgressY?: number;
    lastProgressTime?: number;
    stuckTicks?: number;
    retargetPauseUntil?: number;
    /** While set (and in the future), velocity is a knockback impulse that
     * updateTroops integrates through the collision resolver each frame. */
    knockbackUntil?: number;
    lastTargetSwitchTime?: number;
    lastOpportunityScanTime?: number;
    target: any; // PlacedBuilding | Troop | null
    chillRemainingMs?: number;
    /** Last time the ice golem's on-hit frost FX played (throttle gate —
     *  continuous-beam damage ticks would otherwise spam a burst per tick). */
    frostHitFxAt?: number;
    // Special troop properties
    recursionGen?: number; // For recursion (0 = original, 1 = first split, 2 = final)
    slamOffset?: number; // For golem body slam animation
    bowDrawProgress?: number; // For sharpshooter bow draw animation (0 = relaxed, 1 = fully drawn)
    mortarRecoil?: number; // For mobile mortar - recoil offset for the mortar only (not the soldier)
    phalanxSpearOffset?: number; // For phalanx - spear thrusting animation (0 = normal, 1 = full thrust)
    lastHealthBarValue?: number;
    lastHealthChangeTime?: number;
    // Depth-sort thrash guard: only call setDepth when the bucket changes.
    lastDepth?: number;
    // Health-bar geometry cache: skip clear+redraw when nothing moved or changed.
    lastBarDrawHealth?: number;
    lastBarDrawX?: number;
    lastBarDrawY?: number;
    replayPrevSampleX?: number;
    replayPrevSampleY?: number;
    replayPrevSampleT?: number;
    replaySampleX?: number;
    replaySampleY?: number;
    replaySampleT?: number;
}

export interface PlacedObstacle {
    id: string;
    type: ObstacleType;
    gridX: number;
    gridY: number;
    graphics: Phaser.GameObjects.Graphics;
    animOffset: number; // For subtle idle animations
}
