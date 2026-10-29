import { useState } from 'react';
import {
  formatArea,
  formatDistance,
  formatDuration,
  pathLengthM,
  polygonAreaM2,
} from '../layers/measure';
import type { RouteProfile, ToolMode, ToolsApi } from '../state/tools';
import type { WatchAlert } from '../state/watch';

const MODES: readonly [ToolMode, string][] = [
  ['measure', 'Measure'],
  ['pin', 'Pins'],
  ['route', 'Route A→B'],
  ['watch', 'Watch'],
];
const PROFILES: readonly [RouteProfile, string][] = [
  ['foot', 'Walk'],
  ['bike', 'Bike'],
  ['car', 'Car'],
];

/** Measure, pin, route and watch tools; while one is active, map clicks place points. */
export function ToolsPanel({ tools, watch, onClose }: ToolsPanelProps) {
  const { mode, measure, pins, routeEnds, route } = tools;
  return (
    <section className="tools-panel" aria-label="Map tools">
      <header>
        <div className="segmented" role="group" aria-label="Tool">
          {MODES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={mode === id}
              onClick={() => tools.setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} aria-label="Close tools">
          ✕
        </button>
      </header>

      {mode === 'measure' && (
        <div className="tool-body">
          <p className="muted">Click points on the map; three or more also give an area.</p>
          <p>
            {measure.length < 2 ? 'Distance —' : `Distance ${formatDistance(pathLengthM(measure))}`}
            {measure.length >= 3 && ` · Area ${formatArea(polygonAreaM2(measure))}`}
          </p>
          <button
            type="button"
            onClick={() => tools.clear('measure')}
            disabled={measure.length === 0}
          >
            Clear
          </button>
        </div>
      )}

      {mode === 'pin' && (
        <div className="tool-body">
          <p className="muted">Click to drop pins. They are kept in this browser only.</p>
          <p>{pins.length} pins</p>
          <button type="button" onClick={() => tools.clear('pin')} disabled={pins.length === 0}>
            Clear pins
          </button>
        </div>
      )}

      {mode === 'route' && (
        <div className="tool-body">
          <div className="segmented" role="group" aria-label="Travel mode">
            {PROFILES.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={tools.profile === id}
                onClick={() => tools.setProfile(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="muted">
            {routeEnds.length === 0
              ? 'Click the start (A).'
              : routeEnds.length === 1
                ? 'Click the destination (B).'
                : 'Click again to start a new route.'}
          </p>
          {route.loading && <p>Finding a route…</p>}
          {route.error && <p>{route.error}</p>}
          {route.result && (
            <p>
              {formatDistance(route.result.distanceM)} · about{' '}
              {formatDuration(route.result.durationS)}
            </p>
          )}
          <button
            type="button"
            onClick={() => tools.clear('route')}
            disabled={routeEnds.length === 0}
          >
            Clear
          </button>
          <p className="muted small">
            Routing: OSRM via FOSSGIS · © OpenStreetMap contributors. Cycling time assumes 16 km/h.
          </p>
        </div>
      )}

      {mode === 'watch' && <WatchTool tools={tools} watch={watch} />}

      {!mode && <p className="muted tool-body">Pick a tool. Esc leaves the tool.</p>}
    </section>
  );
}

export type NotificationState = NotificationPermission | 'unsupported';

export interface WatchControls {
  alerts: readonly WatchAlert[];
  notifications: NotificationState;
  onEnableNotifications(): void;
  onShowAlert(alert: WatchAlert): void;
}

interface ToolsPanelProps {
  tools: ToolsApi;
  watch: WatchControls;
  onClose(): void;
}

const alertTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});

function WatchTool({ tools, watch }: { tools: ToolsApi; watch: WatchControls }) {
  const [name, setName] = useState('');
  const { watchDraft: draft, watchAreas: areas } = tools;
  return (
    <div className="tool-body">
      <p className="muted">
        Click three or more points around an area and save it. You get an alert when an incident
        appears inside it or a ship or train enters. Areas stay in this browser, and alerts only
        come while the app is open.
      </p>
      <form
        className="watch-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (tools.saveWatch(name)) setName('');
        }}
      >
        <input
          type="text"
          value={name}
          maxLength={40}
          placeholder={`Area ${areas.length + 1}`}
          aria-label="Name of the watch area"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={draft.length < 3}>
          Save area
        </button>
        <button type="button" onClick={() => tools.clear('watch')} disabled={draft.length === 0}>
          Clear
        </button>
      </form>
      {areas.length > 0 && (
        <ul className="watch-areas">
          {areas.map((a) => (
            <li key={a.id}>
              <span>{a.name}</span>
              <button
                type="button"
                onClick={() => tools.removeWatch(a.id)}
                aria-label={`Delete ${a.name}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {watch.notifications === 'default' && (
        <button type="button" onClick={watch.onEnableNotifications}>
          Allow browser notifications
        </button>
      )}
      {watch.notifications === 'denied' && (
        <p className="muted small">
          Browser notifications are blocked; alerts show in the app only.
        </p>
      )}
      {watch.alerts.length > 0 && (
        <>
          <h3 className="watch-title">Recent alerts</h3>
          <ul className="spot-list">
            {watch.alerts.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => watch.onShowAlert(a)}>
                  <span>{a.text}</span>
                  <span className="muted">
                    {a.areaName} · {alertTime.format(new Date(a.ts))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
