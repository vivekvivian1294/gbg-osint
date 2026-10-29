import type { Entity, Metric } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { UpstreamError } from '../core/http';
import { inGothenburgBbox, localDate, truncate } from './util';

// --- Pollen forecast (Pollenrapporten, Naturhistoriska riksmuseet) ---

const POLLEN_HOST = 'api.pollenrapporten.se';
const GOTEBORG_REGION = '2a2a2a2a-2a2a-4a2a-aa2a-2a2a2a303a38';
const POLLEN_CHANNEL = 'env.pollen';
const TYPES_MAX_AGE_MS = 7 * 24 * 3600_000;
const POLLEN_NAMES: Record<string, string> = {
  Hassel: 'Hazel',
  Al: 'Alder',
  Tall: 'Pine',
  'Sälg och viden': 'Willow',
  Alm: 'Elm',
  Björk: 'Birch',
  Bok: 'Beech',
  Ek: 'Oak',
  Gran: 'Spruce',
  Gräs: 'Grass',
  Gråbo: 'Mugwort',
  Malörtsambrosia: 'Ragweed',
};
/** Mould spores are reported with the pollen. */
const SPORES = new Set(['Alternaria', 'Cladosporium', 'Epicoccum']);

const PollenTypes = z.object({
  items: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
});
const Forecasts = z.object({
  items: z.array(
    z.object({
      regionId: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      isEndOfSeason: z.boolean().optional(),
      levelSeries: z.array(
        z.object({ pollenId: z.string(), level: z.number().int().min(0).max(7), time: z.string() }),
      ),
    }),
  ),
});

export function parsePollenTypes(raw: unknown): Record<string, string> {
  return Object.fromEntries(PollenTypes.parse(raw).items.map((t) => [t.id, t.name]));
}

/** Today's levels (0–7) for Göteborg, or none outside the season. */
export function parsePollen(
  raw: unknown,
  names: Readonly<Record<string, string>>,
  today: string,
  ts: string,
): Metric[] {
  const current = Forecasts.parse(raw).items.find(
    (f) =>
      f.regionId === GOTEBORG_REGION &&
      !f.isEndOfSeason &&
      f.startDate <= today &&
      today <= f.endDate,
  );
  if (!current) return [];
  const day = [...new Set(current.levelSeries.map((l) => l.time.slice(0, 10)))]
    .sort()
    .find((d) => d >= today);
  if (!day) return [];
  return current.levelSeries
    .filter((l) => l.time.startsWith(day) && l.level > 0)
    .sort((a, b) => b.level - a.level)
    .map((l) => {
      const sv = names[l.pollenId] ?? 'Okänd';
      const name = SPORES.has(sv) ? `${sv} spores` : `${POLLEN_NAMES[sv] ?? sv} pollen`;
      return {
        id: `pollen-${l.pollenId.slice(-6)}`,
        source: 'pollenrapporten',
        name,
        unit: 'level',
        value: l.level,
        ts,
      };
    });
}

export const pollenForecast: PollConnector = {
  id: 'pollenrapporten.forecast',
  name: 'Pollenrapporten – pollen forecast',
  licence: 'CC BY 4.0',
  attribution: 'Pollenrapporten, Naturhistoriska riksmuseet',
  homepage: 'https://pollenrapporten.se/',
  mode: 'poll',
  intervalMs: 3 * 3600_000,
  allowedHosts: [POLLEN_HOST],
  channels: [{ name: POLLEN_CHANNEL, kind: 'metrics' }],
  async poll(ctx) {
    let names = (await ctx.cache.get<Record<string, string>>('types', TYPES_MAX_AGE_MS))?.value;
    if (!names) {
      names = parsePollenTypes(await ctx.http.getJson(`https://${POLLEN_HOST}/v1/pollen-types`));
      await ctx.cache.set('types', names);
    }
    const raw = await ctx.http.getJson(
      `https://${POLLEN_HOST}/v1/forecasts?region_id=${GOTEBORG_REGION}&current=true`,
    );
    const now = new Date();
    ctx.publish.replace(POLLEN_CHANNEL, parsePollen(raw, names, localDate(now), now.toISOString()));
  },
};

