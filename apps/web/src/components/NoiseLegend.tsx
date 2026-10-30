import { NOISE_CLASSES } from '../engine/noise';

/** Classes of the road traffic noise overlay. */
export function NoiseLegend() {
  return (
    <section className="map-legend" aria-label="Road traffic noise legend">
      <strong>Road traffic noise</strong>
      <ol>
        {NOISE_CLASSES.map((c) => (
          <li key={c.label}>
            <span className="swatch" style={{ background: c.color, opacity: 0.6 }} />
            {c.label}
          </li>
        ))}
      </ol>
      <p className="muted">24-hour average (LAeq), modelled · Göteborgs Stad 2023</p>
    </section>
  );
}
