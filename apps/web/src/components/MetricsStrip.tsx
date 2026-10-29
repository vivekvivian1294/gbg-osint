import type { Metric } from '@gbg-osint/shared';
import { useState } from 'react';
import { useSeries } from '../state/history';
import { Sparkline } from './Sparkline';

export interface MetricGroup {
  layerId: string;
  label: string;
  note?: string;
  /** Metric channels in this group, for their 24-hour history. */
  channels: readonly string[];
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
  'mm/h': 1,
  min: 0,
};

/** Pollenrapporten's levels 0–7. */
export const POLLEN_LEVELS = [
  'None',
  'Low',
  'Low to moderate',
  'Moderate',
  'Moderate to high',
  'High',
  'High to very high',
  'Very high',
];

export function formatMetric(m: Pick<Metric, 'value' | 'unit'>): string {
  if (m.unit === 'level') return POLLEN_LEVELS[Math.round(m.value)] ?? String(m.value);
  const decimals = DECIMALS[m.unit] ?? 1;
  const value = m.value.toLocaleString('sv-SE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    ...(m.unit === 'cm' && { signDisplay: 'exceptZero' }),
  });
  return m.unit === '°' ? `${value}°` : `${value} ${m.unit}`;
}

export function MetricsStrip({ groups }: { groups: readonly MetricGroup[] }) {
  // History is only fetched once the strip has been hovered or focused.
  const [trends, setTrends] = useState(false);
  const visible = groups.filter((g) => g.metrics.length > 0);
  if (visible.length === 0) return null;
  return (
    <section
      className={trends ? 'metrics metrics-trends' : 'metrics'}
      aria-label="Current conditions"
      onMouseEnter={() => setTrends(true)}
      onFocus={() => setTrends(true)}
    >
      {visible.map((g) => (
        <MetricGroupView key={g.layerId} group={g} trends={trends} />
      ))}
    </section>
  );
}

function MetricGroupView({ group: g, trends }: { group: MetricGroup; trends: boolean }) {
  const series = useSeries(trends ? g.channels.map((c) => `${c}/`) : null);
  const byKey = new Map(series.map((s) => [s.key, s]));
  const [now] = useState(Date.now);
  return (
    <dl className="metric-group" aria-label={g.label} {...(g.note && { title: g.note })}>
      {g.metrics.map((m) => {
        const history = g.channels.map((c) => byKey.get(`${c}/${m.id}`)).find(Boolean);
        return (
          <div
            key={m.id}
            className="metric"
            title={`${m.name} · ${timeFormat.format(new Date(m.ts))}${g.note ? `\n${g.note}` : ''}`}
          >
            <dt>{m.name}</dt>
            <dd>{formatMetric(m)}</dd>
            {trends && history && <Sparkline series={history} now={now} label={m.name} />}
          </div>
        );
      })}
    </dl>
  );
}
