import { useState } from 'react';
import { soundSystem } from '../game/systems/SoundSystem';

interface AuthGateProps {
  onLogin: (username: string, password: string) => Promise<void>;
  onCreate: (username: string, password: string) => Promise<void>;
}

type GateAction = 'login' | 'create';

/**
 * The required account gate (production): a fresh device gets NO village
 * until it registers or logs in — this full-screen pxf panel is all it sees.
 * Exactly two fields (username + password) shared by both actions; LOG IN is
 * the form submit, CREATE ACCOUNT registers the same credentials as a brand
 * new account. The parent owns what "success" means (adopting the session);
 * this component owns busy/error presentation.
 */
export function AuthGate({ onLogin, onCreate }: AuthGateProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busyAction, setBusyAction] = useState<GateAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = busyAction !== null;
  const trimmedUsername = username.trim();
  const canLogin = !busy && trimmedUsername.length >= 3 && password.length > 0;
  const canCreate = !busy && trimmedUsername.length >= 3 && password.length >= 8;

  const run = (action: GateAction, task: () => Promise<void>) => {
    soundSystem.play('confirm');
    setBusyAction(action);
    setError(null);
    void task()
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Something went wrong — try again.');
        // Only re-arm the form on failure: on success this gate unmounts.
        setBusyAction(null);
      });
  };

  return (
    <div className="auth-lock-overlay">
      <div className="auth-gate-panel" role="dialog" aria-modal="true" aria-busy={busy}>
        <h2>CLAIM YOUR VILLAGE</h2>
        <p className="auth-gate-sub">
          An account is required to play — just a username and a password.
          Log in, or create a new account to found your village.
        </p>

        {error && <div className="account-error" role="alert">{error}</div>}

        <form
          className="account-panel"
          onSubmit={(e) => {
            e.preventDefault();
            if (canLogin) run('login', () => onLogin(trimmedUsername, password));
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
              autoFocus
              disabled={busy}
            />
          </label>
          <label>
            PASSWORD
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="current-password"
              disabled={busy}
            />
          </label>
          <div className="auth-gate-actions">
            <button type="submit" className="auth-gate-btn" disabled={!canLogin}>
              {busyAction === 'login' ? 'LOGGING IN…' : 'LOG IN'}
            </button>
            <button
              type="button"
              className="auth-gate-btn primary"
              disabled={!canCreate}
              onClick={() => run('create', () => onCreate(trimmedUsername, password))}
            >
              {busyAction === 'create' ? 'CREATING…' : 'CREATE ACCOUNT'}
            </button>
          </div>
          <p className="account-hint">
            New here? Pick a username, choose a password of 8+ characters and hit
            CREATE ACCOUNT — your village loads from any device you log into.
          </p>
        </form>
      </div>
    </div>
  );
}
