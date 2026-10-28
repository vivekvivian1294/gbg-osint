import { decodeLine, encodeLine, type LonLat } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { gnssMetrics } from './aircraft';
import { energyMixMetrics } from './energyCharts';
import { parseRadioBrowser, parseSrChannels } from './radio';
import { parseOsrm, parseRoutePath } from './routing';
import { districtAreas, districtFigures, encodePolygons, jsonStat, parseRegSo } from './scb';
import { mergePosts, parseBluesky, parseMastodon } from './social';

/** JSON-stat 2.0 dataset with dimensions in the given order (values row-major). */
function dataset(dims: [string, string[]][], value: (number | null)[]) {
  return {
    id: dims.map(([d]) => d),
    size: dims.map(([, codes]) => codes.length),
    dimension: Object.fromEntries(
      dims.map(([d, codes]) => [
        d,
        { category: { index: Object.fromEntries(codes.map((c, i) => [c, i])) } },
      ]),
    ),
    value,
  };
}

const square: LonLat[] = [
  [11.95, 57.7],
  [11.96, 57.7],
  [11.96, 57.71],
  [11.95, 57.71],
  [11.95, 57.7],
];

describe('SCB districts', () => {
  it('reads RegSO polygons and multipolygons', () => {
    const areas = parseRegSo({
      features: [
        {
          properties: { regsokod: '1480R110', regsonamn: 'Olivedal' },
          geometry: { type: 'Polygon', coordinates: [square] },
        },
        {
          properties: { regsokod: '1480R111', regsonamn: 'Islands' },
          geometry: { type: 'MultiPolygon', coordinates: [[square], [square]] },
        },
        { properties: { regsokod: 'bad', regsonamn: 'x' }, geometry: { type: 'Point' } },
      ],
    });
    expect(areas.map((a) => [a.code, a.polygons.length])).toEqual([
      ['1480R110', 1],
      ['1480R111', 2],
    ]);
  });

  it('simplifies and encodes rings, dropping collapsed ones', () => {
    const dense: LonLat[] = [...square.slice(0, 1), [11.955, 57.70001], ...square.slice(1)];
    const encoded = encodePolygons([
      [
        dense,
        [
          [11.951, 57.701],
          [11.951, 57.701],
          [11.951, 57.701],
        ],
      ],
    ]);
    expect(encoded).toHaveLength(1);
    expect(encoded[0]).toHaveLength(1);
    expect(decodeLine(encoded[0]![0]!)).toHaveLength(5);
    expect(
      encodePolygons([
        [
          [
            [11.95, 57.7],
            [11.95, 57.7],
            [11.95, 57.7],
            [11.95, 57.7],
          ],
        ],
      ]),
    ).toEqual([]);
  });

  it('looks up JSON-stat cells by codes', () => {
    const d = jsonStat(
      dataset(
        [
          ['Region', ['a', 'b']],
          ['Tid', ['2024', '2025']],
        ],
        [1, 2, 3, null],
      ),
    );
    expect(d.get({ Region: 'a', Tid: '2025' })).toBe(2);
    expect(d.get({ Region: 'b', Tid: '2024' })).toBe(3);
    expect(d.get({ Region: 'b', Tid: '2025' })).toBeUndefined();
    expect(d.get({ Region: 'c', Tid: '2025' })).toBeUndefined();
    expect(d.codes('Tid')).toEqual(['2024', '2025']);
  });

  it('computes density, ages, education and income per district', () => {
    const r = '1480R110_RegSO2025';
    const population = jsonStat(
      dataset(
        [
          ['Region', [r]],
          ['Alder', ['totalt', '65-69', '70-74', '75-79', '80-']],
          ['Kon', ['1+2']],
          ['ContentsCode', ['000007Y7']],
          ['Tid', ['2025']],
        ],
        [4000, 200, 200, 100, 100],
      ),
    );
    const land = jsonStat(
      dataset(
        [
          ['Region', [r]],
          ['ArealTyp', ['01']],
          ['ContentsCode', ['000007DY']],
          ['Tid', ['2026']],
        ],
        [0.5],
      ),
    );
    const education = jsonStat(
      dataset(
        [
          ['Region', [r]],
          ['UtbildningsNiva', ['21', '3+4', '5', '6', 'US']],
          ['ContentsCode', ['000007Z6']],
          ['Tid', ['2025']],
        ],
        [200, 800, 400, 1500, 100],
      ),
    );
    const figures = districtFigures('1480R110', { population, land, education, income: undefined });
    expect(figures).toEqual({
      population: 4000,
      populationYear: 2025,
      over65Pct: 15,
      landKm2: 0.5,
      densityPerKm2: 8000,
      higherEduPct: 50,
      educationYear: 2025,
    });
    const [area] = districtAreas(
      [{ code: '1480R110', name: 'Olivedal', polygons: [[square]] }],
      { population, land, education, income: undefined },
      '2026-10-27T12:00:00.000Z',
    );
    expect(area).toMatchObject({
      id: '1480R110',
      label: 'Olivedal',
      props: { densityPerKm2: 8000 },
    });
    expect(decodeLine(area!.polygons[0]![0]!)).toEqual(square);
    expect(encodeLine(square)).toBe(area!.polygons[0]![0]);
  });
});

