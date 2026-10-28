import type { RadarState } from '../engine/radar';
import type { TourState } from '../engine/tours';
import { useStore, type Store } from '../state/store';

const clock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});

const minutes = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

interface RadarTimelineProps {
  store: Store<RadarState>;
  onPlay(playing: boolean): void;
  onSeek(index: number): void;
}

/** Frame time, play/pause and a scrubber for the radar loop. */
export function RadarTimeline({ store, onPlay, onSeek }: RadarTimelineProps) {
  const radar = useStore(store);
  if (radar.count === 0) return null;
  const behindMin =
    radar.ts && radar.latest
      ? Math.round((Date.parse(radar.latest) - Date.parse(radar.ts)) / 60_000)
      : 0;
  return (
    <div className="radar-timeline" role="group" aria-label="Precipitation radar">
      <button
        type="button"
        onClick={() => onPlay(!radar.playing)}
        aria-label={radar.playing ? 'Pause radar' : 'Play radar'}
      >
        {radar.playing ? '❚❚' : '▶'}
      </button>
      <input
        type="range"
        min={0}
        max={radar.count - 1}
        value={radar.index}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label="Radar frame"
      />
      <span className="radar-time">
        RADAR {radar.ts ? clock.format(new Date(radar.ts)) : '--:--'}
        <span className="muted"> {behindMin > 0 ? `−${behindMin} min` : 'latest'}</span>
      </span>
      <span className="radar-legend" aria-label="Light to heavy precipitation" />
    </div>
  );
}

/** Progress of the camera tour that is playing. */
export function TourBar({ store, onStop }: { store: Store<TourState | null>; onStop(): void }) {
  const tour = useStore(store);
  if (!tour) return null;
  return (
    <div className="tour-bar" role="status">
      <span>▶ {tour.title}</span>
      <span className="muted">
        {minutes(tour.elapsed)} / {minutes(tour.duration)}
      </span>
      <button type="button" onClick={onStop}>
        Stop (Esc)
      </button>
    </div>
  );
}
