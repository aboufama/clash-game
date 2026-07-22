import type { SerializedWorld } from '../data/Models';

export interface AuthUser {
  id: string;
  username: string;
  trophies: number;
  /** True once the account has a username + password and can be loaded from any device. */
  registered: boolean;
}

export interface SessionFeatures {
  /** The authoritative game server will accept purchases without consuming resources. */
  infiniteResources: boolean;
  /** Operator-controlled entitlement for instant upgrades and unrestricted troop access. */
  testMode: boolean;
  /** Stable identity of the currently effective Test Mode enablement. */
  testModeActivationId: string | null;
  /** True until one device atomically claims the activation announcement. */
  testModeAnnouncementPending: boolean;
  /** Server-owned new-account onboarding gate; presentation is handled elsewhere. */
  introBattleRequired: boolean;
}

interface SessionResponse {
  token: string;
  player: AuthUser;
  world: SerializedWorld | null;
  created: boolean;
  unread: number;
  features?: Partial<SessionFeatures>;
}

export interface EnsuredSession {
  user: AuthUser | null;
  online: boolean;
  world: SerializedWorld | null;
  /**
   * True when the server granted no identity: this device must register a
   * username + password (or log in) before it gets a village. The app shows
   * the account gate instead of booting the game.
   */
  registrationRequired?: boolean;
}

export interface DevWorldReseedResult {
  ok: true;
  removedGuests: number;
  preservedPlayers: number;
  seedVersion?: number;
}

const TOKEN_KEY = 'clash.device.token';
const USER_KEY = 'clash.auth';
const AUTH_REQUEST_TIMEOUT_MS = 10_000;

async function timedFetch(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller
    ? globalThis.setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS)
    : null;
  try {
    return await fetch(input, { ...init, signal: controller?.signal });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new Error('Authentication request timed out');
    }
    throw error;
  } finally {
    if (timeout !== null) globalThis.clearTimeout(timeout);
  }
}

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable — the in-memory session still works for this tab.
  }
}

function removeStorage(key: string) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage unavailable — nothing to remove.
  }
}

function loadStoredUser(): AuthUser | null {
  const raw = readStorage(USER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthUser>;
    if (typeof parsed?.id !== 'string' || typeof parsed?.username !== 'string') return null;
    return {
      id: parsed.id,
      username: parsed.username,
      trophies: Number(parsed.trophies) || 0,
      registered: Boolean(parsed.registered)
    };
  } catch {
    return null;
  }
}