// --- Bathing waters (Havs- och vattenmyndigheten, Badplatsen) ---

const HAV_HOST = 'gw.havochvatten.se';
const HAV_API = `https://${HAV_HOST}/external-public/bathing-waters/v2/bathing-waters`;
const BATHING_CHANNEL = 'env.bathing';
const RESULT_MAX_AGE_MS = 24 * 3600_000;
/** The HaV gateway rate-limits hard (429 after a couple of quick requests). */
const REQUEST_GAP_MS = 3_000;
const SITE_ID = /^[A-Z]{2}[0-9A-Z]{6,40}$/;
/** Cache keys must be lower case. */
const resultKey = (id: string) => `r-${id.toLowerCase()}`;

const Notice = z.object({
  description: z.string().optional(),
  startsAt: z.string().optional(),
  typeIdText: z.string().optional(),
});
const Site = z.object({
  bathingWater: z.object({
    id: z.string().regex(SITE_ID),
    name: z.string().min(1),
    euType: z.boolean().optional(),
    waterTypeIdText: z.string().optional(),
    samplingPointPosition: z.object({ latitude: z.string(), longitude: z.string() }).nullish(),
  }),
  adviceAgainstBathing: z.array(Notice).default([]),
  abnormalSituations: z.array(Notice).default([]),
});
const SiteList = z.object({ watersAndAdvisories: z.array(z.unknown()) });
const Results = z.object({
  results: z.array(
    z.object({
      takenAt: z.string(),
      sampleAssessIdText: z.string().optional(),
      algalIdText: z.string().optional(),
      escherichiaColiCount: z.number().optional(),
      intestinalEnterococciCount: z.number().optional(),
    }),
  ),
});

export type BathingSite = z.infer<typeof Site> & { lon: number; lat: number };
export interface BathingSample {
  takenAt: string;
  assessment?: string;
  algae?: string;
  eColi?: number;
  enterococci?: number;
}

const WATER_TYPES: Record<string, string> = { Hav: 'Sea', Sjö: 'Lake', Vattendrag: 'River' };
/** Assessments come both spelled out and abbreviated ("Tjänligt m. Anm."). */
export function assessment(text: string | undefined): string {
  const t = (text ?? '').toLowerCase();
  if (t.startsWith('otjänlig')) return 'Unfit for bathing';
  if (t.startsWith('tjänlig') && /anm/.test(t)) return 'Fit, with remarks';
  if (t.startsWith('tjänlig')) return 'Fit for bathing';
  return text?.trim() || 'Not assessed';
}
const ALGAE: Record<string, string> = {
  'Ingen blomning': 'No bloom',
  Blomning: 'Bloom',
  'Kraftig blomning': 'Heavy bloom',
};

/** Bathing sites in the Gothenburg area with a sampling point. */
export function parseBathingSites(raw: unknown): BathingSite[] {
  return SiteList.parse(raw).watersAndAdvisories.flatMap((item) => {
    const parsed = Site.safeParse(item);
    const pos = parsed.success ? parsed.data.bathingWater.samplingPointPosition : undefined;
    if (!parsed.success || !pos) return [];
    const lon = Number(pos.longitude);
    const lat = Number(pos.latitude);
    return inGothenburgBbox(lon, lat) ? [{ ...parsed.data, lon, lat }] : [];
  });
}

export function latestSample(raw: unknown): BathingSample | undefined {
  const latest = Results.parse(raw)
    .results.filter((r) => Number.isFinite(Date.parse(r.takenAt)))
    .sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt))[0];
  if (!latest) return undefined;
  return {
    takenAt: new Date(Date.parse(latest.takenAt)).toISOString(),
    ...(latest.sampleAssessIdText && { assessment: latest.sampleAssessIdText }),
    ...(latest.algalIdText && { algae: latest.algalIdText }),
    ...(latest.escherichiaColiCount !== undefined && { eColi: latest.escherichiaColiCount }),
    ...(latest.intestinalEnterococciCount !== undefined && {
      enterococci: latest.intestinalEnterococciCount,
    }),
  };
}