describe('energy mix', () => {
  it('groups Swedish generation and reports the latest complete quarter-hour', () => {
    const metrics = energyMixMetrics({
      unix_seconds: [1_800_000_000, 1_800_000_900],
      production_types: [
        { name: 'Nuclear', data: [6000, 6100] },
        { name: 'Hydro water reservoir', data: [4000, 4050] },
        { name: 'Hydro Run-of-River', data: [900, 950] },
        { name: 'Wind onshore', data: [3000, 3000] },
        { name: 'Fossil gas', data: [10, 10] },
        { name: 'Load', data: [15000, null] },
        { name: 'Cross border electricity trading', data: [-2500, -2600] },
        { name: 'Renewable share of generation', data: [56.1, 56.3] },
      ],
    });
    const byId = Object.fromEntries(metrics.map((m) => [m.id, m]));
    expect(byId['se-hydro']).toMatchObject({ name: 'Hydro', unit: 'GW', value: 4.9 });
    expect(byId['se-nuclear']!.value).toBe(6);
    expect(byId['se-other']!.value).toBe(0);
    expect(byId['se-load']!.value).toBe(15);
    expect(byId['se-trade']).toMatchObject({ name: 'Net export', value: 2.5 });
    expect(byId['se-renewable']!.value).toBe(56.1);
    expect(byId['se-hydro']!.ts).toBe(new Date(1_800_000_000_000).toISOString());
  });
});

describe('GNSS quality from aircraft', () => {
  const ac = (nic: number, extra: Record<string, unknown> = {}) => ({
    hex: '4ca1b2',
    lat: 57.7,
    lon: 11.9,
    alt_baro: 30000,
    nic,
    seen_pos: 1,
    ...extra,
  });

  it('counts airborne aircraft with their own GNSS fix', () => {
    const metrics = gnssMetrics({
      now: 1_800_000_000_000,
      ac: [
        ac(8),
        ac(8),
        ac(9),
        ac(0),
        ac(6),
        ac(8, { alt_baro: 'ground' }),
        ac(0, { mlat: ['lat', 'lon'] }),
        ac(8, { seen_pos: 300 }),
      ],
    });
    expect(metrics).toEqual([
      expect.objectContaining({ id: 'gnss-degraded', unit: '%', value: 40 }),
      expect.objectContaining({ id: 'gnss-sampled', value: 5 }),
    ]);
  });

  it('withholds the share when too few aircraft are sampled', () => {
    expect(gnssMetrics({ now: 0, ac: [ac(0)] }).map((m) => m.id)).toEqual(['gnss-sampled']);
  });
});

