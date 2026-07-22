import type { BuildingType, TroopType } from '../config/GameDefinitions';

/**
 * Versioned, JSON-safe presentation facts for replay v2. These events are
 * deliberately separate from simulation keyframes: a hit event owns both the
 * visible impact and the health transition, so replay playback cannot show
 * one before the other.
 */
export const REPLAY_PRESENTATION_EVENT_VERSION = 1 as const;

export type ReplayCombatOwner = 'PLAYER' | 'ENEMY';

export interface ReplayPresentationPoint {
    /** Simulation-space position, used for depth sorting and radius tests. */
    gridX: number;
    gridY: number;
    /** Isometric world-space position, including weapon/body offsets. */
    worldX: number;
    worldY: number;
}

export interface ReplayTroopRef {
    kind: 'troop';
    id: string;
    type: TroopType;
    owner: ReplayCombatOwner;
    level: number;
}

export interface ReplayBuildingRef {
    kind: 'building';
    id: string;
    type: BuildingType;
    owner: ReplayCombatOwner;
    level: number;
}

export type ReplayEntityRef = ReplayTroopRef | ReplayBuildingRef;

export interface ReplayHealthBarCue {
    show: boolean;
    holdMs: number;
    fadeMs: number;
}

export type ReplayAttackStyle =
    | 'melee-punch'
    | 'archer-arrow'
    | 'generic-tracer'
    | 'necromancer-orb'
    | 'mobile-mortar'
    | 'trebuchet'
    | 'ornithopter-bomb'
    | 'storm-lightning'
    | 'stone-golem-slam'
    | 'ice-golem-slam'
    | 'da-vinci-cannon'
    | 'phalanx-thrust'
    | 'war-elephant-trample'
    | 'battering-ram'
    | 'wall-breaker-detonation'
    | 'clockwork-beetle-latch'
    | 'clockwork-beetle-detonation'
    | 'siege-tower-park';

export interface TroopSpawnPayload {
    troop: ReplayTroopRef;
    at: ReplayPresentationPoint;
    reason: 'deployment' | 'necromancer-summon' | 'phalanx-split';
    facingAngle: number;
    maxHealth: number;
    attackDelayMs: number;
    firstAttackDelayMs: number;
    landingMs: number;
    playDeploySound: boolean;
}

export interface CombatAttackPayload {
    actor: ReplayTroopRef;
    target?: ReplayEntityRef;
    at: ReplayPresentationPoint;
    targetPoint?: ReplayPresentationPoint;
    style: ReplayAttackStyle;
    phase: 'windup' | 'release' | 'impact' | 'recoil' | 'recover' | 'cancel';
    facingAngle: number;
    attackDelayMs: number;
    phaseDurationMs: number;
    /** Authored sprite driver values used by slam/tower/spear/tank poses. */
    pose?: {
        slamOffset?: number;
        mortarRecoil?: number;
        parked01?: number;
        phalanxSpearOffset?: number;
        tankSpin01?: number;
        visualOffsetY?: number;
    };
}

export type ReplayDefenseWeapon =
    | 'cannon'
    | 'ballista'
    | 'xbow'
    | 'mortar'
    | 'tesla'
    | 'prism'
    | 'dragons-breath'
    | 'spike-launcher';

export interface DefenseChargePayload {
    defense: ReplayBuildingRef;
    target?: ReplayTroopRef;
    weapon: 'tesla';
    phase: 'start' | 'cancel' | 'complete' | 'visual-clear';
    chargeMs: number;
    chargedVisualMs: number;
    facingAngle: number;
}

export interface DefenseFirePayload {
    defense: ReplayBuildingRef;
    target: ReplayTroopRef;
    weapon: ReplayDefenseWeapon;
    source: ReplayPresentationPoint;
    targetPoint: ReplayPresentationPoint;
    facingAngle: number;
    damage: number;
    fireRateMs: number;
    windupMs: number;
    salvoIndex?: number;
    salvoSize?: number;
}

