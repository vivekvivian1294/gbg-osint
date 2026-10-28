import { encodeLine, type Area, type LonLat } from '@gbg-osint/shared';
import { z } from 'zod';
import type { ConnectorContext, PollConnector } from '../core/connector';
import { UpstreamError } from '../core/http';
import { simplifyLine } from './util';

const CHANNEL = 'context.districts';
const MUNICIPALITY = '1480';
const AREA_SUFFIX = '_RegSO2025';
const WFS_URL =
  'https://geodata.scb.se/geoserver/stat/wfs?service=WFS&version=2.0.0&request=GetFeature' +
  '&typeNames=stat:RegSO_2025&outputFormat=application/json&srsName=EPSG:4326' +
  `&CQL_FILTER=${encodeURIComponent(`kommunkod='${MUNICIPALITY}'`)}`;
const PXWEB = 'https://statistikdatabasen.scb.se/api/v2/tables';
const CACHE_MAX_AGE_MS = 7 * 24 * 3600_000;
const SIMPLIFY_M = 6;

const Ring = z.array(z.tuple([z.number(), z.number()]).rest(z.number())).min(4);
const Geometry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: z.array(Ring).min(1) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(Ring).min(1)).min(1) }),
]);
const RegSo = z.object({
  properties: z.object({
    regsokod: z.string().regex(/^\d{4}R\d{3}$/),
    regsonamn: z.string().min(1).max(120),
  }),
  geometry: Geometry,
});
const FeatureCollection = z.object({ features: z.array(z.unknown()) });

export interface RegSoArea {
  code: string;
  name: string;
  /** Polygons as `[exterior, ...holes]` in lon/lat. */
  polygons: LonLat[][][];
}

export function parseRegSo(raw: unknown): RegSoArea[] {
  const areas: RegSoArea[] = [];
  for (const item of FeatureCollection.parse(raw).features) {
    const parsed = RegSo.safeParse(item);
    if (!parsed.success) continue;
    const { properties: p, geometry: g } = parsed.data;
    const polygons = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rings) =>
      rings.map((ring) => ring.map(([lon, lat]): LonLat => [lon, lat])),
    );
    areas.push({ code: p.regsokod, name: p.regsonamn, polygons });
  }
  return areas;
}

/** Simplified, encoded rings; rings that collapse are dropped (and their polygon if exterior). */
export function encodePolygons(
  polygons: readonly LonLat[][][],
  toleranceM = SIMPLIFY_M,
): string[][] {
  const out: string[][] = [];
  for (const rings of polygons) {
    const encoded = rings.map((ring) => simplifyLine(ring, toleranceM));
    if ((encoded[0]?.length ?? 0) < 4) continue;
    out.push(encoded.filter((r) => r.length >= 4).map(encodeLine));
  }
  return out;
}

const JsonStat = z.object({
  id: z.array(z.string()),
  size: z.array(z.number().int().nonnegative()),
  dimension: z.record(
    z.string(),
    z.object({ category: z.object({ index: z.record(z.string(), z.number().int()) }) }),
  ),
  value: z.array(z.number().nullable()),
});

/** Cell lookup in a JSON-stat 2.0 dataset by dimension codes; undefined for missing cells. */
export function jsonStat(raw: unknown) {
  const data = JsonStat.parse(raw);
  const strides = data.size.map((_, i) => data.size.slice(i + 1).reduce((a, b) => a * b, 1));
  return {
    codes: (dim: string) => Object.keys(data.dimension[dim]?.category.index ?? {}),
    get(codes: Readonly<Record<string, string>>): number | undefined {
      let offset = 0;
      for (const [i, dim] of data.id.entries()) {
        const index = data.dimension[dim]?.category.index[codes[dim] ?? ''];
        if (index === undefined) return undefined;
        offset += index * strides[i]!;
      }
      return data.value[offset] ?? undefined;
    },
  };
}
type Dataset = ReturnType<typeof jsonStat>;

export interface DistrictStats {
  population: Dataset | undefined;
  land: Dataset | undefined;
  education: Dataset | undefined;
  income: Dataset | undefined;
}

const OVER_65 = ['65-69', '70-74', '75-79', '80-'];
const EDUCATION_LEVELS = ['21', '3+4', '5', '6', 'US'];
const round = (v: number, decimals: number) => Math.round(v * 10 ** decimals) / 10 ** decimals;
const latestYear = (d: Dataset | undefined) => d?.codes('Tid')[0] ?? '';

