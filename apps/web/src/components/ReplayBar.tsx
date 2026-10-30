import type { HistoryRange } from '@gbg-osint/shared';
import { useEffect, useState } from 'react';
import { REPLAY_SPEEDS, type ReplayState } from '../state/replay';

const STEP_MS = 15 * 60_000;
const moment = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ${min % 60} min ago` : `${Math.floor(h / 24)} d ${h % 24} h ago`;
}

interface ReplayBarProps {
  replay: ReplayState;
  range: HistoryRange | null;
  /** The moment on screen, which lags `replay.t` while it loads. */
  shownT: number | null;
  onChange(next: Partial<ReplayState>): void;
  onLive(): void;
}

/** Timeline to scrub and play back the last days: events, ships, aircraft, trains and readings. */
export function ReplayBar({ replay, range, shownT, onChange, onLive }: ReplayBarProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const from = range?.from ?? replay.t;
  const to = Math.max(range?.to ?? replay.t, replay.t);
  const seek = (t: number) => onChange({ t: Math.min(to, Math.max(from, t)) });
  return (
    <div className="replay-bar" role="group" aria-label="Replay">
      <span className="replay-badge">REPLAY</span>
      <button type="button" onClick={() => seek(replay.t - STEP_MS)} title="Back 15 minutes">
        −15m
      </button>
      <button
        type="button"
        onClick={() => onChange({ playing: !replay.playing })}
        aria-label={replay.playing ? 'Pause' : 'Play'}
      >
        {replay.playing ? '❚❚' : '▶'}
      </button>
      <button type="button" onClick={() => seek(replay.t + STEP_MS)} title="Forward 15 minutes">
        +15m
      </button>
      <input
        type="range"
        min={from}
        max={to}
        step={60_000}
        value={replay.t}
        disabled={range?.from == null}
        onChange={(e) => onChange({ t: Number(e.target.value), playing: false })}
        aria-label="Replayed moment"
      />
      <span className="replay-time">
        {moment.format(new Date(replay.t))}
        <span className="muted">
          {' '}
          {range?.from == null
            ? 'no history yet'
            : shownT === replay.t
              ? ago(Math.max(0, now.getTime() - replay.t))
              : 'loading…'}
        </span>
      </span>
      <select
        value={replay.speed}
        onChange={(e) => onChange({ speed: Number(e.target.value) })}
        aria-label="Playback speed"
      >
        {REPLAY_SPEEDS.map((s) => (
          <option key={s.speed} value={s.speed}>
            {s.label}
          </option>
        ))}
      </select>
      <button type="button" onClick={onLive} title="Back to live (P)">
        Live
      </button>
    </div>
  );
}