export type ReplayProjectileKind =
    | 'archer-arrow'
    | 'generic-tracer'
    | 'necromancer-orb'
    | 'mobile-mortar-shell'
    | 'trebuchet-stone'
    | 'ornithopter-bomb'
    | 'da-vinci-cannonball'
    | 'cannonball'
    | 'mortar-shell'
    | 'ballista-bolt'
    | 'xbow-bolt'
    | 'tesla-bolt'
    | 'storm-lightning'
    | 'prism-beam'
    | 'dragon-rocket'
    | 'spike-ball';

export type ReplayProjectileTrajectory =
    | {
        kind: 'linear';
        durationMs: number;
        ease: 'Linear' | 'Quad.easeIn' | 'Sine.easeInOut';
    }
    | {
        kind: 'parabolic';
        durationMs: number;
        apexWorldY: number;
        riseMs?: number;
        launchDelayMs?: number;
        spinRadians: number;
    }
    | {
        kind: 'homing';
        durationMs: number;
        ease: 'Linear' | 'Quad.easeIn';
        trackTargetId: string;
    }
    | {
        kind: 'instant';
        durationMs: number;
        segments?: ReadonlyArray<{
            from: ReplayPresentationPoint;
            to: ReplayPresentationPoint;
            delayMs: number;
        }>;
    }
    | {
        kind: 'continuous';
        tickMs: number;
        trackTargetId: string;
    };

export interface ProjectileLaunchPayload {
    projectileId: string;
    projectile: ReplayProjectileKind;
    sourceEntity: ReplayEntityRef;
    targetEntity?: ReplayEntityRef;
    source: ReplayPresentationPoint;
    target: ReplayPresentationPoint;
    level: number;
    rotation: number;
    scale: number;
    trajectory: ReplayProjectileTrajectory;
}

export type ReplayImpactStyle =
    | 'arrow-hit'
    | 'tracer-hit'
    | 'grave-orb-burst'
    | 'mobile-mortar-explosion'
    | 'trebuchet-explosion'
    | 'ornithopter-explosion'
    | 'da-vinci-impact'
    | 'cannon-impact'
    | 'mortar-explosion'
    | 'ballista-impact'
    | 'xbow-impact'
    | 'tesla-impact'
    | 'storm-lightning-impact'
    | 'prism-impact'
    | 'dragon-rocket-explosion'
    | 'spike-zone-impact';

export interface ProjectileImpactPayload {
    projectileId: string;
    projectile: ReplayProjectileKind;
    style: ReplayImpactStyle;
    at: ReplayPresentationPoint;
    sourceEntity?: ReplayEntityRef;
    targetEntity?: ReplayEntityRef;
    level: number;
    radiusTiles: number;
    shake?: { durationMs: number; intensity: number };
}

export type ReplayDamageKind =
    | 'melee'
    | 'projectile'
    | 'splash'
    | 'chain'
    | 'continuous-beam'
    | 'detonation'
    | 'slam'
    | 'trample'
    | 'spike-zone';

export interface CombatDamagePayload {
    source?: ReplayEntityRef;
    target: ReplayEntityRef;
    at: ReplayPresentationPoint;
    damageKind: ReplayDamageKind;
    amount: number;
    healthBefore: number;
    healthAfter: number;
    maxHealth: number;
    linkedPresentationEventId?: string;
    healthBar: ReplayHealthBarCue;
}

export interface CombatHealPayload {
    source: ReplayTroopRef;
    target: ReplayTroopRef;
    at: ReplayPresentationPoint;
    healKind: 'physician-pulse';
    amount: number;
    healthBefore: number;
    healthAfter: number;
    maxHealth: number;
    pulseIndex: number;
    /** Stable ordinal among allies healed by this one source pulse. */
    targetIndex?: number;
    healthBar: ReplayHealthBarCue;
}

export type ReplayTroopDeathStyle =
    | 'standard-poof'
    | 'wall-breaker-detonation'
    | 'clockwork-beetle-detonation'
    | 'phalanx-split'
    | 'golem-collapse'
    | 'ice-golem-collapse'
    | 'siege-tower-collapse-rolling'
    | 'siege-tower-collapse-parked'
    | 'da-vinci-tank-collapse'
    | 'trebuchet-collapse'
    | 'war-elephant-collapse';