describe('social posts', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');

  it('keeps only text, time and link, and drops labelled posts', () => {
    const posts = parseBluesky({
      posts: [
        {
          uri: 'at://did:plc:abc123/app.bsky.feed.post/3myudyyisls2d',
          author: { did: 'did:plc:abc123', handle: 'someone.bsky.social', displayName: 'Some One' },
          record: { text: 'Regn  över\nGöteborg <3', createdAt: '2026-10-27T11:00:00Z' },
        },
        {
          uri: 'at://did:plc:def/app.bsky.feed.post/xyz',
          author: { did: 'did:plc:def' },
          record: { text: 'nsfw', createdAt: '2026-10-27T11:00:00Z' },
          labels: [{ val: 'porn' }],
        },
      ],
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      source: 'bluesky',
      title: 'Regn över Göteborg <3',
      url: 'https://bsky.app/profile/did:plc:abc123/post/3myudyyisls2d',
      locationPrecision: 'none',
    });
    expect(JSON.stringify(posts)).not.toMatch(/someone|Some One/);
  });

  it('skips sensitive and bot Mastodon posts and merges newest first', () => {
    const status = (url: string, created: string, extra: Record<string, unknown> = {}) => ({
      created_at: created,
      url,
      content: '<p>Hej <a href="x">#göteborg</a></p>',
      sensitive: false,
      spoiler_text: '',
      account: { acct: 'person@example.social', bot: false },
      ...extra,
    });
    const masto = parseMastodon([
      status('https://example.social/@a/1', '2026-10-27T10:00:00Z'),
      status('https://example.social/@a/2', '2026-10-27T10:00:00Z', { sensitive: true }),
      status('https://example.social/@a/3', '2026-10-27T10:00:00Z', { account: { bot: true } }),
      status('https://example.social/@a/4', '2026-10-20T10:00:00Z'),
    ]);
    expect(masto.map((p) => p.title)).toEqual(['Hej #göteborg', 'Hej #göteborg']);
    const merged = mergePosts([masto, masto], now);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.url).toBe('https://example.social/@a/1');
  });
});

describe('radio', () => {
  it('lists Sveriges Radio Gothenburg channels and HTTPS community streams', () => {
    const sr = parseSrChannels({
      channels: [
        {
          id: 212,
          name: 'P4 Göteborg',
          siteurl: 'https://sverigesradio.se/p4',
          liveaudio: { url: 'https://sr.se/212.mp3' },
        },
        { id: 213, name: 'P4 Blekinge', liveaudio: { url: 'https://sr.se/213.mp3' } },
      ],
    });
    expect(sr).toEqual([
      expect.objectContaining({
        id: 'sr-212',
        name: 'Sveriges Radio P4 Göteborg',
        stream: 'https://sr.se/212.mp3',
      }),
    ]);
    const station = (name: string, url: string, ok = 1) => ({
      stationuuid: '0b0f2d36-2fe7-11e9-a80b-52543be04c81',
      name,
      url_resolved: url,
      codec: 'MP3',
      bitrate: 128,
      lastcheckok: ok,
    });
    const rb = parseRadioBrowser([
      station('Bandit Metal', 'https://stream.example/metal'),
      station('Mix Megapol GBG', 'http://insecure.example/live'),
      station('Broken', 'https://stream.example/broken', 0),
      station('Sveriges Radio P4 Göteborg', 'https://live1.sr.se/p4gbg-aac-320'),
    ]);
    expect(rb).toEqual([
      expect.objectContaining({
        name: 'Bandit Metal',
        provider: 'Radio Browser',
        bitrateKbps: 128,
      }),
    ]);
  });
});

describe('routing', () => {
  it('accepts only well-formed route paths near Gothenburg', () => {
    expect(parseRoutePath('route/bike/11.97460/57.70890/11.99250/57.69500.json')).toEqual({
      profile: 'bike',
      from: [11.9746, 57.7089],
      to: [11.9925, 57.695],
    });
    expect(parseRoutePath('route/car/18.06/59.33/11.99/57.69.json')).toBeUndefined();
    expect(parseRoutePath('route/plane/11.97/57.70/11.99/57.69.json')).toBeUndefined();
    expect(parseRoutePath('route/foot/11.97/57.70/11.99.json')).toBeUndefined();
  });

  it('turns an OSRM response into a route, estimating cycling time', () => {
    const line = encodeLine(square);
    const osrm = (distance: number, duration: number) => ({
      code: 'Ok',
      routes: [{ distance, duration, geometry: line }],
    });
    expect(parseOsrm(osrm(2651.1, 547), 'foot')).toEqual({
      profile: 'foot',
      distanceM: 2651.1,
      durationS: 547,
      line,
    });
    expect(parseOsrm(osrm(4000, 300), 'bike')!.durationS).toBeCloseTo(900, 6);
    expect(parseOsrm({ code: 'NoRoute', routes: [] }, 'car')).toBeUndefined();
  });
});
