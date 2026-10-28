import {
  formatArea,
  formatDistance,
  formatDuration,
  pathLengthM,
  polygonAreaM2,
} from '../layers/measure';
import type { RouteProfile, ToolMode, ToolsApi } from '../state/tools';

const MODES: readonly [ToolMode, string][] = [
  ['measure', 'Measure'],
  ['pin', 'Pins'],
  ['route', 'Route A→B'],
];
const PROFILES: readonly [RouteProfile, string][] = [
  ['foot', 'Walk'],
  ['bike', 'Bike'],
  ['car', 'Car'],
];

/** Measure, pin and route tools; while one is active, map clicks place points. */
export function ToolsPanel({ tools, onClose }: { tools: ToolsApi; onClose(): void }) {
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

      {!mode && <p className="muted tool-body">Pick a tool. Esc leaves the tool.</p>}
    </section>
  );
}