async function postJson<T>(path: string, body: unknown, token?: string | null): Promise<T> {
  const response = await timedFetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store'
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(detail?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

/**
 * Identity: the device holds a secret session token. A valid token resumes
 * its account. Without one, production requires creating an account first —
 * username + password, nothing else — before any village exists
 * (`registrationRequired` from /auth/session drives the account gate). In
 * development (CLASH_ALLOW_GUESTS=1) the server auto-creates a playable
 * guest instead, which can later be upgraded in place via register().
 */
export class Auth {
  private static current: AuthUser | null = null;
  private static online = false;
  private static token: string | null = null;
  private static features: SessionFeatures = {
    infiniteResources: false,
    testMode: false,
    testModeActivationId: null,
    testModeAnnouncementPending: false,
    introBattleRequired: false
  };
  private static ensureInFlight: Promise<EnsuredSession> | null = null;

  static getCurrentUser() {
    return Auth.current;
  }

  static isOnlineMode() {
    return Auth.online;
  }

  static getFeatures(): Readonly<SessionFeatures> {
    return Auth.features;
  }

  private static normalizedFeatures(features?: Partial<SessionFeatures> | null) {
    const testMode = features?.testMode === true;
    const activationId = typeof features?.testModeActivationId === 'string'
      && features.testModeActivationId.length > 0
      ? features.testModeActivationId
      : null;
    return {
      // Test mode always includes the infinite wallet. Keeping the standalone
      // flag also preserves the legacy development-only entitlement.
      infiniteResources: testMode || features?.infiniteResources === true,
      testMode,
      testModeActivationId: testMode ? activationId : null,
      introBattleRequired: features?.introBattleRequired === true
    };
  }

  /** A fresh authenticated session is the only response allowed to arm UI. */
  private static adoptSessionFeatures(features?: Partial<SessionFeatures> | null): Readonly<SessionFeatures> {
    const normalized = Auth.normalizedFeatures(features);
    Auth.features = {
      ...normalized,
      testModeAnnouncementPending: normalized.testMode
        && normalized.testModeActivationId !== null
        && features?.testModeAnnouncementPending === true
    };
    return Auth.features;
  }

  /**
   * Adopt live server entitlements without arming announcement UI. Home-sync
   * may disarm a session-latched claim after another tab wins, but it can
   * never turn a non-pending client into an announcement contender.
   */
  static adoptFeatures(features?: Partial<SessionFeatures> | null): Readonly<SessionFeatures> {
    const normalized = Auth.normalizedFeatures(features);
    const pendingStillCurrent = Auth.features.testModeAnnouncementPending
      && normalized.testMode
      && normalized.testModeActivationId !== null
      && normalized.testModeActivationId === Auth.features.testModeActivationId
      && features?.testModeAnnouncementPending === true;
    Auth.features = {
      ...normalized,
      testModeAnnouncementPending: pendingStillCurrent
    };
    return Auth.features;
  }

  static pendingTestModeAnnouncement(): string | null {
    return Auth.features.testModeAnnouncementPending
      ? Auth.features.testModeActivationId
      : null;
  }

  /** Settle one terminal claim without disturbing a newer activation. */
  static resolveTestModeAnnouncement(activationId: string): void {
    if (Auth.features.testModeActivationId !== activationId) return;
    Auth.features = { ...Auth.features, testModeAnnouncementPending: false };
  }

  static resolveIntroBattle(): void {
    if (!Auth.features.introBattleRequired) return;
    Auth.features = { ...Auth.features, introBattleRequired: false };
  }

  static getToken(): string | null {
    if (Auth.token) return Auth.token;
    Auth.token = readStorage(TOKEN_KEY);
    return Auth.token;
  }

  private static adoptSession(session: SessionResponse) {
    Auth.token = session.token;
    Auth.current = session.player;
    Auth.online = true;
    Auth.adoptSessionFeatures(session.features);
    writeStorage(TOKEN_KEY, session.token);
    writeStorage(USER_KEY, JSON.stringify(session.player));
  }

  /**
   * Establish a session. Always resolves: with the server it returns (or
   * creates) the account; without it, it falls back to the cached identity in
   * offline mode.
   */
  static ensureUser(): Promise<EnsuredSession> {
    // React StrictMode deliberately mounts effects twice in development. One
    // shared bootstrap prevents two tokenless requests from minting two guest
    // villages and racing to become this tab's identity.
    if (Auth.ensureInFlight) return Auth.ensureInFlight;
    const task = Auth.establishSession();
    Auth.ensureInFlight = task;
    void task.finally(() => {
      if (Auth.ensureInFlight === task) Auth.ensureInFlight = null;
    });
    return task;
  }

  private static async establishSession(): Promise<EnsuredSession> {
    const stored = loadStoredUser();
    if (stored) Auth.current = stored;

    try {
      const response = await timedFetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: Auth.getToken() }),
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(`Session request failed (${response.status})`);
      const payload = (await response.json()) as SessionResponse | { registrationRequired?: unknown };
      if ((payload as { registrationRequired?: unknown }).registrationRequired === true) {
        // The registration wall: the server granted no identity, so whatever
        // token/profile this tab cached is dead. Clear it so the account gate
        // starts clean (createAccount must go out with no stale bearer).
        Auth.token = null;
        Auth.current = null;
        Auth.online = true;
        Auth.adoptFeatures();
        removeStorage(TOKEN_KEY);
        removeStorage(USER_KEY);
        return { user: null, online: true, world: null, registrationRequired: true };
      }
      const session = payload as SessionResponse;
      Auth.adoptSession(session);
      return { user: session.player, online: true, world: session.world ?? null };
    } catch (error) {
      console.warn('Game server unreachable, entering offline mode:', error);
      Auth.online = false;
      Auth.adoptFeatures();
      return { user: Auth.current, online: false, world: null };
    }
  }

  /** Change the village name. */
  static async rename(name: string): Promise<AuthUser> {
    const data = await postJson<{ player: AuthUser }>('/api/player/rename', { name }, Auth.getToken());
    Auth.current = data.player;
    writeStorage(USER_KEY, JSON.stringify(data.player));
    return data.player;
  }

  /**
   * Development-only world maintenance. The server owns the preservation
   * rules; the client deliberately sends no player ids or deletion criteria.
   */
  static async reseedWorld(): Promise<DevWorldReseedResult> {
    if (!import.meta.env.DEV) throw new Error('World reseeding is only available in development');
    const result = await postJson<DevWorldReseedResult>('/api/debug/reseed-world', {}, Auth.getToken());
    if (result.ok !== true) throw new Error('The game server did not confirm the world reseed');
    return result;
  }

  /**
   * Attach a username + password to the current village so it can be loaded
   * from any device. The current session keeps working — nothing is lost.
   */
  static async register(username: string, password: string): Promise<AuthUser> {
    const data = await postJson<{ player: AuthUser }>('/api/auth/register', { username, password }, Auth.getToken());
    Auth.current = data.player;
    writeStorage(USER_KEY, JSON.stringify(data.player));
    return data.player;
  }

  /**
   * Account-gate registration: create a brand-new account (username +
   * password, nothing else). Deliberately sends NO bearer token — the server
   * creates the account, allocates its village plot and issues this device's
   * session, which is adopted here.
   */
  static async createAccount(username: string, password: string): Promise<{ user: AuthUser; world: SerializedWorld | null }> {
    const session = await postJson<SessionResponse>('/api/auth/register', { username, password });
    Auth.adoptSession(session);
    return { user: session.player, world: session.world ?? null };
  }

  /**
   * Log into a registered account. The server issues a fresh session token for
   * this device; the caller should reload app state afterwards.
   */
  static async login(username: string, password: string): Promise<SessionResponse> {
    const previousToken = Auth.getToken();
    const session = await postJson<SessionResponse>('/api/auth/login', { username, password });
    Auth.adoptSession(session);
    if (previousToken && previousToken !== session.token) {
      // Revoke only the old device token. This deliberately does not call
      // logout(), which would wipe the newly adopted account from this tab.
      await Auth.revokeToken(previousToken).catch(error => {
        console.warn('Signed into the new account, but old session cleanup failed:', error);
      });
    }
    return session;
  }

  /** Server-only token revoke; never mutates the currently adopted local session. */
  static async revokeToken(token: string): Promise<void> {
    if (!token) return;
    await postJson('/api/auth/logout', { token }, Auth.getToken());
  }

  /**
   * End this device's session. Best-effort server revoke, then local wipe —
   * the next ensureUser() starts a fresh guest village.
   */
  static async logout(): Promise<void> {
    const token = Auth.getToken();
    if (token) {
      await postJson('/api/auth/logout', { token }, token).catch(() => undefined);
    }
    Auth.token = null;
    Auth.current = null;
    Auth.online = false;
    Auth.adoptFeatures();
    removeStorage(TOKEN_KEY);
    removeStorage(USER_KEY);
  }
}
