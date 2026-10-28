import { decodeLine, type Area, type LonLat } from '@gbg-osint/shared';

export interface DistrictMetric {
  id: string;
  label: string;
  /** Key in the area's props. */
  prop: string;
  yearProp: string;
  format(value: number): string;
  note?: string;
}

const sv = (v: number, digits = 0) =>
  v.toLocaleString('sv-SE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const DISTRICT_METRICS: readonly DistrictMetric[] = [
  {
    id: 'density',
    label: 'Population density',
    prop: 'densityPerKm2',
    yearProp: 'populationYear',
    format: (v) => `${sv(v)} /km²`,
    note: 'Residents per km² of land.',
  },
  {
    id: 'population',
    label: 'Population',
    prop: 'population',
    yearProp: 'populationYear',
    format: (v) => sv(v),
  },
  {
    id: 'over65',
    label: 'Aged 65 or over',
    prop: 'over65Pct',
    yearProp: 'populationYear',
    format: (v) => `${sv(v, 1)} %`,
  },
  {
    id: 'education',
    label: 'Higher education (3+ years)',
    prop: 'higherEduPct',
    yearProp: 'educationYear',
    format: (v) => `${sv(v, 1)} %`,
    note: 'Share of residents aged 25–65 with three or more years of post-secondary education.',
  },
  {
    id: 'income',
    label: 'Median disposable income',
    prop: 'medianIncomeTkr',
    yearProp: 'incomeYear',
    format: (v) => `${sv(v)} tkr`,
    note: 'Equivalised disposable income per person, SEK thousands per year.',
  },
];

export const DEFAULT_DISTRICT_METRIC = 'density';

/** Sequential palette, low to high; readable on dark and satellite basemaps. */
export const DISTRICT_PALETTE = ['#26345e', '#2d6a8f', '#3a9a8c', '#8cc27a', '#f0dc78'] as const;

export function metricById(id: string): DistrictMetric {
  return DISTRICT_METRICS.find((m) => m.id === id) ?? DISTRICT_METRICS[0]!;
}

export function areaValue(area: Area, metric: DistrictMetric): number | undefined {
  const v = area.props?.[metric.prop];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Upper bounds of all but the last class, so each class holds about as many areas. */
export function quantileBreaks(
  values: readonly number[],
  classes = DISTRICT_PALETTE.length,
): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const breaks: number[] = [];
  for (let k = 1; k < classes; k++) {
    const b = sorted[Math.min(sorted.length - 1, Math.floor((k * sorted.length) / classes))]!;
    if (breaks.length === 0 || b > breaks.at(-1)!) breaks.push(b);
  }
  return breaks;
}

export function classOf(value: number, breaks: readonly number[]): number {
  const i = breaks.findIndex((b) => value < b);
  return i === -1 ? breaks.length : i;
}

export interface DistrictShape {
  id: string;
  polygons: LonLat[][][];
  color: string | null;
}

export interface DistrictClasses {
  metric: DistrictMetric;
  breaks: number[];
  year: number | undefined;
  shapes: DistrictShape[];
}

/** Decoded polygons coloured into quantile classes of the chosen metric. */
export function classifyDistricts(areas: readonly Area[], metricId: string): DistrictClasses {
  const metric = metricById(metricId);
  const values = areas.flatMap((a) => {
    const v = areaValue(a, metric);
    return v === undefined ? [] : [v];
  });
  const breaks = quantileBreaks(values);
  const yearValue = areas.map((a) => a.props?.[metric.yearProp]).find((y) => typeof y === 'number');
  const shapes = areas.map((a) => {
    const v = areaValue(a, metric);
    return {
      id: a.id,
      polygons: a.polygons.map((rings) => rings.map(decodeLine)),
      color: v === undefined ? null : DISTRICT_PALETTE[classOf(v, breaks)]!,
    };
  });
  return { metric, breaks, year: typeof yearValue === 'number' ? yearValue : undefined, shapes };
}
