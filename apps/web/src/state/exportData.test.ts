import { encodeLine, type ChannelItem } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { inView, itemBox } from './bounds';
import { fileStamp, itemTitle, toCsv, toGeoJson, type ExportRecord } from './exportData';

const TS = '2026-10-30T10:00:00Z';
const ship: ChannelItem = {
  id: '265000001',
  source: 'aisstream.ships',
  kind: 'ship',
  lon: 11.9,
  lat: 57.7,
  heading: 90,
  speed: 5,
  label: 'STENA DANICA',
  ts: TS,
  via: [[11.89, 57.7]],
  props: { destination: 'FREDERIKSHAVN' },
};
const incident: ChannelItem = {
  id: 'e1',
  source: 'trafikverket.situations',
  category: 'Olycka',
  severity: 'major',
  title: '=HYPERLINK("http://evil")',
  body: 'Two cars, "minor" injuries,\nlane closed',
  geometry: { type: 'Point', coordinates: [11.95, 57.71] },
  locationPrecision: 'exact',
  start: TS,
};
const river: ChannelItem = {
  id: 'w1',
  source: 'osm.waterways',
  kind: 'waterway',
  line: encodeLine([
    [11.9, 57.7],
    [12.0, 57.72],
  ]),
  label: 'Säveån',
  ts: TS,
};
const district: ChannelItem = {
  id: 'd1',
  source: 'scb.regso',
  label: 'Lindholmen',
  polygons: [
    [
      encodeLine([
        [11.9, 57.7],
        [11.92, 57.7],
        [11.92, 57.71],
      ]),
    ],
  ],
  ts: TS,
  props: { population: 6676 },
};
const reading: ChannelItem = {
  id: 'no2',
  source: 'goteborg.airquality',
  name: 'NO₂ Femman',
  unit: 'µg/m³',
  value: 21.5,
  ts: TS,
  lon: 11.97,
  lat: 57.71,
};
const departure: ChannelItem = {
  id: 'dep1',
  source: 'vasttrafik.departures',
  board: 'Brunnsparken',
  direction: 'departure',
  mode: 'tram',
  line: '6',
  place: 'Länsmansgården',
  planned: TS,
  cancelled: false,
};

const rec = (item: ChannelItem, layer = 'Layer'): ExportRecord => ({ layer, channel: 'c', item });
const meta = { generated: TS, attribution: ['Trafikverket (CC0)'] };

describe('export', () => {
  it('writes GeoJSON with geometry per item type and no departures', () => {
    const fc = JSON.parse(
      toGeoJson(
        [ship, incident, river, district, reading, departure].map((i) => rec(i)),
        meta,
      ),
    ) as {
      attribution: string[];
      features: {
        id: string;
        geometry: { type: string; coordinates: unknown };
        properties: Record<string, unknown>;
      }[];
    };
    expect(fc.attribution).toEqual(['Trafikverket (CC0)']);
    expect(fc.features.map((f) => f.geometry?.type)).toEqual([
      'Point',
      'Point',
      'LineString',
      'Polygon',
      'Point',
    ]);
    const [s, , w, d] = fc.features;
    expect(s!.id).toBe('c/265000001');
    expect(s!.properties).toMatchObject({ layer: 'Layer', label: 'STENA DANICA', heading: 90 });
    expect(s!.properties).not.toHaveProperty('via');
    expect(s!.properties).not.toHaveProperty('lon');
    expect(w!.geometry.coordinates).toEqual([
      [11.9, 57.7],
      [12, 57.72],
    ]);
    // Rings are closed, as GeoJSON requires.
    const ring = (d!.geometry.coordinates as number[][][])[0]!;
    expect(ring.at(-1)).toEqual(ring[0]);
    expect(d!.properties).toMatchObject({ label: 'Lindholmen', props: { population: 6676 } });
  });

  it('writes spreadsheet-safe CSV', () => {
    const csv = toCsv([rec(ship), rec(incident), rec(departure), rec(reading)]);
    expect(csv.startsWith('\uFEFFlayer,type,id,source,kind,label,lon,lat')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toHaveLength(5); // header, three rows, trailing empty line
    expect(lines[1]).toContain('object,265000001,aisstream.ships,ship,STENA DANICA,11.9,57.7');
    expect(lines[1]).toContain('"{""destination"":""FREDERIKSHAVN""}"');
    // Formulas are neutralised and quotes, commas and newlines escaped.
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain('"Two cars, ""minor"" injuries,\nlane closed"');
    expect(csv).toContain('reading,no2,goteborg.airquality,,NO₂ Femman,11.97,57.71,,,,,21.5,µg/m³');
  });

  it('finds where items are and whether they are in view', () => {
    expect(itemBox(district)).toEqual([11.9, 57.7, 11.92, 57.71]);
    expect(itemBox(departure)).toBeNull();
    const view = { west: 11.91, south: 57.69, east: 11.95, north: 57.72 };
    expect(inView(district, view)).toBe(true);
    expect(inView(river, view)).toBe(true);
    expect(inView(ship, view)).toBe(false);
    expect(inView(departure, view)).toBe(false);
  });

  it('names items and files', () => {
    expect(itemTitle(ship)).toBe('STENA DANICA');
    expect(itemTitle(reading)).toBe('NO₂ Femman');
    expect(itemTitle(departure)).toBe('dep1');
    expect(fileStamp(new Date('2026-10-30T10:05:00Z'))).toBe('2026-10-30_1105');
  });
});
