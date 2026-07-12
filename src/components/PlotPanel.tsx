import { useRef } from 'react';
import type { PlotPanelInfo, PlotPanelAction } from '../game/GameManager';
import { useWorldAnchor } from '../ui/useWorldAnchor';

interface PlotPanelProps {
  info: PlotPanelInfo | null;
  onAction: (action: PlotPanelAction) => void;
  onClose: () => void;
}

/**
 * The world-map neighbour sheet — a pixel-art speech bubble hanging over the
 * tapped village. It stays in the DOM for fixed-size readability and accessible
 * actions, framed by the same generated pixel borders as the rest of the UI and
 * pinned to the plot through pan/zoom by useWorldAnchor.
 */
const PLOT_ACTION_ICON: Record<PlotPanelAction['kind'], string> = {
  attack: 'sym-swords',
  scout: 'sym-eye',
  watch: 'sym-watch',
  settle: 'sym-home',
  info: 'sym-shield'
};

export function PlotPanel({ info, onAction, onClose }: PlotPanelProps) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  useWorldAnchor(bubbleRef, info?.anchor ?? null, { clampMargin: { x: 150, top: 90, bottom: 60 }, flipBelowY: info?.anchorBelow?.y });
  if (!info) return null;
  const anchored = Boolean(info.anchor);
  return (
    <div className="plot-overlay-clear" onClick={onClose}>
      <div
        ref={bubbleRef}
        className={`plot-bubble ${anchored ? 'anchored' : 'centered'}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="plot-title">
          <span className="plot-title-name">
            {info.title}
            {info.trophies !== undefined && (
              <span className="plot-trophies"><span className="sym sym-trophy small" />{info.trophies}</span>
            )}
          </span>
        </div>
        <div className="plot-actions">
          {info.actions.map((action, i) => (
            <button
              key={i}
              className={`plot-action ${action.kind}`}
              onClick={() => onAction(action)}
            >
              <span className={`sym small ${PLOT_ACTION_ICON[action.kind]}`} />
              {action.label}
            </button>
          ))}
        </div>
        <span className="px-tail" />
      </div>
    </div>
  );
}
