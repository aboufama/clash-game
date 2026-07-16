import { upgradeDurationMs } from './Economy';
import type { BuildingType } from './GameDefinitions';

/**
 * The server's effective upgrade-clock policy, advertised on every owned
 * world payload (`world.upgradePolicy`). Display durations MUST come from
 * here: the client used to read its own VITE_CLASH_UPGRADE_DURATION_MS env
 * var, which was set independently of the server's CLASH_UPGRADE_DURATION_MS
 * / CLASH_UPGRADE_TIME_SCALE knobs — whenever the two drifted, every
 * advertised "~duration" lied about the deadline the server would bill.
 */
export interface ServerUpgradePolicy {
    /** One exact duration for every timed upgrade (dev/test servers). */
    fixedDurationMs?: number;
    /** Multiplier applied to the shared upgradeDurationMs math (default 1). */
    timeScale?: number;
}

let serverPolicy: ServerUpgradePolicy | null = null;

/** Adopt the policy advertised by a server world payload; garbage is ignored. */
export function adoptUpgradePolicy(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const source = raw as Record<string, unknown>;
    const fixed = Number(source.fixedDurationMs);
    const scale = Number(source.timeScale);
    serverPolicy = {
        ...(Number.isFinite(fixed) && fixed >= 0 ? { fixedDurationMs: Math.round(fixed) } : {}),
        ...(Number.isFinite(scale) && scale >= 0 ? { timeScale: scale } : {})
    };
}

/**
 * The duration the SERVER will bill for upgrading `type` to `toLevel` —
 * mirrors server/domain/village/economy.ts exactly: walls are instant, a
 * fixed policy duration wins outright, otherwise the shared math is scaled.
 * Until the first world payload arrives the unscaled shared math applies.
 */
export function serverUpgradeDurationMs(type: BuildingType | string, toLevel: number): number {
    if (type === 'wall') return 0;
    if (serverPolicy?.fixedDurationMs !== undefined) return serverPolicy.fixedDurationMs;
    return Math.round(upgradeDurationMs(type, toLevel) * (serverPolicy?.timeScale ?? 1));
}
