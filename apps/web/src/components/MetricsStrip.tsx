import type { Metric } from '@gbg-osint/shared';

export interface MetricGroup {
  layerId: string;
  label: string;
  note?: string;
  metrics: readonly Metric[];
}

const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  dateStyle: 'short',
  timeStyle: 'short',
});

const DECIMALS: Record<string, number> = {
  'SEK/kWh': 2,
  '°C': 1,
  'm/s': 1,
  mm: 1,
  hPa: 0,
  '%': 0,
  '°': 0,
  cm: 0,
  GW: 1,
  aircraft: 0,
};

export function formatMetric(m: Pick<Metric, 'value' | 'unit'>): string {
  const decimals = DECIMALS[m.unit] ?? 1;
  const value = m.value.toLocaleString('sv-SE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    ...(m.unit === 'cm' && { signDisplay: 'exceptZero' }),
  });
  return m.unit === '°' ? `${value}°` : `${value} ${m.unit}`;
}

export function MetricsStrip({ groups }: { groups: readonly MetricGroup[] }) {
  const visible = groups.filter((g) => g.metrics.length > 0);
  if (visible.length === 0) return null;
  return (
    <section className="metrics" aria-label="Current conditions">
      {visible.map((g) => (
        <dl
          key={g.layerId}
          className="metric-group"
          aria-label={g.label}
          {...(g.note && { title: g.note })}
        >
          {g.metrics.map((m) => (
            <div
              key={m.id}
              className="metric"
              title={`${m.name} · ${timeFormat.format(new Date(m.ts))}${g.note ? `\n${g.note}` : ''}`}
            >
              <dt>{m.name}</dt>
              <dd>{formatMetric(m)}</dd>
            </div>
          ))}
        </dl>
      ))}
    </section>
  );
}
