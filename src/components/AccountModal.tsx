import { useEffect, useState } from 'react';
import type { DevWorldReseedResult } from '../game/backend/Auth';
import { soundSystem } from '../game/systems/SoundSystem';
import {
  DESIGN_CHANGED_EVENT,
  activeSlot,
  listVariantUnits,
  setActiveSlot,
} from '../game/renderers/redesign/DesignRegistry';

interface AccountUser {
  id: string;
  username: string;
  trophies: number;
  registered: boolean;
}

interface AccountModalProps {
  isOpen: boolean;
  currentUser: AccountUser | null;
  isOnline: boolean;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
  onRegister: (username: string, password: string) => Promise<void>;
  onLogin: (username: string, password: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onReseedWorld: () => Promise<DevWorldReseedResult>;
}

type Tab = 'profile' | 'register' | 'login';
/** Which async flow is in flight — drives per-button progress labels. */
type BusyAction = 'rename' | 'register' | 'login' | 'logout' | 'reseed';

/**
 * DESIGN LAB (dev only) — live design-variant switching for the clean-room
 * tournament units. Rows render purely from DesignRegistry.listVariantUnits(),
 * so a future tournament's units appear here the moment their vector draw fns
 * are registered — zero hardcoded names. Clicking a slot applies INSTANTLY
 * behind the open modal: setActiveSlot persists the choice and dispatches the
 * design-changed event MainScene repaints on.
 */
function DesignLabSection() {
  // activeSlot() reads localStorage per render; bump on any design change
  // (ours or another tab/tool's) so the segmented buttons track reality.
  const [, setRevision] = useState(0);
  useEffect(() => {
    const onChanged = () => setRevision(r => r + 1);
    window.addEventListener(DESIGN_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DESIGN_CHANGED_EVENT, onChanged);
  }, []);

  const units = listVariantUnits();
  if (units.length === 0) return null;

  return (
    <section className="settings-section" aria-label="Design lab">
      <div className="settings-section-title">DESIGN LAB</div>
      <p className="account-hint">
        Dev tool: switch a unit&apos;s clean-room design variant. Applies live — baked sprites
        and the vector fallback follow the same selection.
      </p>
      {units.map(({ unit, slots }) => {
        const current = activeSlot(unit);
        return (
          <div className="settings-row" key={unit}>
            <div className="settings-row-text">
              <span className="settings-row-label">{unit.toUpperCase()}</span>
            </div>
            <div className="design-slot-tabs" role="radiogroup" aria-label={`${unit} design variant`}>
              {slots.map(slot => (
                <button
                  key={slot}
                  type="button"
                  role="radio"
                  aria-checked={current === slot}
                  className={`tab-btn ${current === slot ? 'active' : ''}`}
                  onClick={() => {
                    if (current === slot) return;
                    soundSystem.play('click');
                    setActiveSlot(unit, slot);
                  }}
                >
                  {slot}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * The settings menu behind the HUD gear, in pxf pixel-frame chrome:
 * account/session management plus audio. Every device starts as a guest
 * village; registering a username + password saves it to the server so it can
 * be loaded from any browser, and logging in loads an existing account here.
 */
export function AccountModal({ isOpen, currentUser, isOnline, onClose, onRename, onRegister, onLogin, onLogout, onReseedWorld }: AccountModalProps) {
  const registered = currentUser?.registered ?? false;

  const [tab, setTab] = useState<Tab>('profile');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reseedConfirming, setReseedConfirming] = useState(false);
  // Audio mirrors the HUD speaker button: both drive soundSystem, and the
  // 'clash:muted' window event (plus a re-read on open) keeps them in step.
  const [muted, setMuted] = useState(soundSystem.muted);

  const busy = busyAction !== null;

  // Reset transient state only when the modal opens. Depending on currentUser
  // here would wipe the form (and any success notice) the moment a register or
  // rename updates the profile while the modal is still open.
  useEffect(() => {
    if (!isOpen) return;
    setTab('profile');
    setUsername('');
    setPassword('');
    setConfirm('');
    setError(null);
    setNotice(null);
    setReseedConfirming(false);
    setMuted(soundSystem.muted);
  }, [isOpen]);

  // Keep the editable village-name field following the profile (rename and
  // register both change it) without clobbering the rest of the form.
  const profileUsername = currentUser?.username ?? '';
  useEffect(() => {
    if (!isOpen) return;
    setName(profileUsername);
  }, [isOpen, profileUsername]);

  if (!isOpen) return null;

  const switchTab = (next: Tab) => {
    setTab(next);
    setError(null);
    setNotice(null);
    setPassword('');
    setConfirm('');
    setReseedConfirming(false);
  };

  const run = async (key: BusyAction, action: () => Promise<void>, successNotice?: string) => {
    setBusyAction(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (successNotice) setNotice(successNotice);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusyAction(null);
    }
  };

  const toggleMuted = () => {
    const next = !soundSystem.muted;
    soundSystem.setMuted(next);
    setMuted(next);
    if (!next) soundSystem.play('click'); // audible confirmation on unmute
    // Keep the HUD speaker button in step (it listens for this event).
    window.dispatchEvent(new Event('clash:muted'));
  };

  const trimmedName = name.trim();
  const canRename = isOnline && !busy && trimmedName.length >= 3 && trimmedName !== currentUser?.username;
  const trimmedUsername = username.trim();
  const canRegister = isOnline && !busy && trimmedUsername.length >= 3 && password.length >= 8 && password === confirm;
  const canLogin = isOnline && !busy && trimmedUsername.length >= 3 && password.length > 0;

  const reseedWorld = () => {
    void run('reseed', async () => {
      const result = await onReseedWorld();
      setReseedConfirming(false);
      const generation = Number.isSafeInteger(result.seedVersion)
        ? ` (generation ${result.seedVersion})`
        : '';
      setNotice(
        `Generated world rebuilt${generation}. Removed ${result.removedGuests} guest village${result.removedGuests === 1 ? '' : 's'} `
        + `and kept ${result.preservedPlayers} player village${result.preservedPlayers === 1 ? '' : 's'}. Reloading…`
      );
    });
  };

  return (
    <div className="account-modal-backdrop">
      <div className="account-modal" role="dialog" aria-modal="true" aria-busy={busy}>
        <div className="account-modal-header">
          <h3>SETTINGS</h3>
          {busy && <span className="busy-pill">WORKING…</span>}
          <span className={`status-pill ${isOnline ? 'online' : 'offline'}`}>
            {isOnline ? 'ONLINE' : 'OFFLINE'}
          </span>
          <button className="pxf-close" onClick={onClose} disabled={busy} aria-label="Close settings"><span className="sym sym-close small" /></button>
        </div>

        {error && <div className="account-error" role="alert">{error}</div>}
        {notice && !error && <div className="account-warning" role="status">{notice}</div>}

        <section className="settings-section" aria-label="Account and session">
          <div className="settings-section-title">ACCOUNT &amp; SESSION</div>

          {!registered && (
            <div className="account-tabs">
              <button className={`tab-btn ${tab === 'profile' ? 'active' : ''}`} onClick={() => switchTab('profile')} disabled={busy}>
                PROFILE
              </button>
              <button className={`tab-btn ${tab === 'register' ? 'active' : ''}`} onClick={() => switchTab('register')} disabled={busy}>
                SAVE VILLAGE
              </button>
              <button className={`tab-btn ${tab === 'login' ? 'active' : ''}`} onClick={() => switchTab('login')} disabled={busy}>
                LOG IN
              </button>
            </div>
          )}

          {tab === 'profile' && (
            <form
              className="account-panel"
              onSubmit={(e) => {
                e.preventDefault();
                if (canRename) void run('rename', () => onRename(trimmedName), 'Name saved!');
              }}
            >
              <label>
                VILLAGE NAME
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Commander01"
                  maxLength={18}
                  disabled={!isOnline || busy}
                />
              </label>
              {currentUser && (
                <div className="account-meta">
                  <span><span className="sym sym-trophy small" /> {currentUser.trophies} trophies</span>
                </div>
              )}
              <button className="action-btn" type="submit" disabled={!canRename}>
                {busyAction === 'rename' ? 'SAVING…' : 'SAVE NAME'}
              </button>
              {registered ? (
                <>
                  <p className="account-hint">
                    Signed in as <strong>{currentUser?.username}</strong>. Your village is saved to your
                    account — log in from any device to load it.
                  </p>
                  <button
                    type="button"
                    className="logout-btn"
                    disabled={busy}
                    onClick={() => void run('logout', onLogout)}
                  >
                    {busyAction === 'logout' ? 'LOGGING OUT…' : 'LOG OUT'}
                  </button>
                </>
              ) : (
                <p className="account-hint">
                  This village is only tied to this browser. Use SAVE VILLAGE to protect it with a
                  username and password, or LOG IN to load an existing account.
                </p>
              )}
            </form>
          )}

          {tab === 'register' && !registered && (
            <form
              className="account-panel"
              onSubmit={(e) => {
                e.preventDefault();
                if (canRegister) {
                  void run('register', async () => {
                    await onRegister(trimmedUsername, password);
                    setTab('profile');
                  }, 'Village saved! You can now log in from any device.');
                }
              }}
            >
              <label>
                USERNAME
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="3-18 letters, numbers, _ or -"
                  maxLength={18}
                  autoComplete="username"
                  disabled={!isOnline || busy}
                />
              </label>
              <label>
                PASSWORD
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  disabled={!isOnline || busy}
                />
              </label>
              <label>
                CONFIRM PASSWORD
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat password"
                  autoComplete="new-password"
                  disabled={!isOnline || busy}
                />
              </label>
              {password.length > 0 && confirm.length > 0 && password !== confirm && (
                <p className="account-hint">Passwords do not match.</p>
              )}
              <button className="action-btn" type="submit" disabled={!canRegister}>
                {busyAction === 'register' ? 'SAVING…' : 'CREATE ACCOUNT'}
              </button>
              <p className="account-hint">
                Keeps your current village exactly as it is — it just becomes loadable from anywhere.
              </p>
            </form>
          )}

          {tab === 'login' && !registered && (
            <form
              className="account-panel"
              onSubmit={(e) => {
                e.preventDefault();
                if (canLogin) void run('login', () => onLogin(trimmedUsername, password));
              }}
            >
              <label>
                USERNAME
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Your account username"
                  maxLength={18}
                  autoComplete="username"
                  disabled={!isOnline || busy}
                />
              </label>
              <label>
                PASSWORD
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your password"
                  autoComplete="current-password"
                  disabled={!isOnline || busy}
                />
              </label>
              <button className="action-btn" type="submit" disabled={!canLogin}>
                {busyAction === 'login' ? 'LOGGING IN…' : 'LOG IN'}
              </button>
              <p className="account-hint">
                Loads that account's village on this device. This browser's guest village stays behind
                on the server.
              </p>
            </form>
          )}
        </section>

        <section className="settings-section" aria-label="Audio">
          <div className="settings-section-title">AUDIO</div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label">SOUND &amp; MUSIC</span>
              <span className="settings-row-hint">
                Master switch for music, ambience and effects — the HUD speaker is the same switch.
              </span>
            </div>
            <button
              type="button"
              className={`px-toggle ${muted ? '' : 'on'}`}
              role="switch"
              aria-checked={!muted}
              aria-label="Sound and music"
              disabled={busy}
              onClick={toggleMuted}
            >
              <i className="px-toggle-knob" />
              <span className="px-toggle-state">{muted ? 'OFF' : 'ON'}</span>
            </button>
          </div>
        </section>

        {import.meta.env.DEV && <DesignLabSection />}

        {import.meta.env.DEV && (
          <section className="settings-section dev-world-tools" aria-label="Development world tools">
            <div className="dev-world-tools-title">DEVELOPMENT WORLD</div>
            <p className="account-hint">
              Regenerates every non-player village and wilderness—including lakes, rivers, roads, scenery,
              and residents. Keeps this village and all registered players; removes other guest villages.
            </p>
            {reseedConfirming ? (
              <div className="dev-reseed-confirm" role="alert">
                <p>This rebuilds the whole generated world and removes every other guest village. It cannot be undone.</p>
                <div className="dev-reseed-actions">
                  <button
                    type="button"
                    className="dev-reseed-cancel"
                    disabled={busy}
                    onClick={() => setReseedConfirming(false)}
                  >
                    CANCEL
                  </button>
                  <button
                    type="button"
                    className="dev-reseed-confirm-btn"
                    disabled={!isOnline || busy}
                    onClick={reseedWorld}
                  >
                    {busyAction === 'reseed' ? 'RESEEDING…' : 'CONFIRM RESEED'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="dev-reseed-world-btn"
                disabled={!isOnline || busy}
                onClick={() => {
                  setError(null);
                  setNotice(null);
                  setReseedConfirming(true);
                }}
              >
                RESEED GENERATED WORLD
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
