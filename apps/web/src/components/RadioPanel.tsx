import { RadioListSchema, type RadioStation } from '@gbg-osint/shared';
import { useEffect, useState } from 'react';
import { fetchJson } from '../state/api';

interface RadioPanelProps {
  playing: RadioStation | null;
  onPlay(station: RadioStation | null): void;
}

/** Live radio from Sveriges Radio and community stations around Gothenburg. */
export function RadioPanel({ playing, onPlay }: RadioPanelProps) {
  const [stations, setStations] = useState<readonly RadioStation[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchJson('/api/data/radio.stations/stations.json', RadioListSchema, controller.signal).then(
      (list) => setStations(list.stations),
      () => {
        if (!controller.signal.aborted) setError(true);
      },
    );
    return () => controller.abort();
  }, []);

  if (error) return <p className="empty">The station list is unavailable right now.</p>;
  if (!stations) return <p className="empty">Loading stations…</p>;
  return (
    <div className="radio">
      <ol className="radio-list">
        {stations.map((s) => {
          const active = playing?.id === s.id;
          return (
            <li key={s.id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onPlay(active ? null : s)}
                aria-label={`${active ? 'Stop' : 'Play'} ${s.name}`}
              >
                {active ? '■' : '▶'}
              </button>
              <span className="radio-name">{s.name}</span>
              <span className="muted">
                {s.provider === 'Sveriges Radio' ? 'SR' : 'community'}
                {s.bitrateKbps ? ` · ${s.bitrateKbps} kbps` : ''}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="muted small">
        Streams play directly from the broadcasters. Station list: Sveriges Radio open API and
        radio-browser.info.
      </p>
    </div>
  );
}
