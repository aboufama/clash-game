import { useEffect, useMemo, useRef, useState } from 'react';

const SAMPLE_MS = 1000;
const HISTORY_MINUTES = 3;
const MAX_SAMPLES = Math.max(1, Math.floor((HISTORY_MINUTES * 60 * 1000) / SAMPLE_MS));
const GRAPH_WIDTH = 320;
const GRAPH_HEIGHT = 120;

interface DebugMenuProps {
  isOpen: boolean;
}

interface FpsStats {
  current: number;
  min: number;
  max: number;
  avg: number;
  low: number;
}

export function DebugMenu({ isOpen }: DebugMenuProps) {
  const [history, setHistory] = useState<number[]>([]);
  const [stats, setStats] = useState<FpsStats>({
    current: 0,
    min: 0,
    max: 0,
    avg: 0,
    low: 0
  });
  const historyRef = useRef<number[]>([]);
  const frameCountRef = useRef(0);
  const fpsSumRef = useRef(0);

  useEffect(() => {
    // Only sample while the overlay is visible — otherwise this rAF loop (and its
    // 1Hz state updates) would run for the entire session for a hidden panel.
    if (!isOpen) return;

    let rafId = 0;
    let lastTime = performance.now();
    let lastSampleTime = lastTime;

    const tick = (now: number) => {
      const delta = now - lastTime;
      lastTime = now;
      const fps = delta > 0 ? 1000 / delta : 0;
      frameCountRef.current += 1;
      fpsSumRef.current += fps;

      if (now - lastSampleTime >= SAMPLE_MS) {
        const sample = fpsSumRef.current / Math.max(1, frameCountRef.current);
        const updated = [...historyRef.current, sample].slice(-MAX_SAMPLES);
        historyRef.current = updated;

        const min = Math.min(...updated);
        const max = Math.max(...updated);
        const avg = updated.reduce((sum, val) => sum + val, 0) / updated.length;
        const sorted = [...updated].sort((a, b) => a - b);
        const lowIndex = Math.max(0, Math.floor(sorted.length * 0.05) - 1);
        const low = sorted[lowIndex] ?? sample;

        setHistory(updated);
        setStats({ current: sample, min, max, avg, low });

        frameCountRef.current = 0;
        fpsSumRef.current = 0;
        lastSampleTime = now;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isOpen]);

  const peak = history.length > 0 ? Math.max(...history) : 60;
  const maxFps = Math.max(60, Math.ceil(peak / 10) * 10);
  const points = useMemo(() => {
    if (history.length < 2) return '';
    const span = Math.max(1, history.length - 1);
    return history
      .map((value, index) => {
        const x = (index / span) * GRAPH_WIDTH;
        const y = GRAPH_HEIGHT - Math.min(1, value / maxFps) * GRAPH_HEIGHT;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [history, maxFps]);

  return (
    <div className={`debug-menu ${isOpen ? 'open' : ''}`}>
      <div className="debug-header">
        <div className="debug-title">DEBUG</div>
        <div className="debug-hint">Press P to toggle</div>
      </div>
      <div className="debug-stats">
        <div className="debug-stat">FPS {Math.round(stats.current)}</div>
        <div className="debug-stat">AVG {Math.round(stats.avg)}</div>
        <div className="debug-stat">LOW {Math.round(stats.low)}</div>
        <div className="debug-stat">MIN {Math.round(stats.min)}</div>
        <div className="debug-stat">MAX {Math.round(stats.max)}</div>
      </div>
      <div className="debug-graph-label">HISTORY {HISTORY_MINUTES}M @ {SAMPLE_MS / 1000}s</div>
      <svg className="debug-graph" viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} preserveAspectRatio="none">
        <line x1="0" y1={GRAPH_HEIGHT} x2={GRAPH_WIDTH} y2={GRAPH_HEIGHT} />
        <line x1="0" y1={GRAPH_HEIGHT * 0.5} x2={GRAPH_WIDTH} y2={GRAPH_HEIGHT * 0.5} />
        <line x1="0" y1="0" x2={GRAPH_WIDTH} y2="0" />
        {points && <polyline points={points} />}
      </svg>
      <div className="debug-graph-scale">0 - {maxFps} FPS</div>
    </div>
  );
}