/** Figures for one area; anything SCB suppresses or lacks is simply left out. */
export function districtFigures(code: string, stats: DistrictStats): Record<string, number> {
  const Region = `${code}${AREA_SUFFIX}`;
  const figures: Record<string, number> = {};
  const { population: p, land: l, education: e, income: i } = stats;

  const people = (Alder: string) =>
    p?.get({ Region, Alder, Kon: '1+2', ContentsCode: '000007Y7', Tid: latestYear(p) });
  const pop = people('totalt');
  if (pop !== undefined) {
    figures.population = pop;
    figures.populationYear = Number(latestYear(p));
    const old = OVER_65.map(people);
    if (pop > 0 && old.every((v) => v !== undefined)) {
      figures.over65Pct = round((100 * old.reduce<number>((a, b) => a + (b ?? 0), 0)) / pop, 1);
    }
  }

  const land = l?.get({ Region, ArealTyp: '01', ContentsCode: '000007DY', Tid: latestYear(l) });
  if (land !== undefined && land > 0) {
    figures.landKm2 = round(land, 2);
    if (pop !== undefined) figures.densityPerKm2 = Math.round(pop / land);
  }

  const levels = EDUCATION_LEVELS.map((UtbildningsNiva) =>
    e?.get({ Region, UtbildningsNiva, ContentsCode: '000007Z6', Tid: latestYear(e) }),
  );
  const educated = levels[EDUCATION_LEVELS.indexOf('6')];
  const adults = levels.reduce<number>((a, b) => a + (b ?? 0), 0);
  if (educated !== undefined && adults > 0) {
    figures.higherEduPct = round((100 * educated) / adults, 1);
    figures.educationYear = Number(latestYear(e));
  }

  const income = i?.get({ Region, ContentsCode: '000008AB', Tid: latestYear(i) });
  if (income !== undefined) {
    figures.medianIncomeTkr = round(income, 1);
    figures.incomeYear = Number(latestYear(i));
  }
  return figures;
}

export function districtAreas(
  areas: readonly RegSoArea[],
  stats: DistrictStats,
  ts: string,
): Area[] {
  return areas.flatMap((a) => {
    const polygons = encodePolygons(a.polygons);
    if (polygons.length === 0) return [];
    return [
      {
        id: a.code,
        source: 'scb',
        label: a.name,
        polygons,
        ts,
        props: { code: a.code, ...districtFigures(a.code, stats) },
      },
    ];
  });
}

async function table(
  ctx: ConnectorContext,
  id: string,
  regions: readonly string[],
  selection: Record<string, string[]>,
): Promise<Dataset> {
  const body = {
    selection: [
      { variableCode: 'Region', valueCodes: regions },
      ...Object.entries(selection).map(([variableCode, valueCodes]) => ({
        variableCode,
        valueCodes,
      })),
      { variableCode: 'Tid', valueCodes: ['top(1)'] },
    ],
  };
  const raw = await ctx.http.postJson(
    `${PXWEB}/${id}/data?lang=en&outputFormat=json-stat2`,
    JSON.stringify(body),
    { headers: { 'content-type': 'application/json' }, timeoutMs: 60_000 },
  );
  return jsonStat(raw);
}

export const scbDistricts: PollConnector = {
  id: 'scb.districts',
  name: 'SCB – district statistics (RegSO)',
  licence: 'CC0 1.0',
  attribution: 'Statistics Sweden (SCB)',
  homepage: 'https://www.scb.se/vara-tjanster/oppna-data/',
  mode: 'poll',
  intervalMs: 24 * 3600_000,
  allowedHosts: ['geodata.scb.se', 'statistikdatabasen.scb.se'],
  channels: [{ name: CHANNEL, kind: 'areas' }],
  async poll(ctx) {
    const cached = await ctx.cache.get<Area[]>('districts', CACHE_MAX_AGE_MS);
    if (cached) {
      ctx.publish.replace(CHANNEL, cached.value);
      return;
    }
    const geo = await ctx.http.getJson(WFS_URL, { timeoutMs: 60_000, maxBytes: 20 * 1024 * 1024 });
    const areas = parseRegSo(geo);
    if (areas.length === 0) throw new UpstreamError('No districts in the SCB response');
    const regions = areas.map((a) => `${a.code}${AREA_SUFFIX}`);
    const [population, land, education, income] = await Promise.allSettled([
      table(ctx, 'TAB6574', regions, {
        Alder: ['totalt', ...OVER_65],
        Kon: ['1+2'],
        ContentsCode: ['000007Y7'],
      }),
      table(ctx, 'TAB6420', regions, { ArealTyp: ['01'], ContentsCode: ['000007DY'] }),
      table(ctx, 'TAB6534', regions, {
        UtbildningsNiva: EDUCATION_LEVELS,
        ContentsCode: ['000007Z6'],
      }),
      table(ctx, 'TAB6684', regions, { ContentsCode: ['000008AB'] }),
    ]);
    const ok = (r: PromiseSettledResult<Dataset>) =>
      r.status === 'fulfilled' ? r.value : undefined;
    const stats: DistrictStats = {
      population: ok(population),
      land: ok(land),
      education: ok(education),
      income: ok(income),
    };
    const failed = [population, land, education, income].filter((r) => r.status === 'rejected');
    for (const f of failed) ctx.log.warn({ err: f.reason }, 'SCB table failed');
    const items = districtAreas(areas, stats, new Date().toISOString());
    if (failed.length === 0) await ctx.cache.set('districts', items);
    ctx.publish.replace(CHANNEL, items);
  },
};
