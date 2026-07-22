import { useState, useEffect, useRef } from 'react';
import { Backend, type AttackNotification } from '../game/backend/GameBackend';
import { formatGold } from '../game/economy/Currency';
import { soundSystem } from '../game/systems/SoundSystem';

interface NotificationsPanelProps {
  userId: string;
  isOnline: boolean;
  incomingAttack?: { attackId: string; attackerName: string } | null;
  onWatchLive?: (attackId: string, attackerName: string) => void;
  onWatchReplay?: (attackId: string, attackerName: string) => void;
  onRevenge?: (attackerId: string, attackerName: string) => void;
}

export function NotificationsPanel({ userId, isOnline, incomingAttack, onWatchLive, onWatchReplay, onRevenge }: NotificationsPanelProps) {
  const [notifications, setNotifications] = useState<AttackNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const panelRefreshSequence = useRef(0);

  useEffect(() => {
    if (!isOnline || isOpen) return;
    let cancelled = false;

    const loadNotifications = async () => {
      if (document.hidden) return;
      try {
        const count = await Backend.getUnreadNotificationCount(userId);
        if (!cancelled) setUnreadCount(count);
      } catch {
        // Keep the last good badge through an outage.
      }
    };

    loadNotifications();
    // Poll for new notifications every 30 seconds
    const interval = setInterval(loadNotifications, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [userId, isOnline, isOpen]);

  useEffect(() => () => {
    panelRefreshSequence.current += 1;
  }, [userId, isOnline]);

  // Open FIRST, fetch and mark-read together: waiting on a slow network before
  // showing the dropdown makes the bell feel dead. If the read write fails,
  // the freshly fetched list restores the honest unread badge and keeps the
  // manual retry available.
  const refreshPanel = (markRead: boolean) => {
    const sequence = ++panelRefreshSequence.current;
    setIsLoading(true);
    setLoadError(false);
    void (async () => {
      const [listResult, readResult] = await Promise.allSettled([
        Backend.getNotifications(userId),
        markRead ? Backend.markNotificationsRead(userId) : Promise.resolve(),
      ]);
      if (sequence !== panelRefreshSequence.current) return;
      const markedRead = markRead && readResult.status === 'fulfilled';

      if (listResult.status === 'fulfilled') {
        const notifs = listResult.value;
        setNotifications(markedRead
          ? notifs.map(n => ({ ...n, read: true }))
          : notifs);
        setUnreadCount(markedRead
          ? 0
          : notifs.filter(n => !n.read).length);
      } else {
        setLoadError(true);
      }
      if (listResult.status === 'rejected' && markedRead) {
        // The server accepted the read even if the list refresh failed.
        setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        setUnreadCount(0);
      }
      setIsLoading(false);
    })();
  };

  const handleOpen = () => {
    if (!isOnline) return;
    soundSystem.play('uiOpen');
    setIsOpen(true);
    refreshPanel(true);
  };

  const handleClose = () => {
    panelRefreshSequence.current += 1;
    setIsLoading(false);
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
      <button
        className="notifications-btn"
        onClick={handleOpen}
        title="Notifications"
        aria-label="Notifications"
        aria-expanded={isOpen}
      >
        <div className="btn-icon icon bell-icon"></div>
        {unreadCount > 0 && (
          <span className="notification-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
        )}
      </button>

      {isOpen && (
        <>
          <div className="notifications-backdrop" onClick={() => { soundSystem.play('uiClose'); handleClose(); }}></div>
          <div className="notifications-dropdown">
            <div className="notifications-header">
              <h3>NOTIFICATIONS &amp; REPLAYS</h3>
              {notifications.some(n => !n.read) && (
                <button className="mark-read-btn" onClick={() => { soundSystem.play('uiTap'); void handleMarkAllRead(); }}>
                  Mark all read
                </button>
              )}
            </div>

            {/* One event, one surface; history goes to the bell: the pxf
                incoming-attack card (App.tsx) is the popup surface — this
                LIVE row lands here SILENTLY as history (badge only, no
                popup duplication, no toast). */}
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

            {loadError && (
              <div className="notification-load-error" role="alert">
                <span>Notifications and replays could not be loaded.</span>
                <button
                  type="button"
                  className="watch-live-btn"
                  disabled={isLoading}
                  onClick={() => { soundSystem.play('uiTap'); refreshPanel(false); }}
                >
                  {isLoading ? 'RETRYING…' : 'RETRY'}
                </button>
              </div>
            )}

            {notifications.length === 0 && !incomingAttack && !loadError ? (
              <div className="no-notifications">
                {isLoading ? 'Consulting the watch…' : 'No attacks yet. Your base is safe!'}
              </div>
            ) : (
              notifications.map(notif => {
                if (notif.kind === 'admin_notice') {
                  return (
                    <div
                      key={notif.id}
                      className={`notification-item admin-notice ${notif.severity ?? 'info'} ${!notif.read ? 'unread' : ''}`}
                    >
                      <div className="admin-notice-label">
                        {notif.severity === 'critical' ? 'URGENT NOTICE' : notif.severity === 'warning' ? 'KINGDOM WARNING' : 'KINGDOM NOTICE'}
                      </div>
                      <div className="attacker">{notif.title || 'Message from the keep'}</div>
                      <div className="admin-notice-message">{notif.message || 'The keep has sent an update.'}</div>
                      <div className="timestamp">{formatTimeAgo(notif.timestamp)}</div>
                    </div>
                  );
                }
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
                        // App owns the same army gate as every other rewarding
                        // attack — and plays confirm/denied feedback there too.
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