export function bathingEntities(
  sites: readonly BathingSite[],
  samples: ReadonlyMap<string, BathingSample | null>,
  ts: string,
): Entity[] {
  return sites.map((s) => {
    const w = s.bathingWater;
    const advice = s.adviceAgainstBathing[0];
    const abnormal = s.abnormalSituations[0];
    const sample = samples.get(w.id);
    const text = (n: z.infer<typeof Notice>) =>
      truncate(n.description?.trim() || n.typeIdText || 'Yes', 300);
    return {
      id: w.id,
      source: 'havochvatten',
      kind: 'poi' as const,
      lon: s.lon,
      lat: s.lat,
      label: truncate(w.name, 120),
      ts,
      props: {
        waterType: WATER_TYPES[w.waterTypeIdText ?? ''] ?? w.waterTypeIdText ?? 'Unknown',
        ...(w.euType && { euBathingWater: true }),
        ...(advice && { adviceAgainstBathing: text(advice) }),
        ...(advice?.startsAt && { adviceSince: advice.startsAt }),
        ...(abnormal && { abnormalSituation: text(abnormal) }),
        ...(sample && {
          lastSample: assessment(sample.assessment),
          sampledAt: sample.takenAt,
          ...(sample.algae && { algae: ALGAE[sample.algae] ?? sample.algae }),
          ...(sample.eColi !== undefined && { eColiPer100ml: sample.eColi }),
          ...(sample.enterococci !== undefined && { enterococciPer100ml: sample.enterococci }),
        }),
      },
    };
  });
}

export const bathingWaters: PollConnector = {
  id: 'hav.bathingwaters',
  name: 'Havs- och vattenmyndigheten – bathing waters',
  licence: 'CC0 1.0',
  attribution: 'Havs- och vattenmyndigheten (Badplatsen)',
  homepage: 'https://www.havochvatten.se/badplatser-och-badvatten.html',
  mode: 'poll',
  intervalMs: 6 * 3600_000,
  allowedHosts: [HAV_HOST],
  channels: [{ name: BATHING_CHANNEL, kind: 'entities' }],
  async poll(ctx) {
    const sites = parseBathingSites(await ctx.http.getJson(HAV_API, { timeoutMs: 60_000 }));
    const samples = new Map<string, BathingSample | null>();
    const publish = () =>
      ctx.publish.replace(
        BATHING_CHANNEL,
        bathingEntities(sites, samples, new Date().toISOString()),
      );
    const stale: BathingSite[] = [];
    for (const s of sites) {
      const key = resultKey(s.bathingWater.id);
      const fresh = await ctx.cache.get<BathingSample | null>(key, RESULT_MAX_AGE_MS);
      if (fresh) samples.set(s.bathingWater.id, fresh.value);
      else {
        const old = await ctx.cache.get<BathingSample | null>(key, Infinity);
        if (old) samples.set(s.bathingWater.id, old.value);
        stale.push(s);
      }
    }
    publish();
    // Sample results change at most every couple of weeks in summer; fetch them slowly.
    for (const s of stale) {
      if (ctx.signal.aborted) return;
      await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
      try {
        const raw = await ctx.http.getJson(`${HAV_API}/${s.bathingWater.id}/results`);
        const sample = latestSample(raw) ?? null;
        samples.set(s.bathingWater.id, sample);
        await ctx.cache.set(resultKey(s.bathingWater.id), sample);
      } catch (err) {
        if (err instanceof UpstreamError && err.status === 429) break;
        ctx.log.warn({ err, site: s.bathingWater.id }, 'Bathing water results failed');
      }
    }
    publish();
  },
};
