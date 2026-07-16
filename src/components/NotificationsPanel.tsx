import { useState, useEffect } from 'react';
import { Backend } from '../game/backend/GameBackend';
import { formatGold } from '../game/economy/Currency';

interface Notification {
  id: string;
  attackId?: string;
  attackerId?: string;
  attackerName: string;
  goldLost?: number;
  oreLost?: number;
  foodLost?: number;
  destruction: number;
  timestamp: number;
  read: boolean;
  replayAvailable?: boolean;
}

interface NotificationsPanelProps {
  userId: string;
  isOnline: boolean;
  incomingAttack?: { attackId: string; attackerName: string } | null;
  onWatchLive?: (attackId: string, attackerName: string) => void;
  onWatchReplay?: (attackId: string, attackerName: string) => void;
  onRevenge?: (attackerId: string, attackerName: string) => void;
}

export function NotificationsPanel({ userId, isOnline, incomingAttack, onWatchLive, onWatchReplay, onRevenge }: NotificationsPanelProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isOnline) return;

    const loadNotifications = async () => {
      if (document.hidden) return;
      try {
        const count = await Backend.getUnreadNotificationCount(userId);
        setUnreadCount(count);
      } catch {
        // Keep the last good badge through an outage.
      }
    };

    loadNotifications();
    // Poll for new notifications every 30 seconds
    const interval = setInterval(loadNotifications, 30000);
    return () => clearInterval(interval);
  }, [userId, isOnline]);

  // Open FIRST, fetch after: waiting on a slow network before showing the
  // dropdown makes the bell feel dead. The list refreshes in place, and the
  // badge re-anchors from the fresh list.
  const handleOpen = () => {
    if (!isOnline) return;
    setIsOpen(true);
    setIsLoading(true);
    void (async () => {
      try {
        const notifs = await Backend.getNotifications(userId);
        setNotifications(notifs);
        setUnreadCount(notifs.filter(n => !n.read).length);
      } catch {
        // Network blip: stay open with whatever we already have.
      } finally {
        setIsLoading(false);
      }
    })();
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  const handleMarkAllRead = async () => {
    try {
      await Backend.markNotificationsRead(userId);
    } catch {
      return; // keep the badge honest if the server never heard it
    }
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);
  };

  const formatTimeAgo = (timestamp: number): string => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  if (!isOnline) return null;

  return (
    <div className="notifications-container">
      <button className="notifications-btn" onClick={handleOpen}>
        <div className="btn-icon icon bell-icon"></div>
        {unreadCount > 0 && (
          <span className="notification-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
        )}
      </button>

      {isOpen && (
        <>
          <div className="notifications-backdrop" onClick={handleClose}></div>
          <div className="notifications-dropdown">
            <div className="notifications-header">
              <h3>DEFENSE LOG</h3>
              {notifications.some(n => !n.read) && (
                <button className="mark-read-btn" onClick={handleMarkAllRead}>
                  Mark all read
                </button>
              )}
            </div>

            {incomingAttack && onWatchLive && (
              <div className="notification-item live-attack">
                <div className="live-indicator">LIVE</div>
                <div className="attacker">{incomingAttack.attackerName} is attacking!</div>
                <button
                  className="watch-live-btn"
                  onClick={() => {
                    onWatchLive(incomingAttack.attackId, incomingAttack.attackerName);
                    handleClose();
                  }}
                >
                  WATCH LIVE
                </button>
              </div>
            )}

            {notifications.length === 0 && !incomingAttack ? (
              <div className="no-notifications">
                {isLoading ? 'Consulting the watch…' : 'No attacks yet. Your base is safe!'}
              </div>
            ) : (
              notifications.map(notif => {
                const goldLost = notif.goldLost ?? 0;
                return (
                <div key={notif.id} className={`notification-item ${!notif.read ? 'unread' : ''}`}>
                  <div className="attacker">{notif.attackerName} raided you!</div>
                  <div className="loot-info">
                    <span className="loot-amount">
                      <span className="icon gold-icon"></span>
                      -{formatGold(goldLost, false, false)}
                    </span>
                    {(notif.oreLost ?? 0) > 0 && (
                      <span className="loot-amount"><span className="icon ore-icon"></span>-{notif.oreLost}</span>
                    )}
                    {(notif.foodLost ?? 0) > 0 && (
                      <span className="loot-amount"><span className="icon food-icon"></span>-{notif.foodLost}</span>
                    )}
                    <span>{notif.destruction}% destroyed</span>
                  </div>
                  <div className="timestamp">{formatTimeAgo(notif.timestamp)}</div>
                  {notif.replayAvailable && notif.attackId && onWatchReplay && (
                    <button
                      className="watch-live-btn"
                      onClick={() => {
                        onWatchReplay(notif.attackId!, notif.attackerName);
                        handleClose();
                      }}
                    >
                      WATCH REPLAY
                    </button>
                  )}
                  {notif.attackerId && onRevenge && (
                    <button
                      className="watch-live-btn revenge-btn"
                      onClick={() => {
                        // App owns the same army gate as every other rewarding attack.
                        onRevenge(notif.attackerId!, notif.attackerName);
                        handleClose();
                      }}
                    >
                      <span className="sym sym-swords small" /> REVENGE
                    </button>
                  )}
                </div>
              );
            })
            )}
          </div>
        </>
      )}
    </div>
  );
}
