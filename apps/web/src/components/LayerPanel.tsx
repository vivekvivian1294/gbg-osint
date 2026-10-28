import type { SourceStatus } from '@gbg-osint/shared';
import { LAYER_GROUPS, LAYERS, layerAvailability, type Availability } from '../layers/registry';

interface LayerPanelProps {
  sources: ReadonlyMap<string, SourceStatus>;
  enabled: ReadonlySet<string>;
  onToggle(id: string): void;
}

export function LayerPanel({ sources, enabled, onToggle }: LayerPanelProps) {
  return (
    <aside className="panel panel-left" aria-labelledby="layers-title">
      <h2 id="layers-title">Data layers</h2>
      {LAYER_GROUPS.map((group) => (
        <section key={group.id} className="layer-group" aria-label={group.label}>
          <h3>{group.label}</h3>
          <ul>
            {LAYERS.filter((l) => l.group === group.id).map((layer) => {
              const availability = layerAvailability(layer, sources);
              const usable = availability.kind === 'available';
              return (
                <li key={layer.id} className={usable ? 'layer' : 'layer layer-unavailable'}>
                  <label>
                    <input
                      type="checkbox"
                      checked={usable && enabled.has(layer.id)}
                      disabled={!usable}
                      onChange={() => onToggle(layer.id)}
                    />
                    <span className="layer-label" title={layer.note}>
                      {layer.label}
                    </span>
                  </label>
                  <AvailabilityBadge availability={availability} />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}

function AvailabilityBadge({ availability }: { availability: Availability }) {
  switch (availability.kind) {
    case 'planned':
      return <span className="badge">Phase {availability.phase}</span>;
    case 'needs-config':
      return (
        <span className="badge badge-warn" title={`Missing: ${availability.missing.join(', ')}`}>
          Needs key
        </span>
      );
    case 'available':
      return (
        <span
          className={`state-dot state-${availability.state}`}
          role="img"
          aria-label={`Source ${availability.state}`}
          title={`Source ${availability.state}`}
        />
      );
  }
}
