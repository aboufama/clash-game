import { useEffect, useState } from 'react';
import { Backend, type AttackNotification } from '../game/backend/GameBackend';

interface ReplayTheatreModalProps {
  userId: string;
  onWatch: (attackId: string, attackerName: string) => void;
  onClose: () => void;
}

/**
 * The replay theatre — every recorded defence of your village, ready to
 * watch again. A plain pixel-panel list for now (the bonfire storyteller
 * can inherit it later).
 */
export function ReplayTheatreModal({ userId, onWatch, onClose }: ReplayTheatreModalProps) {
  const [items, setItems] = useState<AttackNotification[] | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void Backend.getNotifications(userId).then(all => {
      if (!cancelled) {
        setItems(all.filter(n => n.replayAvailable && n.attackId));
        setError(false);
      }
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => { cancelled = true; };
  }, [userId, reload]);

  const retry = () => {
    setItems(null);
    setError(false);
    setReload(value => value + 1);
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const age = (t: number) => {
    const mins = Math.max(1, Math.round((now - t) / 60_000));
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="theatre-modal" onClick={e => e.stopPropagation()}>
        <div className="atlas-title">
          <span className="sym sym-watch small" />
          <span>REPLAY THEATRE</span>
          <span className="atlas-count">
            {error ? 'unavailable' : items === null ? 'rewinding…' : `${items.length} battle${items.length === 1 ? '' : 's'}`}
          </span>
          <button className="plot-close" onClick={onClose} aria-label="Close">
            <span className="sym sym-close small" />
          </button>
        </div>
        <div className="theatre-list">
          {error && (
            <div className="theatre-empty">
              The battle records could not be loaded.
              {' '}
              <button className="theatre-watch" onClick={retry}>RETRY</button>
            </div>
          )}
          {items !== null && items.length === 0 && (
            <div className="theatre-empty">No battles on record yet — peace, for now.</div>
          )}
          {(items ?? []).map(n => (
            <div key={n.id} className="theatre-item">
              <span className="theatre-who">{n.attackerName}</span>
              <span className={`theatre-outcome ${n.destruction >= 50 ? 'lost' : 'held'}`}>
                {n.destruction}% {n.destruction >= 50 ? 'razed' : 'held'}
              </span>
              <span className="theatre-when">{age(n.timestamp)}</span>
              <button
                className="theatre-watch"
                onClick={() => { onWatch(n.attackId!, n.attackerName); onClose(); }}
              >
                <span className="sym sym-watch small" /> WATCH
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