export interface EntityDeathPayload {
    entity: ReplayTroopRef;
    at: ReplayPresentationPoint;
    style: ReplayTroopDeathStyle;
    facingAngle: number;
    animationMs: number;
    leaveRemnant: boolean;
}

export interface BuildingDestroyPayload {
    building: ReplayBuildingRef;
    at: ReplayPresentationPoint;
    footprint: { width: number; height: number };
    style: 'ordinary' | 'defense' | 'tesla-defense' | 'town-hall';
    silent: boolean;
    createRubble: boolean;
    shake: { durationMs: number; intensity: number; townHall: boolean };
}

export type ReplayAbilityPayload =
    | {
        ability: 'physician-heal-pulse';
        actor: ReplayTroopRef;
        at: ReplayPresentationPoint;
        radiusTiles: number;
        amount: number;
        targets: readonly ReplayTroopRef[];
        pulseIndex: number;
    }
    | {
        ability: 'necromancer-summon';
        actor: ReplayTroopRef;
        at: ReplayPresentationPoint;
        summonType: TroopType;
        summonCount: number;
        staggerMs: number;
    }
    | {
        ability: 'siege-tower-park' | 'siege-tower-ramp-open' | 'siege-tower-ramp-close';
        actor: ReplayTroopRef;
        wall?: ReplayBuildingRef;
        at: ReplayPresentationPoint;
        durationMs: number;
    }
    | {
        ability: 'siege-tower-ramp-hop';
        actor: ReplayTroopRef;
        wall: ReplayBuildingRef;
        at: ReplayPresentationPoint;
        visualOffsetY: number;
    }
    | {
        ability: 'clockwork-beetle-latch' | 'clockwork-beetle-detonate';
        actor: ReplayTroopRef;
        target: ReplayBuildingRef;
        at: ReplayPresentationPoint;
        leapMs: number;
        fuseMs: number;
    }
    | {
        ability: 'stone-golem-slam' | 'ice-golem-slam';
        actor: ReplayTroopRef;
        target: ReplayBuildingRef;
        at: ReplayPresentationPoint;
        radiusTiles: number;
        windupMs: number;
        recoveryMs: number;
    }
    | {
        ability: 'ice-golem-freeze-burst';
        actor: ReplayTroopRef;
        at: ReplayPresentationPoint;
        radiusTiles: number;
        durationMs: number;
        targets: readonly ReplayBuildingRef[];
    }
    | {
        ability: 'storm-chain';
        actor: ReplayTroopRef;
        at: ReplayPresentationPoint;
        targets: readonly ReplayBuildingRef[];
        hopDelayMs: number;
        damageFalloff: number;
    }
    | {
        ability: 'war-elephant-trample' | 'battering-ram-punch' | 'phalanx-thrust';
        actor: ReplayTroopRef;
        target: ReplayBuildingRef;
        at: ReplayPresentationPoint;
        durationMs: number;
        distancePx: number;
    }
    | {
        ability: 'da-vinci-recoil' | 'da-vinci-ring-spin';
        actor: ReplayTroopRef;
        target: ReplayBuildingRef;
        at: ReplayPresentationPoint;
        durationMs: number;
        turnRadians: number;
    }
    | {
        ability: 'prism-beam-start' | 'prism-beam-tick' | 'prism-beam-stop';
        actor: ReplayBuildingRef;
        target?: ReplayTroopRef;
        at: ReplayPresentationPoint;
        tickMs: number;
        hue: number;
    }
    | {
        ability: 'dragons-breath-salvo';
        actor: ReplayBuildingRef;
        at: ReplayPresentationPoint;
        targets: readonly ReplayTroopRef[];
        salvoSize: number;
        staggerMs: number;
    }
    | {
        ability: 'spike-zone-create' | 'spike-zone-tick' | 'spike-zone-expire';
        actor?: ReplayBuildingRef;
        at: ReplayPresentationPoint;
        zoneId: string;
        owner: ReplayCombatOwner;
        radiusTiles: number;
        durationMs: number;
        damage: number;
        targets: readonly ReplayTroopRef[];
    };

