import { DISTRICT_METRICS, DISTRICT_PALETTE, type DistrictClasses } from '../layers/districts';

interface DistrictLegendProps {
  classes: DistrictClasses;
  onMetricChange(id: string): void;
}

/** Metric picker and class legend for the district choropleth. */
export function DistrictLegend({ classes, onMetricChange }: DistrictLegendProps) {
  const { metric, breaks, year } = classes;
  const bounds = [undefined, ...breaks];
  return (
    <section className="district-legend" aria-label="District statistics legend">
      <label>
        <span className="visually-hidden">Statistic</span>
        <select value={metric.id} onChange={(e) => onMetricChange(e.target.value)}>
          {DISTRICT_METRICS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <ol>
        {breaks.length === 0 && <li className="muted">No figures for this statistic yet.</li>}
        {breaks.length > 0 &&
          bounds.map((low, i) => (
            <li key={i}>
              <span className="swatch" style={{ background: DISTRICT_PALETTE[i] }} />
              {low === undefined
                ? `< ${metric.format(breaks[0]!)}`
                : i === breaks.length
                  ? `≥ ${metric.format(low)}`
                  : `${metric.format(low)} – ${metric.format(breaks[i]!)}`}
            </li>
          ))}
      </ol>
      {metric.note && <p>{metric.note}</p>}
      <p className="muted">SCB · RegSO areas{year ? ` · ${year}` : ''} · equal-count classes</p>
    </section>
  );
}
