import { useEffect, useState } from 'react';
import type { DevWorldReseedResult } from '../game/backend/Auth';

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

/**
 * Village profile and account access. Every device starts as a guest village;
 * registering a username + password saves it to the server so it can be loaded
 * from any browser, and logging in loads an existing account here.
 */
export function AccountModal({ isOpen, currentUser, isOnline, onClose, onRename, onRegister, onLogin, onLogout, onReseedWorld }: AccountModalProps) {
  const registered = currentUser?.registered ?? false;

  const [tab, setTab] = useState<Tab>('profile');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reseedConfirming, setReseedConfirming] = useState(false);

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

  const run = async (action: () => Promise<void>, successNotice?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (successNotice) setNotice(successNotice);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const trimmedName = name.trim();
  const canRename = isOnline && !busy && trimmedName.length >= 3 && trimmedName !== currentUser?.username;
  const trimmedUsername = username.trim();
  const canRegister = isOnline && !busy && trimmedUsername.length >= 3 && password.length >= 8 && password === confirm;
  const canLogin = isOnline && !busy && trimmedUsername.length >= 3 && password.length > 0;

  const reseedWorld = () => {
    void run(async () => {
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
      <div className="account-modal">
        <div className="account-modal-header">
          <h3>VILLAGE PROFILE</h3>
          <span className={`status-pill ${isOnline ? 'online' : 'offline'}`}>
            {isOnline ? 'ONLINE' : 'OFFLINE'}
          </span>
          <button className="account-close" onClick={onClose} disabled={busy}>✕</button>
        </div>

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

        {error && <div className="account-error" role="alert">{error}</div>}
        {notice && !error && <div className="account-warning" role="status">{notice}</div>}

        {tab === 'profile' && (
          <form
            className="account-panel"
            onSubmit={(e) => {
              e.preventDefault();
              if (canRename) void run(() => onRename(trimmedName), 'Name saved!');
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
              SAVE NAME
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
                  onClick={() => void run(onLogout)}
                >
                  LOG OUT
                </button>
              </>
            ) : (
              <p className="account-hint">
                This village is only tied to this browser. Use SAVE VILLAGE to protect it with a
                username and password, or LOG IN to load an existing account.
              </p>
            )}
            {import.meta.env.DEV && (
              <section className="dev-world-tools" aria-label="Development world tools">
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
                        {busy ? 'RESEEDING…' : 'CONFIRM RESEED'}
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
          </form>
        )}

        {tab === 'register' && !registered && (
          <form
            className="account-panel"
            onSubmit={(e) => {
              e.preventDefault();
              if (canRegister) {
                void run(async () => {
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
              {busy ? 'SAVING…' : 'CREATE ACCOUNT'}
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
              if (canLogin) void run(() => onLogin(trimmedUsername, password));
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
              {busy ? 'LOGGING IN…' : 'LOG IN'}
            </button>
            <p className="account-hint">
              Loads that account's village on this device. This browser's guest village stays behind
              on the server.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
