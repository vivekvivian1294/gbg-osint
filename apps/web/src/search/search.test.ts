import { describe, expect, it } from 'vitest';
import { PLACES } from './places';
import { normalize, parseCoordinates, search } from './search';

describe('normalize', () => {
  it('folds case, accents and whitespace', () => {
    expect(normalize('  Göteborg   Landvetter ')).toBe('goteborg landvetter');
    expect(normalize('Feskekôrka')).toBe('feskekorka');
  });
});

describe('parseCoordinates', () => {
  it.each([
    ['57.7089, 11.9746', { lat: 57.7089, lon: 11.9746 }],
    ['57.7089 11.9746', { lat: 57.7089, lon: 11.9746 }],
    ['geo:57.7089,11.9746', { lat: 57.7089, lon: 11.9746 }],
    ['geo:57.7089,11.9746;u=35', { lat: 57.7089, lon: 11.9746 }],
    ['-33.9, 151.2', { lat: -33.9, lon: 151.2 }],
  ])('parses %s', (input, expected) => {
    expect(parseCoordinates(input)).toEqual(expected);
  });

  it.each(['95, 11', '57, 200', 'geo:57,11,30', 'liseberg', '57.7', '57.7,11.9,3', '1e3, 2'])(
    'rejects %s',
    (input) => {
      expect(parseCoordinates(input)).toBeUndefined();
    },
  );
});

describe('search', () => {
  it('finds places by name, alias and without accents', () => {
    expect(search('lise', PLACES)[0]).toMatchObject({ type: 'place', label: 'Liseberg' });
    expect(search('GOT', PLACES)[0]).toMatchObject({ label: 'Göteborg Landvetter Airport' });
    expect(search('alvsborg', PLACES)[0]).toMatchObject({ label: 'Älvsborgsbron' });
  });

  it('lists live entities before places', () => {
    const results = search('sas', PLACES, [
      { layerId: 'aircraft', id: '4aca1f', label: 'SAS1234', kind: 'aircraft' },
    ]);
    expect(results[0]).toMatchObject({ type: 'entity', label: 'SAS1234' });
  });

  it('returns coordinates as a single result and ignores very short queries', () => {
    expect(search('57.7, 11.97', PLACES)).toEqual([
      { type: 'coords', label: '57.70000, 11.97000', lat: 57.7, lon: 11.97 },
    ]);
    expect(search('g', PLACES)).toEqual([]);
  });

  it('has valid place coordinates around Gothenburg', () => {
    for (const p of PLACES) {
      expect(p.lat).toBeGreaterThan(57.5);
      expect(p.lat).toBeLessThan(57.95);
      expect(p.lon).toBeGreaterThan(11.5);
      expect(p.lon).toBeLessThan(12.35);
    }
  });
});
