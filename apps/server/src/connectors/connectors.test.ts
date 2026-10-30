import { EntitySchema, EventSchema, MetricSchema } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { parseAircraft } from './aircraft';
import { toSatellites, visibleSatellites } from './celestrak';
import { DISTRICTS, districtIn } from './districts';
import { priceMetrics } from './elpris';
import { parseCrisisItems } from './krisinformation';
import { parseBikeStations } from './nextbike';
import { parsePois } from './osm';
import { parsePoliceEvents, parsePoliceTime } from './polisen';
import { parseFeed } from './rss';
import { forecastMetrics } from './smhiForecast';
import { latestObservation } from './smhiObservations';
import { parseWarnings } from './smhiWarnings';
import { toPlainText } from './util';

const NOW = Date.parse('2026-10-23T12:00:00+02:00');

describe('polisen', () => {
  const base = {
    summary: 'Brand i ett flerfamiljshus.',
    url: '/aktuellt/handelser/2026/oktober/23/x/',
    location: { name: 'Västra Götalands län', gps: '58.25,13.06' },
  };

  it('parses padded and unpadded times', () => {
    expect(parsePoliceTime('2026-10-23 7:00:14 +02:00')).toBe('2026-10-23T07:00:14+02:00');
    expect(parsePoliceTime('2026-10-23 10:50:46 +02:00')).toBe('2026-10-23T10:50:46+02:00');
    expect(parsePoliceTime('garbage')).toBeUndefined();
  });

  it('keeps recent Göteborg events at the municipality centre', () => {
    const events = parsePoliceEvents(
      [
        {
          ...base,
          id: 1,
          datetime: '2026-10-23 10:50:46 +02:00',
          name: '23 oktober 10.38, Brand, Göteborg',
          type: 'Brand',
        },
        {
          ...base,
          id: 2,
          datetime: '2026-10-23 07:00:14 +02:00',
          name: '23 oktober 07.00, Sammanfattning natt, Västra Götalands län',
          type: 'Sammanfattning natt',
        },
        {
          ...base,
          id: 3,
          datetime: '2026-10-01 10:00:00 +02:00',
          name: '1 oktober, Brand, Göteborg',
          type: 'Brand',
        },
        { id: 'bad' },
      ],
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: '1',
      severity: 'minor',
      locationPrecision: 'municipality',
      url: 'https://polisen.se/aktuellt/handelser/2026/oktober/23/x/',
    });
    expect(EventSchema.safeParse(events[0]).success).toBe(true);
  });

  it('places events at the one district their text names', () => {
    const [event] = parsePoliceEvents(
      [
        {
          ...base,
          id: 4,
          datetime: '2026-10-23 10:50:46 +02:00',
          name: '22 oktober 20.36, Brand, Göteborg',
          summary:
            'Larm inkommer till SOS om brand i en parkerad bil på Majstångsgatan, Kungsladugård.',
          type: 'Brand',
        },
      ],
      NOW,
    );
    expect(event).toMatchObject({
      locationPrecision: 'district',
      place: 'Kungsladugård',
      geometry: { type: 'Point', coordinates: [11.9206, 57.6848] },
    });
    expect(EventSchema.safeParse(event).success).toBe(true);
  });
});