export type ReplayStatusPayload = {
    status: 'frozen';
    phase: 'apply' | 'refresh' | 'remove';
    source?: ReplayTroopRef;
    target: ReplayBuildingRef;
    at: ReplayPresentationPoint;
    durationMs: number;
    untilT: number;
};

export type ReplayFxPreset =
    | 'deploy-dust'
    | 'heal-ring'
    | 'heal-number'
    | 'summon-flourish'
    | 'siege-ramp-dust'
    | 'slam-cracks'
    | 'golem-hit'
    | 'ice-golem-hit'
    | 'freeze-burst'
    | 'freeze-dressing'
    | 'freeze-thaw'
    | 'building-collapse'
    | 'troop-death'
    | ReplayImpactStyle;

export type ReplayFxPayload =
    | {
        fx: 'preset';
        preset: ReplayFxPreset;
        at: ReplayPresentationPoint;
        source?: ReplayEntityRef;
        target?: ReplayEntityRef;
        level: number;
        owner?: ReplayCombatOwner;
        radius?: number;
        durationMs?: number;
        linkedPresentationEventId?: string;
    }
    | {
        fx: 'flash';
        at: ReplayPresentationPoint;
        radius: number;
        squash: number;
        color: number;
        alpha: number;
        scaleTo: number;
        durationMs: number;
        delayMs: number;
        depth: number;
        additive: boolean;
    }
    | {
        fx: 'ring';
        at: ReplayPresentationPoint;
        radiusFrom: number;
        radiusTo: number;
        squash: number;
        thicknessFrom: number;
        thicknessTo: number;
        color: number;
        alpha: number;
        durationMs: number;
        delayMs: number;
        depth: number;
    }
    | {
        fx: 'burst';
        at: ReplayPresentationPoint;
        count: number;
        colors: readonly number[];
        radius: number;
        spreadX: number;
        spreadY: number;
        radial: number;
        up: number;
        alpha: number;
        durationMs: number;
        depth: number;
        square: boolean;
        additive: boolean;
    }
    | {
        fx: 'lightning';
        points: readonly ReplayPresentationPoint[];
        color: number;
        width: number;
        alpha: number;
        durationMs: number;
        depth: number;
    }
    | {
        fx: 'screen-shake';
        durationMs: number;
        intensity: number;
        townHall: boolean;
    };

export interface ReplaySoundPayload {
    sound: 'deploy' | 'destroy';
    source?: ReplayEntityRef;
    at?: ReplayPresentationPoint;
}

export interface ReplayPresentationEventPayloadMap {
    'troop.spawn': TroopSpawnPayload;
    'combat.attack': CombatAttackPayload;
    'defense.charge': DefenseChargePayload;
    'defense.fire': DefenseFirePayload;
    'projectile.launch': ProjectileLaunchPayload;
    'projectile.impact': ProjectileImpactPayload;
    'combat.damage': CombatDamagePayload;
    'combat.heal': CombatHealPayload;
    'entity.death': EntityDeathPayload;
    'building.destroy': BuildingDestroyPayload;
    'ability': ReplayAbilityPayload;
    'status': ReplayStatusPayload;
    'fx': ReplayFxPayload;
    'sound': ReplaySoundPayload;
}

export type ReplayPresentationEventType = keyof ReplayPresentationEventPayloadMap;

export type ReplayPresentationEventOf<K extends ReplayPresentationEventType> = {
    [P in K]: Readonly<{
        version: typeof REPLAY_PRESENTATION_EVENT_VERSION;
        id: string;
        seed: number;
        type: P;
        payload: ReplayPresentationEventPayloadMap[P];
    }>;
}[K];

export type ReplayPresentationEvent = {
    [K in ReplayPresentationEventType]: ReplayPresentationEventOf<K>;
}[ReplayPresentationEventType];

export type ReplayPresentationEventDraft = {
    [K in ReplayPresentationEventType]: Readonly<{
        type: K;
        payload: ReplayPresentationEventPayloadMap[K];
    }>;
}[ReplayPresentationEventType];