describe('district names', () => {
  const name = (text: string) => districtIn(text)?.name;

  it('finds the district a text names, also in the genitive', () => {
    expect(name('Det brinner i en mataffär på Treriksgatan i Gamlestaden.')).toBe('Gamlestaden');
    expect(name('Misstänkt smitning från trafikolycka, Masthugget.')).toBe('Masthugget');
    expect(name('Bråk vid Bergsjöns centrum.')).toBe('Bergsjön');
    expect(name('Rån i Nordstan.')).toBe('Nordstaden');
    expect(name('Olycka vid Frölunda torg.')).toBe('Frölunda');
    expect(name('Misstänkt brand i ett flerfamiljshus i Gamlestan.')).toBe('Gamlestaden');
    expect(name('Vi får larm om brand i en byggnad vid Rymdtorget.')).toBe('Bergsjön');
  });

  it('skips street names, directions and texts naming several districts', () => {
    expect(name('Kollision på Lundbyleden vid Backavägen.')).toBeUndefined();
    expect(
      name('En förare kör i fel riktning på Lundbyleden i riktning mot Eriksberg.'),
    ).toBeUndefined();
    expect(name('Jakt från Angered till Hammarkullen.')).toBeUndefined();
    expect(name('Kollision på Älvsborgsbron.')).toBeUndefined();
    expect(name('Bränder i lunden och på heden.')).toBeUndefined();
  });

  it('keeps every district centre in the Gothenburg area, with unique names', () => {
    const names = DISTRICTS.flatMap((d) => [d.name, ...(d.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
    for (const d of DISTRICTS) {
      expect(d.at[0]).toBeGreaterThan(11.6);
      expect(d.at[0]).toBeLessThan(12.25);
      expect(d.at[1]).toBeGreaterThan(57.55);
      expect(d.at[1]).toBeLessThan(57.85);
    }
  });
});

describe('krisinformation', () => {
  it('keeps national, county and Göteborg items with matching precision', () => {
    const item = (id: string, area: { type: string; description: string }[]) => ({
      identifier: id,
      published: '2026-10-21T21:56:17+02:00',
      headline: `Headline ${id}`,
      preamble: 'Preamble',
      web: 'https://www.krisinformation.se/x',
      area,
    });
    const events = parseCrisisItems(
      [
        item('1', [{ type: 'Country', description: 'Sverige' }]),
        item('2', [{ type: 'County', description: 'Västra Götalands län' }]),
        item('3', [{ type: 'Municipality', description: 'Göteborg' }]),
        item('4', [{ type: 'County', description: 'Skåne län' }]),
      ],
      'vma',
    );
    expect(events.map((e) => [e.id, e.locationPrecision, e.severity])).toEqual([
      ['vma-1', 'none', 'critical'],
      ['vma-2', 'region', 'critical'],
      ['vma-3', 'municipality', 'critical'],
    ]);
    for (const e of events) expect(EventSchema.safeParse(e).success).toBe(true);
  });
});

describe('smhi warnings', () => {
  const area = (id: number, affected: number[], end?: string) => ({
    id,
    approximateStart: '2026-10-25T02:00:00.535Z',
    ...(end && { approximateEnd: end }),
    areaName: { sv: 'Västra Götalands län' },
    warningLevel: { sv: 'Gul varning', code: 'YELLOW' },
    eventDescription: { sv: 'Vind' },
    affectedAreas: affected.map((x) => ({ id: x })),
    descriptions: [{ text: { sv: 'Byvind upp till 25 m/s.' } }],
  });

  it('keeps active warnings for Västra Götaland and Kattegatt', () => {
    const events = parseWarnings(
      [
        {
          id: 10,
          event: { sv: 'Vind' },
          warningAreas: [
            area(1, [13, 14], '2026-10-25T11:00:00Z'),
            area(2, [12]),
            area(3, [56], '2026-10-22T00:00:00Z'),
          ],
        },
      ],
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: '10-1',
      severity: 'minor',
      title: 'Gul varning: Vind – Västra Götalands län',
      body: 'Byvind upp till 25 m/s.',
      locationPrecision: 'region',
    });
    expect(EventSchema.safeParse(events[0]).success).toBe(true);
  });
});

describe('smhi observations', () => {
  it('returns the latest numeric value', () => {
    expect(
      latestObservation({
        value: [
          { date: 1792746000000, value: '11.5' },
          { date: 1792749600000, value: '12.0' },
        ],
      }),
    ).toEqual({ ts: new Date(1792749600000).toISOString(), value: 12 });
    expect(latestObservation({ value: [] })).toBeUndefined();
    expect(latestObservation({ value: [{ date: 1, value: '' }] })).toBeUndefined();
    expect(latestObservation({ value: null })).toBeUndefined();
  });
});

describe('smhi forecast', () => {
  it('summarises the next 12 hours', () => {
    const step = (time: string, start: string, t: number, gust: number, rain: number) => ({
      time,
      intervalParametersStartTime: start,
      data: { air_temperature: t, wind_speed_of_gust: gust, precipitation_amount_mean: rain },
    });
    const metrics = forecastMetrics(
      {
        referenceTime: '2026-10-23T09:00:00Z',
        timeSeries: [
          step('2026-10-23T10:00:00Z', '2026-10-23T09:00:00Z', 99, 99, 99),
          step('2026-10-23T11:00:00Z', '2026-10-23T10:00:00Z', 12, 6, 0.5),
          step('2026-10-23T14:00:00Z', '2026-10-23T11:00:00Z', 9, 14, 1),
          step('2026-10-24T12:00:00Z', '2026-10-24T06:00:00Z', -40, 99, 99),
        ],
      },
      NOW,
    );
    expect(Object.fromEntries(metrics.map((m) => [m.id, m.value]))).toEqual({
      'fc12-temp-min': 9,
      'fc12-temp-max': 12,
      'fc12-precip': 3.5,
      'fc12-gust': 14,
    });
    for (const m of metrics) expect(MetricSchema.safeParse(m).success).toBe(true);
  });
});

describe('elpris', () => {
  it('finds the current interval and daily range', () => {
    const metrics = priceMetrics(
      [
        {
          SEK_per_kWh: 0.85,
          time_start: '2026-10-23T11:45:00+02:00',
          time_end: '2026-10-23T12:00:00+02:00',
        },
        {
          SEK_per_kWh: 1.2,
          time_start: '2026-10-23T12:00:00+02:00',
          time_end: '2026-10-23T12:15:00+02:00',
        },
        {
          SEK_per_kWh: 0.4,
          time_start: '2026-10-23T12:15:00+02:00',
          time_end: '2026-10-23T12:30:00+02:00',
        },
      ],
      NOW,
    );
    expect(metrics.map((m) => [m.id, m.value])).toEqual([
      ['se3-now', 1.2],
      ['se3-min', 0.4],
      ['se3-max', 1.2],
    ]);
    for (const m of metrics) expect(MetricSchema.safeParse(m).success).toBe(true);
  });
});

describe('nextbike', () => {
  it('joins station information with status', () => {
    const entities = parseBikeStations(
      { data: { stations: [{ station_id: '1', name: 'Dalgångsgatan', lat: 57.67, lon: 11.98 }] } },
      {
        data: {
          stations: [
            {
              station_id: '1',
              num_bikes_available: 7,
              num_docks_available: 3,
              is_renting: true,
              last_reported: 1792752319,
            },
            { station_id: 'unknown', num_bikes_available: 1, last_reported: 1792752319 },
          ],
        },
      },
    );
    expect(entities).toEqual([
      expect.objectContaining({
        id: '1',
        kind: 'bike_station',
        label: 'Dalgångsgatan',
        props: { bikes: 7, docks: 3, renting: true },
      }),
    ]);
    expect(EntitySchema.safeParse(entities[0]).success).toBe(true);
  });
});

describe('adsb.fi aircraft', () => {
  const ac = {
    hex: '484ee5',
    flight: 'KLM86F  ',
    r: 'PH-HSE',
    t: 'B738',
    alt_baro: 38000,
    alt_geom: 37600,
    gs: 441.3,
    track: 199.87,
    lat: 57.737686,
    lon: 9.383653,
    seen_pos: 0.2,
  };

  it('converts units and skips privacy-flagged or stale aircraft', () => {
    const entities = parseAircraft({
      now: 1792752389500,
      ac: [
        ac,
        { ...ac, hex: 'aaaaaa', dbFlags: 8 },
        { ...ac, hex: 'bbbbbb', seen_pos: 120 },
        { ...ac, hex: 'cccccc', alt_baro: 'ground', alt_geom: undefined, dbFlags: 1 },
        { hex: 'nope' },
      ],
    });
    expect(entities.map((e) => e.id)).toEqual(['484ee5', 'cccccc']);
    const [klm, ground] = entities;
    expect(klm).toMatchObject({ label: 'KLM86F', heading: 199.87 });
    expect(klm?.alt).toBeCloseTo(37600 * 0.3048);
    expect(klm?.speed).toBeCloseTo(441.3 * 0.514444);
    expect(ground).toMatchObject({ alt: 0, props: { onGround: true, military: true } });
    for (const e of entities) expect(EntitySchema.safeParse(e).success).toBe(true);
  });
});

describe('celestrak', () => {
  const iss = {
    OBJECT_NAME: 'ISS (ZARYA)',
    OBJECT_ID: '1998-067A',
    EPOCH: '2026-10-21T01:08:59.469792',
    MEAN_MOTION: 15.48967427,
    ECCENTRICITY: 0.00067597,
    INCLINATION: 51.6327,
    RA_OF_ASC_NODE: 37.2623,
    ARG_OF_PERICENTER: 289.5321,
    MEAN_ANOMALY: 70.4938,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 25544,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 59126,
    BSTAR: 0.00018187691,
    MEAN_MOTION_DOT: 0.00009575,
    MEAN_MOTION_DDOT: 0,
  };

  it('deduplicates element sets and propagates valid positions', () => {
    const sats = toSatellites([iss, iss, { OBJECT_NAME: 'broken' }]);
    expect(sats).toHaveLength(1);

    // Sample a day; the ISS rises over Gothenburg several times.
    const start = Date.parse('2026-10-21T00:00:00Z');
    const visible = Array.from({ length: 24 * 60 }, (_, i) =>
      visibleSatellites(sats, new Date(start + i * 60_000)),
    ).flat();
    expect(visible.length).toBeGreaterThan(0);
    for (const e of visible) {
      expect(EntitySchema.safeParse(e).success).toBe(true);
      expect(e.alt).toBeGreaterThan(350_000);
      expect(e.alt).toBeLessThan(450_000);
      expect(e.props?.elevationDeg).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('rss', () => {
  const feed = { id: 'svt-vast', name: 'SVT Väst' };
  const rss = (items: string) =>
    `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Väst</title>${items}</channel></rss>`;

  it('extracts plain-text headlines, snippets and links', () => {
    const events = parseFeed(
      rss(`
        <item>
          <title><![CDATA[Cyklist påkörd på Tjörn &amp; förd till sjukhus]]></title>
          <link>https://www.svt.se/nyheter/lokalt/vast/cyklist</link>
          <description><![CDATA[<p>En cyklist <b>blev</b> påkörd.</p><script>alert(1)</script>]]></description>
          <pubDate>Fri, 23 Oct 2026 08:24:18 +0200</pubDate>
        </item>
        <item><title>No date</title><link>https://www.svt.se/x</link></item>
        <item><title>Bad link</title><link>javascript:alert(1)</link><pubDate>Fri, 23 Oct 2026 08:24:18 +0200</pubDate></item>`),
      feed,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'SVT Väst',
      title: 'Cyklist påkörd på Tjörn & förd till sjukhus',
      url: 'https://www.svt.se/nyheter/lokalt/vast/cyklist',
      start: '2026-10-23T06:24:18.000Z',
      locationPrecision: 'none',
    });
    expect(events[0]?.body).not.toMatch(/[<>]/);
    expect(EventSchema.safeParse(events[0]).success).toBe(true);
  });

  it('rejects feeds with a DTD', () => {
    expect(() =>
      parseFeed('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><rss></rss>', feed),
    ).toThrow(/DTD/);
  });
});

describe('osm', () => {
  it('uses node coordinates or way centres', () => {
    const entities = parsePois(
      {
        elements: [
          {
            type: 'node',
            id: 1,
            lat: 57.7,
            lon: 11.65,
            tags: { amenity: 'fire_station', name: 'Öckerö Räddningstjänst' },
          },
          { type: 'way', id: 2, center: { lat: 57.68, lon: 11.96 }, tags: { amenity: 'hospital' } },
          { type: 'way', id: 3, tags: { amenity: 'police' } },
        ],
      },
      NOW,
    );
    expect(entities.map((e) => [e.id, e.label, e.props?.category])).toEqual([
      ['node/1', 'Öckerö Räddningstjänst', 'fire_station'],
      ['way/2', 'Hospital', 'hospital'],
    ]);
    for (const e of entities) expect(EntitySchema.safeParse(e).success).toBe(true);
  });
});

describe('toPlainText', () => {
  it('strips tags and decodes entities', () => {
    expect(toPlainText('<p>A&nbsp;&amp;&#8211;&#x2014; <b>b</b></p>')).toBe('A &–— b');
  });
});
